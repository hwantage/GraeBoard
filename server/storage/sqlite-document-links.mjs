import { retentionView } from "../sync/visibility.mjs";
import { parse } from "../db.mjs";
import { sheetCloneBrowseIndex } from "../sheet-clones.mjs";
import { parseDocumentLinkPath } from "../../shared/document-links.js";

// Current titles of linked documents with the reads that open them: a task
// as /calendar/tasks/:id, an entry as /calendar/entries/:id, memos and copy
// rows as their document routes (team access, deletion, retention). A target
// the user cannot open is left out rather than refused.
export function resolveSqliteDocumentLinks({ db, teamAccess, user }, paths) {
  const readable = new Map();
  const canRead = (teamId) => {
    if (!readable.has(teamId))
      try {
        teamAccess(user, teamId);
        readable.set(teamId, true);
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        readable.set(teamId, false);
      }
    return readable.get(teamId);
  };
  const sheetClones = new Map();
  const sheetClone = (id) => {
    if (!sheetClones.has(id)) {
      const row = db
        .prepare("SELECT id,team_id,data FROM sheet_clones WHERE id=?")
        .get(id);
      sheetClones.set(
        id,
        row &&
          canRead(row.team_id) &&
          !retentionView(db, row.team_id).hidden("sheetClone", [row.id])
          ? row
          : null,
      );
    }
    return sheetClones.get(id);
  };
  const taskRow = db.prepare(
    `SELECT t.id,t.team_id AS teamId,c.value AS title FROM tasks t LEFT JOIN cells c ON c.task_id=t.id AND c.key='title'
    WHERE t.id=? AND t.deleted_at IS NULL`,
  );
  const entryRow = db.prepare(
    `SELECT e.team_id AS teamId,e.title FROM calendar_entries e
    WHERE e.id=? AND e.deleted_at IS NULL
    AND (e.user_id IS NULL OR e.user_id IN (SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=e.team_id AND u.active=1) OR EXISTS (SELECT 1 FROM sync_person_refs p WHERE p.team_id=e.team_id AND p.person_id=e.user_id))`,
  );
  const memoRow = db.prepare(
    "SELECT title FROM annual_memos WHERE team_id=? AND year=? AND id=?",
  );
  const sheetCloneMemoRow = db.prepare(
    "SELECT title FROM sheet_clone_memos WHERE sheet_clone_id=? AND id=?",
  );
  const links = [];
  for (const path of paths) {
    const link = parseDocumentLinkPath(path);
    let found = null;
    if (link.kind === "task") {
      const row = taskRow.get(link.id);
      if (
        row &&
        canRead(row.teamId) &&
        !retentionView(db, row.teamId).hidden("task", [row.id])
      )
        found = { teamId: row.teamId, title: String(parse(row.title, "")) };
    } else if (link.kind === "calendar") {
      const row = entryRow.get(link.id);
      if (row && canRead(row.teamId)) found = row;
    } else if (link.kind === "memo") {
      const visibility = canRead(link.teamId)
        ? retentionView(db, link.teamId)
        : null;
      const row =
        visibility &&
        !visibility.years.has(String(link.year)) &&
        !visibility.hidden("document", ["annual", String(link.year), link.id])
          ? memoRow.get(link.teamId, link.year, link.id)
          : null;
      if (row) found = { teamId: link.teamId, title: row.title };
    } else {
      const sheet = sheetClone(link.sheetCloneId);
      if (sheet && link.kind === "sheet-clone-task") {
        const task = sheetCloneBrowseIndex(sheet.data).tasks.get(link.id);
        if (task)
          found = {
            teamId: sheet.team_id,
            title: String(task.cells.title?.value ?? ""),
          };
      } else if (
        sheet &&
        !retentionView(db, sheet.team_id).hidden("document", [
          "sheetCloneMemo",
          sheet.id,
          link.id,
        ])
      ) {
        const row = sheetCloneMemoRow.get(sheet.id, link.id);
        if (row) found = { teamId: sheet.team_id, title: row.title };
      }
    }
    if (found) links.push({ path, teamId: found.teamId, title: found.title });
  }
  return { links };
}
