import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { installHttpFallback } from "../server/http-boundary.mjs";
import { createWorker } from "../worker/entry.mjs";
import { syncErrorMessage } from "../shared/sync-error-message.js";
import { apiErrorMessage } from "../shared/api-error-message.js";
import { unpack } from "../shared/compact.js";

test("sync diagnostics distinguish capacity, trust, authorization and rate limits without reflecting private details", () => {
  for (const [error, expected] of [
    [
      new Error("Snapshot exceeds uncompressed byte budget"),
      /스냅샷 용량 한도.*배포 버전.*보존/,
    ],
    [
      new Error(
        "External snapshot exceeds decoded byte capacity; canonical cursor is unchanged",
      ),
      /스냅샷 용량 한도/,
    ],
    [
      new Error("External synchronization entity capacity exceeded"),
      /항목 수.*허용 개수/,
    ],
    [
      new Error("External state and pending capacity exceeded"),
      /공유 자료와 미전송 변경.*외부 서버/,
    ],
    [
      new TypeError("fetch failed", {
        cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      }),
      /HTTPS 인증서.*Node·Git/,
    ],
    [new Error("GitHub request failed (403)"), /토큰.*권한/],
    [
      new Error("GitHub request failed (404)"),
      /저장소를 찾을 수 없습니다.*Repository access/,
    ],
    [
      new Error("GitHub request failed (403); retry after the scheduled delay"),
      /요청 한도.*잠시 후/,
    ],
    [new Error("fetch failed"), /네트워크·프록시·DNS/],
  ]) {
    assert.match(syncErrorMessage(error), expected);
  }
  assert.equal(
    syncErrorMessage(new Error("permission denied for table secret")),
    "",
  );
  assert.equal(
    syncErrorMessage(new Error("postgres://secret:password@internal/db")),
    "",
  );
  const snapshot = syncErrorMessage(
    "Snapshot exceeds uncompressed byte budget",
  );
  for (const message of ["Snapshot exceeds uncompressed byte budget", snapshot])
    assert.equal(
      apiErrorMessage({
        path: "/teams/test/sync/enable",
        method: "POST",
        status: 500,
        external: true,
        data: { error: message, code: "EXTERNAL_SYNC_CAPACITY" },
      }),
      snapshot,
    );
});

test("Node sync HTTP errors expose a safe cause while unrelated and unknown failures retain the generic boundary", async () => {
  const app = express();
  let failure = new Error("Snapshot exceeds uncompressed byte budget");
  app.post(["/api/teams/test/sync/enable", "/api/tasks"], () => {
    throw failure;
  });
  installHttpFallback(app, { staticDir: "/nonexistent-graeboard-static" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = async (path) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      { method: "POST" },
    );
    assert.equal(response.status, 500);
    return (await response.json()).error;
  };
  try {
    assert.match(
      await request("/api/teams/test/sync/enable"),
      /스냅샷 용량 한도/,
    );
    assert.match(await request("/api/tasks"), /서버에서 처리하지 못했습니다/);
    failure = new TypeError("fetch failed", {
      cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    });
    assert.match(
      await request("/api/teams/test/sync/enable"),
      /Node·Git.*인증서 신뢰/,
    );
    failure = new Error("postgres://secret:password@internal/db");
    const unknown = await request("/api/teams/test/sync/enable");
    assert.match(unknown, /서버에서 처리하지 못했습니다/);
    assert.doesNotMatch(unknown, /secret|password|internal/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("external worker HTTP boundary translates known sync errors and hides unknown provider diagnostics", async () => {
  let failure = new Error("Snapshot exceeds uncompressed byte budget");
  const worker = createWorker({
    verify: async () => {
      throw failure;
    },
    onError() {},
  });
  const request = () =>
    worker.fetch(new Request("https://example.test/api/teams/test/sync/run"), {
      GRAEBOARD_SITE: "external",
      APP_ORIGIN: "https://example.test",
    });
  let response = await request();
  assert.equal(response.status, 500);
  assert.match(unpack(await response.json()).error, /스냅샷 용량 한도/);
  failure = new Error("postgres://secret:password@internal/db");
  response = await request();
  assert.equal(response.status, 500);
  assert.equal(
    unpack(await response.json()).error,
    "서비스 연결을 확인한 뒤 다시 시도하세요.",
  );
});
