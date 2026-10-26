import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { openDatabase, json } from "../server/db.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import {
  writeDocumentImage,
  documentImagePath,
} from "../server/document-images.mjs";
import {
  verifyTransferAssets,
  exportTransferAssets,
} from "../server/storage/logical-assets.mjs";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import { SqliteDatabase, sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import {
  exportTeam,
  importTeam,
  freezeTeam,
  releaseTransfer,
} from "../server/storage/logical-transfer.mjs";
import { verifyTransfer } from "../server/storage/logical-format.mjs";
import {
  S3ImageStore,
  backupExternal,
  restoreExternal,
  readExternalBackup,
} from "../server/storage/external-backup.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import {
  canonical,
  digest,
  entityId,
  stateHash,
} from "../server/sync/protocol.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { reduce } from "../server/sync/reducer.mjs";

function sourceFixture(dir) {
  const db = openDatabase(join(dir, "source.sqlite")),
    adapter = new SqliteDatabase(db),
    teamId = randomUUID(),
    userId = randomUUID(),
    taskId = randomUUID(),
    docId = randomUUID(),
    visibleDocId = randomUUID(),
    createdAt = new Date().toISOString();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "이관 검증",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,'original-secret-hash',?)",
  ).run(userId, "source@example.test", "보존 이름", createdAt);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).run(taskId, teamId, "[2026]", 0, userId, createdAt, createdAt);
  db.prepare(
    "INSERT INTO cells(task_id,key,value,version) VALUES(?,?,?,?)",
  ).run(taskId, "title", json("original"), 13);
  const archivedBytes = Buffer.from("archived-image"),
    activeBytes = Buffer.from("active-image"),
    pendingBytes = Buffer.from("unpublished-pending-image"),
    pendingUrl = `/api/document-images/${teamId}/${digest(pendingBytes)}.webp`,
    archivedUrl = `/api/document-images/${teamId}/${digest(archivedBytes)}.webp`,
    activeUrl = `/api/document-images/${teamId}/${digest(activeBytes)}.webp`;
  for (const [id, url] of [
    [docId, archivedUrl],
    [visibleDocId, activeUrl],
  ]) {
    const version = storeDocumentVersion(db, {
      teamId,
      documentId: canonical(["task", taskId, id]),
      markdown: "![image](" + url + ")",
      actorId: userId,
    });
    db.prepare(
      "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,?,?,1,21,?,?)",
    ).run(
      taskId,
      id,
      id === docId ? "archived" : "active",
      0,
      version,
      createdAt,
      userId,
    );
  }
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
    randomUUID(),
    teamId,
    userId,
    "edit",
    "cell",
    null,
    "{}",
    createdAt,
  );
  const store = sqliteTeamStore(db, teamId);
  store.writeLink({
    repo_id: randomUUID(),
    bootstrap_id: randomUUID(),
    installation_id: randomUUID(),
    writer_epoch: randomUUID(),
    profile_id: "source",
    mode: "active",
    updated_at: createdAt,
  });
  const link = store.readLink();
  let state = { entities: allEntities(db, link), receipts: {}, conflicts: {} };
  const key = entityId("cell", [taskId, "title"]),
    record = state.entities[key];
  const conflict = makeOperation({
    link,
    actorRef: userId,
    before: {
      [key]: {
        ...record,
        payload: { ...record.payload, value: "different base" },
      },
    },
    after: {
      [key]: {
        ...record,
        payload: { ...record.payload, value: "conflicting submission" },
      },
    },
  });
  state = reduce(state, conflict).state;
  assert.equal(Object.values(state.conflicts).length, 1);
  store.writeState(state, "a".repeat(40));
  store.advanceHead(null, "a".repeat(40), stateHash(state));
  const visibleKey = entityId("document", ["task", taskId, visibleDocId]),
    visible = state.entities[visibleKey],
    desired = {
      ...visible,
      payload: {
        ...visible.payload,
        markdown: visible.payload.markdown + "\n![pending](" + pendingUrl + ")",
      },
    };
  const pending = makeOperation({
    link: store.readLink(),
    actorRef: userId,
    before: { [key]: record, [visibleKey]: visible },
    after: {
      [key]: {
        ...record,
        payload: { ...record.payload, value: "local pending" },
      },
      [visibleKey]: desired,
    },
  });
  store.enqueue(pending);
  const pendingVersion = storeDocumentVersion(db, {
    teamId,
    documentId: canonical(desired.key),
    markdown: desired.payload.markdown,
    actorId: userId,
  });
  db.prepare(
    "UPDATE task_documents SET version_id=?,revision=22 WHERE task_id=? AND id=?",
  ).run(pendingVersion, taskId, visibleDocId);
  db.prepare(
    "UPDATE cells SET value=?,version=14 WHERE task_id=? AND key='title'",
  ).run(json("local pending"), taskId);
  const doc = state.entities[entityId("document", ["task", taskId, docId])];
  store.putExclusion({
    siteId: link.installation_id,
    kind: "document",
    key: doc.key,
    generation: doc.generation,
    revision: 7,
    createdAt,
  });
  db.prepare("DELETE FROM task_documents WHERE task_id=? AND id=?").run(
    taskId,
    docId,
  );
  store.nextRevision("cell", [taskId, "title"]);
  store.appendEvent("changed", { teamId });
  store.putObject(
    digest(new Uint8Array([0, 255, 3])),
    "binary",
    new Uint8Array([0, 255, 3]),
  );
  return {
    db,
    adapter,
    teamId,
    userId,
    taskId,
    docId,
    visibleDocId,
    archivedBytes,
    activeBytes,
    pendingBytes,
    pendingUrl,
    archivedUrl,
    activeUrl,
    pending,
    state,
  };
}

