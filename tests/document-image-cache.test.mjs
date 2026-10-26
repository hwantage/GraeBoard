import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDocumentImageReferenceCache,
  documentImageUrls,
  withDocumentImageReferences,
  withPreparedDocumentImageReferences,
} from "../shared/document-image-references.js";
import { createApp } from "../server/app.mjs";
import { createDocumentImagePreparation } from "../server/document-image-preparation.mjs";
import { openDatabase, insertTask, json, transaction } from "../server/db.mjs";
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
async function fixture(
  t,
  { linked = true, coldBody = false, extraTasks = 0, memory = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-image-cache-")),
    images = join(directory, "images"),
    databasePath = memory ? ":memory:" : join(directory, "data.sqlite"),
    db = openDatabase(databasePath),
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
  const taskIds = [
    teamId,
    teamId,
    otherTeam,
    ...Array(extraTasks).fill(teamId),
  ].map(
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
    await app.locals.documentPreparation?.close();
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
    databasePath,
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
  test(`actual ${linked ? "linked" : "unlinked"} 64KiB cold and changed document saves perform zero AST parses on the main thread`, async (t) => {
    const f = await fixture(t, { linked, coldBody: true }),
      events = parses(t, f.writer);
    const first = largeBody(f.imageUrl);
    assert.equal(Buffer.byteLength(first), 65536);
    ok(await f.save(first));
    assert.equal(
      events.length,
      0,
      "cold document extraction runs in the real background worker",
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
      0,
      "a new desired body also parses off the main thread",
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
  assert.equal(events.length, 0);
  assert.equal(
    (await f.save(body, { taskId: f.taskIds[2] })).status,
    400,
    "same cached string still fails foreign-team image check",
  );
  assert.equal(getTaskDocument(f.db, f.taskIds[2]).markdown, "");
  assert.equal(
    events.length,
    0,
    "foreign-team rejection used cached syntax, not a reparsing workaround",
  );
  rmSync(documentImagePath(f.images, f.imageUrl));
  assert.equal(
    (await f.save(body, { taskId: f.taskIds[1] })).status,
    400,
    "fresh file check rejects a removed image on a different document",
  );
  assert.equal(getTaskDocument(f.db, f.taskIds[1]).markdown, "");
  assert.equal(events.length, 0);
  writeDocumentImage(f.images, f.imageUrl, f.bytes);
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.actorId);
  assert.equal((await f.save(body, { taskId: f.taskIds[1] })).status, 403);
  assert.equal(f.store.readPending().length, 1);
  const beforeDirectChecks = events.length;
  await withDocumentImageReferences(async () => {
    documentImageUrls(body);
    const afterWarm = events.length;
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
      afterWarm,
      "Worker shares extraction but performs its own team and storage validation",
    );
  });
  assert.ok(events.length <= beforeDirectChecks + 1);
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
  assert.equal(events.length, 0);
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
  assert.equal(events.length, 0);
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

// Hold the real worker response, rather than faking parser output or relying on
// elapsed time. Every race occurs after parsing and before the repository commit.
async function duringPreparation(f, body, mutate) {
  const provider = f.app.locals.documentPreparation;
  assert.equal(typeof provider?.prepare, "function");
  const prepare = provider.prepare;
  let enter,
    release,
    intercepted = false;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  provider.prepare = async (...args) => {
    const result = await prepare.apply(provider, args);
    if (!intercepted) {
      intercepted = true;
      enter({ markdowns: args[0], result });
      await gate;
    }
    return result;
  };
  const pending = f.save(body);
  let failure;
  try {
    const prepared = await Promise.race([
      entered,
      pending.then((response) => {
        throw new Error(
          "Save completed before real worker preparation: " +
            JSON.stringify(response),
        );
      }),
    ]);
    assert.equal(f.writer(), false);
    assert.equal(
      f.transactions(),
      0,
      "preparation did not acquire SQLite's writer",
    );
    assert.ok(
      prepared.result.some(
        (row) => row.markdown === body && row.urls.includes(f.imageUrl),
      ),
    );
    await mutate(prepared);
  } catch (error) {
    failure = error;
  } finally {
    release();
    provider.prepare = prepare;
  }
  const result = await pending;
  if (failure) throw failure;
  return result;
}

test(
  "prepared cold save remains off-main-thread after more than eight other documents evict recent extraction entries",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { coldBody: true, extraTasks: 10 }),
      events = parses(t, f.writer);
    const body = largeBody(f.imageUrl);
    const response = await duringPreparation(f, body, async () => {
      for (const taskId of f.taskIds.slice(3))
        ok(await f.save(largeBody(f.imageUrl), { taskId }));
      assert.equal(
        getTaskDocument(f.db, f.taskIds[0]).markdown,
        f.original,
        "first save is still waiting",
      );
      assert.equal(
        events.length,
        0,
        "all unrelated cold HTTP saves also use the worker",
      );
    });
    ok(response);
    assert.equal(
      events.length,
      0,
      "prepared exact texts are pinned independently of the recent LRU",
    );
    assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, body);
    assert.equal(f.store.readPending().length, 11);
  },
);

for (const cause of ["membership", "session", "file"])
  test(
    `async document preflight rechecks ${cause} before commit`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, { coldBody: true }),
        events = parses(t, f.writer);
      const counts = () =>
        Object.fromEntries(
          ["audit", "document_versions", "sync_outbox"].map((table) => [
            table,
            f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
          ]),
        );
      const before = counts();
      const response = await duringPreparation(
        f,
        largeBody(f.imageUrl),
        async () => {
          if (cause === "membership")
            f.db
              .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
              .run(f.teamId, f.actorId);
          else if (cause === "session")
            f.db.prepare("DELETE FROM sessions WHERE user_id=?").run(f.actorId);
          else rmSync(documentImagePath(f.images, f.imageUrl));
        },
      );
      assert.equal(
        response.status,
        cause === "membership" ? 403 : cause === "session" ? 401 : 400,
        JSON.stringify(response),
      );
      assert.deepEqual(counts(), before);
      assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, f.original);
      assert.equal(events.length, 0);
    },
  );

