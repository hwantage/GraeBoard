import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, getTask, json, transaction } from "../server/db.mjs";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import {
  documentImagePath,
  writeDocumentImage,
} from "../server/document-images.mjs";
import {
  documentImageUrls,
  documentPayloadImageUrls,
} from "../shared/document-image-references.js";
import { imageReferences as workerImageReferences } from "../worker/images.mjs";
import {
  activeImageReferences,
  installImageReferences,
} from "../server/sync/retention.mjs";
import sharp from "sharp";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import {
  digest,
  entityId,
  validateEntityPayload,
} from "../server/sync/protocol.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-image-review-"));
  const remote = options.remote || join(directory, "remote.git");
  if (!options.remote)
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(join(directory, "site.sqlite"));
  const teamId = options.teamId || randomUUID(),
    actorId = randomUUID(),
    token = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Images",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(actorId, "images@example.com", "Images", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(actorId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    actorId,
    Date.now() + 86400000,
  );
  const transport = new GitCliTransport({
    directory: join(directory, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    syncOptions: {
      installationId: randomUUID(),
      profiles: [{ profileId: "test", teamId, repository: "test/images" }],
      transports: { test: transport },
      schedule: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        Cookie: `weekly_session=${token}`,
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: unpack(await response.json()) };
  };
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.shutdown();
    app.locals.documentEvents.shutdown();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const enable = async () => {
    ok(
      await api(
        `/admin/teams/${teamId}/connection`,
        { profileId: "test", expectedRevision: 0 },
        "PUT",
      ),
    );
    ok(await api(`/teams/${teamId}/sync/enable`, {}));
  };
  return { db, app, teamId, actorId, directory, remote, api, enable };
}
function ok(response) {
  assert.ok(
    response.status >= 200 && response.status < 300,
    JSON.stringify(response),
  );
  return response.data;
}

test("foreign image-shaped plaintext in actual cell saves publishes immutable pending operations", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "before" },
    }),
  ).task;
  await f.enable();
  const store = f.app.locals.sync.store(f.teamId);
  const beforeHead = store.readLink().canonical_head;
  const foreign = `/api/document-images/${randomUUID()}/not-even-a-hash`;
  for (const value of [`see ${foreign}`, `![literal title](${foreign})`])
    ok(
      await f.api("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: task.id,
            key: "title",
            value,
            expectedVersion: getTask(f.db, task.id).cells.title.version,
          },
        ],
      }),
    );
  const pending = store.readPending();
  assert.equal(pending.length, 2);
  await f.app.locals.sync.get(f.teamId).run();
  assert.notEqual(store.readLink().canonical_head, beforeHead);
  assert.equal(store.readPending().length, 0);
  for (const operation of pending)
    assert.equal(
      store.readState().receipts[operation.opId].payloadHash,
      digest(operation),
    );
  assert.equal(
    store.readState().entities[entityId("cell", [task.id, "title"])].payload
      .value,
    `![literal title](${foreign})`,
  );
});

