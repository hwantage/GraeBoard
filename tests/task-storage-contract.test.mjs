import { createExternalRouteApp } from "./external-route-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import {
  openDatabase,
  insertTask,
  userWithTeams,
  json,
  getTask,
} from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS, sampleProperties } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { RequestContext } from "../worker/control.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { canonical, emptyState } from "../server/sync/protocol.mjs";

function sqliteFixture(t) {
  const dir = mkdtempSync("/tmp/gb-task-contract-"),
    db = openDatabase(join(dir, "data.sqlite")),
    teamId = randomUUID(),
    userId = randomUUID(),
    adapter = new SqliteDatabase(db),
    stamp = new Date().toISOString();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Repository contract",
    json({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "contract@example.test", "Contract", stamp);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(userId).digest("hex"),
    userId,
    Date.now() + 600000,
  );
  const task = insertTask(db, {
      teamId,
      year: 2026,
      actorId: userId,
      fields: { title: "initial", description: "second", owner: userId },
    }),
    link = {
      team_id: teamId,
      repo_id: randomUUID(),
      bootstrap_id: randomUUID(),
      installation_id: randomUUID(),
      writer_epoch: randomUUID(),
      profile_id: "contract",
      mode: "paused",
      canonical_head: "a".repeat(40),
      updated_at: stamp,
    },
    state = { ...emptyState(), entities: allEntities(db, link) };
  adapter.withTeamTransaction(teamId, (tx) => {
    const { team_id, ...fields } = link;
    tx.sync.writeLink(fields);
    tx.sync.writeState(state, link.canonical_head);
  });
  const user = userWithTeams(
      db,
      db.prepare("SELECT * FROM users WHERE id=?").get(userId),
    ),
    app = createApp({
      db,
      rateLimits: false,
      syncOptions: { schedule: false, installationId: link.installation_id },
    });
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, adapter, app, user, teamId, taskId: task.id, link, state };
}
const request = (changes) => ({
  operationId: randomUUID(),
  createdAt: new Date().toISOString(),
  changes,
});
const decoded = (result) =>
  result.data || unpack(JSON.parse(result.encoded.body));

async function commonContract({
  service,
  teamId,
  taskId,
  counts,
  failOnce,
  events,
}) {
  const initial = await service.query({ teamId, year: "2026" }),
    initialTask = decoded(initial).tasks.find((row) => row.id === taskId);
  assert.equal(initialTask.cells.title.value, "initial");
  assert.equal(
    (
      await service.query(
        { teamId, year: "2026" },
        { ifNoneMatch: initial.etag },
      )
    ).notModified,
    true,
  );
  const first = request([
      {
        taskId,
        key: "title",
        expectedVersion: initialTask.cells.title.version,
        value: "saved",
      },
    ]),
    before = await counts(),
    result = await service.saveBatch(first),
    saved = await counts();
  assert.equal(result.cells[0].value, "saved");
  assert.equal(saved.operations, before.operations + 1);
  assert.equal(saved.pending, before.pending + 1);
  assert.equal(saved.audit, before.audit + 1);
  assert.equal(await events(), 1);
  assert.deepEqual(await service.saveBatch(first), result);
  assert.deepEqual(await counts(), saved);
  assert.equal(await events(), 1);
  const current = decoded(
    await service.query({ teamId, year: "2026" }),
  ).tasks.find((row) => row.id === taskId);
  const mixed = request([
    {
      taskId,
      key: "description",
      expectedVersion: current.cells.description.version,
      value: "must roll back",
    },
    {
      taskId,
      key: "title",
      expectedVersion: initialTask.cells.title.version,
      value: "stale",
    },
  ]);
  await assert.rejects(
    Promise.resolve().then(() => service.saveBatch(mixed)),
    (error) => error.status === 409,
  );
  assert.deepEqual(await counts(), saved);
  assert.equal(await events(), 1);
  failOnce();
  const failed = request([
    {
      taskId,
      key: "title",
      expectedVersion: current.cells.title.version,
      value: "late transaction failure",
    },
  ]);
  await assert.rejects(
    Promise.resolve().then(() => service.saveBatch(failed)),
    /injected storage failure/,
  );
  assert.deepEqual(await counts(), saved);
  assert.equal(await events(), 1);
  assert.equal(
    decoded(await service.query({ teamId, year: "2026" })).tasks.find(
      (row) => row.id === taskId,
    ).cells.title.value,
    "saved",
  );
  const staleStyle = request([
    {
      taskId,
      key: "title",
      expectedVersion: current.cells.title.version,
      expectedFormatRevision: (current.formatting?.revision || 0) + 1,
      style: { bold: true },
    },
  ]);
  await assert.rejects(
    Promise.resolve().then(() => service.saveBatch(staleStyle)),
    (error) => error.status === 409,
  );
  const duplicateChange = {
    ...first.changes[0],
    expectedVersion: current.cells.title.version,
  };
  const duplicate = request([duplicateChange, duplicateChange]);
  await assert.rejects(
    Promise.resolve().then(() => service.saveBatch(duplicate)),
    (error) => error.status === 400,
  );
  assert.deepEqual(await counts(), saved);
  assert.equal(await events(), 1);
  return result;
}

