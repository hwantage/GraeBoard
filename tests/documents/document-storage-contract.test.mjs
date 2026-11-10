import { join } from "node:path";
import { openDatabase } from "../../server/db.mjs";
import test from "node:test";
import { copiedRowSchema } from "../../shared/validation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createExternalRouteApp } from "../support/external-route-fixture.mjs";
import { DocumentBusinessService } from "../../server/storage/documents/document-service.mjs";
import { unpack } from "../../shared/formatting/compact.js";
import sharp from "sharp";
import { materialize } from "../../worker/sync/materialize.mjs";

import {
  sqliteFixture,
  postgresFixture,
} from "../support/business-storage-fixture.mjs";
import { CalendarBusinessService } from "../../server/storage/calendar/calendar-service.mjs";
import { PostgresCalendarRepository } from "../../worker/storage/calendar/postgres-calendar.mjs";

const saveRequest = (markdown, expectedRevision) => ({
  markdown,
  expectedRevision,
  operationId: randomUUID(),
});
const rejected = (work, status) =>
  assert.rejects(
    Promise.resolve().then(work),
    (error) => error.status === status,
  );
function scopes(f) {
  return [
    { kind: "task", taskId: f.taskId },
    { kind: "sheetClone", sheetCloneId: f.sheetCloneId, taskId: f.taskId },
    { kind: "annual", teamId: f.teamId, year: 2026 },
    { kind: "sheetCloneMemo", sheetCloneId: f.sheetCloneId },
    { kind: "calendar", entryId: f.entryId, documentId: "main" },
  ];
}
async function documentContract({ f, service, counts, failOnce }) {
  const values = [];
  for (const owner of scopes(f)) {
    const scope = {
      ...owner,
      documentId: owner.kind === "calendar" ? "main" : randomUUID(),
    };
    if (owner.kind !== "calendar") {
      const created = await service.create(owner, {
        id: scope.documentId,
        title: "Contract document",
      });
      assert.ok(created.documents.some((doc) => doc.id === scope.documentId));
    }
    const initial = await service.read(scope),
      before = await counts();
    const request = saveRequest(`${owner.kind} first`, initial.revision),
      first = await service.save(scope, request),
      saved = await counts();
    assert.equal(first.markdown, `${owner.kind} first`);
    assert.notEqual(first.revision, initial.revision);
    assert.equal(saved.pending, before.pending + 1, owner.kind + " capture");
    assert.equal((await service.save(scope, request)).markdown, first.markdown);
    assert.deepEqual(await counts(), saved, owner.kind + " replay");
    await rejected(
      () => service.save(scope, saveRequest("stale", initial.revision)),
      409,
    );
    assert.deepEqual(await counts(), saved);
    failOnce();
    await assert.rejects(
      Promise.resolve().then(() =>
        service.save(scope, saveRequest("rollback", first.revision)),
      ),
      /injected document failure/,
    );
    assert.deepEqual(
      await counts(),
      saved,
      owner.kind + " rollback audit/outbox/events",
    );
    assert.equal((await service.read(scope)).markdown, first.markdown);
    const second = await service.save(
      scope,
      saveRequest("second version", first.revision),
    );
    const restored = await service.save(
      scope,
      saveRequest(first.markdown, second.revision),
    );
    assert.equal(
      restored.markdown,
      first.markdown,
      "existing body/version restore uses ordinary optimistic save",
    );
    if (owner.kind !== "calendar") {
      await service.rename(scope, {
        title: "Renamed",
        expectedTitle: "Contract document",
      });
      assert.equal((await service.read(scope)).title, "Renamed");
      assert.equal(
        (await service.list(owner, { content: true })).documents.find(
          (doc) => doc.id === scope.documentId,
        ).markdown,
        first.markdown,
      );
      // A copied row sends these back when pasted or restored, so both sites
      // answer a task's or copy row's contents with what copiedRowSchema takes.
      if (["task", "sheetClone"].includes(owner.kind)) {
        const listed = (await service.list(owner, { content: true })).documents;
        assert.deepEqual(
          listed.map((doc) => Object.keys(doc).sort()),
          listed.map(() => ["id", "markdown", "title"]),
          owner.kind + " content listing",
        );
        copiedRowSchema.shape.documents.parse(listed);
      }
      if (
        ["task", "sheetClone", "annual", "sheetCloneMemo"].includes(owner.kind)
      ) {
        const otherId = randomUUID();
        await service.create(owner, { id: otherId });
        const list = (await service.list(owner)).documents.map((doc) => doc.id);
        const order = { ids: [...list].reverse(), expectedIds: list };
        failOnce();
        await assert.rejects(
          Promise.resolve().then(() => service.reorder(owner, order)),
          /injected document failure/,
        );
        assert.deepEqual(
          (await service.list(owner)).documents.map((doc) => doc.id),
          list,
        );
        await service.reorder(owner, order);
        assert.equal((await service.read(scope)).markdown, first.markdown);
        await rejected(
          () =>
            service.reorder(owner, {
              ids: list.slice(1),
              expectedIds: order.ids,
            }),
          409,
        );
        const orderedCounts = await counts();
        await service.reorder(owner, order);
        // SQLite invalidation cursors may move for a replayed structural command;
        // durable rows, audit and P must remain unchanged on either engine.
        const { published: ignoredBefore, ...durableBefore } = orderedCounts;
        const { published: ignoredAfter, ...durableAfter } = await counts();
        assert.deepEqual(durableAfter, durableBefore);
        assert.deepEqual(
          (await service.list(owner)).documents.map((doc) => doc.id),
          [...list].reverse(),
        );
      }
      const current = await service.read(scope);
      await rejected(
        () => service.remove(scope, { expectedRevision: initial.revision }),
        409,
      );
      const removed = await service.remove(scope, {
        expectedRevision: current.revision,
      });
      assert.ok(!removed.documents.some((doc) => doc.id === scope.documentId));
      await rejected(() => service.read(scope), 404);
    }
    values.push(scope);
  }
  return values;
}

