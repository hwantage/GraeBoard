import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { createNodeBackground } from "../server/sync/node-background.mjs";
import { entityId } from "../server/sync/protocol.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { reduceMany } from "../server/sync/reducer.mjs";
import { materialize, readEntity } from "../server/sync/entities.mjs";
import { transaction } from "../server/db.mjs";
import { prepareStatePatch } from "../shared/sync-team-store.mjs";
import { isRecoveryError } from "../server/sync/errors.mjs";
import {
  pendingEntityKeys,
  canRetireProjection,
} from "../server/sync/projection.mjs";

test("status reads the latest local sequence including acknowledged input", async (t) => {
  const f = await performanceFixture({ rows: 1, clients: 1, users: 1 });
  t.after(() => f.close());
  f.setLink("active");
  const insert = f.db.prepare(
    "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES(?,?,?,'acknowledged',?)",
  );
  transaction(f.db, () => {
    for (let i = 0; i < 1000; i++)
      insert.run(randomUUID(), f.teamId, "{}", "2026-10-29T12:00:00.000Z");
    // Sequence, not wall-clock MAX, identifies the latest committed local input.
    insert.run(randomUUID(), f.teamId, "{}", "2026-10-29T11:59:59.000Z");
  });
  const result = await f.api(`/teams/${f.teamId}/sync`);
  assert.equal(result.lastLocalSavedAt, "2026-10-29T11:59:59.000Z");
  assert.equal(result.pending, 0);
});

test("a rejected local tag creation is retired only after its verified receipt acknowledges pending input", async (t) => {
  const f = await performanceFixture({ rows: 1, clients: 1, users: 1 });
  t.after(() => f.close());
  f.setLink("initializing");
  await f.app.locals.sync.get(f.teamId).run({ initialize: true });
  const store = f.app.locals.sync.store(f.teamId);
  const before = store.readState();
  const tag = await f.api(`/calendar/teams/${f.teamId}/tags`, {
    id: randomUUID(),
    name: "Same name",
    color: "green",
    kind: "label",
  });
  const [local] = store.readPending();
  assert.ok(local);
  const change = local.changes.find((change) => change.entity === "tag");
  const remoteKey = [randomUUID()];
  const remote = makeOperation({
    link: store.readLink(),
    actorRef: local.actorRef,
    before: {},
    after: {
      [entityId("tag", remoteKey)]: {
        entity: "tag",
        key: remoteKey,
        payload: change.desired,
        deleted: false,
      },
    },
  });
  const canonical = reduceMany(before, [remote, local]);
  assert.equal(canonical.receipts[local.opId].result, "conflict");
  const ghostKey = entityId("tag", change.key);
  assert.equal(canonical.entities[ghostKey], undefined);
  const background = createNodeBackground({ db: f.db });
  t.after(() => background.close());
  const protectedPatch = await background.compute({
    kind: "project",
    teamId: f.teamId,
    state: canonical,
  });
  assert.equal(protectedPatch.changedEntities[ghostKey], undefined);
  assert.ok(
    f.db.prepare("SELECT id FROM calendar_tags WHERE id=?").get(tag.id),
  );
  // Receive the peer's winning creation before our own immutable P has been
  // published. The protected local row must not block the canonical receive.
  const peerOnly = reduceMany(before, [remote]);
  const waitingPatch = await background.compute({
    kind: "project",
    teamId: f.teamId,
    state: peerOnly,
  });
  f.app.locals.sync.capture.without(() =>
    transaction(f.db, () =>
      materialize(
        f.db,
        f.teamId,
        waitingPatch.changedEntities,
        waitingPatch.previous,
        { retiredKeys: waitingPatch.retiredKeys },
      ),
    ),
  );
  assert.ok(
    f.db.prepare("SELECT id FROM calendar_tags WHERE id=?").get(tag.id),
  );
  assert.deepEqual(store.readPending(), [local]);
  const acknowledgedPatch = await background.compute({
    kind: "project",
    teamId: f.teamId,
    state: canonical,
    previousState: peerOnly,
    ackOpIds: [local.opId],
  });
  assert.equal(acknowledgedPatch.changedEntities[ghostKey].deleted, true);
  f.app.locals.sync.capture.without(() =>
    transaction(f.db, () =>
      materialize(
        f.db,
        f.teamId,
        acknowledgedPatch.changedEntities,
        acknowledgedPatch.previous,
        { retiredKeys: acknowledgedPatch.retiredKeys },
      ),
    ),
  );
  assert.equal(
    f.db.prepare("SELECT id FROM calendar_tags WHERE id=?").get(tag.id),
    undefined,
  );
  assert.ok(
    f.db.prepare("SELECT id FROM calendar_tags WHERE id=?").get(remoteKey[0]),
  );
  assert.deepEqual(
    store.readPending(),
    [local],
    "projection retirement must not erase pending or conflict evidence",
  );
});

