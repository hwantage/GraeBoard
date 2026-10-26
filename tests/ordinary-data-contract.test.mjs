import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../server/storage/postgres-tasks.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { PostgresDocumentRepository } from "../server/storage/postgres-documents.mjs";
import { HistoryBusinessService } from "../server/storage/history-service.mjs";
import { PostgresHistoryRepository } from "../server/storage/postgres-history.mjs";
import { DocumentBrowserBusinessService } from "../server/storage/document-browser-service.mjs";
import { PostgresDocumentBrowserRepository } from "../server/storage/postgres-document-browser.mjs";
import { TransferBusinessService } from "../server/storage/transfer-service.mjs";
import { PostgresTransferRepository } from "../server/storage/postgres-transfer.mjs";
import { createApp } from "../server/app.mjs";
import { getTask } from "../server/db.mjs";
import { unpack } from "../shared/compact.js";
import { materialize } from "../worker/materialize.mjs";
const decoded = (value) => value.data || unpack(JSON.parse(value.encoded.body));
const taskCommand = (taskId, value, expectedVersion) => ({
  operationId: randomUUID(),
  createdAt: new Date().toISOString(),
  changes: [{ taskId, key: "title", value, expectedVersion }],
});
const documentCommand = (markdown, expectedRevision) => ({
  operationId: randomUUID(),
  markdown,
  expectedRevision,
});
const rejected = (work, status) =>
  assert.rejects(Promise.resolve().then(work), (e) => e.status === status);
async function workbook(title = "Imported task") {
  const wb = new ExcelJS.Workbook(),
    sheet = wb.addWorksheet("Imported");
  sheet.addRow(["업무", "담당자", "진척률"]);
  sheet.addRow([title, "Contract", "37%"]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
async function contract({
  f,
  tasks,
  documents,
  history,
  browser,
  transfer,
  counts,
  failOnce,
  exclude,
}) {
  const scope = { kind: "task", taskId: f.taskId, documentId: "main" },
    owner = { teamId: f.teamId, year: 2026 };
  const current = await documents.read(scope);
  await documents.save(
    scope,
    documentCommand(
      "# Notes\n\n[link](https://example.test)",
      current.revision,
    ),
  );
  const initial = decoded(
    await tasks.query({ ...owner, year: "2026" }),
  ).tasks.find((t) => t.id === f.taskId);
  const changed = await tasks.saveBatch(
    taskCommand(f.taskId, "History title", initial.cells.title.version),
  );
  const entries = (
    await history.query({
      ...owner,
      taskId: f.taskId,
      sheetId: "original",
      limit: 1,
    })
  ).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "cells");
  const versions = { [`${f.taskId}:title`]: changed.cells[0].version },
    before = await counts();
  await rejected(
    () =>
      history.restore(entries[0].id, {
        versions: { [`${f.taskId}:title`]: 0 },
      }),
    409,
  );
  assert.deepEqual(await counts(), before);
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() => history.restore(entries[0].id, { versions })),
    /injected ordinary failure/,
  );
  assert.deepEqual(await counts(), before);
  const restored = await history.restore(entries[0].id, { versions });
  assert.equal(restored.cells[0].value, "initial");
  assert.equal((await counts()).pending, before.pending + 1);
  const sources = await browser.query("sources", owner);
  assert.equal(sources.sources.find((s) => s.id === "live").documentCount, 1);
  const page = await browser.query("tasks", {
    ...owner,
    source: "live",
    q: "init",
    limit: 1,
    groupBy: "owner",
  });
  assert.equal(page.taskCount, 1);
  assert.equal(page.tasks[0].documents[0].preview, "Notes link");
  assert.equal(page.nextOffset, null);
  assert.equal(
    (
      await browser.query("task", {
        ...owner,
        source: "live",
        taskId: f.taskId,
      })
    ).task.id,
    f.taskId,
  );
  const exported = await transfer.export({
    ...owner,
    scope: "all",
    format: "json",
  });
  assert.equal(exported.contentType, "application/json");
  const backup = unpack(JSON.parse(exported.body));
  assert.equal(
    backup.tasks[0].documents[0].markdown,
    "# Notes\n\n[link](https://example.test)",
  );
  const bytes = await workbook(),
    preview = await transfer.preview({
      ...owner,
      file: { name: "import.xlsx", bytes },
    });
  assert.equal(preview.sheets[0].count, 1);
  assert.equal(preview.personMap.Contract, f.user.id);
  const exceptions = await transfer.exceptions(preview.id);
  assert.equal(JSON.parse(exceptions.body).filename, "import.xlsx");
  const apply = {
    sheet: preview.sheets[0].name,
    year: 2026,
    personMap: preview.personMap,
    mode: "tasks",
    referenceDate: "2026-10-01",
    acceptWarnings: true,
  };
  const beforeApply = await counts();
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() => transfer.apply(preview.id, apply)),
    /injected ordinary failure/,
  );
  assert.deepEqual(await counts(), beforeApply);
  const applied = await transfer.apply(preview.id, apply);
  assert.equal(applied.count, 1);
  const afterApply = await counts();
  assert.equal(afterApply.pending, beforeApply.pending + 1);
  assert.equal((await transfer.apply(preview.id, apply)).count, 1);
  assert.deepEqual(await counts(), afterApply);
  assert.equal(
    decoded(await tasks.query({ ...owner, year: "2026" })).tasks.length,
    2,
  );
  await exclude(true);
  assert.deepEqual((await browser.query("sources", owner)).sources, []);
  assert.equal(
    (await browser.query("tasks", { ...owner, source: "live" })).taskCount,
    0,
  );
  const hiddenExport = unpack(
    JSON.parse(
      (await transfer.export({ ...owner, scope: "all", format: "json" })).body,
    ),
  );
  assert.deepEqual(hiddenExport.tasks, []);
  assert.deepEqual(hiddenExport.reports, []);
  await rejected(() => transfer.apply(preview.id, apply), 409);
  await rejected(
    () =>
      transfer.preview({
        teamId: f.teamId,
        year: 2026,
        file: { name: "retained.xlsx", bytes },
      }),
    409,
  );
  await exclude(false);
  return { bytes, preview, apply };
}

