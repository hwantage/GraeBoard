import test from "node:test";
import { markedState } from "../../support/sync-state-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sqliteFixture,
  postgresFixture,
} from "../../support/business-storage-fixture.mjs";
import {
  applicationEntities,
  upgradeState,
  splitSheetCloneRecord,
} from "../../../server/sync/core/versions.mjs";
import {
  canonical,
  digest,
  entityId,
  stateHash,
  protocolVersion,
} from "../../../server/sync/core/protocol.mjs";
import {
  mergeMarkdown,
  reduce,
  reduceMany,
  validateSnapshot,
} from "../../../server/sync/core/reducer.mjs";
import { makeOperation } from "../../../server/sync/core/operations.mjs";
import { SheetCloneBusinessService } from "../../../server/storage/sheet-clones/sheet-clone-service.mjs";
import { PostgresSheetCloneRepository } from "../../../worker/storage/sheet-clones/postgres-sheet-clones.mjs";
import { materialize } from "../../../worker/sync/materialize.mjs";
import { adminRoutes } from "../../../worker/control/admin.mjs";
import { RESOLUTION_REJECTED } from "../../../shared/sync/conflict-origin.js";
import {
  encodeSnapshot,
  decodeSnapshot,
} from "../../../server/sync/core/snapshot.mjs";
import { getTask, transaction, openDatabase } from "../../../server/db.mjs";
import { channel } from "node:diagnostics_channel";
import { encodeSheetClone } from "../../../server/sheet-clones/sheet-clones.mjs";
import {
  packSheetCloneData,
  unpackSheetCloneData,
} from "../../../shared/sheet-clones/sheet-clone-sync-data.js";
// SheetClone data travels and is stored in the shared-dictionary form; tests read it expanded.
const sheetCloneTasks = (record) =>
  unpackSheetCloneData(record.payload.data).tasks;
import {
  storeSheetCloneDocuments,
  syncSheetCloneDocuments,
} from "../../../server/documents/document-storage.mjs";
import {
  allEntities,
  readEntity,
} from "../../../server/sync/node/entities.mjs";
import { SqliteDatabase } from "../../../server/storage/sqlite.mjs";
import {
  exportTeam,
  importTeam,
  freezeTeam,
} from "../../../server/storage/transfer/logical-transfer.mjs";
import { join } from "node:path";

const editRequest = (f, sheetClone, value) => ({
  operationId: randomUUID(),
  revision: sheetClone.revision,
  operations: [
    {
      kind: "cells",
      at: new Date().toISOString(),
      changes: [
        {
          taskId: f.taskId,
          key: "title",
          value,
          expectedVersion: sheetClone.tasks[0].cells.title.version,
        },
      ],
    },
  ],
});

test("A3 protocol 3 to 4 preserves all sheetClone metadata, cells, document identities, receipts and v3-compatible snapshots", (t) => {
  const f = sqliteFixture(t),
    beforeHash = stateHash(f.state),
    next = upgradeState(f.state);
  validateSnapshot(next, { teamId: f.teamId, repoId: f.link.repo_id });
  assert.equal(protocolVersion(next), 4);
  assert.equal(
    stateHash(f.state),
    beforeHash,
    "old canonical state is never mutated",
  );
  assert.deepEqual(next.receipts, f.state.receipts);
  assert.deepEqual(next.conflicts, f.state.conflicts);
  for (const [id, before] of Object.entries(f.state.entities)) {
    // The protocol marker is not application data.
    if (before.entity === "protocol") continue;
    const restored = applicationEntities(next.entities)[id];
    assert.deepEqual(restored.payload, before.payload, id);
    assert.equal(restored.deleted, before.deleted);
  }
  assert.equal(
    next.entities[entityId("sheetClone", [f.sheetCloneId])].payload.data.tasks,
    undefined,
  );
  assert.equal(
    next.entities[
      entityId("sheetCloneCell", [f.sheetCloneId, f.taskId, "title"])
    ].payload.data.value,
    "initial",
  );
  const restored = decodeSnapshot(
    encodeSnapshot({ atCommit: f.link.canonical_head, state: next }),
  ).state;
  assert.equal(stateHash(restored), stateHash(next));
  assert.throws(() => upgradeState(next), /version 3/);
});