test("both hosts protect pending references and held rows during projection retirement", () => {
  const pending = [
    {
      changes: [
        {
          entity: "calendar",
          key: ["event"],
          base: null,
          desired: { userId: "person", tags: [{ id: "tag" }] },
        },
      ],
    },
  ];
  const keys = pendingEntityKeys(pending);
  for (const [entity, id] of [
    ["calendar", "event"],
    ["person", "person"],
    ["tag", "tag"],
  ])
    assert.equal(canRetireProjection(entityId(entity, [id]), {}, keys), false);
  assert.equal(
    canRetireProjection(entityId("tag", ["rejected"]), {}, keys),
    true,
  );
});

test("local immutable-state violations require recovery instead of retrying forever", () => {
  const empty = { entities: {}, receipts: {}, conflicts: {} };
  const previous = {
    ...empty,
    receipts: { saved: { payloadHash: "original" } },
  };
  for (const next of [
    empty,
    { ...empty, receipts: { saved: { payloadHash: "changed" } } },
  ]) {
    assert.throws(
      () => prepareStatePatch(previous, next),
      (error) => {
        assert.equal(error.code, "SYNC_INTEGRITY");
        assert.equal(isRecoveryError(error), true);
        return true;
      },
    );
  }
  assert.equal(isRecoveryError({ code: "EXTERNAL_SYNC_CAPACITY" }), true);
  assert.equal(isRecoveryError(new Error("temporary database outage")), false);
});

test("a timed-out team request preserves other workers and queued requests", async (t) => {
  const workerUrl = new URL(
    `data:text/javascript,${encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", ({ id, request, cancelId }) => {
      if (cancelId) return;
      setTimeout(() => parentPort.postMessage({ id, result: request.teamId }), request.delay);
    });
  `)}`,
  );
  const background = createNodeBackground({
    databasePath: "/unused",
    workerUrl,
    timeoutMs: 500,
  });
  t.after(() => background.close());
  const slow = assert.rejects(
    background.compute({ teamId: "slow", delay: 5000 }),
    { code: "SYNC_TIMEOUT" },
  );
  const queued = background.compute({ teamId: "slow", delay: 5 });
  assert.equal(
    await background.compute({ teamId: "other", delay: 5 }),
    "other",
  );
  await slow;
  assert.equal(await queued, "slow");
  assert.equal(background.closed, false);
});

test("completed background phases reset the inactivity timeout", async (t) => {
  const workerUrl = new URL(
    `data:text/javascript,${encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", async ({ id, request, cancelId }) => {
      if (cancelId) return;
      for (let phase = 0; phase < 5; phase++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        parentPort.postMessage({ progress: id });
      }
      parentPort.postMessage({ id, result: request.teamId });
    });
  `)}`,
  );
  const background = createNodeBackground({
    databasePath: "/unused",
    workerUrl,
    timeoutMs: 500,
  });
  t.after(() => background.close());
  assert.equal(await background.compute({ teamId: "phases" }), "phases");
});

