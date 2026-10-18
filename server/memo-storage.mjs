// Copy only metadata and immutable body references. The source and destination
// own independent rows, and later edits replace only the destination reference.
export function copyReportMemos(
  db,
  { reportId, sourceId, teamId, year, actorId },
) {
  const table = sourceId ? "report_memos" : "annual_memos";
  const where = sourceId ? "report_id=?" : "team_id=? AND year=?";
  db.prepare(
    `INSERT INTO report_memos(report_id,id,title,position,version_id,has_content,revision,updated_at,actor_id)
    SELECT ?,id,title,position,version_id,has_content,0,updated_at,? FROM ${table} WHERE ${where}`,
  ).run(reportId, actorId, ...(sourceId ? [sourceId] : [teamId, year]));
}

// Bodies are materialized only for explicit JSON export, never for opening a sheet.
export function memoContents(db, { reportId, teamId, year }) {
  const table = reportId ? "report_memos" : "annual_memos";
  const where = reportId ? "m.report_id=?" : "m.team_id=? AND m.year=?";
  return db
    .prepare(
      `SELECT m.id,m.title,v.markdown FROM ${table} m
    JOIN document_versions v ON v.id=m.version_id WHERE ${where} ORDER BY m.position,m.id`,
    )
    .all(...(reportId ? [reportId] : [teamId, year]));
}