test("A3 protocol 4 changes independent copy cells without modifying original cells and rejects mixed protocol commands", (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(f.state),
    sheetClone = state.entities[entityId("sheetClone", [f.sheetCloneId])];
  const operation = (key, value) => {
    const id = entityId("sheetCloneCell", [f.sheetCloneId, f.taskId, key]),
      before = state.entities[id];
    return makeOperation({
      link: { ...f.link, protocol: 4 },
      actorRef: f.user.id,
      before: { [id]: before },
      after: {
        [id]: {
          ...before,
          payload: { data: { ...before.payload.data, value } },
        },
      },
    });
  };
  const a = operation("title", "copy title"),
    b = operation("description", "copy detail");
  const ab = reduceMany(state, [a, b]),
    ba = reduceMany(state, [b, a]);
  assert.deepEqual(ab.entities, ba.entities);
  assert.equal(
    ab.entities[entityId("cell", [f.taskId, "title"])].payload.value,
    "initial",
  );
  assert.strictEqual(
    ab.entities[entityId("sheetClone", [f.sheetCloneId])],
    sheetClone,
  );
  assert.ok(Buffer.byteLength(canonical(a)) < 2000);
  assert.throws(
    () => reduce(state, { ...a, protocol: 3, reducer: 3 }),
    /Unsupported protocol/,
  );
  assert.throws(() => reduce(f.state, a), /Unsupported protocol/);
});

test("A6 reducer 3 retains the 20000-edit merge budget while reducer 4 has the deterministic 2000-edit boundary and preserves conflicts", (t) => {
  const base = "a".repeat(3000) + "middle" + "b".repeat(3000);
  const changed = (count) => [
    "c".repeat(count) + base.slice(count),
    base.slice(0, -count) + "d".repeat(count),
  ];
  const [allowedA, allowedB] = changed(1000);
  assert.equal(
    mergeMarkdown(base, allowedA, allowedB, 4),
    "c".repeat(1000) + base.slice(1000, -1000) + "d".repeat(1000),
  );
  const [current, desired] = changed(1001);
  assert.equal(
    mergeMarkdown(base, current, desired),
    "c".repeat(1001) + base.slice(1001, -1001) + "d".repeat(1001),
  );
  assert.equal(mergeMarkdown(base, current, desired, 4), null);
  assert.throws(() => mergeMarkdown(base, current, desired, 2), /reducer/);
  const f = sqliteFixture(t),
    state = upgradeState(f.state),
    id = entityId("document", ["annual", "2026", "budget"]);
  state.entities[id] = {
    entity: "document",
    key: ["annual", "2026", "budget"],
    generation: "g",
    version: "first",
    payload: { title: "Budget", position: 0, markdown: current },
    deleted: false,
  };
  const before = {
    ...state.entities[id],
    payload: { ...state.entities[id].payload, markdown: base },
  };
  const op = makeOperation({
    link: { ...f.link, protocol: 4 },
    actorRef: f.user.id,
    before: { [id]: before },
    after: {
      [id]: { ...before, payload: { ...before.payload, markdown: desired } },
    },
  });
  const result = reduce(state, op);
  assert.equal(result.receipt.result, "conflict");
  assert.equal(result.state.entities[id].payload.markdown, current);
  assert.equal(
    result.state.conflicts[op.opId].operation.changes[0].base.markdown,
    base,
  );
  assert.equal(
    result.state.conflicts[op.opId].operation.changes[0].desired.markdown,
    desired,
  );
});

