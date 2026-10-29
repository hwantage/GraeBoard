import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import {
  applicationEntities,
  upgradeState,
  splitReportRecord,
} from "../server/sync/versions.mjs";
import {
  canonical,
  digest,
  emptyState,
  entityId,
  stateHash,
  protocolVersion,
} from "../server/sync/protocol.mjs";
import {
  mergeMarkdown,
  reduce,
  reduceMany,
  validateSnapshot,
} from "../server/sync/reducer.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { ReportBusinessService } from "../server/storage/report-service.mjs";
import { PostgresReportRepository } from "../worker/storage/postgres-reports.mjs";
import { materialize } from "../worker/materialize.mjs";
import { adminRoutes } from "../worker/admin.mjs";
import { encodeSnapshot, decodeSnapshot } from "../server/sync/snapshot.mjs";
import { getTask, transaction, openDatabase } from "../server/db.mjs";
import { channel } from "node:diagnostics_channel";
import { encodeReport } from "../server/reports.mjs";
import {
  storeReportDocuments,
  syncReportDocuments,
} from "../server/document-storage.mjs";
import { allEntities, readEntity } from "../server/sync/entities.mjs";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import {
  exportTeam,
  importTeam,
  freezeTeam,
} from "../server/storage/logical-transfer.mjs";
import { join } from "node:path";

const editRequest = (f, report, value) => ({
  operationId: randomUUID(),
  revision: report.revision,
  operations: [
    {
      kind: "cells",
      at: new Date().toISOString(),
      changes: [
        {
          taskId: f.taskId,
          key: "title",
          value,
          expectedVersion: report.tasks[0].cells.title.version,
        },
      ],
    },
  ],
});

test("A3 v1 to v2 preserves all report metadata, cells, document identities, receipts and v3-compatible snapshots", (t) => {
  const f = sqliteFixture(t),
    beforeHash = stateHash(f.state),
    next = upgradeState(f.state);
  validateSnapshot(next, { teamId: f.teamId, repoId: f.link.repo_id });
  assert.equal(protocolVersion(next), 2);
  assert.equal(
    stateHash(f.state),
    beforeHash,
    "old canonical state is never mutated",
  );
  assert.deepEqual(next.receipts, f.state.receipts);
  assert.deepEqual(next.conflicts, f.state.conflicts);
  for (const [id, before] of Object.entries(f.state.entities)) {
    const restored = applicationEntities(next.entities)[id];
    assert.deepEqual(restored.payload, before.payload, id);
    assert.equal(restored.deleted, before.deleted);
  }
  assert.equal(
    next.entities[entityId("report", [f.reportId])].payload.data.tasks,
    undefined,
  );
  assert.equal(
    next.entities[entityId("reportCell", [f.reportId, f.taskId, "title"])]
      .payload.data.value,
    "initial",
  );
  const restored = decodeSnapshot(
    encodeSnapshot({ atCommit: f.link.canonical_head, state: next }),
  ).state;
  assert.equal(stateHash(restored), stateHash(next));
  assert.throws(() => upgradeState(next), /version 1/);
});

