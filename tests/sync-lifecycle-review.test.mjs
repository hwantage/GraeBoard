import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  getTask,
  json,
  transaction,
  touchTasks,
} from "../server/db.mjs";
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

test("reconnect retries a concurrent document save and another SQLite writer before committing", async (t) => {
  const f = await fixture(t);
  const memoId = randomUUID(),
    memoPath = `/teams/${f.teamId}/years/2026/memos/${memoId}`;
  ok(
    await f.api(`/teams/${f.teamId}/years/2026/memos`, {
      id: memoId,
      title: "before",
    }),
  );
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  const databasePath = f.db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main").file;
  let attempts = 0;
  f.options.onReconnectPrepared = async ({ attempt }) => {
    attempts++;
    if (attempt === 0)
      ok(
        await f.api(
          memoPath,
          {
            markdown: "saved during reconnection",
            expectedRevision: 0,
            operationId: randomUUID(),
          },
          "PUT",
        ),
      );
    if (attempt === 1) {
      const second = new DatabaseSync(databasePath);
      try {
        second
          .prepare("UPDATE annual_memos SET title=? WHERE id=?")
          .run("another handle", memoId);
      } finally {
        second.close();
      }
    }
  };
  ok(await f.api(`/teams/${f.teamId}/sync/reconnect`, {}));
  assert.equal(attempts, 3);
  const changes = f.store.readPending().flatMap((op) => op.changes);
  const memo = changes.find(
    (row) => row.entity === "document" && row.key.at(-1) === memoId,
  );
  assert.equal(memo.desired.markdown, "saved during reconnection");
  assert.equal(memo.desired.title, "another handle");
  assert.equal(f.store.readPending().length, 1);
});

test("reconnect rolls back failed capture and rejects recovery, foreign identity, busy leases and revoked managers", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  ok(await f.api("/cells/batch", f.command("offline edit")));
  const before = f.store.readLink();
  const reconnect = () => f.api(`/teams/${f.teamId}/sync/reconnect`, {});
  f.db.exec(
    "CREATE TEMP TRIGGER fail_reconnect BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  assert.equal((await reconnect()).status, 500);
  assert.deepEqual(f.store.readLink(), before);
  assert.equal(f.store.readPending().length, 0);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "offline edit");
  f.db.exec("DROP TRIGGER fail_reconnect");
  const originalFields = Object.fromEntries(
    Object.entries(before).filter(([key]) => key !== "team_id"),
  );
  for (const patch of [
    { mode: "recovery" },
    { installation_id: randomUUID() },
    { lease_owner: "another-writer", lease_until: Date.now() + 60000 },
  ]) {
    f.store.writeLink({ ...originalFields, ...patch });
    assert.equal((await reconnect()).status, 409);
    assert.equal(f.store.readPending().length, 0);
  }
  f.store.writeLink(originalFields);
  f.options.onReconnectPrepared = () => {
    f.db
      .prepare("UPDATE users SET system_role='user' WHERE id=?")
      .run(f.userId);
    f.db
      .prepare("UPDATE memberships SET role='member' WHERE user_id=?")
      .run(f.userId);
  };
  assert.equal((await reconnect()).status, 403);
  assert.equal(f.store.readLink().mode, "disconnected");
  assert.equal(f.store.readPending().length, 0);
  delete f.options.onReconnectPrepared;
  f.db
    .prepare("UPDATE memberships SET role='lead' WHERE user_id=?")
    .run(f.userId);
  ok(await reconnect());
  assert.equal(f.store.readLink().mode, "active");
  assert.equal(f.store.readPending().length, 1);
});

test("reconnect before initial publication preserves edits and waits for explicit initial publication", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  ok(await f.api("/cells/batch", f.command("before initial publication")));
  const pending = f.store.readPending();
  const status = ok(await f.api(`/teams/${f.teamId}/sync/reconnect`, {}));
  assert.equal(status.mode, "paused");
  assert.equal(await f.transport.readHead(), null);
  assert.deepEqual(f.store.readPending().slice(0, pending.length), pending);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  assert.equal(f.store.readPending().length, 0);
  assert.equal(
    getTask(f.db, f.task.id).cells.title.value,
    "before initial publication",
  );
});

test("reconnect automatically publishes saved edits without a second run request", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  ok(await f.api("/cells/batch", f.command("automatically published")));
  f.options.schedule = true;
  ok(await f.api(`/teams/${f.teamId}/sync/reconnect`, {}));
  await until(
    () =>
      f.store.readPending().length === 0 &&
      Object.values(f.store.readState().entities).some(
        (row) =>
          row.entity === "cell" &&
          row.payload.value === "automatically published",
      ),
    "Reconnect must schedule the real Git runner without another UI action",
  );
  assert.equal(await f.transport.readHead(), f.store.readLink().canonical_head);
});

test("reconnect under continued edits stays disconnected and can be retried without losing input", async (t) => {
  const f = await fixture(t);
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  ok(await f.api(`/teams/${f.teamId}/sync/disconnect`, {}));
  f.options.onReconnectPrepared = async ({ attempt }) => {
    ok(await f.api("/cells/batch", f.command(`concurrent edit ${attempt}`)));
  };
  const result = await f.api(`/teams/${f.teamId}/sync/reconnect`, {});
  assert.equal(result.status, 409);
  assert.match(result.data.error, /다른 사용자가 자료를 저장 중/);
  assert.equal(f.store.readLink().mode, "disconnected");
  assert.equal(f.store.readPending().length, 0);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "concurrent edit 2");
  delete f.options.onReconnectPrepared;
  ok(await f.api(`/teams/${f.teamId}/sync/reconnect`, {}));
  await f.app.locals.sync.get(f.teamId).run();
  assert.equal(f.store.readPending().length, 0);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "concurrent edit 2");
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