test("A3 Node ordinary sheetClone save captures only the changed protocol 4 copy cell", async (t) => {
  const f = sqliteFixture(t),
    next = upgradeState(f.state);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(next, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  const service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    ),
    before = service.read(f.sheetCloneId);
  const result = await service.edit(
    f.sheetCloneId,
    editRequest(f, before, "Node copy"),
  );
  assert.equal(result.tasks[0].cells.title.value, "Node copy");
  const pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].protocol, 4);
  assert.ok(
    !pending[0].changes.some((change) => change.entity === "sheetClone"),
  );
  assert.equal(
    pending[0].changes.filter((change) => change.entity === "sheetCloneCell")
      .length,
    1,
  );
  assert.ok(
    pending[0].changes.every((change) =>
      ["sheetCloneCell", "sheetCloneTask", "document"].includes(change.entity),
    ),
  );
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  assert.equal(getTask(f.db, f.taskId).cells.title.value, "initial");
  const projected = reduceMany(next, pending);
  assert.equal(
    sheetCloneTasks(
      applicationEntities(projected.entities)[
        entityId("sheetClone", [f.sheetCloneId])
      ],
    )[0].cells.title.value,
    "Node copy",
  );
});

test("A3 actual PostgreSQL sheetClone save and materialization retain copy-cell separation under protocol 4", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state);
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(state, f.link.canonical_head);
    await materialize(tx, f.teamId, { state, pending: [], exclusions: [] });
  });
  const service = new SheetCloneBusinessService(
      new PostgresSheetCloneRepository({ context: f.makeContext() }),
      f.user,
    ),
    before = await service.read(f.sheetCloneId);
  const result = await service.edit(
    f.sheetCloneId,
    editRequest(f, before, "Edge copy"),
  );
  assert.equal(result.tasks[0].cells.title.value, "Edge copy");
  const pending = await f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].protocol, 4);
  assert.ok(
    !pending[0].changes.some((change) => change.entity === "sheetClone"),
  );
  assert.equal(
    pending[0].changes.filter((change) => change.entity === "sheetCloneCell")
      .length,
    1,
  );
  assert.ok(
    pending[0].changes.every((change) =>
      ["sheetCloneCell", "sheetCloneTask", "document"].includes(change.entity),
    ),
  );
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  const projected = reduceMany(state, pending);
  assert.equal(
    sheetCloneTasks(
      applicationEntities(projected.entities)[
        entityId("sheetClone", [f.sheetCloneId])
      ],
    )[0].cells.title.value,
    "Edge copy",
  );
  await f.adapter.commitCanonical(
    f.teamId,
    f.link.canonical_head,
    "b".repeat(40),
    projected,
    pending.map((op) => op.opId),
    (tx, data) => materialize(tx, f.teamId, data),
  );
  const restored = await service.read(f.sheetCloneId);
  assert.equal(restored.tasks[0].cells.title.value, "Edge copy");
});

