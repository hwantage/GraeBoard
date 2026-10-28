const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
    ? value
    : "";

function operation(path, method) {
  const route = path.split("?")[0];
  const action = ["GET", "HEAD"].includes(method) ? "조회" : "처리";
  if (route.includes("/sync/")) return `동기화 ${action}`;
  if (route.includes("/memos")) return `꼬리 메모 ${action}`;
  if (route.includes("/document")) return `문서 ${action}`;
  if (route.startsWith("/tasks")) return `업무 목록 ${action}`;
  if (route.startsWith("/cells")) return "업무 셀 저장";
  if (route.startsWith("/reports")) return `사본 ${action}`;
  if (route.startsWith("/calendar")) return `캘린더 ${action}`;
  if (route.startsWith("/bootstrap")) return "화면 정보 조회";
  if (route.startsWith("/auth")) return "계정 인증";
  if (route.startsWith("/admin")) return `설정 ${action}`;
  return `자료 ${action}`;
}

// Never display provider message/HTML bodies: they can contain internal SQL,
// connection strings or login markup. Classify known codes and HTTP statuses.
export function apiErrorMessage({
  path,
  method = "GET",
  status,
  data = null,
  headers = new Headers(),
  invalidResponse = false,
  external = false,
}) {
  const body = data && typeof data === "object" ? data : {};
  const code =
    identifier(headers.get("sb-error-code")) || identifier(body.code);
  const requestId =
    identifier(headers.get("sb-request-id")) ||
    identifier(headers.get("x-request-id")) ||
    identifier(headers.get("cf-ray"));
  const knownMessage = typeof body.error === "string" ? body.error : "";
  // Keep application validation/conflict messages and their existing UI flow.
  if (knownMessage && status < 500 && status !== 429) return knownMessage;

  let reason;
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED") {
    const retryAfter = headers.get("retry-after");
    const seconds =
      retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : retryAfter
          ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
          : 0;
    const wait =
      Number.isFinite(seconds) && seconds > 0
        ? `${seconds}초 뒤 다시 시도하세요.`
        : "잠시 후 다시 시도하세요.";
    reason = `${external ? "외부 서버" : "서버"}의 요청 제한으로 처리가 거절되었습니다. ${wait} 반복되면 관리자에게 요청 빈도와 서비스 사용 한도를 확인해 달라고 요청하세요.`;
  } else if (
    ["WORKER_LIMIT", "WORKER_RESOURCE_LIMIT"].includes(code) ||
    status === 546
  ) {
    reason =
      "외부 서버의 실행 자원 한도를 초과했습니다. 관리자에게 함수의 CPU·메모리 사용량과 실행 로그 확인을 요청하세요.";
  } else if (["BOOT_ERROR", "BOOT_FAILURE"].includes(code)) {
    reason =
      "외부 서버 함수를 시작하지 못했습니다. 관리자에게 배포 설정과 시작 오류 로그 확인을 요청하세요.";
  } else if (status === 401) {
    reason =
      "로그인 인증을 확인할 수 없습니다. 입력을 보존한 뒤 다시 로그인하세요.";
  } else if (status === 403) {
    reason =
      "이 작업에 대한 접근 권한이 없습니다. 팀 관리자에게 계정과 팀 권한 확인을 요청하세요.";
  } else if (status === 404) {
    reason =
      "요청한 자료 또는 기능을 찾을 수 없습니다. 화면을 다시 불러온 뒤에도 반복되면 관리자에게 확인을 요청하세요.";
  } else if ([408, 504].includes(status) || code === "IDLE_TIMEOUT") {
    reason =
      "서버 응답 시간이 초과되었습니다. 입력을 보존하고 잠시 후 다시 시도하세요. 반복되면 관리자에게 처리 지연 확인을 요청하세요.";
  } else if ([502, 503].includes(status)) {
    reason =
      "서버에 연결하지 못했거나 현재 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하고, 반복되면 관리자에게 서버·데이터베이스 연결 확인을 요청하세요.";
  } else if (status >= 500) {
    reason =
      "서버 내부 오류로 처리하지 못했습니다. 입력을 보존하고 다시 시도하세요. 반복되면 아래 진단 정보와 발생 시각을 관리자에게 전달하세요.";
  } else if (status === 0) {
    reason =
      "서버에 연결하지 못했습니다. 네트워크·프록시 연결을 확인한 뒤 다시 시도하세요.";
  } else if (invalidResponse) {
    reason =
      "서버가 예상한 데이터 형식으로 응답하지 않았습니다. 입력을 보존하고 로그인 상태와 서비스 연결을 확인하세요.";
  } else {
    reason =
      "서버가 요청을 거절했습니다. 입력 내용을 확인하고 반복되면 관리자에게 아래 진단 정보를 전달하세요.";
  }
  const details = [
    status ? `HTTP ${status}` : "네트워크 오류",
    code || (invalidResponse ? "INVALID_RESPONSE" : ""),
    requestId ? `요청 ID ${requestId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (
    knownMessage &&
    status >= 500 &&
    !code &&
    ![
      "서비스 연결을 확인한 뒤 다시 시도하세요.",
      "외부 서버에 연결할 수 없습니다.",
      "서버에 연결할 수 없습니다.",
    ].includes(knownMessage)
  )
    reason = knownMessage;
  return `${operation(path, method.toUpperCase())} 실패: ${reason} (${details})`;
}
