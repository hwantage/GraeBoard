import { nextTaskStamp } from "./db.mjs";
import { taskInsertionPlan } from "./storage/task-command-rules.mjs";

// Call inside the creation transaction so a failed insert also rolls back spacing.
export function insertionPosition(db, teamId, year, targetId, placement) {
  const years = Array.isArray(year) ? year : [year];
  const rows = db
    .prepare(
      `SELECT id,position,updated_at FROM tasks WHERE team_id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM json_each(years) WHERE value IN (${years.map(() => "?").join(",")})) ORDER BY position,created_at,id`,
    )
    .all(teamId, ...years);
  const plan = taskInsertionPlan(rows, targetId, placement);
  if (plan.rebased.length) {
    const update = db.prepare(
      "UPDATE tasks SET position=?,updated_at=? WHERE id=?",
    );
    for (const row of plan.rebased)
      update.run(row.position, nextTaskStamp(row.updated_at), row.id);
  }
  return plan.position;
}