// Frozen with the pre-review v1 reducer from 8be6e298ea9420e64771e4de7b98eb8e2332b888.
// This history needs more than 2000 edit steps and must keep its old success
// result. Reducer 3 is reducer 1 under the SheetClone names: replayed as
// protocol 3, the same history must give the frozen v1 state once its
// commands are hashed as the v1 commands they were and C drops its marker.
test("A6 frozen v1 history keeps identical canonical, receipt and conflict hashes under reducer 3", () => {
  const base = "a".repeat(3000) + "middle" + "b".repeat(3000),
    current = "c".repeat(1001) + base.slice(1001),
    desired = base.slice(0, -1001) + "d".repeat(1001),
    body = (markdown) => ({ title: "Budget", position: 0, markdown });
  const op = (
    opId,
    desired,
    before = null,
    baseVersion = null,
    protocol = 3,
  ) => ({
    protocol,
    reducer: protocol,
    repoId: "golden-repo",
    teamId: "golden-team",
    opId,
    writerEpoch: "golden-writer",
    actorRef: "golden-actor",
    createdAt: "2026-10-29T00:00:00.000Z",
    dependsOn: [],
    changes: [
      {
        entity: "document",
        key: ["annual", "2026", "budget"],
        generation: "golden-generation",
        baseVersion,
        action: before ? "edit" : "create",
        base: before && body(before),
        desired: body(desired),
        fields: before ? ["markdown"] : ["title", "position", "markdown"],
      },
    ],
    objects: [],
  });
  const history = (protocol) => [
    op("golden-create", base, null, null, protocol),
    op("golden-current", current, base, "golden-create:0", protocol),
    op("golden-desired", desired, base, "golden-create:0", protocol),
  ];
  const state = reduceMany(markedState(), history(3));
  // The v1 commands themselves are no longer accepted.
  assert.throws(
    () => reduceMany(markedState(), history(1)),
    /Unsupported protocol/,
  );
  const v1 = Object.fromEntries(
      history(1).map((item) => [item.opId, digest(item)]),
    ),
    { [entityId("protocol", [])]: marker, ...entities } = state.entities,
    receipts = Object.fromEntries(
      Object.entries(state.receipts).map(([id, receipt]) => [
        id,
        { ...receipt, payloadHash: v1[id] },
      ]),
    ),
    frozen = { entities, receipts, conflicts: state.conflicts };
  assert.equal(
    stateHash(frozen),
    "cf6c01007d9e0badcfbf663042f877102bfc7e50277d3806faddc425f5e1974d",
  );
  assert.equal(
    digest(receipts),
    "90dd3bda9d59fd4ccb582dc367ec1d11f2b6c03a5abff8af6989506553da7cde",
  );
  assert.equal(
    digest(state.conflicts),
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("A3 deleting and restoring a copy never revives previously deleted rows or cells", (t) => {
  const f = sqliteFixture(t),
    source = structuredClone(f.state),
    sheetCloneId = entityId("sheetClone", [f.sheetCloneId]);
  const secondTask = randomUUID(),
    sourceData = unpackSheetCloneData(
      source.entities[sheetCloneId].payload.data,
    ),
    originalTask = sourceData.tasks[0];
  source.entities[sheetCloneId].payload.data = packSheetCloneData({
    ...sourceData,
    tasks: [
      ...sourceData.tasks,
      { ...structuredClone(originalTask), id: secondTask },
    ],
  });
  let state = upgradeState(source);
  const command = (after) => {
    const before = Object.fromEntries(
      Object.keys(after).map((id) => [id, state.entities[id] || null]),
    );
    const operation = makeOperation({
      link: { ...f.link, protocol: 4 },
      actorRef: f.user.id,
      before,
      after,
    });
    const result = reduce(state, operation);
    assert.equal(result.receipt.result, "applied");
    state = result.state;
  };
  const removedCell = entityId("sheetCloneCell", [
    f.sheetCloneId,
    f.taskId,
    "description",
  ]);
  command({ [removedCell]: null });
  const removedTaskIds = Object.entries(state.entities)
    .filter(
      ([, record]) =>
        ["sheetCloneTask", "sheetCloneCell"].includes(record.entity) &&
        record.key[1] === secondTask,
    )
    .map(([id]) => id);
  command(Object.fromEntries(removedTaskIds.map((id) => [id, null])));
  const active = applicationEntities(state.entities)[sheetCloneId];
  assert.equal(sheetCloneTasks(active).length, 1);
  assert.equal(sheetCloneTasks(active)[0].cells.description, undefined);
  const visible = splitSheetCloneRecord(active);
  command(
    Object.fromEntries(
      visible.map((record) => [entityId(record.entity, record.key), null]),
    ),
  );
  const deleted = applicationEntities(state.entities)[sheetCloneId];
  assert.equal(deleted.deleted, true);
  assert.equal(sheetCloneTasks(deleted).length, 1);
  assert.equal(sheetCloneTasks(deleted)[0].cells.description, undefined);
  const restored = splitSheetCloneRecord({ ...deleted, deleted: false });
  command(
    Object.fromEntries(
      restored.map((record) => [entityId(record.entity, record.key), record]),
    ),
  );
  const final = applicationEntities(state.entities)[sheetCloneId];
  assert.equal(sheetCloneTasks(final).length, 1);
  assert.equal(sheetCloneTasks(final)[0].cells.description, undefined);
  assert.equal(
    state.entities[entityId("sheetCloneTask", [f.sheetCloneId, secondTask])]
      .deleted,
    true,
  );
  assert.equal(state.entities[removedCell].deleted, true);
  validateSnapshot(state, { teamId: f.teamId, repoId: f.link.repo_id });
});

test("A3 a pre-existing protocol 3 deleted copy retains exactly its tombstone body after upgrade", (t) => {
  const f = sqliteFixture(t),
    state = structuredClone(f.state),
    id = entityId("sheetClone", [f.sheetCloneId]);
  state.entities[id].deleted = true;
  const next = upgradeState(state);
  assert.deepEqual(
    applicationEntities(next.entities)[id].payload,
    state.entities[id].payload,
  );
  validateSnapshot(next, { teamId: f.teamId, repoId: f.link.repo_id });
  const invalid = structuredClone(next);
  invalid.entities[entityId("protocol", [])].deleted = true;
  assert.throws(
    () =>
      validateSnapshot(invalid, { teamId: f.teamId, repoId: f.link.repo_id }),
    /Deleted protocol marker/,
  );
});

test("A3 1000-row 100-document copy decodes once per phase and invalidates after rollback", async (t) => {
  const f = sqliteFixture(t),
    sheetClone = structuredClone(
      unpackSheetCloneData(
        f.state.entities[entityId("sheetClone", [f.sheetCloneId])].payload.data,
      ),
    ),
    prototype = sheetClone.tasks[0];
  sheetClone.tasks = Array.from({ length: 1000 }, (_, index) => ({
    ...structuredClone(prototype),
    id: index ? randomUUID() : f.taskId,
    documents:
      index < 100 ? [{ id: "main", title: "", markdown: "Body " + index }] : [],
  }));
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      sheetClone.tasks = storeSheetCloneDocuments(
        f.db,
        sheetClone.tasks,
        f.teamId,
        f.user.id,
      );
      f.db
        .prepare("UPDATE sheet_clones SET data=? WHERE id=?")
        .run(encodeSheetClone(sheetClone), f.sheetCloneId);
      syncSheetCloneDocuments(f.db, f.sheetCloneId, sheetClone.tasks);
    }),
  );
  const counts = [],
    observer = ({ sheetCloneId }) => counts.push(sheetCloneId),
    diagnostic = channel("graeboard.sync.sheetClone.decode");
  diagnostic.subscribe(observer);
  t.after(() => diagnostic.unsubscribe(observer));
  const actualDecodes = [],
    decoded = channel("graeboard.sheetClone.decode"),
    countDecode = (sample) => actualDecodes.push(sample);
  decoded.subscribe(countDecode);
  t.after(() => decoded.unsubscribe(countDecode));
  const source = { ...markedState(), entities: allEntities(f.db, f.link) };
  assert.equal(
    counts.length,
    1,
    "bootstrap shares one decoded copy across its 100 documents",
  );
  const state = upgradeState(source);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  counts.length = 0;
  const metadataQueries = [],
    prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", (sql) => {
    const statement = prepare(sql);
    if (
      sql.includes("json_each(?) AS wanted") &&
      sql.includes("sync_entities")
    ) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, "all", (...args) => {
        const rows = all(...args);
        metadataQueries.push({ sql, args, rows: rows.length });
        return rows;
      });
    }
    return statement;
  });
  const service = new SheetCloneBusinessService(
    f.app.locals.sheetCloneRepository,
    f.user,
  );
  const first = service.read(f.sheetCloneId);
  actualDecodes.length = 0;
  await service.edit(f.sheetCloneId, editRequest(f, first, "1000-row edit"));
  assert.equal(
    counts.length,
    2,
    "one before plus one after decode for all 100 references",
  );
  assert.equal(
    actualDecodes.length,
    2,
    "business read/response and capture share each exact BLOB decode inside this edit",
  );
  const pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(
    pending[0].changes.filter((c) => c.entity === "sheetCloneCell").length,
    1,
  );
  assert.ok(!pending[0].changes.some((c) => c.entity === "sheetClone"));
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  assert.equal(getTask(f.db, f.taskId).cells.title.value, "initial");
  counts.length = 0;
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.db
          .prepare("UPDATE sheet_clones SET name='rolled back' WHERE id=?")
          .run(f.sheetCloneId);
        throw new Error("rollback fixture");
      }),
    /rollback fixture/,
  );
  assert.equal(counts.length, 1);
  counts.length = 0;
  const second = service.read(f.sheetCloneId);
  actualDecodes.length = 0;
  await service.edit(f.sheetCloneId, editRequest(f, second, "after rollback"));
  assert.equal(
    counts.length,
    2,
    "rolled-back before images do not survive the next transaction",
  );
  assert.equal(
    actualDecodes.length,
    2,
    "a later edit starts a new decode scope after rollback",
  );
  assert.equal(metadataQueries.length, 2);
  for (const query of metadataQueries) {
    assert.ok(
      query.rows <= 3,
      "only changed copy metadata is read, independent of the 1000-row sheet size",
    );
    const plan = prepare("EXPLAIN QUERY PLAN " + query.sql).all(...query.args);
    assert.ok(
      plan.some((row) =>
        /team_id=\? AND entity=\? AND entity_key=\?/.test(row.detail),
      ),
      "lookup must use all canonical primary-key columns rather than scanning the team's entities",
    );
  }
  const result = reduceMany(state, f.adapter.readPending(f.teamId));
  assert.equal(
    applicationEntities(result.entities)[
      entityId("sheetClone", [f.sheetCloneId])
    ].payload.name,
    "Contract sheetClone",
  );
});

