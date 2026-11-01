import { HttpError } from "./http-error.js";
import { canonical, entityId } from "../server/sync/protocol.mjs";
import {
  SYNC_RECEIPT_MAX_BYTES,
  SYNC_RECEIPT_WARNING_BYTES,
  SYNC_SNAPSHOT_MAX_BYTES,
} from "./sync-limits.js";

export class CapacityError extends HttpError {
  constructor(
    message = "External synchronization capacity exceeded",
    status = 413,
  ) {
    super(status, message);
    this.status = status;
    this.code = "EXTERNAL_SYNC_CAPACITY";
  }
}
// A team has no total size budget: saves, publications and receipts cost what
// they change (slices and the state sum), not the whole team. An operator may
// still cap a team with SYNC_MAX_STATE_BYTES and SYNC_MAX_ENTITIES.
export function capacityLimits(env = {}) {
  const cap = (name) => {
    if (env[name] === undefined || env[name] === "") return Infinity;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1024)
      throw new CapacityError(
        "External synchronization capacity configuration is invalid",
      );
    return value;
  };
  return {
    maxBytes: cap("SYNC_MAX_STATE_BYTES"),
    maxEntities: cap("SYNC_MAX_ENTITIES"),
    maxReceiptBytes: SYNC_RECEIPT_MAX_BYTES,
    maxSnapshotBytes: SYNC_SNAPSHOT_MAX_BYTES,
  };
}
export function receiptCapacity(bytes) {
  return {
    bytes,
    limitBytes: SYNC_RECEIPT_MAX_BYTES,
    warningBytes: SYNC_RECEIPT_WARNING_BYTES,
    warning: bytes >= SYNC_RECEIPT_WARNING_BYTES,
    blocked: bytes > SYNC_RECEIPT_MAX_BYTES,
  };
}
export const recordBytes = (key, value) =>
  Buffer.byteLength(JSON.stringify(key)) +
  Buffer.byteLength(canonical(value)) +
  2;
export function reservedReceiptBytes(operation) {
  // A failed command has no output tokens. Reserve both the longer failure
  // identity and every successful output token so either outcome fits before P
  // is saved. Existing versions can be reused by no-ops; reserve their length.
  const outputTokens = Object.fromEntries(
    operation.changes.map((change, index) => {
      const token = `${operation.opId}:${index}`;
      return [
        entityId(change.entity, change.key),
        typeof change.baseVersion === "string" &&
        change.baseVersion.length > token.length
          ? change.baseVersion
          : token,
      ];
    }),
  );
  return recordBytes(operation.opId, {
    opId: operation.opId,
    payloadHash: "f".repeat(64),
    result: "dependency-blocked",
    conflictId: operation.opId,
    outputTokens,
  });
}
export function assertReceiptCapacity(bytes, status = 413) {
  if (bytes > SYNC_RECEIPT_MAX_BYTES)
    throw new CapacityError(
      "동기화 수신 이력의 16MiB 한도에 도달했습니다. 기존 자료와 입력은 보존됩니다. 관리자에게 이력 용량을 확인해 주세요.",
      status,
    );
  return receiptCapacity(bytes);
}
export function assertStateCapacity(
  state,
  limits = capacityLimits(),
  pending = [],
  { allowReceiptOverflow = false, status = 413 } = {},
) {
  let bytes = 64,
    receiptBytes = 2,
    count = 0;
  for (const [section, records] of Object.entries(state)) {
    if (!["entities", "receipts", "conflicts"].includes(section)) continue;
    for (const [key, value] of Object.entries(records)) {
      if (section === "receipts") {
        receiptBytes += recordBytes(key, value);
        continue;
      }
      if (section === "entities" && ++count > limits.maxEntities)
        throw new CapacityError(
          "External synchronization entity capacity exceeded; canonical cursor is unchanged",
          status,
        );
      bytes += recordBytes(key, value);
      if (bytes > limits.maxBytes)
        throw new CapacityError(
          "External synchronization state byte capacity exceeded; canonical cursor is unchanged",
          status,
        );
    }
  }
  for (const operation of pending)
    bytes += Buffer.byteLength(canonical(operation));
  if (bytes > limits.maxBytes)
    throw new CapacityError(
      "External state and pending capacity exceeded; prior data is preserved",
      status,
    );
  if (!allowReceiptOverflow) assertReceiptCapacity(receiptBytes, status);
  return {
    bytes,
    entities: count,
    receiptBytes,
    receiptCapacity: receiptCapacity(receiptBytes),
  };
}
// The same measurement as assertStateCapacity(state), derived from a measured
// state it was reduced from: only records whose object changed are serialized.
export function assertStateCapacityFrom(
  base,
  baseSize,
  state,
  limits = capacityLimits(),
  { allowReceiptOverflow = false, status = 413 } = {},
) {
  let bytes = baseSize.bytes,
    receiptBytes = baseSize.receiptBytes,
    count = baseSize.entities;
  for (const section of ["entities", "receipts", "conflicts"]) {
    const before = base[section],
      after = state[section];
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const old = before[key],
        value = after[key];
      if (old === value) continue;
      const delta =
        (value === undefined ? 0 : recordBytes(key, value)) -
        (old === undefined ? 0 : recordBytes(key, old));
      if (section === "receipts") receiptBytes += delta;
      else bytes += delta;
      if (section === "entities")
        count += (value !== undefined) - (old !== undefined);
    }
  }
  if (count > limits.maxEntities)
    throw new CapacityError(
      "External synchronization entity capacity exceeded; canonical cursor is unchanged",
      status,
    );
  if (bytes > limits.maxBytes)
    throw new CapacityError(
      "External synchronization state byte capacity exceeded; canonical cursor is unchanged",
      status,
    );
  if (!allowReceiptOverflow) assertReceiptCapacity(receiptBytes, status);
  return {
    bytes,
    entities: count,
    receiptBytes,
    receiptCapacity: receiptCapacity(receiptBytes),
  };
}
