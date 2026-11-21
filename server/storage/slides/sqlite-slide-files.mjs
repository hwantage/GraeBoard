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
  writeFileSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { SLIDE_FILE_EXTENSION } from "../../../shared/slides/slide-file-rules.js";
import { requireThat } from "../../../shared/validation.js";

export const SLIDE_STORE_VERSION = 2;
export const SLIDE_STORE_FILE = "slide-files.sqlite";
// Bytes of the current revision and this many revisions before it are kept.
export const SLIDE_KEPT_REVISIONS = 10;

// Released steps are never edited; a later change is a new step.
const migrations = ["001-slide-files.sql", "002-slide-sync.sql"].map(
  (name, index) => {
    const sql = readFileSync(
      new URL(`../../migrations/slides/${name}`, import.meta.url),
      "utf8",
    );
    return {
      version: index + 1,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  },
);
export const slideStoreChecksums = migrations.map((step) => step.checksum);

export function slideFilesDirectory() {
  return resolve(process.env.SLIDE_FILES_DIR || "data/slide-files");
}
export const slideBlobPath = (directory, teamId, contentHash) =>
  join(directory, "blobs", teamId, `${contentHash}.${SLIDE_FILE_EXTENSION}`);

const userVersion = (db) =>
  db.prepare("PRAGMA user_version").get().user_version;
const hasTables = (db) =>
  !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
function assertHistory(db, version) {
  const rows = db
    .prepare("SELECT version,checksum FROM schema_migrations ORDER BY version")
    .all();
  if (
    rows.length !== version ||
    rows.some(
      (row, index) =>
        row.version !== index + 1 ||
        row.checksum !== migrations[index].checksum,
    )
  )
    throw new Error("슬라이드 저장소의 변환 이력이 이 버전과 다릅니다.");
}
// Applies the steps after `from` in one transaction. Each step records its
// own history row, so a store is never left between two versions.
function applySteps(db, from) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) !== from)
      throw new Error(
        "슬라이드 저장소가 변환 중에 바뀌었습니다. 다시 시도하세요.",
      );
    for (const step of migrations.filter((item) => item.version > from)) {
      db.exec(step.sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        step.version,
        step.checksum,
        new Date().toISOString(),
      );
      db.exec(`PRAGMA user_version=${step.version}`);
    }
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("슬라이드 저장소 무결성 검사에 실패했습니다.");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function assertSlideStore(db) {
  const version = userVersion(db);
  if (version > 0 && version < SLIDE_STORE_VERSION) {
    assertHistory(db, version);
    throw new Error(
      `슬라이드 저장소 형식 v${version}은 변환이 필요합니다. 서버를 멈추고 npm run migrate -- --engine sqlite-slides --database <SLIDE_FILES_DIR>/${SLIDE_STORE_FILE} 을 실행하세요.`,
    );
  }
  if (version !== SLIDE_STORE_VERSION)
    throw new Error(
      `슬라이드 저장소 형식 v${version}은 지원하지 않습니다. 원본과 호환 릴리스를 보존하세요.`,
    );
  assertHistory(db, version);
}

