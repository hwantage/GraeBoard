import {
  assertReceiptCapacity,
  receiptCapacity,
  reservedReceiptBytes,
} from "../../shared/sync-capacity.mjs";

// Canonical receipt rows are immutable. Reuse their byte total only for the same
// database/team/installation/head/hash/generation. Pending reservations advance
// from committed outbox sequence IDs; the operation being checked is not cached.
export function createReceiptCapacityGuard(db) {
  const cache = new Map();
  const totals = db.prepare(
    "SELECT COALESCE(SUM(length(CAST(receipt AS BLOB))+length(CAST(json_quote(op_id) AS BLOB))+2),0) AS bytes FROM sync_receipts WHERE team_id=?",
  );
  // The latest-save index also covers this range, but would visit acknowledged
  // history whenever no newer pending sequence advances this cursor.
  const tail = db.prepare(
    "SELECT local_seq,payload FROM sync_outbox INDEXED BY sync_outbox_pending_idx WHERE team_id=? AND status<>'acknowledged' AND local_seq>? ORDER BY local_seq",
  );
  const read = (link) => {
    const key = JSON.stringify([
      link.team_id,
      link.installation_id,
      link.repo_id,
      link.profile_id,
      link.canonical_head,
      link.canonical_hash,
      link.generation,
    ]);
    let value = cache.get(link.team_id);
    if (value?.key !== key) {
      value = {
        key,
        bytes: Number(totals.get(link.team_id).bytes) + 2,
        pendingBytes: 0,
        sequence: 0,
      };
      cache.set(link.team_id, value);
    }
    for (const row of tail.all(link.team_id, value.sequence)) {
      value.pendingBytes += reservedReceiptBytes(JSON.parse(row.payload));
      value.sequence = row.local_seq;
    }
    return value;
  };
  return {
    check(link, operation) {
      const value = read(link);
      return assertReceiptCapacity(
        value.bytes + value.pendingBytes + reservedReceiptBytes(operation),
        400,
      );
    },
    status(link) {
      return receiptCapacity(read(link).bytes);
    },
    clear() {
      cache.clear();
    },
  };
}