// Link titles follow the document routes on both engines: what the user can
// read, current titles, nothing for deleted, missing or other teams' targets.
async function linkContract({ f, service, links, outsiderLinks }) {
  const memo = randomUUID(),
    copyMemo = randomUUID(),
    missing = randomUUID();
  await service.create(
    { kind: "annual", teamId: f.teamId, year: 2026 },
    { id: memo, title: "Linked memo" },
  );
  await service.create(
    { kind: "sheetCloneMemo", sheetCloneId: f.sheetCloneId },
    { id: copyMemo, title: "Linked copy memo" },
  );
  const paths = {
    task: `/links/task/${f.taskId}`,
    calendar: `/links/calendar/${f.entryId}`,
    memo: `/links/memo/${f.teamId}/2026/${memo}`,
    sheetCloneTask: `/links/sheet-clone-task/${f.sheetCloneId}/${f.taskId}`,
    sheetCloneMemo: `/links/sheet-clone-memo/${f.sheetCloneId}/${copyMemo}`,
  };
  const absent = [
    `/links/memo/${f.teamId}/2025/${memo}`,
    `/links/memo/${f.teamId}/2026/${missing}`,
    `/links/sheet-clone-task/${f.sheetCloneId}/${missing}`,
    `/links/sheet-clone-task/${missing}/${f.taskId}`,
    `/links/sheet-clone-memo/${f.sheetCloneId}/${missing}`,
  ];
  const titles = async (read, list) =>
    Object.fromEntries(
      (await read(list)).links.map((link) => {
        assert.equal(link.teamId, f.teamId);
        return [link.path, link.title];
      }),
    );
  assert.deepEqual(await titles(links, [...Object.values(paths), ...absent]), {
    [paths.task]: "initial",
    [paths.calendar]: "Contract calendar",
    [paths.memo]: "Linked memo",
    [paths.sheetCloneTask]: "initial",
    [paths.sheetCloneMemo]: "Linked copy memo",
  });
  assert.deepEqual(await titles(outsiderLinks, Object.values(paths)), {});
  await service.rename(
    { kind: "annual", teamId: f.teamId, year: 2026, documentId: memo },
    { title: "Renamed memo", expectedTitle: "Linked memo" },
  );
  const read = await service.read({
    kind: "sheetCloneMemo",
    sheetCloneId: f.sheetCloneId,
    documentId: copyMemo,
  });
  await service.remove(
    {
      kind: "sheetCloneMemo",
      sheetCloneId: f.sheetCloneId,
      documentId: copyMemo,
    },
    { expectedRevision: read.revision },
  );
  assert.deepEqual(await titles(links, [paths.memo, paths.sheetCloneMemo]), {
    [paths.memo]: "Renamed memo",
  });
}
async function retentionContract({ f, service, counts, exclude }) {
  const owner = { kind: "annual", teamId: f.teamId, year: 2026 },
    scope = { ...owner, documentId: randomUUID() };
  await service.create(owner, { id: scope.documentId });
  const initial = await service.read(scope),
    saved = await service.save(
      scope,
      saveRequest("Retained original", initial.revision),
    );
  await exclude(true);
  const before = await counts();
  assert.deepEqual((await service.list(owner)).documents, []);
  for (const work of [
    () => service.read(scope),
    () => service.save(scope, saveRequest("hidden overwrite", saved.revision)),
    () => service.create(owner, { id: randomUUID() }),
    () => service.read({ kind: "task", taskId: f.taskId, documentId: "main" }),
    () =>
      service.read({
        kind: "sheetClone",
        sheetCloneId: f.sheetCloneId,
        taskId: f.taskId,
        documentId: "main",
      }),
  ])
    await assert.rejects(Promise.resolve().then(work), (error) =>
      [404, 409].includes(error.status),
    );
  assert.deepEqual(
    await counts(),
    before,
    "hidden reads/writes preserve audit, P, versions/events",
  );
  assert.ok(
    (
      await service.read({
        kind: "calendar",
        entryId: f.entryId,
        documentId: "main",
      })
    ).markdown.includes("calendar"),
  );
  await exclude(false);
  assert.equal((await service.read(scope)).markdown, "Retained original");
}

