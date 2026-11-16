import { canonical, digest } from "../../server/sync/core/protocol.mjs";
import { conflictSummary } from "./conflict-origin.js";

// Derived local read models only: never included in canonical state or Git.
// Hash the exact JSON value, including its type, for the saved-choice label.
const changes = (operation = {}) =>
  (operation.changes || []).map((change) => ({
    entity: change.entity,
    key: change.key,
    desired: digest(canonical(change.desired ?? null)),
  }));
export const operationListSummary = (operation = {}) => ({
  opId: operation.opId,
  actorRef: operation.actorRef,
  createdAt: operation.createdAt,
  writerEpoch: operation.writerEpoch,
  resolves: operation.resolves || [],
  changes: operation.resolves?.length ? changes(operation) : [],
});
export function conflictListSummary(conflict) {
  return {
    ...conflictSummary(conflict),
    operation: {
      ...operationListSummary(conflict.operation),
      changes: changes(conflict.operation),
    },
  };
}

// Used by migration and PG import/restore. Read at most 8 MiB per batch,
// allowing one oversized record, without changing any source row.
export async function rebuildConflictSummaries(tx, teamId = null) {
  for (const [source, target, key, summarize] of [
    [
      "sync_conflicts",
      "sync_conflict_summaries",
      "conflict_id",
      conflictListSummary,
    ],
    ["sync_outbox", "sync_outbox_summaries", "op_id", operationListSummary],
  ]) {
    let afterTeam = "",
      afterId = "";
    for (;;) {
      const candidates = (
        await tx.query(
          `SELECT team_id,${key} id,octet_length(payload) bytes FROM ${source} WHERE ($1::text IS NULL OR team_id=$1) AND (team_id,${key})>($2,$3) ORDER BY team_id,${key} LIMIT 100`,
          [teamId, afterTeam, afterId],
        )
      ).rows;
      if (!candidates.length) break;
      const page = [];
      let bytes = 0;
      for (const row of candidates) {
        if (page.length && bytes + Number(row.bytes) > 8 * 1024 * 1024) break;
        page.push(row);
        bytes += Number(row.bytes);
      }
      const rows = (
        await tx.query(
          `SELECT s.team_id,s.${key} id,s.payload FROM ${source} s JOIN unnest($1::text[],$2::text[]) wanted(team_id,id) ON s.team_id=wanted.team_id AND s.${key}=wanted.id`,
          [page.map((row) => row.team_id), page.map((row) => row.id)],
        )
      ).rows;
      await tx.query(
        `INSERT INTO ${target}(team_id,${key},summary) SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) ON CONFLICT(team_id,${key}) DO UPDATE SET summary=EXCLUDED.summary`,
        [
          rows.map((row) => row.team_id),
          rows.map((row) => row.id),
          rows.map((row) => JSON.stringify(summarize(JSON.parse(row.payload)))),
        ],
      );
      afterTeam = page.at(-1).team_id;
      afterId = page.at(-1).id;
    }
  }
}
