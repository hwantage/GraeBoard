import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { DocumentBusinessService } from "../server/storage/documents/document-service.mjs";
import { PostgresDocumentRepository } from "../worker/storage/documents/postgres-documents.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultView } from "../shared/domain.js";
import { unpack } from "../shared/formatting/compact.js";
import { unpackSheetClonePayload } from "../shared/sheet-clones/sheet-clone-sync-data.js";
import { payloadEqual } from "../server/sync/protocol.mjs";
import { SheetCloneBusinessService } from "../server/storage/sheet-clones/sheet-clone-service.mjs";
import { bucket } from "./worker-github-fixture.mjs";
import { PostgresSheetCloneRepository } from "../worker/storage/sheet-clones/postgres-sheet-clones.mjs";
import { PostgresHistoryRepository } from "../worker/storage/postgres-history.mjs";
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
    name: "contract sheetClone",
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
    (await service.list({ teamId: f.teamId })).sheetClones.some(
      (row) => row.id === input.id,
    ),
  );
  const sheetClone = await service.read(input.id);
  assert.equal(sheetClone.tasks.length, 1);
  assert.equal(sheetClone.tasks[0].cells.title.value, "initial");
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
    "stale edit leaves sheetClone/P/audit unchanged",
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
    kind: "sheetClone",
    sheetCloneId: input.id,
    taskId: f.taskId,
    documentId: "main",
  };
  const oldDocument = await documents.read(scope);
  await documents.save(scope, {
    markdown: "copy this sheetClone body",
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
    "copy this sheetClone body",
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
    "invalid restore cannot change sheetClone/audit/P",
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
test("M6 sheetClone service preserves SQLite create/edit/retry/CAS/rollback and synchronous reads", async (t) => {
  const f = sqliteBusinessFixture(t),
    service = new SheetCloneBusinessService(
      f.app.locals.sheetCloneRepository,
      f.user,
    );
  const counts = () => ({
    sheetClones: f.db
      .prepare("SELECT id,name,data FROM sheet_clones ORDER BY id")
      .all(),
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
test("M6 same sheetClone service uses PG and actual external HTTP reads sheetClone with no SQLite sheetClone mirror", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const context = pg.createContext(),
    repository = new PostgresSheetCloneRepository({ context }),
    service = new SheetCloneBusinessService(repository, f.user);
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
    sheetClones: (
      await pg.pool.query(
        "SELECT entity_key,payload FROM graeboard.site_entities WHERE entity='sheetClone' ORDER BY entity_key",
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
  const sheetCloneId = await contract({
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
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sheet_clones").get().n, 0);
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
    `http://127.0.0.1:${server.address().port}/api/sheet-clones/${sheetCloneId}`,
    { headers: { Cookie: "weekly_session=" + f.user.id } },
  );
  assert.equal(response.status, 200);
  const body = unpack(await response.json());
  assert.equal(body.tasks[0].cells.title.value, "edited");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(
    `http://127.0.0.1:${server.address().port}/api/sheet-clones/${sheetCloneId}/events`,
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
          setTimeout(() => reject(new Error("sheetClone SSE timeout")), 3000),
        ),
      ]);
      if (next.done) throw new Error("SSE closed");
      buffer += decoder.decode(next.value, { stream: true });
    }
    throw new Error("missing sheetClone SSE");
  }
  const first = await documentFrame();
  const renamed = await fetch(
    `http://127.0.0.1:${server.address().port}/api/sheet-clones/${sheetCloneId}/name`,
    {
      method: "PATCH",
      headers: {
        Cookie: "weekly_session=" + f.user.id,
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      body: JSON.stringify({
        name: "HTTP PG sheetClone",
        expectedName: "renamed",
      }),
    },
  );
  assert.equal(renamed.status, 200, await renamed.text());
  const next = await documentFrame();
  assert.ok(
    next.revision > first.revision,
    "actual PG event reaches Node subscriber without SQLite sheetClone",
  );
  controller.abort();
});

// A copy is megabytes once unpacked (every task repeats the team's formatting
// rules), so PostgreSQL records it packed or summarized and reads it back
// whole: history still restores deleted rows and retries answer the same.
test("PG copy audit and retry records stay packed and read back whole", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const service = new SheetCloneBusinessService(
      new PostgresSheetCloneRepository({ context: pg.createContext() }),
      f.user,
    ),
    history = new PostgresHistoryRepository({ context: pg.createContext() }),
    audit = async (action) =>
      (
        await pg.pool.query(
          "SELECT id,payload FROM graeboard.site_audit WHERE action=$1 ORDER BY created_at,id",
          [action],
        )
      ).rows;
  const id = randomUUID();
  await service.create({
    id,
    teamId: f.teamId,
    year: 2026,
    name: "packed copy",
    referenceDate: "2026-10-01",
    view: defaultView(2026),
    taskIds: [f.taskId],
  });
  assert.deepEqual(
    (await audit("sheet-clone")).map((row) => JSON.parse(row.payload)),
    [
      [
        {
          entity: "sheetClone",
          key: [id],
          before: null,
          after: { name: "packed copy", count: 1 },
        },
      ],
    ],
  );
  let current = await service.read(id);
  const added = randomUUID(),
    styled = {
      revision: current.revision,
      operationId: randomUUID(),
      operations: [
        {
          kind: "create",
          at: new Date().toISOString(),
          taskId: added,
          fields: { title: "row to delete" },
        },
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [
            {
              taskId: f.taskId,
              key: "title",
              value: "styled",
              style: { bold: true },
              expectedVersion: current.tasks[0].cells.title.version,
            },
          ],
        },
      ],
    };
  const saved = await service.edit(id, styled);
  // The retry answers from the packed record exactly as the first save did.
  assert.deepEqual(await service.edit(id, styled), saved);
  const response = (
    await pg.pool.query(
      "SELECT response FROM graeboard.site_operations WHERE op_id=$1",
      [styled.operationId],
    )
  ).rows[0].response;
  assert.ok(JSON.parse(response).$styles, "the retry record is packed");
  current = await service.edit(id, {
    revision: saved.revision,
    operationId: randomUUID(),
    operations: [
      { kind: "delete", at: new Date().toISOString(), taskIds: [added] },
    ],
  });
  assert.ok(!current.tasks.some((task) => task.id === added));
  const edits = await audit("sheet-clone-edit");
  assert.ok(
    edits.every((row) =>
      JSON.parse(row.payload)
        .filter((c) => c.entity === "sheetClone")
        .every((c) => c.after.data.$styles),
    ),
    "copy edits are audited in their stored form",
  );
  const { entries } = await history.query(f.user, {
    teamId: f.teamId,
    sheetId: id,
  });
  const removal = entries.find(
    (entry) => entry.before?.deletedTasks?.[0]?.id === added,
  );
  assert.deepEqual(removal.restorableTaskIds, [added]);
  const restored = await history.restore(f.user, removal.id, {
    revision: current.revision,
  });
  assert.ok(restored.tasks.some((task) => task.id === added));
});

// Edits of one copy while nothing publishes leave one unsent operation, from
// the copy before the first edit to its latest content, instead of one copy
// per save; a held lease or another kind of change keeps them separate.
test("PG consecutive copy edits replace the last unsent edit of that copy", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const service = new SheetCloneBusinessService(
      new PostgresSheetCloneRepository({ context: pg.createContext() }),
      f.user,
    ),
    pending = async () =>
      (
        await pg.pool.query(
          "SELECT payload FROM graeboard.sync_outbox WHERE status<>'acknowledged' ORDER BY local_seq",
        )
      ).rows.map((row) => JSON.parse(row.payload)),
    sheetCloneOps = async () =>
      (await pending()).filter((op) =>
        op.changes.some((c) => c.entity === "sheetClone"),
      ),
    id = randomUUID();
  await service.create({
    id,
    teamId: f.teamId,
    year: 2026,
    name: "edited copy",
    referenceDate: "2026-10-01",
    view: defaultView(2026),
    taskIds: [f.taskId],
  });
  const title = async (value) => {
    const current = await service.read(id);
    return service.edit(id, {
      revision: current.revision,
      operationId: randomUUID(),
      operations: [
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [
            {
              taskId: f.taskId,
              key: "title",
              value,
              expectedVersion: current.tasks[0].cells.title.version,
            },
          ],
        },
      ],
    });
  };
  // The first edit also creates the copy's document, so it stays as it is.
  await title("first");
  const before = await sheetCloneOps(),
    original = before
      .at(-1)
      .changes.find((c) => c.entity === "sheetClone").desired;
  for (const value of ["second", "third", "fourth"]) await title(value);
  const ops = await sheetCloneOps();
  assert.equal(ops.length, before.length + 1, "one operation for the edits");
  const [edit] = ops.at(-1).changes;
  assert.equal(ops.at(-1).changes.length, 1);
  assert.deepEqual(edit.base, original, "from the copy before them");
  assert.equal(
    unpackSheetClonePayload(edit.desired).data.tasks[0].cells.title.value,
    "fourth",
  );
  // The merged operation reaches the stored content.
  const stored = JSON.parse(
    (
      await pg.pool.query(
        "SELECT payload FROM graeboard.site_entities WHERE entity='sheetClone' AND entity_key=$1",
        [JSON.stringify([id])],
      )
    ).rows[0].payload,
  );
  assert.ok(payloadEqual("sheetClone", edit.desired, stored));
  const lease = (owner) =>
      pg.pool.query(
        "UPDATE graeboard.team_sync_links SET lease_owner=$1,lease_until=$2",
        [owner, owner ? Date.now() + 600000 : null],
      ),
    rename = (name) =>
      pg.createContext().data(
        f.teamId,
        async (s) => {
          const row = await s.get("sheetClone", [id]);
          await s.put("sheetClone", [id], { ...row.payload, name });
        },
        { write: true, body: {}, action: "sheet-clone-rename" },
      );
  // A sync run holding the lease may have read the last row: append instead.
  await lease("run");
  await rename("renamed");
  assert.equal((await sheetCloneOps()).length, before.length + 2);
  // Undone once the run is over, the rename leaves nothing to send.
  await lease(null);
  await rename("edited copy");
  assert.equal((await sheetCloneOps()).length, before.length + 1);
});

// Autosaves of one document while nothing publishes leave one unsent
// operation, from the body before them to the latest body, as copy edits do.
// Each pending autosave carried the whole body, and dozens of them made every
// save and sync run replay and parse every body again (2026-11-03).
test("PG consecutive document autosaves replace the last unsent edit of that document", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const documents = new DocumentBusinessService(
      new PostgresDocumentRepository({ context: pg.createContext() }),
      f.user,
    ),
    task = { kind: "task", taskId: f.taskId, documentId: "main" },
    memo = {
      kind: "annual",
      teamId: f.teamId,
      year: 2026,
      documentId: randomUUID(),
    },
    pending = async () =>
      (
        await pg.pool.query(
          "SELECT payload FROM graeboard.sync_outbox WHERE status<>'acknowledged' ORDER BY local_seq",
        )
      ).rows.map((row) => JSON.parse(row.payload)),
    taskOps = async () =>
      (await pending()).filter((op) =>
        op.changes.some((c) => c.entity === "document" && c.key[0] === "task"),
      ),
    save = async (scope, markdown) =>
      documents.save(scope, {
        markdown,
        expectedRevision: (await documents.read(scope)).revision,
        operationId: randomUUID(),
      });
  // The first save creates the document, so it stays as it is.
  await save(task, "first");
  const before = (await taskOps()).length;
  for (const body of ["second", "third", "fourth"]) await save(task, body);
  let ops = await taskOps();
  assert.equal(ops.length, before + 1, "one operation for the edits");
  const [edit, ...others] = ops.at(-1).changes;
  assert.equal(others.length, 0);
  assert.equal(edit.action, "edit");
  assert.equal(edit.base.markdown, "first", "from the body before them");
  assert.equal(edit.desired.markdown, "fourth");
  // The merged operation reaches the stored body.
  assert.equal((await documents.read(task)).markdown, "fourth");
  // Another document's save in between ends the run of edits.
  await documents.create(
    { kind: "annual", teamId: f.teamId, year: 2026 },
    { id: memo.documentId, title: "메모" },
  );
  await save(memo, "memo body");
  await save(memo, "memo body edited");
  await save(task, "fifth");
  ops = await taskOps();
  assert.equal(ops.length, before + 2);
  assert.equal(ops.at(-1).changes[0].base.markdown, "fourth");
  const memoEdits = (await pending()).filter((op) =>
    op.changes.some((c) => c.entity === "document" && c.key[0] === "annual"),
  );
  assert.equal(
    memoEdits.at(-1).changes[0].desired.markdown,
    "memo body edited",
  );
  const lease = (owner) =>
    pg.pool.query(
      "UPDATE graeboard.team_sync_links SET lease_owner=$1,lease_until=$2",
      [owner, owner ? Date.now() + 600000 : null],
    );
  // A sync run holding the lease may have read the last row: append instead.
  // So does an expired lease: the stopped run may have published that row.
  await lease("run");
  await save(task, "leased");
  assert.equal((await taskOps()).length, before + 3);
  await pg.pool.query("UPDATE graeboard.team_sync_links SET lease_until=$1", [
    Date.now() - 1000,
  ]);
  await save(task, "expired");
  assert.equal((await taskOps()).length, before + 4);
  // Undone once the run is over, the edit leaves nothing to send.
  await lease(null);
  await save(task, "leased");
  assert.equal((await taskOps()).length, before + 3);
  assert.equal((await documents.read(task)).markdown, "leased");
});

