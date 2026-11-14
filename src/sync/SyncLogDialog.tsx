import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, RefreshCw } from "lucide-react";
import { api, download, send } from "../platform/api";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import LoadingState from "../ui/LoadingState";
import { Modal } from "../ui/Modal";
import Select from "../ui/Select";
import { busyProps } from "../ui/busyProps";
import { syncModeNames, type SyncStatus } from "./sync-types";
import { syncLogFailedCommand, syncLogGuidance } from "./sync-log-guidance";
import type { SyncLogEntry, SyncLogLevel, SyncLogPage } from "./sync-log-types";
import "./sync-log.css";

const levelNames: Record<SyncLogLevel, string> = {
  changes: "실패와 상태 변화만",
  cycles: "주기 요약 + 실패 상세",
  git: "모든 Git 명령",
};
const actionNames: Record<string, string> = {
  check: "연결 검사",
  enable: "초기 게시",
  run: "지금 동기화",
  pause: "일시정지",
  resume: "재개",
  reconnect: "다시 연결",
  disconnect: "연결 해제",
  checkpoint: "체크포인트 생성",
  upgrade: "프로토콜 전환",
  reset: "연결 기록 초기화",
  "log-level": "로그 수준 변경",
};
const cycleNames: Record<string, string> = {
  checkpoint: "체크포인트 생성",
  upgrade: "프로토콜 전환",
};
const imageReasons: Record<string, string> = {
  "missing locally": "사내 서버에 파일 없음",
  "damaged locally": "사내 서버의 파일 손상",
  "missing from Git": "저장소에 파일 없음",
  "damaged in Git": "저장소의 파일 손상",
};
const mode = (value?: string | number) =>
  syncModeNames[value as SyncStatus["mode"]] || String(value ?? "");
const clock = (value: string) =>
  // 14:03:12, which stays on one line unlike the Korean long form.
  new Date(value).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul" });
const seconds = (ms?: number) =>
  ms === undefined ? "" : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
const short = (oid?: string | null) => (oid ? oid.slice(0, 7) : "없음");

type Tone = "ok" | "fail" | "info";
function describe(entry: SyncLogEntry): {
  tone: Tone;
  label: string;
  text: string;
} {
  const failed = entry.ok === false;
  if (entry.kind === "cycle") {
    if (failed)
      return {
        tone: "fail",
        label: "실패",
        text: `${cycleNames[entry.action || ""] || "동기화"} 실패 · ${entry.error?.message || "원인 불명"}`,
      };
    const parts = [
      entry.busy
        ? "다른 동기화가 진행 중이라 건너뜀"
        : [
            entry.recovered ? "회복" : "",
            entry.received ? "받음" : "",
            entry.published ? "올림" : "",
          ]
            .filter(Boolean)
            .join(" · ") || "변경 없음",
      entry.commits ? `커밋 ${entry.commits}개` : "",
      entry.pending ? `미전송 ${entry.pending}건` : "",
      seconds(entry.ms),
    ];
    return {
      tone: "ok",
      label: "성공",
      text: `${cycleNames[entry.action || ""] || "동기화"} · ${parts.filter(Boolean).join(" · ")}`,
    };
  }
  if (entry.kind === "git")
    return {
      tone: failed ? "fail" : "ok",
      label: failed ? "실패" : "성공",
      text:
        `git ${entry.command}` +
        (failed
          ? entry.timedOut
            ? " · 시간 초과"
            : entry.aborted
              ? " · 중단됨"
              : ` · 종료 코드 ${entry.code ?? "없음"}`
          : "") +
        (entry.ms === undefined ? "" : ` · ${seconds(entry.ms)}`),
    };
  if (entry.kind === "action")
    return {
      tone: failed ? "fail" : "info",
      label: failed ? "실패" : "작업",
      text:
        `${entry.actor?.name || "알 수 없음"} · ${actionNames[entry.action || ""] || entry.action}` +
        (entry.action === "log-level"
          ? ` (${levelNames[entry.from as SyncLogLevel] || entry.from} → ${levelNames[entry.to as SyncLogLevel] || entry.to})`
          : "") +
        (failed ? ` · ${entry.error?.message || ""}` : ""),
    };
  if (entry.kind === "state")
    return {
      tone: "info",
      label: "상태",
      text:
        entry.change === "conflicts"
          ? `충돌 보관 ${entry.from}건 → ${entry.to}건`
          : `상태 변경: ${mode(entry.from)} → ${mode(entry.to)}` +
            (entry.reason ? ` · ${entry.reason}` : ""),
    };
  if (entry.kind === "server")
    return {
      tone: "info",
      label: "서버",
      text: entry.event === "start" ? "사내 서버 시작" : "사내 서버 종료",
    };
  if (entry.kind === "worker")
    return {
      tone: "fail",
      label: "이상",
      text: `동기화 작업 스레드가 실행 도중 종료됨 (코드 ${entry.code ?? "없음"})`,
    };
  return {
    tone: "info",
    label: "이미지",
    text: `이미지 건너뜀 · ${imageReasons[entry.reason || ""] || entry.reason} · ${entry.path}`,
  };
}