test("A6 protocol 4 Unicode, deletion and same-position insertion rules are deterministic", () => {
  const examples = [
    [
      "가나다라마바사",
      "가X나다라마바사",
      "가나다라마바사Y",
      "가X나다라마바사Y",
    ],
    ["A😀B한글C", "A😀B!한글C", "A😀B한글C?", "A😀B!한글C?"],
    ["abcdef", "abef", "abcdeF", "abeF"],
    ["ab", "aXb", "aYb", null],
    ["ab", "aXb", "aXb", "aXb"],
  ];
  for (const [base, current, desired, expected] of examples) {
    assert.equal(mergeMarkdown(base, current, desired, 4), expected);
    assert.equal(mergeMarkdown(base, desired, current, 4), expected);
  }
});

test("A3 protocol 4 logical transfer preserves canonical children and exports the established sheetClone view", async (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(f.state);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  const service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    ),
    before = service.read(f.sheetCloneId);
  await service.edit(
    f.sheetCloneId,
    editRequest(f, before, "pending transfer copy"),
  );
  const pending = f.adapter.readPending(f.teamId),
    job = await freezeTeam(f.adapter, f.teamId),
    bundle = await exportTeam(f.adapter, f.teamId, { omitJobId: job });
  const sheetClone = bundle.payload.tables.site_entities.find(
    (row) => row.entity === "sheetClone",
  );
  assert.equal(
    unpackSheetCloneData(JSON.parse(sheetClone.payload).data).tasks[0].cells
      .title.value,
    "pending transfer copy",
  );
  assert.ok(
    !bundle.payload.tables.site_entities.some((row) =>
      ["protocol", "sheetCloneTask", "sheetCloneCell"].includes(row.entity),
    ),
  );
  assert.ok(
    bundle.payload.tables.sync_entities.some(
      (row) => row.entity === "sheetCloneCell",
    ),
  );
  const db = openDatabase(join(f.dir, "restored-v2.sqlite"));
  t.after(() => db.close());
  const restored = new SqliteDatabase(db);
  await importTeam(restored, bundle);
  assert.equal(stateHash(restored.readState(f.teamId)), stateHash(state));
  assert.deepEqual(restored.readPending(f.teamId), pending);
  assert.equal(
    sheetCloneTasks(readEntity(db, f.teamId, "sheetClone", [f.sheetCloneId]))[0]
      .cells.title.value,
    "pending transfer copy",
  );
  assert.equal(restored.readLink(f.teamId).mode, "recovery");
});

