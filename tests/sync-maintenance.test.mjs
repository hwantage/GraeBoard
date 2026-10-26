import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, json } from "../server/db.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { materializeEntity } from "../server/sync/entities.mjs";
import { MaintenanceService } from "../server/sync/maintenance.mjs";
import { sqliteMaintenanceAdapter } from "../server/sync/maintenance-sqlite.mjs";
import {
  canonical,
  digest,
  entityId,
  stateHash,
} from "../server/sync/protocol.mjs";
import {
  activeImageReferences,
  isExcluded,
  retentionId,
} from "../server/sync/retention.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { recoverMaintenanceJob } from "../scripts/sync-maintenance-recover.mjs";

function fixture(t, options = {}) {
  const db = openDatabase(":memory:"),
    teamId = randomUUID(),
    siteId = randomUUID(),
    actorId = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Maintenance",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(actorId, "maintenance@example.com", "관리자", new Date().toISOString());
  t.after(() => db.close());
  const store = sqliteTeamStore(db, teamId);
  store.writeLink({
    repo_id: "repo",
    bootstrap_id: "bootstrap",
    installation_id: siteId,
    writer_epoch: "writer",
    profile_id: "profile",
    mode: "active",
    canonical_head: "canonical",
    updated_at: new Date().toISOString(),
  });
  const files = new Map(),
    archive = new Map(),
    created = new Map();
  const images = {
    list: () =>
      [...files].map(([url, data]) => ({
        url,
        size: data.length,
        createdAt: created.get(url),
      })),
    has: (url) => files.has(url),
    read: (url) => files.get(url),
    install: (url, bytes) => files.set(url, bytes),
    remove: (url) => files.delete(url),
  };
  const transport = {
    readFile: (_head, path) => archive.get(path) || null,
    readHead: () => "canonical",
    verifyReachable: (ancestor, head) => ancestor === head,
  };
  const adapter = sqliteMaintenanceAdapter({ db, teamId, siteId });
  const service = new MaintenanceService({
    teamId,
    siteId,
    siteName: "내부 서버",
    teamName: "Maintenance",
    adapter,
    images,
    transport,
    now: () => Date.parse("2026-10-27T00:00:00Z"),
    ...options,
  });
  const image = (name, { archived = true, young = false } = {}) => {
    const bytes = new TextEncoder().encode(name),
      url = `/api/document-images/${teamId}/${digest(bytes)}.webp`;
    files.set(url, bytes);
    created.set(url, young ? "2026-10-26T23:59:00Z" : "2025-01-01T00:00:00Z");
    if (archived)
      archive.set(url.replace("/api/document-images/", "images/"), bytes);
    return url;
  };
  const document = (id, year, urls = []) => {
    const record = {
      entity: "document",
      key: ["annual", String(year), id],
      generation: "generation-" + id,
      version: "version-" + id,
      payload: {
        title: id,
        position: 0,
        markdown: urls.map((url) => `![image](${url})`).join("\n"),
      },
      deleted: false,
    };
    store.putEntity(record);
    materializeEntity(db, teamId, record, { actorId });
    return record;
  };
  return {
    db,
    teamId,
    siteId,
    actorId,
    store,
    files,
    archive,
    images,
    adapter,
    transport,
    service,
    image,
    document,
  };
}

test("a cached image is not sufficient when the remote archive history was replaced", async (t) => {
  const f = fixture(t);
  f.document("doc", 2025, [f.image("archive")]);
  f.transport.readHead = () => "replaced-head";
  await assert.rejects(
    f.service.preview({ kind: "year", year: 2025 }, f.actorId),
    /Git 이력이 변경/,
  );
  assert.equal(f.files.size, 1);
  assert.equal(f.store.readExclusions().length, 0);
});

