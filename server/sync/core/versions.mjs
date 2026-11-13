import {
  canonical,
  digest,
  entityId,
  protocolVersion,
  protocolMarker,
  PROTOCOL,
  ROW_PROTOCOL,
  SPLIT_PROTOCOL,
  sheetCloneFormatId,
} from "./protocol.mjs";
import {
  packSheetCloneData,
  unpackSheetCloneData,
} from "../../../shared/sheet-clones/sheet-clone-sync-data.js";

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

const plainObject = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
// Protocol 5: the parent keeps the row order, each distinct formatting value
// is one record keyed by its hash and each row is one record with its cells.
// A row whose formatting is not an object keeps it in its own data.
export const splitSheetCloneRows = (record) => {
  if (!record) return [];
  const source =
    record.entity === "sheetClone"
      ? unpackSheetCloneData(record.payload?.data)
      : null;
  if (!Array.isArray(source?.tasks)) return [record];
  const { tasks, ...data } = source,
    formats = new Map(),
    ids = new Set(),
    rows = [];
  for (const task of tasks) {
    if (ids.has(task.id))
      throw new Error(
        "Duplicate sheet clone task identity prevents lossless protocol upgrade",
      );
    ids.add(task.id);
    const { cells = {}, ...metadata } = task;
    let format = null;
    if (plainObject(metadata.formatting)) {
      format = sheetCloneFormatId(metadata.formatting);
      if (!formats.has(format))
        formats.set(format, {
          ...record,
          entity: "sheetCloneFormat",
          key: [record.key[0], format],
          payload: { data: metadata.formatting },
        });
      delete metadata.formatting;
    }
    rows.push({
      ...record,
      entity: "sheetCloneTask",
      key: [record.key[0], task.id],
      payload: { data: metadata, format, cells },
    });
  }
  return [
    {
      ...record,
      payload: {
        ...record.payload,
        data,
        order: tasks.map((task) => task.id),
      },
    },
    ...formats.values(),
    ...rows,
  ];
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
  const version = protocolVersion({ entities });
  if (version === ROW_PROTOCOL) return composedRows(entities);
  if (version !== SPLIT_PROTOCOL) {
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

// Protocol 5 recomposition: rows in the parent's order, then any row the
// order does not list by key; an order entry without a visible row is
// skipped. `only` limits the work to those sheet clone IDs.
export function composedRows(entities, only = null) {
  const output = {},
    rows = new Map(),
    formats = new Map();
  for (const [id, record] of Object.entries(entities)) {
    if (record.entity === "protocol") continue;
    if (record.entity === "sheetCloneTask") {
      if (!rows.has(record.key[0])) rows.set(record.key[0], []);
      rows.get(record.key[0]).push(record);
    } else if (record.entity === "sheetCloneFormat")
      formats.set(canonical(record.key), record);
    else output[id] = record;
  }
  for (const [id, record] of Object.entries(output)) {
    if (record.entity !== "sheetClone") continue;
    if (only && !only.has(record.key[0])) {
      delete output[id];
      continue;
    }
    const visible = new Map(
        (rows.get(record.key[0]) || [])
          .filter((row) => visibleChild(record, row))
          .sort(compareKeys)
          .map((row) => [row.key[1], row]),
      ),
      ordered = [];
    for (const taskId of record.payload.order || []) {
      const row = visible.get(taskId);
      if (!row) continue;
      ordered.push(row);
      visible.delete(taskId);
    }
    ordered.push(...visible.values());
    const { order: _order, ...payload } = record.payload;
    output[id] = {
      ...record,
      payload: {
        ...payload,
        data: packSheetCloneData({
          ...unpackSheetCloneData(record.payload.data),
          tasks: ordered.map((row) => {
            const format =
              row.payload.format &&
              formats.get(canonical([record.key[0], row.payload.format]));
            return {
              ...row.payload.data,
              ...(format ? { formatting: format.payload.data } : {}),
              cells: row.payload.cells,
            };
          }),
        }),
      },
    };
  }
  return output;
}

// The explicit transition from protocol 3: each sheet clone is split into
// deterministic records, rows and cells for protocol 4 (formerly 1 -> 2) or
// formats and rows for protocol 5. The token labels are part of each format.
export function upgradeState(state, target = SPLIT_PROTOCOL) {
  if (![SPLIT_PROTOCOL, ROW_PROTOCOL].includes(target))
    throw new Error("Unsupported protocol upgrade target");
  const split =
      target === ROW_PROTOCOL ? splitSheetCloneRows : splitSheetCloneRecord,
    label = target === ROW_PROTOCOL ? "protocol-5" : "protocol-2";
  if (protocolVersion(state) !== PROTOCOL)
    throw new Error("Protocol upgrade requires version 3");
  if (Object.values(state.conflicts).some((conflict) => !conflict.resolution))
    throw new Error("Protocol upgrade requires resolved conflicts");
  const entities = {};
  for (const record of Object.values(state.entities)) {
    for (const next of split(record)) {
      const changed = next !== record;
      entities[entityId(next.entity, next.key)] = changed
        ? {
            ...next,
            generation:
              next.entity === "sheetClone"
                ? record.generation
                : digest([
                    label + "-generation",
                    record.generation,
                    next.entity,
                    next.key,
                  ]),
            version:
              record.deleted && next.entity !== "sheetClone"
                ? digest([
                    label + "-version",
                    record.version,
                    "sheetClone",
                    record.key,
                  ]) + ":0"
                : digest([
                    label + "-version",
                    record.version,
                    next.entity,
                    next.key,
                  ]),
          }
        : record;
    }
  }
  entities[MARKER] = protocolMarker(
    target,
    digest(["protocol-" + target, digest(state)]),
  );
  return {
    entities,
    receipts: { ...state.receipts },
    conflicts: { ...state.conflicts },
  };
}
