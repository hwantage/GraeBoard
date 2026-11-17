import { failure, privateHeaders } from "../../edge/security.mjs";

// Bounded, read-only Supabase Edge path. Does not load business data or run sync.
export const EXTERNAL_LOG_PAGE = 50;
export const EXTERNAL_LOG_BYTES = 256 * 1024;
const DAY = 86400000,
  CACHE_MS = 15000,
  TIMEOUT_MS = 8000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const day = (time) => new Date(time + 9 * 3600000).toISOString().slice(0, 10);
const problem = (status, message, retryAfter) =>
  Object.assign(new Error(message), { status, retryAfter });

export function externalLogWindow(query, now) {
  if (
    [...query.keys()].some(
      (key) => !["date", "problems", "before"].includes(key),
    ) ||
    [...query.keys()].some((key) => query.getAll(key).length !== 1)
  )
    throw problem(400, "로그 조회 조건을 확인하세요.");
  const dates = [...new Set([day(now), day(now - DAY)])];
  const date = query.get("date") || dates[0];
  if (
    !dates.includes(date) ||
    ![null, "0", "1"].includes(query.get("problems"))
  )
    throw problem(400, "최근 24시간 안의 로그 조회 날짜와 결과를 확인하세요.");
  const start = Math.max(Date.parse(date + "T00:00:00+09:00"), now - DAY);
  const end = Math.min(Date.parse(date + "T00:00:00+09:00") + DAY, now);
  const before = query.get("before");
  let cursor = null;
  if (before) {
    const parts = before.split("|");
    if (
      parts.length !== 2 ||
      !TIMESTAMP.test(parts[0]) ||
      !UUID.test(parts[1]) ||
      !Number.isFinite(Date.parse(parts[0] + "Z")) ||
      Date.parse(parts[0] + "Z") < start ||
      Date.parse(parts[0] + "Z") > end
    )
      throw problem(400, "이전 로그 조회 위치를 확인하세요.");
    cursor = { at: parts[0], id: parts[1] };
  }
  return {
    date,
    dates,
    start,
    end,
    cursor,
    problems: query.get("problems") === "1",
  };
}

// Never select request headers, bodies, full metadata or arbitrary SQL supplied
// by the browser. Limits apply inside ClickHouse, before downloading JSON.
export function externalLogSql(functionId, teamId, window) {
  if (!UUID.test(functionId) || !UUID.test(teamId))
    throw problem(503, "외부 동기화 로그의 Supabase 함수 설정을 확인하세요.");
  const phase = "startsWith(event_message, 'GraeBoard sync phase ')";
  const failedPhase = `(${phase} AND JSONExtractString(substringUTF8(event_message, 22), 'phase') = 'failed')`;
  const runtimeError = `(event_message IN ('CPU Time exceeded','Memory limit exceeded') OR log_attributes['reason'] IN ('CPUTime','Memory','WallClockTime') OR startsWith(event_message, 'GraeBoard scheduled synchronization failed') OR startsWith(event_message, 'GraeBoard team directory synchronization failed') OR startsWith(event_message, 'GraeBoard Worker request failed'))`;
  const requestError = `(source = 'function_edge_logs' AND toInt32OrZero(log_attributes['response.status_code']) >= 400 AND (startsWith(log_attributes['request.pathname'], '/functions/v1/graeboard/api/teams/${teamId}/sync') OR log_attributes['request.pathname'] = '/functions/v1/graeboard/_gateway/scheduled'))`;
  return `SELECT toString(id) AS id, formatDateTime(timestamp, '%Y-%m-%dT%H:%i:%S.%f', 'UTC') AS timestamp_text,
    substringUTF8(event_message, 1, 1200) AS message, source,
    log_attributes['execution_id'] AS execution_id,
    log_attributes['reason'] AS reason,
    log_attributes['cpu_time_used'] AS cpu_ms,
    log_attributes['response.status_code'] AS status
  FROM logs WHERE log_attributes['function_id'] = '${functionId}'
    AND timestamp >= parseDateTime64BestEffort('${new Date(window.start).toISOString()}', 6, 'UTC')
    AND timestamp < parseDateTime64BestEffort('${new Date(window.end).toISOString()}', 6, 'UTC')
    AND ((source = 'function_logs' AND (${runtimeError} OR ${window.problems ? failedPhase : phase})) OR ${requestError})
    ${window.cursor ? `AND (timestamp < parseDateTime64BestEffort('${window.cursor.at}', 6, 'UTC') OR (timestamp = parseDateTime64BestEffort('${window.cursor.at}', 6, 'UTC') AND toString(id) < '${window.cursor.id}'))` : ""}
    ORDER BY timestamp DESC, toString(id) DESC LIMIT ${EXTERNAL_LOG_PAGE + 1}`;
}

