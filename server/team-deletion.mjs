import { audit, parse, transaction } from "./db.mjs";
import { requireThat } from "./validation.mjs";
import { stableId } from "./transfer.mjs";

export function deleteTeam(db, teamId, actorId) {
  return transaction(db, () => {
    const team = db.prepare("SELECT id FROM teams WHERE id=?").get(teamId);
    requireThat(team, 404, "팀을 찾을 수 없습니다.");
    // Match the existing account-management rule: active admins need a team.
    const strandedAdmin = db
      .prepare(
        `
      SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
      WHERE m.team_id=? AND u.role='admin' AND u.active=1
        AND NOT EXISTS(SELECT 1 FROM memberships other WHERE other.user_id=u.id AND other.team_id<>?)
    `,
      )
      .get(teamId, teamId);
    requireThat(
      !strandedAdmin,
      409,
      "이 팀에만 배속된 시스템 관리자가 있습니다. 해당 관리자를 다른 팀에 배속한 뒤 삭제하세요.",
    );

    // Batch responses contain cell contents even after the tasks are deleted.
    db.prepare(
      `DELETE FROM operations WHERE id IN (
      SELECT target FROM audit WHERE team_id=? AND action='cells'
    ) OR EXISTS (
      SELECT 1 FROM json_each(operations.response, '$.cells') c
      JOIN tasks t ON t.id=json_extract(c.value, '$.taskId') WHERE t.team_id=?
    )`,
    ).run(teamId, teamId);
    // Import replay IDs predate a team reference in their response. Remove all
    // possible replay keys for this team's previews, across supported years.
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