test("protocol 5 logical transfer carries a copy as its row records and restores the established sheetClone", async (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(f.state, 5);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  const service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    ),
    before = service.read(f.sheetCloneId);
  await service.edit(
    f.sheetCloneId,
    editRequest(f, before, "pending transfer copy"),
  );
  const pending = f.adapter.readPending(f.teamId),
    job = await freezeTeam(f.adapter, f.teamId),
    bundle = await exportTeam(f.adapter, f.teamId, { omitJobId: job }),
    site = bundle.payload.tables.site_entities,
    parent = JSON.parse(
      site.find((row) => row.entity === "sheetClone").payload,
    ),
    row = site.find(
      (item) =>
        item.entity === "sheetCloneTask" &&
        JSON.parse(item.entity_key)[1] === f.taskId,
    );
  // The site rows an external site at protocol 5 stores: the parent with its
  // format assignment, and each row with its cells.
  assert.equal(parent.order, undefined);
  assert.equal(typeof parent.formats, "object");
  assert.equal(parent.data.tasks, undefined);
  assert.equal(
    JSON.parse(row.payload).cells.title.value,
    "pending transfer copy",
  );
  assert.ok(!site.some((item) => item.entity === "protocol"));
  const db = openDatabase(join(f.dir, "restored-v5.sqlite"));
  t.after(() => db.close());
  const restored = new SqliteDatabase(db);
  await importTeam(restored, bundle);
  assert.equal(stateHash(restored.readState(f.teamId)), stateHash(state));
  assert.deepEqual(restored.readPending(f.teamId), pending);
  const tasks = sheetCloneTasks(
    readEntity(db, f.teamId, "sheetClone", [f.sheetCloneId]),
  );
  assert.equal(tasks.length, before.tasks.length);
  assert.equal(
    tasks.find((task) => task.id === f.taskId).cells.title.value,
    "pending transfer copy",
  );
});

