// The offline SheetClone conversion is the only code that still knows the
// names a sheet clone had before SQLite v34, PostgreSQL team v3, JSON export
// v7 and sync protocols 3/4. The application never imports this directory.
export const CONVERSION = "sheet-clone-1";

const ENTITIES = {
  report: "sheetClone",
  reportTask: "sheetCloneTask",
  reportCell: "sheetCloneCell",
};
const DOCUMENT_SCOPES = { report: "sheetClone", reportMemo: "sheetCloneMemo" };
const IMPORT_MODES = {
  report: "create-sheet-clone",
  copy: "append-to-sheet-clone",
};

export const entityName = (entity) => ENTITIES[entity] || entity;
export const documentKey = (key) =>
  Array.isArray(key) && Object.hasOwn(DOCUMENT_SCOPES, key[0])
    ? [DOCUMENT_SCOPES[key[0]], ...key.slice(1)]
    : key;
export const isLegacyDocumentKey = (key) =>
  Array.isArray(key) && Object.hasOwn(DOCUMENT_SCOPES, key[0]);
export const entityKey = (entity, key) =>
  entity === "document" ? documentKey(key) : key;
export const entityId = (entity, key) => JSON.stringify([entity, key]);
// `["report",["id"]]` as stored by the synchronization tables and events.
export function entityIdText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !Array.isArray(value[1])
  )
    return text;
  const [entity, key] = value,
    next = entityName(entity),
    nextKey = entityKey(entity, key);
  return next === entity && nextKey === key ? text : entityId(next, nextKey);
}
// report, report-edit, report-memo-create, ... -> sheet-clone, sheet-clone-...
export const auditAction = (action) =>
  action === "report"
    ? "sheet-clone"
    : typeof action === "string" && action.startsWith("report-")
      ? "sheet-clone-" + action.slice("report-".length)
      : action;
export const importMode = (mode) => IMPORT_MODES[mode] || mode;
export const isLegacyImportMode = (mode) => Object.hasOwn(IMPORT_MODES, mode);