test("A3 v2 changes independent copy cells without modifying original cells and rejects mixed protocol commands", (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(f.state),
    report = state.entities[entityId("report", [f.reportId])];
  const operation = (key, value) => {
    const id = entityId("reportCell", [f.reportId, f.taskId, key]),
      before = state.entities[id];
    return makeOperation({
      link: { ...f.link, protocol: 2 },
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
  assert.strictEqual(ab.entities[entityId("report", [f.reportId])], report);
  assert.ok(Buffer.byteLength(canonical(a)) < 2000);
  assert.throws(
    () => reduce(state, { ...a, protocol: 1, reducer: 1 }),
    /Unsupported protocol/,
  );
  assert.throws(() => reduce(f.state, a), /Unsupported protocol/);
});

test("A6 reducer v1 retains its old merge budget while v2 has a deterministic 2000-edit boundary and preserves conflicts", (t) => {
  const base = "a".repeat(3000) + "middle" + "b".repeat(3000);
  const changed = (count) => [
    "c".repeat(count) + base.slice(count),
    base.slice(0, -count) + "d".repeat(count),
  ];
  const [allowedA, allowedB] = changed(1000);
  assert.equal(
    mergeMarkdown(base, allowedA, allowedB, 2),
    "c".repeat(1000) + base.slice(1000, -1000) + "d".repeat(1000),
  );
  const [current, desired] = changed(1001);
  assert.equal(
    mergeMarkdown(base, current, desired),
    "c".repeat(1001) + base.slice(1001, -1001) + "d".repeat(1001),
  );
  assert.equal(mergeMarkdown(base, current, desired, 2), null);
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
    link: { ...f.link, protocol: 2 },
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

test("A3 Node ordinary report save captures only the changed v2 copy cell", async (t) => {
  const f = sqliteFixture(t),
    next = upgradeState(f.state);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(next, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  const service = new ReportBusinessService(
      f.app.locals.reportRepository,
      f.user,
    ),
    before = service.read(f.reportId);
  const result = await service.edit(
    f.reportId,
    editRequest(f, before, "Node copy"),
  );
  assert.equal(result.tasks[0].cells.title.value, "Node copy");
  const pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].protocol, 2);
  assert.ok(!pending[0].changes.some((change) => change.entity === "report"));
  assert.equal(
    pending[0].changes.filter((change) => change.entity === "reportCell")
      .length,
    1,
  );
  assert.ok(
    pending[0].changes.every((change) =>
      ["reportCell", "reportTask", "document"].includes(change.entity),
    ),
  );
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  assert.equal(getTask(f.db, f.taskId).cells.title.value, "initial");
  const projected = reduceMany(next, pending);
  assert.equal(
    applicationEntities(projected.entities)[entityId("report", [f.reportId])]
      .payload.data.tasks[0].cells.title.value,
    "Node copy",
  );
});

test("A3 actual PostgreSQL report save and materialization retain copy-cell separation under v2", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state);
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(state, f.link.canonical_head);
    await materialize(tx, f.teamId, { state, pending: [], exclusions: [] });
  });
  const service = new ReportBusinessService(
      new PostgresReportRepository({ context: f.makeContext() }),
      f.user,
    ),
    before = await service.read(f.reportId);
  const result = await service.edit(
    f.reportId,
    editRequest(f, before, "Edge copy"),
  );
  assert.equal(result.tasks[0].cells.title.value, "Edge copy");
  const pending = await f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].protocol, 2);
  assert.ok(!pending[0].changes.some((change) => change.entity === "report"));
  assert.equal(
    pending[0].changes.filter((change) => change.entity === "reportCell")
      .length,
    1,
  );
  assert.ok(
    pending[0].changes.every((change) =>
      ["reportCell", "reportTask", "document"].includes(change.entity),
    ),
  );
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  const projected = reduceMany(state, pending);
  assert.equal(
    applicationEntities(projected.entities)[entityId("report", [f.reportId])]
      .payload.data.tasks[0].cells.title.value,
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
  const restored = await service.read(f.reportId);
  assert.equal(restored.tasks[0].cells.title.value, "Edge copy");
});

