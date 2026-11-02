// A link between documents is an ordinary Markdown link to an app path:
//
//   [업무 제목](/links/task/<업무 UUID>)
//   [일정 제목](/links/calendar/<일정 UUID>)
//
// The path has no origin, so the same body opens on the internal and the
// external site after synchronization. The link text is the title at paste
// time; the editor shows the target's current title instead.
export const DOCUMENT_LINK_KINDS = ["task", "calendar"];
// IDs per kind in one title lookup.
export const DOCUMENT_LINK_BATCH = 100;
const LINK_PATH =
  /^\/links\/(task|calendar)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function documentLinkPath({ kind, id }) {
  return `/links/${kind}/${id}`;
}

// The stored path only: no origin, query or fragment.
/** @returns {{ kind: "task" | "calendar", id: string } | null} */
export function parseDocumentLinkPath(path) {
  const match = LINK_PATH.exec(String(path));
  return match ? { kind: match[1], id: match[2] } : null;
}
