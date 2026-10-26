import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assetResources } from "./image-resources.mjs";
import {
  fileImageStore,
  exportTransferAssets,
  verifyTransferAssets,
  installTransferAssets,
} from "../server/storage/logical-assets.mjs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import {
  exportTeam,
  importTeam,
  freezeTeam,
  releaseTransfer,
} from "../server/storage/logical-transfer.mjs";
import { verifyTransfer } from "../server/storage/logical-format.mjs";

export async function openTransferDatabase({
  engine,
  database,
  urlEnv,
  scope = "team",
}) {
  if (engine === "sqlite") {
    if (!database || !existsSync(database))
      throw new Error(
        "Specify an existing --database; run migrate --initialize first",
      );
    const db = new DatabaseSync(resolve(database));
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL",
    );
    const adapter = new SqliteDatabase(db);
    try {
      adapter.health();
    } catch (error) {
      db.close();
      throw error;
    }
    return { adapter, close: () => db.close() };
  }
  if (engine !== "postgres" || !urlEnv || !process.env[urlEnv])
    throw new Error("Specify postgres --url-env containing a database URL");
  const pool = new Pool({ connectionString: process.env[urlEnv], max: 2 }),
    adapter = new PostgresDatabase(pool, { scope });
  try {
    await adapter.health();
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { adapter, close: () => pool.end() };
}
export async function main(args = process.argv.slice(2)) {
  const { values: v } = parseArgs({
    args,
    options: {
      action: { type: "string" },
      engine: { type: "string" },
      database: { type: "string" },
      "url-env": { type: "string" },
      "team-id": { type: "string" },
      file: { type: "string" },
      freeze: { type: "boolean" },
      "job-id": { type: "string" },
      "profile-id": { type: "string" },
      "installation-id": { type: "string" },
      "dry-run": { type: "boolean" },
      "images-dir": { type: "string" },
      resources: { type: "string" },
      "git-directory": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (v.help) {
    console.log(
      "npm run transfer -- --action export|import|release --engine sqlite|postgres --database PATH|--url-env NAME --team-id UUID --file PATH [--freeze] [--job-id UUID] [--dry-run] [--profile-id NAME] [--installation-id UUID] [--images-dir PATH|--resources JSON] [--git-directory PATH]",
    );
    return;
  }
  if (!["export", "import", "release"].includes(v.action))
    throw new Error("Choose --action export, import or release");
  let bundle;
  if (v.action === "import") {
    if (!v.file) throw new Error("--file is required");
    bundle = JSON.parse(readFileSync(v.file, "utf8"));
    verifyTransfer(bundle);
    if (v["team-id"] && v["team-id"] !== bundle.payload.teamId)
      throw new Error("Target team does not match bundle");
    v["team-id"] = bundle.payload.teamId;
  }
  if (!v["team-id"]) throw new Error("--team-id is required");
  const { adapter, close } = await openTransferDatabase({
    engine: v.engine,
    database: v.database,
    urlEnv: v["url-env"],
  });
  let resources;
  try {
    resources = v.resources ? assetResources(v.resources, v["team-id"]) : null;
    const images = v["images-dir"]
      ? fileImageStore(v["images-dir"])
      : resources?.images;
    if (v.action === "export") {
      if (!v.file && !v["dry-run"]) throw new Error("--file is required");
      if (v.file && existsSync(v.file))
        throw new Error("Refusing to overwrite an existing logical bundle");
      if (!v.freeze && !v["job-id"] && !v["dry-run"])
        throw new Error(
          "Specify --freeze to pause team writes and synchronization for transfer",
        );
      const jobId = v["dry-run"]
        ? undefined
        : v["job-id"] || (await freezeTeam(adapter, v["team-id"]));
      if (v["job-id"])
        await adapter.withTeamTransaction(
          v["team-id"],
          (tx) => {
            const result = tx.query(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2 AND kind='logical-transfer' AND phase='frozen'",
              [v["team-id"], jobId],
            );
            const check = (value) => {
              if (!value.rows[0])
                throw new Error("Frozen transfer job not found");
            };
            return result?.then ? result.then(check) : check(result);
          },
          { readOnly: true },
        );
      const data = await exportTeam(adapter, v["team-id"], {
        requireFrozen: !v["dry-run"],
        omitJobId: jobId,
      });
      let assets;
      if (!v["dry-run"]) {
        const link = data.payload.tables.team_sync_links[0];
        let gitReady = false;
        const readArchive = async (url) => {
          if (!link?.canonical_head) return null;
          const path = url.replace("/api/document-images/", "images/");
          if (resources?.git) {
            if (!gitReady) {
              await resources.git.readHead();
              gitReady = true;
            }
            return resources.git.readFile(link.canonical_head, path);
          }
          const directory =
            v["git-directory"] ||
            resolve(
              process.env.GRAEBOARD_SYNC_DIR || "data/sync",
              link.profile_id,
            );
          try {
            return (
              await promisify(execFile)(
                "git",
                ["-C", directory, "show", link.canonical_head + ":" + path],
                {
                  encoding: "buffer",
                  maxBuffer: 11 * 1024 * 1024,
                  timeout: 30000,
                },
              )
            ).stdout;
          } catch {
            throw new Error(
              "Fixed-head Git archive image is unavailable; preserve local image backup",
            );
          }
        };
        try {
          assets = await exportTransferAssets(
            data,
            resolve(v.file) + ".assets",
            { images, readArchive },
          );
          writeFileSync(resolve(v.file), JSON.stringify(data) + "\n", {
            mode: 0o600,
            flag: "wx",
          });
        } catch (error) {
          throw new Error(
            error.message + " (team remains frozen; jobId " + jobId + ")",
          );
        }
      }
      console.log(
        JSON.stringify({
          dryRun: !!v["dry-run"],
          teamId: v["team-id"],
          jobId,
          assets,
          hash: data.hash,
          rows: Object.fromEntries(
            Object.entries(data.payload.tables).map(([table, rows]) => [
              table,
              rows.length,
            ]),
          ),
        }),
      );
    } else if (v.action === "import") {
      const assets = await verifyTransferAssets(
        bundle,
        resolve(v.file) + ".assets",
      );
      if (!v["dry-run"]) await installTransferAssets(bundle, assets, images);
      const result = v["dry-run"]
        ? { dryRun: true, teamId: v["team-id"], hash: bundle.hash }
        : await importTeam(adapter, bundle, {
            profileId: v["profile-id"],
            installationId: v["installation-id"],
          });
      console.log(JSON.stringify(result));
    } else {
      if (!v["job-id"]) throw new Error("--job-id is required");
      if (!v["dry-run"])
        await releaseTransfer(adapter, v["team-id"], v["job-id"]);
      console.log(
        JSON.stringify({ released: !v["dry-run"], synchronization: "paused" }),
      );
    }
  } finally {
    resources?.close();
    await close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error.code ? "Transfer failed (" + error.code + ")" : error.message,
    );
    process.exitCode = 1;
  });