// A copy repeats the source documents as they are: an image the store lacks
// is shown as missing in the copy too, and never stops the copy.
test("PG copy creation goes on when the image store lacks an image", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  pg.env.BUCKET = bucket();
  const missing = `/api/document-images/${f.teamId}/${"a".repeat(64)}.webp`,
    documentId = randomUUID(),
    markdown = `본문\n\n![그림](${missing})`,
    key = JSON.stringify(["task", f.taskId, documentId]);
  await pg.pool.query(
    "INSERT INTO graeboard.site_entities VALUES($1,'document',$2,$3,1,0)",
    [
      f.teamId,
      key,
      JSON.stringify({ title: "그림 문서", position: 1, markdown }),
    ],
  );
  await pg.pool.query(
    "INSERT INTO graeboard.site_entity_revisions VALUES($1,'document',$2,1)",
    [f.teamId, key],
  );
  const service = new SheetCloneBusinessService(
      new PostgresSheetCloneRepository({ context: pg.createContext() }),
      f.user,
    ),
    id = randomUUID();
  await service.create({
    id,
    teamId: f.teamId,
    year: 2026,
    name: "missing image copy",
    referenceDate: "2026-10-01",
    view: defaultView(2026),
    taskIds: [f.taskId],
  });
  const copied = (
    await pg.pool.query(
      "SELECT payload FROM graeboard.site_entities WHERE entity='document' AND entity_key=$1",
      [JSON.stringify(["sheetClone", id, f.taskId, documentId])],
    )
  ).rows[0];
  assert.equal(JSON.parse(copied.payload).markdown, markdown);
});
