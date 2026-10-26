import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AdminHistoryBusinessService } from "../server/storage/admin-history-service.mjs";
import { SqliteAdminHistoryRepository } from "../server/storage/sqlite-admin-history.mjs";
import { PostgresAdminHistoryRepository } from "../server/storage/postgres-admin-history.mjs";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import { createApp } from "../server/app.mjs";
import { unpack } from "../shared/compact.js";
import { RequestContext } from "../worker/control.mjs";
import { SqliteControlStore } from "../server/storage/control-store.mjs";
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const beforeDate = ago(30).slice(0, 10);
async function contract({
  service,
  f,
  seed,
  protectedState,
  remaining,
  failOnce,
}) {
  const old = ago(60),
    recent = ago(1),
    ids = [];
  for (let index = 0; index < 55; index++) {
    const id = randomUUID();
    ids.push(id);
    await seed({
      id,
      teamId: null,
      action: "user-update",
      payload: { before: { name: "old" }, after: { name: "new" } },
      createdAt: old,
    });
  }
  await seed({
    id: randomUUID(),
    teamId: null,
    action: "login",
    payload: { success: true },
    createdAt: recent,
  });
  const first = await service.audit({
    action: "user-update",
    actorId: f.user.id,
  });
  assert.equal(first.entries.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(first.entries[0].actor, "Contract");
  const second = await service.audit({
    action: "user-update",
    actorId: f.user.id,
    cursorAt: first.nextCursor.createdAt,
    cursorId: first.nextCursor.id,
  });
  assert.equal(second.entries.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.entries, ...second.entries].map((row) => row.id)).size,
    55,
  );
  assert.deepEqual(await service.auditEntry(ids[0]), {
    before: { name: "old" },
    after: { name: "new" },
  });
  const denied = new AdminHistoryBusinessService(service.repository, {
    ...f.user,
    systemRole: "user",
  });
  await assert.rejects(
    Promise.resolve().then(() => denied.storage()),
    (error) => error.status === 403,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      service.cleanup({ token: randomUUID(), confirmed: true }),
    ),
    (error) => error.status === 410,
  );
  const oldTeamId = randomUUID(),
    recentTeamId = randomUUID();
  await seed({
    id: oldTeamId,
    teamId: f.teamId,
    action: "task",
    payload: { note: "old local audit" },
    createdAt: old,
  });
  await seed({
    id: recentTeamId,
    teamId: f.teamId,
    action: "task",
    payload: { note: "recent local audit" },
    createdAt: recent,
  });
  const before = await protectedState(),
    preview = await service.preview({ scopeId: f.teamId, beforeDate });
  assert.equal(preview.audit.eligible.count, 1);
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.cleanup({ token: preview.token, confirmed: true }),
    ),
    /injected cleanup failure/,
  );
  assert.equal(await remaining(oldTeamId), true);
  assert.deepEqual(await protectedState(), before);
  const result = await service.cleanup({
    token: preview.token,
    confirmed: true,
  });
  assert.equal(result.completed, true);
  assert.equal(result.deleted.audit.count, 1);
  assert.deepEqual(
    await protectedState(),
    before,
    "C/P/L/head and current business state must remain byte-identical",
  );
  assert.equal(await remaining(oldTeamId), false);
  assert.equal(await remaining(recentTeamId), true);
  assert.ok(
    (await service.storage()).scopes.some((scope) => scope.id === f.teamId),
  );
  return ids[0];
}
test("M6 administrator audit/cleanup common service uses SQLite bounded local history cleanup", async (t) => {
  const f = sqliteFixture(t),
    repository = new SqliteAdminHistoryRepository({ db: f.db }),
    service = new AdminHistoryBusinessService(repository, f.user);
  await contract({
    service,
    f,
    seed: (row) =>
      f.db
        .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)")
        .run(
          row.id,
          row.teamId,
          f.user.id,
          row.action,
          f.user.id,
          canonical(row.payload.before ?? null),
          canonical(row.payload.after ?? row.payload),
          row.createdAt,
        ),
    protectedState: () => ({
      snapshot: f.adapter.readSnapshot(f.teamId),
      tasks: f.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
      cells: f.db.prepare("SELECT * FROM cells ORDER BY task_id,key").all(),
    }),
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected cleanup failure");
      };
    },
    remaining: (id) => !!f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(id),
  });
});
test("M6 same administrator audit/cleanup service uses actual PostgreSQL and Node PG-only audit HTTP", async (t) => {
  const pg = await postgresFixture(t),
    f = pg;
  if (!pg) return;
  const make = (user) =>
      new PostgresAdminHistoryRepository({ context: pg.makeContext(user) }),
    service = new AdminHistoryBusinessService(make(f.user), f.user);
  const id = await contract({
    service,
    f,
    seed: (row) =>
      row.teamId
        ? pg.pool.query(
            "INSERT INTO graeboard.site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$3,$5,$6)",
            [
              row.id,
              row.teamId,
              f.user.id,
              row.action,
              canonical(row.payload),
              row.createdAt,
            ],
          )
        : pg.control.query(
            "INSERT INTO graeboard.control_audit VALUES($1,$2,$3,$2,$4,$5)",
            [
              row.id,
              f.user.id,
              row.action,
              canonical(row.payload),
              row.createdAt,
            ],
          ),
    protectedState: async () => ({
      snapshot: await pg.adapter.readSnapshot(f.teamId),
      entities: (
        await pg.pool.query(
          "SELECT * FROM graeboard.site_entities ORDER BY entity,entity_key",
        )
      ).rows,
    }),
    failOnce() {
      const original = service.repository.scopeTransaction.bind(
        service.repository,
      );
      service.repository.scopeTransaction = (user, scope, work, options) => {
        if (options?.write) {
          service.repository.scopeTransaction = original;
          return original(
            user,
            scope,
            async (tx) => {
              await work(tx);
              throw new Error("injected cleanup failure");
            },
            options,
          );
        }
        return original(user, scope, work, options);
      };
    },
    remaining: async (id) =>
      (
        await pg.pool.query("SELECT 1 FROM graeboard.site_audit WHERE id=$1", [
          id,
        ])
      ).rows.length > 0,
  });
  const app = createApp({
      db: f.db,
      rateLimits: false,
      syncOptions: { schedule: false, installationId: f.link.installation_id },
      adminHistoryRepository: make,
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await app.locals.sync.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  assert.equal(
    f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(id),
    undefined,
  );
  const response = await fetch(
    "http://127.0.0.1:" + server.address().port + "/api/admin/audit/" + id,
    { headers: { Cookie: "weekly_session=" + f.user.id } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(unpack(await response.json()), {
    before: { name: "old" },
    after: { name: "new" },
  });
});

test("Node hybrid administrator history keeps SQLite control authoritative without a PG control binding or identity mirrors", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  await f.control.query("DELETE FROM graeboard.memberships");
  await f.control.query("DELETE FROM graeboard.users");
  await f.control.query("DELETE FROM graeboard.teams");
  const {
      PG_CONTROL: unused,
      BUCKET: unusedBucket,
      TOKEN: unusedToken,
      ...env
    } = f.env,
    controlStore = new SqliteControlStore({ db: f.db, env }),
    systemRepository = new SqliteAdminHistoryRepository({ db: f.db }),
    previewStore = new Map(),
    make = (user) =>
      new PostgresAdminHistoryRepository({
        context: new RequestContext(
          env,
          user,
          {},
          new Request("http://node.test/api/admin"),
          { waitUntil() {} },
          { controlStore },
        ),
        systemRepository,
        previewStore,
      }),
    service = new AdminHistoryBusinessService(make(f.user), f.user);
  env.SYNC_PROFILES = JSON.stringify([
    { profileId: "contract", teamId: f.teamId, databaseBinding: "PG_TEAM" },
  ]);
  const id = await contract({
    service,
    f,
    seed: (row) =>
      row.teamId
        ? f.pool.query(
            "INSERT INTO graeboard.site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$3,$5,$6)",
            [
              row.id,
              row.teamId,
              f.user.id,
              row.action,
              canonical(row.payload),
              row.createdAt,
            ],
          )
        : f.db
            .prepare("INSERT INTO audit VALUES(?,NULL,?,?,?,?,?,?)")
            .run(
              row.id,
              f.user.id,
              row.action,
              f.user.id,
              canonical(row.payload.before ?? null),
              canonical(row.payload.after ?? row.payload),
              row.createdAt,
            ),
    protectedState: async () => ({
      snapshot: await f.adapter.readSnapshot(f.teamId),
      entities: (
        await f.pool.query(
          "SELECT * FROM graeboard.site_entities ORDER BY entity,entity_key",
        )
      ).rows,
    }),
    remaining: async (id) =>
      (
        await f.pool.query("SELECT 1 FROM graeboard.site_audit WHERE id=$1", [
          id,
        ])
      ).rows.length > 0,
    failOnce() {
      const original = service.repository.scopeTransaction.bind(
        service.repository,
      );
      service.repository.scopeTransaction = (user, scope, work, options) => {
        if (!options?.write) return original(user, scope, work, options);
        service.repository.scopeTransaction = original;
        return original(
          user,
          scope,
          async (tx) => {
            await work(tx);
            throw new Error("injected cleanup failure");
          },
          options,
        );
      };
    },
  });
  const cleanupAudit = f.db
    .prepare("SELECT * FROM audit WHERE action='history-cleanup' AND target=?")
    .get(f.teamId);
  assert.equal(
    cleanupAudit.team_id,
    null,
    "PG team cleanup records its administrator audit in SQLite control",
  );
  assert.equal(JSON.parse(cleanupAudit.after_json).deleted.audit.count, 1);
  assert.equal(
    (await service.storage()).scopes.find((scope) => scope.id === f.teamId)
      .latest.actor,
    "Contract",
  );
  const app = createApp({
      db: f.db,
      rateLimits: false,
      syncOptions: { schedule: false, installationId: f.link.installation_id },
      adminHistoryRepository: make,
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await app.locals.sync.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = {
      Cookie: "weekly_session=" + f.user.id,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    };
  const detail = await fetch(origin + "/api/admin/audit/" + id, { headers });
  assert.equal(detail.status, 200);
  assert.deepEqual(unpack(await detail.json()), {
    before: { name: "old" },
    after: { name: "new" },
  });
  const preview = await fetch(
    origin +
      "/api/admin/history-cleanup?scopeId=system&beforeDate=" +
      beforeDate,
    { headers },
  );
  assert.equal(preview.status, 200);
  const result = await preview.json();
  assert.equal(result.audit.eligible.count, 55);
  const cleaned = await fetch(origin + "/api/admin/history-cleanup", {
    method: "POST",
    headers,
    body: JSON.stringify({ token: result.token, confirmed: true }),
  });
  assert.equal(cleaned.status, 200, await cleaned.clone().text());
  assert.equal((await cleaned.json()).deleted.audit.count, 55);
  assert.equal(
    f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(id),
    undefined,
  );
  assert.equal(
    (await f.control.query("SELECT COUNT(*) n FROM graeboard.control_jobs"))
      .rows[0].n,
    "0",
  );
  assert.equal("PG_CONTROL" in env, false);
});
