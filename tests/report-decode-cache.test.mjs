import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteFixture } from "./business-storage-fixture.mjs";
import { transaction } from "../server/db.mjs";
import {
  encodeReport,
  decodeReport,
  withReportDecodeCache,
} from "../server/reports.mjs";
import {
  readReport,
  reportDocumentContents,
  storeDocumentVersion,
} from "../server/document-storage.mjs";
import { prepareReportEdits } from "../server/storage/report-command-rules.mjs";
import { ReportBusinessService } from "../server/storage/report-service.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import { unpackReportData } from "../shared/report-sync-data.js";

const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test("scoped decoded report bytes never cache owner-specific document references or mutate shared input", async (t) => {
  const f = sqliteFixture(t),
    otherId = randomUUID(),
    original = decodeReport(
      f.db.prepare("SELECT data FROM reports WHERE id=?").get(f.reportId).data,
    );
  let bytes, firstVersion;
  f.db.syncCapture.without(() =>
    transaction(f.db, () => {
      firstVersion = storeDocumentVersion(f.db, {
        teamId: f.teamId,
        documentId: "shared",
        markdown: "first report body",
        actorId: f.user.id,
      });
      const secondVersion = storeDocumentVersion(f.db, {
        teamId: f.teamId,
        documentId: "shared",
        markdown: "second report body",
        actorId: f.user.id,
      });
      bytes = encodeReport({
        ...original,
        tasks: original.tasks.map((task) => ({
          ...task,
          documents: [{ id: "shared", title: "Body", versionId: firstVersion }],
        })),
      });
      f.db
        .prepare("UPDATE reports SET data=? WHERE id=?")
        .run(bytes, f.reportId);
      f.db
        .prepare(
          "INSERT INTO reports SELECT ?,team_id,year,'other copy',reference_date,created_by,created_at,data FROM reports WHERE id=?",
        )
        .run(otherId, f.reportId);
      for (const [reportId, version] of [
        [f.reportId, firstVersion],
        [otherId, secondVersion],
      ])
        f.db
          .prepare("INSERT INTO report_documents VALUES(?,?,?,?)")
          .run(reportId, f.taskId, "shared", version);
    }),
  );
  const rowA = f.db.prepare("SELECT * FROM reports WHERE id=?").get(f.reportId),
    rowB = f.db.prepare("SELECT * FROM reports WHERE id=?").get(otherId);
  let shared;
  withReportDecodeCache(() => {
    shared = freeze(decodeReport(bytes));
    assert.strictEqual(decodeReport(Buffer.from(bytes)), shared);
    const before = canonical(shared),
      first = readReport(f.db, rowA),
      second = readReport(f.db, rowB);
    assert.equal(
      reportDocumentContents(f.db, first).tasks[0].documents[0].markdown,
      "first report body",
    );
    assert.equal(
      reportDocumentContents(f.db, second).tasks[0].documents[0].markdown,
      "second report body",
    );
    const prepared = prepareReportEdits({
      report: first,
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
    const changed = encodeReport({ ...first, tasks: prepared.tasks });
    assert.equal(decodeReport(changed).tasks[0].cells.title.value, "changed");
    assert.equal(second.tasks[0].cells.title.value, "initial");
    assert.equal(canonical(shared), before);
    assert.equal(shared.tasks[0].documents[0].versionId, firstVersion);
  });
  assert.notStrictEqual(decodeReport(bytes), shared);
  withReportDecodeCache(() =>
    assert.notStrictEqual(decodeReport(bytes), shared),
  );
  let failed;
  assert.throws(
    () =>
      withReportDecodeCache(() => {
        failed = decodeReport(bytes);
        throw new Error("failed scope");
      }),
    /failed scope/,
  );
  withReportDecodeCache(() =>
    assert.notStrictEqual(decodeReport(bytes), failed),
  );
  withReportDecodeCache(() => {
    const outer = decodeReport(bytes);
    withReportDecodeCache(() =>
      assert.notStrictEqual(decodeReport(bytes), outer),
    );
    assert.strictEqual(decodeReport(bytes), outer);
  });
  let scheduledSource;
  const later = await new Promise((resolve) =>
    withReportDecodeCache(() => {
      scheduledSource = decodeReport(bytes);
      setImmediate(() => resolve([decodeReport(bytes), decodeReport(bytes)]));
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

test("failed ordinary report edit discards both decoded after-images and transaction writes before the next request", async (t) => {
  const f = sqliteFixture(t),
    service = new ReportBusinessService(f.app.locals.reportRepository, f.user),
    before = service.read(f.reportId);
  const edit = (report, value) => ({
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
  const original = f.db
    .prepare("SELECT data FROM reports WHERE id=?")
    .get(f.reportId).data;
  const failure = t.mock.method(f.db.syncCapture, "flush", () => {
    throw new Error("capture rollback");
  });
  await assert.rejects(
    async () => service.edit(f.reportId, edit(before, "discarded edit")),
    /capture rollback/,
  );
  failure.mock.restore();
  assert.deepEqual(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(f.reportId).data,
    original,
  );
  assert.equal(f.adapter.readPending(f.teamId).length, 0);
  const current = service.read(f.reportId);
  assert.equal(current.tasks[0].cells.title.value, "initial");
  const result = await service.edit(
    f.reportId,
    edit(current, "saved next request"),
  );
  assert.equal(result.tasks[0].cells.title.value, "saved next request");
  const pending = f.adapter.readPending(f.teamId);
  assert.equal(pending.length, 1);
  // The command carries the report data in the shared-dictionary storage form.
  assert.equal(
    unpackReportData(
      pending[0].changes.find((change) => change.entity === "report").base.data,
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
