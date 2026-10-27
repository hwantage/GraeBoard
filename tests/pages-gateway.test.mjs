import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/[[path]].js";

test("Pages fails closed with JSON when the private Worker is absent or unavailable", async () => {
  for (const path of ["/", "/assets/app.js", "/api/bootstrap"])
    for (const env of [
      {},
      {
        GRAEBOARD_BACKEND: {
          fetch() {
            throw new Error("private configuration");
          },
        },
      },
    ]) {
      const response = await onRequest({
        request: new Request("https://graeboard.pages.dev" + path),
        env,
        next() {
          throw new Error("must not fall back to Pages assets");
        },
      });
      assert.equal(response.status, 503);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: "외부 서버에 연결할 수 없습니다.",
      });
    }
});

test("Pages preserves origin, authentication, upload bytes, cookies and streaming responses", async () => {
  const bytes = new Uint8Array([0, 255, 18, 0, 128]);
  const request = new Request(
    "https://graeboard.pages.dev/api/events?cursor=one",
    {
      method: "POST",
      headers: {
        Origin: "https://graeboard.pages.dev",
        "Cf-Access-Jwt-Assertion": "signed-fixture",
        Cookie: "__Host-graeboard_account=fixture",
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    },
  );
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const result = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Set-Cookie":
        "__Host-graeboard_account=renewed; Path=/; Secure; HttpOnly",
      "Cache-Control": "no-store, no-transform",
    },
  });
  const response = await onRequest({
    request,
    env: {
      GRAEBOARD_BACKEND: {
        async fetch(forwarded) {
          assert.equal(forwarded.url, request.url);
          assert.equal(forwarded.method, "POST");
          for (const [name, value] of request.headers)
            assert.equal(forwarded.headers.get(name), value);
          assert.deepEqual(
            new Uint8Array(await forwarded.arrayBuffer()),
            bytes,
          );
          return result;
        },
      },
    },
  });
  assert.equal(
    response.headers.get("set-cookie"),
    result.headers.get("set-cookie"),
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  controller.close();
  assert.equal((await reader.read()).done, true);
});
