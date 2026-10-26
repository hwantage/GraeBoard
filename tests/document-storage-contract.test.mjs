import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { createPostgresBusinessStorage } from "../server/storage/business-storage.mjs";
import { SqliteControlStore } from "../server/storage/control-store.mjs";
import { FileImageStore } from "../server/storage/file-images.mjs";
import { documentImagePath } from "../server/document-images.mjs";
import { unpack } from "../shared/compact.js";
import sharp from "sharp";
import { materialize } from "../worker/materialize.mjs";

import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";

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
    { kind: "report", reportId: f.reportId, taskId: f.taskId },
    { kind: "annual", teamId: f.teamId, year: 2026 },
    { kind: "reportMemo", reportId: f.reportId },
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
      if (["annual", "reportMemo"].includes(owner.kind)) {
        const otherId = randomUUID();
        await service.create(owner, { id: otherId });
        const list = (await service.list(owner)).documents.map((doc) => doc.id);
        const order = { ids: [...list].reverse(), expectedIds: list };
        await service.reorder(owner, order);
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
        kind: "report",
        reportId: f.reportId,
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
  const outsider = new DocumentBusinessService(repository, {
    id: randomUUID(),
    systemRole: "user",
    teamIds: [],
    teamRoles: {},
  });
  await rejected(
    () => outsider.read({ kind: "task", taskId: f.taskId, documentId: "main" }),
    403,
  );
});

test("M6 identical document contract uses PostgreSQL and Node HTTP task-id requests/SSE never consult SQLite domain rows", async (t) => {
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
  // The host retains accounts, sessions and team membership, without any task
  // or document rows; PostgreSQL control is absent from this configuration.
  const hostDb = openDatabase(join(f.dir, "host-auth.sqlite"));
  hostDb
    .prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
    )
    .run(
      f.user.id,
      "host@example.test",
      "Host identity",
      new Date().toISOString(),
    );
  hostDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      createHash("sha256").update(f.user.id).digest("hex"),
      f.user.id,
      Date.now() + 600000,
    );
  const hostTeam = f.db.prepare("SELECT * FROM teams WHERE id=?").get(f.teamId);
  hostDb
    .prepare("INSERT INTO teams VALUES(?,?,?)")
    .run(hostTeam.id, hostTeam.name, hostTeam.settings);
  hostDb
    .prepare("INSERT INTO memberships VALUES(?,?,'member')")
    .run(f.user.id, f.teamId);
  const imageDirectory = join(f.dir, "host-images"),
    {
      PG_CONTROL: unusedControl,
      BUCKET: unusedBucket,
      TOKEN: unusedToken,
      ...teamEnv
    } = f.env;
  teamEnv.SYNC_PROFILES = JSON.stringify([
    { profileId: "contract", teamId: f.teamId, databaseBinding: "PG_TEAM" },
  ]);
  await f.control.query("DELETE FROM graeboard.memberships");
  await f.control.query("DELETE FROM graeboard.users");
  await f.control.query("DELETE FROM graeboard.teams");
  repository.context.controlStore = new SqliteControlStore({
    db: hostDb,
    env: teamEnv,
  });
  repository.context.teamCache.clear();
  repository.context.env = teamEnv;
  repository.context.imageStore = (teamId) =>
    new FileImageStore({ directory: imageDirectory, teamId });
  const app = createApp({
    db: hostDb,
    rateLimits: false,
    documentImagesDir: imageDirectory,
    storage: createPostgresBusinessStorage({ env: teamEnv }),
    syncOptions: { schedule: false, installationId: f.link.installation_id },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.documentEvents.close();
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hostDb.close();
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
      saveRequest("Node HTTP writes PostgreSQL", after.revision),
    ),
  });
  assert.equal(saved.status, 200, await saved.text());
  await waitBody("Node HTTP writes PostgreSQL");
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
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const { url: imageUrl } = await uploaded.json();
  assert.equal(readdirSync(join(imageDirectory, f.teamId)).length, 1);
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
  const imageMarkdown = `Node HTTP writes PostgreSQL\n\n![image](${imageUrl})`,
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
    readFileSync(documentImagePath(imageDirectory, imageUrl)),
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
    readFileSync(documentImagePath(imageDirectory, imageUrl)).toString(
      "base64",
    ),
  );
  await waitBody(imageUrl);
  assert.equal(hostDb.prepare("SELECT COUNT(*) n FROM tasks").get().n, 0);
  assert.equal(
    hostDb.prepare("SELECT COUNT(*) n FROM task_documents").get().n,
    0,
  );
  buffer = "";
  hostDb
    .prepare("DELETE FROM memberships WHERE user_id=? AND team_id=?")
    .run(f.user.id, f.teamId);
  app.locals.documentEvents.notify(`task:${f.taskId}:main`);
  await waitBody("event: access-revoked");
  assert.ok(!buffer.includes("Node HTTP writes PostgreSQL"));
  const revoked = await fetch(`${origin}/api/tasks/${f.taskId}/document`, {
    headers,
  });
  assert.ok(
    [403, 404].includes(revoked.status),
    "SQLite control membership revocation closes PostgreSQL document access",
  );
  assert.equal(
    (await fetch(origin + imageUrl, { headers })).status,
    403,
    "image reads also use current SQLite control membership",
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
  assert.equal(readdirSync(join(imageDirectory, f.teamId)).length, 1);
  assert.equal("PG_CONTROL" in teamEnv, false);
  assert.equal("BUCKET" in teamEnv, false);
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
