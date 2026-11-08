import { AsyncLocalStorage } from "node:async_hooks";

// Only JSON parsed here is reusable. It is deeply frozen before a reducer or
// projection can see it; mutable callers and a different text for the same opId
// always go through validation again. The bounded memo lives for one run.
const scopes = new AsyncLocalStorage();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 128;
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const active = () => {
  const scope = scopes.getStore();
  return scope && !scope.closed ? scope : null;
};
export function parseSyncOperation(text) {
  const scope = active();
  if (!scope) return JSON.parse(text);
  if (scope.rows.has(text)) return scope.rows.get(text);
  const operation = JSON.parse(text),
    bytes = Buffer.byteLength(text);
  if (
    operation &&
    typeof operation === "object" &&
    scope.rows.size < MAX_ENTRIES &&
    scope.bytes + bytes <= MAX_BYTES
  ) {
    freeze(operation);
    scope.rows.set(text, operation);
    scope.prepared.set(operation, {});
    scope.jsonObjects.add(operation);
    for (const change of Array.isArray(operation.changes)
      ? operation.changes
      : [])
      for (const payload of [change?.base, change?.desired])
        if (payload && typeof payload === "object")
          scope.jsonObjects.add(payload);
    scope.bytes += bytes;
  }
  return operation;
}
// Metadata is available only for this run's own deeply immutable JSON.
export const preparedSyncOperation = (operation) =>
  active()?.prepared.get(operation);
export const syncCanonicalCache = () => active();
export function rememberSyncCanonical(scope, value, text) {
  if (scope?.jsonObjects.has(value) && !scope.texts.has(value)) {
    const bytes = Buffer.byteLength(text);
    if (scope.textBytes + bytes <= MAX_BYTES) {
      scope.texts.set(value, text);
      scope.textBytes += bytes;
    }
  }
  return text;
}

export function withSyncOperationCache(work) {
  if (active()) return work();
  const scope = {
    rows: new Map(),
    prepared: new WeakMap(),
    bytes: 0,
    closed: false,
    texts: new WeakMap(),
    jsonObjects: new WeakSet(),
    textBytes: 0,
  };
  const close = () => {
    scope.closed = true;
    scope.rows.clear();
    scope.prepared = new WeakMap();
    scope.texts = new WeakMap();
    scope.jsonObjects = new WeakSet();
  };
  return scopes.run(scope, () => {
    try {
      const result = work();
      if (result?.then) return Promise.resolve(result).finally(close);
      close();
      return result;
    } catch (error) {
      close();
      throw error;
    }
  });
}
