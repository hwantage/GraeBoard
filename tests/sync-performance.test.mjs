import test from "node:test";
import assert from "node:assert/strict";
import {
  performanceFixture,
  runTwoTeamPerformance,
  runReviewPerformance,
} from "../scripts/sync-performance.mjs";
import {
  createNodeBackground,
  assertSnapshotGuard,
} from "../server/sync/node-background.mjs";
import { entityId } from "../server/sync/protocol.mjs";
import { randomUUID } from "node:crypto";

test("two-team performance fixture verifies simultaneous Git heads and bulk-paste SSE without hiding a failed job", async () => {
  const result = await runTwoTeamPerformance({
    rows: 40,
    secondaryRows: 20,
    clients: 3,
    users: 3,
    rounds: 2,
    bulkValueBytes: 8000,
    includeScheduled: false,
  });
  assert.equal(result.simultaneous.bothTeamHeadsVerified, true);
  assert.equal(result.bulkPaste.cells, 40);
  assert.equal(result.bulkPaste.deliveredClients, 3);
  assert.equal(result.bulkPaste.resetRefetchClients, 3);
  assert.ok(result.simultaneous.samples >= 6);
  assert.equal(result.scheduled, null);
});

test("background WAL snapshot, concurrent capture, ACK and real SSE preserve internal saves", async (t) => {
  const f = await performanceFixture({ rows: 60, clients: 3, users: 3 });
  t.after(() => f.close());
  f.setLink("initializing");
  const background = createNodeBackground({ db: f.db });
  t.after(() => background.close());
  const snapshot = await background.compute({
    kind: "bootstrap",
    teamId: f.teamId,
  });
  assert.ok(Object.keys(snapshot.bundle.state.entities).length > 1000);
  const saved = await f.measure(2);
  assert.equal(saved.samples, 6);
  assert.ok(saved.commitToAllSseP95Ms < 1000);
  assert.throws(
    () => assertSnapshotGuard(f.db, f.teamId, snapshot.guard),
    /snapshot changed/,
  );
  // Freeze B0 before newer P arrives, then verify the real worker coordinator
  // projects those later local edits rather than overwriting them on genesis.
  f.db
    .prepare("UPDATE team_sync_links SET bootstrap_bundle=? WHERE team_id=?")
    .run(snapshot.bundleJson, f.teamId);
  const before = f.db
    .prepare("SELECT value FROM cells WHERE task_id=? AND key='title'")
    .get(f.taskIds[0]).value;
  await f.app.locals.sync.get(f.teamId).run({ initialize: true });
  assert.equal(
    f.db
      .prepare("SELECT value FROM cells WHERE task_id=? AND key='title'")
      .get(f.taskIds[0]).value,
    before,
  );
  assert.equal(f.app.locals.sync.store(f.teamId).readPending().length, 0);
  assert.equal(f.app.locals.sync.store(f.teamId).readLink().mode, "active");
  await f.measure(2);
  assert.equal(f.app.locals.sync.store(f.teamId).readPending().length, 6);
});

test("maintenance fences synchronization but online backup does not block capture", async (t) => {
  const f = await performanceFixture({ rows: 3, clients: 3, users: 3 });
  t.after(() => f.close());
  f.setLink("active");
  const insert = f.db.prepare(
    "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  insert.run(
    "maintenance",
    f.teamId,
    "cleanup",
    "planned",
    "{}",
    "{}",
    new Date().toISOString(),
  );
  assert.equal(f.app.locals.sync.store(f.teamId).acquire("owner"), false);
  f.db
    .prepare(
      "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id='maintenance'",
    )
    .run();
  insert.run(
    "backup",
    f.teamId,
    "backup",
    "snapshot",
    "{}",
    "{}",
    new Date().toISOString(),
  );
  assert.equal(f.app.locals.sync.store(f.teamId).acquire("owner"), true);
  f.app.locals.sync.store(f.teamId).release("owner");
  await f.measure(1);
  assert.equal(f.app.locals.sync.store(f.teamId).readPending().length, 3);
});

test("prepared canonical delta accepts unrelated P and rejects same-field or parent interference", async (t) => {
  const f = await performanceFixture({ rows: 3, clients: 3, users: 3 });
  t.after(() => f.close());
  f.setLink("initializing");
  await f.app.locals.sync.get(f.teamId).run({ initialize: true });
  const background = createNodeBackground({ db: f.db });
  t.after(() => background.close());
  const state = f.app.locals.sync.store(f.teamId).readState(),
    key = entityId("cell", [f.taskIds[0], "title"]);
  state.entities[key] = {
    ...state.entities[key],
    version: randomUUID(),
    payload: { ...state.entities[key].payload, value: "remote" },
  };
  const prepared = await background.compute({
    kind: "project",
    teamId: f.teamId,
    state,
  });
  assert.deepEqual(Object.keys(prepared.changedEntities), [key]);
  const save = async (index) => {
    const taskId = f.taskIds[index],
      version = f.db
        .prepare("SELECT version FROM cells WHERE task_id=? AND key='title'")
        .get(taskId).version;
    await f.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId,
          key: "title",
          value: "local " + index,
          expectedVersion: version,
        },
      ],
    });
  };
  await save(1);
  assert.doesNotThrow(() =>
    assertSnapshotGuard(f.db, f.teamId, prepared.guard, {
      touched: prepared.touched,
    }),
  );
  await save(0);
  assert.throws(
    () =>
      assertSnapshotGuard(f.db, f.teamId, prepared.guard, {
        touched: prepared.touched,
      }),
    /snapshot changed/,
  );
  // An own B0/ACK has no visible delta. Arbitrary later P must remain live and
  // must not force a full canonical rebuild under sustained internal editing.
  const current = await background.compute({
    kind: "project",
    teamId: f.teamId,
  });
  assert.equal(Object.keys(current.changedEntities).length, 0);
  await save(2);
  assert.doesNotThrow(() =>
    assertSnapshotGuard(f.db, f.teamId, current.guard, {
      touched: current.touched,
    }),
  );
});

test("review performance scenarios exercise both v2 upgrade endpoints, report workload and remote metadata without refetch", async () => {
  const result = await runReviewPerformance({
    rows: 40,
    documents: 4,
    users: 3,
    clients: 3,
    rounds: 1,
    acknowledgedRows: 100,
  });
  assert.equal(result.linkedIdle.pairedRuns.length, 3);
  assert.equal(result.bulk2000.cells, 80);
  assert.equal(result.unlinkedTeamInLinkedDatabase.capturedOperations, 0);
  assert.equal(result.users1000.users, 3);
  assert.equal(result.reportCreate.protocol, 2);
  assert.equal(result.reportEdit.tasks, 40);
  assert.equal(result.reportEdit.documents, 4);
  assert.equal(result.retentionQuery.active.samples, 1);
  assert.equal(result.acknowledgedOutboxStatus.addedRows, 100);
  assert.equal(result.remoteTask30Clients.deliveredClients, 3);
  assert.equal(result.remoteTask30Clients.snapshotRefetches, 0);
});