test("SQLite logical export freezes writes, verifies checksums and restores exact protocol and revision state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gb-transfer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = sourceFixture(dir);
  t.after(() => f.db.close());
  await assert.rejects(exportTeam(f.adapter, f.teamId), /freeze|Pause/);
  const job = await freezeTeam(f.adapter, f.teamId),
    bundle = await exportTeam(f.adapter, f.teamId, { omitJobId: job });
  assert.equal(bundle.payload.tables.site_maintenance_jobs.length, 0);
  assert.equal(f.adapter.readLink(f.teamId).mode, "paused");
  assert.equal(JSON.stringify(bundle).includes("original-secret-hash"), false);
  const corrupted = structuredClone(bundle);
  corrupted.payload.tables.sync_outbox[0].payload += " ";
  assert.throws(() => verifyTransfer(corrupted), /checksum/);
  const target = openDatabase(join(dir, "target.sqlite"));
  t.after(() => target.close());
  const adapter = new SqliteDatabase(target);
  await importTeam(adapter, bundle);
  assert.equal(stateHash(adapter.readState(f.teamId)), stateHash(f.state));
  assert.deepEqual(adapter.readPending(f.teamId), [f.pending]);
  assert.equal(adapter.readLink(f.teamId).mode, "recovery");
  assert.notEqual(
    adapter.readLink(f.teamId).writer_epoch,
    f.adapter.readLink(f.teamId).writer_epoch,
  );
  assert.equal(
    target
      .prepare("SELECT version FROM cells WHERE task_id=? AND key='title'")
      .get(f.taskId).version,
    14,
  );
  assert.equal(
    target
      .prepare("SELECT revision FROM task_documents WHERE task_id=? AND id=?")
      .get(f.taskId, f.visibleDocId).revision,
    22,
  );
  assert.equal(
    target.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    3,
  );
  assert.equal(target.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  assert.equal(
    target.prepare("SELECT active,password FROM users WHERE id=?").get(f.userId)
      .active,
    0,
  );
  await assert.rejects(importTeam(adapter, bundle), /empty target/);
  const historyOnly = openDatabase(join(dir, "history-only.sqlite"));
  t.after(() => historyOnly.close());
  historyOnly
    .prepare("INSERT INTO teams VALUES(?,?,?)")
    .run(f.teamId, "Existing history", json(DEFAULT_SETTINGS));
  historyOnly
    .prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,'retained','Retained','!',?)",
    )
    .run(f.userId, new Date().toISOString());
  storeDocumentVersion(historyOnly, {
    teamId: f.teamId,
    documentId: "retained",
    markdown: "Keep existing history",
    actorId: f.userId,
  });
  await assert.rejects(
    importTeam(new SqliteDatabase(historyOnly), bundle),
    /empty target/,
  );
  assert.equal(
    historyOnly.prepare("SELECT markdown FROM document_versions").get()
      .markdown,
    "Keep existing history",
  );
  let archivedReads = 0;
  await exportTransferAssets(bundle, join(dir, "archive-assets"), {
    images: {
      async read(url) {
        return url === f.activeUrl
          ? f.activeBytes
          : url === f.pendingUrl
            ? f.pendingBytes
            : null;
      },
    },
    async readArchive(url) {
      assert.equal(url, f.archivedUrl);
      archivedReads++;
      return f.archivedBytes;
    },
  });
  assert.equal(archivedReads, 1);
  assert.equal(
    (await verifyTransferAssets(bundle, join(dir, "archive-assets"))).size,
    3,
  );
  await assert.rejects(
    exportTransferAssets(bundle, join(dir, "missing-assets"), {
      images: {
        async read() {
          return null;
        },
      },
    }),
    /unavailable/,
  );
  assert.equal(existsSync(join(dir, "missing-assets")), false);
  const cliPath = join(dir, "cli-empty.sqlite"),
    bundlePath = join(dir, "cli-bundle.json");
  const command = (args) => {
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sourceImages = join(dir, "source-images"),
    targetImages = join(dir, "target-images");
  for (const [url, bytes] of [
    [f.activeUrl, f.activeBytes],
    [f.archivedUrl, f.archivedBytes],
    [f.pendingUrl, f.pendingBytes],
  ])
    writeDocumentImage(sourceImages, url, bytes);
  command([
    "scripts/transfer.mjs",
    "--action",
    "export",
    "--engine",
    "sqlite",
    "--database",
    join(dir, "source.sqlite"),
    "--team-id",
    f.teamId,
    "--job-id",
    job,
    "--file",
    bundlePath,
    "--images-dir",
    sourceImages,
  ]);
  command([
    "scripts/migrate.mjs",
    "--engine",
    "sqlite",
    "--database",
    cliPath,
    "--initialize",
  ]);
  command([
    "scripts/transfer.mjs",
    "--action",
    "import",
    "--engine",
    "sqlite",
    "--database",
    cliPath,
    "--file",
    bundlePath,
    "--dry-run",
  ]);
  const empty = openDatabase(cliPath);
  assert.equal(empty.prepare("SELECT COUNT(*) n FROM teams").get().n, 0);
  empty.close();
  command([
    "scripts/transfer.mjs",
    "--action",
    "import",
    "--engine",
    "sqlite",
    "--database",
    cliPath,
    "--file",
    bundlePath,
    "--images-dir",
    targetImages,
  ]);
  assert.ok(existsSync(documentImagePath(targetImages, f.pendingUrl)));
  assert.ok(existsSync(documentImagePath(targetImages, f.activeUrl)));
  assert.equal(
    existsSync(documentImagePath(targetImages, f.archivedUrl)),
    false,
  );
  const sidecar = JSON.parse(readFileSync(bundlePath, "utf8"));
  assert.equal(
    (await verifyTransferAssets(sidecar, bundlePath + ".assets")).size,
    3,
  );
  const imported = openDatabase(cliPath);
  assert.equal(imported.prepare("SELECT id FROM teams").get().id, f.teamId);
  assert.equal(
    imported
      .prepare("SELECT value FROM cells WHERE task_id=? AND key='title'")
      .get(f.taskId).value,
    json("local pending"),
  );
  imported.close();
  await releaseTransfer(f.adapter, f.teamId, job);
  assert.equal(f.adapter.readLink(f.teamId).mode, "paused");
});

