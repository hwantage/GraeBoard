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

/** Records that belong to a sheet clone under protocols 4 and 5. */
export const isSheetCloneChild = (entity) =>
  [
    "sheetCloneTask",
    "sheetCloneCell",
    "sheetCloneFormat",
    "sheetCloneRule",
  ].includes(entity);
/** How a protocol splits a sheet clone into records; null when it does not. */
export const sheetCloneSplitter = (version) =>
  version === ROW_PROTOCOL
    ? splitSheetCloneRows
    : version === SPLIT_PROTOCOL
      ? splitSheetCloneRecord
      : null;

const plainObject = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
// Protocol 5: the parent keeps which formatting each row uses, each distinct
// formatting value is one record keyed by its hash that names its rules, each
// distinct rule is one record keyed by its hash and each row is one record
// with its cells. Rows are ordered by their own position (see
// sheetCloneRowOrder), so adding or moving a row changes no other record.
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
    rules = new Map(),
    // Rows usually share one formatting object, and formatting values share
    // their rule objects: hash each object once.
    formatIds = new Map(),
    ruleIds = new Map(),
    assigned = {},
    ids = new Set(),
    rows = [],
    child = (entity, id, payload) => ({
      ...record,
      entity,
      key: [record.key[0], id],
      payload,
    }),
    ruleId = (rule) => {
      if (!ruleIds.has(rule)) {
        const id = sheetCloneFormatId(rule);
        ruleIds.set(rule, id);
        if (!rules.has(id))
          rules.set(id, child("sheetCloneRule", id, { data: rule }));
      }
      return ruleIds.get(rule);
    },
    formatId = (formatting) => {
      if (!formatIds.has(formatting)) {
        // A formatting's rules are stored once each and named here, so
        // adding a rule adds that rule and this short list.
        const { rules: list, ...rest } = formatting,
          payload =
            Array.isArray(list) && list.every(plainObject)
              ? { data: rest, rules: list.map(ruleId) }
              : { data: formatting },
          id = sheetCloneFormatId(payload);
        formatIds.set(formatting, id);
        if (!formats.has(id))
          formats.set(id, child("sheetCloneFormat", id, payload));
      }
      return formatIds.get(formatting);
    };
  for (const task of tasks) {
    if (ids.has(task.id))
      throw new Error(
        "Duplicate sheet clone task identity prevents lossless protocol upgrade",
      );
    ids.add(task.id);
    const { cells = {}, ...metadata } = task;
    if (plainObject(metadata.formatting)) {
      assigned[task.id] = formatId(metadata.formatting);
      delete metadata.formatting;
    }
    rows.push(child("sheetCloneTask", task.id, { data: metadata, cells }));
  }
  return [
    {
      ...record,
      payload: {
        ...record.payload,
        data,
        formats: assigned,
      },
    },
    ...formats.values(),
    ...rules.values(),
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

// Protocol 5 recomposition (see sheetCloneRowOrder for the row order).
// `only` limits the work to those sheet clone IDs.
export function composedRows(entities, only = null) {
  const output = {},
    rows = new Map(),
    formats = new Map(),
    rules = new Map();
  for (const [id, record] of Object.entries(entities)) {
    if (record.entity === "protocol") continue;
    if (record.entity === "sheetCloneTask") {
      if (!rows.has(record.key[0])) rows.set(record.key[0], []);
      rows.get(record.key[0]).push(record);
    } else if (record.entity === "sheetCloneFormat")
      formats.set(canonical(record.key), record);
    else if (record.entity === "sheetCloneRule")
      rules.set(canonical(record.key), record);
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
        .map((row) => [row.key[1], row.payload]),
    );
    const composed = composeSheetClone(
      record.payload,
      sheetCloneRowOrder([...visible]),
      sheetCloneFormattings(
        (format) => formats.get(canonical([record.key[0], format]))?.payload,
        (rule) => rules.get(canonical([record.key[0], rule]))?.payload,
      ),
    );
    output[id] = {
      ...record,
      payload: { ...composed, data: packSheetCloneData(composed.data) },
    };
  }
  return output;
}