test("remote task metadata publishes a delta and empty commits emit no invalidation", async (t) => {
  const f = await performanceFixture({ rows: 1, clients: 1, users: 1 });
  t.after(() => f.close());
  const taskId = f.taskIds[0],
    key = entityId("task", [taskId]);
  const previous = readEntity(f.db, f.teamId, "task", [taskId]);
  const calls = { reset: 0, invalidate: 0, publish: [] };
  f.app.locals.cellEvents.invalidateTeam = () => calls.reset++;
  f.app.locals.cellEvents.publish = (result) => calls.publish.push(result);
  f.app.locals.documentEvents.invalidate = () => calls.invalidate++;
  f.app.locals.sync.notify(f.teamId, []);
  assert.deepEqual(calls, { reset: 0, invalidate: 0, publish: [] });
  f.db
    .prepare("UPDATE tasks SET position=10,updated_at=? WHERE id=?")
    .run("2099-01-01T00:00:00.000Z", taskId);
  const current = readEntity(f.db, f.teamId, "task", [taskId]);
  f.app.locals.sync.notify(f.teamId, [key], {
    previous: { [key]: previous },
    entities: { [key]: current },
  });
  assert.equal(calls.reset, 0);
  assert.equal(calls.invalidate, 0);
  assert.equal(calls.publish[0].taskMetadata[taskId].position, 10);
  f.app.locals.sync.notify(f.teamId, [key], {
    previous: { [key]: previous },
    entities: {
      [key]: { ...current, payload: { ...current.payload, years: [2027] } },
    },
  });
  assert.equal(
    calls.reset,
    1,
    "scope changes still force a fresh scoped snapshot",
  );
});

test("paused v2 transition rejects late disjoint pending input at the final SQLite writer and preserves C, P and local rows", async (t) => {
  const { sqliteFixture } = await import("./business-storage-fixture.mjs");
  const { createNodeMutationBridge } =
    await import("../server/sync/node-mutations.mjs");
  const { snapshotGuard } = await import("../server/sync/node-background.mjs");
  const { upgradeState } = await import("../server/sync/versions.mjs");
  const { canonical, stateHash, protocolVersion } =
    await import("../server/sync/protocol.mjs");
  const f = sqliteFixture(t),
    raw = f.app.locals.sync.store(f.teamId);
  assert.equal(raw.acquire("transition-review"), true);
  const state = upgradeState(f.state),
    guard = snapshotGuard(f.db, f.teamId);
  // The worker prepared only report changes while P was empty. The late original
  // cell input does not overlap that touched set, so ordinary projection guards
  // intentionally allow it; a protocol transition must enforce a strict drain.
  const prepared = {
    guard,
    touched: ["unique:report"],
    patch: prepareStatePatch(f.state, state),
    outboxHashes: [],
    changedEntities: {},
    previous: {},
    retiredKeys: [],
    hash: stateHash(state),
  };
  const key = entityId("cell", [f.taskId, "title"]),
    cell = f.state.entities[key];
  const pending = makeOperation({
    link: raw.readLink(),
    actorRef: f.user.id,
    before: { [key]: cell },
    after: {
      [key]: {
        ...cell,
        payload: { ...cell.payload, value: "late original cell input" },
      },
    },
  });
  transaction(f.db, () => raw.enqueue(pending));
  const before = {
    state: canonical(raw.readState()),
    pending: canonical(raw.readPending()),
    head: raw.readLink().canonical_head,
    hash: raw.readLink().canonical_hash,
    cells: f.db
      .prepare("SELECT * FROM cells WHERE task_id=? ORDER BY key")
      .all(f.taskId),
    audit: f.db.prepare("SELECT COUNT(*) count FROM audit").get().count,
  };
  const bridge = createNodeMutationBridge({
    db: f.db,
    store: () => raw,
    capture: f.app.locals.sync.capture,
    notify() {
      assert.fail("rejected transition must not notify a commit");
    },
    installationId: f.link.installation_id,
    isStopped: () => false,
    recordError() {},
  });
  await assert.rejects(
    () =>
      bridge(
        {
          action: "commit",
          teamId: f.teamId,
          owner: "transition-review",
          data: {
            transition: true,
            expectedHead: f.link.canonical_head,
            newHead: "c".repeat(40),
            ackOpIds: [],
            prepared,
          },
        },
        { upgrading: true },
      ),
    (error) => error.status === 409 && error.code === "SYNC_INTERRUPTED",
  );
  assert.equal(protocolVersion(raw.readState()), 1);
  assert.equal(canonical(raw.readState()), before.state);
  assert.equal(canonical(raw.readPending()), before.pending);
  assert.equal(raw.readLink().canonical_head, before.head);
  assert.equal(raw.readLink().canonical_hash, before.hash);
  assert.deepEqual(
    f.db
      .prepare("SELECT * FROM cells WHERE task_id=? ORDER BY key")
      .all(f.taskId),
    before.cells,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) count FROM audit").get().count,
    before.audit,
  );
});
