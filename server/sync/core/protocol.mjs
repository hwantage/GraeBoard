import { createHash } from "node:crypto";
import {
  preparedSyncOperation,
  syncCanonicalCache,
  syncRunPayloads,
  rememberSyncCanonical,
} from "./sync-operation-cache.mjs";
import { SYNC_OPERATION_MAX_BYTES } from "../../../shared/sync/sync-limits.js";
import { documentImageUrls } from "../../../shared/documents/document-image-references.js";
import {
  DOCUMENT_IMAGE_PATTERN,
  isDocumentImage,
} from "../../../shared/documents/document-images.js";
import {
  normalizeEntityPayload,
  unpackSheetCloneData,
} from "../../../shared/sheet-clones/sheet-clone-sync-data.js";
// Protocol 3 keeps a sheet clone as one record, as protocol 1 did; protocol 4
// splits it into rows and cells, as protocol 2 did. Protocols 1 and 2 named the
// same records `report`. A team's shared history reaches 3 or 4 only through
// the one-time SheetClone cutover (tools/sheet-clone-cutover, SYNC_PROTOCOL.md),
// which leaves a standard checkpoint for new readers; this runtime reads
// neither 1 nor 2.
//
// Protocol 5 keeps a sheet clone as a parent (metadata and row order), one
// record per distinct formatting value and one record per row holding its
// cells. A cell edit then carries one row, not the whole clone (protocol 3),
// without one record per cell and the formatting repeated in every row
// (protocol 4). Number 4 stays readable and is never reused.
export const PROTOCOL = 3;
export const SPLIT_PROTOCOL = 4;
export const ROW_PROTOCOL = 5;

export const ENTITIES_WHOLE = new Set([
  "team",
  "person",
  "task",
  "cell",
  "document",
  "sheetClone",
  "calendar",
  "tag",
  "rule",
  "weekly",
  "filter",
  "formats",
  "protocol",
]);
const ENTITIES_SPLIT = new Set([
  ...ENTITIES_WHOLE,
  "sheetCloneTask",
  "sheetCloneCell",
]);
const ENTITIES_ROWS = new Set([
  ...ENTITIES_WHOLE,
  "sheetCloneFormat",
  "sheetCloneTask",
]);
// Every shared entity of any supported protocol, for storage scans.
export const ENTITIES = new Set([...ENTITIES_SPLIT, ...ENTITIES_ROWS]);
/** The entities one protocol version shares. */
export const entitiesFor = (version) =>
  version === ROW_PROTOCOL
    ? ENTITIES_ROWS
    : version === SPLIT_PROTOCOL
      ? ENTITIES_SPLIT
      : ENTITIES_WHOLE;
const VERSIONS = [PROTOCOL, SPLIT_PROTOCOL, ROW_PROTOCOL];
// The version C's protocol marker names. Before anything is shared C is
// empty and its first publication starts at protocol 3; records without a
// supported marker (0) belong to a protocol this runtime does not read.
export const protocolVersion = (state) => {
  const entities = state?.entities,
    version = entities?.[JSON.stringify(["protocol", []])]?.payload?.version;
  if (VERSIONS.includes(version)) return version;
  return entities && !Object.keys(entities).length ? PROTOCOL : 0;
};
export const supportedVersion = (protocol, reducer = protocol) =>
  VERSIONS.includes(protocol) && reducer === protocol;
export const protocolMarker = (version, token) => ({
  entity: "protocol",
  key: [],
  generation: token,
  version: token,
  payload: { version, reducer: version },
  deleted: false,
});
export const entityId = (entity, key) => JSON.stringify([entity, key]);
// A record or payload whose `data` already has its canonical text in this run
// (a sheet copy of megabytes, serialized when its command was validated) is
// assembled around that text instead of being walked and serialized again.
const holdsKnownText = (value, cache) =>
  !!cache &&
  !Array.isArray(value) &&
  !!value.data &&
  typeof value.data === "object" &&
  cache.texts.has(value.data);