test("M6 ordinary task/cell service uses SQLite repository with atomic capture and one after-COMMIT event", async (t) => {
  const f = sqliteFixture(t),
    service = new TaskBusinessService(f.app.locals.taskRepository, f.user);
  let events = 0;
  f.app.locals.cellEvents.publish = (result) => {
    // A distinct connection must already observe the committed cell and P.
    const reader = openDatabase(join(f.dir, "data.sqlite"));
    try {
      assert.equal(
        getTask(reader, f.taskId).cells.title.value,
        result.cells[0].value,
      );
      assert.equal(
        reader.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
        1,
      );
    } finally {
      reader.close();
    }
    events++;
  };
  const counts = () => ({
    operations: f.db.prepare("SELECT COUNT(*) n FROM operations").get().n,
    pending: f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
    audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    cells: f.db
      .prepare(
        "SELECT key,value,version FROM cells WHERE task_id=? ORDER BY key",
      )
      .all(f.taskId),
  });
  await commonContract({
    service,
    teamId: f.teamId,
    taskId: f.taskId,
    counts,
    events: () => events,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected storage failure");
      };
    },
  });
  assert.equal(
    service.query({ teamId: f.teamId, year: "2026" }) instanceof Promise,
    false,
  );
});

test("M6 same ordinary service uses real PostgreSQL repository and external HTTP task/cell routes accept that backend", async (t) => {
  const bin = process.env.TEST_PG_BIN;
  if (!bin || !existsSync(join(bin, "postgres"))) {
    t.skip("Set TEST_PG_BIN for actual PostgreSQL ordinary-business contract");
    return;
  }
  const f = sqliteFixture(t),
    dir = mkdtempSync("/tmp/gb-task-pg-"),
    data = join(dir, "pg"),
    pools = [];
  let started = false;
  const cmd = (name, args) => {
    const r = spawnSync(join(bin, name), args, {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
  };
  t.after(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (started) cmd("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });
  cmd("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  cmd("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-F -h '' -k ${dir} -p 5432`,
    "-w",
    "start",
  ]);
  started = true;
  const url = (database) =>
      `postgresql://${encodeURIComponent(process.env.USER)}@localhost/${database}?host=${encodeURIComponent(dir)}&port=5432`,
    root = new Pool({ connectionString: url("postgres") });
  pools.push(root);
  await root.query("CREATE DATABASE control");
  await root.query("CREATE DATABASE team");
  const control = new Pool({ connectionString: url("control") }),
    pool = new Pool({ connectionString: url("team") });
  pools.push(control, pool);
  await migratePostgres(control, { scope: "control", initialize: true });
  await migratePostgres(pool, {
    scope: "team",
    teamId: f.teamId,
    initialize: true,
  });
  await control.query(
    "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,'contract@example.test','contract@example.test','Contract','admin',$2)",
    [f.user.id, new Date().toISOString()],
  );
  await control.query(
    "INSERT INTO graeboard.teams(id,name,profile_id,status) VALUES($1,'Contract','contract','active')",
    [f.teamId],
  );
  await control.query(
    "INSERT INTO graeboard.memberships VALUES($1,$2,'lead')",
    [f.user.id, f.teamId],
  );
  const adapter = new PostgresDatabase(pool, { teamId: f.teamId });
  await adapter.withTeamTransaction(f.teamId, async (tx) => {
    const { team_id, ...fields } = f.link;
    await tx.sync.writeLink(fields);
    await tx.sync.writeState(f.state, f.link.canonical_head);
    for (const record of Object.values(f.state.entities)) {
      await tx.query("INSERT INTO site_entities VALUES($1,$2,$3,$4,1,0)", [
        f.teamId,
        record.entity,
        canonical(record.key),
        canonical(record.payload),
      ]);
      await tx.query("INSERT INTO site_entity_revisions VALUES($1,$2,$3,1)", [
        f.teamId,
        record.entity,
        canonical(record.key),
      ]);
    }
  });
  const env = {
      PG_CONTROL: { connectionString: url("control") },
      PG_TEAM: { connectionString: url("team") },
      BUCKET: {},
      TOKEN: "synthetic-contract-token",
      SYNC_PROFILES: JSON.stringify([
        {
          profileId: "contract",
          teamId: f.teamId,
          repository: "example/private",
          databaseBinding: "PG_TEAM",
          bucketBinding: "BUCKET",
          githubSecret: "TOKEN",
        },
      ]),
    },
    makeRepository = (user) =>
      new PostgresTaskRepository({
        context: new RequestContext(
          env,
          user,
          {},
          new Request("https://example.test/api/tasks"),
          { waitUntil() {} },
        ),
      }),
    repository = makeRepository(f.user),
    service = new TaskBusinessService(repository, f.user);
  let fail = false;
  const originalData = repository.context.data.bind(repository.context);
  repository.context.data = (teamId, work, options) =>
    originalData(
      teamId,
      async (s) => {
        const output = await work(s);
        if (fail && options?.write) {
          fail = false;
          const capture = s.capture.bind(s);
          s.capture = async (actor) => {
            await capture(actor);
            throw new Error("injected storage failure");
          };
        }
        return output;
      },
      options,
    );
  const counts = async () => ({
    operations: Number(
      (await pool.query("SELECT COUNT(*) n FROM graeboard.site_operations"))
        .rows[0].n,
    ),
    pending: Number(
      (await pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox")).rows[0]
        .n,
    ),
    audit: Number(
      (await pool.query("SELECT COUNT(*) n FROM graeboard.site_audit")).rows[0]
        .n,
    ),
    cells: (
      await pool.query(
        "SELECT entity_key,payload,revision FROM graeboard.site_entities WHERE entity='cell' ORDER BY entity_key",
      )
    ).rows,
  });
  await commonContract({
    service,
    teamId: f.teamId,
    taskId: f.taskId,
    counts,
    failOnce: () => {
      fail = true;
    },
    events: async () =>
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) n FROM graeboard.site_events WHERE kind='cells'",
          )
        ).rows[0].n,
      ),
  });
  const app = createExternalRouteApp({
      env: env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => makeRepository(user).context,
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = {
      Cookie: "weekly_session=" + f.user.id,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    response = await fetch(`${origin}/api/tasks?teamId=${f.teamId}&year=2026`, {
      headers,
    }),
    body = unpack(await response.json());
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.tasks[0].cells.title.value, "saved");
  const save = await fetch(origin + "/api/cells/batch", {
    method: "POST",
    headers,
    body: JSON.stringify(
      request([
        {
          taskId: f.taskId,
          key: "title",
          expectedVersion: body.tasks[0].cells.title.version,
          value: "external HTTP writes PostgreSQL",
        },
      ]),
    ),
  });
  assert.equal(save.status, 200, await save.text());
  assert.equal(
    (
      await adapter.withTeamTransaction(
        f.teamId,
        async (tx) =>
          (
            await tx.query(
              "SELECT payload FROM site_entities WHERE entity='cell' AND entity_key=$1",
              [canonical([f.taskId, "title"])],
            )
          ).rows[0],
      )
    ).payload.includes("external HTTP writes PostgreSQL"),
    true,
  );
  assert.equal(getTask(f.db, f.taskId).cells.title.value, "initial");
});