function clean(value, token) {
  return String(value || "")
    .slice(0, 4800)
    .split(token)
    .join("[비밀값 숨김]")
    .replace(/(?:Bearer\s+)[\w.+/=-]+/gi, "Bearer [숨김]")
    .replace(/\b(?:github_pat_|gh[pousr]_|sbp_)[\w-]+/g, "[토큰 숨김]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[토큰 숨김]")
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi, "[주소 숨김]")
    .replace(
      /((?:password|secret|token|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1[숨김]",
    );
}
export function externalLogEntry(row, token) {
  if (
    !UUID.test(row.id) ||
    !TIMESTAMP.test(row.timestamp_text) ||
    !Number.isFinite(Date.parse(row.timestamp_text + "Z"))
  )
    throw problem(502, "Supabase 로그 응답 형식을 확인하지 못했습니다.");
  const message = clean(row.message, token);
  const isPhase = message.startsWith("GraeBoard sync phase ");
  let phase = null;
  if (isPhase) {
    try {
      phase = JSON.parse(message.slice("GraeBoard sync phase ".length));
    } catch {
      /* bounded/truncated diagnostic */
    }
  }
  // A long failure message can be truncated after its phase field.
  const failedPhase = isPhase && /"phase"\s*:\s*"failed"/.test(message);
  const failed = !isPhase || failedPhase;
  const reason = row.reason;
  const code =
    message.includes("CPU Time exceeded") || reason === "CPUTime"
      ? "EDGE_CPU_LIMIT"
      : message.includes("Memory limit exceeded") || reason === "Memory"
        ? "EDGE_MEMORY_LIMIT"
        : reason === "WallClockTime"
          ? "EDGE_WALL_CLOCK_LIMIT"
          : Number(row.status) === 546
            ? "EDGE_RESOURCE_LIMIT"
            : Number(row.status) === 429
              ? "EDGE_RATE_LIMIT"
              : undefined;
  return {
    line: row.id,
    at: row.timestamp_text + "Z",
    kind: "external",
    ok: failed ? false : undefined,
    event: code || (failed ? "error" : "phase"),
    phase:
      typeof phase?.phase === "string"
        ? phase.phase.slice(0, 40)
        : failedPhase
          ? "failed"
          : undefined,
    ms: Number.isFinite(phase?.ms) ? phase.ms : undefined,
    executionId: UUID.test(row.execution_id) ? row.execution_id : undefined,
    cpuMs: /^\d+$/.test(row.cpu_ms) ? Number(row.cpu_ms) : undefined,
    error: failed
      ? { message, code, status: Number(row.status) || undefined }
      : undefined,
    message,
  };
}

async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > EXTERNAL_LOG_BYTES) {
    await response.body?.cancel();
    throw problem(502, "Supabase 로그 응답이 조회 용량 한도를 넘었습니다.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw problem(502, "Supabase 로그 응답이 비어 있습니다.");
  const decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > EXTERNAL_LOG_BYTES)
        throw problem(502, "Supabase 로그 응답이 조회 용량 한도를 넘었습니다.");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}

