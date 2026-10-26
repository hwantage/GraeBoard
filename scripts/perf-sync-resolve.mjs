// Isolated HTTP conflict-resolution benchmark. Never opens an existing database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sourceRoot = resolve(flag("--source-root", process.cwd()));
const tasks = Number(flag("--tasks", "10000"));
const clients = Number(flag("--clients", "30"));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const epoch = () => performance.timeOrigin + performance.now();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
const moduleAt = (path) => import(pathToFileURL(join(sourceRoot, path)).href);

async function serverMain() {
  const [
    { openDatabase, json, transaction },
    { createApp },
    { DEFAULT_SETTINGS },
    { SqliteDatabase },
    { allEntities },
    { emptyState, entityId },
    { makeOperation },
    { reduce, validateSnapshot },
  ] = await Promise.all([
    moduleAt("server/db.mjs"),
    moduleAt("server/app.mjs"),
    moduleAt("shared/domain.js"),
    moduleAt("server/storage/sqlite.mjs"),
    moduleAt("server/sync/entities.mjs"),
    moduleAt("server/sync/protocol.mjs"),
    moduleAt("server/sync/operations.mjs"),
    moduleAt("server/sync/reducer.mjs"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "graeboard-resolve-http-"));
  const db = openDatabase(join(dir, "site.sqlite"));
  const teamId = id(1),
    userId = id(2),
    token = "resolve-benchmark-session";
  const stamp = "2026-10-27T00:00:00.000Z";
  const link = {
    team_id: teamId,
    repo_id: id(3),
    bootstrap_id: id(4),
    installation_id: id(5),
    writer_epoch: id(6),
    profile_id: "benchmark",
    mode: "paused",
    canonical_head: "a".repeat(40),
    updated_at: stamp,
  };
  const setupStart = performance.now();
  let conflictId, canonicalCount;
  function seed() {
    transaction(db, () => {
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        "Resolve benchmark",
        json(DEFAULT_SETTINGS),
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
      ).run(userId, "benchmark@example.test", "Benchmark", stamp);
      db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
        userId,
        teamId,
      );
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        hash(token),
        userId,
        Date.now() + 3600000,
      );
      const task = db.prepare(
        "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      );
      const cell = db.prepare(
        "INSERT INTO cells(task_id,key,value,style_id,version) VALUES(?,?,?,0,1)",
      );
      for (let i = 0; i < tasks; i++) {
        const taskId = id(1000 + i);
        task.run(taskId, teamId, "[2026]", i, userId, stamp, stamp);
        cell.run(taskId, "title", JSON.stringify("Task " + i));
        for (let k = 1; k < 27; k++)
          cell.run(
            taskId,
            "2026-W" + String(k).padStart(2, "0"),
            JSON.stringify("week " + k),
          );
      }
    });
    let state = { ...emptyState(), entities: allEntities(db, link) };
    canonicalCount = Object.keys(state.entities).length;
    const key = entityId("cell", [id(1000), "title"]),
      base = state.entities[key];
    const operation = (n, value) =>
      makeOperation({
        link,
        actorRef: userId,
        before: { [key]: base },
        after: { [key]: { ...base, payload: { ...base.payload, value } } },
        opId: id(n),
        createdAt: stamp,
      });
    state = reduce(state, operation(10, "canonical winner"), {
      teamId,
      repoId: link.repo_id,
    }).state;
    const losing = reduce(state, operation(11, "submitted resolution"), {
      teamId,
      repoId: link.repo_id,
    });
    assert.equal(losing.receipt.result, "conflict");
    state = losing.state;
    conflictId = losing.receipt.conflictId;
    validateSnapshot(state, { teamId, repoId: link.repo_id });
    db.prepare("UPDATE cells SET value=? WHERE task_id=? AND key='title'").run(
      JSON.stringify("canonical winner"),
      id(1000),
    );
    new SqliteDatabase(db).withTeamTransaction(teamId, (tx) => {
      const { team_id, ...fields } = link;
      tx.sync.writeLink(fields);
      tx.sync.writeState(state, link.canonical_head);
    });
  }
  seed();
  const setupMs = performance.now() - setupStart;
  let measured = false,
    writerStart = null;
  const writes = [],
    prepared = [],
    committed = [],
    publications = [],
    domainSelectExecutions = { task: 0, cell: 0, style: 0 };
  const originalExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (measured && /^BEGIN IMMEDIATE\s*;?$/i.test(sql.trim()))
      writerStart = epoch();
    try {
      return originalExec(sql);
    } finally {
      if (
        measured &&
        writerStart !== null &&
        /^(COMMIT|ROLLBACK)\s*;?$/i.test(sql.trim())
      ) {
        writes.push({
          startEpochMs: writerStart,
          endEpochMs: epoch(),
          durationMs: epoch() - writerStart,
          outcome: sql.trim(),
        });
        writerStart = null;
      }
    }
  };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const kind =
      sql === "SELECT * FROM tasks WHERE id=? AND team_id=?"
        ? "task"
        : sql ===
            "SELECT c.* FROM cells c JOIN tasks t ON t.id=c.task_id WHERE t.team_id=? AND c.task_id=? AND c.key=?"
          ? "cell"
          : sql === "SELECT data FROM styles WHERE id=?"
            ? "style"
            : null;
    if (kind)
      for (const method of ["get", "all"]) {
        const execute = statement[method].bind(statement);
        statement[method] = (...params) => {
          if (measured) domainSelectExecutions[kind]++;
          return execute(...params);
        };
      }
    return statement;
  };
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: {
      installationId: link.installation_id,
      schedule: false,
      onResolvePrepared: (metrics) => prepared.push(metrics),
      onResolveCommitted: (metrics) => committed.push(metrics),
    },
  });
  const publish = app.locals.cellEvents.publish;
  app.locals.cellEvents.publish = function (result, changedTasks) {
    if (measured)
      publications.push({
        operationId: result.operationId,
        atEpochMs: epoch(),
        cells: result.cells,
      });
    return publish.call(this, result, changedTasks);
  };
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  process.send({
    type: "ready",
    port: server.address().port,
    token,
    teamId,
    taskId: id(1000),
    conflictId,
    expectedHead: link.canonical_head,
    tasks,
    cells: tasks * 27,
    canonicalCount,
    setupMs,
    node: process.version,
  });
  process.on("message", async ({ requestId, kind, expected }) => {
    try {
      if (kind === "start") {
        measured = true;
        loop.enable();
        process.send({ requestId, value: { startedAtEpochMs: epoch() } });
      } else if (kind === "finish") {
        await delay(30);
        loop.disable();
        measured = false;
        const pending = app.locals.sync.store(teamId).readPending();
        const resolutions = pending.filter((op) =>
          op.resolves?.includes(conflictId),
        );
        assert.equal(resolutions.length, 1);
        assert.equal(
          db
            .prepare("SELECT value FROM cells WHERE task_id=? AND key='title'")
            .get(id(1000)).value,
          JSON.stringify("submitted resolution"),
        );
        for (const row of expected)
          assert.equal(
            db
              .prepare(
                "SELECT value FROM cells WHERE task_id=? AND key='title'",
              )
              .get(row.taskId).value,
            JSON.stringify(row.value),
          );
        assert.equal(
          app.locals.sync.store(teamId).readLink().canonical_head,
          link.canonical_head,
        );
        assert.equal(
          pending.length,
          expected.reduce((n, row) => n + row.saves, 0) + 1,
        );
        process.send({
          requestId,
          value: {
            writes,
            prepared,
            committed,
            publications,
            domainSelectExecutions,
            eventLoop: {
              meanMs: loop.mean / 1e6,
              p95Ms: loop.percentile(95) / 1e6,
              maxMs: loop.max / 1e6,
            },
            correctness: {
              resolvedValue: true,
              resolutionPendingExactlyOnce: true,
              concurrentValuesPreserved: true,
              everySavePending: true,
              canonicalHeadUnchanged: true,
            },
            pendingCount: pending.length,
          },
        });
      } else if (kind === "stop") {
        await app.locals.sync.close();
        app.locals.cellEvents.close();
        app.locals.documentEvents.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        db.close();
        rmSync(dir, { recursive: true, force: true });
        process.send({ requestId, value: { stopped: true } }, () =>
          process.disconnect(),
        );
      }
    } catch (error) {
      process.send({ requestId, error: error.stack });
    }
  });
}