for (const bumpRevision of [true, false])
  test(
    `async document preflight rejects a real second-connection body change ${bumpRevision ? "with a new revision" : "at the same revision"} without parsing it under the writer`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, { coldBody: true }),
        events = parses(t, f.writer);
      const newer = largeBody(f.imageUrl),
        desired = largeBody(f.imageUrl);
      const response = await duringPreparation(f, desired, async () => {
        const second = openDatabase(f.databasePath);
        try {
          transaction(second, () => {
            const version = storeDocumentVersion(second, {
              teamId: f.teamId,
              documentId: `${f.taskIds[0]}:main`,
              markdown: newer,
              actorId: f.actorId,
            });
            second
              .prepare(
                `UPDATE task_documents SET version_id=?,revision=revision+${bumpRevision ? 1 : 0},updated_at=? WHERE task_id=? AND id='main'`,
              )
              .run(version, new Date().toISOString(), f.taskIds[0]);
          });
        } finally {
          second.close();
        }
      });
      assert.equal(response.status, 409, JSON.stringify(response));
      assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, newer);
      assert.equal(f.store.readPending().length, 0);
      assert.equal(
        events.length,
        0,
        "newer unprepared text must not trigger AST fallback inside the failed save",
      );
    },
  );

test(
  "in-memory SQLite ordinary document saves use the same off-main-thread parser without a database-file dependency",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { linked: false, memory: true }),
      events = parses(t, f.writer);
    const body = largeBody(f.imageUrl);
    ok(await f.save(body));
    assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, body);
    assert.equal(events.length, 0);
  },
);

for (const [name, fault, code] of [
  ["crash", "throw new Error('parser fixture crash');", "CRASH"],
  [
    "invalid reply",
    "parentPort.postMessage({id: request.id, hashes: request.items.map(() => 'incorrect'), urls: request.items.map(() => [])});",
    "INVALID_REPLY",
  ],
  ["timeout", "/* Deliberately do not answer this message. */", "TIMEOUT"],
])
  test(
    `actual document HTTP parser ${name} preserves all state and permits retry with the same operation ID`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, { coldBody: true }),
        events = parses(t, f.writer),
        provider = f.app.locals.documentPreparation,
        prepare = provider.prepare;
      const directory = mkdtempSync(
        join(tmpdir(), "graeboard-http-parser-fault-"),
      );
      const file = join(directory, "worker.mjs");
      writeFileSync(
        file,
        `import { parentPort } from 'node:worker_threads';
parentPort.on('message', request => { ${fault} });\n`,
      );
      const faulty = createDocumentImagePreparation({
        workerUrl: pathToFileURL(file),
        timeoutMs: name === "timeout" ? 300 : 3000,
      });
      const beforeBody = { ...getTaskDocument(f.db, f.taskIds[0]) },
        body = largeBody(f.imageUrl),
        request = {
          operationId: randomUUID(),
          expectedRevision: beforeBody.revision,
        };
      const counts = () =>
        Object.fromEntries(
          ["audit", "document_versions", "sync_outbox"].map((table) => [
            table,
            f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
          ]),
        );
      const before = counts();
      let failure;
      provider.prepare = async (markdowns) => {
        try {
          return await faulty.prepare(markdowns);
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      try {
        const response = await f.save(body, request);
        assert.equal(response.status, 503, JSON.stringify(response));
        assert.equal(failure?.code, `DOCUMENT_IMAGE_PREPARATION_${code}`);
        assert.deepEqual(counts(), before);
        assert.deepEqual(
          { ...getTaskDocument(f.db, f.taskIds[0]) },
          beforeBody,
        );
        assert.equal(
          f.transactions(),
          0,
          "failed parser never enters the writer",
        );
        assert.equal(
          events.length,
          0,
          "parser failure has no synchronous fallback",
        );
      } finally {
        provider.prepare = prepare;
        await faulty.close();
        rmSync(directory, { recursive: true, force: true });
      }
      const saved = ok(await f.save(body, request));
      assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, body);
      assert.equal(f.store.readPending().length, 1);
      const after = counts();
      assert.equal(ok(await f.save(body, request)).revision, saved.revision);
      assert.deepEqual(
        counts(),
        after,
        "same operation retry remains idempotent",
      );
      assert.equal(events.length, 0);
    },
  );

