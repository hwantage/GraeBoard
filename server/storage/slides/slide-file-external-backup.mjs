import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { digest } from "../../sync/core/protocol.mjs";
import { portableHash } from "../../../shared/transfer/logical-format.mjs";
import {
  SLIDE_SCHEMA,
  slideSchemaReady,
} from "../../../shared/slides/slide-store-version.js";
import {
  MAX_SLIDE_FILE_BYTES,
  SLIDE_FILE_EXTENSION,
} from "../../../shared/slides/slide-file-rules.js";

// The external site's slide files inside an external backup: the rows of the
// slide schema in one consistent read, and exactly the R2 objects they refer
// to. Temporary shares are not backed up.
const S = SLIDE_SCHEMA;
const KEPT_REVISIONS = 10;
const TABLES = {
  slide_files: [
    "id",
    "team_id",
    "title",
    "revision",
    "byte_length",
    "content_hash",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
    "create_request_id",
  ],
  slide_file_revisions: [
    "file_id",
    "revision",
    "content_hash",
    "byte_length",
    "saved_by",
    "saved_at",
    "request_id",
  ],
  // What the two sites last agreed on per file (see slide-file-branch.mjs).
  slide_sync_files: [
    "team_id",
    "file_id",
    "shared_version",
    "shared_hash",
    "shared_title",
    "shared_deleted_at",
    "shared_chunks",
    "meta_oid",
  ],
};
const key = (teamId, contentHash) => {
  if (!/^[a-f0-9]{64}$/.test(contentHash))
    throw new Error("Invalid slide content hash");
  return `slides/${teamId}/${contentHash}.${SLIDE_FILE_EXTENSION}`;
};

// Slide objects through the S3 API of the team's R2 bucket.
export class S3SlideBlobStore {
  constructor({ client, bucket, teamId }) {
    if (!client || !bucket || !teamId)
      throw new Error("S3 client, bucket and teamId are required");
    Object.assign(this, { client, bucket, teamId });
  }
  async read(contentHash) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key(this.teamId, contentHash),
        }),
      );
      if (response.ContentLength > MAX_SLIDE_FILE_BYTES)
        throw new Error("Backup slide file exceeds byte limit");
      return new Uint8Array(await response.Body.transformToByteArray());
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey")
        return null;
      throw error;
    }
  }
  async install(contentHash, bytes) {
    if (bytes.length > MAX_SLIDE_FILE_BYTES || digest(bytes) !== contentHash)
      throw new Error("Backup slide file checksum mismatch");
    const existing = await this.read(contentHash);
    if (existing) {
      if (digest(existing) !== contentHash)
        throw new Error("Refusing to overwrite mismatched target slide file");
      return;
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key(this.teamId, contentHash),
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  }
}

// Bytes the rows need: each file's current revision (required) and the older
// revisions the store still keeps (copied when present).
function referenced(tables) {
  const files = new Map(tables.slide_files.map((file) => [file.id, file]));
  const result = new Map();
  for (const row of tables.slide_file_revisions) {
    const file = files.get(row.file_id);
    if (!file || row.revision < file.revision - KEPT_REVISIONS) continue;
    result.set(
      row.content_hash,
      result.get(row.content_hash) || row.revision === file.revision,
    );
  }
  return result;
}
// null when the database has no slide store.
async function readTables(adapter, teamId) {
  return adapter.transaction(
    async (tx) => {
      const exists = (
        await tx.query(`SELECT to_regclass('${S}.schema_migrations') AS name`)
      ).rows[0].name;
      if (!exists) return null;
      if (
        !slideSchemaReady(
          (
            await tx.query(
              `SELECT version,checksum FROM ${S}.schema_migrations ORDER BY version`,
            )
          ).rows,
        )
      )
        throw new Error("Unsupported graeboard_slides schema; data preserved");
      const tables = {};
      tables.slide_files = (
        await tx.query(
          `SELECT ${TABLES.slide_files.join(",")} FROM ${S}.slide_files WHERE team_id=$1 ORDER BY id`,
          [teamId],
        )
      ).rows;
      tables.slide_file_revisions = (
        await tx.query(
          `SELECT ${TABLES.slide_file_revisions.map((name) => "r." + name).join(",")}
           FROM ${S}.slide_file_revisions r JOIN ${S}.slide_files f ON f.id=r.file_id
           WHERE f.team_id=$1 ORDER BY r.file_id,r.revision`,
          [teamId],
        )
      ).rows;
      tables.slide_sync_files = (
        await tx.query(
          `SELECT ${TABLES.slide_sync_files.join(",")} FROM ${S}.slide_sync_files WHERE team_id=$1 ORDER BY file_id`,
          [teamId],
        )
      ).rows;
      return tables;
    },
    { teamId, readOnly: true },
  );
}