export function canonical(value) {
  const cache = syncCanonicalCache();
  if (value && typeof value === "object") {
    const cached = cache?.texts.get(value);
    if (cached !== undefined) return cached;
    if (holdsKnownText(value, cache)) return canonicalValue(value, cache);
    // Parsed canonical JSON keeps its keys in canonical order, so the native
    // serializer writes the same text without the intermediate strings that
    // joining piece by piece allocates (hundreds of megabytes for a sheet
    // copy of a few megabytes).
    if (inCanonicalOrder(value))
      return rememberSyncCanonical(cache, value, JSON.stringify(value));
  }
  return canonicalValue(value, cache);
}
// Whether JSON.stringify(value) is exactly canonical(value): every object is
// plain with its keys already sorted, and every value is one canonical JSON
// can hold. Anything else is left to canonicalValue, which sorts or throws.
function inCanonicalOrder(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      if (!(i in value) || !inCanonicalOrder(value[i])) return false;
    return true;
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  let previous;
  for (const key of Object.keys(value)) {
    if (previous !== undefined && previous > key) return false;
    previous = key;
    if (!inCanonicalOrder(value[key])) return false;
  }
  return true;
}
// A record built here (entity, key, payload) has its own keys unsorted but
// holds parsed JSON a level or two down, so the native path is tried again for
// the first few levels below an unsorted object. The limit bounds how often a
// subtree that fails the check is walked again.
const NATIVE_DEPTH = 4;
function canonicalValue(value, cache, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  )
    return JSON.stringify(value);
  const cached = cache?.texts.get(value);
  if (cached !== undefined) return cached;
  if (
    depth &&
    depth <= NATIVE_DEPTH &&
    value &&
    typeof value === "object" &&
    !holdsKnownText(value, cache) &&
    inCanonicalOrder(value)
  )
    return rememberSyncCanonical(cache, value, JSON.stringify(value));
  if (Array.isArray(value))
    return rememberSyncCanonical(
      cache,
      value,
      "[" +
        value.map((item) => canonicalValue(item, cache, depth + 1)).join(",") +
        "]",
    );
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return rememberSyncCanonical(
      cache,
      value,
      "{" +
        Object.keys(value)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ":" +
              canonicalValue(value[k], cache, depth + 1),
          )
          .join(",") +
        "}",
    );
  throw new Error("Unsupported canonical JSON value");
}
// Throws where canonical() would, without building the string: validation
// walks a copy of megabytes once instead of serializing it.
export function assertCanonical(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  )
    return;
  if (Array.isArray(value)) value.forEach(assertCanonical);
  else if (value && Object.getPrototypeOf(value) === Object.prototype)
    for (const key of Object.keys(value)) assertCanonical(value[key]);
  else throw new Error("Unsupported canonical JSON value");
}
// text(value), when given, may return the canonical text of an object to write
// whole instead of visiting it.
function visitCanonical(value, write, text) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  ) {
    write(JSON.stringify(value));
    return;
  }
  if (text && value && typeof value === "object") {
    const cached = text(value);
    if (cached !== undefined) {
      write(cached);
      return;
    }
  }
  if (Array.isArray(value)) {
    write("[");
    for (let i = 0; i < value.length; i++) {
      if (i) write(",");
      if (i in value) visitCanonical(value[i], write, text);
    }
    write("]");
    return;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    write("{");
    let first = true;
    for (const key of Object.keys(value).sort()) {
      if (!first) write(",");
      first = false;
      write(JSON.stringify(key));
      write(":");
      visitCanonical(value[key], write, text);
    }
    write("}");
    return;
  }
  throw new Error("Unsupported canonical JSON value");
}
// canonical() that writes text(value)'s string for any object it knows.
export function canonicalWith(value, text) {
  const parts = [];
  visitCanonical(value, (token) => parts.push(token), text);
  return parts.join("");
}
export function digest(value) {
  return digestWith(value);
}
function digestWith(value, text) {
  const hash = createHash("sha256");
  if (typeof value === "string" || value instanceof Uint8Array)
    return hash.update(value).digest("hex");
  // Match canonical() byte for byte without retaining the whole JSON string.
  // Never split a Unicode scalar between hash.update calls. Large string values
  // are written whole; intermediate buffers are bounded by 16 KiB of text.
  let chunks = [],
    length = 0;
  const flush = () => {
    if (length) hash.update(chunks.join(""));
    chunks = [];
    length = 0;
  };
  visitCanonical(
    value,
    (token) => {
      if (token.length >= 16384) {
        flush();
        hash.update(token);
      } else {
        if (length + token.length > 16384) flush();
        chunks.push(token);
        length += token.length;
      }
    },
    text,
  );
  flush();
  return hash.digest("hex");
}
// digest() of a value that reaches some objects more than once (an unpacked
// copy gives all its tasks one formatting object): each such object is
// serialized once and its text reused, so the work follows the distinct
// structure, not every repetition. The hash is the same.
export function digestShared(value) {
  const seen = new WeakSet(),
    repeated = new WeakSet(),
    pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) {
      repeated.add(item);
      continue;
    }
    seen.add(item);
    for (const key of Object.keys(item)) pending.push(item[key]);
  }
  const texts = new WeakMap();
  return digestWith(value, (item) => {
    if (!repeated.has(item)) return undefined;
    if (!texts.has(item)) texts.set(item, canonical(item));
    return texts.get(item);
  });
}
// Whether canonical(a) === canonical(b), without building either string. It
// stops at the first difference, and a pair of objects reached again (an
// unpacked copy shares one formatting object among all its tasks) is compared
// once. Values canonical() rejects still throw.
export function equal(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return sameCanonical(a, b, new Map());
}
const plainObject = (value) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function sameCanonical(a, b, seen) {
  const objectA = !!a && typeof a === "object",
    objectB = !!b && typeof b === "object";
  if (!objectA || !objectB) {
    if (objectA || objectB) {
      assertCanonical(a);
      assertCanonical(b);
      return false;
    }
    // Two strings have the same canonical text exactly when they are the
    // same string; null and booleans likewise. Everything else (numbers,
    // mixed types, values canonical() rejects) keeps the serialized compare.
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (
      a === b &&
      (a === null ||
        typeof a === "boolean" ||
        (typeof a === "number" &&
          Number.isFinite(a) &&
          Math.abs(a) <= Number.MAX_SAFE_INTEGER))
    )
      return true;
    return canonical(a) === canonical(b);
  }
  if (a === b) return true;
  if (seen.get(a)?.has(b)) return true;
  let same;
  if (Array.isArray(a) && Array.isArray(b)) {
    same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++)
      same = sameCanonical(a[i], b[i], seen);
  } else if (plainObject(a) && plainObject(b)) {
    const keys = Object.keys(a);
    same = keys.length === Object.keys(b).length;
    for (let i = 0; same && i < keys.length; i++)
      same =
        Object.hasOwn(b, keys[i]) &&
        sameCanonical(a[keys[i]], b[keys[i]], seen);
  } else if (
    (Array.isArray(a) || plainObject(a)) &&
    (Array.isArray(b) || plainObject(b))
  ) {
    assertCanonical(a);
    assertCanonical(b);
    same = false;
  } else return canonical(a) === canonical(b);
  if (same) {
    if (!seen.has(a)) seen.set(a, new Set());
    seen.get(a).add(b);
  }
  return same;
}
// A sheet copy's shared-dictionary data, unpacked once per data object.
// Validation and the reducer both read the unpacked form of the same payload,
// and successive commands on one copy share payload objects, so each object is
// unpacked once instead of at every use. The result is only read, never
// changed. Keyed by the object, so an entry ends with its event.
const unpackedSheetClones = new WeakMap();
const unpackedSheetCloneData = (data) => {
  if (!data || typeof data !== "object") return data;
  let unpacked = unpackedSheetClones.get(data);
  if (unpacked === undefined) {
    unpacked = unpackSheetCloneData(data);
    unpackedSheetClones.set(data, unpacked);
  }
  return unpacked;
};
// normalizeEntityPayload() with the unpacked data shared as above.
export const normalizedPayload = (entity, payload) => {
  if (entity !== "sheetClone" || !payload) return payload;
  const data = unpackedSheetCloneData(payload.data);
  return data === payload.data ? payload : { ...payload, data };
};
// 사본 data는 평문과 공유 사전 형태가 섞여 있을 수 있으므로 내용으로 비교한다.
export const payloadEqual = (entity, a, b) =>
  a === b || equal(normalizedPayload(entity, a), normalizedPayload(entity, b));
