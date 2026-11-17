import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createExternalSyncLog,
  EXTERNAL_LOG_BYTES,
  externalLogWindow,
  externalLogSql,
  externalLogEntry,
} from "../../worker/sync/sync-log-api.mjs";

const team = "11111111-1111-4111-8111-111111111111";
const functionId = "22222222-2222-4222-8222-222222222222";
const time = Date.parse("2026-11-17T08:50:00Z");
const settings = () => ({
  APP_ORIGIN: "https://board.pages.dev",
  SITE_TEAM_ID: team,
  GRAEBOARD_LOG_PROJECT_REF: "abcdefghijklmnopqrst",
  GRAEBOARD_LOGS_TOKEN: "sbp_private_logs_only",
  GRAEBOARD_LOG_FUNCTION_ID: functionId,
});
const request = (query = "", options = {}) =>
  new Request(`https://board.pages.dev/api/teams/${team}/sync/log${query}`, {
    headers: {
      "X-Requested-With": "WeeklyPlan",
      Cookie: "__Host-graeboard_account=lead",
    },
    ...options,
  });
const row = (changes = {}) => ({
  id: randomUUID(),
  timestamp_text: "2026-11-17T08:34:36.867000",
  message: "CPU Time exceeded",
  execution_id: randomUUID(),
  cpu_ms: "2000",
  reason: "",
  status: "",
  ...changes,
});
const authorized = async () => {};

test("Edge log reads recheck current permissions even for cached responses", async () => {
  const env = settings();
  let calls = 0,
    checks = 0,
    allowed = true;
  const authorize = async () => {
    checks++;
    if (!allowed) throw Object.assign(new Error("denied"), { status: 403 });
  };
  const read = createExternalSyncLog({
    now: () => time,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(
        options.headers.Authorization,
        `Bearer ${env.GRAEBOARD_LOGS_TOKEN}`,
      );
      assert.equal(options.redirect, "manual");
      assert.equal(
        url.pathname,
        "/v1/projects/abcdefghijklmnopqrst/analytics/endpoints/logs",
      );
      assert.match(url.searchParams.get("sql"), /LIMIT 51$/);
      return Response.json({ result: [row()] });
    },
  });
  const first = await read(request(), env, team, authorize);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const page = await first.json();
  assert.equal(page.entries[0].error.code, "EDGE_CPU_LIMIT");
  assert.equal(page.entries[0].cpuMs, 2000);
  assert.equal((await read(request(), env, team, authorize)).status, 200);
  assert.equal(calls, 1);
  assert.equal(checks, 2);
  allowed = false;
  assert.equal((await read(request(), env, team, authorize)).status, 403);
  assert.equal(calls, 1);
  assert.equal(checks, 3);
});