async function main() {
  assert.ok(Number.isInteger(tasks) && tasks > clients && tasks <= 10000);
  assert.ok(Number.isInteger(clients) && clients >= 1 && clients <= 30);
  const output = resolve(
    flag("--output", "docs/validation/perf-sync-resolve.json"),
  );
  assert.equal(
    existsSync(output),
    false,
    "Refusing to overwrite prior evidence",
  );
  mkdirSync(dirname(output), { recursive: true });
  const report = {
    schemaVersion: 1,
    label: flag("--label", "resolve"),
    startedAt: new Date().toISOString(),
    sourceRoot,
    declaredSourceCommit: flag("--source-commit", null),
    node: process.version,
    tasks,
    cellsPerTask: 27,
    concurrentWriters: clients,
    harnessSha256: hash(readFileSync(script)),
    productFiles: {},
    status: "running",
    scope: [
      "Real HTTP resolve against valid directly seeded linked canonical state/conflict; no Git publication or initial enable throughput measured.",
      "Independent client process measures HTTP/SSE while server is blocked. Thirty unrelated-task serial writers and thirty dedicated SSE readers by default; each starts another save 10ms after prior response.",
      "All BEGIN IMMEDIATE through COMMIT/ROLLBACK wall spans measured, including commit execution; this is not SQLite internal lock instrumentation.",
      "Preparation metrics come from final runtime hooks. Baseline main-thread counters count actual get/all executions of exact task/cell/style readEntity SQL and can include ordinary capture reads; the wrapper adds the same counter instrumentation to both runtimes.",
      "One fixture/run per requested invocation; synthetic local data and loopback HTTP, not production capacity evidence.",
    ],
  };
  for (const file of [
    "server/app.mjs",
    "server/db.mjs",
    "server/sync/node.mjs",
    "server/sync/background-worker.mjs",
    "server/sync/node-background.mjs",
    "server/sync/entities.mjs",
    "server/sync/reducer.mjs",
    "server/sync/capture.mjs",
  ])
    report.productFiles[file] = hash(readFileSync(join(sourceRoot, file)));
  try {
    report.observedGitHead = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    report.observedGitHead = null;
  }
  const child = fork(
    script,
    [
      "--server",
      "--source-root",
      sourceRoot,
      "--tasks",
      String(tasks),
      "--clients",
      String(clients),
    ],
    { cwd: sourceRoot, stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  const waiters = new Map();
  let readyResolve,
    readyReject,
    sequence = 0,
    stopped = false;
  const ready = new Promise((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  child.on("message", (message) => {
    if (message.type === "ready") readyResolve(message);
    else if (waiters.has(message.requestId)) {
      const { resolve, reject } = waiters.get(message.requestId);
      waiters.delete(message.requestId);
      message.error ? reject(new Error(message.error)) : resolve(message.value);
    }
  });
  child.on("error", readyReject);
  const exit = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      if (!stopped) {
        const error = new Error(`Benchmark child exited ${code}/${signal}`);
        readyReject(error);
        for (const waiter of waiters.values()) waiter.reject(error);
      }
      resolveExit({ code, signal });
    }),
  );
  const rpc = (kind, extra = {}) =>
    new Promise((resolveRpc, reject) => {
      const requestId = ++sequence;
      waiters.set(requestId, { resolve: resolveRpc, reject });
      child.send({ requestId, kind, ...extra });
    });
  const abort = new AbortController();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    const fixture = await ready;
    report.fixture = fixture;
    const { unpack, parseCompact } = await moduleAt("shared/compact.js");
    const base = `http://127.0.0.1:${fixture.port}`;
    const api = async (path, body) => {
      const startEpochMs = epoch();
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          Cookie: "weekly_session=" + fixture.token,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = unpack(await response.json());
      return {
        status: response.status,
        data,
        startEpochMs,
        endEpochMs: epoch(),
        durationMs: epoch() - startEpochMs,
      };
    };
    const events = [],
      pumps = [];
    let streamError,
      streamReady = 0;
    for (let client = 0; client < clients; client++) {
      const response = await fetch(
        `${base}/api/cells/events?teamId=${fixture.teamId}&year=2026`,
        {
          headers: { Cookie: "weekly_session=" + fixture.token },
          signal: abort.signal,
        },
      );
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      pumps.push(
        (async () => {
          let buffer = "";
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const type = frame.match(/^event: (.+)$/m)?.[1];
                if (type === "ready") streamReady++;
                if (type === "cells")
                  events.push({
                    client,
                    receivedAtEpochMs: epoch(),
                    data: parseCompact(frame.match(/^data: (.+)$/m)[1]),
                  });
              }
            }
          } catch (error) {
            if (!abort.signal.aborted) streamError = error;
          }
        })(),
      );
    }
    for (let n = 0; streamReady < clients && n < 200; n++) await delay(10);
    assert.equal(streamReady, clients, "All dedicated cell SSE clients ready");
    report.measurementStart = await rpc("start");
    const saves = [],
      expected = Array.from({ length: clients }, (_, i) => ({
        taskId: id(1001 + i),
        value: "Task " + (i + 1),
        version: 1,
        saves: 0,
      }));
    let saving = true;
    const writers = expected.map(async (state, client) => {
      while (saving) {
        const value = `concurrent-${client}-${state.saves}`;
        const operationId = randomUUID();
        const saved = await api("/api/cells/batch", {
          operationId,
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: state.taskId,
              key: "title",
              value,
              expectedVersion: state.version,
            },
          ],
        });
        assert.equal(saved.status, 200, JSON.stringify(saved));
        state.version = saved.data.cells[0].version;
        state.value = value;
        state.saves++;
        saves.push({ client, operationId, ...saved });
        await delay(10);
      }
    });
    await delay(50);
    report.resolve = await api(
      `/api/teams/${fixture.teamId}/sync/conflicts/${fixture.conflictId}/resolve`,
      { choice: "submitted", expectedHead: fixture.expectedHead },
    );
    assert.equal(report.resolve.status, 200, JSON.stringify(report.resolve));
    await delay(100);
    saving = false;
    await Promise.all(writers);
    for (
      let n = 0;
      n < 300 &&
      !saves.every(
        (save) =>
          events.filter((event) => event.data.operationId === save.operationId)
            .length === clients,
      );
      n++
    )
      await delay(10);
    if (streamError) throw streamError;
    for (const save of saves) {
      const delivered = events.filter(
        (row) => row.data.operationId === save.operationId,
      );
      assert.equal(
        new Set(delivered.map((event) => event.client)).size,
        clients,
        "Every ordinary save must reach all dedicated SSE clients",
      );
      for (const event of delivered)
        assert.deepEqual(event.data.cells, save.data.cells);
    }
    const resolved = events.filter((event) =>
      event.data.cells?.some(
        (cell) =>
          cell.taskId === fixture.taskId &&
          cell.value === "submitted resolution",
      ),
    );
    assert.equal(
      new Set(resolved.map((event) => event.client)).size,
      clients,
      "Resolution reaches every dedicated cell SSE client",
    );
    report.server = await rpc("finish", { expected });
    report.saves = saves;
    report.events = events;
    report.saveLatencyMs = summary(saves.map((save) => save.durationMs));
    const resolutionPublication = report.server.publications.find((entry) =>
      entry.cells?.some(
        (cell) =>
          cell.taskId === fixture.taskId &&
          cell.value === "submitted resolution",
      ),
    );
    assert.ok(resolutionPublication, "Resolution commit publication recorded");
    report.resolve.commitToAllSseMs =
      Math.max(...resolved.map((event) => event.receivedAtEpochMs)) -
      resolutionPublication.atEpochMs;
    const commits = new Map(
      report.server.publications.map((row) => [row.operationId, row.atEpochMs]),
    );
    report.commitToAllSseMs = summary(
      saves.map(
        (save) =>
          Math.max(
            ...events
              .filter((event) => event.data.operationId === save.operationId)
              .map((event) => event.receivedAtEpochMs),
          ) - commits.get(save.operationId),
      ),
    );
    report.overlappingSaves = saves.filter(
      (save) =>
        save.startEpochMs <= report.resolve.endEpochMs &&
        save.endEpochMs >= report.resolve.startEpochMs,
    ).length;
    assert.ok(
      report.overlappingSaves >= clients,
      "At least 30 ordinary saves genuinely overlap the resolve HTTP request",
    );
    report.writeTransactionMs = summary(
      report.server.writes.map((row) => row.durationMs),
    );
    report.correctness = {
      ...report.server.correctness,
      everyOrdinarySaveDelivered: true,
      resolutionDelivered: true,
    };
    abort.abort();
    await Promise.all(pumps);
    stopped = true;
    await rpc("stop");
    report.childExit = await exit;
    assert.equal(report.childExit.code, 0);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    abort.abort();
    child.kill("SIGTERM");
    await exit;
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    report.completedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          output,
          status: report.status,
          resolveMs: report.resolve?.durationMs,
          saveLatencyMs: report.saveLatencyMs,
          commitToAllSseMs: report.commitToAllSseMs,
          writeTransactionMs: report.writeTransactionMs,
          eventLoop: report.server?.eventLoop,
          prepared: report.server?.prepared,
          committed: report.server?.committed,
          error: report.error,
        },
        null,
        2,
      ),
    );
  }
}

if (args.includes("--server"))
  serverMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  });
else
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
