import { entityId, protocolVersion } from "./protocol.mjs";
import { entityReferences } from "./operations.mjs";
import { uniqueName } from "./reducer.mjs";

// Site rows already contain C+P from capture/the preceding canonical commit.
// An independent change to C cannot change that projection on P's keys. Keep
// the entire ordered replay whenever its inputs, hierarchy, name constraints,
// tag users, receipts or resolutions change; never cache a reducer result.
export function pendingNeedsProjection(base, state, pending) {
  if (!pending.length) return false;
  if (!base || protocolVersion(base) !== protocolVersion(state)) return true;
  const keys = new Set(),
    names = new Set(),
    tags = new Set();
  for (const op of pending) {
    if (
      !op ||
      op.protocol !== protocolVersion(state) ||
      !Array.isArray(op.changes) ||
      !Array.isArray(op.dependsOn) ||
      (op.resolves && !Array.isArray(op.resolves))
    )
      return true;
    for (const id of [op.opId, ...op.dependsOn])
      if (base.receipts[id] !== state.receipts[id]) return true;
    for (const id of op.resolves || [])
      if (base.conflicts[id] !== state.conflicts[id]) return true;
    for (const change of op.changes) {
      if (
        !change ||
        typeof change.entity !== "string" ||
        !Array.isArray(change.key) ||
        (change.entity === "document" && !change.key.length) ||
        change.key.some((part) => typeof part !== "string")
      )
        return true;
      // siteWriter.finish also consumes the team row even when only another
      // record is written, so its pending overlay must always be present.
      if (change.entity === "team") return true;
      keys.add(entityId(change.entity, change.key));
      for (const [entity, key] of entityReferences(
        change.entity,
        change.key,
        null,
      ))
        keys.add(entityId(entity, key));
      if (change.entity === "tag") tags.add(change.key[0]);
      if (["tag", "filter", "sheetClone"].includes(change.entity))
        for (const payload of [change.base, change.desired]) {
          if (!payload) continue;
          if (typeof payload.name !== "string") return true;
          names.add(uniqueName({ entity: change.entity, payload }));
        }
      if (change.entity === "calendar")
        for (const payload of [change.base, change.desired]) {
          if (payload?.tags && !Array.isArray(payload.tags)) return true;
          for (const tag of payload?.tags || []) {
            if (typeof tag?.id !== "string") return true;
            keys.add(entityId("tag", [tag.id]));
          }
        }
    }
  }
  for (const id of new Set([
    ...Object.keys(base.entities),
    ...Object.keys(state.entities),
  ])) {
    const before = base.entities[id],
      after = state.entities[id];
    if (before === after) continue;
    if (keys.has(id)) return true;
    for (const record of [before, after]) {
      if (!record) continue;
      if (record.entity === "protocol" || names.has(uniqueName(record)))
        return true;
      // A parent's pending deletion/restore/retention affects child rows, and
      // protocol 4 children compose their parent copy's application payload.
      for (const [entity, key] of entityReferences(
        record.entity,
        record.key,
        null,
      ))
        if (keys.has(entityId(entity, key))) return true;
      if (
        record.entity === "calendar" &&
        record.payload.tags?.some((tag) => tags.has(tag.id))
      )
        return true;
    }
  }
  return false;
}

// Pending includes held operations. Their local rows and referenced parents
// remain recoverable until a verified canonical receipt acknowledges the input.
export function pendingEntityKeys(pending) {
  const keys = new Set();
  for (const operation of pending)
    for (const change of operation.changes) {
      keys.add(entityId(change.entity, change.key));
      for (const payload of [change.base, change.desired])
        for (const [entity, key] of entityReferences(
          change.entity,
          change.key,
          payload,
        ))
          keys.add(entityId(entity, key));
    }
  return keys;
}

export const canRetireProjection = (key, visible, protectedKeys) =>
  !visible[key] && !protectedKeys.has(key);
