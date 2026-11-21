import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slide = (text) => Buffer.from(JSON.stringify({ version: 1, name: text }));

// The S3 API of a bucket, kept in memory; also usable as the R2 binding.
class MemoryBucket {
  objects = new Map();
  puts = 0;
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
    return {
      ContentLength: bytes.length,
      Body: { transformToByteArray: async () => bytes },
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
  assert.equal(
    (await restoreInto(state, backup, target, { dryRun: true })).verified,
    true,
  );
  assert.equal(target.bucket.puts, 0);
  await restoreInto(state, backup, target);
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