function Details({
  entry,
  entries,
}: {
  entry: SyncLogEntry;
  entries: SyncLogEntry[];
}) {
  const guidance = syncLogGuidance(entry, entries),
    command = syncLogFailedCommand(entry, entries);
  const rows: [string, string][] = [];
  const add = (name: string, value?: string | number | null | false) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== false &&
      value !== ""
    )
      rows.push([name, String(value)]);
  };
  add(
    "시각",
    new Date(entry.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
  );
  if (entry.kind === "cycle") {
    add("상태", mode(entry.mode));
    add(
      "사내 head",
      entry.headBefore !== undefined
        ? `${short(entry.headBefore)} → ${short(entry.head)}`
        : short(entry.head),
    );
    add("외부 서버가 알린 head", short(entry.peerHead));
    add(
      "외부 서버 상태 시각",
      entry.peerObservedAt &&
        new Date(entry.peerObservedAt).toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
        }),
    );
    add(
      "미전송",
      entry.pendingBefore !== undefined
        ? `${entry.pendingBefore}건 → ${entry.pending}건`
        : `${entry.pending ?? 0}건`,
    );
    add("충돌 보관", `${entry.conflicts ?? 0}건`);
    add("소요", seconds(entry.ms));
    add("오류", entry.error?.message);
    add("오류 코드", entry.error?.code);
    add("실패한 Git 명령", command && `git ${command.args}`);
  }
  if (entry.kind === "git") {
    add("명령", `git ${entry.args}`);
    add("종료 코드", entry.code);
    add("소요", seconds(entry.ms));
    add("입력 크기", entry.inputBytes && `${entry.inputBytes}바이트`);
  }
  if (entry.kind === "action") add("오류", entry.error?.message);
  if (entry.kind === "server") {
    add("프로세스", entry.pid);
    add("Node", entry.node);
  }
  return (
    <div className="sync-log-details">
      {guidance && (
        <div className="sync-log-guidance">
          <p>
            <b>원인</b> {guidance.cause}
          </p>
          <p>
            <b>조치</b> {guidance.action}
          </p>
        </div>
      )}
      <dl>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {(entry.stderr || command?.stderr) && (
        <>
          <p className="sync-log-raw-title">Git 출력 원문</p>
          <pre className="sync-log-raw">{entry.stderr || command?.stderr}</pre>
        </>
      )}
    </div>
  );
}