test("invalid team, method, header and injected query never reach the log provider", async () => {
  let calls = 0;
  const read = createExternalSyncLog({
    now: () => time,
    fetcher: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  const env = settings();
  for (const [req, expected] of [
    [request("?date=2026-01-01"), 400],
    [request("?sql=SELECT+secret"), 400],
    [request("?before=x%27+OR+1%3D1"), 400],
    [request("?problems=1&problems=0"), 400],
    [request("", { method: "POST", body: "{}" }), 405],
    [request("", { headers: {} }), 403],
    [
      new Request(request().url.replace(team, functionId), {
        headers: request().headers,
      }),
      403,
    ],
  ])
    assert.equal(
      (
        await read(
          req,
          env,
          new URL(req.url).pathname.split("/")[3],
          authorized,
        )
      ).status,
      expected,
    );
  assert.equal(calls, 0);
});

test("date bounds, filters and timestamp/id cursor are pushed into ClickHouse without offset scans", () => {
  const window = externalLogWindow(
    new URLSearchParams({ date: "2026-11-16", problems: "1" }),
    time,
  );
  assert.equal(window.start, time - 86400000);
  assert.equal(window.end, Date.parse("2026-11-16T15:00:00Z"));
  assert.deepEqual(window.dates, ["2026-11-17", "2026-11-16"]);
  const query = externalLogSql(functionId, team, window);
  assert.match(query, new RegExp(functionId));
  assert.match(query, /source = 'function_logs'/);
  assert.match(query, /CPUTime/);
  assert.match(query, /JSONExtractString.*phase.*failed/);
  assert.match(query, /team directory synchronization failed/);
  assert.doesNotMatch(query, /SELECT \*|OFFSET|request.headers/);
  assert.throws(() => externalLogSql("x' OR true", team, window));
});

test("concurrent requests coalesce; pagination is bounded and preserves timestamps with tied IDs; new filters are throttled", async () => {
  let tick = time,
    calls = 0,
    finish;
  const env = settings();
  const rows = Array.from({ length: 51 }, () => row()).sort((a, b) =>
    b.id.localeCompare(a.id),
  );
  const read = createExternalSyncLog({
    now: () => tick,
    fetcher: async (url) => {
      calls++;
      if (calls === 1)
        await new Promise((resolve) => {
          finish = resolve;
        });
      else
        assert.match(
          url.searchParams.get("sql"),
          new RegExp(`toString\\(id\\) < '${rows[49].id}'`),
        );
      return Response.json({ result: calls === 1 ? rows : [rows[50]] });
    },
  });
  const a = read(request(), env, team, authorized);
  const b = read(request(), env, team, authorized);
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  const pages = await Promise.all([a, b]);
  const first = await pages[0].json();
  assert.deepEqual(await pages[1].json(), first);
  assert.equal(calls, 1);
  assert.equal(first.entries.length, 50);
  assert.equal(first.next, `${rows[49].timestamp_text}|${rows[49].id}`);
  assert.equal(
    (await read(request("?problems=1"), env, team, authorized)).status,
    429,
  );
  tick += 3001;
  const second = await (
    await read(
      request(`?before=${encodeURIComponent(first.next)}`),
      env,
      team,
      authorized,
    )
  ).json();
  assert.equal(second.entries[0].line, rows[50].id);
  assert.equal(second.next, null);
  assert.equal(calls, 2);
});

test("missing configuration, provider errors and malformed/oversize responses are not presented as empty successful logs", async () => {
  let calls = 0;
  const readMissing = createExternalSyncLog({
    now: () => time,
    fetcher: async () => {
      calls++;
    },
  });
  assert.equal(
    (
      await readMissing(
        request(),
        { ...settings(), GRAEBOARD_LOGS_TOKEN: "" },
        team,
        authorized,
      )
    ).status,
    503,
  );
  assert.equal(calls, 0);
  for (const response of [
    Response.json({ error: "private upstream detail" }, { status: 403 }),
    Response.json({ error: "private upstream detail" }, { status: 402 }),
    Response.json({ error: "private upstream detail", result: [] }),
    Response.json({ result: [{}] }),
    Response.json({ result: Array.from({ length: 52 }, () => row()) }),
    new Response("{}", {
      headers: { "content-length": String(EXTERNAL_LOG_BYTES + 1) },
    }),
    new Response(" ".repeat(EXTERNAL_LOG_BYTES + 1)),
    new Response("not json"),
    new Response(null, {
      status: 302,
      headers: { Location: "https://another.example" },
    }),
  ]) {
    const read = createExternalSyncLog({
      now: () => time,
      fetcher: async () => response,
    });
    const result = await read(request(), settings(), team, authorized);
    assert.equal(result.status, 502);
    assert.doesNotMatch(
      await result.text(),
      /private upstream detail|sbp_private_logs_only/,
    );
  }
});

test("provider Retry-After blocks further upstream queries and raw credentials are redacted", async () => {
  let calls = 0,
    tick = time;
  const env = settings(),
    read = createExternalSyncLog({
      now: () => tick,
      fetcher: async () => {
        calls++;
        return calls === 1
          ? new Response(null, {
              status: 429,
              headers: { "Retry-After": "60" },
            })
          : Response.json({
              result: [
                row({
                  message: `GraeBoard Worker request failed ${env.GRAEBOARD_LOGS_TOKEN} Bearer abc123 https://host/?secret=x password="example"`,
                  reason: "Memory",
                }),
              ],
            });
      },
    });
  const first = await read(request(), env, team, authorized);
  assert.equal(first.status, 429);
  assert.equal(first.headers.get("retry-after"), "60");
  tick += 10000;
  assert.equal(
    (await read(request("?problems=1"), env, team, authorized)).status,
    429,
  );
  assert.equal(calls, 1);
  tick += 51000;
  const next = await read(request(), env, team, authorized);
  const text = await next.text();
  assert.doesNotMatch(text, /abc123|private_logs_only|host\/|example/);
  assert.match(text, /EDGE_MEMORY_LIMIT/);
});

test(
  "a stalled response body is aborted within the request deadline and does not leave the next query locked",
  { timeout: 12000 },
  async (t) => {
    // Keep Node alive while AbortSignal.timeout uses an unreferenced timer.
    const alive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(alive));
    let tick = time,
      calls = 0,
      aborted = false;
    const env = settings();
    const read = createExternalSyncLog({
      now: () => tick,
      fetcher: async (_url, { signal }) => {
        if (++calls > 1) return Response.json({ result: [] });
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(signal.reason);
                },
                { once: true },
              );
              controller.enqueue(new TextEncoder().encode('{"result":['));
            },
          }),
        );
      },
    });
    const response = await read(request(), env, team, authorized);
    assert.equal(response.status, 502);
    assert.equal(aborted, true);
    tick += 9000;
    assert.equal((await read(request(), env, team, authorized)).status, 200);
    assert.equal(calls, 2);
  },
);

test("a maximum-size page stays bounded and failed diagnostic phases are errors even if the message is truncated", async () => {
  const rows = Array.from({ length: 51 }, () =>
    row({ message: "\u{1f4cb}".repeat(1200) }),
  );
  const body = JSON.stringify({ result: rows });
  assert.ok(Buffer.byteLength(body) <= EXTERNAL_LOG_BYTES);
  const read = createExternalSyncLog({
    now: () => time,
    fetcher: async () => new Response(body),
  });
  const response = await read(request(), settings(), team, authorized);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).entries.length, 50);
  for (const message of [
    'GraeBoard sync phase {"label":"team","phase":"failed","error":"SYNC_AUTH"}',
    'GraeBoard sync phase {"label":"team","phase":"failed","error":"' +
      "x".repeat(1300),
  ]) {
    const entry = externalLogEntry(row({ message }), "secret");
    assert.equal(entry.ok, false);
    assert.equal(entry.phase, "failed");
    assert.equal(entry.event, "error");
    assert.ok(entry.error.message);
  }
});
