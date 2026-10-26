import { canonical } from "../sync/protocol.mjs";

export function unfinishedJobError(row) {
  return Object.assign(
    new Error(
      `Maintenance job ${row.job_id} (${row.kind}, team ${row.team_id}) is unfinished. ` +
        (row.kind === "backup"
          ? "If its executor has stopped, use sync:maintenance-recover --job-id with --dry-run, then --confirm-drained; start the next backup at a new destination."
          : "Resume or recover that job before starting a backup."),
    ),
    {
      code: "ACTIVE_MAINTENANCE_JOB",
      jobId: row.job_id,
      teamId: row.team_id,
      status: 409,
    },
  );
}

export function abandonedBackup(
  row,
  { confirmedDrained = false, dryRun = false } = {},
) {
  if (
    !row ||
    row.kind !== "backup" ||
    ["complete", "cancelled"].includes(row.phase)
  )
    throw Object.assign(new Error("An unfinished backup job is required."), {
      status: 409,
    });
  if (!dryRun && !confirmedDrained)
    throw Object.assign(
      new Error(
        "Stop the earlier backup executor, verify it has exited, then confirm drained execution before cancelling its backup guard.",
      ),
      { status: 409 },
    );
  const result = {
    jobId: row.job_id,
    teamId: row.team_id,
    kind: row.kind,
    previousPhase: row.phase,
    phase: "cancelled",
    dryRun,
  };
  return {
    result,
    progress: {
      ...JSON.parse(row.progress),
      recovery: {
        confirmedDrained: true,
        previousPhase: row.phase,
        recoveredAt: new Date().toISOString(),
        reason:
          "Stopped backup executor confirmed drained; incomplete artifacts remain untrusted.",
      },
    },
  };
}

// PostgreSQL only: the SQLite command keeps its existing synchronous exclusive
// transaction. Both paths use the same explicit drained-executor policy above.
export async function recoverBackupJob(database, teamId, jobId, options = {}) {
  if (database.engine !== "postgres")
    throw new Error("Use synchronous maintenance recovery for SQLite");
  return database.withTeamTransaction(
    teamId,
    async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2",
          [teamId, jobId],
        )
      ).rows[0];
      const { result, progress } = abandonedBackup(row, options);
      if (options.dryRun) return result;
      await tx.query(
        "UPDATE site_maintenance_jobs SET phase='cancelled',progress=$3 WHERE team_id=$1 AND job_id=$2",
        [teamId, jobId, canonical(progress)],
      );
      await tx.query(
        "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,'site-maintenance-recovery',$4,$5,$6)",
        [
          crypto.randomUUID(),
          teamId,
          options.actorId || "maintenance-cli",
          jobId,
          canonical({ ...result, recovery: progress.recovery }),
          progress.recovery.recoveredAt,
        ],
      );
      return result;
    },
    { readOnly: !!options.dryRun },
  );
}
