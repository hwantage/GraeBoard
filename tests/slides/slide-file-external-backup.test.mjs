import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { migratePostgres } from "../../server/migrations/postgres.mjs";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";
import { PostgresDatabase } from "../../worker/storage/postgres.mjs";
import { PostgresSlideFileRepository } from "../../worker/storage/slides/postgres-slide-files.mjs";
import {
  backupExternal,
  readExternalBackup,
  restoreExternal,
} from "../../server/storage/transfer/external-backup.mjs";
import { S3SlideBlobStore } from "../../server/storage/slides/slide-file-external-backup.mjs";
import { SLIDE_THUMBNAIL_VERSION } from "../../shared/slides/slide-file-rules.js";
import { slideThumbnailKey } from "../../worker/storage/slides/r2-slide-blobs.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slide = (text) => Buffer.from(JSON.stringify({ version: 1, name: text }));

// The S3 API of a bucket, kept in memory; also usable as the R2 binding.
class MemoryBucket {
  objects = new Map();
  puts = 0;
  downloads = 0;
  // Downloads collected into one array instead of read in pieces.
  buffered = 0;
  async send(command) {
    const { Key, Body } = command.input;
    if (command.constructor.name === "PutObjectCommand") {
      this.puts++;
      this.objects.set(Key, Uint8Array.from(Body));
      return {};
    }
    const bytes = this.objects.get(Key);
    if (!bytes)
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    this.downloads++;
    return {
      ContentLength: bytes.length,
      Body: {
        transformToByteArray: async () => {
          this.buffered++;
          return bytes;
        },
        // In Node the SDK's body is also a stream of pieces.
        async *[Symbol.asyncIterator]() {
          yield bytes.subarray(0, 8);
          yield bytes.subarray(8);
        },
      },
    };
  }
  put = async (key, bytes) =>
    void this.objects.set(key, Uint8Array.from(bytes));
  get = async (key) => {
    const bytes = this.objects.get(key);
    return bytes && { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  };
  head = async (key) => (this.objects.has(key) ? { key } : null);
  delete = async (key) => void this.objects.delete(key);
}
const noImages = {
  list: async () => [],
  read: async () => null,
  install: async () => {},
};
// Whole slide files of a backup in memory at once. readFile is the call that
// loads a complete file, and a loaded file is needed until the bucket has
// stored it.
function trackSlideLoads(t, bucket) {
  const readFile = fs.promises.readFile;
  const loads = { count: 0, peak: 0 };
  fs.promises.readFile = (path, ...rest) => {
    if (String(path).endsWith(".canvaslide")) {
      loads.count++;
      loads.peak = Math.max(loads.peak, loads.count - bucket.puts);
    }
    return readFile(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.promises.readFile = readFile;
    syncBuiltinESMExports();
  });
  return loads;
}

async function source(t, { slides = true } = {}) {
  const pg = await postgresBusinessFixture(t);
  if (!pg) return null;
  const directory = mkdtempSync(join(tmpdir(), "slide-external-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bucket = new MemoryBucket();
  const state = { pg, directory, bucket, teamId: pg.teamId };
  // A new, empty team database in the same cluster to restore into.
  state.target = async (name, { slideSchema = true } = {}) => {
    await pg.control.query(`CREATE DATABASE ${name}`);
    const pool = new Pool({
      connectionString: pg.env.PG_TEAM.connectionString.replace(
        "/team?",
        `/${name}?`,
      ),
    });
    t.after(() => pool.end());
    await migratePostgres(pool, {
      scope: "team",
      teamId: pg.teamId,
      initialize: true,
    });
    if (slideSchema) await migrateSlideSchema(pool);
    const targetBucket = new MemoryBucket();
    return {
      pool,
      bucket: targetBucket,
      adapter: new PostgresDatabase(pool, { teamId: pg.teamId }),
      slides: new S3SlideBlobStore({
        client: targetBucket,
        bucket: "target",
        teamId: pg.teamId,
      }),
      repository: new PostgresSlideFileRepository({
        pool,
        bucket: targetBucket,
        teamId: pg.teamId,
      }),
    };
  };
  state.backup = (destination) =>
    backupExternal({
      control: null,
      teams: [
        {
          adapter: pg.adapter,
          teamId: pg.teamId,
          images: noImages,
          slides: new S3SlideBlobStore({
            client: bucket,
            bucket: "source",
            teamId: pg.teamId,
          }),
        },
      ],
      destination,
    });
  if (!slides) return state;
  await migrateSlideSchema(pg.pool);
  const repository = new PostgresSlideFileRepository({
    pool: pg.pool,
    bucket,
    teamId: pg.teamId,
  });
  const put = (bytes, extra) => ({
    teamId: pg.teamId,
    bytes,
    contentHash: sha(bytes),
    requestId: randomUUID(),
    userId: pg.user.id,
    at: new Date().toISOString(),
    ...extra,
  });
  state.first = slide("첫 저장");
  state.current = slide("현재");
  state.file = await repository.create(
    put(state.first, { id: randomUUID(), title: "자료" }),
  );
  await repository.replace(
    put(state.current, { fileId: state.file.id, baseRevision: 1 }),
  );
  const removed = await repository.create(
    put(slide("삭제한 자료"), { id: randomUUID(), title: "삭제" }),
  );
  await repository.remove({
    teamId: pg.teamId,
    fileId: removed.id,
    at: new Date().toISOString(),
  });
  await repository.createShare({
    id: "a".repeat(21),
    teamId: pg.teamId,
    body: "{}",
    userId: pg.user.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  // An object no revision refers to is not part of a backup.
  await bucket.put(
    `slides/${pg.teamId}/${"f".repeat(64)}.canvaslide`,
    slide("x"),
  );
  // Neither are card thumbnails, which the browser draws again.
  for (const bytes of [state.first, state.current])
    await repository.putThumbnail(
      pg.teamId,
      sha(bytes),
      Buffer.from("source thumbnail"),
    );
  return { ...state, repository, put };
}
const restoreInto = (state, backup, target, options = {}) =>
  restoreExternal({
    source: backup,
    teams: [
      {
        adapter: target.adapter,
        teamId: state.teamId,
        images: noImages,
        slides: target.slides,
      },
    ],
    ...options,
  });
const slideRows = async (pool) =>
  (
    await pool.query(
      "SELECT id,revision,content_hash,deleted_at FROM graeboard_slides.slide_files ORDER BY id",
    )
  ).rows;
const taskRows = async (pool) =>
  Number(
    (await pool.query("SELECT COUNT(*) n FROM graeboard.site_entities")).rows[0]
      .n,
  );

test("외부 백업은 슬라이드 스키마의 행과 참조하는 R2 원본을 함께 묶고 새 DB·버킷으로 복원한다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const backup = join(state.directory, "backup");
  await state.backup(backup);
  const manifest = JSON.parse(
    readFileSync(join(backup, "manifest.json"), "utf8"),
  );
  // Layout 1 plus the slide offset: a tool that predates slides refuses it.
  assert.equal(manifest.version, 4);
  assert.deepEqual(
    readdirSync(join(backup, state.teamId, "slides")).sort(),
    [state.first, state.current, slide("삭제한 자료")]
      .map((bytes) => `${sha(bytes)}.canvaslide`)
      .sort(),
  );
  const read = await readExternalBackup(backup);
  assert.equal(read.teams[0].slides.tables.slide_files.length, 2);
  assert.equal("slide_shares" in read.teams[0].slides.tables, false);

  const target = await state.target("team_restored");
  // A thumbnail left in the target bucket by an earlier use is not slide
  // data of another point in time: the restore neither refuses nor touches
  // it. Its name is the content it shows, so it can only ever be served for
  // that content.
  const leftover = slideThumbnailKey(
    state.teamId,
    sha(state.current),
    SLIDE_THUMBNAIL_VERSION,
  );
  await target.bucket.put(leftover, Buffer.from("target thumbnail"));
  assert.equal(
    (await restoreInto(state, backup, target, { dryRun: true })).verified,
    true,
  );
  assert.equal(target.bucket.puts, 0);
  await restoreInto(state, backup, target);
  assert.deepEqual(
    [...target.bucket.objects.keys()].sort(),
    [
      leftover,
      ...[state.first, state.current, slide("삭제한 자료")].map(
        (bytes) => `slides/${state.teamId}/${sha(bytes)}.canvaslide`,
      ),
    ].sort(),
    "only the content of the backup was installed",
  );
  assert.equal(
    await target.repository.thumbnail(state.teamId, sha(state.first)),
    null,
    "thumbnails are not restored",
  );
  assert.equal(
    Buffer.from(
      await target.repository.thumbnail(state.teamId, sha(state.current)),
    ).toString(),
    "target thumbnail",
  );
  assert.deepEqual(
    await slideRows(target.pool),
    await slideRows(state.pg.pool),
  );
  const restored = await target.repository.read(state.teamId, state.file.id);
  assert.equal(restored.file.revision, 2);
  assert.equal(Buffer.from(restored.bytes).equals(state.current), true);
  assert.equal((await target.repository.list(state.teamId)).length, 1);
  assert.equal(
    await target.repository.readShare(
      state.teamId,
      "a".repeat(21),
      new Date().toISOString(),
    ),
    null,
    "temporary shares are not restored",
  );
  for (const bytes of [state.first, state.current])
    assert.equal(
      Buffer.from(
        target.bucket.objects.get(
          `slides/${state.teamId}/${sha(bytes)}.canvaslide`,
        ),
      ).equals(bytes),
      true,
    );
  // A conditional save continues from the restored revision.
  const next = slide("복원 뒤");
  assert.equal(
    (
      await target.repository.replace(
        state.put(next, { fileId: state.file.id, baseRevision: 2 }),
      )
    ).file.revision,
    3,
  );
  // That save made the target differ from the backup: a second restore is refused.
  await assert.rejects(restoreInto(state, backup, target), /already has files/);
});

test("같은 백업의 복원은 다시 실행해도 한 번만 반영된다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const backup = join(state.directory, "backup");
  await state.backup(backup);
  const target = await state.target("team_rerun");
  await restoreInto(state, backup, target);
  const puts = target.bucket.puts;
  await restoreInto(state, backup, target);
  assert.equal(target.bucket.puts, puts);
  assert.deepEqual(
    await slideRows(target.pool),
    await slideRows(state.pg.pool),
  );
});

test("행이 이미 복원돼 있어도 원본 객체를 확인해 빠진 것은 다시 넣고 다른 것은 거절한다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const backup = join(state.directory, "backup");
  await state.backup(backup);
  const target = await state.target("team_objects");
  await restoreInto(state, backup, target);
  const key = `slides/${state.teamId}/${sha(state.current)}.canvaslide`;

  // The database kept the restored rows, but the bucket lost its objects
  // (a replaced or emptied bucket). The same restore repairs it.
  target.bucket.objects.clear();
  await assert.rejects(target.repository.read(state.teamId, state.file.id));
  await restoreInto(state, backup, target);
  assert.equal(
    Buffer.from(
      (await target.repository.read(state.teamId, state.file.id)).bytes,
    ).equals(state.current),
    true,
  );
  assert.equal(target.bucket.objects.size, 3);

  // An intact target is verified without being rewritten.
  const puts = target.bucket.puts;
  await restoreInto(state, backup, target);
  assert.equal(target.bucket.puts, puts);

  // An object that is not the backed-up content is never accepted or overwritten.
  target.bucket.objects.set(key, new TextEncoder().encode("{}"));
  await assert.rejects(restoreInto(state, backup, target), /mismatched/);
  assert.equal(new TextDecoder().decode(target.bucket.objects.get(key)), "{}");
  assert.equal(
    (await restoreInto(state, backup, target, { dryRun: true })).verified,
    true,
    "a dry run does not read or write objects",
  );
});

test("대상 슬라이드 저장소에 다른 자료가 있거나 저장소가 없으면 아무것도 바꾸지 않고 거절한다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const withSlides = join(state.directory, "with-slides");
  await state.backup(withSlides);

  const occupied = await state.target("team_occupied");
  const leftover = slide("다른 시점의 자료");
  const kept = await occupied.repository.create(
    state.put(leftover, { id: randomUUID(), title: "남아 있던 자료" }),
  );
  const before = await slideRows(occupied.pool);
  await assert.rejects(
    restoreInto(state, withSlides, occupied),
    /already has files/,
  );
  assert.deepEqual(await slideRows(occupied.pool), before);
  assert.equal(await taskRows(occupied.pool), 0, "team data was not imported");
  assert.equal(
    Buffer.from(
      (await occupied.repository.read(state.teamId, kept.id)).bytes,
    ).equals(leftover),
    true,
  );

  const missing = await state.target("team_no_store", { slideSchema: false });
  await assert.rejects(
    restoreInto(state, withSlides, missing),
    /slides migration/,
  );
  assert.equal(await taskRows(missing.pool), 0);
  assert.equal(missing.bucket.puts, 0);
});

test("슬라이드 도입 전 형식의 백업은 이전과 같고, 자료가 남은 저장소에는 복원하지 않는다", async (t) => {
  const state = await source(t, { slides: false });
  if (!state) return;
  const old = join(state.directory, "old");
  await state.backup(old);
  const manifest = JSON.parse(readFileSync(join(old, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal("slides" in manifest.teams[0], false);
  assert.equal(existsSync(join(old, state.teamId, "slides.json")), false);

  // Into a target with leftover slide files: refused, nothing mixed.
  const occupied = await state.target("team_old_occupied");
  await occupied.repository.create({
    id: randomUUID(),
    teamId: state.teamId,
    title: "남아 있던 자료",
    bytes: slide("남음"),
    contentHash: sha(slide("남음")),
    requestId: randomUUID(),
    userId: state.pg.user.id,
    at: new Date().toISOString(),
  });
  await assert.rejects(restoreInto(state, old, occupied), /already has files/);
  assert.equal(await taskRows(occupied.pool), 0);

  // Into an empty store, and into a database without the slide schema.
  for (const [name, slideSchema] of [
    ["team_old_empty", true],
    ["team_old_plain", false],
  ]) {
    const target = await state.target(name, { slideSchema });
    await restoreInto(state, old, target);
    assert.ok((await taskRows(target.pool)) > 0);
    assert.equal(target.bucket.objects.size, 0);
    if (slideSchema) assert.deepEqual(await slideRows(target.pool), []);
  }
});

test("백업의 슬라이드 원본이 손상됐거나 빠졌으면 읽기에서 거절한다", async (t) => {
  const state = await source(t);
  if (!state) return;
  for (const damage of ["corrupt", "missing", "rows"]) {
    const backup = join(state.directory, damage);
    await state.backup(backup);
    const blob = join(
      backup,
      state.teamId,
      "slides",
      `${sha(state.current)}.canvaslide`,
    );
    if (damage === "corrupt") writeFileSync(blob, "{}");
    if (damage === "missing") rmSync(blob);
    if (damage === "rows") {
      const path = join(backup, state.teamId, "slides.json");
      const data = JSON.parse(readFileSync(path, "utf8"));
      data.tables.slide_files[0].revision = 99;
      writeFileSync(path, JSON.stringify(data));
    }
    await assert.rejects(readExternalBackup(backup));
    const target = await state.target(`team_${damage}`);
    await assert.rejects(restoreInto(state, backup, target));
    assert.deepEqual(await slideRows(target.pool), []);
    assert.equal(await taskRows(target.pool), 0);
    assert.equal(target.bucket.puts, 0);
  }
  // A current revision whose object is gone: no backup is produced.
  state.bucket.objects.delete(
    `slides/${state.teamId}/${sha(state.current)}.canvaslide`,
  );
  const failed = join(state.directory, "failed");
  await assert.rejects(state.backup(failed), /current revision is unavailable/);
  assert.equal(existsSync(failed), false);
  assert.equal(existsSync(failed + ".partial"), false);
});

test("현재 revision의 R2 원본 내용이 해시와 다르면 백업을 만들지 않는다", async (t) => {
  const state = await source(t);
  if (!state) return;
  state.bucket.objects.set(
    `slides/${state.teamId}/${sha(state.current)}.canvaslide`,
    new TextEncoder().encode("{}"),
  );
  const failed = join(state.directory, "failed");
  await assert.rejects(state.backup(failed), /integrity failure/);
  assert.equal(existsSync(failed), false);
  assert.equal(existsSync(failed + ".partial"), false);
});

test("복원은 슬라이드 원본을 한 번에 하나만 올리고, 이미 있는 객체는 조각으로 받아 비교한다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const backup = join(state.directory, "backup");
  await state.backup(backup);
  const target = await state.target("team_bounded");
  const loads = trackSlideLoads(t, target.bucket);

  // Reading the backup hashes every slide file and keeps none of them.
  const read = await readExternalBackup(backup);
  assert.equal(read.teams[0].slides.blobs.size, 3);
  assert.equal(loads.count, 0);
  assert.equal(
    [...read.teams[0].slides.blobs.values()].some(
      (value) => value instanceof Uint8Array,
    ),
    false,
  );

  // Each file is loaded only when it is installed.
  await restoreInto(state, backup, target);
  assert.equal(target.bucket.puts, 3);
  assert.equal(loads.count, 3);
  assert.equal(loads.peak, 1);
  assert.equal(target.bucket.downloads, 0);

  // A second run finds every object in place. Each is downloaded once to be
  // compared, in pieces, and none is rewritten.
  await restoreInto(state, backup, target);
  assert.equal(target.bucket.puts, 3);
  assert.equal(target.bucket.downloads, 3);
  assert.equal(target.bucket.buffered, 0);
});

test("백업을 확인한 뒤 원본 파일이 바뀌면 그 파일부터 넣지 않고 슬라이드 행도 넣지 않는다", async (t) => {
  const state = await source(t);
  if (!state) return;
  const backup = join(state.directory, "backup");
  await state.backup(backup);
  const target = await state.target("team_changed");
  const folder = join(backup, state.teamId, "slides");
  const intact = new Map(
    readdirSync(folder).map((name) => [name, readFileSync(join(folder, name))]),
  );
  // The backup folder is damaged while the restore runs: right after the
  // first object is stored, every other slide file changes.
  const send = target.bucket.send.bind(target.bucket);
  target.bucket.send = async (command) => {
    const result = await send(command);
    if (
      command.constructor.name === "PutObjectCommand" &&
      target.bucket.puts === 1
    )
      for (const name of intact.keys())
        if (!command.input.Key.endsWith(name))
          writeFileSync(join(folder, name), "{}");
    return result;
  };
  await assert.rejects(
    restoreInto(state, backup, target),
    /Backup slide file checksum mismatch/,
  );
  assert.equal(target.bucket.puts, 1);
  for (const [key, bytes] of target.bucket.objects)
    assert.equal(key, `slides/${state.teamId}/${sha(bytes)}.canvaslide`);
  assert.deepEqual(await slideRows(target.pool), []);

  // With the backup folder intact again, the same restore completes.
  for (const [name, bytes] of intact) writeFileSync(join(folder, name), bytes);
  await restoreInto(state, backup, target);
  assert.equal(target.bucket.puts, 3);
  assert.deepEqual(
    await slideRows(target.pool),
    await slideRows(state.pg.pool),
  );
});