test("M6 ordinary history/browser/transfer services use SQLite transactions and shared import/search policies", async (t) => {
  const f = sqliteFixture(t),
    tasks = new TaskBusinessService(f.app.locals.taskRepository, f.user),
    documents = new DocumentBusinessService(
      f.app.locals.documentRepository,
      f.user,
    ),
    history = new HistoryBusinessService(
      f.app.locals.historyRepository,
      f.user,
    ),
    browser = new DocumentBrowserBusinessService(
      f.app.locals.documentBrowserRepository,
      f.user,
    ),
    transfer = new TransferBusinessService(
      f.app.locals.transferRepository,
      f.user,
    );
  const counts = () => ({
    pending: f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
    audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    operations: f.db.prepare("SELECT COUNT(*) n FROM operations").get().n,
    imports: f.db
      .prepare("SELECT id,applied_at,result FROM imports ORDER BY id")
      .all(),
  });
  await contract({
    f,
    tasks,
    documents,
    history,
    browser,
    transfer,
    counts,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected ordinary failure");
      };
    },
    exclude(enabled) {
      f.adapter.withTeamTransaction(f.teamId, (tx) => {
        if (enabled)
          tx.sync.putExclusion({
            siteId: f.link.installation_id,
            kind: "year",
            key: ["2026"],
            revision: 1,
            createdAt: new Date().toISOString(),
          });
        else
          f.db
            .prepare("DELETE FROM site_retention WHERE team_id=?")
            .run(f.teamId);
      });
    },
  });
  assert.equal(history.query({ teamId: f.teamId }) instanceof Promise, false);
  assert.equal(
    browser.query("sources", { teamId: f.teamId, year: 2026 }) instanceof
      Promise,
    false,
  );
});

