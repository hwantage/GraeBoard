// Copy only metadata and immutable body references. The source and destination
// own independent rows, and later edits replace only the destination reference.
export function copySheetCloneMemos(
  db,
  { sheetCloneId, sourceId, teamId, year, actorId, visibleDocument },
) {
  const table = sourceId ? "sheet_clone_memos" : "annual_memos";
  const where = sourceId ? "sheet_clone_id=?" : "team_id=? AND year=?";
  const args = sourceId ? [sourceId] : [teamId, year];
  const ids = visibleDocument
    ? db
        .prepare(`SELECT id FROM ${table} WHERE ${where}`)
        .all(...args)
        .map((row) => row.id)
        .filter(visibleDocument)
    : null;
  db.prepare(
    `INSERT INTO sheet_clone_memos(sheet_clone_id,id,title,position,version_id,has_content,revision,updated_at,actor_id)
    SELECT ?,id,title,position,version_id,has_content,0,updated_at,? FROM ${table} WHERE ${where}${ids ? " AND id IN (SELECT value FROM json_each(?))" : ""}`,
  ).run(sheetCloneId, actorId, ...args, ...(ids ? [JSON.stringify(ids)] : []));
}

// Bodies are materialized only for explicit JSON export, never for opening a sheet.
export function memoContents(db, { sheetCloneId, teamId, year }) {
  const table = sheetCloneId ? "sheet_clone_memos" : "annual_memos";
  const where = sheetCloneId
    ? "m.sheet_clone_id=?"
    : "m.team_id=? AND m.year=?";
  return db
    .prepare(
      `SELECT m.id,m.title,v.markdown FROM ${table} m
    JOIN document_versions v ON v.id=m.version_id WHERE ${where} ORDER BY m.position,m.id`,
    )
    .all(...(sheetCloneId ? [sheetCloneId] : [teamId, year]));
}
