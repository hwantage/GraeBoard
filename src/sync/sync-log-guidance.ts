import type { SyncLogEntry } from "./sync-log-types";

export type SyncLogGuidance = { cause: string; action: string };

// Known failures of the internal server's Git commands, matched against what
// Git printed. The log file keeps the original text; this only explains it.
// The first match wins, so specific patterns come before general ones.
const known: {
  pattern: RegExp;
  // Only for this Git command, when the same text means something else elsewhere.
  command?: string;
  cause: string;
  action: string;
}[] = [
  {
    // Elsewhere a missing object can mean a damaged clone.
    command: "merge-base",
    pattern: /Not a valid commit name|Not a valid object name|bad object/i,
    cause:
      "외부 서버가 알린 커밋을 사내 서버가 아직 받지 않았습니다. 사내 서버가 받은 직후 외부 서버가 새 변경을 올리면 생깁니다.",
    action:
      "조치가 필요 없습니다. 다음 동기화에서 그 커밋을 받으면 사라집니다. 여러 번 이어지면 지금 동기화를 실행하고, 그래도 남으면 사내 서버의 동기화 폴더가 손상됐는지 확인하세요.",
  },
  // Causes on this server come before network ones: a full disk during a
  // fetch also prints "remote end hung up".
  {
    pattern: /No space left on device|Disk quota exceeded/i,
    cause: "사내 서버의 디스크가 가득 찼습니다.",
    action: "디스크 공간을 확보하세요. 공간이 생기면 자동으로 이어집니다.",
  },
  {
    pattern: /\.lock': File exists|Unable to create .*\.lock/i,
    cause: "이전 Git 작업이 비정상 종료해 잠금 파일이 남았습니다.",
    action:
      "저절로 풀리지 않으면 서버 관리자에게 사내 서버 동기화 폴더의 잠금 파일 점검을 요청하세요.",
  },
  {
    pattern:
      /not a git repository|object file .* is empty|loose object .* is corrupt|packfile .* (is corrupt|cannot be)|bad object/i,
    cause: "사내 서버의 동기화 폴더가 손상됐을 수 있습니다.",
    action:
      "서버 관리자에게 동기화 폴더 점검을 요청하세요. 업무 자료와 미전송 변경은 DB에 보존되어 있습니다.",
  },
  {
    pattern: /Could not resolve (host|proxy)/i,
    cause: "사내 서버가 GitHub 또는 프록시의 주소를 찾지 못했습니다.",
    action:
      "사내 서버의 DNS와 앱 전용 Git 프록시 설정(http.https://github.com/.proxy)을 확인하세요.",
  },
  {
    pattern: /Proxy Authentication Required|HTTP (code )?407/i,
    cause: "프록시가 사내 서버의 요청을 인증하지 못해 거절했습니다.",
    action: "프록시의 GitHub 접속 허용과 인증 설정을 확인하세요.",
  },
  {
    pattern:
      /SSL certificate problem|unable to get local issuer certificate|self[- ]signed certificate|certificate verify failed/i,
    cause: "GitHub 연결의 HTTPS 인증서를 신뢰하지 못했습니다.",
    action:
      "사내 TLS 검사 환경이면 사내 CA 인증서를 Git이 신뢰하도록 등록하세요(외부 동기화 설정 안내의 사내 HTTPS 인증서 항목).",
  },
  {
    pattern:
      /Authentication failed|could not read Username|terminal prompts disabled|HTTP 401|error: 401|invalid credentials/i,
    cause: "GitHub 토큰이 없거나 만료됐거나 폐기됐습니다.",
    action:
      "외부 동기화 설정의 GitHub 저장소 단계에서 토큰을 다시 저장한 뒤 연결 검사를 실행하세요.",
  },
  {
    pattern:
      /Repository not found|HTTP 404|error: 404|does not appear to be a git repository/i,
    cause: "저장소를 찾지 못했습니다. 주소가 다르거나 토큰에 권한이 없습니다.",
    action: "저장소 주소와 토큰의 저장소 접근 권한을 확인하세요.",
  },
  {
    pattern: /HTTP 403|error: 403|Permission to .* denied|access denied/i,
    cause: "GitHub가 이 토큰의 접근을 거절했습니다.",
    action:
      "토큰의 저장소 쓰기 권한과 GitHub 사용 한도를 확인하세요. 한도 초과라면 잠시 뒤 자동으로 풀립니다.",
  },
  {
    command: "push",
    pattern: /Updates were rejected|failed to push some refs|fetch first/i,
    cause: "외부 서버가 먼저 변경을 올려, 사내 서버의 게시가 거절됐습니다.",
    action:
      "조치가 필요 없습니다. 사내 서버가 그 변경을 받은 뒤 다시 올립니다.",
  },
  {
    pattern:
      /Failed to connect|Connection refused|Connection timed out|Couldn't connect to server|Network is unreachable|No route to host|Connection reset/i,
    cause: "사내 서버가 GitHub 또는 프록시에 연결하지 못했습니다.",
    action:
      "네트워크와 방화벽, 프록시 서버의 상태를 확인하세요. 연결이 돌아오면 자동으로 이어집니다.",
  },
  {
    pattern: /Operation too slow|Operation timed out|timed out/i,
    cause: "GitHub와의 전송이 너무 느려 중단됐습니다.",
    action:
      "네트워크와 프록시의 속도를 확인하세요. 미전송 변경은 보존되며 다음 동기화에서 다시 시도합니다.",
  },
  {
    pattern:
      /RPC failed|HTTP 5\d\d|error: 5\d\d|remote end hung up|unexpected disconnect/i,
    cause: "GitHub 또는 프록시가 전송 도중 연결을 끊었습니다.",
    action:
      "대개 일시적입니다. 반복되면 프록시의 요청 크기 제한과 GitHub 상태를 확인하세요.",
  },
];