// Opens the slide store database, creating it only when the file is new and
// empty. An older version is converted only by the explicit migration; any
// other version, or a history that does not match this code, is refused with
// the data left as it is.
export function openSlideDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SLIDE_STORE_FILE);
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    if (userVersion(db) === 0) {
      if (hasTables(db))
        throw new Error(
          "슬라이드 저장소가 버전 0인데 테이블이 있습니다. 초기화하지 않고 중단합니다.",
        );
      applySteps(db, 0);
    } else assertSlideStore(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
// The explicit upgrade of an existing store file (npm run migrate).
export function migrateSlideStore(path, { dryRun = false } = {}) {
  if (!existsSync(path)) throw new Error("슬라이드 저장소 파일이 없습니다.");
  const db = new DatabaseSync(path, { readOnly: dryRun });
  try {
    if (!dryRun) db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const from = userVersion(db);
    if (from === SLIDE_STORE_VERSION) {
      assertHistory(db, from);
      return { from, to: from, applied: false };
    }
    if (from < 1 || from > SLIDE_STORE_VERSION)
      throw new Error(
        `슬라이드 저장소 형식 v${from}은 지원하지 않습니다. 데이터를 보존했습니다.`,
      );
    assertHistory(db, from);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("슬라이드 저장소 무결성 검사에 실패했습니다.");
    if (dryRun)
      return { from, to: SLIDE_STORE_VERSION, applied: false, dryRun: true };
    applySteps(db, from);
    return { from, to: SLIDE_STORE_VERSION, applied: true };
  } finally {
    db.close();
  }
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

// A file with what the two sites last agreed on, as the sync core reads it.
// `missing` is a file known only from the branch (deleted before it arrived).
const syncFile = (row) => ({
  id: row.id || row.sync_id,
  missing: !row.id,
  title: row.title,
  contentHash: row.content_hash,
  byteLength: row.byte_length,
  revision: row.revision,
  deletedAt: row.deleted_at,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
  shared: row.shared_version
    ? {
        version: row.shared_version,
        hash: row.shared_hash,
        title: row.shared_title,
        deletedAt: row.shared_deleted_at,
        chunks: JSON.parse(row.shared_chunks),
        metaOid: row.meta_oid,
      }
    : null,
  pendingVersion: row.pending_version,
});

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
      db.prepare("DELETE FROM slide_sync_files WHERE team_id=?").run(teamId);
      db.prepare("DELETE FROM slide_sync_state WHERE team_id=?").run(teamId);
    });
    rmSync(join(this.directory, "staging", teamId), {
      recursive: true,
      force: true,
    });
    rmSync(join(this.directory, "blobs", teamId), {
      recursive: true,
      force: true,
    });
  }
  // --- Synchronization with the other site (server/sync/core/slide-file-branch.mjs).
  // The repository only keeps state; the rules live in the sync core.
  syncState(teamId) {
    return this.#transaction((db) => {
      const read = () =>
        db
          .prepare("SELECT head,epoch FROM slide_sync_state WHERE team_id=?")
          .get(teamId);
      if (!read())
        db.prepare("INSERT INTO slide_sync_state VALUES(?,NULL,?,1)").run(
          teamId,
          randomUUID(),
        );
      return { ...read() };
    });
  }
  // Whether this team has anything to synchronize; never creates the store.
  syncHasFiles(teamId) {
    if (!this.#db && !existsSync(join(this.directory, SLIDE_STORE_FILE)))
      return false;
    return !!this.#open()
      .prepare(
        `SELECT 1 FROM slide_files WHERE team_id=?
         UNION ALL SELECT 1 FROM slide_sync_files WHERE team_id=? LIMIT 1`,
      )
      .get(teamId, teamId);
  }
  // Moves the cursor only from the head this pass started at, so a slower
  // pass can never move it back. False when another pass moved it first.
  syncSetHead(teamId, head, previous) {
    return (
      this.#open()
        .prepare(
          "UPDATE slide_sync_state SET head=? WHERE team_id=? AND head IS ?",
        )
        .run(head, teamId, previous ?? null).changes === 1
    );
  }
  // A restored store never continues the version numbering of the store it
  // was copied from, and reads the whole branch again.
  syncReset() {
    const db = this.#open();
    for (const row of db.prepare("SELECT team_id FROM slide_sync_state").all())
      db.prepare(
        "UPDATE slide_sync_state SET head=NULL,epoch=?,next_seq=1 WHERE team_id=?",
      ).run(randomUUID(), row.team_id);
    db.exec(
      "UPDATE slide_sync_files SET pending_version=NULL,pending_key=NULL",
    );
  }
  syncFiles(teamId) {
    return this.#open()
      .prepare(
        `SELECT f.*, s.file_id AS sync_id, s.shared_version, s.shared_hash, s.shared_title,
                s.shared_deleted_at, s.shared_chunks, s.meta_oid, s.pending_version, s.pending_key
         FROM slide_files f LEFT JOIN slide_sync_files s ON s.team_id=f.team_id AND s.file_id=f.id
         WHERE f.team_id=?
         UNION ALL
         SELECT f.*, s.file_id, s.shared_version, s.shared_hash, s.shared_title,
                s.shared_deleted_at, s.shared_chunks, s.meta_oid, s.pending_version, s.pending_key
         FROM slide_sync_files s LEFT JOIN slide_files f ON f.id=s.file_id
         WHERE s.team_id=? AND f.id IS NULL`,
      )
      .all(teamId, teamId)
      .map(syncFile);
  }
  syncReadContent(teamId, contentHash) {
    return this.#readBlob(teamId, contentHash);
  }
  // The same local state always gets the same version, so a publication that
  // is retried after a lost answer does not create a second version.
  syncAllocateVersion(teamId, fileId, key) {
    return this.#transaction((db) => {
      const row = db
        .prepare(
          "SELECT pending_version,pending_key FROM slide_sync_files WHERE team_id=? AND file_id=?",
        )
        .get(teamId, fileId);
      if (row?.pending_version && row.pending_key === key)
        return row.pending_version;
      const state = db
        .prepare("SELECT epoch,next_seq FROM slide_sync_state WHERE team_id=?")
        .get(teamId);
      const version = `${state.epoch}:${state.next_seq}`;
      db.prepare(
        "UPDATE slide_sync_state SET next_seq=next_seq+1 WHERE team_id=?",
      ).run(teamId);
      db.prepare(
        `INSERT INTO slide_sync_files(team_id,file_id,pending_version,pending_key) VALUES(?,?,?,?)
         ON CONFLICT(team_id,file_id) DO UPDATE SET pending_version=excluded.pending_version,pending_key=excluded.pending_key`,
      ).run(teamId, fileId, version, key);
      return version;
    });
  }
  #markShared(db, teamId, fileId, shared) {
    db.prepare(
      `INSERT INTO slide_sync_files(team_id,file_id,shared_version,shared_hash,shared_title,shared_deleted_at,shared_chunks,meta_oid)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(team_id,file_id) DO UPDATE SET shared_version=excluded.shared_version,shared_hash=excluded.shared_hash,
         shared_title=excluded.shared_title,shared_deleted_at=excluded.shared_deleted_at,shared_chunks=excluded.shared_chunks,
         meta_oid=excluded.meta_oid,pending_version=NULL,pending_key=NULL`,
    ).run(
      teamId,
      fileId,
      shared.version,
      shared.hash,
      shared.title,
      shared.deletedAt,
      JSON.stringify(shared.chunks),
      shared.metaOid,
    );
  }
  // Confirms a version this site published. It applies only while that
  // version is still the one waiting for confirmation (or is already the
  // shared one): a confirmation that arrives after a later version was
  // published or received must not put the older version back.
  syncMarkShared(teamId, fileId, shared) {
    return this.#transaction((db) => {
      const row = db
        .prepare(
          "SELECT shared_version,pending_version FROM slide_sync_files WHERE team_id=? AND file_id=?",
        )
        .get(teamId, fileId);
      // A duplicate confirmation has nothing to write. In particular it
      // must leave the pending version of a newer publication alone.
      if (row?.pending_version !== shared.version)
        return row?.shared_version === shared.version;
      this.#markShared(db, teamId, fileId, shared);
      return true;
    });
  }
  // Applies a version received from the branch. `take` says which parts of it
  // replace the local file; `copy` first keeps the local content as a file of
  // its own. Bytes are complete on disk before any row changes.
  // False (nothing applied) when the file no longer looks like `expect`: it
  // was saved, renamed or deleted here after the decision was made.
  syncApply(teamId, { meta, metaOid, bytes, take, copy, expect }) {
    if (bytes) this.#writeBlob(teamId, meta.contentHash, bytes);
    return this.#transaction((db) => {
      const file = db
        .prepare("SELECT * FROM slide_files WHERE id=? AND team_id=?")
        .get(meta.id, teamId);
      const record = db
        .prepare(
          "SELECT shared_version FROM slide_sync_files WHERE team_id=? AND file_id=?",
        )
        .get(teamId, meta.id);
      if (
        !!file !== expect.exists ||
        (record?.shared_version ?? null) !== expect.sharedVersion ||
        (file &&
          (file.content_hash !== expect.contentHash ||
            file.title !== expect.title ||
            (file.deleted_at ?? null) !== expect.deletedAt))
      )
        return false;
      const insert = (
        id,
        title,
        hash,
        length,
        by,
        at,
        requestId,
        deletedAt,
      ) => {
        db.prepare(
          `INSERT INTO slide_files
           (id,team_id,title,revision,byte_length,content_hash,created_by,created_at,updated_by,updated_at,deleted_at,create_request_id)
           VALUES(?,?,?,1,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          teamId,
          title,
          length,
          hash,
          by,
          at,
          by,
          at,
          deletedAt,
          requestId,
        );
        db.prepare(
          "INSERT INTO slide_file_revisions VALUES(?,1,?,?,?,?,?)",
        ).run(id, hash, length, by, at, requestId);
      };
      if (
        copy &&
        file &&
        !db.prepare("SELECT 1 FROM slide_files WHERE id=?").get(copy.id)
      )
        insert(
          copy.id,
          copy.title,
          file.content_hash,
          file.byte_length,
          file.updated_by,
          file.updated_at,
          `sync-conflict:${copy.id}`,
          null,
        );
      if (!file) {
        // A file this site never had. A deleted one leaves only its sync record.
        if (!meta.deletedAt && take.content)
          insert(
            meta.id,
            meta.title,
            meta.contentHash,
            meta.byteLength,
            meta.updatedBy.id,
            meta.updatedAt,
            `sync:${meta.version}`,
            null,
          );
      } else {
        if (take.content && file.content_hash !== meta.contentHash) {
          const revision = file.revision + 1;
          db.prepare(
            "UPDATE slide_files SET revision=?,byte_length=?,content_hash=?,updated_by=?,updated_at=? WHERE id=?",
          ).run(
            revision,
            meta.byteLength,
            meta.contentHash,
            meta.updatedBy.id,
            meta.updatedAt,
            meta.id,
          );
          db.prepare(
            "INSERT INTO slide_file_revisions VALUES(?,?,?,?,?,?,?)",
          ).run(
            meta.id,
            revision,
            meta.contentHash,
            meta.byteLength,
            meta.updatedBy.id,
            meta.updatedAt,
            `sync:${meta.version}`,
          );
        }
        if (take.title)
          db.prepare("UPDATE slide_files SET title=? WHERE id=?").run(
            meta.title,
            meta.id,
          );
        if (take.deleted)
          db.prepare("UPDATE slide_files SET deleted_at=? WHERE id=?").run(
            meta.deletedAt,
            meta.id,
          );
      }
      this.#markShared(db, teamId, meta.id, {
        version: meta.version,
        hash: meta.contentHash,
        title: meta.title,
        deletedAt: meta.deletedAt,
        chunks: meta.chunks,
        metaOid,
      });
      return true;
    });
  }
  #stagePath(teamId, hash) {
    return join(this.directory, "staging", teamId, hash);
  }
  syncStage(teamId, hash, bytes) {
    mkdirSync(join(this.directory, "staging", teamId), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(this.directory, "tmp"), { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "tmp", randomUUID());
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, this.#stagePath(teamId, hash));
  }
  syncStaged(teamId, hash) {
    const path = this.#stagePath(teamId, hash);
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    // A damaged staged chunk is fetched again.
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return null;
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  syncUnstage(teamId, hashes) {
    for (const hash of hashes)
      rmSync(this.#stagePath(teamId, hash), { force: true });
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