// The formatting value of each format record, from the format's payload and
// its rule records' payloads by ID. One value per format, so rows with the
// same format share one formatting object.
export function sheetCloneFormattings(formatOf, ruleOf) {
  const values = new Map();
  return (id) => {
    if (!values.has(id)) {
      const format = formatOf(id);
      values.set(
        id,
        !format
          ? null
          : Array.isArray(format.rules)
            ? {
                ...format.data,
                rules: format.rules.map((rule) => ruleOf(rule)?.data),
              }
            : format.data,
      );
    }
    return values.get(id);
  };
}
// A protocol 5 copy as the application reads it: the parent without its
// format assignment, and `rows` ([row ID, row payload] in display order) as
// tasks. `formattingOf` gives a format's value (see sheetCloneFormattings).
export function composeSheetClone(parent, rows, formattingOf) {
  const { formats: assigned = {}, ...payload } = parent;
  return {
    ...payload,
    data: {
      ...unpackSheetCloneData(parent.data),
      tasks: rows.map(([rowId, row]) => {
        const formatting =
          Object.hasOwn(assigned, rowId) && formattingOf(assigned[rowId]);
        return {
          ...row.data,
          ...(formatting ? { formatting } : {}),
          cells: row.cells,
        };
      }),
    },
  };
}
// The order of a protocol 5 copy's rows, as the sheet shows them: by position,
// then creation time, then ID. `rows` are [row ID, row payload] pairs.
export function sheetCloneRowOrder(rows) {
  const text = (value) => String(value ?? "");
  return rows.toSorted(([leftId, left], [rightId, right]) => {
    const a = left.data || {},
      b = right.data || {},
      byPosition = (Number(a.position) || 0) - (Number(b.position) || 0);
    if (byPosition) return byPosition;
    const [created, other] = [text(a.createdAt), text(b.createdAt)];
    if (created !== other) return created < other ? -1 : 1;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}
/** Whether a sheet clone payload is the protocol 5 parent of row records. */
export const isSheetCloneRowParent = (payload) => plainObject(payload?.formats);

// What an external site stores in its site rows. Under protocol 5 it keeps a
// copy as the same parent, format and row records as C, so a change to one
// row writes one row; earlier protocols keep the copy as one record.
export function siteEntities(entities) {
  if (protocolVersion({ entities }) !== ROW_PROTOCOL)
    return applicationEntities(entities);
  if (!Object.hasOwn(entities, MARKER)) return entities;
  const { [MARKER]: marker, ...rest } = entities;
  return rest;
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

// Site rows of copies kept as row records (see siteEntities), as the single
// record per copy the internal SQLite site keeps. Rows carry no version, so a
// live copy takes its live rows and a deleted copy every row it has.
export function composedSiteEntities(entities) {
  const output = {},
    children = new Map();
  for (const [id, record] of Object.entries(entities))
    if (
      ["sheetCloneTask", "sheetCloneFormat", "sheetCloneRule"].includes(
        record.entity,
      )
    ) {
      if (!children.has(record.key[0])) children.set(record.key[0], []);
      children.get(record.key[0]).push(record);
    } else output[id] = record;
  for (const [id, record] of Object.entries(output)) {
    if (
      record.entity !== "sheetClone" ||
      !isSheetCloneRowParent(record.payload)
    )
      continue;
    const rows = new Map(),
      formats = new Map(),
      rules = new Map();
    for (const child of children.get(record.key[0]) || [])
      if (child.entity === "sheetCloneFormat")
        formats.set(child.key[1], child.payload);
      else if (child.entity === "sheetCloneRule")
        rules.set(child.key[1], child.payload);
      else if (record.deleted || !child.deleted)
        rows.set(child.key[1], child.payload);
    const composed = composeSheetClone(
      record.payload,
      sheetCloneRowOrder([...rows]),
      sheetCloneFormattings(
        (format) => formats.get(format),
        (rule) => rules.get(rule),
      ),
    );
    output[id] = {
      ...record,
      payload: { ...composed, data: packSheetCloneData(composed.data) },
    };
  }
  return output;
}
