import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";

const code = stripTypeScriptTypes(
  readFileSync(
    new URL("../src/event-stream-broker.ts", import.meta.url),
    "utf8",
  ),
);
const { StreamBroker } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const requests = [];
  const responses = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    let controller,
      closed = false;
    const request = {
      streams: JSON.parse(options.body).streams,
      send: (bytes) => controller.enqueue(bytes),
      end: () => {
        closed = true;
        controller.close();
      },
      fail: () => {
        if (!closed) {
          closed = true;
          controller.error(new Error("offline"));
        }
      },
      get closed() {
        return closed;
      },
    };
    requests.push(request);
    if (responses.length) {
      closed = true;
      const { status, data } = responses.shift();
      return Response.json(data, { status });
    }
    const body = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
      },
    });
    options.signal.addEventListener("abort", request.fail, { once: true });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const broker = new StreamBroker();
  const clients = [];
  t.after(() => clients.forEach((client) => client.close()));
  return {
    requests,
    respond: (status, data = {}) => responses.push({ status, data }),
    client() {
      const messages = [];
      const client = broker.attach((message) => messages.push(message));
      clients.push(client);
      return {
        ...client,
        messages,
        events: () => messages.filter((message) => message.kind === "event"),
      };
    },
    async tick(ms = 10) {
      t.mock.timers.tick(ms);
      await setImmediate();
    },
    async send(request, id, event, data, lastEventId) {
      const frame = `event: stream\ndata: ${JSON.stringify({ id, event, data: JSON.stringify(data), lastEventId })}\n\n`;
      // Split inside both UTF-8 and SSE field boundaries, as a real network does.
      const bytes = new TextEncoder().encode(frame);
      const size = bytes.length > 1024 * 1024 ? bytes.length : 7;
      for (let i = 0; i < bytes.length; i += size)
        request.send(bytes.slice(i, i + size));
      await setImmediate();
    },
  };
}
const doc = (id, name = "a") => ({
  id,
  path: `/api/tasks/${name}/documents/main/events`,
  lastEventId: "",
});
const cells = (id, cursor) => ({
  id,
  path: `/api/cells/events?year=2026&teamId=team&after=${cursor}`,
  lastEventId: "",
});

test("공유 브로커는 탭별 ID 충돌·중복 구독을 분리하고 마지막 구독 종료 시 연결을 닫는다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([doc(1)]);
  b.update([doc(1), doc(2, "b")]);
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].streams.length, 2);
  const wire = f.requests[0].streams;
  await f.send(f.requests[0], wire[0].id, "document", {
    markdown: '공유 "본문"\n다음 줄',
  });
  assert.equal(a.events().length, 1);
  assert.equal(b.events().length, 1);
  assert.equal(b.events()[0].id, 1);
  await f.send(f.requests[0], wire[1].id, "document", {
    markdown: "B의 다른 문서",
  });
  assert.equal(a.events().length, 1);
  assert.equal(b.events()[1].id, 2);
  a.close();
  await f.tick();
  assert.ok(
    !f.requests[0].closed,
    "중복 구독자 종료는 채널 집합을 바꾸지 않는다",
  );
  assert.equal(f.requests.length, 1);
  b.close();
  await f.tick();
  assert.ok(f.requests[0].closed);
  assert.equal(f.requests.length, 1);
});

test("늦게 열린 탭은 자신의 이전 커서부터 재전송받고 기존 탭의 현재 커서를 잘못 상속하지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([cells(1, "epoch:5")]);
  await f.tick();
  await f.send(
    f.requests[0],
    f.requests[0].streams[0].id,
    "ready",
    {},
    "epoch:10",
  );
  const b = f.client();
  b.update([cells(8, "epoch:7")]);
  await f.tick();
  assert.equal(f.requests[1].streams.length, 1);
  assert.equal(f.requests[1].streams[0].lastEventId, "epoch:7");
  assert.ok(!f.requests[1].streams[0].path.includes("after="));
  assert.equal(b.events().length, 0, "이전 사용자의 캐시를 전달하지 않는다");
  await f.send(
    f.requests[1],
    f.requests[1].streams[0].id,
    "cells",
    { cells: [] },
    "epoch:11",
  );
  assert.equal(b.events()[0].id, 8);
  assert.equal(b.events()[0].lastEventId, "epoch:11");
  f.requests[1].fail();
  await setImmediate();
  await f.tick(1500);
  assert.equal(f.requests[2].streams[0].lastEventId, "epoch:11");
});