// Writes <folder>/slides.json and <folder>/slides/<hash>.canvaslide; returns
// the manifest entry, or null when the site has no slide store.
export async function backupSlides({ adapter, teamId, blobs, folder }) {
  const tables = await readTables(adapter, teamId);
  if (!tables) return null;
  if (!blobs) throw new Error("Slide file store is required for this backup");
  await mkdir(join(folder, "slides"), { recursive: true, mode: 0o700 });
  const files = [];
  for (const [contentHash, current] of referenced(tables)) {
    const bytes = await blobs.read(contentHash);
    if (!bytes) {
      if (current)
        throw new Error(
          "Slide file of a current revision is unavailable in R2",
        );
      continue;
    }
    if (digest(bytes) !== contentHash)
      throw new Error("Backup slide file integrity failure");
    await writeFile(
      join(folder, "slides", `${contentHash}.${SLIDE_FILE_EXTENSION}`),
      bytes,
      { mode: 0o600 },
    );
    files.push({ contentHash, size: bytes.length });
  }
  const hash = portableHash(tables);
  await writeFile(
    join(folder, "slides.json"),
    JSON.stringify({ tables, hash }) + "\n",
    { mode: 0o600 },
  );
  return { path: `${teamId}/slides.json`, hash, files };
}

// Reads and verifies the slide part of a backup before anything is restored.
export async function readSlideBackup(directory, teamId, entry) {
  if (entry.path !== `${teamId}/slides.json`)
    throw new Error("Invalid backup slide path");
  const { tables, hash } = JSON.parse(
    await readFile(join(directory, entry.path), "utf8"),
  );
  if (
    hash !== entry.hash ||
    portableHash(tables) !== hash ||
    Object.keys(tables).sort().join() !== Object.keys(TABLES).sort().join() ||
    tables.slide_files.some((row) => row.team_id !== teamId)
  )
    throw new Error("Slide backup checksum mismatch");
  const blobs = new Map();
  for (const file of entry.files) {
    key(teamId, file.contentHash);
    const bytes = await readFile(
      join(
        directory,
        teamId,
        "slides",
        `${file.contentHash}.${SLIDE_FILE_EXTENSION}`,
      ),
    );
    if (bytes.length !== file.size || digest(bytes) !== file.contentHash)
      throw new Error("Backup slide file checksum mismatch");
    blobs.set(file.contentHash, bytes);
  }
  for (const [contentHash, current] of referenced(tables))
    if (current && !blobs.has(contentHash))
      throw new Error("Backup slide file of a current revision is missing");
  return { tables, hash, blobs };
}

// A restored team must never be paired with slide files of another point in
// time. Returns "restored" when the target already holds exactly this backup.
export async function checkSlideTarget({ adapter, teamId, backup }) {
  const tables = await readTables(adapter, teamId);
  if (!tables) {
    if (backup)
      throw new Error(
        "Target has no slide store: run the slides migration before restoring this backup",
      );
    return "absent";
  }
  if (!tables.slide_files.length && !tables.slide_sync_files.length)
    return "empty";
  if (backup && portableHash(tables) === backup.hash) return "restored";
  throw new Error(
    "Target slide store already has files of this team; restore into an empty store",
  );
}

export async function restoreSlides({ adapter, teamId, blobs, backup }) {
  const target = await checkSlideTarget({ adapter, teamId, backup });
  if (!blobs) throw new Error("Slide file store is required for this restore");
  // Rows that already match say nothing about the bucket. Every object of the
  // backup is compared with the target: a missing one is stored, an equal one
  // is left as it is, and a different one refuses the restore.
  for (const [contentHash, bytes] of backup.blobs)
    await blobs.install(contentHash, bytes);
  if (target === "restored") return;
  await adapter.transaction(
    async (tx) => {
      for (const [table, columns] of Object.entries(TABLES))
        for (const row of backup.tables[table])
          await tx.query(
            `INSERT INTO ${S}.${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
            columns.map((name) => row[name]),
          );
      // A restored store starts a new publication epoch and reads the sync
      // branch from the beginning, so it never reuses a version ID. Versions
      // allocated but not confirmed are not part of a backup.
      await tx.query(`DELETE FROM ${S}.slide_sync_state WHERE team_id=$1`, [
        teamId,
      ]);
    },
    { teamId },
  );
}
