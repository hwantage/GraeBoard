import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { assertSqliteHistory } from "../server/migrations/sqlite.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import {
  abandonedBackup,
  recoverBackupJob,
} from "../server/storage/backup-recovery.mjs";

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
    if (!row || ["complete", "cancelled"].includes(row.phase))
      throw new Error(
        "An unfinished cleanup, restore or backup job is required.",
      );
    if (row.kind === "backup") {
      const { result, progress } = abandonedBackup(row, {
        confirmedDrained,
        dryRun,
      });
      if (dryRun) {
        db.exec("ROLLBACK");
        return result;
      }
      db.prepare(
        "UPDATE site_maintenance_jobs SET phase='cancelled',progress=? WHERE job_id=?",
      ).run(canonical(progress), jobId);
      // CLI execution has no authenticated application user. Keep its durable
      // recovery record in job.progress and emit a system event without falsely
      // attributing it to an arbitrary users row required by the audit FK.
      db.prepare(
        "INSERT INTO site_events(team_id,kind,payload,created_at) VALUES(?,'site-maintenance-recovery',?,?)",
      ).run(
        row.team_id,
        canonical({ ...result, recovery: progress.recovery }),
        progress.recovery.recoveredAt,
      );
      db.exec("COMMIT");
      return result;
    }
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

async function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      engine: { type: "string", default: "sqlite" },
      "url-env": { type: "string" },
      "team-id": { type: "string" },
      "job-id": { type: "string" },
      "confirm-drained": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: npm run sync:maintenance-recover -- --database /absolute/file.sqlite --job-id JOB_ID --dry-run\nPostgreSQL backup guard: --engine postgres --url-env PG_TEAM_URL --team-id TEAM_ID --job-id JOB_ID --dry-run\nApply only after every old executor has stopped: replace --dry-run with --confirm-drained.\nCleanup/restore keeps its guard and can resume in the maintenance screen. An abandoned backup guard is cancelled; its partial files are not a valid backup. Preserve or remove those partial files separately, then start a new backup at a new destination. C, P, L and existing backup files are unchanged.",
    );
    return;
  }
  if (values.engine === "postgres") {
    if (!values["url-env"] || !values["team-id"] || !values["job-id"])
      throw new Error("PostgreSQL requires --url-env, --team-id and --job-id.");
    const { openTransferDatabase } = await import("./transfer.mjs");
    const resource = await openTransferDatabase({
      engine: "postgres",
      urlEnv: values["url-env"],
    });
    try {
      console.log(
        JSON.stringify(
          await recoverBackupJob(
            resource.adapter,
            values["team-id"],
            values["job-id"],
            {
              confirmedDrained: values["confirm-drained"],
              dryRun: values["dry-run"],
            },
          ),
        ),
      );
    } finally {
      await resource.close();
    }
    return;
  }
  if (values.engine !== "sqlite")
    throw new Error("Choose --engine sqlite or postgres.");
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
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