test("M14 cached business writes capture atomically across unlinked, linked, disconnected and relinked trigger schemas", async (t) => {
  const f = await fixture(t, { connected: false });
  const triggers = () =>
    f.db
      .prepare(
        "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'sync_detect_%' ORDER BY name",
      )
      .all();
  assert.deepEqual(triggers(), []);
  // Prime the business UPSERT, style lookup, timestamp and audit statements
  // before any capture triggers exist. Later requests reuse those programs.
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
  const linked = f.store.readPending()[0];
  const cell = linked.changes.find((change) => change.entity === "cell");
  assert.deepEqual(cell.key, [f.task.id, "title"]);
  assert.equal(cell.base.value, "unlinked save");
  assert.equal(cell.desired.value, "linked save");
  assert.equal(linked.actorRef, f.userId);
  assert.equal(
    linked.changes.some((change) => change.entity === "task"),
    false,
    "The cell save's task timestamp must not create a shared task change",
  );
  const oldStamp = getTask(f.db, f.task.id).updatedAt;
  transaction(f.db, () => touchTasks(f.db, [getTask(f.db, f.task.id)]));
  assert.notEqual(getTask(f.db, f.task.id).updatedAt, oldStamp);
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
  assert.equal(
    f.store.readPending()[1].changes.find((change) => change.entity === "cell")
      .base.value,
    "disconnected save",
  );
  // UPDATE OF must still capture shared task fields, including scripts using
  // the same transaction boundary as ordinary business commands.
  const beforeTask = getTask(f.db, f.task.id);
  transaction(f.db, () =>
    f.db
      .prepare("UPDATE tasks SET years=?,position=? WHERE id=?")
      .run(json([2026, 2027]), beforeTask.position + 10, f.task.id),
  );
  const taskChange = f.store.readPending().at(-1).changes;
  assert.equal(f.store.readPending().length, 3);
  assert.equal(taskChange.length, 1);
  assert.equal(taskChange[0].entity, "task");
  assert.deepEqual(taskChange[0].base.years, beforeTask.years);
  assert.deepEqual(taskChange[0].desired.years, [2026, 2027]);
  assert.equal(taskChange[0].desired.position, beforeTask.position + 10);

  const snapshot = () => ({
    task: getTask(f.db, f.task.id),
    pending: f.db
      .prepare("SELECT op_id,payload FROM sync_outbox ORDER BY local_seq")
      .all(),
    audit: f.db.prepare("SELECT * FROM audit ORDER BY id").all(),
    operations: f.db.prepare("SELECT * FROM operations ORDER BY id").all(),
    cursor: f.app.locals.cellEvents.cursor(),
  });
  const beforeFailure = snapshot(),
    command = f.command("retry after outbox failure");
  f.db.exec(`CREATE TEMP TRIGGER fail_outbox_insert BEFORE INSERT ON sync_outbox
    BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`);
  const rejected = await f.api("/cells/batch", command);
  assert.equal(rejected.status, 500);
  assert.deepEqual(snapshot(), beforeFailure);
  f.db.exec("DROP TRIGGER fail_outbox_insert");
  ok(await f.api("/cells/batch", command));
  assert.equal(
    getTask(f.db, f.task.id).cells.title.value,
    command.changes[0].value,
  );
  assert.equal(f.store.readPending().length, 4);
  assert.equal(
    f.store
      .readPending()
      .at(-1)
      .changes.find((change) => change.entity === "cell").desired.value,
    command.changes[0].value,
  );
  const committed = snapshot();
  ok(await f.api("/cells/batch", command));
  assert.deepEqual(
    snapshot(),
    committed,
    "A retry must not duplicate any writes or events",
  );
});

test("Cached style statements do not retain pruned style IDs across business commands", async (t) => {
  const f = await fixture(t, { connected: false });
  const red = { color: "#dc2626" },
    blue = { color: "#2563eb" };
  const saveStyle = async (key, style) => {
    const task = getTask(f.db, f.task.id);
    ok(
      await f.api("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: f.task.id,
            key,
            style,
            expectedVersion: task.cells[key]?.version ?? 0,
            expectedFormatRevision: task.formatting?.revision ?? 0,
          },
        ],
      }),
    );
  };
  const styleId = (key) =>
    f.db
      .prepare("SELECT style_id FROM cells WHERE task_id=? AND key=?")
      .get(f.task.id, key).style_id;
  await saveStyle("title", red);
  const firstId = styleId("title");
  await saveStyle("title", {});
  assert.equal(
    f.db.prepare("SELECT id FROM styles WHERE id=?").get(firstId),
    undefined,
  );
  // A different cell keeps the replacement style live while the earlier style
  // is requested again, exposing any cached data/object -> stale ID mapping.
  await saveStyle("owner", blue);
  assert.equal(
    styleId("owner"),
    firstId,
    "SQLite reused the pruned highest row ID",
  );
  await saveStyle("title", red);
  assert.notEqual(styleId("title"), styleId("owner"));
  const saved = getTask(f.db, f.task.id);
  assert.deepEqual(saved.cells.title.style, red);
  assert.deepEqual(saved.cells.owner.style, blue);
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
