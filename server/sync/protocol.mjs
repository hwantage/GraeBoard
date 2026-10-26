import { createHash } from "node:crypto";
export const PROTOCOL = 1;
export const ENTITIES = new Set([
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
function visitCanonical(value, write) {
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
  if (Array.isArray(value)) {
    write("[");
    for (let i = 0; i < value.length; i++) {
      if (i) write(",");
      if (i in value) visitCanonical(value[i], write);
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
      visitCanonical(value[key], write);
    }
    write("}");
    return;
  }
  throw new Error("Unsupported canonical JSON value");
}
export function digest(value) {
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
  visitCanonical(value, (token) => {
    if (token.length >= 16384) {
      flush();
      hash.update(token);
    } else {
      if (length + token.length > 16384) flush();
      chunks.push(token);
      length += token.length;
    }
  });
  flush();
  return hash.digest("hex");
}
export const equal = (a, b) =>
  a === b ||
  (a !== undefined && b !== undefined && canonical(a) === canonical(b));
export const emptyState = () => ({ entities: {}, receipts: {}, conflicts: {} });
export const stateHash = (state) => digest(state);
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
};
const plain = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
export function validateEntityPayload(entity, key, payload, teamId) {
  if (
    !ENTITIES.has(entity) ||
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
  canonical(payload);
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
  if (entity === "report") {
    if (
      !Number.isInteger(payload.year) ||
      !plain(payload.data) ||
      !Array.isArray(payload.data.tasks) ||
      !Array.isArray(payload.data.users) ||
      !plain(payload.data.settings) ||
      !plain(payload.data.view)
    )
      throw new Error("Invalid report payload");
    if (
      Object.keys(payload.data).some(
        (field) => !["tasks", "users", "view", "settings"].includes(field),
      ) ||
      payload.data.users.some(
        (person) =>
          !plain(person) ||
          Object.keys(person).some((field) => !["id", "name"].includes(field)),
      )
    )
      throw new Error("Private account data in report");
    if (payload.data.tasks.some((task) => task.teamId !== teamId))
      throw new Error("Foreign team report row");
  }
  for (const url of JSON.stringify(payload).matchAll(
    /\/api\/document-images\/([^/"\\]+)\/([^"\\\s#)]+)/g,
  ))
    if (url[1] !== teamId || !/^[a-f0-9]{64}\.webp$/.test(url[2]))
      throw new Error("Foreign or invalid image reference");
}
export function validateOperation(op, identity) {
  if (
    !op ||
    op.protocol !== 1 ||
    op.reducer !== 1 ||
    op.repoId !== identity.repoId ||
    op.teamId !== identity.teamId
  )
    throw new Error("Unsupported protocol or foreign team operation");
  for (const name of ["opId", "writerEpoch", "actorRef", "createdAt"])
    if (typeof op[name] !== "string" || !op[name] || op[name].length > 200)
      throw new Error("Invalid operation identity");
  if (
    !Array.isArray(op.dependsOn) ||
    op.dependsOn.some((id) => typeof id !== "string" || id === op.opId) ||
    !Array.isArray(op.changes) ||
    op.changes.length > 200000 ||
    !Array.isArray(op.objects)
  )
    throw new Error("Invalid operation structure");
  const seen = new Set();
  for (const c of op.changes) {
    if (
      !ENTITIES.has(c.entity) ||
      !Array.isArray(c.key) ||
      c.key.some((v) => typeof v !== "string" || v.length > 200) ||
      !["create", "edit", "delete", "restore"].includes(c.action) ||
      typeof c.generation !== "string" ||
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
    canonical(c.base);
    canonical(c.desired);
    if (c.base !== null)
      validateEntityPayload(c.entity, c.key, c.base, op.teamId);
    if (c.desired !== null)
      validateEntityPayload(c.entity, c.key, c.desired, op.teamId);
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
    for (const url of JSON.stringify(c.desired).matchAll(
      /\/api\/document-images\/([^/"\\]+)\/([^"\\\s#)]+)/g,
    ))
      if (url[1] !== op.teamId || !/^[a-f0-9]{64}\.webp$/.test(url[2]))
        throw new Error("Foreign or invalid image reference");
  }
  if (Buffer.byteLength(canonical(op)) > 64 * 1024 * 1024)
    throw new Error("Operation exceeds protocol byte budget");
  return op;
}
