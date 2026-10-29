import { isRecoveryError, isSyncInterruption } from "./errors.mjs";

export function createSyncErrorRecorder(db, capture) {
  const update =
    db.prepare(`UPDATE team_sync_links SET last_error=?,updated_at=?,
    mode=CASE WHEN ? THEN 'recovery' ELSE mode END,
    remote_status=CASE WHEN ? THEN NULL ELSE remote_status END
    WHERE team_id=? AND (last_error IS NOT ? OR (? AND mode<>'recovery'))`);
  return (teamId, error) => {
    if (isSyncInterruption(error)) return;
    const message =
      error == null || error.message === null
        ? null
        : error.message || String(error);
    const recovery = Number(isRecoveryError(error));
    const result = update.run(
      message,
      new Date().toISOString(),
      recovery,
      recovery,
      teamId,
      message,
      recovery,
    );
    if (recovery && result.changes) capture.refresh();
  };
}
