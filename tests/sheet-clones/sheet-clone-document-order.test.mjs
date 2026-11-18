import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteFixture } from "../support/business-storage-fixture.mjs";
import { transaction } from "../../server/db.mjs";
import {
  decodeSheetClone,
  encodeSheetClone,
} from "../../server/sheet-clones/sheet-clones.mjs";
import { storeDocumentVersion } from "../../server/documents/document-storage.mjs";
import { SheetCloneBusinessService } from "../../server/storage/sheet-clones/sheet-clone-service.mjs";
import { allEntities } from "../../server/sync/node/entities.mjs";
import {
  entityId,
  ROW_PROTOCOL,
  SPLIT_PROTOCOL,
} from "../../server/sync/core/protocol.mjs";
import { reduceMany } from "../../server/sync/core/reducer.mjs";
import { upgradeState } from "../../server/sync/core/versions.mjs";
import { normalizeSheetCloneDocumentOrder } from "../../scripts/sync/sync-sheet-clone-document-order.mjs";

// A copy the external site made before 2026-11-18: the row lists documents
// one, two, three, while shared state holds positions 4, 0 and 2, so the
// external site shows two, three, one.
function externalCopy(t, protocol = ROW_PROTOCOL) {
  const f = sqliteFixture(t),
    documentKey = (id) => ["sheetClone", f.sheetCloneId, f.taskId, id],
    localList = () =>
      decodeSheetClone(
        f.db
          .prepare("SELECT data FROM sheet_clones WHERE id=?")
          .get(f.sheetCloneId).data,
      )
        .tasks.find((task) => task.id === f.taskId)
        .documents.map((document) => document.id);
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      const data = decodeSheetClone(
          f.db
            .prepare("SELECT data FROM sheet_clones WHERE id=?")
            .get(f.sheetCloneId).data,
        ),
        documents = ["one", "two", "three"].map((title) => ({
          id: randomUUID(),
          title,
          versionId: storeDocumentVersion(f.db, {
            teamId: f.teamId,
            documentId: randomUUID(),
            markdown: title + " body",
            actorId: f.user.id,
          }),
        }));
      f.db.prepare("UPDATE sheet_clones SET data=? WHERE id=?").run(
        encodeSheetClone({
          ...data,
          tasks: data.tasks.map((task) => ({ ...task, documents })),
        }),
        f.sheetCloneId,
      );
      for (const document of documents)
        f.db
          .prepare("INSERT INTO sheet_clone_documents VALUES(?,?,?,?)")
          .run(f.sheetCloneId, f.taskId, document.id, document.versionId);
    }),
  );
  const [one, two, three] = localList(),
    positions = { [one]: 4, [two]: 0, [three]: 2 };
  let state = { ...f.state, entities: allEntities(f.db, f.link) };
  for (const [id, position] of Object.entries(positions)) {
    const key = entityId("document", documentKey(id));
    state.entities[key] = {
      ...state.entities[key],
      payload: { ...state.entities[key].payload, position },
    };
  }
  if (protocol !== 3) state = upgradeState(state, protocol);
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
  // Capture reads the team's protocol with its links.
  f.db.syncCapture.refresh();
  const replay = (pending) => {
    const result = reduceMany(state, pending, {
      teamId: f.teamId,
      repoId: f.link.repo_id,
    });
    for (const operation of pending)
      assert.equal(
        result.receipts[operation.opId].result,
        "applied",
        JSON.stringify(result.conflicts[operation.opId]?.reason),
      );
    return result;
  };
  return { f, documentKey, localList, one, two, three, replay };
}

for (const protocol of [SPLIT_PROTOCOL, ROW_PROTOCOL])
  test(`protocol ${protocol}: an external copy's row is listed and numbered in its shared tab order once`, (t) => {
    const { f, documentKey, localList, one, two, three, replay } = externalCopy(
      t,
      protocol,
    );
    const run = (dryRun) =>
      normalizeSheetCloneDocumentOrder({
        db: f.db,
        teamId: f.teamId,
        dryRun,
      });
    const found = {
      teamId: f.teamId,
      sheetClones: 1,
      rows: 1,
      // "two" keeps position 0; "three" and "one" become 1 and 2.
      documents: 2,
      lists: 1,
      skipped: [],
    };
    // A dry run reports and writes nothing.
    assert.deepEqual(run(true), { ...found, enqueued: false });
    assert.equal(f.adapter.readPending(f.teamId).length, 0);
    assert.deepEqual(localList(), [one, two, three]);

    assert.deepEqual(run(false), { ...found, enqueued: true });
    const pending = f.adapter.readPending(f.teamId);
    assert.equal(pending.length, 1);
    // Only the order changes: titles and bodies are not part of it.
    for (const change of pending[0].changes)
      assert.deepEqual(
        change.fields,
        change.entity === "document" ? ["position"] : ["data"],
      );
    assert.deepEqual(localList(), [two, three, one]);
    // Shared state takes it as the reducer on either site does.
    const result = replay(pending);
    const position = (id) =>
      result.entities[entityId("document", documentKey(id))].payload.position;
    assert.deepEqual([two, three, one].map(position), [0, 1, 2]);
    assert.deepEqual(
      result.entities[
        entityId("sheetCloneTask", [f.sheetCloneId, f.taskId])
      ].payload.data.documents.map((document) => document.id),
      [two, three, one],
    );
    // The internal copy now reads as shared state holds it, so later edits
    // start from the same values.
    const local = allEntities(f.db, f.link);
    for (const id of [one, two, three]) {
      const key = entityId("document", documentKey(id));
      assert.equal(
        local[key].payload.position,
        result.entities[key].payload.position,
      );
    }
    // A rerun, also before publishing, finds nothing.
    assert.deepEqual(run(false), {
      ...found,
      sheetClones: 0,
      rows: 0,
      documents: 0,
      lists: 0,
      enqueued: false,
    });
    // The tool runs with the server stopped; starting it reads the queued
    // operation, so a later change of these documents starts from it.
    f.db.syncCapture.refresh();
    // Deleting the copy here is then applied.
    new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    ).remove({ teamId: f.teamId, ids: [f.sheetCloneId] });
    const deleted = replay(f.adapter.readPending(f.teamId));
    assert.equal(
      deleted.entities[entityId("sheetClone", [f.sheetCloneId])].deleted,
      true,
    );
  });

test("a team still on protocol 3 is refused, as reordering would send whole copies", (t) => {
  const { f } = externalCopy(t, 3);
  assert.throws(
    () => normalizeSheetCloneDocumentOrder({ db: f.db, teamId: f.teamId }),
    /protocol 3; run this after protocol 4/,
  );
  assert.equal(f.adapter.readPending(f.teamId).length, 0);
});