test("다른 서버 세대의 늦은 탭은 reset을 요청하고 같은 경로의 나머지 구독을 유지한다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([cells(1, "new:5")]);
  await f.tick();
  await f.send(
    f.requests[0],
    f.requests[0].streams[0].id,
    "ready",
    {},
    "new:10",
  );
  b.update([cells(1, "old:7")]);
  await f.tick();
  assert.equal(f.requests[1].streams[0].lastEventId, "");
  b.update([]);
  await f.tick();
  assert.equal(
    f.requests.length,
    2,
    "동일 채널에서 리스너만 빠지면 연결을 유지한다",
  );
});

test("서버 heartbeat가 끊겨 프록시 연결만 남아도 마지막 커서부터 다시 연결한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([cells(1, "epoch:5")]);
  await f.tick();
  await f.send(
    f.requests[0],
    f.requests[0].streams[0].id,
    "ready",
    {},
    "epoch:8",
  );
  await f.tick(30000);
  f.requests[0].send(new TextEncoder().encode(": keep-alive\n\n"));
  await setImmediate();
  await f.tick(30000);
  assert.equal(f.requests.length, 1, "heartbeat는 연결의 유효 시간을 갱신한다");
  assert.ok(!f.requests[0].closed);
  await f.tick(15000);
  assert.ok(f.requests[0].closed, "끊기지 않은 응답도 무응답이면 취소한다");
  await f.tick(1500);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].streams[0].lastEventId, "epoch:8");
  a.close();
  await f.tick(60000);
  assert.equal(
    f.requests.length,
    2,
    "닫은 구독은 idle timer로 다시 열리지 않는다",
  );
});

test("동일 구독 집합과 커서는 재연결하지 않고 새 리스너에도 기존 연결로 전달한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([cells(1, "epoch:100")]);
  await f.tick();
  const wire = f.requests[0].streams[0];
  await f.send(f.requests[0], wire.id, "ready", {}, "epoch:110");
  a.update([cells(1, "epoch:100")]); // Page sync queued before the latest event.
  const b = f.client();
  b.update([cells(9, "epoch:110")]);
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.equal(b.messages.at(-1).readyState, 1);
  await f.send(f.requests[0], wire.id, "cells", { cells: [] }, "epoch:111");
  assert.equal(b.events()[0].lastEventId, "epoch:111");
  b.close();
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.ok(!f.requests[0].closed);
});

test("closed는 해당 채널만 종료하고 같은 청크의 다른 이벤트와 연결은 보존한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "b")]);
  await f.tick();
  const [bad, good] = f.requests[0].streams;
  f.requests[0].send(
    new TextEncoder().encode(
      `event: stream\ndata: ${JSON.stringify({ id: bad.id, event: "rejected", data: '{"status":400}' })}\n\n` +
        `event: closed\ndata: {"id":${bad.id}}\n\n` +
        `event: stream\ndata: ${JSON.stringify({ id: good.id, event: "document", data: '{"markdown":"정상 채널"}', lastEventId: "epoch:1" })}\n\n`,
    ),
  );
  await f.tick(10000);
  assert.equal(a.events().at(-1).data, '{"markdown":"정상 채널"}');
  assert.deepEqual(
    a.messages.find((m) => m.kind === "state" && m.readyState === 2),
    { kind: "state", id: 1, readyState: 2, error: true },
  );
  assert.ok(!a.messages.some((m) => m.id === 2 && m.readyState === 2));
  assert.equal(f.requests.length, 1);
  assert.ok(!f.requests[0].closed);
  a.update([doc(2, "b")]);
  await f.tick();
  assert.equal(
    f.requests.length,
    1,
    "닫힌 채널 제거로 두 번째 재연결을 만들지 않는다",
  );
  await f.send(
    f.requests[0],
    good.id,
    "document",
    { markdown: "다음 변경" },
    "epoch:2",
  );
  assert.equal(a.events().at(-1).lastEventId, "epoch:2");
});

