import { randomUUID } from "node:crypto";
import { canonical, digest } from "../server/sync/protocol.mjs";
import { executeSync, executeAsync } from "./sync-team-store.mjs";
import { requireThat } from "./http-error.js";

const MAX_ROWS = 500,
  MAX_BYTES = 10 * 1024 * 1024;
const query = (sql, values = []) => ({ sql, values });
function references(operation, protectedIds) {
  protectedIds.add(operation.opId);
  for (const id of [
    ...(operation.dependsOn || []),
    ...(operation.resolves || []),
  ])
    protectedIds.add(id);
  for (const change of operation.changes || [])
    if (typeof change.baseVersion === "string")
      protectedIds.add(
        change.baseVersion.slice(0, change.baseVersion.lastIndexOf(":")) ||
          change.baseVersion,
      );
}
function* protectedOperations(teamId) {
  const ids = new Set();
  let bytes = 0;
  for (const [table, column, condition] of [
    ["sync_outbox", "payload", "status<>'acknowledged'"],
    ["sync_conflicts", "payload", "resolution IS NULL"],
  ]) {
    bytes += Number(
      (yield query(
        `SELECT COALESCE(SUM(octet_length(${column})),0) bytes FROM ${table} WHERE team_id=$1 AND ${condition}`,
        [teamId],
      )).rows[0].bytes,
    );
    requireThat(
      bytes <= MAX_BYTES,
      409,
      "미전송·충돌 자료가 큽니다. 먼저 동기화와 충돌을 정리한 뒤 운영 이력 정리를 다시 준비하세요.",
    );
    const rows = yield query(
      `SELECT ${column} FROM ${table} WHERE team_id=$1 AND ${condition}`,
      [teamId],
    );
    for (const row of rows.rows) {
      const value = JSON.parse(row.payload);
      references(table === "sync_conflicts" ? value.operation : value, ids);
    }
  }
  return ids;
}
function* preview(teamId, asOf, now) {
  const at = Date.parse(asOf);
  requireThat(
    Number.isFinite(at) && new Date(at).toISOString() === asOf && at <= now,
    400,
    "현재 시각 이하의 ISO 기준시각을 지정하세요.",
  );
  const outboxBefore = new Date(at - 30 * 86400000).toISOString(),
    eventsBefore = new Date(at - 7 * 86400000).toISOString();
  const link =
    (yield query(
      "SELECT canonical_head,generation FROM team_sync_links WHERE team_id=$1",
      [teamId],
    )).rows[0] || null;
  const protectedIds = yield* protectedOperations(teamId);
  const latest = Number(
    (yield query(
      "SELECT COALESCE(MAX(local_seq),0) AS seq FROM sync_outbox WHERE team_id=$1",
      [teamId],
    )).rows[0].seq,
  );
  const candidates = [];
  let bytes = 0,
    after = 0,
    hasMore = false;
  for (;;) {
    const rows = (yield query(
      "SELECT op_id,local_seq,payload_hash,octet_length(payload) payload_bytes FROM sync_outbox WHERE team_id=$1 AND status='acknowledged' AND created_at<$2 AND local_seq>$3 AND local_seq<$4 ORDER BY local_seq LIMIT 500",
      [teamId, outboxBefore, after, latest],
    )).rows;
    if (!rows.length) break;
    for (const row of rows) {
      after = Number(row.local_seq);
      if (
        !row.payload_hash ||
        protectedIds.has(row.op_id) ||
        Number(row.payload_bytes) > MAX_BYTES
      )
        continue;
      const evidence = (yield query(
        "SELECT payload_hash,receipt,commit_oid FROM sync_receipts WHERE team_id=$1 AND op_id=$2",
        [teamId, row.op_id],
      )).rows[0];
      if (
        !evidence ||
        evidence.payload_hash !== row.payload_hash ||
        !/^[a-f0-9]{40}$/.test(evidence.commit_oid || "")
      )
        continue;
      const receipt = JSON.parse(evidence.receipt);
      if (
        receipt.opId !== row.op_id ||
        receipt.payloadHash !== row.payload_hash
      )
        continue;
      const payload = (yield query(
        "SELECT payload FROM sync_outbox WHERE team_id=$1 AND op_id=$2",
        [teamId, row.op_id],
      )).rows[0].payload;
      if (digest(JSON.parse(payload)) !== row.payload_hash) continue;
      const size = Buffer.byteLength(payload);
      if (size > MAX_BYTES) continue;
      if (candidates.length === MAX_ROWS || bytes + size > MAX_BYTES) {
        hasMore = true;
        break;
      }
      candidates.push({
        table: "sync_outbox",
        key: row.op_id,
        hash: row.payload_hash,
        bytes: size,
      });
      bytes += size;
    }
    if (hasMore || rows.length < 500) break;
  }
  if (!hasMore) {
    // OFFSET 999 identifies the oldest of the newest 1,000 retained events.
    const retained = (yield query(
      "SELECT cursor FROM site_events WHERE team_id=$1 ORDER BY cursor DESC LIMIT 1 OFFSET 999",
      [teamId],
    )).rows[0];
    if (retained) {
      const rows = (yield query(
        "SELECT cursor,kind,created_at,octet_length(payload) payload_bytes FROM site_events WHERE team_id=$1 AND cursor<$2 AND created_at<$3 ORDER BY cursor LIMIT 501",
        [teamId, retained.cursor, eventsBefore],
      )).rows;
      for (const row of rows) {
        const size = Number(row.payload_bytes);
        if (size > MAX_BYTES) continue;
        if (candidates.length === MAX_ROWS || bytes + size > MAX_BYTES) {
          hasMore = true;
          break;
        }
        const payload = (yield query(
          "SELECT payload FROM site_events WHERE team_id=$1 AND cursor=$2",
          [teamId, row.cursor],
        )).rows[0].payload;
        candidates.push({
          table: "site_events",
          key: String(row.cursor),
          hash: digest([row.kind, payload, row.created_at]),
          bytes: size,
        });
        bytes += size;
      }
    }
  }
  const manifest = {
    teamId,
    asOf,
    outboxBefore,
    eventsBefore,
    head: link?.canonical_head || null,
    generation: Number(link?.generation || 0),
    candidates,
  };
  return {
    ...manifest,
    token: digest(manifest),
    rows: candidates.length,
    bytes,
    hasMore,
  };
}
function* apply(teamId, input, now) {
  requireThat(
    typeof input.token === "string",
    400,
    "미리보기 token과 기준시각이 필요합니다.",
  );
  requireThat(
    !(yield query(
      "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled') LIMIT 1",
      [teamId],
    )).rows.length,
    409,
    "백업 또는 다른 유지보수 작업이 진행 중입니다.",
  );
  const link = (yield query(
    "SELECT lease_owner,lease_until FROM team_sync_links WHERE team_id=$1",
    [teamId],
  )).rows[0];
  requireThat(
    !link?.lease_owner || Number(link.lease_until) <= now,
    409,
    "동기화가 진행 중입니다. 완료한 뒤 다시 정리하세요.",
  );
  const selected = yield* preview(teamId, input.asOf, now);
  requireThat(
    selected.token === input.token,
    409,
    "정리 후보가 변경되었습니다. 미리보기를 다시 확인하세요.",
  );
  if (!selected.rows) return { removed: 0, bytes: 0, hasMore: false };
  const jobId = randomUUID(),
    owner = randomUUID(),
    createdAt = new Date(now).toISOString();
  yield query(
    "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'local-history','deleting',$3,$4,$5)",
    [
      jobId,
      teamId,
      canonical(selected),
      canonical({ owner, until: now + 600000 }),
      createdAt,
    ],
  );
  for (const item of selected.candidates) {
    const key = item.table === "sync_outbox" ? "op_id" : "cursor";
    const result = yield query(
      `DELETE FROM ${item.table} WHERE team_id=$1 AND ${key}=$2`,
      [teamId, item.key],
    );
    requireThat(
      result.rowCount === 1,
      409,
      "정리 후보가 변경되었습니다. 현재 묶음은 보존됩니다.",
    );
  }
  yield query(
    "UPDATE site_maintenance_jobs SET phase='complete',progress=$3 WHERE team_id=$1 AND job_id=$2",
    [
      teamId,
      jobId,
      canonical({
        owner,
        removed: selected.rows,
        bytes: selected.bytes,
        completedAt: createdAt,
      }),
    ],
  );
  return {
    jobId,
    removed: selected.rows,
    bytes: selected.bytes,
    hasMore: selected.hasMore,
  };
}

// Opt-in operator action only. Each preview/apply uses the adapter's existing
// team transaction/lock; a failed 500-row/10MiB batch rolls back in full.
export function localHistoryMaintenance(
  database,
  teamId,
  input,
  { now = Date.now() } = {},
) {
  const work = input.apply
    ? apply(teamId, input, now)
    : preview(teamId, input.asOf, now);
  if (database.engine === "sqlite")
    return database.withTeamTransaction(
      teamId,
      (tx) => executeSync(work, tx.query),
      { readOnly: !input.apply },
    );
  return database.withTeamTransaction(
    teamId,
    (tx) => executeAsync(work, tx.query),
    { readOnly: !input.apply },
  );
}
