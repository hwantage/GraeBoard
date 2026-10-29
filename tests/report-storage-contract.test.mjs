import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { PostgresDocumentRepository } from "../worker/storage/postgres-documents.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { ReportBusinessService } from "../server/storage/report-service.mjs";
import { PostgresReportRepository } from "../worker/storage/postgres-reports.mjs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
const reject = (work, status) =>
  assert.rejects(
    Promise.resolve().then(work),
    (error) => error.status === status,
  );
async function contract({ f, service, documents, counts, failOnce }) {
  const input = {
    id: randomUUID(),
    teamId: f.teamId,
    year: 2026,
    name: "contract report",
    referenceDate: "2026-10-01",
    view: defaultView(2026),
    taskIds: [f.taskId],
  };
  await reject(
    () => service.create({ ...input, view: defaultView(2025) }),
    400,
  );
  const created = await service.create(input);
  assert.equal(created.id, input.id);
  let after = await counts();
  await service.create(input);
  assert.deepEqual(await counts(), after, "create retry adds no P/audit");
  await reject(
    () => service.create({ ...input, referenceDate: "2026-10-02" }),
    409,
  );
  assert.deepEqual(await counts(), after);
  assert.ok(
    (await service.list({ teamId: f.teamId })).reports.some(
      (row) => row.id === input.id,
    ),
  );
  const report = await service.read(input.id);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].cells.title.value, "initial");
  await service.rename(input.id, { name: "renamed", expectedName: input.name });
  const beforeEdit = await service.read(input.id),
    edit = {
      operationId: randomUUID(),
      revision: beforeEdit.revision,
      operations: [
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [
            {
              taskId: f.taskId,
              key: "title",
              value: "edited",
              expectedVersion: beforeEdit.tasks[0].cells.title.version,
            },
          ],
        },
      ],
    };
  const saved = await service.edit(input.id, edit);
  assert.equal(saved.tasks[0].cells.title.value, "edited");
  after = await counts();
  await service.edit(input.id, edit);
  assert.deepEqual(await counts(), after, "edit replay is atomic");
  await reject(
    () => service.edit(input.id, { ...edit, operationId: randomUUID() }),
    409,
  );
  assert.deepEqual(
    await counts(),
    after,
    "stale edit leaves report/P/audit unchanged",
  );
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.rename(input.id, { name: "rollback", expectedName: "renamed" }),
    ),
    /injected storage failure/,
  );
  assert.deepEqual(
    await counts(),
    after,
    "postcapture failure rolls back business and P/audit",
  );
  assert.equal((await service.read(input.id)).name, "renamed");
  const scope = {
    kind: "report",
    reportId: input.id,
    taskId: f.taskId,
    documentId: "main",
  };
  const oldDocument = await documents.read(scope);
  await documents.save(scope, {
    markdown: "copy this report body",
    expectedRevision: oldDocument.revision,
    operationId: randomUUID(),
  });
  let current = await service.read(input.id);
  const copiedId = randomUUID();
  current = await service.edit(input.id, {
    revision: current.revision,
    operationId: randomUUID(),
    operations: [
      {
        kind: "create",
        at: new Date().toISOString(),
        taskId: copiedId,
        sourceId: f.taskId,
        fields: {},
      },
    ],
  });
  assert.equal(
    (await documents.read({ ...scope, taskId: copiedId })).markdown,
    "copy this report body",
    "source-row copy preserves stored document bytes",
  );
  const stored = await counts();
  const restore = {
    ...current.tasks[0],
    id: randomUUID(),
    teamId: randomUUID(),
    documents: [],
  };
  await reject(
    () =>
      service.edit(input.id, {
        revision: current.revision,
        operationId: randomUUID(),
        operations: [
          { kind: "restore", at: new Date().toISOString(), tasks: [restore] },
        ],
      }),
    400,
  );
  await reject(
    () =>
      service.edit(input.id, {
        revision: current.revision,
        operationId: randomUUID(),
        operations: [
          {
            kind: "restore",
            at: new Date().toISOString(),
            tasks: [
              {
                ...restore,
                teamId: f.teamId,
                cells: {
                  invalid_column: { value: "bad", style: {}, version: 1 },
                },
              },
            ],
          },
        ],
      }),
    400,
  );
  assert.deepEqual(
    await counts(),
    stored,
    "invalid restore cannot change report/audit/P",
  );
  const changedYear = await service.edit(input.id, {
    revision: current.revision,
    operationId: randomUUID(),
    view: defaultView(2027),
    operations: [],
  });
  assert.equal(changedYear.year, 2027);
  assert.equal(changedYear.view.year, 2027);
  return input.id;
}
test("M6 report service preserves SQLite create/edit/retry/CAS/rollback and synchronous reads", async (t) => {
  const f = sqliteBusinessFixture(t),
    service = new ReportBusinessService(f.app.locals.reportRepository, f.user);
  const counts = () => ({
    reports: f.db.prepare("SELECT id,name,data FROM reports ORDER BY id").all(),
    pending: f.db
      .prepare("SELECT payload FROM sync_outbox ORDER BY local_seq")
      .all(),
    audit: f.db.prepare("SELECT id FROM audit ORDER BY id").all(),
  });
  await contract({
    f,
    service,
    documents: new DocumentBusinessService(
      f.app.locals.documentRepository,
      f.user,
    ),
    counts,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected storage failure");
      };
    },
  });
  assert.equal(service.list({ teamId: f.teamId }) instanceof Promise, false);
});
test("M6 same report service uses PG and actual external HTTP reads report with no SQLite report mirror", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const context = pg.createContext(),
    repository = new PostgresReportRepository({ context }),
    service = new ReportBusinessService(repository, f.user);
  let fail = false;
  const data = context.data.bind(context);
  context.data = (teamId, work, options) =>
    data(
      teamId,
      async (s) => {
        const output = await work(s);
        if (fail && options?.write) {
          fail = false;
          const capture = s.capture.bind(s);
          s.capture = async (actor) => {
            await capture(actor);
            throw new Error("injected storage failure");
          };
        }
        return output;
      },
      options,
    );
  const counts = async () => ({
    reports: (
      await pg.pool.query(
        "SELECT entity_key,payload FROM graeboard.site_entities WHERE entity='report' ORDER BY entity_key",
      )
    ).rows,
    pending: (
      await pg.pool.query(
        "SELECT payload FROM graeboard.sync_outbox ORDER BY local_seq",
      )
    ).rows,
    audit: (
      await pg.pool.query("SELECT id FROM graeboard.site_audit ORDER BY id")
    ).rows,
  });
  const reportId = await contract({
    f,
    service,
    documents: new DocumentBusinessService(
      new PostgresDocumentRepository({ context: pg.createContext() }),
      f.user,
    ),
    counts,
    failOnce() {
      fail = true;
    },
  });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 0);
  const app = createExternalRouteApp({
      env: pg.env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => pg.createContext(user, request),
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await app.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/reports/${reportId}`,
    { headers: { Cookie: "weekly_session=" + f.user.id } },
  );
  assert.equal(response.status, 200);
  const body = unpack(await response.json());
  assert.equal(body.tasks[0].cells.title.value, "edited");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(
    `http://127.0.0.1:${server.address().port}/api/reports/${reportId}/events`,
    {
      headers: { Cookie: "weekly_session=" + f.user.id },
      signal: controller.signal,
    },
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  async function documentFrame() {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      let end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.includes("event: document"))
          return JSON.parse(
            frame
              .split("\n")
              .find((line) => line.startsWith("data: "))
              .slice(6),
          );
        continue;
      }
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("report SSE timeout")), 3000),
        ),
      ]);
      if (next.done) throw new Error("SSE closed");
      buffer += decoder.decode(next.value, { stream: true });
    }
    throw new Error("missing report SSE");
  }
  const first = await documentFrame();
  const renamed = await fetch(
    `http://127.0.0.1:${server.address().port}/api/reports/${reportId}/name`,
    {
      method: "PATCH",
      headers: {
        Cookie: "weekly_session=" + f.user.id,
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      body: JSON.stringify({ name: "HTTP PG report", expectedName: "renamed" }),
    },
  );
  assert.equal(renamed.status, 200, await renamed.text());
  const next = await documentFrame();
  assert.ok(
    next.revision > first.revision,
    "actual PG event reaches Node subscriber without SQLite report",
  );
  controller.abort();
});
