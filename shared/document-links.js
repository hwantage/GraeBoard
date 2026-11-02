// A link between documents is an ordinary Markdown link to an app path:
//
//   [업무 제목](/links/task/<업무 UUID>)
//   [일정 제목](/links/calendar/<일정 UUID>)
//   [메모 제목](/links/memo/<팀 UUID>/<연도>/<메모 ID>)
//   [업무 제목](/links/report-task/<사본 UUID>/<업무 UUID>)
//   [메모 제목](/links/report-memo/<사본 UUID>/<메모 ID>)
//
// The path has no origin, so the same body opens on the internal and the
// external site after synchronization. A copy's task keeps the original's ID,
// so its link also names the copy. The link text is the title at paste time;
// the editor shows the target's current title instead.

/**
 * @typedef {{ kind: "task" | "calendar", id: string }
 *   | { kind: "memo", teamId: string, year: number, id: string }
 *   | { kind: "report-task" | "report-memo", reportId: string, id: string }} DocumentLink
 */

// Links in one title lookup.
export const DOCUMENT_LINK_BATCH = 50;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Memo IDs follow the document IDs: the default `main` or a UUID.
const DOCUMENT = `main|${UUID}`;
const LINK_PATH = new RegExp(
  `^/links/(?:(task|calendar)/(${UUID})|memo/(${UUID})/(\\d{4})/(${DOCUMENT})|(report-task)/(${UUID})/(${UUID})|(report-memo)/(${UUID})/(${DOCUMENT}))$`,
);

/** @param {DocumentLink} link */
export function documentLinkPath(link) {
  if (link.kind === "memo")
    return `/links/memo/${link.teamId}/${link.year}/${link.id}`;
  if (link.kind === "report-task" || link.kind === "report-memo")
    return `/links/${link.kind}/${link.reportId}/${link.id}`;
  return `/links/${link.kind}/${link.id}`;
}

// The stored path only: no origin, query or fragment.
/** @returns {DocumentLink | null} */
export function parseDocumentLinkPath(path) {
  const m = LINK_PATH.exec(String(path));
  if (!m) return null;
  if (m[1])
    return { kind: /** @type {"task" | "calendar"} */ (m[1]), id: m[2] };
  if (m[3]) {
    const year = Number(m[4]);
    return year >= 2000 && year <= 2100
      ? { kind: "memo", teamId: m[3], year, id: m[5] }
      : null;
  }
  if (m[6]) return { kind: "report-task", reportId: m[7], id: m[8] };
  return { kind: "report-memo", reportId: m[10], id: m[11] };
}