export const emptyState = () => ({ entities: {}, receipts: {}, conflicts: {} });
export const stateHash = (state) => digest(state);

// The state sum: each record of C hashed on its own and the digests added in
// four 64-bit lanes (each mod 2^64). Unlike stateHash it is order-free, so a
// commit updates it from the records it changed instead of rehashing C, and
// PostgreSQL computes it with a plain aggregate. It detects accidental
// divergence between sites; it is not meant to resist crafted collisions.
// A record digest is sha256(section "\n" id "\n" canonical(value)), where the
// section is "e" (entity, id = entityId), "r" (receipt, id = opId) or "c"
// (conflict, id = conflictId); canonical JSON never contains a raw newline.
const LANE = 1n << 64n;
const SUM_SECTIONS = [
  ["entities", "e"],
  ["receipts", "r"],
  ["conflicts", "c"],
];
export const SUM_ZERO = "0".repeat(64);
const lanes = (hex) =>
  [0, 16, 32, 48].map((i) => BigInt("0x" + hex.slice(i, i + 16)));
const laneHex = (values) =>
  values
    .map((v) => (((v % LANE) + LANE) % LANE).toString(16).padStart(16, "0"))
    .join("");
export const recordDigest = (section, id, value) =>
  createHash("sha256")
    .update(section + "\n" + id + "\n" + canonical(value))
    .digest("hex");