test("prepared extraction pins only the two real worker texts and cannot fall back to an AST parse inside commit", async (t) => {
  const service = createDocumentImagePreparation();
  t.after(() => service.close());
  const url = urlFor(),
    current = markdownFor(url),
    desired = markdownFor(url),
    unexpected = markdownFor(url),
    afterSuccess = markdownFor(url),
    events = parses(t);
  const entries = await service.prepare([current, desired]);
  assert.equal(events.length, 0);
  assert.throws(
    () =>
      withPreparedDocumentImageReferences(entries, () => {
        assert.deepEqual(documentImageUrls(current), [url]);
        assert.deepEqual(documentImageUrls(desired), [url]);
        documentImageUrls(unexpected);
      }),
    /preparation does not match the current body/,
  );
  assert.equal(
    events.length,
    0,
    "unexpected text fails before any main-thread AST work",
  );
  assert.deepEqual(documentImageUrls(unexpected), [url]);
  assert.equal(
    events.length,
    1,
    "failed commit scope is gone on return to its caller",
  );
  assert.equal(
    withPreparedDocumentImageReferences(entries, () => {
      assert.deepEqual(documentImageUrls(current), [url]);
      return 42;
    }),
    42,
  );
  assert.deepEqual(documentImageUrls(afterSuccess), [url]);
  assert.equal(
    events.length,
    2,
    "successful commit scope is also gone on return",
  );
});

test(
  "overlapping identical HTTP saves both succeed while committing one document, audit and outbox operation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { coldBody: true }),
      events = parses(t, f.writer),
      provider = f.app.locals.documentPreparation,
      prepare = provider.prepare,
      body = largeBody(f.imageUrl),
      beforeBody = { ...getTaskDocument(f.db, f.taskIds[0]) },
      request = {
        operationId: randomUUID(),
        expectedRevision: beforeBody.revision,
      };
    const counts = () =>
      Object.fromEntries(
        ["audit", "document_versions", "sync_outbox"].map((table) => [
          table,
          f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
        ]),
      );
    const before = counts();
    const gates = Array.from({ length: 2 }, () => {
      let enter, release;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      return { entered, enter, wait, release };
    });
    let index = 0;
    provider.prepare = async (...args) => {
      const gate = gates[index++];
      assert.ok(gate, "only the two expected preparation calls occur");
      const result = await prepare.apply(provider, args);
      gate.enter(result);
      await gate.wait;
      return result;
    };
    const pending = [];
    let first, second, afterFirst;
    try {
      pending.push(f.save(body, request));
      await gates[0].entered;
      pending.push(f.save(body, request));
      await gates[1].entered;
      assert.deepEqual({ ...getTaskDocument(f.db, f.taskIds[0]) }, beforeBody);
      assert.equal(
        f.transactions(),
        0,
        "both requests prepared before either commit",
      );
      gates[0].release();
      first = ok(await pending[0]);
      afterFirst = counts();
      gates[1].release();
      second = ok(await pending[1]);
    } finally {
      for (const gate of gates) gate.release();
      provider.prepare = prepare;
      await Promise.allSettled(pending);
    }
    assert.equal(second.revision, first.revision);
    assert.equal(getTaskDocument(f.db, f.taskIds[0]).markdown, body);
    const after = counts();
    assert.deepEqual(
      after,
      afterFirst,
      "replay creates no version, audit or outbox row",
    );
    for (const table of ["audit", "sync_outbox"])
      assert.equal(
        after[table],
        before[table] + 1,
        `one ${table} record commits`,
      );
    assert.equal(f.store.readPending().length, 1);
    assert.equal(events.length, 0);
  },
);
