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
export function assertStateCapacity(
  state,
  limits = capacityLimits(),
  pending = [],
) {
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
  for (const operation of pending)
    bytes += Buffer.byteLength(canonical(operation));
  if (bytes > limits.maxBytes)
    throw new CapacityError(
      "External state and pending capacity exceeded; prior data is preserved",
    );
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
// Same UTF-8 serialization metric as assertStateCapacity. Payloads and entity_key
// are already canonical JSON in storage; PostgreSQL to_json(text) supplies the
// same string escaping as JSON.stringify without fetching the canonical body.
export async function databaseCapacity(database, teamId) {
  return database.withTeamTransaction(
    teamId,
    async (tx) => {
      const row = (
        await tx.query(
          `SELECT
      (SELECT COUNT(*) FROM sync_entities WHERE team_id=$1) AS entities,
      64 + (SELECT COALESCE(SUM(
        octet_length(to_json('['||to_json(entity)::text||','||entity_key||']')::text) +
        octet_length('{"deleted":'||CASE WHEN deleted=1 THEN 'true' ELSE 'false' END||
          ',"entity":'||to_json(entity)::text||',"generation":'||to_json(generation)::text||
          ',"key":'||entity_key||',"payload":'||COALESCE(payload,'null')||
          ',"version":'||to_json(version)::text||'}') + 2),0)
        FROM sync_entities WHERE team_id=$1) +
      (SELECT COALESCE(SUM(octet_length(to_json(op_id)::text)+octet_length(receipt)+2),0)
        FROM sync_receipts WHERE team_id=$1) +
      (SELECT COALESCE(SUM(octet_length(to_json(conflict_id)::text)+octet_length(payload)+2),0)
        FROM sync_conflicts WHERE team_id=$1) +
      (SELECT COALESCE(SUM(octet_length(payload)),0) FROM sync_outbox
        WHERE team_id=$1 AND status<>'acknowledged') AS bytes`,
          [teamId],
        )
      ).rows[0];
      return { entities: Number(row.entities), bytes: Number(row.bytes) };
    },
    { readOnly: true },
  );
}
export async function assertDatabaseCapacity(
  database,
  teamId,
  limits = capacityLimits(),
) {
  const size = await databaseCapacity(database, teamId);
  if (size.entities > limits.maxEntities || size.bytes > limits.maxBytes)
    throw new CapacityError(
      "External stored synchronization capacity exceeded; canonical cursor is unchanged",
    );
  return size;
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