test("단독 closed와 EOF는 두 탭의 커서를 보존해 백오프 후 재연결한다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([doc(1), cells(2, "cells:5")]);
  b.update([doc(9)]);
  await f.tick();
  const [document, cell] = f.requests[0].streams;
  await f.send(
    f.requests[0],
    document.id,
    "document",
    { markdown: "이전" },
    "docs:7",
  );
  await f.send(f.requests[0], cell.id, "ready", {}, "cells:8");
  f.requests[0].send(
    new TextEncoder().encode(
      `event: closed\ndata: {"id":${document.id}}\n\n` +
        `event: closed\ndata: {"id":${cell.id}}\n\n`,
    ),
  );
  f.requests[0].end();
  await setImmediate();
  assert.equal(a.messages.at(-1).readyState, 0);
  assert.ok(![...a.messages, ...b.messages].some((m) => m.readyState === 2));
  await f.tick(1499);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  assert.deepEqual(
    f.requests[1].streams.map((s) => s.lastEventId),
    ["docs:7", "cells:8"],
  );
  await f.send(
    f.requests[1],
    document.id,
    "document",
    { markdown: "복구" },
    "docs:9",
  );
  assert.equal(a.events().at(-1).data, '{"markdown":"복구"}');
  assert.equal(b.events().at(-1).data, '{"markdown":"복구"}');
});

for (const [reason, data] of [
  ["rejected", { status: 400 }],
  ["access-revoked", { status: 403 }],
  ["access-revoked", {}],
]) {
  test(`${reason} ${JSON.stringify(data)} 뒤 closed는 재시도하지 않고 모든 리스너가 떠난 뒤 새 채널을 만든다`, async (t) => {
    const f = fixture(t),
      a = f.client();
    a.update([doc(1)]);
    await f.tick();
    const id = f.requests[0].streams[0].id;
    await f.send(f.requests[0], id, reason, data);
    f.requests[0].send(
      new TextEncoder().encode(`event: closed\ndata: {"id":${id}}\n\n`),
    );
    f.requests[0].end();
    await setImmediate();
    await f.tick(60000);
    assert.equal(f.requests.length, 1);
    const b = f.client();
    b.update([doc(2)]);
    await f.tick();
    assert.equal(b.messages.at(-1).readyState, 2);
    assert.equal(f.requests.length, 1);
    a.close();
    b.close();
    const c = f.client();
    c.update([doc(3)]);
    await f.tick();
    assert.equal(f.requests.length, 2);
    assert.notEqual(f.requests[1].streams[0].id, id);
    assert.equal(c.messages.at(-1).readyState, 1);
  });
}

for (const reason of ["closed", "rejected 500"]) {
  test(`${reason}는 같은 청크의 정상 이벤트를 보존하고 반복 종료에 백오프한다`, async (t) => {
    const f = fixture(t),
      a = f.client();
    a.update([doc(1), doc(2, "b")]);
    await f.tick();
    for (const [attempt, delay] of [1500, 3000].entries()) {
      const request = f.requests[attempt];
      const [bad, good] = request.streams;
      request.send(
        new TextEncoder().encode(
          (reason === "rejected 500"
            ? `event: stream\ndata: ${JSON.stringify({ id: bad.id, event: "rejected", data: '{"status":500}' })}\n\n`
            : "") +
            `event: closed\ndata: {"id":${bad.id}}\n\n` +
            `event: stream\ndata: ${JSON.stringify({ id: good.id, event: "document", data: '{"markdown":"정상"}', lastEventId: `epoch:${attempt + 1}` })}\n\n`,
        ),
      );
      await setImmediate();
      assert.equal(a.events().at(-1).data, '{"markdown":"정상"}');
      assert.ok(!a.messages.some((m) => m.readyState === 2));
      assert.ok(!request.closed, "정상 채널은 재연결 대기 동안 살아 있다");
      await f.tick(delay - 1);
      assert.equal(f.requests.length, attempt + 1);
      await f.tick(1);
      assert.equal(f.requests.length, attempt + 2);
    }
  });
}