test("T11 local cleanup protects shared, pending, conflicting, recent and unarchived image references", async (t) => {
  const f = fixture(t),
    removable = f.image("remove"),
    shared = f.image("shared"),
    pending = f.image("pending"),
    conflict = f.image("conflict"),
    young = f.image("young", { young: true }),
    unarchived = f.image("unarchived", { archived: false });
  const hidden = f.document("hidden", 2025, [
    removable,
    shared,
    pending,
    conflict,
    young,
    unarchived,
  ]);
  const visible = f.document("visible", 2026, [shared]);
  const changed = {
    ...visible,
    payload: {
      ...visible.payload,
      markdown: `![image](${shared})\n![pending](${pending})`,
    },
  };
  const operation = makeOperation({
    link: f.store.readLink(),
    actorRef: f.actorId,
    before: { [entityId("document", visible.key)]: visible },
    after: { [entityId("document", visible.key)]: changed },
  });
  f.store.enqueue(operation);
  f.db.prepare("INSERT INTO sync_conflicts VALUES(?,?,?,?,NULL)").run(
    f.teamId,
    "conflict",
    "old-op",
    canonical({
      conflictId: "conflict",
      opId: "old-op",
      operation: {
        changes: [
          {
            entity: "document",
            desired: { markdown: `![conflict](${conflict})` },
          },
        ],
      },
      resolution: null,
    }),
  );
  const beforeState = stateHash(f.store.readState()),
    beforePending = canonical(f.store.readPending());
  const preview = await f.service.preview(
    { kind: "year", year: 2025 },
    f.actorId,
  );
  assert.equal(preview.images.count, 1);
  assert.deepEqual(preview.protected.map((row) => row.count).sort(), [1, 1, 3]);
  const result = await f.service.execute(
    { token: preview.token, confirmed: true },
    f.actorId,
  );
  assert.equal(result.phase, "complete");
  assert.equal(result.deleted.count, 1);
  assert.equal(f.files.has(removable), false);
  for (const url of [shared, pending, conflict, young, unarchived])
    assert.ok(f.files.has(url));
  assert.equal(stateHash(f.store.readState()), beforeState);
  assert.equal(canonical(f.store.readPending()), beforePending);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM annual_memos").get().n, 2);
  const exclusions = f.store.readExclusions(f.siteId);
  assert.equal(isExcluded(hidden, f.store.readState(), exclusions), true);
  assert.equal(isExcluded(visible, f.store.readState(), exclusions), false);
});

test("T11 restoration installs archived images before removing L and advances stale edit revisions", async (t) => {
  const f = fixture(t),
    url = f.image("restore"),
    doc = f.document("doc", 2025, [url]);
  const revision = () =>
    f.db.prepare("SELECT revision FROM annual_memos WHERE id=?").get("doc")
      .revision;
  const before = revision(),
    original = stateHash(f.store.readState());
  const preview = await f.service.preview(
    {
      kind: "document",
      entity: "document",
      key: doc.key,
      generation: doc.generation,
    },
    f.actorId,
  );
  await f.service.execute({ token: preview.token, confirmed: true }, f.actorId);
  const afterCleanup = revision();
  assert.ok(afterCleanup > before);
  const [retention] = f.store.readExclusions();
  assert.equal(f.files.has(url), false);
  const install = f.images.install;
  f.images.install = (url, bytes) => {
    assert.equal(f.store.readExclusions().length, 1);
    install(url, bytes);
  };
  const result = await f.service.restore(
    {
      retentionId: retentionId(retention),
      expectedRevision: retention.revision,
    },
    f.actorId,
  );
  assert.equal(result.phase, "complete");
  assert.equal(f.files.has(url), true);
  assert.deepEqual(f.store.readExclusions(), []);
  assert.ok(revision() > afterCleanup);
  assert.equal(stateHash(f.store.readState()), original);
});

test("preview is bound to actor, fresh data, expiry and exclusive backup/sync ownership", async (t) => {
  const f = fixture(t);
  f.document("doc", 2025, [f.image("a")]);
  let preview = await f.service.preview(
    { kind: "year", year: 2025 },
    f.actorId,
  );
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, "other"),
    /만료/,
  );
  f.store.writeLink({ generation: 1 });
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, f.actorId),
    /자료가 변경/,
  );
  preview = await f.service.preview({ kind: "year", year: 2025 }, f.actorId);
  f.db
    .prepare("INSERT INTO site_maintenance_jobs VALUES(?,?,?,?,?,?,?)")
    .run("backup", f.teamId, "backup", "running", "{}", "{}", "now");
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, f.actorId),
    /백업/,
  );
  f.db
    .prepare(
      "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id='backup'",
    )
    .run();
  f.store.writeLink({
    lease_owner: "sync",
    lease_until: Date.parse("2027-01-01"),
  });
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, f.actorId),
    /동기화 실행/,
  );
  f.store.writeLink({ lease_owner: null, lease_until: null });
  const job = await f.adapter.readJob(preview.token);
  job.manifest.expiresAt = 0;
  f.db
    .prepare("UPDATE site_maintenance_jobs SET manifest=? WHERE job_id=?")
    .run(canonical(job.manifest), job.jobId);
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, f.actorId),
    /만료/,
  );
  assert.equal(f.files.size, 1);
  assert.equal(f.store.readExclusions().length, 0);
});

