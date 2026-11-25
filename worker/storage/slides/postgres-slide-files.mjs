import {
  SLIDE_SCHEMA,
  slideSchemaReady,
} from "../../../shared/slides/slide-store-version.js";
import { requireThat } from "../../../shared/validation.js";
import { assert } from "../../control/access.mjs";
import { R2SlideBlobStore } from "./r2-slide-blobs.mjs";

// Bytes of the current revision and this many revisions before it are kept
// (the same rule as the internal site's SQLite store).
export const SLIDE_KEPT_REVISIONS = 10;
const S = SLIDE_SCHEMA;

const meta = (row) =>
  row && {
    id: row.id,
    teamId: row.team_id,
    title: row.title,
    revision: row.revision,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
    // A sync-created row records the first received revision, whose editor
    // can differ from the original creator.
    ...(/^sync(?:-conflict)?:/.test(row.create_request_id) && {
      creationFromSync: true,
    }),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
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
        ...(row.shared_chunks !== undefined && {
          chunks: JSON.parse(row.shared_chunks),
        }),
        metaOid: row.meta_oid,
      }
    : null,
  pendingVersion: row.pending_version,
});
// What a save answered when it was first stored; see the SQLite repository.
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

// Whether the team database has the slide store. Its own migration creates
// it, possibly after a release is deployed, and reading a missing table would
// abort the transaction; so a task transaction that reads slide titles asks
// this in the round trip that opens it (withData's `first`).
export const SLIDE_STORE_READY_SQL = `SELECT to_regclass('${S}.slide_files') IS NOT NULL AS ready`;
// Titles of the team's live files among `fileIds`, read in the caller's team
// transaction, for document links.
export async function slideFileTitles(tx, teamId, fileIds) {
  return new Map(
    (
      await tx.query(
        `SELECT id,title FROM ${S}.slide_files WHERE team_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[])`,
        [teamId, fileIds],
      )
    ).rows.map((row) => [row.id, row.title]),
  );
}

