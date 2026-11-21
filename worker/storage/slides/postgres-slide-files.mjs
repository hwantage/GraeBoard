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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
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

// Slide files of the external site: metadata in the graeboard_slides schema of
// the team database and immutable bytes in the team's R2 bucket. No database
// transaction stays open while an R2 request is awaited.
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
  // Removes bytes no kept revision of any file of the team refers to. Runs
  // after the commit; a failure leaves an unreferenced object, never a
  // referenced one missing.
  async #prune(hashes) {
    for (const hash of new Set(hashes)) {
      const kept = await this.#read(
        async (client) =>
          (
            await client.query(
              `SELECT 1 FROM ${S}.slide_file_revisions r JOIN ${S}.slide_files f ON f.id=r.file_id
               WHERE f.team_id=$1 AND r.content_hash=$2 AND r.revision >= f.revision-$3 LIMIT 1`,
              [this.teamId, hash, SLIDE_KEPT_REVISIONS],
            )
          ).rowCount,
      );
      if (!kept) await this.blobs.remove(hash).catch(() => {});
    }
  }
  async list(teamId) {
    this.#team(teamId);
    return this.#read(async (client) =>
      (
        await client.query(
          `SELECT * FROM ${S}.slide_files WHERE team_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC, id`,
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
      if (file.revision !== baseRevision)
        return { saved: false, file: meta(file) };
      const revision = file.revision + 1;
      await client.query(
        `UPDATE ${S}.slide_files SET revision=$1,byte_length=$2,content_hash=$3,updated_by=$4,updated_at=$5 WHERE id=$6`,
        [revision, bytes.byteLength, contentHash, userId, at, fileId],
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