// The sum of C from its records; O(records), for a site holding C in memory.
export function stateSum(state) {
  const total = [0n, 0n, 0n, 0n];
  for (const [section, tag] of SUM_SECTIONS)
    for (const [id, value] of Object.entries(state[section] || {}))
      lanes(recordDigest(tag, id, value)).forEach((v, i) => (total[i] += v));
  return laneHex(total);
}
// The sum of state from the sum of base: only records whose object changed
// (by reference, as reducers share untouched records) are hashed. base and
// state may be whole states or matching slices of them.
export function stateSumFrom(sum, base, state) {
  const total = lanes(sum);
  for (const [section, tag] of SUM_SECTIONS) {
    const before = base[section] || {},
      after = state[section] || {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[id] === after[id]) continue;
      if (before[id] !== undefined)
        lanes(recordDigest(tag, id, before[id])).forEach(
          (v, i) => (total[i] -= v),
        );
      if (after[id] !== undefined)
        lanes(recordDigest(tag, id, after[id])).forEach(
          (v, i) => (total[i] += v),
        );
    }
  }
  return laneHex(total);
}
// Lane totals PostgreSQL returns as signed 64-bit sums, folded mod 2^64.
export const sumFromLanes = (values) => laneHex(values.map((v) => BigInt(v)));
export const initialToken = (bootstrapId, entity, key) =>
  digest([bootstrapId, entity, key]);
const payloadFields = {
  team: ["name", "settings"],
  person: ["name"],
  task: [
    "years",
    "position",
    "defaultStyle",
    "rowStyle",
    "createdBy",
    "createdAt",
    "deletedAt",
  ],
  cell: ["value", "style"],
  document: ["title", "position", "markdown"],
  sheetClone: [
    "year",
    "name",
    "referenceDate",
    "createdBy",
    "createdAt",
    "data",
  ],
  calendar: ["userId", "date", "endDate", "lane", "title", "deletedAt", "tags"],
  tag: ["userId", "name", "color", "kind"],
  rule: ["propertyId", "values", "mode"],
  // importedAt orders a week's items (2026-11-04). Items shared before it
  // have none and keep their place by the time each site first saw them.
  weekly: ["title", "importedAt"],
  filter: ["name", "data"],
  formats: ["rules"],
  protocol: ["version", "reducer"],
  sheetCloneTask: ["data", "index"],
  sheetCloneCell: ["data"],
};
// Protocol 5 shapes of the sheet clone records.
const rowPayloadFields = {
  sheetClone: [...payloadFields.sheetClone, "formats"],
  sheetCloneFormat: ["data"],
  sheetCloneTask: ["data", "cells"],
};
const fieldsFor = (entity, version) =>
  (version === ROW_PROTOCOL && rowPayloadFields[entity]) ||
  payloadFields[entity];
