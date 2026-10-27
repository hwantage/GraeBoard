import { mkdir, writeFile, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { exportTeam, importTeam } from "./logical-transfer.mjs";
import {
  portableRow,
  databaseRow,
  portableHash,
  verifyTransfer,
} from "./logical-format.mjs";
import { canonical, digest, entityId } from "../sync/protocol.mjs";
import { imageReferences, activeImageReferences } from "../sync/retention.mjs";
import { project } from "../sync/reducer.mjs";
import { unfinishedJobError } from "./backup-recovery.mjs";

const CONTROL_TABLES = [
  "control_meta",
  "users",
  "access_identities",
  "control_preferences",
  "teams",
  "memberships",
  "control_jobs",
  "control_audit",
];
const SITE_TABLES = [
  "control_meta",
  "site_meta",
  ...CONTROL_TABLES.slice(1),
  "access_requests",
];
const controlTables = (site, keys = true) =>
  site
    ? [...SITE_TABLES, ...(keys ? ["setup_link_keys", "setup_key_state"] : [])]
    : CONTROL_TABLES;
const imageKey = (teamId, url) => {
  if (
    !new RegExp(
      "^/api/document-images/" + teamId + "/[a-f0-9]{64}\\.webp$",
    ).test(url)
  )
    throw new Error("Invalid or foreign backup image");
  return url.replace("/api/document-images/", "images/");
};
export class S3ImageStore {
  constructor({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    teamId,
    client,
  }) {
    if (!bucket || !teamId)
      throw new Error("S3 bucket and teamId are required");
    this.bucket = bucket;
    this.teamId = teamId;
    this.client =
      client ||
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
  }
  async read(url) {
    try {
      const r = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: imageKey(this.teamId, url),
        }),
      );
      if (r.ContentLength > 10 * 1024 * 1024)
        throw new Error("Backup image exceeds byte limit");
      const bytes = new Uint8Array(await r.Body.transformToByteArray());
      if (bytes.length > 10 * 1024 * 1024)
        throw new Error("Backup image exceeds byte limit");
      return bytes;
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey")
        return null;
      throw error;
    }
  }
  async install(url, bytes) {
    const key = imageKey(this.teamId, url);
    if (
      bytes.length > 10 * 1024 * 1024 ||
      digest(bytes) !== key.split("/").at(-1).slice(0, -5)
    )
      throw new Error("Backup image checksum mismatch");
    const existing = await this.read(url);
    if (existing) {
      if (digest(existing) !== digest(bytes))
        throw new Error("Refusing to overwrite mismatched target image");
      return;
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: "image/webp",
      }),
    );
  }
  async list() {
    let token;
    const result = [];
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "images/" + this.teamId + "/",
          ContinuationToken: token,
        }),
      );
      for (const row of page.Contents || [])
        result.push({
          url: row.Key.replace("images/", "/api/document-images/"),
          size: row.Size,
        });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return result;
  }
  close() {
    this.client.destroy?.();
  }
}
export function stateFrom(bundle) {
  const tables = verifyTransfer(bundle).tables,
    state = { entities: {}, receipts: {}, conflicts: {} };
  for (const row of tables.sync_entities) {
    const key = JSON.parse(row.entity_key);
    state.entities[entityId(row.entity, key)] = {
      entity: row.entity,
      key,
      generation: row.generation,
      version: row.version,
      payload: JSON.parse(row.payload),
      deleted: !!row.deleted,
    };
  }
  for (const row of tables.sync_receipts)
    state.receipts[row.op_id] = JSON.parse(row.receipt);
  for (const row of tables.sync_conflicts)
    state.conflicts[row.conflict_id] = JSON.parse(row.payload);
  const pending = tables.sync_outbox
    .filter((row) => row.status !== "acknowledged")
    .map((row) => JSON.parse(row.payload));
  return { state, pending, tables, link: tables.team_sync_links[0] };
}
async function guardBackup(adapter, teamId) {
  const id = randomUUID();
  await adapter.withTeamTransaction(teamId, async (tx) => {
    const unfinished = (
      await tx.query(
        "SELECT job_id,team_id,kind FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
        [teamId],
      )
    ).rows[0];
    if (unfinished) throw unfinishedJobError(unfinished);
    await tx.query(
      "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'backup','running','{}','{}',$3)",
      [id, teamId, new Date().toISOString()],
    );
  });
  return id;
}
async function completeBackup({ adapter, teamId, jobId }) {
  await adapter.withTeamTransaction(teamId, (tx) =>
    tx.query(
      "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id=$1",
      [jobId],
    ),
  );
}
export async function exportControl(adapter) {
  return adapter.withControlTransaction(
    async (tx) => {
      const tables = {};
      for (const table of controlTables(adapter.site))
        tables[table] = (await tx.query(`SELECT * FROM ${table}`)).rows
          .map(portableRow)
          .sort((a, b) => canonical(a).localeCompare(canonical(b)));
      return { tables, hash: portableHash(tables) };
    },
    { readOnly: true },
  );
}
export async function backupExternal({ control, teams, destination }) {
  destination = resolve(destination);
  const partial = destination + ".partial";
  if (
    (await stat(destination).catch(() => null)) ||
    (await stat(partial).catch(() => null))
  )
    throw new Error("Backup target already exists");
  await mkdir(partial, { recursive: true, mode: 0o700 });
  const guards = [];
  try {
    const manifest = {
      format: "graeboard-external-backup",
      version: control?.site ? 3 : 1,
      createdAt: new Date().toISOString(),
      control: null,
      teams: [],
    };
    if (control) {
      const data = await exportControl(control);
      if (
        control.site &&
        (teams.length !== 1 ||
          teams[0].teamId !== data.tables.site_meta[0]?.team_id)
      )
        throw new Error("Site backup requires its single bound team");
      await writeFile(
        join(partial, "control.json"),
        JSON.stringify(data) + "\n",
        { mode: 0o600 },
      );
      manifest.control = { path: "control.json", hash: portableHash(data) };
    }
    for (const { adapter, teamId, images, git } of teams) {
      const jobId = await guardBackup(adapter, teamId);
      guards.push({ adapter, teamId, jobId });
      const bundle = await exportTeam(adapter, teamId, {
          requireFrozen: false,
          omitJobId: jobId,
        }),
        snapshot = stateFrom(bundle),
        folder = join(partial, teamId);
      await mkdir(join(folder, "images"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(folder, "team.json"),
        JSON.stringify(bundle) + "\n",
        { mode: 0o600 },
      );
      // The DB snapshot fixes both the canonical Git head and all local refs.
      // Archived excluded images are copied directly from that Git commit into
      // this bundle; the source bucket is never repopulated during backup.
      const urls = new Set(imageReferences(bundle.payload.tables, teamId));
      for (const item of await images.list()) urls.add(item.url);
      const assets = [];
      for (const url of urls) {
        let bytes = await images.read(url);
        if (!bytes && snapshot.link?.canonical_head && git)
          bytes = await git.readFile(
            snapshot.link.canonical_head,
            imageKey(teamId, url),
          );
        if (!bytes)
          throw new Error(
            "Referenced image unavailable in R2 and fixed Git archive",
          );
        const key = imageKey(teamId, url),
          hash = key.split("/").at(-1).slice(0, -5);
        if (bytes.length > 10 * 1024 * 1024 || digest(bytes) !== hash)
          throw new Error("Backup image integrity failure");
        await writeFile(join(folder, "images", hash + ".webp"), bytes, {
          mode: 0o600,
        });
        assets.push({ url, hash, size: bytes.length });
      }
      manifest.teams.push({
        teamId,
        path: teamId + "/team.json",
        hash: bundle.hash,
        assets,
      });
    }
    await writeFile(
      join(partial, "manifest.json"),
      JSON.stringify({ ...manifest, hash: portableHash(manifest) }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    await rename(partial, destination);
    return { destination, teams: manifest.teams.length };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  } finally {
    for (const guard of guards) await completeBackup(guard);
  }
}
export async function readExternalBackup(directory) {
  const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ),
    { hash, ...body } = manifest;
  if (
    manifest.format !== "graeboard-external-backup" ||
    ![1, 2, 3].includes(manifest.version) ||
    portableHash(body) !== hash
  )
    throw new Error("External backup manifest checksum mismatch");
  const teams = [];
  for (const entry of manifest.teams) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(entry.teamId) ||
      entry.path !== entry.teamId + "/team.json"
    )
      throw new Error("Invalid backup team path");
    const bundle = JSON.parse(
      await readFile(join(directory, entry.path), "utf8"),
    );
    verifyTransfer(bundle);
    if (bundle.hash !== entry.hash || bundle.payload.teamId !== entry.teamId)
      throw new Error("Team backup checksum mismatch");
    const images = new Map();
    for (const asset of entry.assets) {
      imageKey(entry.teamId, asset.url);
      if (
        !/^[a-f0-9]{64}$/.test(asset.hash) ||
        !asset.url.endsWith("/" + asset.hash + ".webp")
      )
        throw new Error("Invalid image manifest");
      const bytes = await readFile(
        join(directory, entry.teamId, "images", asset.hash + ".webp"),
      );
      if (
        bytes.length !== asset.size ||
        bytes.length > 10 * 1024 * 1024 ||
        digest(bytes) !== asset.hash
      )
        throw new Error("Backup image checksum mismatch");
      images.set(asset.url, bytes);
    }
    teams.push({ bundle, images });
  }
  let control;
  if (manifest.control) {
    if (manifest.control.path !== "control.json")
      throw new Error("Invalid control path");
    control = JSON.parse(
      await readFile(join(directory, "control.json"), "utf8"),
    );
    if (
      portableHash(control) !== manifest.control.hash ||
      portableHash(control.tables) !== control.hash
    )
      throw new Error("Control backup checksum mismatch");
    if (
      Object.keys(control.tables).some(
        (table) =>
          !controlTables(manifest.version >= 2, manifest.version >= 3).includes(
            table,
          ),
      )
    )
      throw new Error("Invalid control backup table");
    for (const table of controlTables(
      manifest.version >= 2,
      manifest.version >= 3,
    )) {
      if (!Array.isArray(control.tables[table]))
        throw new Error("Missing control backup table");
      for (const row of control.tables[table])
        if (Object.keys(row).some((key) => !/^[_a-z]+$/.test(key)))
          throw new Error("Invalid control backup column");
    }
  }
  if (
    manifest.version >= 2 &&
    (!control ||
      control.tables.site_meta.length !== 1 ||
      teams.length !== 1 ||
      teams[0].bundle.payload.teamId !== control.tables.site_meta[0].team_id ||
      control.tables.teams.some(
        (row) => row.id !== control.tables.site_meta[0].team_id,
      ))
  )
    throw new Error("Site backup must contain exactly its bound team");
  return { manifest, teams, control };
}
export async function restoreExternal({
  source,
  control,
  teams,
  dryRun = false,
}) {
  const backup = await readExternalBackup(source);
  if (!!control?.site !== backup.manifest.version >= 2)
    throw new Error("Site and legacy backup layouts cannot be interchanged");
  if (control) {
    if (!backup.control) throw new Error("Control snapshot is absent");
    await control.withControlTransaction(
      async (tx) => {
        if (control.site) {
          const bound = (
            await tx.query("SELECT team_id FROM site_meta WHERE singleton=1")
          ).rows[0]?.team_id;
          if (
            bound !== backup.control.tables.site_meta[0].team_id ||
            teams.length !== 1 ||
            teams[0].teamId !== bound
          )
            throw new Error("Site restore team identity mismatch");
        }
        if (
          (
            await tx.query(
              "SELECT 1 FROM control_jobs WHERE id=$1 AND kind='external-restore' AND phase='complete'",
              ["restore-" + backup.manifest.hash],
            )
          ).rows.length
        )
          return;
        for (const table of controlTables(control.site).filter(
          (name) => !["control_meta", "site_meta"].includes(name),
        ))
          if ((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length)
            throw new Error(
              "Control restore requires an empty initialized control DB",
            );
      },
      { readOnly: true },
    );
  }
  for (const target of teams)
    if (
      !backup.teams.some(
        (entry) => entry.bundle.payload.teamId === target.teamId,
      )
    )
      throw new Error("Requested target team is absent from backup");
  if (dryRun) return { dryRun: true, teams: teams.length, verified: true };
  // Validate every image before the first target mutation. The target DB must
  // remain disconnected from live bindings until this operation and recovery end.
  for (const target of teams) {
    const { bundle, images } = backup.teams.find(
        (entry) => entry.bundle.payload.teamId === target.teamId,
      ),
      { state, pending, tables, link } = stateFrom(bundle);
    const retentions = tables.site_retention.filter(
      (row) => !link || row.site_id === link.installation_id,
    );
    const active = activeImageReferences(
      state,
      pending,
      retentions,
      project(state, pending).entities,
      target.teamId,
    );
    for (const row of tables.site_entities)
      if (!row.deleted && row.entity === "document")
        for (const url of imageReferences(
          JSON.parse(row.payload),
          target.teamId,
        ))
          active.add(url);
    for (const url of active) {
      const bytes = images.get(url);
      if (!bytes) throw new Error("Active backup image is missing");
      await target.images.install(url, bytes);
    }
    await importTeam(target.adapter, bundle, {
      profileId: target.profileId,
      installationId: target.installationId,
      restoreToken: backup.manifest.hash,
    });
  }
  if (control) {
    if (!backup.control) throw new Error("Control snapshot is absent");
    await control.withControlTransaction(async (tx) => {
      if (
        (
          await tx.query(
            "SELECT 1 FROM control_jobs WHERE id=$1 AND kind='external-restore' AND phase='complete'",
            ["restore-" + backup.manifest.hash],
          )
        ).rows.length
      )
        return;
      for (const table of controlTables(control.site).filter(
        (name) => !["control_meta", "site_meta"].includes(name),
      ))
        if ((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length)
          throw new Error(
            "Control restore requires an empty initialized control DB",
          );
      await tx.query("DELETE FROM control_meta");
      if (control.site) await tx.query("DELETE FROM site_meta");
      for (const table of controlTables(control.site))
        for (const row of backup.control.tables[table] || []) {
          const values = databaseRow(row),
            keys = Object.keys(values);
          await tx.query(
            `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
            Object.values(values),
          );
        }
      await tx.query(
        "UPDATE teams SET status='unconnected',config_revision=config_revision+1",
      );
      if (control.site) {
        await tx.query("UPDATE site_meta SET directory_checked_at=0");
        await tx.query(
          "UPDATE setup_link_keys SET revoked_at=COALESCE(revoked_at,$1) WHERE used_at IS NULL",
          [new Date().toISOString()],
        );
      }
      await tx.query(
        "INSERT INTO control_jobs(id,kind,phase,payload,created_at) VALUES($1,'external-restore','complete',$2,$3)",
        [
          "restore-" + backup.manifest.hash,
          canonical({ manifestHash: backup.manifest.hash }),
          new Date().toISOString(),
        ],
      );
    });
  }
  return { restored: teams.length, recoveryRequired: true };
}
