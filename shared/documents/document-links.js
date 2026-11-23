// A link between documents is an ordinary Markdown link to an app path:
//
//   [업무 제목](/links/task/<업무 UUID>)
//   [업무 제목](/links/task/<업무 UUID>/<문서 ID>)
//   [일정 제목](/links/calendar/<일정 UUID>)
//   [메모 제목](/links/memo/<팀 UUID>/<연도>/<메모 ID>)
//   [업무 제목](/links/sheet-clone-task/<사본 UUID>/<업무 UUID>)
//   [업무 제목](/links/sheet-clone-task/<사본 UUID>/<업무 UUID>/<문서 ID>)
//   [메모 제목](/links/sheet-clone-memo/<사본 UUID>/<메모 ID>)
//
// The path has no origin, so the same body opens on the internal and the
// external site after synchronization. A copy's task keeps the original's ID,
// so its link also names the copy. The link text is the title at paste time;
// the editor shows the target's current title instead.
//
// A task link may end with one of the task's documents (2026-11-23): the
// detail then opens showing that document instead of the first. It is the
// link copied from a task with several documents; its title stays the task's.

/**
 * @typedef {{ kind: "task", id: string, documentId?: string }
 *   | { kind: "calendar", id: string }
 *   | { kind: "memo", teamId: string, year: number, id: string }
 *   | { kind: "sheet-clone-task", sheetCloneId: string, id: string, documentId?: string }
 *   | { kind: "sheet-clone-memo", sheetCloneId: string, id: string }} DocumentLink
 */

// Links in one title lookup.
export const DOCUMENT_LINK_BATCH = 50;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Memo and task document IDs: the default `main` or a UUID.
const DOCUMENT = `main|${UUID}`;
const LINK_PATH = new RegExp(
  `^/links/(?:task/(?<task>${UUID})(?:/(?<taskDocument>${DOCUMENT}))?|calendar/(?<calendar>${UUID})|memo/(?<memoTeam>${UUID})/(?<memoYear>\\d{4})/(?<memo>${DOCUMENT})|sheet-clone-task/(?<cloneOfTask>${UUID})/(?<cloneTask>${UUID})(?:/(?<cloneTaskDocument>${DOCUMENT}))?|sheet-clone-memo/(?<cloneOfMemo>${UUID})/(?<cloneMemo>${DOCUMENT}))$`,
);

/** @param {DocumentLink} link */
export function documentLinkPath(link) {
  if (link.kind === "memo")
    return `/links/memo/${link.teamId}/${link.year}/${link.id}`;
  const document =
    (link.kind === "task" || link.kind === "sheet-clone-task") &&
    link.documentId
      ? `/${link.documentId}`
      : "";
  if (link.kind === "sheet-clone-task" || link.kind === "sheet-clone-memo")
    return `/links/${link.kind}/${link.sheetCloneId}/${link.id}${document}`;
  return `/links/${link.kind}/${link.id}${document}`;
}

/**
 * The same target without the document a task link may name: the detail
 * window it opens, whichever document is shown.
 * @template {DocumentLink} T
 * @param {T} link
 * @returns {T}
 */
export function documentLinkWithoutDocument(link) {
  if (link.kind !== "task" && link.kind !== "sheet-clone-task") return link;
  const { documentId, ...target } = link;
  return /** @type {T} */ (target);
}

// The stored path only: no origin, query or fragment.
/** @returns {DocumentLink | null} */
export function parseDocumentLinkPath(path) {
  const found = LINK_PATH.exec(String(path))?.groups;
  if (!found) return null;
  if (found.task)
    return {
      kind: "task",
      id: found.task,
      ...(found.taskDocument ? { documentId: found.taskDocument } : {}),
    };
  if (found.calendar) return { kind: "calendar", id: found.calendar };
  if (found.memo) {
    const year = Number(found.memoYear);
    return year >= 2000 && year <= 2100
      ? { kind: "memo", teamId: found.memoTeam, year, id: found.memo }
      : null;
  }
  if (found.cloneTask)
    return {
      kind: "sheet-clone-task",
      sheetCloneId: found.cloneOfTask,
      id: found.cloneTask,
      ...(found.cloneTaskDocument
        ? { documentId: found.cloneTaskDocument }
        : {}),
    };
  return {
    kind: "sheet-clone-memo",
    sheetCloneId: found.cloneOfMemo,
    id: found.cloneMemo,
  };
}
