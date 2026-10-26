import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDocumentImageReferenceCache,
  documentImageUrls,
  withDocumentImageReferences,
} from "../shared/document-image-references.js";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, json } from "../server/db.mjs";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import { getTaskDocument } from "../server/task-documents.mjs";
import {
  documentImagePath,
  writeDocumentImage,
} from "../server/document-images.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import {
  validateOperation,
  entityId,
  stateHash,
} from "../server/sync/protocol.mjs";
import { validateSnapshot } from "../server/sync/reducer.mjs";
import { imageReferences, R2ImageStore } from "../worker/images.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";

const parseChannel = channel("graeboard.document-images.parse");
function parses(t, writer = () => false) {
  const events = [];
  const listener = (event) => events.push({ ...event, writer: writer() });
  parseChannel.subscribe(listener);
  t.after(() => parseChannel.unsubscribe(listener));
  return events;
}
const urlFor = (teamId = randomUUID()) =>
  `/api/document-images/${teamId}/${"a".repeat(64)}.webp`;
const markdownFor = (url, label = randomUUID()) =>
  `# ${label}\n![inline](${url})\n![reference][pic]\n\n[pic]: ${url}\n`;

test("image extraction cache has bounded LRU count, bytes and absolute lifetime and retains only immutable URL results", () => {
  let now = 100;
  const cache = createDocumentImageReferenceCache({
    maxEntries: 2,
    maxBytes: 1000,
    ttlMs: 30,
    now: () => now,
  });
  const original = ["/first"];
  cache.set("a", original);
  original.push("/mutated");
  assert.deepEqual(cache.get("a"), ["/first"]);
  assert.equal(Object.isFrozen(cache.get("a")), true);
  assert.throws(() => cache.get("a").push("/injected"), TypeError);
  cache.set("b", ["/second"]);
  cache.get("a");
  cache.set("c", ["/third"]);
  assert.equal(cache.size, 2);
  assert.equal(
    cache.get("b"),
    undefined,
    "least recently accessed entry is evicted",
  );
  assert.deepEqual(cache.get("a"), ["/first"]);
  now = 129;
  cache.get("a");
  now = 130;
  assert.equal(
    cache.get("a"),
    undefined,
    "reads cannot extend the lifetime of retained document text",
  );
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  const bytes = createDocumentImageReferenceCache({
    maxEntries: 8,
    maxBytes: 200,
    ttlMs: 30,
    now: () => now,
  });
  bytes.set("x".repeat(30), ["/x"]);
  bytes.set("y".repeat(30), ["/y"]);
  assert.equal(bytes.size, 1, "byte limit also evicts below the count limit");
  assert.equal(bytes.get("x".repeat(30)), undefined);
  assert.ok(bytes.bytes <= 200);
  bytes.set("z".repeat(500), ["/large"]);
  assert.equal(bytes.get("z".repeat(500)), undefined);
  bytes.close();
  bytes.set("late", ["/late"]);
  assert.equal(bytes.closed, true);
  assert.equal(bytes.get("late"), undefined);
  assert.equal(bytes.size, 0);
  assert.equal(bytes.bytes, 0);
  const defaults = createDocumentImageReferenceCache({ now: () => now });
  for (let i = 0; i < 9; i++) defaults.set(String(i), ["/" + i]);
  assert.equal(defaults.size, 8);
  assert.equal(defaults.get("0"), undefined);
  assert.ok(defaults.bytes <= 2 * 1024 * 1024);
  now += 30000;
  assert.equal(defaults.size, 0);
});

