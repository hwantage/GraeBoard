import { audit, now, parse, transaction } from "./db.mjs";
import { encodeReport } from "./reports.mjs";
import { reportResponse, reportRevision } from "./report-editing.mjs";
import {
  storeReportDocuments,
  syncReportDocuments,
  readReport,
} from "./document-storage.mjs";
import { canContribute } from "../shared/domain.js";
import { requireThat } from "../shared/validation.js";

// Sheet identity is independent of the task ID, which copies can share.
export const auditSheetSql = `CASE
  WHEN a.action IN ('report','report-edit','report-rename','report-delete','report-restore') THEN a.target
  WHEN a.action='report-document' OR (a.action LIKE 'document-%' AND length(a.target)>36) THEN substr(a.target,1,36)
  ELSE COALESCE(json_extract(a.after_json,'$.$data.reportId'),json_extract(a.after_json,'$.reportId')) END`;

export function deletedReportTasks(db, entry, report) {
  const deleted = parse(entry.before_json)?.deletedTasks || [];
  const current = new Set(report.tasks.map((task) => task.id));
  const newer = new Set(
    db
      .prepare(
        `SELECT DISTINCT t.value AS id FROM audit a,
    json_each(COALESCE(json_extract(a.after_json,'$.$data.deletedTaskIds'),json_extract(a.after_json,'$.deletedTaskIds'),'[]')) t
    WHERE a.team_id=? AND a.target=? AND a.action='report-edit'
      AND a.rowid>(SELECT rowid FROM audit WHERE id=?)`,
      )
      .all(entry.team_id, entry.target, entry.id)
      .map((row) => row.id),
  );
  return deleted.filter((task) => !current.has(task.id) && !newer.has(task.id));
}

export function restoreReportTasks(db, user, entry, revision) {
  return transaction(db, () => {
    const row = db
      .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
      .get(entry.target, entry.team_id);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    requireThat(
      canContribute(user, row.team_id),
      403,
      "사본을 편집할 권한이 없습니다.",
    );
    const report = readReport(db, row);
    requireThat(
      revision === reportRevision(row.data, report),
      409,
      "사본이 변경되었습니다. 이력을 다시 확인하세요.",
    );
    const deleted = deletedReportTasks(db, entry, report);
    requireThat(
      deleted.length,
      409,
      "이미 복구되었거나 이후 삭제 이력이 있습니다. 최신 이력을 확인하세요.",
    );
    const tasks = storeReportDocuments(
      db,
      [
        ...report.tasks,
        ...deleted.map((task) => ({
          ...task,
          deletedAt: null,
          updatedAt: now(),
        })),
      ],
      row.team_id,
      user.id,
    );
    const users = new Map([
      ...(parse(entry.before_json)?.deletedUsers || []).map((user) => [
        user.id,
        user,
      ]),
      ...report.users.map((user) => [user.id, user]),
    ]);
    const data = encodeReport({ ...report, tasks, users: [...users.values()] });
    db.prepare("UPDATE reports SET data=? WHERE id=?").run(data, row.id);
    syncReportDocuments(db, row.id, tasks);
    audit(db, user.id, row.team_id, "report-restore", row.id, undefined, {
      name: row.name,
      taskIds: deleted.map((task) => task.id),
      restoredFrom: entry.id,
    });
    return reportResponse(db, { ...row, data });
  });
}