class MockS3 {
  constructor(objects = []) {
    this.objects = new Map(objects);
    this.puts = [];
  }
  async send(command) {
    const p = command.input;
    if (command.constructor.name === "GetObjectCommand") {
      const bytes = this.objects.get(p.Key);
      if (!bytes)
        throw Object.assign(new Error("missing"), {
          $metadata: { httpStatusCode: 404 },
        });
      return { Body: { transformToByteArray: async () => bytes } };
    }
    if (command.constructor.name === "PutObjectCommand") {
      this.objects.set(p.Key, new Uint8Array(p.Body));
      this.puts.push(p.Key);
      return {};
    }
    if (command.constructor.name === "ListObjectsV2Command")
      return {
        Contents: [...this.objects]
          .filter(([key]) => key.startsWith(p.Prefix))
          .map(([Key, bytes]) => ({ Key, Size: bytes.length })),
        IsTruncated: false,
      };
    throw new Error("Unexpected S3 operation");
  }
}
test("actual PostgreSQL roundtrip and complete R2/Git backup preserve C/P/L and do not restore excluded images", async (t) => {
  const bin = process.env.TEST_PG_BIN;
  if (!bin || !existsSync(join(bin, "postgres"))) {
    t.skip(
      "Set TEST_PG_BIN for actual isolated PostgreSQL transfer/backup coverage",
    );
    return;
  }
  const dir = mkdtempSync("/tmp/gb-transfer-pg-"),
    data = join(dir, "pg"),
    pools = [];
  let started = false;
  const cmd = (name, args) => {
    const r = spawnSync(join(bin, name), args, {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  t.after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (started) cmd("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });
  cmd("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  cmd("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-F -h '' -k ${dir} -p 5432`,
    "-w",
    "start",
  ]);
  started = true;
  const admin = new Pool({
    host: dir,
    user: process.env.USER,
    database: "postgres",
  });
  pools.push(admin);
  const database = async (name, scope, teamId) => {
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new Pool({
      host: dir,
      user: process.env.USER,
      database: name,
      max: 2,
    });
    pools.push(pool);
    await migratePostgres(pool, { scope, teamId, initialize: true });
    return new PostgresDatabase(pool, { scope, teamId });
  };
  const f = sourceFixture(dir);
  t.after(() => f.db.close());
  const job = await freezeTeam(f.adapter, f.teamId),
    bundle = await exportTeam(f.adapter, f.teamId, { omitJobId: job });
  const postgres = await database("team_source", "team", f.teamId);
  await importTeam(postgres, bundle);
  // Exercise the documented app grants, including sequence UPDATE needed by
  // setval when importing preserved cursor/local_seq values. No schema-owner or
  // superuser fallback is available to this target adapter.
  const restrictedOwner = await database("team_restricted", "team", f.teamId);
  await admin.query("CREATE ROLE graeboard_app LOGIN");
  await restrictedOwner.pool.query(
    "GRANT USAGE ON SCHEMA graeboard TO graeboard_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA graeboard TO graeboard_app; GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA graeboard TO graeboard_app",
  );
  const restrictedPool = new Pool({
    host: dir,
    user: "graeboard_app",
    database: "team_restricted",
    max: 2,
  });
  pools.push(restrictedPool);
  const restricted = new PostgresDatabase(restrictedPool, { teamId: f.teamId });
  assert.equal((await restricted.health()).ready, true);
  await importTeam(restricted, bundle);
  await assert.rejects(
    restrictedPool.query("CREATE TABLE graeboard.forbidden(id int)"),
    (error) => error.code === "42501",
  );
  assert.deepEqual(await restricted.readPending(f.teamId), [f.pending]);
  assert.equal(
    stateHash(await postgres.readState(f.teamId)),
    stateHash(f.state),
  );
  assert.deepEqual(await postgres.readPending(f.teamId), [f.pending]);
  const roundtrip = await exportTeam(postgres, f.teamId),
    sqlite = openDatabase(join(dir, "roundtrip.sqlite"));
  t.after(() => sqlite.close());
  const target = new SqliteDatabase(sqlite);
  await importTeam(target, roundtrip);
  assert.equal(stateHash(target.readState(f.teamId)), stateHash(f.state));
  assert.equal(
    sqlite
      .prepare("SELECT version FROM cells WHERE task_id=? AND key='title'")
      .get(f.taskId).version,
    14,
  );
  assert.deepEqual(
    target.readSnapshot(f.teamId).exclusions,
    f.adapter.readSnapshot(f.teamId).exclusions,
  );
  const control = await database("control_source", "control");
  await control.withControlTransaction((tx) =>
    tx.query(
      "INSERT INTO users(id,username,email,name,system_role,created_at) VALUES($1,'admin','admin@example.test','Admin','admin',$2)",
      [f.userId, new Date().toISOString()],
    ),
  );
  const sourceS3 = new MockS3([
      [f.activeUrl.replace("/api/document-images/", "images/"), f.activeBytes],
      [
        f.pendingUrl.replace("/api/document-images/", "images/"),
        f.pendingBytes,
      ],
    ]),
    images = new S3ImageStore({
      bucket: "synthetic",
      teamId: f.teamId,
      client: sourceS3,
    }),
    reads = [];
  const git = {
    async readFile(oid, path) {
      reads.push({ oid, path });
      assert.equal(oid, "a".repeat(40));
      assert.equal(
        path,
        f.archivedUrl.replace("/api/document-images/", "images/"),
      );
      return f.archivedBytes;
    },
  };
  const output = join(dir, "backup");
  await backupExternal({
    control,
    teams: [{ adapter: postgres, teamId: f.teamId, images, git }],
    destination: output,
  });
  assert.ok(reads.length);
  assert.equal(sourceS3.puts.length, 0);
  assert.equal((await readExternalBackup(output)).teams[0].images.size, 3);
  const restored = await database("team_restored", "team", f.teamId),
    restoredControl = await database("control_restored", "control"),
    targetS3 = new MockS3(),
    targetImages = new S3ImageStore({
      bucket: "new-synthetic",
      teamId: f.teamId,
      client: targetS3,
    });
  await restoreExternal({
    source: output,
    control: restoredControl,
    teams: [{ adapter: restored, teamId: f.teamId, images: targetImages }],
  });
  assert.equal(
    stateHash(await restored.readState(f.teamId)),
    stateHash(f.state),
  );
  assert.equal((await restored.readLink(f.teamId)).mode, "recovery");
  assert.ok(await targetImages.read(f.activeUrl));
  assert.equal(await targetImages.read(f.archivedUrl), null);
  assert.equal(targetS3.puts.length, 2);
  assert.equal(
    (
      await restoredControl.withControlTransaction((tx) =>
        tx.query("SELECT COUNT(*) n FROM users"),
      )
    ).rows[0].n,
    "1",
  );
  // A crash after one database committed can safely resume the same complete
  // backup without wiping that target or duplicating immutable operations.
  const epoch = (await restored.readLink(f.teamId)).writer_epoch;
  await restoreExternal({
    source: output,
    control: restoredControl,
    teams: [{ adapter: restored, teamId: f.teamId, images: targetImages }],
  });
  assert.equal((await restored.readLink(f.teamId)).writer_epoch, epoch);
  assert.deepEqual(await restored.readPending(f.teamId), [f.pending]);
  const bulk = await database("bulk_contract", "team", f.teamId),
    patch = { entities: [], receipts: [], conflicts: [] };
  for (let i = 0; i < 1101; i++)
    patch.entities.push([
      "person",
      canonical([randomUUID()]),
      "g",
      "v",
      canonical({ name: "person " + i }),
      0,
    ]);
  let statements = 0;
  const connect = bulk.pool.connect.bind(bulk.pool);
  bulk.pool.connect = async () => {
    const client = await connect(),
      query = client.query.bind(client),
      release = client.release.bind(client);
    client.query = (sql, params) => {
      if (/^INSERT INTO sync_entities/.test(sql)) statements++;
      return query(sql, params);
    };
    client.release = () => {
      client.query = query;
      client.release = release;
      release();
    };
    return client;
  };
  await assert.rejects(
    bulk.withTeamTransaction(f.teamId, async (tx) => {
      await tx.sync.writeState(null, "head", null, patch);
      throw new Error("rollback batched canonical rows");
    }),
    /rollback batched/,
  );
  assert.equal(statements, 3);
  assert.equal(
    Object.keys((await bulk.readState(f.teamId)).entities).length,
    0,
  );
  await bulk.withTeamTransaction(f.teamId, (tx) =>
    tx.sync.writeState(null, "head", null, patch),
  );
  assert.equal(statements, 6);
  assert.equal(
    Object.keys((await bulk.readState(f.teamId)).entities).length,
    1101,
  );
  const path = join(
    output,
    f.teamId,
    "images",
    digest(f.activeBytes) + ".webp",
  );
  writeFileSync(path, "corrupt");
  await assert.rejects(readExternalBackup(output), /checksum/);
});
