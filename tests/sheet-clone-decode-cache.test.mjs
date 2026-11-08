import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteFixture } from "./business-storage-fixture.mjs";
import { transaction } from "../server/db.mjs";
import {
  encodeSheetClone,
  decodeSheetClone,
  withSheetCloneDecodeCache,
} from "../server/sheet-clones.mjs";
import {
  readSheetClone,
  sheetCloneDocumentContents,
  storeDocumentVersion,
} from "../server/document-storage.mjs";
import { prepareSheetCloneEdits } from "../server/storage/sheet-clone-command-rules.mjs";
import { SheetCloneBusinessService } from "../server/storage/sheet-clone-service.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import { unpackSheetCloneData } from "../shared/sheet-clones/sheet-clone-sync-data.js";

const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test("scoped decoded sheetClone bytes never cache owner-specific document references or mutate shared input", async (t) => {
  const f = sqliteFixture(t),
    otherId = randomUUID(),
    original = decodeSheetClone(
      f.db
        .prepare("SELECT data FROM sheet_clones WHERE id=?")
        .get(f.sheetCloneId).data,
    );
  let bytes, firstVersion;
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      firstVersion = storeDocumentVersion(f.db, {
        teamId: f.teamId,
        documentId: "shared",
        markdown: "first sheetClone body",
        actorId: f.user.id,
      });
      const secondVersion = storeDocumentVersion(f.db, {
        teamId: f.teamId,
        documentId: "shared",
        markdown: "second sheetClone body",
        actorId: f.user.id,
      });
      bytes = encodeSheetClone({
        ...original,
        tasks: original.tasks.map((task) => ({
          ...task,
          documents: [{ id: "shared", title: "Body", versionId: firstVersion }],
        })),
      });
      f.db
        .prepare("UPDATE sheet_clones SET data=? WHERE id=?")
        .run(bytes, f.sheetCloneId);
      f.db
        .prepare(
          "INSERT INTO sheet_clones SELECT ?,team_id,year,'other copy',reference_date,created_by,created_at,data FROM sheet_clones WHERE id=?",
        )
        .run(otherId, f.sheetCloneId);
      for (const [sheetCloneId, version] of [
        [f.sheetCloneId, firstVersion],
        [otherId, secondVersion],
      ])
        f.db
          .prepare("INSERT INTO sheet_clone_documents VALUES(?,?,?,?)")
          .run(sheetCloneId, f.taskId, "shared", version);
    }),
  );
  const rowA = f.db
      .prepare("SELECT * FROM sheet_clones WHERE id=?")
      .get(f.sheetCloneId),
    rowB = f.db.prepare("SELECT * FROM sheet_clones WHERE id=?").get(otherId);
  let shared;
  withSheetCloneDecodeCache(() => {
    shared = freeze(decodeSheetClone(bytes));
    assert.strictEqual(decodeSheetClone(Buffer.from(bytes)), shared);
    const before = canonical(shared),
      first = readSheetClone(f.db, rowA),
      second = readSheetClone(f.db, rowB);
    assert.equal(
      sheetCloneDocumentContents(f.db, first).tasks[0].documents[0].markdown,
      "first sheetClone body",
    );
    assert.equal(
      sheetCloneDocumentContents(f.db, second).tasks[0].documents[0].markdown,
      "second sheetClone body",
    );
    const prepared = prepareSheetCloneEdits({
      sheetClone: first,
      operations: [
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [{ taskId: f.taskId, key: "title", value: "changed" }],
        },
      ],
      teamId: f.teamId,
      year: 2026,
      actorId: f.user.id,
    });
    const changed = encodeSheetClone({ ...first, tasks: prepared.tasks });
    assert.equal(
      decodeSheetClone(changed).tasks[0].cells.title.value,
      "changed",
    );
    assert.equal(second.tasks[0].cells.title.value, "initial");
    assert.equal(canonical(shared), before);
    assert.equal(shared.tasks[0].documents[0].versionId, firstVersion);
  });
  assert.notStrictEqual(decodeSheetClone(bytes), shared);
  withSheetCloneDecodeCache(() =>
    assert.notStrictEqual(decodeSheetClone(bytes), shared),
  );
  let failed;
  assert.throws(
    () =>
      withSheetCloneDecodeCache(() => {
        failed = decodeSheetClone(bytes);
        throw new Error("failed scope");
      }),
    /failed scope/,
  );
  withSheetCloneDecodeCache(() =>
    assert.notStrictEqual(decodeSheetClone(bytes), failed),
  );
  withSheetCloneDecodeCache(() => {
    const outer = decodeSheetClone(bytes);
    withSheetCloneDecodeCache(() =>
      assert.notStrictEqual(decodeSheetClone(bytes), outer),
    );
    assert.strictEqual(decodeSheetClone(bytes), outer);
  });
  let scheduledSource;
  const later = await new Promise((resolve) =>
    withSheetCloneDecodeCache(() => {
      scheduledSource = decodeSheetClone(bytes);
      setImmediate(() =>
        resolve([decodeSheetClone(bytes), decodeSheetClone(bytes)]),
      );
    }),
  );
  assert.notStrictEqual(
    later[0],
    scheduledSource,
    "scheduled sync callbacks cannot inherit reusable data from a completed edit",
  );
  assert.notStrictEqual(
    later[0],
    later[1],
    "a closed inherited scope cannot create a new memo either",
  );
});

test("failed ordinary sheetClone edit discards both decoded after-images and transaction writes before the next request", async (t) => {
  const f = sqliteFixture(t),
    service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    ),
    before = service.read(f.sheetCloneId);
  const edit = (sheetClone, value) => ({
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
  const original = f.db
    .prepare("SELECT data FROM sheet_clones WHERE id=?")
    .get(f.sheetCloneId).data;
  const failure = t.mock.method(f.db.syncCapture, "flush", () => {
    throw new Error("capture rollback");
  });
  await assert.rejects(
    async () => service.edit(f.sheetCloneId, edit(before, "discarded edit")),
    /capture rollback/,
  );
  failure.mock.restore();
  assert.deepEqual(
    f.db.prepare("SELECT data FROM sheet_clones WHERE id=?").get(f.sheetCloneId)
      .data,
    original,
  );
  assert.equal(f.adapter.readPending(f.teamId).length, 0);
  const current = service.read(f.sheetCloneId);
  assert.equal(current.tasks[0].cells.title.value, "initial");
  const result = await service.edit(
    f.sheetCloneId,
    edit(current, "saved next request"),
  );
  assert.equal(result.tasks[0].cells.title.value, "saved next request");
  const pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  // The command carries the sheetClone data in the shared-dictionary storage form.
  assert.equal(
    unpackSheetCloneData(
      pending[0].changes.find((change) => change.entity === "sheetClone").base
        .data,
    ).tasks[0].cells.title.value,
    "initial",
  );
  assert.equal(
    f.db
      .prepare("SELECT payload FROM sync_outbox WHERE op_id=?")
      .get(pending[0].opId).payload,
    canonical(pending[0]),
  );
});
