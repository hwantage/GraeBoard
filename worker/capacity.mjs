import { gunzipSync } from "node:zlib";
import { canonical } from "../server/sync/protocol.mjs";
import {
  SYNC_FILE_MAX_BYTES,
  SYNC_SNAPSHOT_MAX_BYTES,
} from "../shared/sync-limits.js";
import {
  CapacityError,
  capacityLimits,
  assertStateCapacity,
  receiptCapacity,
} from "../shared/sync-capacity.mjs";
export { CapacityError, capacityLimits, assertStateCapacity };
export function assertFileCapacity(path, bytes, limits = capacityLimits()) {
  if (!bytes) return bytes;
  if (!/^snapshots\//.test(path) && !/^events\//.test(path)) return bytes;
  if (
    bytes.byteLength >
    (path.startsWith("snapshots/")
      ? SYNC_SNAPSHOT_MAX_BYTES
      : Math.min(SYNC_FILE_MAX_BYTES, limits.maxBytes))
  )
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
// The parts stay separate so a capture can add only its own change to C.
export async function capacityTotals(tx, teamId) {
  // C's part comes from its totals kept at the current canonical head (see
  // writeTotals in sync-partial.mjs); only the outbox is summed here. Without
  // current totals the whole team is measured as before.
  const kept = (
    await tx.query(
      `SELECT l.canonical_head AS head, t.payload AS totals,
        (SELECT COALESCE(SUM(octet_length(payload)),0) FROM sync_outbox
          WHERE team_id=$1 AND status<>'acknowledged') AS outbox_bytes
      FROM team_sync_links l LEFT JOIN site_entities t
        ON t.team_id=l.team_id AND t.entity='syncTotals' AND t.entity_key='[]'
      WHERE l.team_id=$1`,
      [teamId],
    )
  ).rows[0];
  const totals = kept?.totals && JSON.parse(kept.totals);
  if (kept?.head && totals?.head === kept.head)
    return {
      entities: totals.entities,
      entityBytes: totals.stateBytes,
      conflictBytes: 0,
      outboxBytes: Number(kept.outbox_bytes),
      receiptBytes: totals.receiptBytes,
    };
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
        FROM sync_entities WHERE team_id=$1) AS entity_bytes,
      (SELECT COALESCE(SUM(octet_length(to_json(conflict_id)::text)+octet_length(payload)+2),0)
        FROM sync_conflicts WHERE team_id=$1) AS conflict_bytes,
      (SELECT COALESCE(SUM(octet_length(payload)),0) FROM sync_outbox
        WHERE team_id=$1 AND status<>'acknowledged') AS outbox_bytes,
      2 + (SELECT COALESCE(SUM(octet_length(to_json(op_id)::text)+octet_length(receipt)+2),0)
        FROM sync_receipts WHERE team_id=$1) AS receipt_bytes`,
      [teamId],
    )
  ).rows[0];
  return {
    entities: Number(row.entities),
    entityBytes: Number(row.entity_bytes),
    conflictBytes: Number(row.conflict_bytes),
    outboxBytes: Number(row.outbox_bytes),
    receiptBytes: Number(row.receipt_bytes),
  };
}
// The sync store also needs C alone (stateBytes) to size each reduced state;
// the reported capacity keeps its own shape.
async function measureTotals(tx, teamId) {
  const totals = await capacityTotals(tx, teamId);
  return {
    size: {
      entities: totals.entities,
      bytes: totals.entityBytes + totals.conflictBytes + totals.outboxBytes,
      receiptBytes: totals.receiptBytes,
      receiptCapacity: receiptCapacity(totals.receiptBytes),
    },
    stateBytes: totals.entityBytes + totals.conflictBytes,
  };
}
function measureDatabase(database, teamId) {
  return database.withTeamTransaction(
    teamId,
    (tx) => measureTotals(tx, teamId),
    { readOnly: true },
  );
}
export async function databaseCapacity(database, teamId) {
  return (await measureDatabase(database, teamId)).size;
}
function withinCapacity(measure, limits) {
  if (
    measure.size.entities > limits.maxEntities ||
    measure.size.bytes > limits.maxBytes
  )
    throw new CapacityError(
      "External stored synchronization capacity exceeded; canonical cursor is unchanged",
    );
  return measure;
}
export async function measureDatabaseCapacity(
  database,
  teamId,
  limits = capacityLimits(),
) {
  return withinCapacity(await measureDatabase(database, teamId), limits);
}
// The same measurement inside a caller's transaction.
export async function measureTransactionCapacity(
  tx,
  teamId,
  limits = capacityLimits(),
) {
  return withinCapacity(await measureTotals(tx, teamId), limits);
}
export async function assertDatabaseCapacity(
  database,
  teamId,
  limits = capacityLimits(),
) {
  return (await measureDatabaseCapacity(database, teamId, limits)).size;
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
  if (!bytes || bytes.byteLength > SYNC_SNAPSHOT_MAX_BYTES)
    throw new CapacityError(
      "External snapshot exceeds compressed byte capacity; canonical cursor is unchanged",
    );
  let source = bytes;
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      source = gunzipSync(bytes, { maxOutputLength: SYNC_SNAPSHOT_MAX_BYTES });
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
  if (source.byteLength > SYNC_SNAPSHOT_MAX_BYTES)
    throw new CapacityError(
      "External snapshot exceeds decoded byte capacity; canonical cursor is unchanged",
    );
  const value = JSON.parse(new TextDecoder().decode(source));
  if (value.state) assertStateCapacity(value.state, limits);
  return value;
}
