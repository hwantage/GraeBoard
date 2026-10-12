import { audit, parse, transaction } from "./db.mjs";
import { requireThat } from "./validation.mjs";
import { stableId } from "./transfer.mjs";

export function deleteTeam(db, teamId, actorId) {
  return transaction(db, () => {
    const team = db.prepare("SELECT id FROM teams WHERE id=?").get(teamId);
    requireThat(team, 404, "팀을 찾을 수 없습니다.");
    // References retain team IDs so cleanup also works after an audit expires.
    db.prepare(
      `DELETE FROM operations WHERE EXISTS (
      SELECT 1 FROM json_each(operations.response, '$.refs') r
      WHERE json_extract(r.value, '$.teamId')=?
    )`,
    ).run(teamId);
    // Import operations use deterministic IDs for each sheet, mode and year.
    const removeOperation = db.prepare("DELETE FROM operations WHERE id=?");
    for (const preview of db
      .prepare("SELECT id,data FROM imports WHERE team_id=?")
      .all(teamId)) {
      for (const sheet of parse(preview.data, [])) {
        for (const mode of ["tasks", "report"]) {
          for (let year = 2000; year <= 2100; year++)
            removeOperation.run(
              stableId(`${preview.id}:${sheet.name}:${mode}:${year}`),
            );
        }
      }
    }
    db.prepare(
      "DELETE FROM cells WHERE task_id IN (SELECT id FROM tasks WHERE team_id=?)",
    ).run(teamId);
    for (const table of [
      "tasks",
      "views",
      "filter_states",
      "saved_filters",
      "reports",
      "audit",
      "imports",
      "memberships",
      "team_revisions",
    ])
      db.prepare(`DELETE FROM ${table} WHERE team_id=?`).run(teamId);
    db.prepare("DELETE FROM teams WHERE id=?").run(teamId);
    // Keep only the administrative deletion event, without the deleted payload.
    audit(db, actorId, null, "team-delete", teamId);
    return { ok: true };
  });
}
