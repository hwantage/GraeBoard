import { gunzipSync } from "node:zlib";
import { canonical } from "../server/sync/protocol.mjs";
export class CapacityError extends Error {
  constructor(message = "External synchronization capacity exceeded") {
    super(message);
    this.status = 413;
    this.code = "EXTERNAL_SYNC_CAPACITY";
  }
}
export function capacityLimits(env = {}) {
  const number = (name, fallback, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1024 || value > max)
      throw new CapacityError(
        "External synchronization capacity configuration is invalid",
      );
    return value;
  };
  return {
    maxBytes: number("SYNC_MAX_STATE_BYTES", 4 * 1024 * 1024, 4 * 1024 * 1024),
    maxEntities: number("SYNC_MAX_ENTITIES", 12000, 12000),
  };
}
export function assertStateCapacity(state, limits = capacityLimits()) {
  let bytes = 64,
    count = 0;
  for (const [section, records] of Object.entries(state)) {
    if (!["entities", "receipts", "conflicts"].includes(section)) continue;
    for (const [key, value] of Object.entries(records)) {
      if (section === "entities" && ++count > limits.maxEntities)
        throw new CapacityError(
          "External synchronization entity capacity exceeded; canonical cursor is unchanged",
        );
      bytes +=
        Buffer.byteLength(JSON.stringify(key)) +
        Buffer.byteLength(canonical(value)) +
        2;
      if (bytes > limits.maxBytes)
        throw new CapacityError(
          "External synchronization state byte capacity exceeded; canonical cursor is unchanged",
        );
    }
  }
  return { bytes, entities: count };
}
export function assertFileCapacity(path, bytes, limits = capacityLimits()) {
  if (!bytes) return bytes;
  if (!/^snapshots\//.test(path) && !/^events\//.test(path)) return bytes;
  if (bytes.byteLength > limits.maxBytes)
    throw new CapacityError(
      "External synchronization file capacity exceeded; canonical cursor is unchanged",
    );

  return bytes;
}
export function boundedTransport(transport, limits = capacityLimits()) {
  return new Proxy(transport, {
    get(target, name) {
      if (name === "readFile")
        return async (oid, path) =>
          assertFileCapacity(path, await target.readFile(oid, path), limits);
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function assertDatabaseCapacity(
  database,
  teamId,
  limits = capacityLimits(),
) {
  const row = await database.withTeamTransaction(
    teamId,
    async (tx) =>
      (
        await tx.query(
          "SELECT (SELECT COUNT(*) FROM sync_entities WHERE team_id=$1) AS entities,(SELECT COALESCE(SUM(octet_length(payload)+octet_length(entity_key)+250),0) FROM sync_entities WHERE team_id=$1)+(SELECT COALESCE(SUM(octet_length(receipt)),0) FROM sync_receipts WHERE team_id=$1)+(SELECT COALESCE(SUM(octet_length(payload)),0) FROM sync_conflicts WHERE team_id=$1)+(SELECT COALESCE(SUM(octet_length(payload)),0) FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged') AS bytes",
          [teamId],
        )
      ).rows[0],
    { readOnly: true },
  );
  if (
    Number(row.entities) > limits.maxEntities ||
    Number(row.bytes) > limits.maxBytes
  )
    throw new CapacityError(
      "External stored synchronization capacity exceeded; canonical cursor is unchanged",
    );
}

let synchronizationRunning = false;
export async function exclusiveSync(work) {
  if (synchronizationRunning) return { busy: true };
  synchronizationRunning = true;
  try {
    return await work();
  } finally {
    synchronizationRunning = false;
  }
}

export function decodeBoundedSnapshot(bytes, limits = capacityLimits()) {
  if (!bytes || bytes.byteLength > limits.maxBytes)
    throw new CapacityError(
      "External snapshot exceeds compressed byte capacity; canonical cursor is unchanged",
    );
  let source = bytes;
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      source = gunzipSync(bytes, { maxOutputLength: limits.maxBytes });
  } catch (error) {
    if (
      error.code === "ERR_BUFFER_TOO_LARGE" ||
      /larger|length|output|limit/i.test(error.message)
    )
      throw new CapacityError(
        "External snapshot exceeds decoded byte capacity; canonical cursor is unchanged",
      );
    throw error;
  }
  if (source.byteLength > limits.maxBytes)
    throw new CapacityError(
      "External snapshot exceeds decoded byte capacity; canonical cursor is unchanged",
    );
  return JSON.parse(new TextDecoder().decode(source));
}
