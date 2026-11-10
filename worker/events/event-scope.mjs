// Which streams a site event can change. A "changed" event names the records
// its write touched, so a stream skips an event that names none of the records
// it shows, as the internal site invalidates only the resources a write
// touched. An event without names (a received sync commit, maintenance) still
// reaches every stream.

// Records that only their own streams show. A change to any other record (team
// settings, rules, formats, members) can change what every stream shows.
const OWN_STREAMS = new Set([
  "cell",
  "task",
  "document",
  "calendar",
  "tag",
  "weekly",
  "person",
  "sheetClone",
]);
// Document kinds that only their own panels show, never a team-wide view.
const PANEL_DOCUMENTS = new Set(["annual", "sheetCloneMemo", "sheetClone"]);
// Records the task sheet's cell stream does not show. Task documents are
// among them: their indicator follows the team stream, as on the internal site.
const SHEET_QUIET = new Set(["document", "calendar", "tag", "sheetClone"]);

const startsWith = (key, prefix) =>
  Array.isArray(key) && prefix.every((part, i) => key[i] === part);

// The records a stream shows, from its path and, for documents, the scope its
// route resolved (`{kind, prefix, documentId}`).
export function streamScope(path, documentScope = null) {
  let m;
  if ((m = /^\/teams\/([^/]+)$/.exec(path))) return { kind: "team" };
  if ((m = /^\/sheet-clones\/([^/]+)$/.exec(path)))
    return { kind: "sheetClone", id: m[1] };
  if (!documentScope) return { kind: "all" };
  const { kind, prefix, documentId } = documentScope,
    parent =
      kind === "annual"
        ? null
        : [kind === "sheetCloneMemo" ? "sheetClone" : kind, prefix[1]];
  return documentId
    ? { kind: "document", key: [...prefix, documentId], parent }
    : { kind: "documents", prefix, parent };
}

function touches(scope, { entity, key }) {
  if (!OWN_STREAMS.has(entity) || !Array.isArray(key)) return true;
  switch (scope.kind) {
    // Task rows reach the team as on the internal site's task requests; cell
    // values follow the cell stream.
    case "team":
      return !(
        entity === "cell" ||
        (entity === "document" && PANEL_DOCUMENTS.has(key[0]))
      );
    case "sheetClone":
      return (
        (entity === "sheetClone" && key[0] === scope.id) ||
        (entity === "document" &&
          key[0] === "sheetClone" &&
          key[1] === scope.id)
      );
    case "document":
      return (
        (entity === "document" &&
          key.length === scope.key.length &&
          startsWith(key, scope.key)) ||
        (!!scope.parent &&
          entity === scope.parent[0] &&
          key[0] === scope.parent[1])
      );
    case "documents":
      return (
        (entity === "document" &&
          key.length === scope.prefix.length + 1 &&
          startsWith(key, scope.prefix)) ||
        (!!scope.parent &&
          entity === scope.parent[0] &&
          key[0] === scope.parent[1])
      );
    default:
      return true;
  }
}

const named = (event) =>
  event.kind === "changed" &&
  Array.isArray(event.payload?.entities) &&
  event.payload.entities.length > 0
    ? event.payload.entities
    : null;

// Whether one site_events row (`payload` parsed) can change a stream. Cell
// deltas reach only the cell stream.
export function eventTouches(scope, event) {
  if (event.kind === "cells") return false;
  const entities = named(event);
  return !entities || entities.some((change) => touches(scope, change));
}

// Whether the cell stream can skip a non-cell event instead of resetting every
// task sheet: the event names only records the sheet does not show.
export function sheetQuiet(event) {
  const entities = named(event);
  return !!entities && entities.every(({ entity }) => SHEET_QUIET.has(entity));
}