test("정상 채널의 heartbeat는 이미 예약한 일시 종료 재시도 기한을 초기화하지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "b")]);
  await f.tick();
  await f.tick(15000);
  f.requests[0].send(
    new TextEncoder().encode(
      `event: closed\ndata: {"id":${f.requests[0].streams[0].id}}\n\n`,
    ),
  );
  await setImmediate();
  await f.tick(500);
  f.requests[0].send(new TextEncoder().encode(": keep-alive\n\n"));
  await setImmediate();
  f.requests[0].end();
  await setImmediate();
  await f.tick(999);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  assert.equal(f.requests.length, 2);
});

test("HTTP 400은 거부 ID만 종료하고 정상 채널을 다시 연결한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  f.respond(400, { rejectedIds: [1] });
  a.update([doc(1), doc(2, "b")]);
  await f.tick();
  assert.ok(a.events().some((m) => m.id === 1 && m.event === "rejected"));
  assert.ok(!a.messages.some((m) => m.id === 2 && m.readyState === 2));
  await f.tick(0);
  assert.deepEqual(
    f.requests[1].streams.map((s) => s.path),
    [doc(2, "b").path],
  );
  await f.send(
    f.requests[1],
    f.requests[1].streams[0].id,
    "document",
    { markdown: "복구" },
    "epoch:1",
  );
  assert.equal(a.events().at(-1).id, 2);
  f.requests[1].fail();
  await setImmediate();
  await f.tick(1499);
  assert.equal(f.requests.length, 2);
  await f.tick(1);
  assert.equal(
    f.requests.length,
    3,
    "거부 구독 때문에 정상 채널의 실패 백오프가 늘지 않는다",
  );
});

test("요청 오류는 지수 백오프하고 구독 갱신으로 대기 시간을 우회하지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client();
  f.respond(400);
  f.respond(503);
  f.respond(403);
  a.update([doc(1)]);
  await f.tick();
  assert.ok(!a.messages.some((m) => m.readyState === 2));
  await f.tick(1499);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  assert.equal(f.requests.length, 2);
  a.update([doc(1), doc(2, "b")]);
  await f.tick(2999);
  assert.equal(f.requests.length, 2);
  await f.tick(1);
  assert.equal(f.requests.length, 3);
  await f.tick(5999);
  assert.equal(f.requests.length, 3);
  await f.tick(1);
  assert.equal(f.requests.length, 4);
});

test("HTTP 401 세션 만료는 모든 채널을 CLOSED로 종료한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  f.respond(401);
  a.update([doc(1), doc(2, "b")]);
  await f.tick();
  assert.deepEqual(
    a.messages.filter((m) => m.readyState === 2).map((m) => m.id),
    [1, 2],
  );
  await f.tick(60000);
  assert.equal(f.requests.length, 1);
});

for (const name of ["a", "new"]) {
  test(`401 이후 ${name} 구독 추가는 다른 탭에 남은 세션 종료 채널도 복구한다`, async (t) => {
    const f = fixture(t),
      a = f.client();
    f.respond(401);
    a.update([doc(1), doc(2, "b")]);
    await f.tick();
    const previousIds = f.requests[0].streams.map((s) => s.id);
    const b = f.client();
    b.update([doc(1, name)]);
    await f.tick();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[1].streams.every((s) => !previousIds.includes(s.id)));
    assert.equal(a.messages.at(-1).readyState, 1);
    const shared = f.requests[1].streams.find((s) => s.path === doc(1).path);
    await f.send(
      f.requests[1],
      shared.id,
      "document",
      { markdown: "재인증 뒤 변경" },
      "epoch:1",
    );
    assert.equal(a.events().at(-1).data, '{"markdown":"재인증 뒤 변경"}');
  });
}

test("연결 중 access-revoked 401은 재인증 후 다른 탭의 세션 종료 채널을 같은 커서로 복구한다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([doc(1)]);
  b.update([doc(2, "b")]);
  await f.tick();
  const wire = f.requests[0];
  for (const { id } of wire.streams) {
    await f.send(wire, id, "document", { markdown: "이전" }, `epoch:${id}`);
    await f.send(wire, id, "access-revoked", { status: 401 });
    wire.send(
      new TextEncoder().encode(`event: closed\ndata: {"id":${id}}\n\n`),
    );
  }
  wire.end();
  await setImmediate();
  for (const client of [a, b])
    assert.equal(client.messages.at(-1).readyState, 2);
  await f.tick(60000);
  assert.equal(
    f.requests.length,
    1,
    "만료 세션으로 자동 재연결을 반복하지 않는다",
  );
  a.update([doc(1), doc(3, "new")]);
  await f.tick();
  assert.equal(f.requests.length, 2);
  for (const client of [a, b])
    assert.equal(client.messages.at(-1).readyState, 1);
  for (const old of wire.streams) {
    const restored = f.requests[1].streams.find((s) => s.path === old.path);
    assert.notEqual(restored.id, old.id);
    assert.equal(restored.lastEventId, `epoch:${old.id}`);
    await f.send(
      f.requests[1],
      restored.id,
      "document",
      { markdown: "복구" },
      "epoch:9",
    );
  }
  for (const client of [a, b])
    assert.equal(client.events().at(-1).data, '{"markdown":"복구"}');
});

