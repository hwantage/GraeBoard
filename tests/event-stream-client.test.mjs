import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";

const moduleURL = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const source = (name) =>
  stripTypeScriptTypes(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    { mode: "transform" },
  );
function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, key, previous)
        : delete globalThis[key],
    );
  }
}

test("페이지는 워커 재구독 요청을 받으면 health timeout 없이 처리한 커서로 연결한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const workers = [];
  class Worker {
    constructor() {
      this.messages = [];
      this.port = {
        postMessage: (message) => this.messages.push(message),
        start() {},
        close: () => {
          this.closed = true;
        },
      };
      workers.push(this);
    }
  }
  globals(t, {
    window: new EventTarget(),
    document: new EventTarget(),
    SharedWorker: Worker,
    EventSource: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
  });
  const clientCode = source("event-stream")
    .replaceAll(
      '"./event-stream-broker"',
      JSON.stringify(moduleURL(source("event-stream-broker"))),
    )
    .replace("import.meta.url", '"file:///test/event-stream.ts"');
  const { EventStream } = await import(moduleURL(clientCode));
  const stream = new EventStream("/api/teams/test/events");
  t.mock.timers.tick(0);
  workers[0].port.onmessage({ data: { kind: "ready" } });
  workers[0].port.onmessage({
    data: { kind: "state", id: stream.id, readyState: 1 },
  });
  workers[0].port.onmessage({
    data: {
      kind: "event",
      id: stream.id,
      event: "document",
      data: "{}",
      lastEventId: "epoch:7",
    },
  });
  assert.equal(stream.readyState, 1);
  workers[0].port.onmessage({ data: { kind: "resubscribe" } });
  assert.ok(workers[0].closed);
  assert.equal(stream.readyState, 0);
  t.mock.timers.tick(0);
  assert.equal(workers.length, 2);
  workers[1].port.onmessage({ data: { kind: "ready" } });
  assert.equal(workers[1].messages[0].streams[0].lastEventId, "epoch:7");
  stream.close();
  t.mock.timers.tick(0);
});

test("셀 스트림은 GET 복구 성공 후에도 SSE·5xx 실패가 반복되면 백오프하고 rejected 400은 종료한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sources = [];
  let reads = 0;
  class Stream {
    readyState = 0;
    handlers = new Map();
    constructor() {
      sources.push(this);
    }
    addEventListener(name, fn) {
      this.handlers.set(name, fn);
    }
    close() {
      this.readyState = 2;
    }
    emit(name, data = {}) {
      this.handlers.get(name)?.({ data: JSON.stringify(data) });
    }
    fail() {
      this.readyState = 2;
      this.onerror();
    }
  }
  globals(t, {
    EventSource: { CLOSED: 2 },
    __cellTest: {
      Stream,
      get: async () => {
        reads++;
        return { tasks: [], cellEventId: `epoch:${reads}` };
      },
    },
  });
  const code = source("cell-sync")
    .replace(
      '"./event-stream"',
      JSON.stringify(
        moduleURL(
          `export const EventStream=globalThis.__cellTest.Stream; export { retryableRejection } from ${JSON.stringify(moduleURL(source("event-stream-broker")))};`,
        ),
      ),
    )
    .replace(
      '"./api"',
      JSON.stringify(
        moduleURL(
          'export const api=globalThis.__cellTest.get; export class ApiError extends Error {} export const taskQuery=()=>"/tasks";',
        ),
      ),
    )
    .replace(
      '"../shared/compact.js"',
      JSON.stringify(new URL("../shared/compact.js", import.meta.url).href),
    );
  const { subscribeCellChanges } = await import(moduleURL(code));
  const stop = subscribeCellChanges({
    teamId: "test",
    year: 2026,
    cursor: "epoch:0",
    onActivity() {},
    onChanges() {},
    onSnapshot() {},
    onAccessLost() {},
  });
  t.after(stop);
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  for (const delay of [1000, 2000, 4000]) {
    const before = reads;
    sources.at(-1).fail();
    await tick(delay - 1);
    assert.equal(reads, before);
    await tick(1);
    assert.equal(reads, before + 1);
  }
  sources.at(-1).emit("ready");
  sources.at(-1).fail();
  await tick(1000);
  assert.equal(reads, 4, "정상 SSE ready 이후 지연을 초기화한다");
  for (const delay of [2000, 4000]) {
    const before = reads;
    sources.at(-1).emit("rejected", { status: 500 });
    assert.equal(sources.at(-1).readyState, 2);
    await tick(delay - 1);
    assert.equal(reads, before);
    await tick(1);
    assert.equal(reads, before + 1);
  }
  sources.at(-1).emit("rejected", { status: 400 });
  sources.at(-1).fail();
  await tick(60000);
  assert.equal(reads, 6, "거부된 채널은 같은 구독을 다시 만들지 않는다");
});