export default function SyncLogDialog({
  teamId,
  teamName,
  onClose,
}: {
  teamId: string;
  teamName: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<SyncLogPage | null>(null);
  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [date, setDate] = useState("");
  const [problems, setProblems] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = useCallback(
    async (before?: number) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        const query = new URLSearchParams();
        if (date) query.set("date", date);
        if (problems) query.set("problems", "1");
        if (before !== undefined) query.set("before", String(before));
        const result = await api<SyncLogPage>(
          `/teams/${teamId}/sync/log?${query}`,
        );
        if (id !== request.current) return;
        setPage(result);
        setEntries((current) =>
          before === undefined
            ? result.entries
            : [...current, ...result.entries],
        );
        if (before === undefined) setOpen(new Set());
      } catch (e) {
        if (id === request.current)
          setError(
            (e as Error).message || "동기화 로그를 불러오지 못했습니다.",
          );
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [teamId, date, problems],
  );
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  async function changeLevel(level: SyncLogLevel) {
    setBusy(true);
    setError("");
    try {
      await send(`/admin/teams/${teamId}/sync-log-level`, { level }, "PUT");
      await load();
    } catch (e) {
      setError((e as Error).message || "로그 수준을 바꾸지 못했습니다.");
      setBusy(false);
    }
  }
  async function save() {
    if (!page) return;
    setError("");
    try {
      await download(`/teams/${teamId}/sync/log/download`, { date: page.date });
    } catch (e) {
      setError((e as Error).message || "로그 파일을 내려받지 못했습니다.");
    }
  }
  return (
    <Modal
      title="동기화 로그"
      help={`사내 서버가 ${teamName} 팀을 동기화하며 남긴 기록입니다. 실패한 줄을 펼치면 Git이 출력한 원문과 조치 안내를 볼 수 있습니다.`}
      wide
      className="sync-log-dialog"
      onClose={onClose}
    >
      <div className="sync-log-toolbar">
        <label>
          날짜
          <Select
            value={page?.date || date}
            disabled={!page}
            onChange={(e) => setDate(e.target.value)}
          >
            {(page?.dates || []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
        <label>
          결과
          <Select
            value={problems ? "problems" : "all"}
            onChange={(e) => setProblems(e.target.value === "problems")}
          >
            <option value="all">전체</option>
            <option value="problems">실패와 상태 변화만</option>
          </Select>
        </label>
        <label>
          기록 수준
          <Select
            value={page?.level || "cycles"}
            disabled={!page?.canSetLevel || busy}
            title={
              page && !page.canSetLevel
                ? "기록 수준은 시스템 관리자가 바꿉니다."
                : undefined
            }
            onChange={(e) => void changeLevel(e.target.value as SyncLogLevel)}
          >
            {(page?.levels || (["cycles"] as SyncLogLevel[])).map((value) => (
              <option key={value} value={value}>
                {levelNames[value]}
              </option>
            ))}
          </Select>
        </label>
        <span className="sync-log-toolbar-actions">
          <Button {...busyProps(busy)} onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" />
            새로 고침
          </Button>
          <Button
            {...busyProps(false, !page || (!entries.length && !problems))}
            onClick={() => void save()}
          >
            <Download size={15} aria-hidden="true" />
            내려받기
          </Button>
        </span>
      </div>
      <ErrorNote error={error} />
      {!page && !error && <LoadingState label="동기화 로그를 불러오는 중…" />}
      {page && !entries.length && (
        <p className="field-help">
          {problems
            ? "이 날짜에는 실패나 상태 변화가 없습니다."
            : "이 날짜에는 기록이 없습니다."}
        </p>
      )}
      {!!entries.length && (
        <ul className="sync-log-list">
          {entries.map((entry) => {
            const summary = describe(entry),
              expanded = open.has(entry.line);
            return (
              <li key={entry.line} className={`sync-log-entry ${summary.tone}`}>
                <button
                  type="button"
                  className="sync-log-row"
                  aria-expanded={expanded}
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (!next.delete(entry.line)) next.add(entry.line);
                      return next;
                    })
                  }
                >
                  {expanded ? (
                    <ChevronDown size={15} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={15} aria-hidden="true" />
                  )}
                  <time dateTime={entry.at}>{clock(entry.at)}</time>
                  <span className="sync-log-badge">{summary.label}</span>
                  <span className="sync-log-text">{summary.text}</span>
                </button>
                {expanded && <Details entry={entry} entries={entries} />}
              </li>
            );
          })}
        </ul>
      )}
      {page?.next !== null && page?.next !== undefined && (
        <div className="sync-log-more">
          <Button {...busyProps(busy)} onClick={() => void load(page.next!)}>
            이전 기록 더 보기
          </Button>
        </div>
      )}
      {page && (
        <p className="field-help sync-log-note">
          기록은 한국 시간 기준 날짜별 파일로 {page.retentionDays}일 동안
          보관합니다. 내려받은 파일에는 저장소 주소와 프록시 주소가 들어 있을 수
          있습니다.
        </p>
      )}
    </Modal>
  );
}