/** The key of a sheet clone's formatting record: a hash of its value. */
export const sheetCloneFormatId = (formatting) =>
  digest(formatting).slice(0, 32);
const keyLengths = {
  team: 0,
  person: 1,
  task: 1,
  cell: 2,
  sheetClone: 1,
  calendar: 1,
  tag: 1,
  rule: 0,
  weekly: 3,
  filter: 1,
  formats: 0,
  protocol: 0,
  sheetCloneFormat: 2,
  sheetCloneTask: 2,
  sheetCloneCell: 3,
};
const plain = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
// serializable: the caller already made the payload's canonical text, which
// fails for exactly the values assertCanonical rejects.
export function validateEntityPayload(
  entity,
  key,
  payload,
  teamId,
  version = PROTOCOL,
  { serializable = false } = {},
) {
  if (
    !entitiesFor(version).has(entity) ||
    !Array.isArray(key) ||
    key.some(
      (part) =>
        typeof part !== "string" ||
        !part ||
        part.length > 200 ||
        ["__proto__", "constructor", "prototype"].includes(part),
    )
  )
    throw new Error("Invalid entity key");
  if (entity === "document") {
    if (
      !["task", "annual", "sheetClone", "sheetCloneMemo", "calendar"].includes(
        key[0],
      ) ||
      key.length !== (key[0] === "sheetClone" ? 4 : 3)
    )
      throw new Error("Invalid document owner");
  } else if (key.length !== keyLengths[entity])
    throw new Error("Invalid entity key length");
  if (
    !plain(payload) ||
    Object.keys(payload).some(
      (field) => !fieldsFor(entity, version).includes(field),
    )
  )
    throw new Error(
      entity === "person"
        ? "Account credentials and privileges are local"
        : "Unsupported entity payload",
    );
  if (!serializable) assertCanonical(payload);
  const string = (field, max = 200000) => {
    if (typeof payload[field] !== "string" || payload[field].length > max)
      throw new Error("Invalid " + entity + " " + field);
  };
  if (["team", "person", "sheetClone", "tag", "filter"].includes(entity))
    string("name", 200);
  if (["document", "weekly", "calendar"].includes(entity))
    string("title", 1000);
  if (
    entity === "weekly" &&
    payload.importedAt !== undefined &&
    !(
      typeof payload.importedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.importedAt)
    )
  )
    throw new Error("Invalid weekly importedAt");
  if (
    entity === "team" &&
    (!plain(payload.settings) ||
      Object.keys(payload.settings).some((field) =>
        /secret|token|password|sync|connection/i.test(field),
      ))
  )
    throw new Error("Private team setting in shared payload");
  if (entity === "task") {
    if (
      !Array.isArray(payload.years) ||
      !payload.years.length ||
      payload.years.some(
        (year) => !Number.isSafeInteger(year) || year < 1900 || year > 2200,
      ) ||
      !Number.isFinite(payload.position) ||
      !plain(payload.defaultStyle) ||
      !plain(payload.rowStyle)
    )
      throw new Error("Invalid task payload");
    string("createdBy", 200);
    string("createdAt", 100);
  }
  if (
    entity === "cell" &&
    (!Object.hasOwn(payload, "value") || !plain(payload.style))
  )
    throw new Error("Invalid cell payload");
  if (entity === "document") {
    string("markdown", 256 * 1024);
    if (
      Buffer.byteLength(payload.markdown) > 256 * 1024 ||
      !Number.isFinite(payload.position)
    )
      throw new Error("Invalid document payload");
  }
  if (
    entity === "calendar" &&
    (!Array.isArray(payload.tags) ||
      payload.tags.some(
        (tag) =>
          !plain(tag) ||
          typeof tag.id !== "string" ||
          typeof tag.checked !== "boolean" ||
          Object.keys(tag).some((field) => !["id", "checked"].includes(field)),
      ) ||
      !Number.isInteger(payload.lane))
  )
    throw new Error("Invalid calendar payload");
  // A personal entry or tag names its owner; a team one carries null. The
  // receiver creates a placeholder user for an unknown owner, so the reference
  // must at least be a usable ID.
  if (
    ["calendar", "tag"].includes(entity) &&
    payload.userId !== null &&
    (typeof payload.userId !== "string" ||
      !payload.userId ||
      payload.userId.length > 200)
  )
    throw new Error("Invalid " + entity + " userId");
  if (entity === "formats" && !Array.isArray(payload.rules))
    throw new Error("Invalid formats payload");
  if (
    entity === "protocol" &&
    (payload.version !== version || payload.reducer !== version)
  )
    throw new Error("Invalid protocol marker");
  if (entity === "sheetCloneFormat") {
    if (!plain(payload.data) || sheetCloneFormatId(payload.data) !== key[1])
      throw new Error("Invalid sheetClone format");
  } else if (entity === "sheetCloneTask" && version === ROW_PROTOCOL) {
    const { data, cells } = payload;
    if (
      !plain(data) ||
      data.id !== key[1] ||
      data.teamId !== teamId ||
      Object.hasOwn(data, "cells") ||
      plain(data.formatting) ||
      !plain(cells) ||
      Object.entries(cells).some(
        ([cellKey, cell]) =>
          !cellKey ||
          cellKey.length > 200 ||
          ["__proto__", "constructor", "prototype"].includes(cellKey) ||
          !plain(cell) ||
          !Object.hasOwn(cell, "value") ||
          !plain(cell.style),
      )
    )
      throw new Error("Invalid sheetClone task");
  } else if (
    entity === "sheetCloneTask" &&
    (!plain(payload.data) ||
      payload.data.id !== key[1] ||
      payload.data.teamId !== teamId ||
      Object.hasOwn(payload.data, "cells") ||
      !Number.isSafeInteger(payload.index) ||
      payload.index < 0)
  )
    throw new Error("Invalid sheetClone task");
  if (
    entity === "sheetCloneCell" &&
    (!plain(payload.data) ||
      !Object.hasOwn(payload.data, "value") ||
      !plain(payload.data.style))
  )
    throw new Error("Invalid sheetClone cell");
  if (entity === "sheetClone") {
    // data는 저장과 같은 공유 사전 형태 또는 기존 평문이다. 내용 검사는 푼 뒤 수행한다.
    let data = payload.data;
    if (plain(data))
      try {
        data = unpackedSheetCloneData(data);
      } catch {
        throw new Error("Invalid sheetClone payload");
      }
    if (
      !Number.isInteger(payload.year) ||
      !plain(data) ||
      (version === PROTOCOL
        ? !Array.isArray(data.tasks)
        : Object.hasOwn(data, "tasks")) ||
      !Array.isArray(data.users) ||
      !plain(data.settings) ||
      !plain(data.view)
    )
      throw new Error("Invalid sheetClone payload");
    if (
      Object.keys(data).some(
        (field) => !["tasks", "users", "view", "settings"].includes(field),
      ) ||
      data.users.some(
        (person) =>
          !plain(person) ||
          Object.keys(person).some((field) => !["id", "name"].includes(field)),
      )
    )
      throw new Error("Private account data in sheetClone");
    if (data.tasks?.some((task) => task.teamId !== teamId))
      throw new Error("Foreign team sheetClone row");
    // Protocol 5: the rows are their own records and the parent names each
    // formatted row's formatting record. Keeping that here lets a format
    // change over every row carry no row.
    if (
      version === ROW_PROTOCOL &&
      (!plain(payload.formats) ||
        Object.entries(payload.formats).some(
          ([id, format]) =>
            !id ||
            id.length > 200 ||
            ["__proto__", "constructor", "prototype"].includes(id) ||
            typeof format !== "string" ||
            !/^[a-f0-9]{32}$/.test(format),
        ))
    )
      throw new Error("Invalid sheetClone formats");
  }
  if (entity === "document")
    for (const url of documentImageUrls(payload.markdown))
      if (
        !isDocumentImage(url) ||
        DOCUMENT_IMAGE_PATTERN.exec(url)?.[1] !== teamId
      )
        throw new Error("Foreign or invalid image reference");
}
// serialized: canonical(op) when the caller already has it.
export function validateOperation(
  op,
  identity,
  state,
  { onSerialized, serialized: known } = {},
) {
  if (
    !op ||
    !supportedVersion(op.protocol, op.reducer) ||
    (state && op.protocol !== protocolVersion(state)) ||
    (identity.protocol !== undefined && identity.protocol !== op.protocol) ||
    op.repoId !== identity.repoId ||
    op.teamId !== identity.teamId
  )
    throw new Error("Unsupported protocol or foreign team operation");
  const prepared = preparedSyncOperation(op);
  if (prepared?.validated) {
    validateResolutionState(op, state);
    const serialized = known ?? canonical(op);
    validateOperationSize(serialized);
    onSerialized?.(serialized);
    return op;
  }
  for (const name of ["opId", "writerEpoch", "actorRef", "createdAt"])
    if (typeof op[name] !== "string" || !op[name] || op[name].length > 200)
      throw new Error("Invalid operation identity");
  if (
    !Array.isArray(op.dependsOn) ||
    op.dependsOn.length > 200000 ||
    op.dependsOn.some(
      (id) =>
        typeof id !== "string" || !id || id.length > 200 || id === op.opId,
    ) ||
    !Array.isArray(op.changes) ||
    op.changes.length > 200000 ||
    !Array.isArray(op.objects)
  )
    throw new Error("Invalid operation structure");
  if (op.resolves !== undefined) {
    if (
      !Array.isArray(op.resolves) ||
      op.resolves.length > 200000 ||
      new Set(op.resolves).size !== op.resolves.length ||
      op.resolves.some(
        (id) =>
          typeof id !== "string" || !id || id.length > 200 || id === op.opId,
      )
    )
      throw new Error("Invalid conflict resolution references");
    validateResolutionState(op, state);
  }
  const seen = new Set(),
    // Canonical text of this command's payload objects, where already made.
    texts = new Map();
  for (const c of op.changes) {
    if (
      !entitiesFor(op.protocol).has(c.entity) ||
      c.entity === "protocol" ||
      !Array.isArray(c.key) ||
      c.key.some((v) => typeof v !== "string" || v.length > 200) ||
      !["create", "edit", "delete", "restore"].includes(c.action) ||
      typeof c.generation !== "string" ||
      (c.baseVersion !== null &&
        (typeof c.baseVersion !== "string" ||
          !c.baseVersion ||
          c.baseVersion.length > 512)) ||
      !Array.isArray(c.fields) ||
      c.fields.some(
        (x) =>
          typeof x !== "string" ||
          ["__proto__", "constructor", "prototype"].includes(x),
      )
    )
      throw new Error("Invalid entity change");
    const key = entityId(c.entity, c.key);
    if (seen.has(key)) throw new Error("Duplicate entity change");
    seen.add(key);
    // Successive commands of one run that edit the same record carry its
    // payload twice: one command's desired value is the next one's base (a
    // sheet copy of megabytes, in protocol 3). When the two have the same
    // canonical text, this command's base becomes the earlier desired object,
    // so validation, unpacking and comparison do their work once. The
    // command's canonical text is unchanged, and it is assembled below from
    // the payload texts already made here.
    const run = known === undefined ? syncRunPayloads() : null;
    if (run && !Object.isFrozen(c)) {
      try {
        const previous = run.latest.get(key);
        if (c.base && typeof c.base === "object") {
          // The engine's own serialization first: when it equals the earlier
          // canonical text, the base is that content and needs no walk.
          if (previous && JSON.stringify(c.base) === previous.text) {
            c.base = previous.object;
            texts.set(c.base, previous.text);
          } else texts.set(c.base, canonical(c.base));
        }
        if (c.desired && typeof c.desired === "object") {
          // The data's text is kept for the run: the record this payload
          // becomes is serialized again for its digest, size and storage.
          const data = c.desired.data,
            cache = syncCanonicalCache();
          let text;
          if (cache && data && typeof data === "object") {
            const dataText = canonical(data);
            text = canonicalWith(c.desired, (value) =>
              value === data ? dataText : undefined,
            );
            if (previous?.data && previous.data !== data)
              cache.texts.delete(previous.data);
            cache.texts.set(data, dataText);
          } else text = canonical(c.desired);
          texts.set(c.desired, text);
          run.latest.set(key, { object: c.desired, text, data });
        } else run.latest.delete(key);
      } catch {
        // A payload canonical JSON cannot hold is rejected by the validation
        // below, with its own message.
        run.latest.delete(key);
      }
    }
    // validateEntityPayload checks a non-null value serializes canonically.
    // A payload object already validated in this run as the same record is
    // not validated again.
    const signature = run && key + "\n" + op.teamId + "\n" + op.protocol;
    for (const payload of [c.base, c.desired]) {
      if (payload === null) continue;
      const object = run && payload && typeof payload === "object";
      if (object && run.validated.get(payload) === signature) continue;
      validateEntityPayload(c.entity, c.key, payload, op.teamId, op.protocol, {
        serializable: texts.has(payload),
      });
      if (object) run.validated.set(payload, signature);
    }
    if (c.desired === null && c.action !== "delete")
      throw new Error("Missing desired entity");
    if (
      c.fields.some(
        (field) => !fieldsFor(c.entity, op.protocol).includes(field),
      )
    )
      throw new Error("Unsupported entity field");
    if (c.entity === "team" && c.action === "delete")
      throw new Error("Remote team deletion forbidden");
    if (
      c.entity === "person" &&
      c.desired &&
      Object.keys(c.desired).some((k) => k !== "name")
    )
      throw new Error("Account credentials and privileges are local");
    if (
      c.entity === "team" &&
      c.desired &&
      Object.keys(c.desired).some((k) => !["name", "settings"].includes(k))
    )
      throw new Error("Invalid team payload");
    if (
      c.entity === "team" &&
      c.desired?.settings &&
      Object.keys(c.desired.settings).some((k) =>
        /secret|token|password|sync|connection/i.test(k),
      )
    )
      throw new Error("Private team setting in shared payload");
  }
  const serialized =
    known ??
    (texts.size
      ? canonicalWith(op, (value) => texts.get(value))
      : canonical(op));
  validateOperationSize(serialized);
  onSerialized?.(serialized);
  if (prepared) prepared.validated = true;
  return op;
}
function validateOperationSize(serialized) {
  if (Buffer.byteLength(serialized) > SYNC_OPERATION_MAX_BYTES)
    throw Object.assign(
      new Error(
        `동기화할 변경이 전송 한도 ${Math.ceil(SYNC_OPERATION_MAX_BYTES / 1048576)}MiB를 초과했습니다. 관리자에게 동기화 전송 한도 확인을 요청하세요.`,
      ),
      { status: 400, code: "SYNC_OPERATION_CAPACITY" },
    );
}
function validateResolutionState(op, state) {
  if (state)
    for (const id of op.resolves || []) {
      const conflict =
        Object.hasOwn(state.conflicts, id) && state.conflicts[id];
      if (
        !conflict ||
        conflict.operation?.teamId !== op.teamId ||
        conflict.operation?.repoId !== op.repoId
      )
        throw new Error(
          "Conflict resolution references a missing or foreign conflict",
        );
    }
}
