import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { openDatabase, getTask, json, transaction } from "../server/db.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};
async function until(condition, message, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}
async function fixture(t, { connected = true, worker } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-sync-lifecycle-"));
  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(join(directory, "app.sqlite"));
  const teamId = randomUUID(),
    userId = randomUUID(),
    token = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Lifecycle",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "lifecycle@example.com", "Lifecycle", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + 3600000,
  );
  const transport = new GitCliTransport({
    directory: join(directory, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  const options = {
    installationId: randomUUID(),
    profiles: [{ profileId: "local", teamId, repository: "test/lifecycle" }],
    transports: { local: transport },
    schedule: false,
  };
  const acquired = join(directory, "worker-acquired");
  if (worker) {
    const workerPath = join(directory, "fault-worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
parentPort.on('message', (message) => {
  if (message.request) parentPort.postMessage({ mutation: { id: 1, action: 'acquire', teamId: message.request.config.teamId, owner: 'fault-worker' } });
  else if (message.mutationId === 1 && message.result === true) {
    writeFileSync(${JSON.stringify(acquired)}, 'acquired');
    ${worker === "exit" ? "process.exit(17);" : ""}
  }
});`,
    );
    options.backgroundWorkerUrl = pathToFileURL(workerPath);
    options.backgroundTimeoutMs = 500;
  }
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    syncOptions: options,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const api = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          Cookie: `weekly_session=${token}`,
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, data: unpack(await response.json()) };
  };
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.shutdown();
    app.locals.documentEvents.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  if (connected)
    ok(
      await api(
        `/admin/teams/${teamId}/connection`,
        { profileId: "local", expectedRevision: 0 },
        "PUT",
      ),
    );
  const task = ok(
    await api("/tasks", { teamId, year: 2026, fields: { title: "before" } }),
  ).task;
  const command = (value) => ({
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: task.id,
        key: "title",
        value,
        expectedVersion: getTask(db, task.id).cells.title.version,
      },
    ],
  });
  return {
    db,
    app,
    teamId,
    userId,
    api,
    options,
    acquired,
    transport,
    task,
    command,
    store: app.locals.sync.store(teamId),
  };
}

for (const worker of ["timeout", "exit"])
  test(`H5 actual background ${worker} reports failure, releases its lease, preserves pending and restarts successfully`, async (t) => {
    const f = await fixture(t, { worker });
    const pending = f.db
      .prepare("SELECT op_id,payload FROM sync_outbox ORDER BY local_seq")
      .all();
    assert.ok(pending.length);
    const failed = f.api(`/teams/${f.teamId}/sync/enable`, {});
    await until(
      () => existsSync(f.acquired),
      "Fault worker must acquire the real main-thread lease",
    );
    const result = await failed;
    assert.equal(result.status, 500);
    const status = ok(await f.api(`/teams/${f.teamId}/sync`));
    assert.match(
      status.lastError,
      worker === "timeout" ? /timed out/ : /exited \(17\)/,
    );
    assert.equal(
      status.mode,
      "initializing",
      "Runtime faults must not misclassify data as recovery corruption",
    );
    assert.deepEqual(
      f.db
        .prepare("SELECT op_id,payload FROM sync_outbox ORDER BY local_seq")
        .all(),
      pending,
    );
    assert.equal(f.store.readLink().canonical_head, null);
    await until(
      () => !f.store.readLink().lease_owner,
      "Terminated worker's lease must be released",
    );
    delete f.options.backgroundWorkerUrl;
    f.options.backgroundTimeoutMs = 10000;
    ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
    assert.equal(f.store.readLink().mode, "active");
    assert.equal(f.store.readLink().last_error, null);
    assert.equal(f.store.readPending().length, 0);
    assert.ok(await f.transport.readHead());
    const state = f.store.readState();
    for (const row of pending) {
      assert.ok(state.receipts[row.op_id]);
      assert.equal(
        f.db
          .prepare("SELECT payload FROM sync_outbox WHERE op_id=?")
          .get(row.op_id).payload,
        row.payload,
      );
    }
  });

test("M10 a pending save replaces the later periodic deadline and publishes without a manual run", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const oldHead = f.store.readLink().canonical_head;
  f.options.schedule = true;
  f.app.locals.sync.schedule(f.teamId, 60000);
  ok(await f.api("/cells/batch", f.command("debounced publish")));
  assert.equal(f.store.readPending().length, 1);
  // A later periodic request must also not postpone the already-earlier timer.
  f.app.locals.sync.schedule(f.teamId, 60000);
  await until(
    () => f.store.readPending().length === 0,
    "The save's 1.5s schedule must replace the 60s timer",
    8000,
  );
  assert.notEqual(f.store.readLink().canonical_head, oldHead);
  assert.equal(f.store.readLink().canonical_head, await f.transport.readHead());
});

test("M4 maintenance guard returns HTTP 409, rolls back business/outbox writes and permits an identical retry after completion", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const jobId = randomUUID();
  f.db
    .prepare(
      "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES(?,?,'year','verifying','{}','{}',?)",
    )
    .run(jobId, f.teamId, new Date().toISOString());
  const before = getTask(f.db, f.task.id),
    head = f.store.readLink().canonical_head;
  const command = f.command("keep this draft");
  const rejected = await f.api("/cells/batch", command);
  assert.equal(rejected.status, 409, JSON.stringify(rejected));
  assert.match(rejected.data.error, /정리.*진행/);
  assert.deepEqual(getTask(f.db, f.task.id), before);
  assert.equal(f.store.readPending().length, 0);
  assert.equal(f.store.readLink().canonical_head, head);
  f.db
    .prepare("UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id=?")
    .run(jobId);
  ok(await f.api("/cells/batch", command));
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "keep this draft");
  assert.equal(f.store.readPending().length, 1);
});

test("M14 unlinked and disconnected sites have no shared-write capture triggers; verified relink refresh reinstalls them", async (t) => {
  const f = await fixture(t, { connected: false });
  const triggers = () =>
    f.db
      .prepare(
        "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'sync_detect_%' ORDER BY name",
      )
      .all();
  assert.deepEqual(triggers(), []);
  ok(await f.api("/cells/batch", f.command("unlinked save")));
  assert.equal(f.store.readPending().length, 0);
  ok(
    await f.api(
      `/admin/teams/${f.teamId}/connection`,
      { profileId: "local", expectedRevision: 0 },
      "PUT",
    ),
  );
  const installed = triggers();
  assert.ok(installed.length > 0);
  ok(await f.api("/cells/batch", f.command("linked save")));
  assert.equal(f.store.readPending().length, 1);
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  assert.deepEqual(triggers(), []);
  ok(await f.api("/cells/batch", f.command("disconnected save")));
  assert.equal(f.store.readPending().length, 1);
  // Recovery/profile administration writes the verified link then refreshes
  // capture; this explicitly exercises that lifecycle boundary without Git.
  f.store.writeLink({ mode: "paused" });
  f.app.locals.sync.clear(f.teamId);
  assert.deepEqual(triggers(), installed);
  ok(await f.api("/cells/batch", f.command("relinked save")));
  assert.equal(f.store.readPending().length, 2);
});

test("L17 scheduling failure after COMMIT does not fail HTTP saves and script actors are explicit system identities", async (t) => {
  const f = await fixture(t);
  const messages = [];
  t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
  Object.defineProperty(f.options, "schedule", {
    configurable: true,
    get() {
      throw new Error("injected scheduler failure");
    },
  });
  ok(await f.api("/cells/batch", f.command("durable despite timer failure")));
  assert.equal(
    getTask(f.db, f.task.id).cells.title.value,
    "durable despite timer failure",
  );
  assert.ok(
    messages.some((message) => /injected scheduler failure/.test(message)),
  );
  assert.equal(f.store.readPending().at(-1).actorRef, f.userId);
  transaction(f.db, () =>
    f.db
      .prepare(
        "UPDATE cells SET value=?,version=version+1 WHERE task_id=? AND key='title'",
      )
      .run(json("script save"), f.task.id),
  );
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "script save");
  assert.equal(
    f.store.readPending().at(-1).actorRef,
    `system:${f.options.installationId}`,
  );
  assert.notEqual(f.store.readPending().at(-1).actorRef, f.userId);
});
