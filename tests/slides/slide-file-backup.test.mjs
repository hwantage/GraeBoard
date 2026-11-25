import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../server/db.mjs";
import { backupDatabase } from "../../scripts/transfer/backup.mjs";
import { restoreDatabase } from "../../scripts/transfer/restore.mjs";
import {
  SLIDE_STORE_FILE,
  SqliteSlideFileRepository,
  slideBlobPath,
} from "../../server/storage/slides/sqlite-slide-files.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slide = (text) => Buffer.from(JSON.stringify({ version: 1, name: text }));
const files = (directory) =>
  existsSync(directory)
    ? readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

async function fixture(t, { slides = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "slide-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.sqlite");
  openDatabase(source).close();
  const slideFilesDir = join(directory, "slide-files");
  const teamId = randomUUID();
  const state = { directory, source, slideFilesDir, teamId };
  if (!slides) return state;
  const repository = new SqliteSlideFileRepository({
    directory: slideFilesDir,
  });
  const put = (bytes, extra) => ({
    teamId,
    bytes,
    contentHash: sha(bytes),
    requestId: randomUUID(),
    userId: "user",
    at: new Date().toISOString(),
    ...extra,
  });
  const first = slide("첫 저장");
  const current = slide("현재");
  const file = await repository.create(
    put(first, { id: randomUUID(), title: "자료" }),
  );
  await repository.replace(put(current, { fileId: file.id, baseRevision: 1 }));
  const removed = await repository.create(
    put(slide("삭제한 자료"), { id: randomUUID(), title: "삭제" }),
  );
  repository.remove({
    teamId,
    fileId: removed.id,
    at: new Date().toISOString(),
  });
  repository.createShare({
    id: "a".repeat(21),
    teamId,
    body: "{}",
    userId: "user",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  // Bytes no revision refers to are not part of a backup.
  mkdirSync(join(slideFilesDir, "tmp"), { recursive: true });
  writeFileSync(join(slideFilesDir, "tmp", "abandoned"), "partial");
  // Neither are card thumbnails, which the browser draws again.
  for (const bytes of [first, current])
    await repository.putThumbnail(teamId, sha(bytes), Buffer.from("thumbnail"));
  repository.close();
  return { ...state, file, first, current };
}
const options = (state, name = "restored") => ({
  documentImagesDir: join(state.directory, `${name}-images`),
  slideFilesDir: join(state.directory, `${name}-slides`),
});

test("백업은 슬라이드 저장소와 참조하는 파일만 함께 묶고 새 경로로 복원한다", async (t) => {
  const state = await fixture(t);
  const backup = join(state.directory, "backup.sqlite");
  backupDatabase(state.source, backup, {
    documentImagesDir: join(state.directory, "images"),
    slideFilesDir: state.slideFilesDir,
  });
  assert.deepEqual(
    files(backup + ".slides"),
    [
      SLIDE_STORE_FILE,
      `${sha(state.first)}.canvaslide`,
      `${sha(state.current)}.canvaslide`,
      `${sha(slide("삭제한 자료"))}.canvaslide`,
    ].sort(),
  );
  assert.throws(
    () =>
      backupDatabase(state.source, backup, {
        documentImagesDir: join(state.directory, "images"),
        slideFilesDir: state.slideFilesDir,
      }),
    /이미/,
  );

  const target = options(state);
  const restoredPath = restoreDatabase(
    backup,
    join(state.directory, "restored.sqlite"),
    target,
  );
  const repository = new SqliteSlideFileRepository({
    directory: target.slideFilesDir,
  });
  t.after(() => repository.close());
  const restored = await repository.read(state.teamId, state.file.id);
  assert.equal(restored.file.revision, 2);
  assert.equal(restored.file.contentHash, sha(state.current));
  assert.equal(Buffer.from(restored.bytes).equals(state.current), true);
  assert.equal(repository.list(state.teamId).length, 1);
  // The restored store works without thumbnails and stores new ones.
  assert.equal(existsSync(join(target.slideFilesDir, "thumbnails")), false);
  assert.equal(
    await repository.thumbnail(state.teamId, sha(state.current)),
    null,
  );
  assert.deepEqual(
    await repository.putThumbnail(
      state.teamId,
      sha(state.current),
      Buffer.from("drawn again"),
    ),
    Buffer.from("drawn again"),
  );
  assert.equal(
    repository.readShare(
      state.teamId,
      "a".repeat(21),
      new Date().toISOString(),
    ),
    null,
    "temporary shares are not restored",
  );
  // A conditional save continues from the restored revision.
  assert.equal(
    (
      await repository.replace({
        teamId: state.teamId,
        fileId: state.file.id,
        baseRevision: 2,
        bytes: slide("복원 뒤"),
        contentHash: sha(slide("복원 뒤")),
        requestId: randomUUID(),
        userId: "user",
        at: new Date().toISOString(),
      })
    ).file.revision,
    3,
  );
  const db = new DatabaseSync(restoredPath, { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 35);
  db.close();
});

test("슬라이드 저장소가 없는 사이트의 백업·복원은 이전과 같다", async (t) => {
  const state = await fixture(t, { slides: false });
  const backup = join(state.directory, "backup.sqlite");
  backupDatabase(state.source, backup, {
    documentImagesDir: join(state.directory, "images"),
    slideFilesDir: state.slideFilesDir,
  });
  assert.equal(existsSync(backup + ".slides"), false);
  const target = options(state);
  restoreDatabase(backup, join(state.directory, "restored.sqlite"), target);
  assert.equal(existsSync(target.slideFilesDir), false);
});

test("복원 대상 슬라이드 폴더에 남은 자료가 있으면 섞지 않고 거절한다", async (t) => {
  const state = await fixture(t);
  const withSlides = join(state.directory, "with-slides.sqlite");
  backupDatabase(state.source, withSlides, {
    documentImagesDir: join(state.directory, "images"),
    slideFilesDir: state.slideFilesDir,
  });
  // A backup taken before slides existed: no companion folder.
  const old = await fixture(t, { slides: false });
  const oldBackup = join(old.directory, "old.sqlite");
  backupDatabase(old.source, oldBackup, {
    documentImagesDir: join(old.directory, "images"),
    slideFilesDir: old.slideFilesDir,
  });
  const before = files(state.slideFilesDir);
  for (const backup of [withSlides, oldBackup]) {
    const destination = join(state.directory, `refused-${randomUUID()}.sqlite`);
    assert.throws(
      () =>
        restoreDatabase(backup, destination, {
          documentImagesDir: join(state.directory, "refused-images"),
          // The live directory still holds another point in time.
          slideFilesDir: state.slideFilesDir,
        }),
      /슬라이드 저장소 경로에 기존 자료/,
    );
    assert.equal(existsSync(destination), false, "no database was published");
    assert.deepEqual(
      files(state.slideFilesDir),
      before,
      "nothing was mixed in",
    );
  }
  // Thumbnails alone are also files of another point in time.
  const leftover = join(state.directory, "only-thumbnails");
  mkdirSync(join(leftover, "thumbnails", state.teamId), { recursive: true });
  writeFileSync(join(leftover, "thumbnails", state.teamId, "left"), "x");
  assert.throws(
    () =>
      restoreDatabase(withSlides, join(state.directory, "leftover.sqlite"), {
        documentImagesDir: join(state.directory, "leftover-images"),
        slideFilesDir: leftover,
      }),
    /슬라이드 저장소 경로에 기존 자료/,
  );
  // The old backup restores next to an empty slide directory: no slide files.
  const target = options(state, "old");
  restoreDatabase(
    oldBackup,
    join(state.directory, "old-restored.sqlite"),
    target,
  );
  assert.deepEqual(files(target.slideFilesDir), []);
  const repository = new SqliteSlideFileRepository({
    directory: target.slideFilesDir,
  });
  t.after(() => repository.close());
  assert.deepEqual(repository.list(state.teamId), []);
});

test("백업의 슬라이드 파일이 손상됐거나 빠졌으면 아무것도 복원하지 않는다", async (t) => {
  const state = await fixture(t);
  for (const damage of ["corrupt", "missing", "version"]) {
    const backup = join(state.directory, `${damage}.sqlite`);
    backupDatabase(state.source, backup, {
      documentImagesDir: join(state.directory, "images"),
      slideFilesDir: state.slideFilesDir,
    });
    const blob = slideBlobPath(
      backup + ".slides",
      state.teamId,
      sha(state.current),
    );
    if (damage === "corrupt") writeFileSync(blob, "{}");
    if (damage === "missing") rmSync(blob);
    if (damage === "version") {
      const db = new DatabaseSync(join(backup + ".slides", SLIDE_STORE_FILE));
      db.exec("PRAGMA user_version=3");
      db.close();
    }
    const target = options(state, damage);
    const destination = join(state.directory, `${damage}-restored.sqlite`);
    assert.throws(() => restoreDatabase(backup, destination, target));
    assert.equal(existsSync(destination), false);
    assert.deepEqual(files(target.slideFilesDir), []);
    assert.deepEqual(files(target.documentImagesDir), []);
  }
});

test("현재 revision의 파일이 없으면 백업을 만들지 않는다", async (t) => {
  const state = await fixture(t);
  rmSync(slideBlobPath(state.slideFilesDir, state.teamId, sha(state.current)));
  const backup = join(state.directory, "backup.sqlite");
  assert.throws(
    () =>
      backupDatabase(state.source, backup, {
        documentImagesDir: join(state.directory, "images"),
        slideFilesDir: state.slideFilesDir,
      }),
    /슬라이드 자료 파일이 없습니다/,
  );
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(backup + ".slides"), false);
  assert.equal(existsSync(backup + ".slides.partial"), false);
});
