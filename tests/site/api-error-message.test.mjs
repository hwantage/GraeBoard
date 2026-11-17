import test from "node:test";
import assert from "node:assert/strict";
import { apiErrorMessage } from "../../shared/http/api-error-message.js";
import { createExternalSyncLog } from "../../worker/sync/sync-log-api.mjs";

test("real log configuration responses retain their cause behind Supabase's Edge error header", async () => {
  const team = "11111111-1111-4111-8111-111111111111";
  const path = `/teams/${team}/sync/log`;
  const read = createExternalSyncLog({
    fetcher: () => assert.fail("No log query before configuration"),
  });
  const response = await read(
    new Request(`https://board.pages.dev/api${path}`, {
      headers: { "X-Requested-With": "WeeklyPlan" },
    }),
    { SITE_TEAM_ID: team },
    team,
    async () => {},
  );
  assert.equal(response.status, 503);
  const message = apiErrorMessage({
    path,
    status: response.status,
    data: await response.json(),
    external: true,
    headers: new Headers({
      "sb-error-code": "EDGE_FUNCTION_ERROR",
      "sb-request-id": "log-config-request",
    }),
  });
  assert.match(message, /Supabase 로그 연결이 설정되지 않았습니다/);
  assert.match(message, /토큰.*프로젝트.*함수 ID/);
  assert.match(message, /HTTP 503.*log-config-request/);
  assert.doesNotMatch(message, /데이터베이스 연결/);
});

test("Supabase log errors preserve only approved diagnostics on the exact log route", () => {
  const headers = new Headers({ "sb-error-code": "EDGE_FUNCTION_ERROR" });
  for (const [status, error, expected] of [
    [
      502,
      "Supabase 로그 조회 토큰의 만료 또는 analytics_logs_read 권한을 확인하세요.",
      /analytics_logs_read/,
    ],
    [
      429,
      "Supabase 로그 조회 한도에 도달했습니다. 잠시 후 새로 고치세요.",
      /Supabase 로그 조회 한도/,
    ],
    [
      502,
      "Supabase 로그 조회 요금제와 사용량을 확인하세요.",
      /요금제와 사용량/,
    ],
  ]) {
    assert.match(
      apiErrorMessage({
        path: "/teams/team/sync/log?problems=1",
        status,
        data: { error },
        headers,
        external: true,
      }),
      expected,
    );
  }
  for (const path of [
    "/tasks",
    "/teams/team/sync/log/download",
    "/teams/team/sync/run",
  ]) {
    const message = apiErrorMessage({
      path,
      status: 502,
      headers,
      external: true,
      data: {
        error:
          "Supabase 로그 조회 토큰의 만료 또는 analytics_logs_read 권한을 확인하세요.",
      },
    });
    assert.doesNotMatch(message, /analytics_logs_read/);
  }
  const unsafe = apiErrorMessage({
    path: "/teams/team/sync/log",
    status: 503,
    headers,
    external: true,
    data: {
      error:
        "Supabase 로그 연결이 설정되지 않았습니다. postgres://secret:password@private/db",
    },
  });
  assert.doesNotMatch(unsafe, /secret|password|private/);
  for (const [status, code, expected] of [
    [546, "WORKER_LIMIT", /실행 자원 한도/],
    [503, "BOOT_ERROR", /함수를 시작하지 못했습니다/],
    [429, "RATE_LIMIT_EXCEEDED", /서버의 요청 제한/],
  ]) {
    const message = apiErrorMessage({
      path: "/api/teams/team/sync/log",
      status,
      external: true,
      headers: new Headers({ "sb-error-code": code }),
      data: { error: "Supabase 로그 조회 요금제와 사용량을 확인하세요." },
    });
    assert.match(message, expected);
    assert.doesNotMatch(message, /요금제와 사용량/);
  }
});

test("provider rate limits explain the failed task, retry window and trace reference", () => {
  const message = apiErrorMessage({
    path: "/tasks?teamId=private-team",
    status: 429,
    external: true,
    data: { code: "RATE_LIMIT_EXCEEDED", message: "provider text" },
    headers: new Headers({
      "retry-after": "12",
      "sb-request-id": "request-429",
    }),
  });
  for (const expected of [
    "업무 목록 조회 실패",
    "외부 서버의 요청 제한",
    "12초",
    "HTTP 429",
    "RATE_LIMIT_EXCEEDED",
    "request-429",
  ])
    assert.ok(message.includes(expected));
  assert.ok(!message.includes("private-team"));
});

test("resource limits, timeouts and malformed provider responses have actionable safe messages", () => {
  for (const [status, code, expected] of [
    [546, "WORKER_LIMIT", "실행 자원 한도"],
    [504, "IDLE_TIMEOUT", "응답 시간"],
    [503, "BOOT_ERROR", "시작하지 못했습니다"],
  ]) {
    const message = apiErrorMessage({
      path: "/teams/id/years/2026/memos/id",
      status,
      data: { message: "postgres://secret@private-db", code },
      headers: new Headers({ "sb-request-id": "request-test" }),
    });
    assert.ok(message.includes("꼬리 메모 조회 실패"));
    assert.ok(message.includes(expected));
    assert.ok(!message.includes("secret"));
  }
  for (const data of [
    null,
    "<html>private</html>",
    { message: "password=private" },
    { error: { message: "private" } },
  ]) {
    const message = apiErrorMessage({ path: "/tasks", status: 502, data });
    assert.ok(message.includes("HTTP 502"));
    assert.ok(!message.includes("private"));
  }
  assert.match(
    apiErrorMessage({ path: "/tasks", status: 200, invalidResponse: true }),
    /예상한 데이터 형식.*HTTP 200.*INVALID_RESPONSE/,
  );
});

test("validation and conflict messages stay intact while unknown 401 and network failures give next steps", () => {
  assert.match(
    apiErrorMessage({
      path: "/admin/example",
      status: 503,
      external: true,
      data: { error: "연결 확인 후 다시 시도하세요." },
    }),
    /연결 확인 후 다시 시도하세요.*HTTP 503/,
  );
  assert.equal(
    apiErrorMessage({
      path: "/cells/batch",
      status: 409,
      data: {
        error: "최신 내용을 확인하세요.",
        details: { current: { value: "kept" } },
      },
    }),
    "최신 내용을 확인하세요.",
  );
  assert.match(
    apiErrorMessage({
      path: "/bootstrap",
      status: 401,
      data: { code: 401, message: "JWT missing" },
    }),
    /다시 로그인.*HTTP 401/,
  );
  assert.match(
    apiErrorMessage({ path: "/tasks", status: 0 }),
    /네트워크·프록시.*네트워크 오류/,
  );
  const message = apiErrorMessage({
    path: "/tasks",
    status: 500,
    headers: new Headers({
      "sb-error-code": "https://secret.invalid",
      "sb-request-id": "private token",
    }),
  });
  assert.ok(!message.includes("secret"));
  assert.ok(!message.includes("private token"));
});

test("internal server error messages keep the editor's existing wording", () => {
  for (const status of [500, 503])
    assert.equal(
      apiErrorMessage({
        path: "/calendar/tags/id",
        method: "PUT",
        status,
        data: { error: "체크 저장 실패 검증" },
      }),
      "체크 저장 실패 검증",
    );
});
