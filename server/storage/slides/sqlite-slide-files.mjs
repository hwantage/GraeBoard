import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { SLIDE_FILE_EXTENSION } from "../../../shared/slides/slide-file-rules.js";
import { requireThat } from "../../../shared/validation.js";

export const SLIDE_STORE_VERSION = 1;
export const SLIDE_STORE_FILE = "slide-files.sqlite";
// Bytes of the current revision and this many revisions before it are kept.
export const SLIDE_KEPT_REVISIONS = 10;

const migrationSql = readFileSync(
  new URL("../../migrations/slides/001-slide-files.sql", import.meta.url),
  "utf8",
);
export const slideStoreChecksum = createHash("sha256")
  .update(migrationSql)
  .digest("hex");

export function slideFilesDirectory() {
  return resolve(process.env.SLIDE_FILES_DIR || "data/slide-files");
}
export const slideBlobPath = (directory, teamId, contentHash) =>
  join(directory, "blobs", teamId, `${contentHash}.${SLIDE_FILE_EXTENSION}`);

// Opens the slide store database, creating it only when the file is new and
// empty. Any other version, or a history that does not match this code, is
// refused with the data left as it is.
export function openSlideDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SLIDE_STORE_FILE);
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === 0) {
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .get()
      )
        throw new Error(
          "슬라이드 저장소가 버전 0인데 테이블이 있습니다. 초기화하지 않고 중단합니다.",
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migrationSql);
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
          SLIDE_STORE_VERSION,
          slideStoreChecksum,
          new Date().toISOString(),
        );
        db.exec(`PRAGMA user_version=${SLIDE_STORE_VERSION}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else assertSlideStore(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function assertSlideStore(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== SLIDE_STORE_VERSION)
    throw new Error(
      `슬라이드 저장소 형식 v${version}은 지원하지 않습니다. 원본과 호환 릴리스를 보존하세요.`,
    );
  const rows = db
    .prepare("SELECT version,checksum FROM schema_migrations ORDER BY version")
    .all();
  if (
    rows.length !== 1 ||
    rows[0].version !== SLIDE_STORE_VERSION ||
    rows[0].checksum !== slideStoreChecksum
  )
    throw new Error("슬라이드 저장소의 변환 이력이 이 버전과 다릅니다.");
}

const meta = (row) =>
  row && {
    id: row.id,
    teamId: row.team_id,
    title: row.title,
    revision: row.revision,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };

// What a save answered when it was first stored. A repeated request ID gets
// this again, whatever other members saved since: the caller must keep
// working from the revision it actually wrote, never a newer one it never saw.
const replay = (file, revision, contentHash) => {
  requireThat(
    revision.content_hash === contentHash,
    409,
    "같은 저장 요청 ID가 다른 내용에 쓰였습니다.",
  );
  return {
    ...meta(file),
    revision: revision.revision,
    byteLength: revision.byte_length,
    contentHash: revision.content_hash,
    updatedBy: revision.saved_by,
    updatedAt: revision.saved_at,
  };
};

// Slide files of the internal Node site: metadata in the slide store database
// and immutable bytes at blobs/<team>/<SHA-256>.canvaslide. The database opens
// on first use, so a server that never touches slides creates nothing.
export class SqliteSlideFileRepository {
  #db = null;
  constructor({ directory = slideFilesDirectory() } = {}) {
    this.directory = directory;
    // An existing store is checked at startup instead of on a first request.
    if (existsSync(join(directory, SLIDE_STORE_FILE))) this.#open();
  }
  #open() {
    return (this.#db ??= openSlideDatabase(this.directory));
  }
  close() {
    this.#db?.close();
    this.#db = null;
  }
  #transaction(work) {
    const db = this.#open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  #live(db, teamId, fileId) {
    return db
      .prepare(
        "SELECT * FROM slide_files WHERE id=? AND team_id=? AND deleted_at IS NULL",
      )
      .get(fileId, teamId);
  }
  // Bytes are complete on disk before any row refers to them.
  #writeBlob(teamId, contentHash, bytes) {
    const path = slideBlobPath(this.directory, teamId, contentHash);
    if (existsSync(path)) return;
    mkdirSync(join(this.directory, "blobs", teamId), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(this.directory, "tmp"), { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "tmp", randomUUID());
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, path);
  }
  #readBlob(teamId, contentHash) {
    const bytes = readFileSync(
      slideBlobPath(this.directory, teamId, contentHash),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== contentHash)
      throw new Error("슬라이드 자료 파일의 해시가 기록과 다릅니다.");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  // Removes bytes no kept revision of any file of the team refers to.
  #prune(db, teamId, hashes) {
    for (const hash of new Set(hashes)) {
      const kept = db
        .prepare(
          `SELECT 1 FROM slide_file_revisions r JOIN slide_files f ON f.id=r.file_id
           WHERE f.team_id=? AND r.content_hash=? AND r.revision >= f.revision-? LIMIT 1`,
        )
        .get(teamId, hash, SLIDE_KEPT_REVISIONS);
      if (!kept)
        rmSync(slideBlobPath(this.directory, teamId, hash), { force: true });
    }
  }
  list(teamId) {
    return this.#open()
      .prepare(
        "SELECT * FROM slide_files WHERE team_id=? AND deleted_at IS NULL ORDER BY updated_at DESC, id",
      )
      .all(teamId)
      .map(meta);
  }
  get(teamId, fileId) {
    return meta(this.#live(this.#open(), teamId, fileId)) || null;
  }
  read(teamId, fileId) {
    const file = this.get(teamId, fileId);
    return file
      ? { file, bytes: this.#readBlob(teamId, file.contentHash) }
      : null;
  }
  create({ id, teamId, title, bytes, contentHash, requestId, userId, at }) {
    const db = this.#open();
    // Also a file deleted since: the first answer is replayed, and the next
    // save of that session is refused instead of touching newer content.
    const earlier = db
      .prepare(
        "SELECT * FROM slide_files WHERE team_id=? AND create_request_id=?",
      )
      .get(teamId, requestId);
    if (earlier)
      return replay(
        earlier,
        db
          .prepare(
            "SELECT * FROM slide_file_revisions WHERE file_id=? AND revision=1",
          )
          .get(earlier.id),
        contentHash,
      );
    this.#writeBlob(teamId, contentHash, bytes);
    return this.#transaction((db) => {
      db.prepare(
        `INSERT INTO slide_files
         (id,team_id,title,revision,byte_length,content_hash,created_by,created_at,updated_by,updated_at,create_request_id)
         VALUES(?,?,?,1,?,?,?,?,?,?,?)`,
      ).run(
        id,
        teamId,
        title,
        bytes.byteLength,
        contentHash,
        userId,
        at,
        userId,
        at,
        requestId,
      );
      db.prepare("INSERT INTO slide_file_revisions VALUES(?,1,?,?,?,?,?)").run(
        id,
        contentHash,
        bytes.byteLength,
        userId,
        at,
        requestId,
      );
      return meta(this.#live(db, teamId, id));
    });
  }
  replace({
    teamId,
    fileId,
    baseRevision,
    bytes,
    contentHash,
    requestId,
    userId,
    at,
  }) {
    if (!this.get(teamId, fileId)) return null;
    this.#writeBlob(teamId, contentHash, bytes);
    let expired = [];
    const result = this.#transaction((db) => {
      const file = this.#live(db, teamId, fileId);
      if (!file) return null;
      const earlier = db
        .prepare(
          "SELECT * FROM slide_file_revisions WHERE file_id=? AND request_id=?",
        )
        .get(fileId, requestId);
      if (earlier)
        return { saved: true, file: replay(file, earlier, contentHash) };
      if (file.revision !== baseRevision)
        return { saved: false, file: meta(file) };
      const revision = file.revision + 1;
      db.prepare(
        "UPDATE slide_files SET revision=?,byte_length=?,content_hash=?,updated_by=?,updated_at=? WHERE id=?",
      ).run(revision, bytes.byteLength, contentHash, userId, at, fileId);
      db.prepare("INSERT INTO slide_file_revisions VALUES(?,?,?,?,?,?,?)").run(
        fileId,
        revision,
        contentHash,
        bytes.byteLength,
        userId,
        at,
        requestId,
      );
      expired = db
        .prepare(
          "SELECT content_hash FROM slide_file_revisions WHERE file_id=? AND revision < ?",
        )
        .all(fileId, revision - SLIDE_KEPT_REVISIONS)
        .map((row) => row.content_hash);
      return { saved: true, file: meta(this.#live(db, teamId, fileId)) };
    });
    // After the commit: a save that did not commit removes nothing. These
    // calls are synchronous, so no other save runs between check and removal.
    this.#prune(this.#open(), teamId, expired);
    return result;
  }
  rename({ teamId, fileId, title, userId, at }) {
    return this.#transaction((db) => {
      if (!this.#live(db, teamId, fileId)) return null;
      db.prepare(
        "UPDATE slide_files SET title=?,updated_by=?,updated_at=? WHERE id=?",
      ).run(title, userId, at, fileId);
      return meta(this.#live(db, teamId, fileId));
    });
  }
  // The row and its bytes stay; the file only leaves the team list.
  remove({ teamId, fileId, at }) {
    this.#open()
      .prepare(
        "UPDATE slide_files SET deleted_at=? WHERE id=? AND team_id=? AND deleted_at IS NULL",
      )
      .run(at, fileId, teamId);
  }
  // Permanent team deletion: no foreign key links the two databases, so the
  // control repository calls this after the team is gone.
  removeTeam(teamId) {
    if (!this.#db && !existsSync(join(this.directory, SLIDE_STORE_FILE)))
      return;
    this.#transaction((db) => {
      db.prepare("DELETE FROM slide_files WHERE team_id=?").run(teamId);
      db.prepare("DELETE FROM slide_shares WHERE team_id=?").run(teamId);
    });
    rmSync(join(this.directory, "blobs", teamId), {
      recursive: true,
      force: true,
    });
  }
  createShare({ id, teamId, body, userId, createdAt, expiresAt }) {
    this.#transaction((db) => {
      db.prepare("DELETE FROM slide_shares WHERE expires_at<=?").run(createdAt);
      db.prepare("INSERT INTO slide_shares VALUES(?,?,?,?,?,?)").run(
        id,
        teamId,
        body,
        userId,
        createdAt,
        expiresAt,
      );
    });
  }
  readShare(teamId, id, now) {
    return (
      this.#open()
        .prepare(
          "SELECT body FROM slide_shares WHERE id=? AND team_id=? AND expires_at>?",
        )
        .get(id, teamId, now) || null
    );
  }
}
