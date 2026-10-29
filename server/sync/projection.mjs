import { entityId } from "./protocol.mjs";
import { entityReferences } from "./operations.mjs";

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