test("M6 shared document contract on SQLite retains synchronous commands, all document scopes and atomic rollback", async (t) => {
  const f = sqliteFixture(t),
    repository = f.app.locals.documentRepository,
    service = new DocumentBusinessService(repository, f.user);
  let published = 0;
  const originalPublish = repository.documentEvents.publish.bind(
      repository.documentEvents,
    ),
    revisions = new Map();
  repository.documentEvents.publish = (key, document) => {
    const reader = openDatabase(join(f.dir, "data.sqlite"));
    try {
      assert.ok(
        reader.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n > 0,
      );
    } finally {
      reader.close();
    }
    if (revisions.get(key) !== document.revision) {
      published++;
      revisions.set(key, document.revision);
    }
    return originalPublish(key, document);
  };
  const counts = () => ({
    pending: f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
    audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    versions: f.db.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    published,
  });
  await documentContract({
    f,
    service,
    counts,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected document failure");
      };
    },
  });
  await retentionContract({
    f,
    service,
    counts,
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
  assert.equal(
    service.list({ kind: "task", taskId: f.taskId }) instanceof Promise,
    false,
  );
  const outsiderUser = {
    id: randomUUID(),
    systemRole: "user",
    teamIds: [],
    teamRoles: {},
  };
  const calendar = f.app.locals.calendarRepository;
  await linkContract({
    f,
    service,
    links: async (paths) =>
      new CalendarBusinessService(calendar, f.user).resolveLinks({
        query: { links: paths.join(",") },
      }),
    outsiderLinks: async (paths) =>
      new CalendarBusinessService(calendar, outsiderUser).resolveLinks({
        query: { links: paths.join(",") },
      }),
  });
  const outsider = new DocumentBusinessService(repository, outsiderUser);
  await rejected(
    () => outsider.read({ kind: "task", taskId: f.taskId, documentId: "main" }),
    403,
  );
});

