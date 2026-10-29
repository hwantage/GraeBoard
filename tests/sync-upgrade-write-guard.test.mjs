import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { canonical } from "../server/sync/protocol.mjs";

const command = (taskId, expectedVersion, value) => ({
  operationId: randomUUID(),
  createdAt: new Date().toISOString(),
  changes: [{ taskId, key: "title", value, expectedVersion }],
});

test("Node API protects business rows and input during a live upgrade lease, while ordinary and expired leases allow saves", async (t) => {
  const f = await performanceFixture({ rows: 1, clients: 1, users: 1 });
  t.after(() => f.close());
  f.setLink("paused");
  const store = f.app.locals.sync.store(f.teamId);
  const lease = (mode, owner, until = Date.now() + 60000) => {
    f.db
      .prepare(
        "UPDATE team_sync_links SET mode=?,lease_owner=?,lease_until=? WHERE team_id=?",
      )
      .run(mode, owner, until, f.teamId);
  };
  const snapshot = () => ({
    cells: f.db
      .prepare("SELECT * FROM cells WHERE task_id=? ORDER BY key")
      .all(f.taskIds[0]),
    pending: canonical(store.readPending()),
    state: canonical(store.readState()),
    head: store.readLink().canonical_head,
    hash: store.readLink().canonical_hash,
    audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    operations: f.db.prepare("SELECT COUNT(*) n FROM operations").get().n,
  });
  const save = (body) =>
    fetch(f.origin + "/api/cells/batch", {
      method: "POST",
      headers: {
        cookie: "weekly_session=" + f.tokens[0],
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      body: JSON.stringify(body),
    });
  lease("paused", "upgrade:" + randomUUID());
  const before = snapshot();
  const body = command(
    f.taskIds[0],
    before.cells.find((cell) => cell.key === "title").version,
    "keep this input while upgrading",
  );
  const response = await save(body),
    result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.match(result.error, /형식 전환/);
  assert.deepEqual(snapshot(), before);
  assert.equal(body.changes[0].value, "keep this input while upgrading");
  const read = await fetch(
    f.origin + `/api/tasks?teamId=${f.teamId}&year=2026`,
    { headers: { cookie: "weekly_session=" + f.tokens[0] } },
  );
  assert.equal(read.status, 200, "upgrade lease preserves reads");
  for (const [mode, owner, until] of [
    ["paused", "ordinary-sync", Date.now() + 60000],
    ["active", "ordinary-sync", Date.now() + 60000],
    ["paused", "upgrade:expired", Date.now() - 1],
  ]) {
    lease(mode, owner, until);
    const current = snapshot(),
      value = `saved with ${mode}/${owner}`;
    const saved = await save(
      command(
        f.taskIds[0],
        current.cells.find((cell) => cell.key === "title").version,
        value,
      ),
    );
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(
      JSON.parse(
        f.db
          .prepare("SELECT value FROM cells WHERE task_id=? AND key='title'")
          .get(f.taskIds[0]).value,
      ),
      value,
    );
    assert.equal(
      store.readPending().length,
      JSON.parse(current.pending).length + 1,
    );
  }
});

test("actual PostgreSQL business service rejects writes under an upgrade lease atomically and permits ordinary or expired leases", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const service = new TaskBusinessService(
    new PostgresTaskRepository({ context: f.makeContext() }),
    f.user,
  );
  const lease = (mode, owner, until = Date.now() + 60000) =>
    f.pool.query(
      "UPDATE graeboard.team_sync_links SET mode=$2,lease_owner=$3,lease_until=$4 WHERE team_id=$1",
      [f.teamId, mode, owner, until],
    );
  const snapshot = async () => ({
    rows: (
      await f.pool.query(
        "SELECT * FROM graeboard.site_entities WHERE team_id=$1 ORDER BY entity,entity_key",
        [f.teamId],
      )
    ).rows,
    revisions: (
      await f.pool.query(
        "SELECT * FROM graeboard.site_entity_revisions WHERE team_id=$1 ORDER BY entity,entity_key",
        [f.teamId],
      )
    ).rows,
    counts: (
      await f.pool.query(
        "SELECT (SELECT COUNT(*) FROM graeboard.sync_outbox) pending,(SELECT COUNT(*) FROM graeboard.site_audit) audit,(SELECT COUNT(*) FROM graeboard.site_operations) operations,(SELECT COUNT(*) FROM graeboard.site_events) events",
      )
    ).rows,
    state: canonical(await f.adapter.readState(f.teamId)),
    pending: canonical(await f.adapter.readPending(f.teamId)),
  });
  await lease("paused", "upgrade:" + randomUUID());
  const before = await snapshot(),
    task = (await service.getMany([f.taskId]))[0];
  const body = command(
    f.taskId,
    task.cells.title.version,
    "keep external input while upgrading",
  );
  await assert.rejects(
    () => service.saveBatch(body),
    (error) => error.status === 409 && /형식 전환/.test(error.message),
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(body.changes[0].value, "keep external input while upgrading");
  assert.equal(
    (await service.getMany([f.taskId]))[0].cells.title.value,
    task.cells.title.value,
  );
  for (const [mode, owner, until] of [
    ["paused", "ordinary-sync", Date.now() + 60000],
    ["active", "ordinary-sync", Date.now() + 60000],
    ["paused", "upgrade:expired", Date.now() - 1],
  ]) {
    await lease(mode, owner, until);
    const current = (await service.getMany([f.taskId]))[0],
      pending = await f.adapter.readPending(f.teamId),
      value = `saved with ${mode}/${owner}`;
    await service.saveBatch(
      command(f.taskId, current.cells.title.version, value),
    );
    assert.equal(
      (await service.getMany([f.taskId]))[0].cells.title.value,
      value,
    );
    assert.equal(
      (await f.adapter.readPending(f.teamId)).length,
      pending.length + 1,
    );
  }
});