export function createExternalSyncLog({
  fetcher = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  // Per Edge instance, bounded to eight short-lived pages; authorization is
  // never cached. Different instances still honor upstream 429 independently.
  const states = new WeakMap();
  return async (request, env, teamId, authorize) => {
    try {
      if (request.method !== "GET")
        return failure(405, "GET 요청으로 조회하세요.");
      if (!UUID.test(teamId) || teamId !== env.SITE_TEAM_ID)
        return failure(403, "이 사이트의 팀만 사용할 수 있습니다.");
      if (request.headers.get("x-requested-with") !== "WeeklyPlan")
        return failure(403, "요청 헤더를 확인하세요.");
      const query = new URL(request.url).searchParams;
      const window = externalLogWindow(query, now());
      // The route authenticates the session; recheck current team management
      // permission before every read, including cached or coalesced requests.
      await authorize();
      const project = env.GRAEBOARD_LOG_PROJECT_REF;
      const token = env.GRAEBOARD_LOGS_TOKEN;
      if (
        !/^[a-z0-9]{20}$/.test(project || "") ||
        typeof token !== "string" ||
        !token ||
        !UUID.test(env.GRAEBOARD_LOG_FUNCTION_ID || "")
      )
        return failure(
          503,
          "Supabase 로그 연결이 설정되지 않았습니다. 운영자가 로그 조회 토큰·프로젝트·graeboard 함수 ID를 Edge Function에 등록해야 합니다.",
        );
      let state = states.get(env);
      if (
        !state ||
        state.token !== token ||
        state.project !== project ||
        state.functionId !== env.GRAEBOARD_LOG_FUNCTION_ID
      ) {
        state = {
          token,
          project,
          functionId: env.GRAEBOARD_LOG_FUNCTION_ID,
          pages: new Map(),
          inFlight: null,
          nextAt: 0,
        };
        states.set(env, state);
      }
      const key = `${window.date}:${window.problems}:${query.get("before") || ""}`;
      for (const [key, value] of state.pages)
        if (value.until <= now()) state.pages.delete(key);
      const cached = state.pages.get(key);
      if (cached)
        return Response.json(cached.page, { headers: privateHeaders });
      if (state.inFlight?.key === key)
        return Response.json(await state.inFlight.promise, {
          headers: privateHeaders,
        });
      if (state.inFlight || state.nextAt > now())
        throw problem(
          429,
          "로그 조회가 진행 중이거나 잠시 대기 중입니다. 잠시 후 새로 고치세요.",
          Math.max(1, Math.ceil((state.nextAt - now()) / 1000)),
        );
      const run = async () => {
        state.nextAt = now() + 3000;
        const url = new URL(
          `https://api.supabase.com/v1/projects/${project}/analytics/endpoints/logs`,
        );
        url.searchParams.set(
          "sql",
          externalLogSql(state.functionId, teamId, window),
        );
        url.searchParams.set(
          "iso_timestamp_start",
          new Date(window.start).toISOString(),
        );
        url.searchParams.set(
          "iso_timestamp_end",
          new Date(window.end).toISOString(),
        );
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const retry = Math.min(
              300,
              Math.max(3, Number(response.headers.get("retry-after")) || 60),
            );
            state.nextAt = now() + retry * 1000;
            throw problem(
              429,
              "Supabase 로그 조회 한도에 도달했습니다. 잠시 후 새로 고치세요.",
              retry,
            );
          }
          throw problem(
            502,
            [401, 403].includes(response.status)
              ? "Supabase 로그 조회 토큰의 만료 또는 analytics_logs_read 권한을 확인하세요."
              : response.status === 402
                ? "Supabase 로그 조회 요금제와 사용량을 확인하세요."
                : "Supabase 로그 서버에 연결하지 못했습니다. 잠시 후 새로 고치세요.",
          );
        }
        const data = await boundedJson(response);
        if (
          data.error ||
          !Array.isArray(data.result) ||
          data.result.length > EXTERNAL_LOG_PAGE + 1
        )
          throw problem(
            502,
            "Supabase에서 로그를 조회하지 못했습니다. 운영자가 로그 API 설정을 확인해야 합니다.",
          );
        const rows = data.result.slice(0, EXTERNAL_LOG_PAGE);
        const entries = rows.map((row) => externalLogEntry(row, token));
        const last = rows.at(-1);
        const page = {
          source: "supabase",
          level: "cycles",
          levels: [],
          canSetLevel: false,
          retentionDays: 1,
          date: window.date,
          dates: window.dates,
          entries,
          next:
            data.result.length > EXTERNAL_LOG_PAGE
              ? `${last.timestamp_text}|${last.id}`
              : null,
        };
        if (state.pages.size >= 8)
          state.pages.delete(state.pages.keys().next().value);
        state.pages.set(key, { page, until: now() + CACHE_MS });
        return page;
      };
      const promise = run();
      state.inFlight = { key, promise };
      try {
        return Response.json(await promise, { headers: privateHeaders });
      } finally {
        state.inFlight = null;
      }
    } catch (error) {
      const response = failure(
        error.status || 502,
        error.status
          ? error.message
          : "Supabase 로그 응답을 받지 못했습니다. 잠시 후 새로 고치세요.",
      );
      if (error.retryAfter)
        response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
  };
}
