import {
  RESOLUTION_PENDING,
  resolutionRejected,
} from "../../shared/sync/conflict-origin.js";
import { entityId, protocolVersion } from "../../server/sync/core/protocol.mjs";
import { withSyncOperationCache } from "../../server/sync/core/sync-operation-cache.mjs";
import { assert } from "../control/access.mjs";
import { CanonicalSlice, reduceSlice } from "./sync-partial.mjs";
import { materializeSlice } from "./materialize.mjs";

// Resolution preflight is a projection only; it never writes canonical state.
export async function resolveConflict(ctx, db, teamId, conflictId, body) {
  return withSyncOperationCache(() =>
    db.withTeamTransaction(teamId, async (tx) => {
      // The conflicts being resolved, their records and those pending
      // operations touch (see CanonicalSlice), not the whole of C.
      const choice = body.choice || body.strategy || "current",
        keep = ["current", "keep"].includes(choice),
        link = await tx.sync.readLink(),
        frontier = body.frontier || [conflictId],
        slice = new CanonicalSlice(tx, teamId, {
          conflictDetails: false,
        });
      if (Array.isArray(frontier))
        for (const id of [conflictId, ...frontier])
          if (typeof id === "string") slice.resolves.add(id);
      let state = await slice.load();
      const conflict = state.conflicts[conflictId];
      assert(
        conflict && !conflict.resolution,
        409,
        "충돌 상태가 변경되었습니다.",
      );
      assert(
        body.expectedHead === link.canonical_head,
        409,
        "최신 공유본을 다시 확인하세요.",
      );
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM site_maintenance_jobs WHERE phase NOT IN ('complete','cancelled')",
          )
        ).rows.length,
        409,
        "팀 자료 정리 중입니다.",
      );
      assert(
        Array.isArray(frontier) &&
          frontier.includes(conflictId) &&
          frontier.every(
            (id) => state.conflicts[id] && !state.conflicts[id].resolution,
          ),
        400,
        "해결 범위를 확인하세요.",
      );
      // A saved choice is detected from metadata, before reading any large
      // pending bodies. This also keeps retries cheap while publication waits.
      const saved = await tx.query(
        `SELECT 1 FROM sync_outbox b ${tx.readModels ? "LEFT JOIN sync_outbox_summaries s USING(team_id,op_id)" : ""}
         WHERE b.team_id=$1 AND b.status<>'acknowledged'
           AND EXISTS (SELECT 1 FROM json_array_elements_text(${tx.readModels ? "COALESCE(s.summary,b.payload)" : "b.payload"}::json->'resolves') AS r(id) WHERE r.id=ANY($2::text[])) LIMIT 1`,
        [teamId, frontier],
      );
      assert(!saved.rows.length, 409, RESOLUTION_PENDING);
      assert(
        ["current", "submitted", "edited", "custom", "keep", "apply"].includes(
          choice,
        ),
        400,
        "충돌 해결 방법을 확인하세요.",
      );
      // Keeping the current value creates an empty resolution with no
      // dependencies. Pending entity edits cannot change its result, so there
      // is no entity projection to replay or materialize for this choice.
      const rows = keep ? [] : await tx.sync.readPendingRows(),
        pending = rows.map((row) => row.operation);
      slice.include(pending);
      const originals = keep
        ? []
        : (
            await tx.query(
              `SELECT change.entity,change.key,change.action,change.desired::text AS desired
           FROM (SELECT payload FROM sync_conflicts WHERE team_id=$1 AND conflict_id=$2 OFFSET 0) selected
           CROSS JOIN LATERAL json_to_record(selected.payload::json) AS c(operation json)
           CROSS JOIN LATERAL json_to_record(c.operation) AS o(changes json)
           CROSS JOIN LATERAL json_array_elements(o.changes) WITH ORDINALITY AS x(value,n)
           CROSS JOIN LATERAL json_to_record(x.value) AS change(entity text,key json,action text,desired json)
           ORDER BY n`,
              [teamId, conflictId],
            )
          ).rows.map((row) => ({
            ...row,
            desired: row.desired === null ? null : JSON.parse(row.desired),
          }));
      for (const change of originals)
        slice.touch(change.entity, change.key, change.action);
      state = await slice.load(state);
      const changes = [];
      for (const [index, original] of originals.entries()) {
        const current = state.entities[entityId(original.entity, original.key)],
          desired = ["custom", "edited"].includes(choice)
            ? Array.isArray(body.desired)
              ? body.desired[index]
              : (body.desired?.[entityId(original.entity, original.key)] ??
                body.desired)
            : original.desired;
        assert(
          current || original.action === "create",
          409,
          "대상이 변경되었습니다.",
        );
        changes.push({
          ...original,
          base: current?.payload ?? null,
          baseVersion: current?.version ?? null,
          generation: current?.deleted
            ? crypto.randomUUID()
            : current?.generation || crypto.randomUUID(),
          action: current?.deleted
            ? "restore"
            : current
              ? original.action === "delete" && !keep
                ? "delete"
                : "edit"
              : "create",
          desired,
          fields: [
            ...new Set([
              ...Object.keys(current?.payload || {}),
              ...Object.keys(desired || {}),
            ]),
          ],
        });
      }
      const op = {
        protocol: protocolVersion(state),
        reducer: protocolVersion(state),
        repoId: link.repo_id,
        teamId,
        opId: crypto.randomUUID(),
        writerEpoch: link.writer_epoch,
        actorRef: ctx.user.id,
        createdAt: new Date().toISOString(),
        dependsOn: [],
        changes,
        objects: [],
        resolves: frontier,
      };
      // Checked after the pending operations, which publish first, as the
      // Node server does: a resolution archived again would leave this
      // conflict open and add another one.
      const { state: resolved } = reduceSlice(
        state,
        [...pending, op],
        null,
        await slice.context(state),
        rows.map((row) => ({
          serialized: row.payload,
          hash: row.payload_hash,
        })),
      );
      if (!["applied", "noop"].includes(resolved.receipts[op.opId].result)) {
        const { message, details } = resolutionRejected(
          resolved.conflicts[op.opId]?.reason,
        );
        assert(false, 409, message, details);
      }
      await tx.sync.enqueue(op);
      // C is unchanged; only what pending operations touch projects anew.
      if (!keep)
        await materializeSlice(tx, teamId, {
          base: state,
          state,
          pending: [...pending, op],
          projectedState: resolved,
          exclusions: await tx.sync.readExclusions(),
        });
      ctx.changedTeams.add(teamId);
      return { ok: true, opId: op.opId };
    }),
  );
}