test("exact Markdown extraction is reused through sync and async scopes without retaining closed scopes", async (t) => {
  const events = parses(t),
    own = urlFor(),
    body = markdownFor(own);
  const value = withDocumentImageReferences(() => {
    assert.deepEqual(documentImageUrls(body), [own]);
    return withDocumentImageReferences(() => {
      assert.deepEqual(documentImageUrls(body), [own]);
      return 42;
    });
  });
  assert.equal(value, 42, "SQLite command wrapper must remain synchronous");
  assert.equal(events.length, 1);
  await withDocumentImageReferences(async () => {
    assert.deepEqual(documentImageUrls(body), [own]);
    await Promise.resolve();
    assert.deepEqual(documentImageUrls(body), [own]);
  });
  assert.equal(events.length, 1);
  documentImageUrls(body + "different body");
  assert.equal(
    events.length,
    2,
    "exact strings, not document IDs or URL sets, are cache keys",
  );
  const parallel = markdownFor(own),
    before = events.length;
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const first = withDocumentImageReferences(async () => {
    documentImageUrls(parallel);
    await gate;
    documentImageUrls(parallel);
  });
  await withDocumentImageReferences(async () => {
    for (let i = 0; i < 9; i++) documentImageUrls(markdownFor(own));
    await Promise.resolve();
  });
  resume();
  await first;
  assert.equal(
    events.length - before,
    10,
    "independent command cache survives another command evicting the recent LRU",
  );
  let releaseLate, late;
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve;
  });
  const lateBody = markdownFor(own);
  withDocumentImageReferences(() => {
    documentImageUrls(lateBody);
    late = lateGate.then(() => documentImageUrls(lateBody));
  });
  for (let i = 0; i < 9; i++) documentImageUrls(markdownFor(own));
  const beforeLate = events.length;
  releaseLate();
  await late;
  assert.equal(
    events.length,
    beforeLate + 1,
    "late async child cannot reuse its already closed command cache",
  );
  assert.ok(
    events.every(
      (event) =>
        typeof event.characters === "number" &&
        !Object.hasOwn(event, "markdown"),
    ),
  );
});

function largeBody(url, label = randomUUID()) {
  const block =
    `paragraph ${label} with text\n`.repeat(9) + `![image](${url})\n\n`;
  return block.repeat(Math.ceil(65536 / block.length)).slice(0, 65536);
}
const ok = (response) => {
  assert.ok(
    response.status >= 200 && response.status < 300,
    JSON.stringify(response),
  );
  return response.data;
};
async function fixture(t, { linked = true, coldBody = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-image-cache-")),
    images = join(directory, "images"),
    db = openDatabase(join(directory, "data.sqlite")),
    teamId = randomUUID(),
    otherTeam = randomUUID(),
    actorId = randomUUID(),
    token = randomUUID(),
    installationId = randomUUID(),
    stamp = new Date().toISOString();
  for (const id of [teamId, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      "Cache fixture",
      json(DEFAULT_SETTINGS),
    );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
  ).run(actorId, "cache@example.test", "Cache", stamp);
  for (const id of [teamId, otherTeam])
    db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(actorId, id);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    actorId,
    Date.now() + 600000,
  );
  const taskIds = [teamId, teamId, otherTeam].map(
    (id) =>
      insertTask(db, {
        teamId: id,
        year: 2026,
        actorId,
        fields: { title: "Document" },
      }).id,
  );
  const bytes = Buffer.from(
      "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
      "base64",
    ),
    imageUrl = `/api/document-images/${teamId}/${createHash("sha256").update(bytes).digest("hex")}.webp`;
  writeDocumentImage(images, imageUrl, bytes);
  const original = coldBody ? largeBody(imageUrl) : "original";
  const versionId = storeDocumentVersion(db, {
    teamId,
    documentId: `${taskIds[0]}:main`,
    markdown: original,
    actorId,
  });
  db.prepare(
    "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,'main','Document',0,?,1,1,?,?)",
  ).run(taskIds[0], versionId, stamp, actorId);
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: images,
    syncOptions: { installationId, schedule: false },
  });
  const store = app.locals.sync.store(teamId);
  if (linked) {
    store.writeLink({
      repo_id: randomUUID(),
      bootstrap_id: randomUUID(),
      installation_id: installationId,
      writer_epoch: randomUUID(),
      profile_id: "cache",
      mode: "paused",
      canonical_head: "a".repeat(40),
      updated_at: stamp,
    });
    const state = {
      entities: allEntities(db, store.readLink()),
      receipts: {},
      conflicts: {},
    };
    store.writeState(state, "a".repeat(40));
    store.writeLink({ canonical_hash: stateHash(state) });
    app.locals.sync.capture.refresh();
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const api = async (path, body, method = body ? "PUT" : "GET") => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          Cookie: "weekly_session=" + token,
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, data: unpack(await response.json()) };
  };
  const save = (
    markdown,
    {
      taskId = taskIds[0],
      operationId = randomUUID(),
      expectedRevision = getTaskDocument(db, taskId).revision,
    } = {},
  ) =>
    api(`/tasks/${taskId}/document`, {
      markdown,
      operationId,
      expectedRevision,
    });
  let writer = false,
    transactions = 0;
  const originalExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (/^\s*BEGIN IMMEDIATE/i.test(sql)) {
      const result = originalExec(sql);
      writer = true;
      transactions++;
      return result;
    }
    if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) {
      try {
        return originalExec(sql);
      } finally {
        writer = false;
      }
    }
    return originalExec(sql);
  };
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.shutdown();
    app.locals.documentEvents.shutdown();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    app,
    store,
    teamId,
    actorId,
    otherTeam,
    taskIds,
    original,
    imageUrl,
    images,
    bytes,
    api,
    save,
    writer: () => writer,
    transactions: () => transactions,
  };
}

