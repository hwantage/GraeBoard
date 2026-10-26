import { audit, parse, transaction, pruneStyles } from "./db.mjs";
import { requireThat } from "./validation.mjs";
import { stableId } from "./transfer.mjs";

export function deleteTeam(db, teamId, actorId) {
  return transaction(db, () => {
    const team = db.prepare("SELECT id FROM teams WHERE id=?").get(teamId);
    requireThat(team, 404, "팀을 찾을 수 없습니다.");
    const link = db.prepare('SELECT mode,lease_owner FROM team_sync_links WHERE team_id=?').get(teamId);
    requireThat(!link || (link.mode === 'disconnected' && !link.lease_owner),409,'동기화 연결을 먼저 해제하세요.');
    requireThat(!db.prepare("SELECT 1 FROM sync_outbox WHERE team_id=? AND status<>'acknowledged' LIMIT 1").get(teamId),409,'미전송 변경이 남아 있습니다. 동기화·백업을 확인한 뒤 삭제하세요.');
    requireThat(!db.prepare("SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')").get(teamId),409,'정리·백업 작업을 먼저 완료하세요.');
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
      "annual_memos",
      "calendar_entries",
      "calendar_tags",
      "calendar_weekly_items",
      "calendar_rules",
      "format_rules",
      "format_states",
      "tasks",
      "views",
      "filter_states",
      "saved_filters",
      "reports",
      "audit",
      "imports",
      "memberships",
      "team_revisions",
      "sync_entities",
      "sync_outbox",
      "sync_receipts",
      "sync_conflicts",
      "sync_objects",
      "sync_person_refs",
      "site_retention",
      "site_maintenance_jobs",
      "site_entity_revisions",
      "site_events",
      "team_sync_links",
    ])
      db.prepare(`DELETE FROM ${table} WHERE team_id=?`).run(teamId);
    db.prepare("DELETE FROM teams WHERE id=?").run(teamId);
    pruneStyles(db);
    // Keep only the administrative deletion event, without the deleted payload.
    audit(db, actorId, null, "team-delete", teamId);
    return { ok: true };
  });
}