// The Git command that stopped a failed cycle. The cycle's error names the
// step ("Git operation failed (128, merge-base)"), so only that command,
// written just before the cycle's own entry, is taken; another failure in the
// same minute (a rejected push that was retried) is not the cause.
export function syncLogFailedCommand(
  entry: SyncLogEntry,
  entries: SyncLogEntry[],
): SyncLogEntry | null {
  if (entry.kind !== "cycle" || entry.ok !== false) return null;
  const step = /^Git operation failed \((.+), ([\w-]+)\)$/.exec(
    entry.error?.message || "",
  );
  if (!step) return null;
  const end = Date.parse(entry.at) + 1000,
    start = end - (entry.ms || 0) - 2000;
  return (
    entries.find((other) => {
      const time = Date.parse(other.at);
      return (
        other.kind === "git" &&
        other.ok === false &&
        other.command === step[2] &&
        String(other.code ?? "network") === step[1] &&
        other.line < entry.line &&
        time >= start &&
        time <= end
      );
    }) || null
  );
}

export function syncLogGuidance(
  entry: SyncLogEntry,
  entries: SyncLogEntry[] = [],
): SyncLogGuidance | null {
  if (entry.ok !== false) return null;
  if (entry.kind === "git" && entry.timedOut)
    return {
      cause: "Git 명령이 제한 시간 안에 끝나지 않아 중단됐습니다.",
      action:
        "네트워크와 프록시의 속도를 확인하세요. 미전송 변경은 보존되며 다음 동기화에서 다시 시도합니다.",
    };
  if (entry.kind === "cycle" && entry.error?.code === "SYNC_TIMEOUT")
    return {
      cause: "동기화 계산이 제한 시간 안에 끝나지 않아 중단됐습니다.",
      action:
        "변경량이 많을 때 생깁니다. 다음 동기화에서 이어서 처리합니다. 계속되면 서버 관리자에게 알리세요.",
    };
  const text =
    entry.kind === "git" ? entry.stderr || "" : entry.error?.message || "";
  const match =
    text &&
    known.find(
      (item) =>
        (!item.command || item.command === entry.command) &&
        item.pattern.test(text),
    );
  if (match) return { cause: match.cause, action: match.action };
  // A failed cycle is explained by the Git command that stopped it.
  const command = syncLogFailedCommand(entry, entries);
  return command ? syncLogGuidance(command) : null;
}
