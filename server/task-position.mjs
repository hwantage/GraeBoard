import { nextTaskStamp } from "./db.mjs";
import { requireThat } from "./validation.mjs";

// Call inside the creation transaction so a failed insert also rolls back spacing.
export function insertionPosition(db, teamId, year, targetId, placement) {
  const years = Array.isArray(year) ? year : [year];
  const rows = db
    .prepare(
      `SELECT id,position,updated_at FROM tasks WHERE team_id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM json_each(years) WHERE value IN (${years.map(() => "?").join(",")})) ORDER BY position,created_at,id`,
    )
    .all(teamId, ...years);
  const target = rows.findIndex((row) => row.id === targetId);
  requireThat(target >= 0, 409, "기준 행이 변경되었습니다. 다시 선택하세요.");
  const index = target + (placement === "after" ? 1 : 0);
  const position = () => {
    const before = rows[index - 1]?.position,
      after = rows[index]?.position;
    return before === undefined
      ? after - 100
      : after === undefined
        ? before + 100
        : before + (after - before) / 2;
  };
  const candidate = position();
  if (
    Number.isFinite(candidate) &&
    (!rows[index - 1] || candidate > rows[index - 1].position) &&
    (!rows[index] || candidate < rows[index].position)
  )
    return candidate;
  const update = db.prepare(
    "UPDATE tasks SET position=?,updated_at=? WHERE id=?",
  );
  rows.forEach((row, i) => {
    row.position = (i + 1) * 1000;
    update.run(row.position, nextTaskStamp(row.updated_at), row.id);
  });
  return position();
}
