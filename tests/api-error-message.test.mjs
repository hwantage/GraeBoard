import test from "node:test";
import assert from "node:assert/strict";
import { apiErrorMessage } from "../shared/api-error-message.js";

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
