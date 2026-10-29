import { canonical, digest, entityId, protocolVersion } from "./protocol.mjs";

export const splitReportRecord = (record) => {
  if (
    record?.entity !== "report" ||
    !Array.isArray(record.payload?.data?.tasks)
  )
    return record ? [record] : [];
  const { tasks, ...data } = record.payload.data;
  const records = [{ ...record, payload: { ...record.payload, data } }],
    ids = new Set();
  tasks.forEach((task, index) => {
    if (ids.has(task.id))
      throw new Error(
        "Duplicate report task identity prevents lossless protocol upgrade",
      );
    ids.add(task.id);
    const { cells = {}, ...metadata } = task;
    const parent = {
      ...record,
      entity: "reportTask",
      key: [record.key[0], task.id],
      payload: { data: metadata, index },
    };
    records.push(parent);
    for (const [key, cell] of Object.entries(cells))
      records.push({
        ...record,
        entity: "reportCell",
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

// Application repositories continue to read their established report shape.
// Canonical v2 rows retain independent identities and are never rewritten into
// the report parent simply to serve a legacy-shaped HTTP response.
export function applicationEntities(entities) {
  if (protocolVersion({ entities }) === 1) return entities;
  const output = {},
    tasks = new Map(),
    cells = new Map();
  for (const [id, record] of Object.entries(entities)) {
    if (record.entity === "protocol") continue;
    if (record.entity === "reportTask") {
      if (!tasks.has(record.key[0])) tasks.set(record.key[0], []);
      tasks.get(record.key[0]).push(record);
    } else if (record.entity === "reportCell") {
      const key = canonical(record.key.slice(0, 2));
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(record);
    } else output[id] = record;
  }
  for (const [id, record] of Object.entries(output)) {
    if (record.entity !== "report") continue;
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
    output[id] = {
      ...record,
      payload: {
        ...record.payload,
        data: { ...record.payload.data, tasks: rows },
      },
    };
  }
  return output;
}

export function upgradeState(state) {
  if (protocolVersion(state) !== 1)
    throw new Error("Protocol upgrade requires version 1");
  if (Object.values(state.conflicts).some((conflict) => !conflict.resolution))
    throw new Error("Protocol upgrade requires resolved conflicts");
  const entities = {};
  for (const record of Object.values(state.entities)) {
    for (const next of splitReportRecord(record)) {
      const changed = next !== record;
      entities[entityId(next.entity, next.key)] = changed
        ? {
            ...next,
            generation:
              next.entity === "report"
                ? record.generation
                : digest([
                    "protocol-2-generation",
                    record.generation,
                    next.entity,
                    next.key,
                  ]),
            version:
              record.deleted && next.entity !== "report"
                ? digest([
                    "protocol-2-version",
                    record.version,
                    "report",
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
  const token = digest(["protocol-2", digest(state)]);
  entities[entityId("protocol", [])] = {
    entity: "protocol",
    key: [],
    generation: token,
    version: token,
    payload: { version: 2, reducer: 2 },
    deleted: false,
  };
  return {
    entities,
    receipts: { ...state.receipts },
    conflicts: { ...state.conflicts },
  };
}
