import { diffChars } from "diff";
import {
  canonical,
  digest,
  equal,
  entityId,
  validateOperation,
  validateEntityPayload,
} from "./protocol.mjs";

function edits(base, value) {
  const chunks = diffChars(base, value, { maxEditLength: 20000 }); // deterministic work budget, never wall-clock timeout
  if (!chunks) return null;
  let offset = 0,
    pending = null;
  const changes = [];
  for (const chunk of chunks) {
    if (!chunk.added && !chunk.removed) {
      if (pending) changes.push(pending);
      pending = null;
      offset += chunk.value.length;
    } else {
      pending ||= { start: offset, end: offset, text: "" };
      if (chunk.removed) {
        offset += chunk.value.length;
        pending.end = offset;
      } else pending.text += chunk.value;
    }
  }
  if (pending) changes.push(pending);
  return changes;
}
export function mergeMarkdown(base, current, desired) {
  if (current === desired || desired === base) return current;
  if (current === base) return desired;
  const a = edits(base, current),
    b = edits(base, desired);
  if (!a || !b) return null;
  const result = [...a];
  for (const edit of b) {
    let duplicate = false;
    for (const other of a) {
      if (equal(edit, other)) {
        duplicate = true;
        break;
      }
      if (
        edit.start === other.start ||
        Math.max(edit.start, other.start) < Math.min(edit.end, other.end) ||
        (edit.start > other.start && edit.start < other.end) ||
        (other.start > edit.start && other.start < edit.end)
      )
        return null;
    }
    if (!duplicate) result.push(edit);
  }
  result.sort((x, y) => x.start - y.start || x.end - y.end);
  let text = "",
    offset = 0;
  for (const edit of result) {
    text += base.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  return text + base.slice(offset);
}
export function validateSnapshot(state, identity) {
  const plain = (value) =>
    value && Object.getPrototypeOf(value) === Object.prototype;
  const token = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 512;
  if (
    !plain(state) ||
    !plain(state.entities) ||
    !plain(state.receipts) ||
    !plain(state.conflicts) ||
    Object.keys(state).some(
      (key) => !["entities", "receipts", "conflicts"].includes(key),
    )
  )
    throw new Error("Invalid canonical snapshot");
  for (const [key, record] of Object.entries(state.entities)) {
    if (
      key !== entityId(record.entity, record.key) ||
      !token(record.generation) ||
      !token(record.version) ||
      typeof record.deleted !== "boolean"
    )
      throw new Error("Invalid canonical record");
    validateEntityPayload(
      record.entity,
      record.key,
      record.payload,
      identity.teamId,
    );
  }
  for (const [id, conflict] of Object.entries(state.conflicts)) {
    validateOperation(conflict.operation, identity);
    if (
      id !== conflict.operation.opId ||
      conflict.conflictId !== id ||
      conflict.opId !== id ||
      !plain(conflict.current) ||
      typeof conflict.reason !== "string" ||
      (conflict.resolution !== null && !token(conflict.resolution))
    )
      throw new Error("Invalid conflict identity");
    for (const [key, record] of Object.entries(conflict.current)) {
      if (record === null) continue;
      if (
        !plain(record) ||
        key !== entityId(record.entity, record.key) ||
        !token(record.generation) ||
        !token(record.version) ||
        typeof record.deleted !== "boolean"
      )
        throw new Error("Invalid conflict base record");
      validateEntityPayload(
        record.entity,
        record.key,
        record.payload,
        identity.teamId,
      );
    }
    if (conflict.resolution && !state.receipts[conflict.resolution])
      throw new Error("Missing conflict resolution receipt");
  }
  for (const [id, receipt] of Object.entries(state.receipts))
    if (
      id !== receipt.opId ||
      !["applied", "noop", "conflict", "dependency-blocked"].includes(
        receipt.result,
      ) ||
      !/^[a-f0-9]{64}$/.test(receipt.payloadHash) ||
      !plain(receipt.outputTokens) ||
      !Object.values(receipt.outputTokens).every(token) ||
      (["conflict", "dependency-blocked"].includes(receipt.result)
        ? receipt.conflictId !== id ||
          !state.conflicts[id] ||
          digest(state.conflicts[id].operation) !== receipt.payloadHash
        : receipt.conflictId !== null)
    )
      throw new Error("Invalid receipt");
  const reason = validateState(state.entities);
  if (reason) throw new Error(reason);
  return state;
}

function validateState(entities) {
  const alive = (entity, key) => !!entities[entityId(entity, key)];
  const unique = new Set();
  for (const e of Object.values(entities)) {
    if (e.deleted) continue;
    const p = e.payload;
    if (e.entity === "cell" && !alive("task", [e.key[0]]))
      return "Missing parent task";
    if (e.entity === "document") {
      const parent =
        e.key[0] === "task"
          ? "task"
          : e.key[0] === "calendar"
            ? "calendar"
            : e.key[0].startsWith("report")
              ? "report"
              : null;
      if (parent && !alive(parent, [e.key[1]])) return "Missing document owner";
      if (
        typeof p.markdown !== "string" ||
        Buffer.byteLength(p.markdown) > 256 * 1024
      )
        return "Invalid document body";
    }
    if (e.entity === "calendar") {
      if (p.date > p.endDate || !Number.isSafeInteger(p.lane) || p.lane < 0)
        return "Invalid calendar range";
      for (const tag of p.tags || []) {
        const t = entities[entityId("tag", [tag.id])];
        if (!t || t.deleted || t.payload.userId !== p.userId)
          return "Missing or foreign calendar tag";
      }
    }
    if (["tag", "filter", "report"].includes(e.entity)) {
      const name =
        e.entity === "tag"
          ? p.name.replace(/[A-Z]/g, (x) => x.toLowerCase())
          : p.name.normalize("NFC");
      const key = canonical([e.entity, p.userId || null, name]);
      if (unique.has(key)) return "Duplicate name";
      unique.add(key);
    }
  }
  return null;
}
export function reduce(
  state,
  op,
  identity = { teamId: op.teamId, repoId: op.repoId },
  context = null,
) {
  validateOperation(op, identity);
  const payloadHash = digest(op),
    existing = state.receipts[op.opId];
  if (existing) {
    if (existing.payloadHash !== payloadHash)
      throw new Error("Immutable opId payload mismatch");
    return { state, receipt: existing, duplicate: true };
  }
  for (const id of op.dependsOn)
    if (!state.receipts[id]) throw new Error("Unordered dependency");
  let reason = op.dependsOn.some(
    (id) => !["applied", "noop"].includes(state.receipts[id].result),
  )
    ? "Failed dependency"
    : null;
  const entities = context ? context.entities : { ...state.entities },
    outputs = {},
    undo = new Map();
  let changed = false;
  const remember = (key) => {
    if (!undo.has(key)) undo.set(key, entities[key]);
  };
  for (const change of op.changes)
    remember(entityId(change.entity, change.key));
  if (!reason)
    for (const c of op.changes) {
      const key = entityId(c.entity, c.key),
        current = entities[key];
      let payload = current?.payload,
        deleted = false,
        generation = current?.generation || c.generation;
      const parent =
        c.entity === "cell"
          ? entities[entityId("task", [c.key[0]])]
          : c.entity === "document" && ["task", "calendar"].includes(c.key[0])
            ? entities[entityId(c.key[0], [c.key[1]])]
            : null;
      if (parent?.deleted && c.action !== "delete") {
        reason = "Parent task deleted";
        break;
      }
      if (c.action === "create") {
        if (current) {
          if (
            !current.deleted &&
            current.generation === c.generation &&
            equal(current.payload, c.desired)
          ) {
            outputs[key] = current.version;
            continue;
          }
          reason = "Entity already exists";
          break;
        }
        payload = c.desired;
      } else if (c.action === "restore") {
        let baseVersion = c.baseVersion;
        for (const dependency of op.dependsOn)
          if (baseVersion?.startsWith(dependency + ":"))
            baseVersion =
              state.receipts[dependency]?.outputTokens?.[key] || baseVersion;
        if (!current?.deleted || current.version !== baseVersion) {
          reason = "Restore base changed";
          break;
        }
        generation = c.generation;
        payload = c.desired;
      } else {
        if (!current || current.generation !== c.generation) {
          reason = "Entity generation changed";
          break;
        }
        if (c.action === "delete") {
          if (current.deleted) {
            outputs[key] = current.version;
            continue;
          }
          if (!equal(current.payload, c.base)) {
            reason = "Delete conflicts with edit";
            break;
          }
          deleted = true;
        } else {
          if (current.deleted) {
            reason = "Entity deleted";
            break;
          }
          payload = { ...current.payload };
          for (const field of c.fields) {
            const base = c.base?.[field],
              desired = c.desired?.[field],
              value = current.payload?.[field];
            if (equal(value, desired) || equal(desired, base)) continue;
            if (equal(value, base)) {
              if (desired === undefined) delete payload[field];
              else payload[field] = desired;
              continue;
            }
            if (
              field === "markdown" &&
              [base, value, desired].every((x) => typeof x === "string")
            ) {
              const merged = mergeMarkdown(base, value, desired);
              if (merged !== null) {
                payload[field] = merged;
                continue;
              }
            }
            reason = "Concurrent field change";
            break;
          }
          if (reason) break;
        }
      }
      const version = op.opId + ":" + op.changes.indexOf(c);
      if (
        !current ||
        deleted !== !!current.deleted ||
        !equal(payload, current.payload) ||
        generation !== current.generation
      ) {
        entities[key] = {
          entity: c.entity,
          key: c.key,
          generation,
          version,
          payload,
          deleted,
        };
        changed = true;
        outputs[key] = version;
      } else outputs[key] = current.version;
      if (["task", "calendar"].includes(c.entity) && c.action === "restore")
        for (const [childId, child] of Object.entries(entities))
          if (
            (c.entity === "task" &&
              child.entity === "cell" &&
              child.key[0] === c.key[0]) ||
            (child.entity === "document" &&
              child.key[0] === c.entity &&
              child.key[1] === c.key[0])
          ) {
            remember(childId);
            entities[childId] = { ...child, generation: version, version };
          }
    }
  reason ||= context
    ? validateIncrement(entities, undo, context)
    : validateState(entities);
  if (reason && context)
    for (const [key, previous] of undo) {
      if (previous) entities[key] = previous;
      else delete entities[key];
    }
  const result = reason
    ? reason === "Failed dependency"
      ? "dependency-blocked"
      : "conflict"
    : changed
      ? "applied"
      : "noop";
  const conflictId = reason ? op.opId : null;
  const receipt = {
    opId: op.opId,
    payloadHash,
    result,
    conflictId,
    outputTokens: reason ? {} : outputs,
  };
  const conflicts = context ? state.conflicts : { ...state.conflicts };
  if (reason)
    conflicts[op.opId] = {
      conflictId: op.opId,
      opId: op.opId,
      operation: op,
      reason,
      current: Object.fromEntries(
        op.changes.map((c) => {
          const k = entityId(c.entity, c.key);
          return [k, (context ? undo.get(k) : state.entities[k]) || null];
        }),
      ),
      resolution: null,
    };
  else if (op.resolves)
    for (const id of op.resolves)
      if (conflicts[id])
        conflicts[id] = { ...conflicts[id], resolution: op.opId };
  const receipts = context ? state.receipts : { ...state.receipts };
  receipts[op.opId] = receipt;
  return {
    state: {
      entities: reason ? state.entities : entities,
      receipts,
      conflicts,
    },
    receipt,
  };
}
const uniqueName = (record) => {
  if (
    !record ||
    record.deleted ||
    !["tag", "filter", "report"].includes(record.entity)
  )
    return null;
  const p = record.payload,
    name =
      record.entity === "tag"
        ? p.name.replace(/[A-Z]/g, (c) => c.toLowerCase())
        : p.name.normalize("NFC");
  return canonical([record.entity, p.userId || null, name]);
};
function validationContext(entities) {
  const names = new Map(),
    tagUsers = new Map();
  for (const [id, record] of Object.entries(entities)) {
    const name = uniqueName(record);
    if (name) names.set(name, id);
    if (record.entity === "calendar" && !record.deleted)
      for (const tag of record.payload.tags || []) {
        if (!tagUsers.has(tag.id)) tagUsers.set(tag.id, new Set());
        tagUsers.get(tag.id).add(id);
      }
  }
  return { entities, names, tagUsers };
}
function validateIncrement(entities, undo, context) {
  const touched = new Set(undo.keys());
  for (const id of undo.keys()) {
    const record = entities[id];
    if (record?.entity === "tag")
      for (const user of context.tagUsers.get(record.key[0]) || [])
        touched.add(user);
  }
  for (const id of touched) {
    const e = entities[id];
    if (!e || e.deleted) continue;
    const p = e.payload;
    if (e.entity === "cell" && !entities[entityId("task", [e.key[0]])])
      return "Missing parent task";
    if (e.entity === "document") {
      const parent =
        e.key[0] === "task"
          ? "task"
          : e.key[0] === "calendar"
            ? "calendar"
            : e.key[0].startsWith("report")
              ? "report"
              : null;
      if (parent && !entities[entityId(parent, [e.key[1]])])
        return "Missing document owner";
      if (
        typeof p.markdown !== "string" ||
        Buffer.byteLength(p.markdown) > 256 * 1024
      )
        return "Invalid document body";
    }
    if (e.entity === "calendar") {
      if (p.date > p.endDate || !Number.isSafeInteger(p.lane) || p.lane < 0)
        return "Invalid calendar range";
      for (const tag of p.tags || []) {
        const target = entities[entityId("tag", [tag.id])];
        if (!target || target.deleted || target.payload.userId !== p.userId)
          return "Missing or foreign calendar tag";
      }
    }
  }
  const names = new Map(context.names);
  for (const [id, old] of undo) {
    const name = uniqueName(old);
    if (name && names.get(name) === id) names.delete(name);
  }
  for (const id of undo.keys()) {
    const name = uniqueName(entities[id]);
    if (name) {
      if (names.has(name) && names.get(name) !== id) return "Duplicate name";
      names.set(name, id);
    }
  }
  context.names = names;
  for (const [id, old] of undo) {
    if (old?.entity === "calendar")
      for (const tag of old.payload.tags || [])
        context.tagUsers.get(tag.id)?.delete(id);
    const next = entities[id];
    if (next?.entity === "calendar" && !next.deleted)
      for (const tag of next.payload.tags || []) {
        if (!context.tagUsers.has(tag.id))
          context.tagUsers.set(tag.id, new Set());
        context.tagUsers.get(tag.id).add(id);
      }
  }
  return null;
}

// One working copy for an ordered replay. Each command retains atomic rollback,
// receipts and conflicts; only the temporary projection mutates. This avoids
// copying and validating hundreds of thousands of unrelated cells per keystroke.
export function reduceMany(state, operations, identity) {
  let result = {
    entities: { ...state.entities },
    receipts: { ...state.receipts },
    conflicts: { ...state.conflicts },
  };
  const context = validationContext(result.entities);
  for (const op of operations)
    result = reduce(
      result,
      op,
      identity || { teamId: op.teamId, repoId: op.repoId },
      context,
    ).state;
  return result;
}
export function project(state, pending) {
  // Projection consumers read shared immutable records; an empty P needs no
  // entity/receipt/conflict map copies or validation index.
  if (!pending.length) return { entities: state.entities, held: [] };
  const projected = reduceMany(state, pending);
  return {
    entities: projected.entities,
    held: pending
      .filter(
        (op) =>
          !["applied", "noop"].includes(projected.receipts[op.opId].result),
      )
      .map((op) => op.opId),
  };
}