for (const linked of [false, true])
  test(`actual ${linked ? "linked" : "unlinked"} 64KiB document saves perform zero AST parses inside SQLite writer transactions`, async (t) => {
    const f = await fixture(t, { linked, coldBody: true }),
      events = parses(t, f.writer);
    const first = largeBody(f.imageUrl);
    assert.equal(Buffer.byteLength(first), 65536);
    ok(await f.save(first));
    assert.equal(
      events.length,
      linked ? 2 : 1,
      "linked cold base is parsed before BEGIN; unlinked saves need only desired",
    );
    assert.equal(events.filter((event) => event.writer).length, 0);
    assert.ok(
      f.transactions() > 0,
      "actual save executed a writer transaction",
    );
    const second = largeBody(f.imageUrl);
    ok(await f.save(second));
    assert.equal(
      events.length,
      linked ? 3 : 2,
      "continuous save reuses previous extraction and parses only the new desired body",
    );
    assert.equal(events.filter((event) => event.writer).length, 0);
    assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, second);
    assert.equal(f.store.readPending().length, linked ? 2 : 0);
    if (linked)
      assert.equal(
        f.store
          .readPending()
          .at(-1)
          .changes.find((change) => change.entity === "document").desired
          .markdown,
        second,
      );
  });

test("cached document syntax never caches team authorization or file existence", async (t) => {
  const f = await fixture(t),
    events = parses(t, f.writer),
    body = markdownFor(f.imageUrl);
  ok(await f.save(body));
  assert.equal(events.length, 1);
  assert.equal(
    (await f.save(body, { taskId: f.taskIds[2] })).status,
    400,
    "same cached string still fails foreign-team image check",
  );
  assert.equal(getTaskDocument(f.db, f.taskIds[2]).markdown, "");
  assert.equal(
    events.length,
    1,
    "foreign-team rejection used cached syntax, not a reparsing workaround",
  );
  rmSync(documentImagePath(f.images, f.imageUrl));
  assert.equal(
    (await f.save(body, { taskId: f.taskIds[1] })).status,
    400,
    "fresh file check rejects a removed image on a different document",
  );
  assert.equal(getTaskDocument(f.db, f.taskIds[1]).markdown, "");
  assert.equal(events.length, 1);
  writeDocumentImage(f.images, f.imageUrl, f.bytes);
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.actorId);
  assert.equal((await f.save(body, { taskId: f.taskIds[1] })).status, 403);
  assert.equal(f.store.readPending().length, 1);
  const workerStore = new R2ImageStore({ head: async () => null }, f.teamId);
  await assert.rejects(
    workerStore.validate(body),
    (error) => error.status === 400,
  );
  assert.throws(
    () => imageReferences({ markdown: body }, f.otherTeam),
    (error) => error.status === 400,
  );
  assert.equal(
    events.length,
    1,
    "Worker shares extraction but performs its own team and storage validation",
  );
});

