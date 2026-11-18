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
import { DocumentBusinessService } from "../../server/storage/documents/document-service.mjs";
import { allEntities } from "../../server/sync/node/entities.mjs";
import { entityId } from "../../server/sync/core/protocol.mjs";
import { reduceMany } from "../../server/sync/core/reducer.mjs";

// The internal site numbers a copy's documents by their place in the copy's
// list. Shared state keeps the title and position the writing site sent; an
// external copy has held position 2 for the first document of a row. Deleting
// such a copy here sent a base with the local numbers, the reducer recorded
// "Delete conflicts with edit" and the copy came back on the next receive.
// A copy row with documents "first" and "second" in that list order, whose
// shared state holds position 2 for "first" and 0 for "second".
function sharedOrderCopy(t) {
  const f = sqliteFixture(t),
    documentKey = (id) => ["sheetClone", f.sheetCloneId, f.taskId, id];
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      const data = decodeSheetClone(
          f.db
            .prepare("SELECT data FROM sheet_clones WHERE id=?")
            .get(f.sheetCloneId).data,
        ),
        documents = ["first", "second"].map((title) => ({
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
  const [first, second] = decodeSheetClone(
    f.db.prepare("SELECT data FROM sheet_clones WHERE id=?").get(f.sheetCloneId)
      .data,
  ).tasks[0].documents.map((document) => document.id);
  // Shared state as the external site wrote it: the list order differs.
  const state = { ...f.state, entities: allEntities(f.db, f.link) },
    shared = { [first]: 2, [second]: 0 };
  for (const [id, position] of Object.entries(shared)) {
    const key = entityId("document", documentKey(id));
    assert.equal(state.entities[key].payload.position, id === first ? 0 : 1);
    state.entities[key] = {
      ...state.entities[key],
      payload: { ...state.entities[key].payload, position },
    };
  }
  f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(state, f.link.canonical_head),
  );
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
  return { f, documentKey, first, second, state, shared, replay };
}

test("a copy whose shared document positions differ from its list is edited and deleted here without a conflict", async (t) => {
  const { f, documentKey, first, second, shared, replay } = sharedOrderCopy(t),
    service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    );
  // An ordinary edit of the copy does not send the local numbers as edits.
  const current = service.read(f.sheetCloneId);
  await service.edit(f.sheetCloneId, {
    operationId: randomUUID(),
    revision: current.revision,
    operations: [
      {
        kind: "cells",
        at: new Date().toISOString(),
        changes: [
          {
            taskId: f.taskId,
            key: "title",
            value: "edited",
            expectedVersion: current.tasks[0].cells.title.version,
          },
        ],
      },
    ],
  });
  let pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  assert.deepEqual(
    pending[0].changes.filter((change) => change.entity === "document"),
    [],
  );

  // The delete carries the shared title and position as its base.
  service.remove({ teamId: f.teamId, ids: [f.sheetCloneId] });
  pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 2);
  const deletion = pending[1];
  for (const [id, position] of Object.entries(shared)) {
    const change = deletion.changes.find(
      (item) =>
        item.entity === "document" &&
        item.key.join() === documentKey(id).join(),
    );
    assert.equal(change.action, "delete");
    assert.equal(change.base.position, position);
    assert.equal(change.base.title, id === first ? "first" : "second");
  }
  // Shared state applies both commands, as the reducer on either site does.
  const result = replay(pending);
  assert.equal(
    result.entities[entityId("sheetClone", [f.sheetCloneId])].deleted,
    true,
  );
  for (const id of [first, second])
    assert.equal(
      result.entities[entityId("document", documentKey(id))].deleted,
      true,
    );
});

test("renaming or moving a document of such a copy sends the new title or place over the shared base", async (t) => {
  const { f, documentKey, first, second, replay } = sharedOrderCopy(t),
    service = new DocumentBusinessService(
      f.app.locals.documentRepository,
      f.user,
    ),
    owner = {
      kind: "sheetClone",
      sheetCloneId: f.sheetCloneId,
      taskId: f.taskId,
    },
    documentChange = (operation, id) =>
      operation.changes.find(
        (item) =>
          item.entity === "document" &&
          item.key.join() === documentKey(id).join(),
      );
  await service.rename(
    { ...owner, documentId: first },
    { title: "renamed", expectedTitle: "first" },
  );
  let pending = f.adapter.readPending(f.teamId);
  const renamed = documentChange(pending.at(-1), first);
  assert.deepEqual(renamed.fields, ["title"]);
  assert.equal(renamed.base.position, 2);
  assert.equal(renamed.desired.position, 2);
  assert.equal(renamed.desired.title, "renamed");
  assert.equal(documentChange(pending.at(-1), second), undefined);
  await service.reorder(owner, {
    ids: [second, first],
    expectedIds: [first, second],
  });
  pending = f.adapter.readPending(f.teamId);
  const moved = pending.at(-1);
  assert.equal(documentChange(moved, first).base.position, 2);
  assert.equal(documentChange(moved, first).base.title, "renamed");
  assert.equal(documentChange(moved, first).desired.position, 1);
  // "second" is first in the list now; its shared position 0 already says so.
  assert.equal(documentChange(moved, second), undefined);
  const result = replay(pending);
  const position = (id) =>
    result.entities[entityId("document", documentKey(id))].payload.position;
  assert.ok(position(second) < position(first));
  assert.equal(
    result.entities[entityId("document", documentKey(first))].payload.title,
    "renamed",
  );
});