// Slide files of the external site: metadata in the graeboard_slides schema of
// the team database and immutable bytes in the team's R2 bucket. Bytes are
// uploaded before the transaction; inside it only an existence check and, when
// a concurrent delete won, one repeated upload touch R2.
export class PostgresSlideFileRepository {
  constructor({ pool, bucket, teamId }) {
    this.pool = pool;
    this.teamId = teamId;
    this.blobs = new R2SlideBlobStore(bucket, teamId);
  }
  #team(teamId) {
    assert(teamId === this.teamId, 403, "이 사이트의 팀만 사용할 수 있습니다.");
  }
  // The store exists only after its own migration; the task schema is checked
  // by the pool as before and is not affected when this one is missing.
  async #client() {
    const client = await this.pool.connect();
    try {
      if (!client.slideSchemaReady) {
        const exists = (
          await client.query(
            `SELECT to_regclass('${S}.schema_migrations') AS name`,
          )
        ).rows[0].name;
        assert(
          exists,
          503,
          "슬라이드 저장소가 준비되지 않았습니다. 관리자에게 슬라이드 저장소 migration을 요청하세요.",
        );
        assert(
          slideSchemaReady(
            (
              await client.query(
                `SELECT version,checksum FROM ${S}.schema_migrations ORDER BY version`,
              )
            ).rows,
          ),
          503,
          "슬라이드 저장소 버전이 이 서버와 다릅니다.",
        );
        client.slideSchemaReady = true;
      }
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }
  async #read(work) {
    const client = await this.#client();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  async #transaction(work) {
    const client = await this.#client();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`graeboard-slides:${this.teamId}`],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async #live(client, fileId) {
    return (
      await client.query(
        `SELECT * FROM ${S}.slide_files WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL`,
        [fileId, this.teamId],
      )
    ).rows[0];
  }
  // Reusing stored content and deleting it are serialized by the team lock.
  // A save checks, while it holds the lock, that the object its new row will
  // refer to is still there, and stores it again when a delete got there
  // first; a delete happens only while holding the same lock, after no kept
  // revision refers to the content. Whichever comes second sees the other.
  async #ensureBlob(contentHash, bytes) {
    if (!(await this.blobs.has(contentHash)))
      await this.blobs.write(contentHash, bytes);
  }
  // Removes bytes no kept revision of any file of the team refers to. A
  // failure or a restart leaves an unreferenced object, never a referenced
  // one missing.
  async #prune(hashes) {
    for (const hash of new Set(hashes))
      await this.#transaction(async (client) => {
        const kept = (
          await client.query(
            `SELECT 1 FROM ${S}.slide_file_revisions r JOIN ${S}.slide_files f ON f.id=r.file_id
             WHERE f.team_id=$1 AND r.content_hash=$2 AND r.revision >= f.revision-$3 LIMIT 1`,
            [this.teamId, hash, SLIDE_KEPT_REVISIONS],
          )
        ).rowCount;
        if (!kept) await this.blobs.remove(hash);
      }).catch(() => {});
  }
  async list(teamId) {
    this.#team(teamId);
    return this.#read(async (client) =>
      (
        await client.query(
          `SELECT * FROM ${S}.slide_files WHERE team_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC, id`,
          [teamId],
        )
      ).rows.map(meta),
    );
  }
  async get(teamId, fileId) {
    this.#team(teamId);
    return this.#read(
      async (client) => meta(await this.#live(client, fileId)) || null,
    );
  }
  async read(teamId, fileId) {
    const file = await this.get(teamId, fileId);
    return file
      ? { file, bytes: await this.blobs.read(file.contentHash) }
      : null;
  }
  async #created(client, requestId, contentHash) {
    const earlier = (
      await client.query(
        `SELECT * FROM ${S}.slide_files WHERE team_id=$1 AND create_request_id=$2`,
        [this.teamId, requestId],
      )
    ).rows[0];
    if (!earlier) return null;
    return replay(
      earlier,
      (
        await client.query(
          `SELECT * FROM ${S}.slide_file_revisions WHERE file_id=$1 AND revision=1`,
          [earlier.id],
        )
      ).rows[0],
      contentHash,
    );
  }
  async create({
    id,
    teamId,
    title,
    bytes,
    contentHash,
    requestId,
    userId,
    at,
  }) {
    this.#team(teamId);
    const earlier = await this.#read((client) =>
      this.#created(client, requestId, contentHash),
    );
    if (earlier) return earlier;
    await this.blobs.write(contentHash, bytes);
    return this.#transaction(async (client) => {
      // Two attempts of one request can both pass the first check.
      const raced = await this.#created(client, requestId, contentHash);
      if (raced) return raced;
      await this.#ensureBlob(contentHash, bytes);
      await client.query(
        `INSERT INTO ${S}.slide_files
         (id,team_id,title,revision,byte_length,content_hash,created_by,created_at,updated_by,updated_at,create_request_id)
         VALUES($1,$2,$3,1,$4,$5,$6,$7,$6,$7,$8)`,
        [
          id,
          teamId,
          title,
          bytes.byteLength,
          contentHash,
          userId,
          at,
          requestId,
        ],
      );
      await client.query(
        `INSERT INTO ${S}.slide_file_revisions VALUES($1,1,$2,$3,$4,$5,$6)`,
        [id, contentHash, bytes.byteLength, userId, at, requestId],
      );
      return meta(await this.#live(client, id));
    });
  }
  async replace({
    teamId,
    fileId,
    baseRevision,
    title = null,
    baseTitle = null,
    bytes,
    contentHash,
    requestId,
    userId,
    at,
  }) {
    if (!(await this.get(teamId, fileId))) return null;
    await this.blobs.write(contentHash, bytes);
    let expired = [];
    const result = await this.#transaction(async (client) => {
      const file = await this.#live(client, fileId);
      if (!file) return null;
      const earlier = (
        await client.query(
          `SELECT * FROM ${S}.slide_file_revisions WHERE file_id=$1 AND request_id=$2`,
          [fileId, requestId],
        )
      ).rows[0];
      if (earlier)
        return { saved: true, file: replay(file, earlier, contentHash) };
      if (
        file.revision !== baseRevision ||
        (baseTitle !== null && file.title !== baseTitle)
      )
        return { saved: false, file: meta(file) };
      await this.#ensureBlob(contentHash, bytes);
      const revision = file.revision + 1;
      await client.query(
        `UPDATE ${S}.slide_files SET title=COALESCE($7,title),revision=$1,byte_length=$2,content_hash=$3,updated_by=$4,updated_at=$5 WHERE id=$6`,
        [revision, bytes.byteLength, contentHash, userId, at, fileId, title],
      );
      await client.query(
        `INSERT INTO ${S}.slide_file_revisions VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          fileId,
          revision,
          contentHash,
          bytes.byteLength,
          userId,
          at,
          requestId,
        ],
      );
      expired = (
        await client.query(
          `SELECT content_hash FROM ${S}.slide_file_revisions WHERE file_id=$1 AND revision < $2`,
          [fileId, revision - SLIDE_KEPT_REVISIONS],
        )
      ).rows.map((row) => row.content_hash);
      return { saved: true, file: meta(await this.#live(client, fileId)) };
    });
    await this.#prune(expired);
    return result;
  }
  async rename({ teamId, fileId, title, userId, at }) {
    this.#team(teamId);
    return this.#transaction(async (client) => {
      if (!(await this.#live(client, fileId))) return null;
      await client.query(
        `UPDATE ${S}.slide_files SET title=$1,updated_by=$2,updated_at=$3 WHERE id=$4`,
        [title, userId, at, fileId],
      );
      return meta(await this.#live(client, fileId));
    });
  }
  // The row and its bytes stay; the file only leaves the team list.
  async remove({ teamId, fileId, at }) {
    this.#team(teamId);
    await this.#read((client) =>
      client.query(
        `UPDATE ${S}.slide_files SET deleted_at=$1 WHERE id=$2 AND team_id=$3 AND deleted_at IS NULL`,
        [at, fileId, teamId],
      ),
    );
  }
  // --- Synchronization with the other site (server/sync/core/slide-file-branch.mjs).
  // The same contract as the SQLite repository's sync methods.
  async syncState(teamId) {
    this.#team(teamId);
    const read = async (client) =>
      (
        await client.query(
          `SELECT head,epoch FROM ${S}.slide_sync_state WHERE team_id=$1`,
          [teamId],
        )
      ).rows[0];
    // The row is there after the team's first pass, so a pass only reads it.
    return (
      (await this.#read(read)) ||
      this.#transaction(async (client) => {
        await client.query(
          `INSERT INTO ${S}.slide_sync_state VALUES($1,NULL,$2,1) ON CONFLICT(team_id) DO NOTHING`,
          [teamId, crypto.randomUUID()],
        );
        return read(client);
      })
    );
  }
  async syncHasFiles(teamId) {
    this.#team(teamId);
    return this.#read(
      async (client) =>
        (
          await client.query(
            `SELECT 1 FROM ${S}.slide_files WHERE team_id=$1
             UNION ALL SELECT 1 FROM ${S}.slide_sync_files WHERE team_id=$1 LIMIT 1`,
            [teamId],
          )
        ).rowCount > 0,
    );
  }
  // Moves the cursor only from the head this pass started at, so a slower
  // pass (another Cron run) can never move it back.
  async syncSetHead(teamId, head, previous) {
    this.#team(teamId);
    return this.#read(
      async (client) =>
        (
          await client.query(
            `UPDATE ${S}.slide_sync_state SET head=$1 WHERE team_id=$2 AND head IS NOT DISTINCT FROM $3`,
            [head, teamId, previous ?? null],
          )
        ).rowCount === 1,
    );
  }
  // `chunks: false` leaves out the shared chunk lists; see the SQLite
  // repository.
  async syncFiles(teamId, { chunks = true } = {}) {
    this.#team(teamId);
    return this.#read(async (client) =>
      (
        await client.query(
          `SELECT f.*, COALESCE(f.id, s.file_id) AS sync_id, s.shared_version, s.shared_hash, s.shared_title,
                  s.shared_deleted_at, ${chunks ? "s.shared_chunks, " : ""}s.meta_oid, s.pending_version
           FROM (SELECT * FROM ${S}.slide_files WHERE team_id=$1) f
           FULL JOIN (SELECT * FROM ${S}.slide_sync_files WHERE team_id=$1) s ON s.file_id=f.id`,
          [teamId],
        )
      ).rows.map(syncFile),
    );
  }
  syncReadContent(teamId, contentHash) {
    this.#team(teamId);
    return this.blobs.read(contentHash);
  }
  async syncAllocateVersion(teamId, fileId, key) {
    this.#team(teamId);
    return this.#transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT pending_version,pending_key FROM ${S}.slide_sync_files WHERE team_id=$1 AND file_id=$2`,
          [teamId, fileId],
        )
      ).rows[0];
      if (row?.pending_version && row.pending_key === key)
        return row.pending_version;
      const state = (
        await client.query(
          `UPDATE ${S}.slide_sync_state SET next_seq=next_seq+1 WHERE team_id=$1 RETURNING epoch,next_seq-1 AS seq`,
          [teamId],
        )
      ).rows[0];
      const version = `${state.epoch}:${state.seq}`;
      await client.query(
        `INSERT INTO ${S}.slide_sync_files(team_id,file_id,pending_version,pending_key) VALUES($1,$2,$3,$4)
         ON CONFLICT(team_id,file_id) DO UPDATE SET pending_version=excluded.pending_version,pending_key=excluded.pending_key`,
        [teamId, fileId, version, key],
      );
      return version;
    });
  }
  #markShared(client, fileId, shared) {
    return client.query(
      `INSERT INTO ${S}.slide_sync_files(team_id,file_id,shared_version,shared_hash,shared_title,shared_deleted_at,shared_chunks,meta_oid)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(team_id,file_id) DO UPDATE SET shared_version=excluded.shared_version,shared_hash=excluded.shared_hash,
         shared_title=excluded.shared_title,shared_deleted_at=excluded.shared_deleted_at,shared_chunks=excluded.shared_chunks,
         meta_oid=excluded.meta_oid,pending_version=NULL,pending_key=NULL`,
      [
        this.teamId,
        fileId,
        shared.version,
        shared.hash,
        shared.title,
        shared.deletedAt,
        JSON.stringify(shared.chunks),
        shared.metaOid,
      ],
    );
  }
  // Confirms a version this site published; see the SQLite repository. Two
  // passes of this site can overlap (Cron and a pass started by a request).
  async syncMarkShared(teamId, fileId, shared) {
    this.#team(teamId);
    return this.#transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT shared_version,pending_version FROM ${S}.slide_sync_files WHERE team_id=$1 AND file_id=$2`,
          [teamId, fileId],
        )
      ).rows[0];
      // A duplicate confirmation has nothing to write. In particular it
      // must leave the pending version of a newer publication alone.
      if (row?.pending_version !== shared.version)
        return row?.shared_version === shared.version;
      await this.#markShared(client, fileId, shared);
      return true;
    });
  }
  // False (nothing applied) when the file no longer looks like `expect`: it
  // was saved, renamed or deleted here after the decision was made.
  async syncApply(teamId, { meta, metaOid, bytes, take, copy, expect }) {
    this.#team(teamId);
    if (bytes) await this.blobs.write(meta.contentHash, bytes);
    return this.#transaction(async (client) => {
      const file = (
        await client.query(
          `SELECT * FROM ${S}.slide_files WHERE id=$1 AND team_id=$2`,
          [meta.id, teamId],
        )
      ).rows[0];
      const record = (
        await client.query(
          `SELECT shared_version FROM ${S}.slide_sync_files WHERE team_id=$1 AND file_id=$2`,
          [teamId, meta.id],
        )
      ).rows[0];
      if (
        !!file !== expect.exists ||
        (record?.shared_version ?? null) !== expect.sharedVersion ||
        (file &&
          (file.content_hash !== expect.contentHash ||
            file.title !== expect.title ||
            (file.deleted_at ?? null) !== expect.deletedAt))
      )
        return false;
      const insert = async (id, title, hash, length, by, at, requestId) => {
        await client.query(
          `INSERT INTO ${S}.slide_files
           (id,team_id,title,revision,byte_length,content_hash,created_by,created_at,updated_by,updated_at,create_request_id)
           VALUES($1,$2,$3,1,$4,$5,$6,$7,$6,$7,$8)`,
          [id, teamId, title, length, hash, by, at, requestId],
        );
        await client.query(
          `INSERT INTO ${S}.slide_file_revisions VALUES($1,1,$2,$3,$4,$5,$6)`,
          [id, hash, length, by, at, requestId],
        );
      };
      if (
        copy &&
        file &&
        !(
          await client.query(`SELECT 1 FROM ${S}.slide_files WHERE id=$1`, [
            copy.id,
          ])
        ).rowCount
      )
        await insert(
          copy.id,
          copy.title,
          file.content_hash,
          file.byte_length,
          file.updated_by,
          file.updated_at,
          `sync-conflict:${copy.id}`,
        );
      if (!file) {
        if (!meta.deletedAt && take.content) {
          if (bytes) await this.#ensureBlob(meta.contentHash, bytes);
          await insert(
            meta.id,
            meta.title,
            meta.contentHash,
            meta.byteLength,
            meta.updatedBy.id,
            meta.updatedAt,
            `sync:${meta.version}`,
          );
        }
      } else {
        if (take.content && file.content_hash !== meta.contentHash) {
          if (bytes) await this.#ensureBlob(meta.contentHash, bytes);
          const revision = file.revision + 1;
          await client.query(
            `UPDATE ${S}.slide_files SET revision=$1,byte_length=$2,content_hash=$3,updated_by=$4,updated_at=$5 WHERE id=$6`,
            [
              revision,
              meta.byteLength,
              meta.contentHash,
              meta.updatedBy.id,
              meta.updatedAt,
              meta.id,
            ],
          );
          await client.query(
            `INSERT INTO ${S}.slide_file_revisions VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              meta.id,
              revision,
              meta.contentHash,
              meta.byteLength,
              meta.updatedBy.id,
              meta.updatedAt,
              `sync:${meta.version}`,
            ],
          );
        }
        if (take.title)
          await client.query(
            `UPDATE ${S}.slide_files SET title=$1 WHERE id=$2`,
            [meta.title, meta.id],
          );
        if (take.deleted)
          await client.query(
            `UPDATE ${S}.slide_files SET deleted_at=$1 WHERE id=$2`,
            [meta.deletedAt, meta.id],
          );
      }
      await this.#markShared(client, meta.id, {
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
  // Chunks received so far wait in the bucket until their file is complete.
  syncStage(teamId, hash, bytes) {
    this.#team(teamId);
    return this.blobs.stage(hash, bytes);
  }
  syncStaged(teamId, hash) {
    this.#team(teamId);
    return this.blobs.staged(hash);
  }
  async syncUnstage(teamId, hashes) {
    this.#team(teamId);
    for (const hash of hashes) await this.blobs.unstage(hash);
  }

  async createShare({ id, teamId, body, userId, createdAt, expiresAt }) {
    this.#team(teamId);
    await this.#transaction(async (client) => {
      await client.query(`DELETE FROM ${S}.slide_shares WHERE expires_at<=$1`, [
        createdAt,
      ]);
      await client.query(
        `INSERT INTO ${S}.slide_shares VALUES($1,$2,$3,$4,$5,$6)`,
        [id, teamId, body, userId, createdAt, expiresAt],
      );
    });
  }
  async readShare(teamId, id, now) {
    this.#team(teamId);
    return this.#read(
      async (client) =>
        (
          await client.query(
            `SELECT body FROM ${S}.slide_shares WHERE id=$1 AND team_id=$2 AND expires_at>$3`,
            [id, teamId, now],
          )
        ).rows[0] || null,
    );
  }
}