test("M6 identical document contract uses PostgreSQL and external HTTP task-id requests/SSE never consult SQLite domain rows", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const repository = f.makeRepository(f.user),
    service = new DocumentBusinessService(repository, f.user);
  let fail = false;
  const originalData = repository.context.data.bind(repository.context);
  repository.context.data = (teamId, work, options) =>
    originalData(
      teamId,
      async (s) => {
        const value = await work(s);
        if (fail && options?.write) {
          fail = false;
          const capture = s.capture.bind(s);
          s.capture = async (actor) => {
            await capture(actor);
            throw new Error("injected document failure");
          };
        }
        return value;
      },
      options,
    );
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
  });
  await documentContract({
    f,
    service,
    counts,
    failOnce() {
      fail = true;
    },
  });
  await retentionContract({
    f,
    service,
    counts,
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
  const outsiderUser = (
    await f.control.query(
      "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,'Outsider','user',$3) RETURNING *",
      [randomUUID(), "outsider@example.test", new Date().toISOString()],
    )
  ).rows[0];
  const resolver = (user) => async (paths) =>
    new CalendarBusinessService(
      new PostgresCalendarRepository({ context: f.makeContext(user) }),
      user,
    ).resolveLinks({ query: { links: paths.join(",") } });
  await linkContract({
    f,
    service,
    links: resolver(f.user),
    outsiderLinks: resolver({
      id: outsiderUser.id,
      name: outsiderUser.name,
      systemRole: "user",
      teamIds: [],
      teamRoles: {},
    }),
  });
  const target = { kind: "task", taskId: f.taskId, documentId: "main" };
  const before = await service.read(target);
  const after = await service.save(
    target,
    saveRequest("PostgreSQL initial", before.revision),
  );
  // No matching SQLite task exists. Any old taskAccess/retention lookup fails.
  f.db.syncCapture.without(() => {
    f.db.prepare("DELETE FROM cells WHERE task_id=?").run(f.taskId);
    f.db.prepare("DELETE FROM tasks WHERE id=?").run(f.taskId);
  });
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.user.id);
  f.db
    .prepare("UPDATE memberships SET role='member' WHERE user_id=?")
    .run(f.user.id);
  await f.control.query(
    "UPDATE graeboard.users SET system_role='user' WHERE id=$1",
    [f.user.id],
  );
  await f.control.query(
    "UPDATE graeboard.memberships SET role='member' WHERE user_id=$1",
    [f.user.id],
  );
  const storedImages = new Map(),
    teamEnv = f.env;
  teamEnv.BUCKET = {
    async put(key, bytes) {
      storedImages.set(key, Buffer.from(bytes));
    },
    async head(key) {
      return storedImages.has(key) ? { key } : null;
    },
    async get(key) {
      const bytes = storedImages.get(key);
      return bytes
        ? {
            body: new Response(bytes).body,
            arrayBuffer: async () => new Uint8Array(bytes).buffer,
          }
        : null;
    },
    async delete(key) {
      storedImages.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...storedImages.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  teamEnv.IMAGES = {
    async info(stream) {
      const info = await sharp(
        Buffer.from(await new Response(stream).arrayBuffer()),
      ).metadata();
      return { ...info, format: "image/" + info.format };
    },
    input(stream) {
      return {
        transform() {
          return {
            async output() {
              const bytes = await sharp(
                Buffer.from(await new Response(stream).arrayBuffer()),
              )
                .webp({ quality: 90 })
                .toBuffer();
              return { response: () => new Response(bytes) };
            },
          };
        },
      };
    },
  };
  const imageBytes = (url) =>
    storedImages.get(`images/${f.teamId}/${url.split("/").at(-1)}`);
  const app = createExternalRouteApp({
    env: teamEnv,
    defaultUserId: f.user.id,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = {
      Cookie: "weekly_session=" + f.user.id,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    };
  const response = await fetch(`${origin}/api/tasks/${f.taskId}/document`, {
    headers,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).markdown, "PostgreSQL initial");
  for (const base of [
    `/api/tasks/${f.taskId}/documents`,
    `/api/sheet-clones/${f.sheetCloneId}/tasks/${f.taskId}/documents`,
  ]) {
    const list = unpack(await (await fetch(origin + base, { headers })).json());
    const expectedIds = list.documents.map((doc) => doc.id),
      ids = [...expectedIds].reverse();
    assert.ok(ids.length > 1);
    for (let replay = 0; replay < 2; replay++) {
      const reordered = await fetch(origin + base + "/reorder", {
        method: "POST",
        headers,
        body: JSON.stringify({ ids, expectedIds }),
      });
      assert.equal(reordered.status, 200, await reordered.clone().text());
      assert.deepEqual(
        unpack(await reordered.json()).documents.map((doc) => doc.id),
        ids,
      );
    }
  }
  const abort = new AbortController(),
    stream = await fetch(`${origin}/api/tasks/${f.taskId}/document/events`, {
      headers,
      signal: abort.signal,
    });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const waitBody = async (text) => {
    const deadline = setTimeout(() => abort.abort(), 10000);
    try {
      while (!buffer.includes(text)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value);
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  await waitBody("PostgreSQL initial");
  buffer = "";
  const saved = await fetch(`${origin}/api/tasks/${f.taskId}/document`, {
    method: "PUT",
    headers,
    body: JSON.stringify(
      saveRequest(
        "external HTTP writes PostgreSQL",
        (await service.read(target)).revision,
      ),
    ),
  });
  assert.equal(saved.status, 200, await saved.text());
  await waitBody("external HTTP writes PostgreSQL");
  const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#123456" },
    })
      .png()
      .toBuffer(),
    form = new FormData(),
    beforeUpload = await counts();
  form.set("image", new Blob([png], { type: "image/png" }), "image.png");
  const uploaded = await fetch(
    `${origin}/api/tasks/${f.taskId}/document/images`,
    {
      method: "POST",
      headers: { Cookie: headers.Cookie, "X-Requested-With": "WeeklyPlan" },
      body: form,
    },
  );
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { url: imageUrl } = await uploaded.json();
  assert.equal(storedImages.size, 1);
  assert.equal(
    (await counts()).pending,
    beforeUpload.pending,
    "byte upload does not create a shared document operation",
  );
  assert.equal(
    Number(
      (
        await f.pool.query(
          "SELECT COUNT(*) n FROM graeboard.site_entities WHERE entity='uploadLease'",
        )
      ).rows[0].n,
    ),
    0,
  );
  const imageMarkdown = `external HTTP writes PostgreSQL\n\n![image](${imageUrl})`,
    current = await service.read(target),
    imageSave = await fetch(`${origin}/api/tasks/${f.taskId}/document`, {
      method: "PUT",
      headers,
      body: JSON.stringify(saveRequest(imageMarkdown, current.revision)),
    });
  assert.equal(imageSave.status, 200, await imageSave.clone().text());
  const imageRead = await fetch(origin + imageUrl, { headers });
  assert.equal(imageRead.status, 200, await imageRead.clone().text());
  assert.equal(imageRead.headers.get("content-type"), "image/webp");
  assert.deepEqual(
    Buffer.from(await imageRead.arrayBuffer()),
    imageBytes(imageUrl),
  );
  const exported = await fetch(origin + "/api/export", {
    method: "POST",
    headers,
    body: JSON.stringify({
      teamId: f.teamId,
      year: 2026,
      format: "json",
      scope: "all",
    }),
  });
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.equal(
    unpack(await exported.json()).documentImages[0].base64,
    imageBytes(imageUrl).toString("base64"),
  );
  await waitBody(imageUrl);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tasks").get().n, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM task_documents").get().n,
    0,
  );
  buffer = "";
  await f.control.query(
    "DELETE FROM graeboard.memberships WHERE user_id=$1 AND team_id=$2",
    [f.user.id, f.teamId],
  );
  await waitBody("event: access-revoked");
  assert.ok(!buffer.includes("external HTTP writes PostgreSQL"));
  const revoked = await fetch(`${origin}/api/tasks/${f.taskId}/document`, {
    headers,
  });
  assert.ok(
    [403, 404].includes(revoked.status),
    "PostgreSQL control membership revocation closes PostgreSQL document access",
  );
  assert.equal(
    (await fetch(origin + imageUrl, { headers })).status,
    403,
    "image reads also use current PostgreSQL control membership",
  );
  const deniedUpload = new FormData();
  deniedUpload.set(
    "image",
    new Blob([png], { type: "image/png" }),
    "denied.png",
  );
  assert.ok(
    [403, 404].includes(
      (
        await fetch(`${origin}/api/tasks/${f.taskId}/document/images`, {
          method: "POST",
          headers: { Cookie: headers.Cookie, "X-Requested-With": "WeeklyPlan" },
          body: deniedUpload,
        })
      ).status,
    ),
  );
  assert.equal(storedImages.size, 1);
  abort.abort();
  await reader.cancel().catch(() => {});
  assert.equal((await service.read(target)).markdown, imageMarkdown);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM task_documents WHERE task_id=?")
      .get(f.taskId).n,
    0,
  );
});
