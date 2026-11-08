import {
  canonical,
  digest,
  entityId,
  protocolVersion,
  protocolMarker,
  PROTOCOL,
  SPLIT_PROTOCOL,
} from "./protocol.mjs";
import {
  packSheetCloneData,
  unpackSheetCloneData,
} from "../../shared/sheet-clones/sheet-clone-sync-data.js";

export const splitSheetCloneRecord = (record) => {
  if (!record) return [];
  // 프로토콜 3 사본 data는 공유 사전 형태일 수 있다. 행·셀로 나누기 전에 푼다.
  const source =
    record.entity === "sheetClone"
      ? unpackSheetCloneData(record.payload?.data)
      : null;
  if (!Array.isArray(source?.tasks)) return [record];
  const { tasks, ...data } = source;
  const records = [{ ...record, payload: { ...record.payload, data } }],
    ids = new Set();
  tasks.forEach((task, index) => {
    if (ids.has(task.id))
      throw new Error(
        "Duplicate sheet clone task identity prevents lossless protocol upgrade",
      );
    ids.add(task.id);
    const { cells = {}, ...metadata } = task;
    const parent = {
      ...record,
      entity: "sheetCloneTask",
      key: [record.key[0], task.id],
      payload: { data: metadata, index },
    };
    records.push(parent);
    for (const [key, cell] of Object.entries(cells))
      records.push({
        ...record,
        entity: "sheetCloneCell",
        key: [record.key[0], task.id, key],
        payload: { data: cell },
      });
  });
  return records;
};

const deletionCommand = (record) =>
  record.version.slice(
    0,
    record.version.lastIndexOf(":") < 0
      ? undefined
      : record.version.lastIndexOf(":"),
  );
const visibleChild = (parent, child) =>
  parent.deleted
    ? child.deleted && deletionCommand(parent) === deletionCommand(child)
    : !child.deleted;
const compareKeys = (a, b) => {
  const left = canonical(a.key),
    right = canonical(b.key);
  return left < right ? -1 : left > right ? 1 : 0;
};

const MARKER = entityId("protocol", []);
// Application repositories continue to read their established sheet clone
// shape. Canonical protocol 4 rows retain independent identities and are never
// rewritten into the parent simply to serve a whole-sheet HTTP response. The
// protocol marker is not application data.
export function applicationEntities(entities) {
  if (protocolVersion({ entities }) !== SPLIT_PROTOCOL) {
    if (!Object.hasOwn(entities, MARKER)) return entities;
    const { [MARKER]: marker, ...rest } = entities;
    return rest;
  }
  const output = {},
    tasks = new Map(),
    cells = new Map();
  for (const [id, record] of Object.entries(entities)) {
    if (record.entity === "protocol") continue;
    if (record.entity === "sheetCloneTask") {
      if (!tasks.has(record.key[0])) tasks.set(record.key[0], []);
      tasks.get(record.key[0]).push(record);
    } else if (record.entity === "sheetCloneCell") {
      const key = canonical(record.key.slice(0, 2));
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(record);
    } else output[id] = record;
  }
  for (const [id, record] of Object.entries(output)) {
    if (record.entity !== "sheetClone") continue;
    const rows = (tasks.get(record.key[0]) || [])
      .filter((row) => visibleChild(record, row))
      .sort((a, b) => a.payload.index - b.payload.index || compareKeys(a, b))
      .map((row) => ({
        ...row.payload.data,
        cells: Object.fromEntries(
          (cells.get(canonical(row.key)) || [])
            .filter((cell) => visibleChild(row, cell))
            .map((cell) => [cell.key[2], cell.payload.data]),
        ),
      }));
    // 조합한 사본도 프로토콜 3과 같은 저장 형태(공유 사전)로 돌려준다.
    output[id] = {
      ...record,
      payload: {
        ...record.payload,
        data: packSheetCloneData({
          ...unpackSheetCloneData(record.payload.data),
          tasks: rows,
        }),
      },
    };
  }
  return output;
}

// The explicit protocol 3 -> 4 transition (formerly 1 -> 2): each sheet clone
// is split into deterministic row and cell records.
export function upgradeState(state) {
  if (protocolVersion(state) !== PROTOCOL)
    throw new Error("Protocol upgrade requires version 3");
  if (Object.values(state.conflicts).some((conflict) => !conflict.resolution))
    throw new Error("Protocol upgrade requires resolved conflicts");
  const entities = {};
  for (const record of Object.values(state.entities)) {
    for (const next of splitSheetCloneRecord(record)) {
      const changed = next !== record;
      entities[entityId(next.entity, next.key)] = changed
        ? {
            ...next,
            generation:
              next.entity === "sheetClone"
                ? record.generation
                : digest([
                    "protocol-2-generation",
                    record.generation,
                    next.entity,
                    next.key,
                  ]),
            version:
              record.deleted && next.entity !== "sheetClone"
                ? digest([
                    "protocol-2-version",
                    record.version,
                    "sheetClone",
                    record.key,
                  ]) + ":0"
                : digest([
                    "protocol-2-version",
                    record.version,
                    next.entity,
                    next.key,
                  ]),
          }
        : record;
    }
  }
  entities[MARKER] = protocolMarker(
    SPLIT_PROTOCOL,
    digest(["protocol-4", digest(state)]),
  );
  return {
    entities,
    receipts: { ...state.receipts },
    conflicts: { ...state.conflicts },
  };
}