test("Edge conflict resolution refuses a duplicate copy name before saving and accepts a renamed edit", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state),
    id = entityId("sheetClone", [f.sheetCloneId]),
    original = state.entities[id],
    otherId = randomUUID(),
    link = { ...f.link, protocol: 4 };
  // Two sites take the same copy name: one makes another copy with it, the
  // other renames this copy to it from the same base.
  const other = makeOperation({
      link,
      actorRef: f.user.id,
      before: {},
      after: {
        [entityId("sheetClone", [otherId])]: {
          entity: "sheetClone",
          key: [otherId],
          payload: { ...original.payload, name: "Shared copy name" },
        },
      },
    }),
    rename = makeOperation({
      link,
      actorRef: f.user.id,
      before: { [id]: original },
      after: {
        [id]: {
          ...original,
          payload: { ...original.payload, name: "Shared copy name" },
        },
      },
    }),
    conflicted = reduceMany(state, [other, rename]);
  assert.equal(conflicted.receipts[other.opId].result, "applied");
  assert.equal(conflicted.conflicts[rename.opId].reason, "Duplicate name");
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(conflicted, f.link.canonical_head);
    await materialize(tx, f.teamId, {
      state: conflicted,
      pending: [],
      exclusions: [],
    });
  });
  const resolve = (body) =>
    adminRoutes(
      f.makeContext(),
      `/teams/${f.teamId}/sync/conflicts/${rename.opId}/resolve`,
      "POST",
      { expectedHead: f.link.canonical_head, ...body },
    );
  // Saved, it would be archived again and leave this conflict open, so each
  // retry would only add a conflict.
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(resolve({ choice: "submitted" }), (error) => {
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, {
        code: RESOLUTION_REJECTED,
        reason: "Duplicate name",
      });
      return true;
    });
  assert.deepEqual(await f.adapter.readPending(f.teamId), []);
  await resolve({
    choice: "edited",
    desired: [{ ...original.payload, name: "Renamed copy" }],
  });
  const pending = await f.adapter.readPending(f.teamId),
    resolved = reduceMany(conflicted, pending);
  assert.equal(pending.length, 1);
  assert.equal(resolved.receipts[pending[0].opId].result, "applied");
  assert.equal(resolved.conflicts[rename.opId].resolution, pending[0].opId);
  assert.equal(resolved.entities[id].payload.name, "Renamed copy");
});

