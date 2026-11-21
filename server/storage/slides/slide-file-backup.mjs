import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import {
  assertSlideStore,
  SLIDE_KEPT_REVISIONS,
  SLIDE_STORE_FILE,
  slideBlobPath,
} from "./sqlite-slide-files.mjs";

const hashOf = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export const hasSlideStore = (directory) =>
  existsSync(join(directory, SLIDE_STORE_FILE));

// The bytes a store snapshot needs: every file's current revision, and the
// older revisions the store still keeps.
function referencedBlobs(db) {
  return db
    .prepare(
      `SELECT f.team_id AS teamId, r.content_hash AS contentHash,
              MAX(r.revision = f.revision) AS current
       FROM slide_file_revisions r JOIN slide_files f ON f.id=r.file_id
       WHERE r.revision >= f.revision-?
       GROUP BY f.team_id, r.content_hash`,
    )
    .all(SLIDE_KEPT_REVISIONS);
}
function checkSnapshot(db) {
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("슬라이드 저장소 무결성 검사에 실패했습니다.");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("슬라이드 저장소 외래 키 검사에 실패했습니다.");
  assertSlideStore(db);
}
function copyBlob(from, to, { teamId, contentHash, current }) {
  const source = slideBlobPath(from, teamId, contentHash);
  if (!existsSync(source)) {
    // An older revision may be pruned by a save made after the snapshot. The
    // current revision of the snapshot is always still kept.
    if (current)
      throw new Error(
        `슬라이드 자료 파일이 없습니다: ${teamId}/${contentHash}`,
      );
    return;
  }
  const target = slideBlobPath(to, teamId, contentHash);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  if (hashOf(target) !== contentHash)
    throw new Error(
      `슬라이드 자료 파일의 해시가 기록과 다릅니다: ${teamId}/${contentHash}`,
    );
}

// Copies a consistent snapshot of the slide store and exactly the bytes that
// snapshot refers to. Returns false when the site has no slide store.
export function backupSlideStore(source, destination) {
  if (!hasSlideStore(source)) return false;
  if (existsSync(destination))
    throw new Error("슬라이드 백업 폴더가 이미 있습니다.");
  const temporary = destination + ".partial";
  if (existsSync(temporary))
    throw new Error("진행 중인 슬라이드 백업이 있습니다.");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    const live = new DatabaseSync(join(source, SLIDE_STORE_FILE), {
      readOnly: true,
    });
    try {
      live.exec("PRAGMA busy_timeout=10000");
      live.prepare("VACUUM INTO ?").run(join(temporary, SLIDE_STORE_FILE));
    } finally {
      live.close();
    }
    chmodSync(join(temporary, SLIDE_STORE_FILE), 0o600);
    const snapshot = new DatabaseSync(join(temporary, SLIDE_STORE_FILE), {
      readOnly: true,
    });
    try {
      checkSnapshot(snapshot);
      for (const blob of referencedBlobs(snapshot))
        copyBlob(source, temporary, blob);
    } finally {
      snapshot.close();
    }
    renameSync(temporary, destination);
    return true;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

// Checks a whole slide backup before anything is published from it.
export function verifySlideBackup(backup) {
  const db = new DatabaseSync(join(backup, SLIDE_STORE_FILE), {
    readOnly: true,
  });
  try {
    checkSnapshot(db);
    const blobs = referencedBlobs(db);
    for (const { teamId, contentHash, current } of blobs) {
      const path = slideBlobPath(backup, teamId, contentHash);
      if (!existsSync(path)) {
        if (current)
          throw new Error(
            `백업에 슬라이드 자료 파일이 없습니다: ${teamId}/${contentHash}`,
          );
        continue;
      }
      if (hashOf(path) !== contentHash)
        throw new Error(
          `백업의 슬라이드 자료 해시가 기록과 다릅니다: ${teamId}/${contentHash}`,
        );
    }
    return blobs;
  } finally {
    db.close();
  }
}

// A restored task database must never be paired with slide files of another
// point in time, so the target has to be a new or empty directory.
export function assertEmptySlideTarget(target) {
  if (existsSync(target) && readdirSync(target).length)
    throw new Error(
      `슬라이드 저장소 경로에 기존 자료가 있습니다: ${target}\n복구에는 비어 있는 새 SLIDE_FILES_DIR 경로를 지정하세요.`,
    );
}

export function restoreSlideStore(backup, target) {
  const blobs = verifySlideBackup(backup);
  assertEmptySlideTarget(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const blob of blobs) copyBlob(backup, target, blob);
  const temporary = join(target, SLIDE_STORE_FILE + ".partial");
  copyFileSync(join(backup, SLIDE_STORE_FILE), temporary);
  chmodSync(temporary, 0o600);
  try {
    const restored = new DatabaseSync(temporary);
    try {
      // Share links are temporary, like sessions.
      restored.exec("DELETE FROM slide_shares");
      // A restored store starts a new publication epoch and reads the sync
      // branch from the beginning, so it never reuses a version ID.
      for (const row of restored
        .prepare("SELECT team_id FROM slide_sync_state")
        .all())
        restored
          .prepare(
            "UPDATE slide_sync_state SET head=NULL,epoch=?,next_seq=1 WHERE team_id=?",
          )
          .run(randomUUID(), row.team_id);
      restored.exec(
        "UPDATE slide_sync_files SET pending_version=NULL,pending_key=NULL",
      );
    } finally {
      restored.close();
    }
    renameSync(temporary, join(target, SLIDE_STORE_FILE));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