function clientModule(name) {
  return import(
    moduleURL(
      source("event-stream")
        .replaceAll(
          '"./event-stream-broker"',
          JSON.stringify(moduleURL(source("event-stream-broker"))),
        )
        .replace("import.meta.url", '"file:///test/event-stream.ts"') +
        `\n// ${name}`,
    )
  );
}

test("resumeSession은 기존 워커에 재개를 전달하고 구독 없는 로그인 화면도 확인 후 포트를 정리한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const workers = [];
  class Worker {
    constructor() {
      this.messages = [];
      this.port = {
        postMessage: (message) => this.messages.push(message),
        start() {},
        close: () => {
          this.closed = true;
        },
      };
      workers.push(this);
    }
  }
  globals(t, {
    window: new EventTarget(),
    document: new EventTarget(),
    SharedWorker: Worker,
    EventSource: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
  });
  const { EventStream, resumeSession } = await clientModule(t.name);
  const stream = new EventStream("/api/teams/test/events");
  t.mock.timers.tick(0);
  workers[0].port.onmessage({ data: { kind: "ready" } });
  workers[0].port.onmessage({
    data: { kind: "state", id: stream.id, readyState: 2 },
  });
  resumeSession();
  assert.equal(stream.readyState, 0);
  t.mock.timers.tick(0);
  assert.equal(workers[0].messages.at(-1).kind, "resume");
  workers[0].port.onmessage({ data: { kind: "resumed" } });
  t.mock.timers.tick(0);
  assert.ok(!workers[0].closed, "기존 구독 포트는 유지한다");
  stream.close();
  t.mock.timers.tick(0);
  assert.ok(workers[0].closed);
  resumeSession(); // Auth has no streams; the other tabs still need this signal.
  t.mock.timers.tick(0);
  assert.equal(workers.length, 2);
  workers[1].port.onmessage({ data: { kind: "ready" } });
  assert.deepEqual(workers[1].messages, [
    { kind: "sync", streams: [] },
    { kind: "resume" },
  ]);
  assert.ok(!workers[1].closed);
  workers[1].port.onmessage({ data: { kind: "resumed" } });
  t.mock.timers.tick(0);
  assert.ok(workers[1].closed, "재개를 전달한 임시 포트는 남기지 않는다");
});

test("SharedWorker가 없는 페이지의 resumeSession은 기존 fallback 구독을 직접 재개한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  globals(t, {
    window: new EventTarget(),
    document: new EventTarget(),
    SharedWorker: undefined,
    EventSource: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
  });
  const requests = [];
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const streams = JSON.parse(options.body).streams;
    requests.push(streams);
    if (requests.length === 1) return Response.json({}, { status: 401 });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: stream\ndata: ${JSON.stringify({ id: streams[0].id, event: "document", data: '{"revision":2}', lastEventId: "docs:2" })}\n\n`,
            ),
          );
          options.signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              controller.close();
            },
            { once: true },
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const { EventStream, resumeSession } = await clientModule(t.name);
  const stream = new EventStream("/api/teams/test/events");
  stream.lastEventId = "docs:1";
  const messages = [];
  stream.addEventListener("document", (event) => messages.push(event.data));
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  await tick(0);
  await tick(10);
  assert.equal(stream.readyState, 2);
  resumeSession();
  assert.equal(stream.readyState, 0);
  await tick(0);
  await tick(10);
  assert.equal(requests.length, 2);
  assert.equal(requests[1][0].path, requests[0][0].path);
  assert.equal(requests[1][0].lastEventId, "docs:1");
  assert.notEqual(requests[1][0].id, requests[0][0].id);
  assert.equal(stream.readyState, 1);
  assert.deepEqual(messages, ['{"revision":2}']);
  resumeSession();
  await tick(0);
  await tick(10);
  assert.equal(requests.length, 2);
  assert.equal(
    stream.readyState,
    1,
    "재승인할 세션이 없으면 원래 OPEN 상태를 복원한다",
  );
  stream.close();
  await tick(0);
  assert.ok(cancelled);
});