test("Edge conflict resolution refuses a name an unpublished operation already took", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state),
    id = entityId("sheetClone", [f.sheetCloneId]),
    original = state.entities[id],
    otherId = randomUUID(),
    otherKey = entityId("sheetClone", [otherId]),
    link = { ...f.link, protocol: 4 };
  const rename = (key, record, name) =>
    makeOperation({
      link,
      actorRef: f.user.id,
      before: record ? { [key]: record } : {},
      after: {
        [key]: {
          ...(record || { entity: "sheetClone", key: [otherId] }),
          payload: { ...original.payload, name },
        },
      },
    });
  // Shared: another copy, and this copy renamed first; the later rename of
  // this copy is archived. Only the unpublished rename of the other copy
  // takes the later name, so shared state alone would accept overwriting.
  const other = rename(otherKey, null, "Other copy"),
    first = rename(id, original, "Canonical name"),
    later = rename(id, original, "Later name"),
    conflicted = reduceMany(state, [other, first, later]);
  assert.equal(
    conflicted.conflicts[later.opId].reason,
    "Concurrent field change",
  );
  const unpublished = rename(
    otherKey,
    conflicted.entities[otherKey],
    "Later name",
  );
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(conflicted, f.link.canonical_head);
    await materialize(tx, f.teamId, {
      state: conflicted,
      pending: [],
      exclusions: [],
    });
    await tx.sync.enqueue(unpublished);
  });
  const resolve = (choice) =>
    adminRoutes(
      f.makeContext(),
      `/teams/${f.teamId}/sync/conflicts/${later.opId}/resolve`,
      "POST",
      { choice, expectedHead: f.link.canonical_head },
    );
  await assert.rejects(resolve("submitted"), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, {
      code: RESOLUTION_REJECTED,
      reason: "Duplicate name",
    });
    return true;
  });
  assert.deepEqual(
    (await f.adapter.readPending(f.teamId)).map((op) => op.opId),
    [unpublished.opId],
    "the unpublished operation stays and nothing is added",
  );
  await resolve("current");
  const pending = await f.adapter.readPending(f.teamId),
    replayed = reduceMany(conflicted, pending);
  assert.equal(pending.length, 2);
  assert.equal(replayed.conflicts[later.opId].resolution, pending[1].opId);
  assert.equal(replayed.entities[id].payload.name, "Canonical name");
});

test("A3 actual Edge conflict resolution creates a protocol 4 operation and preserves both original submissions", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state),
    id = entityId("sheetCloneCell", [f.sheetCloneId, f.taskId, "title"]),
    original = state.entities[id];
  const edit = (value) =>
    makeOperation({
      link: { ...f.link, protocol: 4 },
      actorRef: f.user.id,
      before: { [id]: original },
      after: {
        [id]: {
          ...original,
          payload: { data: { ...original.payload.data, value } },
        },
      },
    });
  const a = edit("canonical copy"),
    b = edit("submitted copy"),
    conflicted = reduceMany(state, [a, b]);
  assert.equal(conflicted.receipts[b.opId].result, "conflict");
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(conflicted, f.link.canonical_head);
    await materialize(tx, f.teamId, {
      state: conflicted,
      pending: [],
      exclusions: [],
    });
  });
  await adminRoutes(
    f.makeContext(),
    `/teams/${f.teamId}/sync/conflicts/${b.opId}/resolve`,
    "POST",
    { choice: "submitted", expectedHead: f.link.canonical_head },
  );
  const pending = await f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].protocol, 4);
  assert.equal(pending[0].reducer, 4);
  assert.deepEqual(
    (await f.adapter.readState(f.teamId)).conflicts[b.opId],
    conflicted.conflicts[b.opId],
  );
  const resolved = reduceMany(conflicted, pending);
  assert.equal(resolved.entities[id].payload.data.value, "submitted copy");
  assert.equal(
    resolved.conflicts[b.opId].operation.changes[0].desired.data.value,
    "submitted copy",
  );
  assert.equal(
    resolved.conflicts[b.opId].current[id].payload.data.value,
    "canonical copy",
  );
});
