// Translate only recognized diagnostics. Never reflect SQL, credentials or a
// provider response into an HTTP error message; callers keep their safe fallback.
export function syncErrorMessage(error) {
  const message = typeof error === "string" ? error : error?.message || "";
  const code = error?.cause?.code || error?.code;
  if (
    /Snapshot exceeds (uncompressed|Git object) byte budget|snapshot exceeds (compressed|decoded) byte capacity|^동기화할 자료가 스냅샷 용량 한도를 초과했습니다/i.test(
      message,
    )
  )
    return "동기화할 자료가 스냅샷 용량 한도를 초과했습니다. 관리자에게 내부·외부 서버의 용량 설정과 배포 버전을 확인해 달라고 요청한 뒤 다시 실행하세요. 기존 자료와 미전송 변경은 보존됩니다.";
  if (
    /entity capacity exceeded|^동기화할 업무·셀·문서·일정의 항목 수가/i.test(
      message,
    )
  )
    return "동기화할 업무·셀·문서·일정의 항목 수가 외부 서버의 허용 개수를 초과했습니다. 관리자에게 동기화 항목 수 한도와 배포 버전을 확인해 달라고 요청하세요. 기존 자료와 미전송 변경은 보존됩니다.";
  if (
    /state byte capacity|state and pending capacity|stored synchronization capacity|^팀의 공유 자료와 미전송 변경이 외부 서버의 동기화 용량 한도를/i.test(
      message,
    )
  )
    return "팀의 공유 자료와 미전송 변경이 외부 서버의 동기화 용량 한도를 초과했습니다. 관리자에게 외부 서버의 용량 설정과 배포 버전을 확인해 달라고 요청하세요. 기존 자료와 미전송 변경은 보존됩니다.";
  if (
    /file capacity exceeded|event envelope byte budget|^동기화 변경 묶음이 전송 파일의 용량 한도를/i.test(
      message,
    )
  )
    return "동기화 변경 묶음이 전송 파일의 용량 한도를 초과했습니다. 관리자에게 보존된 미전송 변경을 확인해 달라고 요청하세요.";
  if (
    /capacity configuration is invalid|^외부 서버의 동기화 용량 설정값이 올바르지 않습니다/i.test(
      message,
    )
  )
    return "외부 서버의 동기화 용량 설정값이 올바르지 않습니다. 관리자에게 SYNC_MAX_STATE_BYTES와 SYNC_MAX_ENTITIES 설정을 확인해 달라고 요청하세요.";
  if (
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
    ].includes(code) ||
    /self[- ]signed certificate|unable to get local issuer certificate|certificate has expired/i.test(
      message,
    )
  )
    return "Git 서버의 HTTPS 인증서를 신뢰할 수 없습니다. 관리자에게 사내 보안 인증서의 유효기간과 Node·Git의 인증서 신뢰 설정을 확인해 달라고 요청한 뒤 연결 검사를 다시 실행하세요.";
  if (
    /GitHub rate limit|GitHub request budget|GitHub request failed \((?:403|429)\); retry after/i.test(
      message,
    )
  )
    return "GitHub 요청 한도에 도달해 동기화를 완료하지 못했습니다. 잠시 후 다시 실행하세요. 반복되면 관리자에게 GitHub 요청량을 확인해 달라고 요청하세요.";
  if (
    /GitHub request failed \((?:401|403)\)|Authentication failed for|Permission denied \(publickey\)/i.test(
      message,
    )
  )
    return "Git 저장소에 접근할 권한을 확인하지 못했습니다. 관리자에게 Git 접속 토큰의 유효 여부와 해당 비공개 저장소의 읽기·쓰기 권한을 확인해 달라고 요청하세요.";
  if (
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    /timed out|timeout/i.test(message)
  )
    return "동기화 서버의 응답 시간이 초과되었습니다. 네트워크·프록시 연결을 확인하고 잠시 후 다시 실행하세요.";
  if (
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code) ||
    /^(fetch failed|Failed to fetch|NetworkError.*)$/i.test(message) ||
    /Could not resolve host|Failed to connect to/i.test(message)
  )
    return "동기화 서버에 연결하지 못했습니다. 관리자에게 서버의 네트워크·프록시·DNS 연결을 확인해 달라고 요청한 뒤 연결 검사를 다시 실행하세요.";
  return "";
}

export const isSyncRequest = (path) =>
  /^\/(?:api\/)?(?:admin\/)?teams\/[^/]+\/(?:sync|connection)(?:\/|$)/.test(
    path,
  );
