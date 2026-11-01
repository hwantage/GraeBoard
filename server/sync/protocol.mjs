import { createHash } from "node:crypto";
import { SYNC_OPERATION_MAX_BYTES } from "../../shared/sync-limits.js";
import { documentImageUrls } from "../../shared/document-image-references.js";
import {
  DOCUMENT_IMAGE_PATTERN,
  isDocumentImage,
} from "../../shared/document-images.js";
import {
  normalizeEntityPayload,
  unpackReportData,
} from "../../shared/report-sync-data.js";
export const PROTOCOL = 1;
export const ENTITIES_V1 = new Set([
  "team",
  "person",
  "task",
  "cell",
  "document",
  "report",
  "calendar",
  "tag",
  "rule",
  "weekly",
  "filter",
  "formats",
]);
export const ENTITIES = new Set([
  ...ENTITIES_V1,
  "protocol",
  "reportTask",
  "reportCell",
]);
export const protocolVersion = (state) =>
  state?.entities?.[JSON.stringify(["protocol", []])]?.payload?.version === 2
    ? 2
    : 1;
export const supportedVersion = (protocol, reducer = protocol) =>
  [1, 2].includes(protocol) && reducer === protocol;
export const entityId = (entity, key) => JSON.stringify([entity, key]);
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
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
// 사본 data는 평문과 공유 사전 형태가 섞여 있을 수 있으므로 내용으로 비교한다.
export const payloadEqual = (entity, a, b) =>
  equal(normalizeEntityPayload(entity, a), normalizeEntityPayload(entity, b));
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
  report: ["year", "name", "referenceDate", "createdBy", "createdAt", "data"],
  calendar: ["userId", "date", "endDate", "lane", "title", "deletedAt", "tags"],
  tag: ["userId", "name", "color", "kind"],
  rule: ["propertyId", "values", "mode"],
  weekly: ["title"],
  filter: ["name", "data"],
  formats: ["rules"],
  protocol: ["version", "reducer"],
  reportTask: ["data", "index"],
  reportCell: ["data"],
};
const keyLengths = {
  team: 0,
  person: 1,
  task: 1,
  cell: 2,
  report: 1,
  calendar: 1,
  tag: 1,
  rule: 0,
  weekly: 3,
  filter: 1,
  formats: 0,
  protocol: 0,
  reportTask: 2,
  reportCell: 3,
};
const plain = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
export function validateEntityPayload(
  entity,
  key,
  payload,
  teamId,
  version = 1,
) {
  if (
    !(version === 2 ? ENTITIES : ENTITIES_V1).has(entity) ||
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
      !["task", "annual", "report", "reportMemo", "calendar"].includes(
        key[0],
      ) ||
      key.length !== (key[0] === "report" ? 4 : 3)
    )
      throw new Error("Invalid document owner");
  } else if (key.length !== keyLengths[entity])
    throw new Error("Invalid entity key length");
  if (
    !plain(payload) ||
    Object.keys(payload).some((field) => !payloadFields[entity].includes(field))
  )
    throw new Error(
      entity === "person"
        ? "Account credentials and privileges are local"
        : "Unsupported entity payload",
    );
  assertCanonical(payload);
  const string = (field, max = 200000) => {
    if (typeof payload[field] !== "string" || payload[field].length > max)
      throw new Error("Invalid " + entity + " " + field);
  };
  if (["team", "person", "report", "tag", "filter"].includes(entity))
    string("name", 200);
  if (["document", "weekly", "calendar"].includes(entity))
    string("title", 1000);
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
  if (entity === "formats" && !Array.isArray(payload.rules))
    throw new Error("Invalid formats payload");
  if (entity === "protocol" && (payload.version !== 2 || payload.reducer !== 2))
    throw new Error("Invalid protocol marker");
  if (
    entity === "reportTask" &&
    (!plain(payload.data) ||
      payload.data.id !== key[1] ||
      payload.data.teamId !== teamId ||
      Object.hasOwn(payload.data, "cells") ||
      !Number.isSafeInteger(payload.index) ||
      payload.index < 0)
  )
    throw new Error("Invalid report task");
  if (
    entity === "reportCell" &&
    (!plain(payload.data) ||
      !Object.hasOwn(payload.data, "value") ||
      !plain(payload.data.style))
  )
    throw new Error("Invalid report cell");
  if (entity === "report") {
    // data는 저장과 같은 공유 사전 형태 또는 기존 평문이다. 내용 검사는 푼 뒤 수행한다.
    let data = payload.data;
    if (plain(data))
      try {
        data = unpackReportData(data);
      } catch {
        throw new Error("Invalid report payload");
      }
    if (
      !Number.isInteger(payload.year) ||
      !plain(data) ||
      (version === 1
        ? !Array.isArray(data.tasks)
        : Object.hasOwn(data, "tasks")) ||
      !Array.isArray(data.users) ||
      !plain(data.settings) ||
      !plain(data.view)
    )
      throw new Error("Invalid report payload");
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
      throw new Error("Private account data in report");
    if (data.tasks?.some((task) => task.teamId !== teamId))
      throw new Error("Foreign team report row");
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
    if (state)
      for (const id of op.resolves) {
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
  const seen = new Set();
  for (const c of op.changes) {
    if (
      !(op.protocol === 2 ? ENTITIES : ENTITIES_V1).has(c.entity) ||
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
    // validateEntityPayload checks a non-null value serializes canonically.
    if (c.base !== null)
      validateEntityPayload(c.entity, c.key, c.base, op.teamId, op.protocol);
    if (c.desired !== null)
      validateEntityPayload(c.entity, c.key, c.desired, op.teamId, op.protocol);
    if (c.desired === null && c.action !== "delete")
      throw new Error("Missing desired entity");
    if (c.fields.some((field) => !payloadFields[c.entity].includes(field)))
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
  const serialized = known ?? canonical(op);
  if (Buffer.byteLength(serialized) > SYNC_OPERATION_MAX_BYTES)
    throw Object.assign(
      new Error(
        `동기화할 변경이 전송 한도 ${Math.ceil(SYNC_OPERATION_MAX_BYTES / 1048576)}MiB를 초과했습니다. 관리자에게 동기화 전송 한도 확인을 요청하세요.`,
      ),
      { status: 400, code: "SYNC_OPERATION_CAPACITY" },
    );
  onSerialized?.(serialized);
  return op;
}