test("M6 same history/browser/transfer contract uses PostgreSQL; Node injected PG-only HTTP query/export/import remains on PG", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  let fail = false;
  const context = (user) => {
    const ctx = f.makeContext(user),
      data = ctx.data.bind(ctx);
    ctx.data = (teamId, work, options) =>
      data(
        teamId,
        async (s) => {
          const result = await work(s);
          if (fail && options?.write) {
            fail = false;
            const capture = s.capture.bind(s);
            s.capture = async (actor) => {
              await capture(actor);
              throw new Error("injected ordinary failure");
            };
          }
          return result;
        },
        options,
      );
    return ctx;
  };
  const make = {
    task: (user) => new PostgresTaskRepository({ context: context(user) }),
    document: (user) =>
      new PostgresDocumentRepository({ context: context(user) }),
    history: (user) =>
      new PostgresHistoryRepository({ context: context(user) }),
    browser: (user) =>
      new PostgresDocumentBrowserRepository({ context: context(user) }),
    transfer: (user) =>
      new PostgresTransferRepository({ context: context(user) }),
  };
  const tasks = new TaskBusinessService(make.task(f.user), f.user),
    documents = new DocumentBusinessService(make.document(f.user), f.user),
    history = new HistoryBusinessService(make.history(f.user), f.user),
    browser = new DocumentBrowserBusinessService(make.browser(f.user), f.user),
    transfer = new TransferBusinessService(make.transfer(f.user), f.user);
  const counts = async () => ({
    pending: Number(
      (await f.pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox"))
        .rows[0].n,
    ),
    audit: Number(
      (await f.pool.query("SELECT COUNT(*) n FROM graeboard.site_audit"))
        .rows[0].n,
    ),
    operations: Number(
      (await f.pool.query("SELECT COUNT(*) n FROM graeboard.site_operations"))
        .rows[0].n,
    ),
    events: Number(
      (await f.pool.query("SELECT COUNT(*) n FROM graeboard.site_events"))
        .rows[0].n,
    ),
    imports: (
      await f.pool.query(
        "SELECT entity_key,payload FROM graeboard.site_entities WHERE entity='import' ORDER BY entity_key",
      )
    ).rows,
  });
  const result = await contract({
    f,
    tasks,
    documents,
    history,
    browser,
    transfer,
    counts,
    failOnce() {
      fail = true;
    },
    exclude: (enabled) =>
      f.adapter.withTeamTransaction(f.teamId, async (tx) => {
        if (enabled)
          await tx.sync.putExclusion({
            siteId: f.link.installation_id,
            kind: "year",
            key: ["2026"],
            revision: 1,
            createdAt: new Date().toISOString(),
          });
        else
          await tx.query("DELETE FROM site_retention WHERE team_id=$1", [
            f.teamId,
          ]);
        await materialize(tx, f.teamId, {
          state: await tx.sync.readState(),
          pending: await tx.sync.readPending(),
          exclusions: await tx.sync.readExclusions(),
        });
      }),
  });
  f.db.syncCapture.without(() => {
    f.db.prepare("DELETE FROM cells WHERE task_id=?").run(f.taskId);
    f.db.prepare("DELETE FROM tasks WHERE id=?").run(f.taskId);
  });
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.user.id);
  const app = createApp({
      db: f.db,
      rateLimits: false,
      historyRepository: make.history,
      browserRepository: make.browser,
      transferRepository: make.transfer,
      syncOptions: { schedule: false, installationId: f.link.installation_id },
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.documentEvents.close();
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = {
      Cookie: "weekly_session=" + f.user.id,
      "X-Requested-With": "WeeklyPlan",
    },
    read = async (path, body) => {
      const r = await fetch(origin + "/api" + path, {
        headers: { ...headers, "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return unpack(await r.json());
    };
  const beforeHTTP = decoded(
    await tasks.query({ teamId: f.teamId, year: "2026" }),
  ).tasks.find((t) => t.id === f.taskId);
  const editedHTTP = await tasks.saveBatch(
    taskCommand(
      f.taskId,
      "HTTP history target",
      beforeHTTP.cells.title.version,
    ),
  );
  const historyHTTP = (
    await read(`/audit?teamId=${f.teamId}&taskId=${f.taskId}&limit=1`)
  ).entries[0];
  assert.equal(
    (
      await read(`/audit/${historyHTTP.id}/restore`, {
        versions: { [`${f.taskId}:title`]: editedHTTP.cells[0].version },
      })
    ).cells[0].value,
    beforeHTTP.cells.title.value,
  );
  assert.equal(
    (
      await read(
        `/document-browser/task?teamId=${f.teamId}&year=2026&source=live&taskId=${f.taskId}`,
      )
    ).task.id,
    f.taskId,
  );
  assert.ok(
    (
      await read("/export", {
        teamId: f.teamId,
        year: 2026,
        format: "json",
        scope: "all",
      })
    ).tasks.some((t) => t.id === f.taskId),
  );
  const form = new FormData();
  form.set("teamId", f.teamId);
  form.set("year", "2026");
  form.set(
    "file",
    new Blob([await workbook("Node imported task")]),
    "import.xlsx",
  );
  const preview = await fetch(origin + "/api/import/preview", {
    method: "POST",
    headers,
    body: form,
  });
  assert.equal(preview.status, 200, await preview.clone().text());
  const httpPreview = await preview.json();
  assert.notEqual(httpPreview.id, result.preview.id);
  assert.equal(
    (
      await read(`/import/${httpPreview.id}/apply`, {
        ...result.apply,
        personMap: httpPreview.personMap,
      })
    ).count,
    1,
  );
  assert.ok(
    decoded(await tasks.query({ teamId: f.teamId, year: "2026" })).tasks.some(
      (row) => row.cells.title.value === "Node imported task",
    ),
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM imports").get().n, 0);
  assert.equal(getTask(f.db, f.taskId), null);
});