// Frozen with the pre-review v1 reducer from 8be6e298ea9420e64771e4de7b98eb8e2332b888.
// This history needs more than 2000 edit steps and must keep its old success result.
test("A6 frozen v1 history keeps identical canonical, receipt and conflict hashes", () => {
  const base = "a".repeat(3000) + "middle" + "b".repeat(3000),
    current = "c".repeat(1001) + base.slice(1001),
    desired = base.slice(0, -1001) + "d".repeat(1001),
    body = (markdown) => ({ title: "Budget", position: 0, markdown });
  const op = (opId, desired, before = null, baseVersion = null) => ({
    protocol: 1,
    reducer: 1,
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
  const state = reduceMany(emptyState(), [
    op("golden-create", base),
    op("golden-current", current, base, "golden-create:0"),
    op("golden-desired", desired, base, "golden-create:0"),
  ]);
  assert.equal(
    stateHash(state),
    "cf6c01007d9e0badcfbf663042f877102bfc7e50277d3806faddc425f5e1974d",
  );
  assert.equal(
    digest(state.receipts),
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
    reportId = entityId("report", [f.reportId]);
  const secondTask = randomUUID(),
    originalTask = source.entities[reportId].payload.data.tasks[0];
  source.entities[reportId].payload.data.tasks.push({
    ...structuredClone(originalTask),
    id: secondTask,
  });
  let state = upgradeState(source);
  const command = (after) => {
    const before = Object.fromEntries(
      Object.keys(after).map((id) => [id, state.entities[id] || null]),
    );
    const operation = makeOperation({
      link: { ...f.link, protocol: 2 },
      actorRef: f.user.id,
      before,
      after,
    });
    const result = reduce(state, operation);
    assert.equal(result.receipt.result, "applied");
    state = result.state;
  };
  const removedCell = entityId("reportCell", [
    f.reportId,
    f.taskId,
    "description",
  ]);
  command({ [removedCell]: null });
  const removedTaskIds = Object.entries(state.entities)
    .filter(
      ([, record]) =>
        ["reportTask", "reportCell"].includes(record.entity) &&
        record.key[1] === secondTask,
    )
    .map(([id]) => id);
  command(Object.fromEntries(removedTaskIds.map((id) => [id, null])));
  const active = applicationEntities(state.entities)[reportId];
  assert.equal(active.payload.data.tasks.length, 1);
  assert.equal(active.payload.data.tasks[0].cells.description, undefined);
  const visible = splitReportRecord(active);
  command(
    Object.fromEntries(
      visible.map((record) => [entityId(record.entity, record.key), null]),
    ),
  );
  const deleted = applicationEntities(state.entities)[reportId];
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.payload.data.tasks.length, 1);
  assert.equal(deleted.payload.data.tasks[0].cells.description, undefined);
  const restored = splitReportRecord({ ...deleted, deleted: false });
  command(
    Object.fromEntries(
      restored.map((record) => [entityId(record.entity, record.key), record]),
    ),
  );
  const final = applicationEntities(state.entities)[reportId];
  assert.equal(final.payload.data.tasks.length, 1);
  assert.equal(final.payload.data.tasks[0].cells.description, undefined);
  assert.equal(
    state.entities[entityId("reportTask", [f.reportId, secondTask])].deleted,
    true,
  );
  assert.equal(state.entities[removedCell].deleted, true);
  validateSnapshot(state, { teamId: f.teamId, repoId: f.link.repo_id });
});

test("A3 a pre-existing v1 deleted copy retains exactly its tombstone body after upgrade", (t) => {
  const f = sqliteFixture(t),
    state = structuredClone(f.state),
    id = entityId("report", [f.reportId]);
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
    report = structuredClone(
      f.state.entities[entityId("report", [f.reportId])].payload.data,
    ),
    prototype = report.tasks[0];
  report.tasks = Array.from({ length: 1000 }, (_, index) => ({
    ...structuredClone(prototype),
    id: index ? randomUUID() : f.taskId,
    documents:
      index < 100 ? [{ id: "main", title: "", markdown: "Body " + index }] : [],
  }));
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      report.tasks = storeReportDocuments(
        f.db,
        report.tasks,
        f.teamId,
        f.user.id,
      );
      f.db
        .prepare("UPDATE reports SET data=? WHERE id=?")
        .run(encodeReport(report), f.reportId);
      syncReportDocuments(f.db, f.reportId, report.tasks);
    }),
  );
  const counts = [],
    observer = ({ reportId }) => counts.push(reportId),
    diagnostic = channel("graeboard.sync.report.decode");
  diagnostic.subscribe(observer);
  t.after(() => diagnostic.unsubscribe(observer));
  const actualDecodes = [],
    decoded = channel("graeboard.report.decode"),
    countDecode = (sample) => actualDecodes.push(sample);
  decoded.subscribe(countDecode);
  t.after(() => decoded.unsubscribe(countDecode));
  const source = { ...emptyState(), entities: allEntities(f.db, f.link) };
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
  const service = new ReportBusinessService(
    f.app.locals.reportRepository,
    f.user,
  );
  const first = service.read(f.reportId);
  actualDecodes.length = 0;
  await service.edit(f.reportId, editRequest(f, first, "1000-row edit"));
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
    pending[0].changes.filter((c) => c.entity === "reportCell").length,
    1,
  );
  assert.ok(!pending[0].changes.some((c) => c.entity === "report"));
  assert.ok(Buffer.byteLength(canonical(pending[0])) < 5000);
  assert.equal(getTask(f.db, f.taskId).cells.title.value, "initial");
  counts.length = 0;
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.db
          .prepare("UPDATE reports SET name='rolled back' WHERE id=?")
          .run(f.reportId);
        throw new Error("rollback fixture");
      }),
    /rollback fixture/,
  );
  assert.equal(counts.length, 1);
  counts.length = 0;
  const second = service.read(f.reportId);
  actualDecodes.length = 0;
  await service.edit(f.reportId, editRequest(f, second, "after rollback"));
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
    applicationEntities(result.entities)[entityId("report", [f.reportId])]
      .payload.name,
    "Contract report",
  );
});