test("deletion chunks are resumable and archive failure never exposes missing local data", async (t) => {
  const f = fixture(t, { chunkSize: 1 }),
    first = f.image("first"),
    second = f.image("second");
  f.document("doc", 2025, [first, second]);
  const preview = await f.service.preview(
    { kind: "year", year: 2025 },
    f.actorId,
  );
  const path = first.replace("/api/document-images/", "images/"),
    archive = f.archive.get(path);
  f.archive.delete(path);
  await assert.rejects(
    f.service.execute({ token: preview.token, confirmed: true }, f.actorId),
    /보관 사본/,
  );
  assert.equal(f.files.size, 2);
  assert.equal(f.store.readExclusions().length, 0);
  assert.equal((await f.adapter.readJob(preview.token)).phase, "failed");
  f.archive.set(path, archive);
  const verifying = await f.service.resume(preview.token);
  assert.equal(verifying.phase, "verifying");
  assert.equal(verifying.deleted.count, 0);
  assert.equal(f.store.readExclusions().length, 0);
  const result = await f.service.resume(preview.token);
  assert.equal(result.hasMore, true);
  assert.equal(result.deleted.count, 1);
  const current = await f.adapter.readJob(preview.token);
  assert.equal(current.phase, "deleting");
  const [retention] = f.store.readExclusions();
  await assert.rejects(
    f.service.restore(
      {
        retentionId: retentionId(retention),
        expectedRevision: retention.revision,
      },
      f.actorId,
    ),
    /다른 정리/,
  );
  const done = await f.service.resume(preview.token);
  assert.equal(done.phase, "complete");
  assert.equal(done.deleted.count, 2);
  assert.equal(f.files.size, 0);
  await assert.rejects(f.service.resume(preview.token), /계속할/);
});

test("an active executor cannot be stolen just because a clock lease expired", async (t) => {
  const f = fixture(t);
  f.document("doc", 2025, [f.image("a")]);
  const preview = await f.service.preview(
      { kind: "year", year: 2025 },
      f.actorId,
    ),
    job = await f.adapter.readJob(preview.token);
  await f.adapter.begin(job, {
    actorId: f.actorId,
    now: 1,
    revision: preview.revision,
  });
  await f.adapter.claim(job.jobId, "first-executor", 1);
  await assert.rejects(
    Promise.resolve().then(() =>
      f.adapter.claim(job.jobId, "second-executor", 100000000),
    ),
    /이미 실행/,
  );
  const canonicalBefore = stateHash(f.store.readState());
  assert.throws(
    () => recoverMaintenanceJob(f.db, { jobId: job.jobId }),
    /confirm-drained/,
  );
  const dry = recoverMaintenanceJob(f.db, { jobId: job.jobId, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(
    (await f.adapter.readJob(job.jobId)).progress.owner,
    "first-executor",
  );
  const recovered = recoverMaintenanceJob(f.db, {
    jobId: job.jobId,
    confirmedDrained: true,
  });
  assert.equal(recovered.phase, "failed");
  assert.equal((await f.adapter.readJob(job.jobId)).progress.owner, undefined);
  assert.equal((await f.adapter.listJob()).jobId, job.jobId);
  assert.equal(stateHash(f.store.readState()), canonicalBefore);
  assert.equal((await f.service.resume(job.jobId)).phase, "complete");
});

test("restore keeps L until every image chunk is installed", async (t) => {
  const f = fixture(t, { chunkSize: 1 }),
    first = f.image("restore-first"),
    second = f.image("restore-second");
  f.document("doc", 2025, [first, second]);
  const preview = await f.service.preview(
    { kind: "year", year: 2025 },
    f.actorId,
  );
  let result = await f.service.execute(
    { token: preview.token, confirmed: true },
    f.actorId,
  );
  while (result.hasMore) result = await f.service.resume(result.jobId);
  const [retention] = f.store.readExclusions();
  const partial = await f.service.restore(
    {
      retentionId: retentionId(retention),
      expectedRevision: retention.revision,
    },
    f.actorId,
  );
  assert.equal(partial.kind, "restore");
  assert.equal(partial.hasMore, true);
  assert.equal(f.files.size, 1);
  assert.equal(f.store.readExclusions().length, 1);
  assert.equal((await f.service.resume(partial.jobId)).phase, "complete");
  assert.equal(f.files.size, 2);
  assert.equal(f.store.readExclusions().length, 0);
});

test("L generation and multi-year rules are identical for internal and external projections", () => {
  const task = {
      entity: "task",
      key: ["t"],
      generation: "g",
      payload: { years: [2025, 2026] },
    },
    document = {
      entity: "document",
      key: ["task", "t", "d"],
      generation: "g",
      payload: { markdown: "" },
    };
  const state = { [entityId("task", task.key)]: task };
  const years = [{ kind: "year", entity_key: '["2025"]', generation: "" }];
  assert.equal(isExcluded(task, state, years), false);
  assert.equal(isExcluded(document, state, years), false);
  years.push({ kind: "year", entity_key: '["2026"]', generation: "" });
  assert.equal(isExcluded(document, state, years), true);
  assert.equal(
    isExcluded(document, state, [
      { kind: "document", key: document.key, generation: "old" },
    ]),
    false,
  );
  assert.equal(
    isExcluded(document, state, [
      { kind: "document", key: document.key, generation: "g" },
    ]),
    true,
  );
  const urls = activeImageReferences(
    { entities: {}, conflicts: {} },
    [],
    [],
    {},
  );
  assert.equal(urls.size, 0);
});