test("failed capture flush rolls back document, audit and P; cached retry rechecks file and permission", async (t) => {
  const f = await fixture(t),
    events = parses(t, f.writer),
    body = markdownFor(f.imageUrl),
    operationId = randomUUID();
  const counts = () =>
    Object.fromEntries(
      ["audit", "sync_outbox", "document_versions"].map((table) => [
        table,
        f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
      ]),
    );
  const before = counts(),
    original = { ...getTaskDocument(f.db, f.taskIds[0]) },
    flush = f.db.syncCapture.flush;
  f.db.syncCapture.flush = () => {
    flush();
    throw new Error("fixture failure after capture flush");
  };
  try {
    assert.equal((await f.save(body, { operationId })).status, 500);
  } finally {
    f.db.syncCapture.flush = flush;
  }
  assert.deepEqual(counts(), before);
  assert.deepEqual({ ...getTaskDocument(f.db, f.taskIds[0]) }, original);
  assert.equal(events.length, 1);
  rmSync(documentImagePath(f.images, f.imageUrl));
  assert.equal((await f.save(body, { operationId })).status, 400);
  assert.deepEqual(counts(), before);
  writeDocumentImage(f.images, f.imageUrl, f.bytes);
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.actorId);
  assert.equal((await f.save(body, { operationId })).status, 403);
  assert.deepEqual(counts(), before);
  f.db
    .prepare("INSERT INTO memberships VALUES(?,?,'lead')")
    .run(f.actorId, f.teamId);
  const request = { operationId, expectedRevision: original.revision };
  const saved = ok(await f.save(body, request));
  const after = counts();
  assert.equal(f.store.readPending().length, 1);
  assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, body);
  assert.equal(ok(await f.save(body, request)).revision, saved.revision);
  assert.deepEqual(counts(), after, "successful retry remains idempotent");
  assert.equal(events.length, 1);
  assert.equal(events.filter((event) => event.writer).length, 0);
});

test("cached extraction cannot bypass untrusted operation base, desired or snapshot image validation", (t) => {
  const events = parses(t),
    owner = randomUUID(),
    teamId = randomUUID(),
    taskId = randomUUID(),
    repoId = randomUUID();
  const url = urlFor(owner),
    body = markdownFor(url),
    key = ["task", taskId, "main"],
    id = entityId("document", key);
  const record = {
    entity: "document",
    key,
    generation: randomUUID(),
    version: randomUUID(),
    deleted: false,
    payload: { title: "Document", position: 0, markdown: body },
  };
  const link = {
    team_id: teamId,
    repo_id: repoId,
    bootstrap_id: randomUUID(),
    writer_epoch: randomUUID(),
  };
  const identity = { teamId, repoId };
  withDocumentImageReferences(() => {
    assert.deepEqual(documentImageUrls(body), [url]);
    for (const [before, after] of [
      [null, record],
      [
        record,
        { ...record, payload: { ...record.payload, markdown: "safe desired" } },
      ],
    ]) {
      const operation = makeOperation({
        link,
        actorRef: randomUUID(),
        before: { [id]: before },
        after: { [id]: after },
      });
      assert.throws(
        () => validateOperation(operation, identity),
        /image reference/i,
      );
    }
    for (const deleted of [false, true])
      assert.throws(
        () =>
          validateSnapshot(
            {
              entities: { [id]: { ...record, deleted } },
              receipts: {},
              conflicts: {},
            },
            identity,
          ),
        /image reference/i,
      );
  });
  assert.equal(
    events.length,
    1,
    "every strict validator rejects using the same cached extraction",
  );
});