test("A6 v2 Unicode, deletion and same-position insertion rules are deterministic", () => {
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
    assert.equal(mergeMarkdown(base, current, desired, 2), expected);
    assert.equal(mergeMarkdown(base, desired, current, 2), expected);
  }
});

test("A3 v2 logical transfer preserves canonical children and exports the established report view", async (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(f.state);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
  f.db.syncCapture.refresh();
  const service = new ReportBusinessService(
      f.app.locals.reportRepository,
      f.user,
    ),
    before = service.read(f.reportId);
  await service.edit(
    f.reportId,
    editRequest(f, before, "pending transfer copy"),
  );
  const pending = f.adapter.readPending(f.teamId),
    job = await freezeTeam(f.adapter, f.teamId),
    bundle = await exportTeam(f.adapter, f.teamId, { omitJobId: job });
  const report = bundle.payload.tables.site_entities.find(
    (row) => row.entity === "report",
  );
  assert.equal(
    JSON.parse(report.payload).data.tasks[0].cells.title.value,
    "pending transfer copy",
  );
  assert.ok(
    !bundle.payload.tables.site_entities.some((row) =>
      ["protocol", "reportTask", "reportCell"].includes(row.entity),
    ),
  );
  assert.ok(
    bundle.payload.tables.sync_entities.some(
      (row) => row.entity === "reportCell",
    ),
  );
  const db = openDatabase(join(f.dir, "restored-v2.sqlite"));
  t.after(() => db.close());
  const restored = new SqliteDatabase(db);
  await importTeam(restored, bundle);
  assert.equal(stateHash(restored.readState(f.teamId)), stateHash(state));
  assert.deepEqual(restored.readPending(f.teamId), pending);
  assert.equal(
    readEntity(db, f.teamId, "report", [f.reportId]).payload.data.tasks[0].cells
      .title.value,
    "pending transfer copy",
  );
  assert.equal(restored.readLink(f.teamId).mode, "recovery");
});

test("A3 actual Edge conflict resolution creates a v2 operation and preserves both original submissions", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const state = upgradeState(f.state),
    id = entityId("reportCell", [f.reportId, f.taskId, "title"]),
    original = state.entities[id];
  const edit = (value) =>
    makeOperation({
      link: { ...f.link, protocol: 2 },
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
  assert.equal(pending[0].protocol, 2);
  assert.equal(pending[0].reducer, 2);
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
