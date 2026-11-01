import {
  isRecoveryError,
  normalizeSyncError,
  isSyncInterruption,
  SyncInterruption,
} from "../server/sync/errors.mjs";
import {
  canonical,
  entityId,
  protocolVersion,
  stateSumFrom,
} from "../server/sync/protocol.mjs";
import { assert } from "./access.mjs";
import {
  capacityLimits,
  assertStateCapacity,
  measureDatabaseCapacity,
  CapacityError,
} from "./capacity.mjs";
import { materialize, materializeSlice } from "./materialize.mjs";
import {
  CanonicalSlice,
  reduceSlice,
  sliceChanges,
  canonicalHashes,
  computeTotals,
  readTotals,
  writeTotals,
  clearTotals,
} from "./sync-partial.mjs";
export function boundStore(
  database,
  teamId,
  {
    maintenanceJobId = null,
    limits = capacityLimits(),
    // A Supabase Edge invocation ends within 400 seconds (150 on Free), so an
    // invocation stopped at its CPU limit blocks the team for at most seven
    // minutes; an operator-side first import of a long chain may hold the
    // lease for hours.
    leaseMs = 420000,
    // Without it every commit re-compares every visible row, which heals a
    // damaged projection but costs the whole team. Hosted publish/receive runs
    // and a long operator import compare only what each commit changed.
    incrementalMaterialize = false,
    // Apply operations to the records they touch instead of loading C.
    slices = true,
  } = {},
) {
  let owner = null,
    // Whether this run's SQL hash of C matched the stored canonical hash.
    canonicalVerified = false;
  // SQL already measures C before it is read; the service derives the size of
  // each reduced state from it instead of serializing the whole state again.
  const measured = new WeakMap();
  const call = (work) => database.withTeamTransaction(teamId, work);
  return {
    readLink: () => database.readLink(teamId),
    readState: async ({ mark = () => {} } = {}) => {
      const { size, stateBytes } = await measureDatabaseCapacity(
        database,
        teamId,
        limits,
      );
      mark("measureCapacity", { bytes: stateBytes });
      const state = await database.readState(teamId);
      measured.set(state, {
        bytes: stateBytes,
        entities: size.entities,
        receiptBytes: size.receiptBytes,
      });
      return state;
    },
    measuredSize: (state) => measured.get(state),
    // Applies operations to the part of C they touch. The state sum comes
    // from C's kept totals (one order-free aggregate when they are missing)
    // plus the records the operations changed, so a commit costs what it
    // changes. With legacyHash it also has PostgreSQL rebuild the whole-state
    // hash a peer without the state sum still verifies, after checking the SQL
    // text of C against the stored canonical hash once per run. null means the
    // whole-state path decides: a v2 team, a key whose order could differ, or a
    // reduction the slice cannot complete on its own.
    reduceSlice: slices
      ? (
          operations,
          identity,
          { cover = [], legacyHash = false, mark = () => {} } = {},
        ) =>
          database.withTeamTransaction(
            teamId,
            async (tx) => {
              const link = await tx.sync.readLink();
              if (!link?.canonical_head) return null;
              const slice = new CanonicalSlice(tx, teamId),
                base = await slice.include(operations).include(cover).load();
              if (protocolVersion(base) !== 1) return null;
              const context = await slice.context(base);
              mark("readSlice", {
                entities: Object.keys(base.entities).length,
              });
              let state;
              try {
                ({ state } = reduceSlice(base, operations, identity, context));
              } catch {
                return null;
              }
              mark("reduce");
              let totals = await readTotals(tx, teamId, link.canonical_head);
              if (!totals) {
                totals = await computeTotals(tx, teamId);
                mark("computeTotals", { entities: totals.entities });
              }
              if (
                totals.entities > limits.maxEntities ||
                totals.stateBytes > limits.maxBytes
              )
                throw new CapacityError(
                  "External stored synchronization capacity exceeded; canonical cursor is unchanged",
                );
              measured.set(base, {
                bytes: totals.stateBytes,
                entities: totals.entities,
                receiptBytes: totals.receiptBytes,
              });
              const sum = stateSumFrom(totals.sum, base, state);
              mark("stateSum");
              let hash = null;
              if (legacyHash) {
                // C's SQL text is checked against the stored hash once per
                // run. Commits carrying only the state sum leave no stored
                // hash; the result hash is then the SQL rebuild alone.
                const check = !!link.canonical_hash && !canonicalVerified;
                const hashes = await canonicalHashes(
                  tx,
                  teamId,
                  sliceChanges(base, state),
                  { current: check },
                );
                const verified =
                  !!hashes &&
                  (!check || hashes.current === link.canonical_hash);
                mark("canonicalHash", { verified, checked: check });
                if (!verified) return null;
                if (check) canonicalVerified = true;
                hash = hashes.next;
              }
              return { head: link.canonical_head, base, state, sum, hash };
            },
            { readOnly: true },
          )
      : undefined,
    // The protocol C is at, from its marker record alone.
    readProtocol: () =>
      database.withTeamTransaction(
        teamId,
        async (tx) => {
          const row = (
            await tx.query(
              "SELECT payload FROM sync_entities WHERE team_id=$1 AND entity='protocol' AND entity_key='[]'",
              [teamId],
            )
          ).rows[0];
          return protocolVersion({
            entities: row?.payload
              ? {
                  [entityId("protocol", [])]: {
                    payload: JSON.parse(row.payload),
                  },
                }
              : {},
          });
        },
        { readOnly: true },
      ),
    readPending: () => database.readPending(teamId),
    async acquire(id) {
      return call(async (tx) => {
        if (
          (
            await tx.query(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND kind<>'backup' AND phase NOT IN ('complete','cancelled') AND ($2::text IS NULL OR job_id<>$2)",
              [teamId, maintenanceJobId],
            )
          ).rows.length
        )
          return false;
        const now = Date.now();
        const q = await tx.query(
          "UPDATE team_sync_links SET lease_owner=$2,lease_until=$3 WHERE team_id=$1 AND (lease_owner IS NULL OR lease_until<$4)",
          [teamId, id, now + leaseMs, now],
        );
        if (q.rowCount) {
          owner = id;
          return true;
        }
        return false;
      });
    },
    async release(id) {
      await call((tx) =>
        tx.query(
          "UPDATE team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=$1 AND lease_owner=$2",
          [teamId, id],
        ),
      );
      owner = null;
    },
    async commitCanonical(expected, head, state, ack, options = {}) {
      // A slice is not C: its size and hash come from the SQL measurement.
      if (
        options.slice &&
        !(options.stateSize && (options.stateHash || options.stateSum))
      )
        throw new Error("A slice commit requires its measured size and hash");
      // The service measured this same state; only the pending part is new.
      const size = options.stateSize || assertStateCapacity(state, limits);
      return database.commitCanonical(
        teamId,
        expected,
        head,
        state,
        ack,
        async (tx, projection) => {
          const link = await tx.sync.readLink();
          if (
            link.lease_owner !== owner ||
            link.lease_until <= Date.now() ||
            (!["active", "initializing", "importing"].includes(link.mode) &&
              !(options.transition === true && link.mode === "paused"))
          )
            throw new SyncInterruption();
          if (
            options.transition === true &&
            (
              await tx.query(
                "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
                [teamId],
              )
            ).rows.length
          )
            throw new SyncInterruption(
              "정리·백업 작업이 시작되어 형식 전환을 중단했습니다.",
            );
          if (options.transition === true && projection.pending.length)
            throw new SyncInterruption(
              "새 미전송 자료가 있어 형식 전환을 중단했습니다. 입력을 보존하고 관리자에게 확인하세요.",
            );
          if (
            size.bytes +
              projection.pending.reduce(
                (bytes, operation) =>
                  bytes + Buffer.byteLength(canonical(operation)),
                0,
              ) >
            limits.maxBytes
          )
            throw new CapacityError(
              "External state and pending capacity exceeded; prior data is preserved",
            );
          if (options.slice)
            await materializeSlice(tx, teamId, {
              ...projection,
              base: options.previousState,
            });
          else
            await materialize(
              tx,
              teamId,
              incrementalMaterialize && options.previousState
                ? { ...projection, previousState: options.previousState }
                : projection,
            );
          // C's totals follow every change to C, or are dropped so the next
          // reader measures C again.
          if (options.stateSum && options.stateSize)
            await writeTotals(tx, teamId, head, {
              sum: options.stateSum,
              entities: size.entities,
              stateBytes: size.bytes,
              receiptBytes: size.receiptBytes,
            });
          else await clearTotals(tx, teamId);
          // A received commit may acknowledge our own outbox after a lost
          // publish response. Only that evidence marks a local write published.
          if (ack.length)
            await tx.query(
              "UPDATE team_sync_links SET last_published_at=$2 WHERE team_id=$1 AND EXISTS (SELECT 1 FROM sync_outbox WHERE team_id=$1 AND op_id=ANY($3::text[]) AND status='acknowledged')",
              [teamId, new Date().toISOString(), ack],
            );
        },
        options,
      );
    },
    finishImport: (head) =>
      call(async (tx) => {
        const link = await tx.sync.readLink();
        assert(
          link?.lease_owner === owner && link.canonical_head === head,
          409,
          "가져오기 실행 또는 기준 커서가 바뀌었습니다.",
        );
        if (link.mode === "importing")
          await tx.query(
            "UPDATE team_sync_links SET mode='active' WHERE team_id=$1",
            [teamId],
          );
      }),
    setError: (error) =>
      isSyncInterruption(error)
        ? undefined
        : call((tx) =>
            tx.query(
              "UPDATE team_sync_links SET last_error=$2,updated_at=$3,mode=CASE WHEN $4 THEN 'recovery' ELSE mode END WHERE team_id=$1",
              [
                teamId,
                normalizeSyncError(error)?.message || null,
                new Date().toISOString(),
                isRecoveryError(error),
              ],
            ),
          ),
    saveRemoteStatus: (status) =>
      call(async (tx) => {
        const link = await tx.sync.readLink();
        return tx.query(
          "UPDATE team_sync_links SET remote_status=$2 WHERE team_id=$1",
          [
            teamId,
            canonical({ ...status, verifiedAgainstHead: link.canonical_head }),
          ],
        );
      }),
  };
}
