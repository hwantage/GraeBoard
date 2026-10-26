import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { assertSqliteHistory } from "../server/migrations/sqlite.mjs";
import { canonical } from "../server/sync/protocol.mjs";

export function recoverMaintenanceJob(
  db,
  { jobId, confirmedDrained = false, dryRun = false },
) {
  assertSqliteHistory(db);
  if (!dryRun && !confirmedDrained)
    throw new Error(
      "Stop all application, background synchronization and cleanup processes, verify no earlier executor is running, then pass --confirm-drained.",
    );
  db.exec("BEGIN EXCLUSIVE");
  try {
    const row = db
      .prepare("SELECT * FROM site_maintenance_jobs WHERE job_id=?")
      .get(jobId);
    if (
      !row ||
      ["complete", "cancelled"].includes(row.phase) ||
      row.kind === "backup"
    )
      throw new Error("An unfinished cleanup or restore job is required.");
    const manifest = JSON.parse(row.manifest),
      progress = JSON.parse(row.progress);
    if (manifest.preview || !progress.owner)
      throw new Error(
        "This job has no abandoned executor; resume it from the site maintenance screen.",
      );
    const resumePhase =
      row.phase === "failed" ? progress.resumePhase : row.phase;
    if (!["verifying", "deleting", "restoring"].includes(resumePhase))
      throw new Error(
        "Unsupported recovery phase; preserve the database for inspection.",
      );
    const result = {
      jobId,
      teamId: row.team_id,
      kind: row.kind,
      previousPhase: row.phase,
      phase: "failed",
      dryRun,
    };
    if (dryRun) {
      db.exec("ROLLBACK");
      return result;
    }
    delete progress.owner;
    delete progress.until;
    progress.resumePhase = resumePhase;
    progress.error =
      "Stopped executor confirmed drained; resume the preserved job.";
    progress.recoveredAt = new Date().toISOString();
    db.prepare(
      "UPDATE site_maintenance_jobs SET phase='failed',progress=? WHERE job_id=?",
    ).run(canonical(progress), jobId);
    db.prepare(
      "INSERT INTO audit(id,team_id,actor_id,action,target,before_json,after_json,created_at) VALUES(?,?,?,'site-maintenance-recovery',?,NULL,?,?)",
    ).run(
      randomUUID(),
      row.team_id,
      manifest.actorId,
      jobId,
      canonical({ kind: row.kind, resumePhase }),
      progress.recoveredAt,
    );
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      "job-id": { type: "string" },
      "confirm-drained": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: npm run sync:maintenance-recover -- --database /absolute/file.sqlite --job-id JOB_ID --dry-run\nApply only after every old executor has stopped: replace --dry-run with --confirm-drained.\nThis clears abandoned executor ownership while preserving the active job guard, manifest, C, P, L and progress. Restart the app and resume the job in site maintenance.",
    );
    return;
  }
  if (
    !values.database ||
    !isAbsolute(values.database) ||
    !existsSync(values.database) ||
    !values["job-id"]
  )
    throw new Error(
      "An existing absolute --database path and --job-id are required.",
    );
  const db = new DatabaseSync(values.database);
  try {
    console.log(
      JSON.stringify(
        recoverMaintenanceJob(db, {
          jobId: values["job-id"],
          confirmedDrained: values["confirm-drained"],
          dryRun: values["dry-run"],
        }),
      ),
    );
  } finally {
    db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