test("최신 스냅샷으로 합류한 리스너에는 자신의 커서 이전 셀을 재전송하지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([cells(1, "epoch:100")]);
  await f.tick();
  b.update([cells(2, "epoch:120")]);
  await f.tick();
  assert.equal(f.requests.length, 1);
  const wire = f.requests[0].streams[0];
  for (const n of [101, 120, 121])
    await f.send(
      f.requests[0],
      wire.id,
      "cells",
      { cells: [{ value: n }], updatedAt: { task: String(n) } },
      `epoch:${n}`,
    );
  assert.deepEqual(
    a.events().map((m) => JSON.parse(m.data).updatedAt.task),
    ["101", "120", "121"],
  );
  assert.deepEqual(
    b.events().map((m) => JSON.parse(m.data).updatedAt.task),
    ["121"],
  );
});

test("워커의 4MiB 대기열 초과는 포트 종료 전에 즉시 재구독을 요청한다", async (t) => {
  const f = fixture(t);
  const scope = {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    value: scope,
    configurable: true,
  });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, "self", previous)
      : delete globalThis.self,
  );
  const workerCode = stripTypeScriptTypes(
    readFileSync(
      new URL("../src/event-stream.worker.ts", import.meta.url),
      "utf8",
    ),
  ).replace(
    '"./event-stream-broker"',
    JSON.stringify(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`,
    ),
  );
  await import(
    `data:text/javascript;base64,${Buffer.from(workerCode).toString("base64")}`
  );
  const messages = [];
  const port = {
    postMessage: (m) => messages.push(m),
    start() {},
    close() {
      messages.push({ kind: "port-closed" });
    },
  };
  scope.onconnect({ ports: [port] });
  port.onmessage({ data: { kind: "sync", streams: [doc(1)] } });
  await f.tick();
  const wire = f.requests[0].streams[0];
  for (let n = 1; n <= 3; n++)
    await f.send(
      f.requests[0],
      wire.id,
      "document",
      { markdown: "가".repeat(750000) },
      `epoch:${n}`,
    );
  assert.deepEqual(
    messages.slice(-2).map((m) => m.kind),
    ["resubscribe", "port-closed"],
  );
  assert.ok(f.requests[0].closed);
});

for (const reason of ["closed", "rejected 500"]) {
  test(`${reason} 대기 중 구독 변경은 정상 전송을 유지하고 ${reason === "closed" ? "연결 백오프 후" : "10ms 후"} 반영한다`, async (t) => {
    const f = fixture(t),
      a = f.client();
    a.update([cells(1, "cells:1"), doc(2)]);
    await f.tick();
    const wire = f.requests[0],
      [bad, good] = wire.streams;
    await f.send(wire, good.id, "document", { markdown: "이전" }, "docs:1");
    if (reason === "rejected 500")
      await f.send(wire, bad.id, "rejected", { status: 500 });
    wire.send(
      new TextEncoder().encode(`event: closed\ndata: {"id":${bad.id}}\n\n`),
    );
    await setImmediate();
    a.update([doc(2)]); // cell-sync closes the rejected stream.
    assert.ok(!wire.closed);
    a.update([doc(2), doc(3, "new")]);
    await f.tick(reason === "closed" ? 1499 : 9);
    assert.equal(f.requests.length, 1);
    assert.ok(!wire.closed);
    await f.send(
      wire,
      good.id,
      "document",
      { markdown: "대기 중 정상 변경" },
      "docs:2",
    );
    assert.equal(a.events().at(-1).data, '{"markdown":"대기 중 정상 변경"}');
    await f.tick(1);
    assert.equal(f.requests.length, 2);
    assert.ok(wire.closed);
    assert.deepEqual(
      f.requests[1].streams.map((s) => [s.path, s.lastEventId]),
      [
        [doc(2).path, "docs:2"],
        [doc(3, "new").path, ""],
      ],
    );
  });
}

test("부분 종료 대기 중 마지막 구독을 제거하면 연결과 재시도를 즉시 정리한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "b")]);
  await f.tick();
  const wire = f.requests[0];
  wire.send(
    new TextEncoder().encode(
      `event: closed\ndata: {"id":${wire.streams[0].id}}\n\n`,
    ),
  );
  await setImmediate();
  a.update([]);
  assert.ok(wire.closed);
  await f.tick(60000);
  assert.equal(f.requests.length, 1);
});

test("부분 종료 대기 중 과거 커서로 합류하면 재전송 전 최신 이벤트를 받지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client(),
    b = f.client();
  a.update([cells(1, "cells:5"), doc(2)]);
  await f.tick();
  const wire = f.requests[0],
    [cell, document] = wire.streams;
  await f.send(wire, cell.id, "ready", {}, "cells:10");
  wire.send(
    new TextEncoder().encode(`event: closed\ndata: {"id":${document.id}}\n\n`),
  );
  await setImmediate();
  b.update([cells(3, "cells:7")]);
  assert.ok(wire.closed);
  await f.tick(1500);
  assert.equal(f.requests[1].streams[0].lastEventId, "cells:7");
  await f.send(f.requests[1], cell.id, "cells", { cells: [] }, "cells:8");
  assert.equal(b.events().at(-1).lastEventId, "cells:8");
  assert.equal(a.events().at(-1).lastEventId, "cells:10");
});

async function rejectChannel(f, request, id, end = false) {
  await f.send(request, id, "rejected", { status: 500 });
  request.send(
    new TextEncoder().encode(`event: closed\ndata: {"id":${id}}\n\n`),
  );
  if (end) request.end();
  await setImmediate();
}

test("5xx 채널의 3초 백오프는 새 구독의 첫 스냅샷을 늦추지 않는다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1)]);
  await f.tick();
  const bad = f.requests[0].streams[0].id;
  await rejectChannel(f, f.requests[0], bad, true);
  await f.tick(1500);
  await rejectChannel(f, f.requests[1], bad, true);
  a.update([doc(1), doc(2, "new")]);
  await f.tick(9);
  assert.equal(f.requests.length, 2);
  await f.tick(1);
  assert.deepEqual(
    f.requests[2].streams.map((s) => s.path),
    [doc(2, "new").path],
  );
  assert.equal(
    a.messages.filter((m) => m.kind === "state" && m.id === 1).at(-1)
      .readyState,
    0,
  );
  await f.send(
    f.requests[2],
    f.requests[2].streams[0].id,
    "document",
    { markdown: "즉시 표시" },
    "docs:1",
  );
  assert.equal(a.events().at(-1).data, '{"markdown":"즉시 표시"}');
  await f.tick(2989);
  assert.equal(f.requests.length, 3);
  await f.tick(1);
  assert.deepEqual(
    f.requests[3].streams.map((s) => s.path),
    [doc(1).path, doc(2, "new").path],
  );
  assert.equal(f.requests[3].streams[1].lastEventId, "docs:1");
});

test("5xx 대기 중 정상 채널의 EOF는 독립적인 1.5초 전송 백오프부터 시작한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "healthy")]);
  await f.tick();
  const bad = f.requests[0].streams[0].id;
  await rejectChannel(f, f.requests[0], bad);
  await f.tick(1500);
  await rejectChannel(f, f.requests[1], bad);
  f.requests[1].end();
  await setImmediate();
  await f.tick(1499);
  assert.equal(f.requests.length, 2);
  await f.tick(1);
  assert.deepEqual(
    f.requests[2].streams.map((s) => s.path),
    [doc(2, "healthy").path],
  );
  await f.tick(1499);
  assert.equal(f.requests.length, 3);
  await f.tick(1);
  assert.equal(f.requests[3].streams.length, 2);
});

test("5xx 채널이 15초 동안 유지된 뒤 실패하면 채널 백오프를 1.5초로 초기화한다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "healthy")]);
  await f.tick();
  const bad = f.requests[0].streams[0].id;
  for (const delay of [1500, 3000]) {
    await rejectChannel(f, f.requests.at(-1), bad);
    await f.tick(delay);
  }
  const request = f.requests.at(-1);
  await f.tick(15000);
  request.send(new TextEncoder().encode(": keep-alive\n\n"));
  await setImmediate();
  await rejectChannel(f, request, bad);
  await f.tick(1499);
  assert.equal(f.requests.length, 3);
  await f.tick(1);
  assert.equal(f.requests.length, 4);
});

for (const reason of ["HTTP 401", "access-revoked 401"]) {
  test(`${reason} 뒤 resume만 호출해도 두 탭의 키와 커서를 유지하며 새 채널로 복구한다`, async (t) => {
    const f = fixture(t),
      a = f.client(),
      b = f.client();
    a.update([doc(1)]);
    b.update([doc(2, "b")]);
    await f.tick();
    const initial = f.requests[0];
    for (const channel of initial.streams)
      await f.send(
        initial,
        channel.id,
        "document",
        { markdown: "이전" },
        `docs:${channel.id}`,
      );
    if (reason === "HTTP 401") {
      f.respond(401);
      initial.fail();
      await setImmediate();
      await f.tick(1500);
    } else {
      for (const { id } of initial.streams) {
        await f.send(initial, id, "access-revoked", { status: 401 });
        initial.send(
          new TextEncoder().encode(`event: closed\ndata: {"id":${id}}\n\n`),
        );
      }
      initial.end();
      await setImmediate();
    }
    assert.equal(a.messages.at(-1).readyState, 2);
    assert.equal(b.messages.at(-1).readyState, 2);
    const before = f.requests.length;
    b.resume();
    await f.tick();
    assert.equal(f.requests.length, before + 1);
    const restored = f.requests.at(-1);
    for (const [i, previous] of initial.streams.entries()) {
      assert.equal(restored.streams[i].path, previous.path);
      assert.equal(restored.streams[i].lastEventId, `docs:${previous.id}`);
      assert.notEqual(restored.streams[i].id, previous.id);
      await f.send(
        restored,
        restored.streams[i].id,
        "document",
        { markdown: "복구" },
        "docs:10",
      );
    }
    for (const client of [a, b])
      assert.equal(client.events().at(-1).data, '{"markdown":"복구"}');
    b.resume();
    await f.tick();
    assert.equal(
      f.requests.length,
      before + 1,
      "세션 종료가 없으면 재연결하지 않는다",
    );
    assert.ok(!restored.closed);
    assert.equal(b.messages.at(-1).readyState, 1);
  });
}

test("resume은 구독 자체의 거부를 다시 열지 않으며 5xx 대기 중 HTTP401도 전체 세션을 닫는다", async (t) => {
  const f = fixture(t),
    a = f.client();
  a.update([doc(1), doc(2, "healthy"), doc(3, "denied")]);
  await f.tick();
  const [bad, healthy, denied] = f.requests[0].streams;
  await f.send(f.requests[0], denied.id, "access-revoked", { status: 403 });
  f.requests[0].send(
    new TextEncoder().encode(`event: closed\ndata: {"id":${denied.id}}\n\n`),
  );
  await rejectChannel(f, f.requests[0], bad.id);
  a.update([doc(1), doc(2, "healthy"), doc(3, "denied"), doc(4, "new")]);
  f.respond(401);
  await f.tick();
  assert.ok(
    a.messages
      .filter((m) => m.kind === "state")
      .slice(-3)
      .every((m) => m.readyState === 2),
  );
  await f.tick(60000);
  assert.equal(
    f.requests.length,
    2,
    "5xx 재시도 타이머도 만료 세션으로 연결하지 않는다",
  );
  a.resume();
  await f.tick();
  const resumed = f.requests.at(-1).streams;
  assert.equal(resumed.length, 3);
  assert.ok(!resumed.some((s) => s.path === doc(3, "denied").path));
  assert.ok(resumed.some((s) => s.path === bad.path));
  assert.ok(resumed.some((s) => s.path === healthy.path));
});