test("foreign image-shaped historical audit plaintext cannot break maintenance HTTP listing preview execution or restore", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "retained" },
    }),
  ).task;
  ok(
    await f.api(
      `/tasks/${task.id}/document`,
      {
        markdown: "retained document",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  await f.enable();
  f.db
    .prepare(
      "INSERT INTO audit(id,team_id,actor_id,action,target,before_json,after_json,created_at) VALUES(?,?,?,'edit',?,?,?,?)",
    )
    .run(
      randomUUID(),
      f.teamId,
      f.actorId,
      task.id,
      null,
      JSON.stringify({
        value: `/api/document-images/${randomUUID()}/${"a".repeat(64)}.webp`,
      }),
      new Date().toISOString(),
    );
  const path = `/admin/teams/${f.teamId}/maintenance`;
  const listing = ok(await f.api(path));
  const doc = listing.documents.find(
    (item) => item.key[0] === "task" && item.key[1] === task.id,
  );
  assert.ok(doc);
  const preview = ok(
    await f.api(path + "/preview", { kind: "document", ...doc }),
  );
  ok(await f.api(path + "/execute", { token: preview.token, confirmed: true }));
  const excluded = ok(await f.api(path)).retention[0];
  ok(
    await f.api(path + "/restore", {
      retentionId: excluded.id,
      expectedRevision: excluded.revision,
    }),
  );
  assert.equal(
    ok(await f.api(`/tasks/${task.id}/document`)).markdown,
    "retained document",
  );
});

test("Markdown image dependencies agree across reference syntax, protocol and Worker while free text stays legal", () => {
  const teamId = randomUUID(),
    taskId = randomUUID();
  const own = `/api/document-images/${teamId}/${"a".repeat(64)}.webp`;
  const foreign = `/api/document-images/${randomUUID()}/${"b".repeat(64)}.webp`;
  const markdown = `![inline](${own}#width=200)\n![reference][pic]\n\n[pic]: ${own}\n\n\`![code](${foreign})\`\n\n${foreign}`;
  assert.deepEqual(documentImageUrls(markdown), [own]);
  assert.deepEqual(
    documentPayloadImageUrls({
      payload: JSON.stringify({ markdown }),
      title: foreign,
      value: `![text](${foreign})`,
    }),
    [own],
  );
  assert.deepEqual(
    workerImageReferences({ markdown, title: foreign }, teamId),
    [own],
  );
  validateEntityPayload(
    "document",
    ["task", taskId, "main"],
    { markdown, title: "Document", position: 0 },
    teamId,
  );
  for (const body of [
    `![foreign](${foreign})`,
    `![foreign][pic]\n\n[pic]: ${foreign}`,
  ]) {
    assert.throws(
      () => workerImageReferences({ markdown: body }, teamId),
      (error) => error.status === 400,
    );
    assert.throws(
      () =>
        validateEntityPayload(
          "document",
          ["task", taskId, "main"],
          { markdown: body, title: "Document", position: 0 },
          teamId,
        ),
      /image reference/i,
    );
    assert.deepEqual(
      workerImageReferences(
        { value: body, title: body, name: body, data: { query: body } },
        teamId,
      ),
      [],
    );
  }
});

test("foreign actual document images reject atomically at HTTP and capture boundaries", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "before" },
    }),
  ).task;
  ok(
    await f.api(
      `/tasks/${task.id}/document`,
      { markdown: "original", expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  await f.enable();
  const path = `/tasks/${task.id}/document`;
  const persisted = ({ sync, ...document }) => document;
  const before = persisted(ok(await f.api(path)));
  const count = () =>
    Object.fromEntries(
      ["audit", "sync_outbox", "document_versions"].map((table) => [
        table,
        f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
      ]),
    );
  const beforeCounts = count();
  const foreign = `/api/document-images/${randomUUID()}/${"a".repeat(64)}.webp`;
  for (const markdown of [
    `![foreign](${foreign})`,
    `![foreign][pic]\n\n[pic]: ${foreign}`,
  ]) {
    const result = await f.api(
      path,
      {
        markdown,
        expectedRevision: before.revision,
        operationId: randomUUID(),
      },
      "PUT",
    );
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(persisted(ok(await f.api(path))), before);
    assert.deepEqual(count(), beforeCounts);
  }
  assert.throws(
    () =>
      f.db.syncCapture.withActor(f.actorId, () =>
        transaction(f.db, () => {
          const versionId = storeDocumentVersion(f.db, {
            teamId: f.teamId,
            documentId: `${task.id}:main`,
            markdown: `![foreign](${foreign})`,
            actorId: f.actorId,
          });
          f.db
            .prepare(
              "UPDATE task_documents SET version_id=?,revision=revision+1 WHERE task_id=? AND id='main'",
            )
            .run(versionId, task.id);
          f.db
            .prepare(
              "INSERT INTO audit(id,team_id,actor_id,action,target,created_at) VALUES(?,?,?,'document',?,?)",
            )
            .run(
              randomUUID(),
              f.teamId,
              f.actorId,
              task.id,
              new Date().toISOString(),
            );
        }),
      ),
    (error) => error.status === 400 && /image reference/i.test(error.message),
  );
  assert.deepEqual(persisted(ok(await f.api(path))), before);
  assert.deepEqual(
    count(),
    beforeCounts,
    "domain row, immutable body, audit and P all roll back together",
  );
});

test("actual Git receive skips tombstone-only and locally excluded images while keeping live shared images", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "images" },
    }),
  ).task;
  const makeImage = async (color) => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: color },
    })
      .webp()
      .toBuffer();
    const url = `/api/document-images/${f.teamId}/${digest(bytes)}.webp`;
    writeDocumentImage(join(f.directory, "images"), url, bytes);
    return url;
  };
  const deletedOnly = await makeImage("red"),
    shared = await makeImage("blue");
  const deadId = randomUUID(),
    liveId = randomUUID();
  for (const id of [deadId, liveId])
    ok(await f.api(`/tasks/${task.id}/documents`, { id }));
  const deadPath = `/tasks/${task.id}/documents/${deadId}`,
    livePath = `/tasks/${task.id}/documents/${liveId}`;
  const dead = ok(
    await f.api(
      deadPath,
      {
        markdown: `![dead](${deletedOnly})\n![shared](${shared})`,
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  ok(
    await f.api(
      livePath,
      {
        markdown: `![shared][pic]\n\n[pic]: ${shared}`,
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  await f.enable();
  ok(await f.api(deadPath, { expectedRevision: dead.revision }, "DELETE"));
  await f.app.locals.sync.get(f.teamId).run();
  ok(await f.api(`/teams/${f.teamId}/sync/checkpoint`, {}));
  const sourceStore = f.app.locals.sync.store(f.teamId),
    state = sourceStore.readState();
  assert.equal(
    state.entities[entityId("document", ["task", task.id, deadId])].deleted,
    true,
  );
  assert.ok(
    activeImageReferences(state, [], [], state.entities, f.teamId).has(
      deletedOnly,
    ),
    "recoverable tombstone still protects locally present bytes",
  );
  assert.equal(
    installImageReferences(state, [], [], state.entities, f.teamId).has(
      deletedOnly,
    ),
    false,
  );
  const peer = await fixture(t, { teamId: f.teamId, remote: f.remote });
  const original = sourceStore.readLink();
  peer.app.locals.sync.store(f.teamId).writeLink({
    ...Object.fromEntries(
      ["repo_id", "bootstrap_id", "writer_epoch", "updated_at"].map((key) => [
        key,
        original[key],
      ]),
    ),
    profile_id: "test",
    installation_id: peer.app.locals.sync.installationId,
    mode: "importing",
  });
  peer.app.locals.sync.capture.refresh();
  await peer.app.locals.sync.get(f.teamId).run({ receiveOnly: true });
  const peerFile = (url) =>
    documentImagePath(join(peer.directory, "images"), url);
  assert.equal(
    existsSync(peerFile(deletedOnly)),
    false,
    "joining site does not hydrate tombstone-only bytes",
  );
  assert.equal(
    existsSync(peerFile(shared)),
    true,
    "live reference wins over a shared tombstone reference",
  );
  // Archive-backed local cleanup is allowed after explicit local recovery-history
  // removal and local exclusions cover every remaining reference to that file.
  peer.db.prepare("DELETE FROM audit WHERE team_id=?").run(f.teamId);
  utimesSync(peerFile(shared), new Date("2025-01-01"), new Date("2025-01-01"));
  const maintenance = `/admin/teams/${f.teamId}/maintenance`;
  const preview = ok(
    await peer.api(maintenance + "/preview", { kind: "year", year: 2026 }),
  );
  assert.equal(preview.images.count, 1);
  ok(
    await peer.api(maintenance + "/execute", {
      token: preview.token,
      confirmed: true,
    }),
  );
  assert.equal(existsSync(peerFile(shared)), false);
  ok(
    await f.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value: "unrelated next commit",
          expectedVersion: getTask(f.db, task.id).cells.title.version,
        },
      ],
    }),
  );
  await f.app.locals.sync.get(f.teamId).run();
  await peer.app.locals.sync.get(f.teamId).run({ receiveOnly: true });
  assert.equal(
    peer.app.locals.sync.store(f.teamId).readLink().canonical_head,
    sourceStore.readLink().canonical_head,
  );
  assert.equal(existsSync(peerFile(deletedOnly)), false);
  assert.equal(
    existsSync(peerFile(shared)),
    false,
    "later receive does not reinstall L-excluded content",
  );
});
