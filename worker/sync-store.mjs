import { isRecoveryError, normalizeSyncError } from "../server/sync/errors.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import { assert } from "./access.mjs";
import {
  capacityLimits,
  assertStateCapacity,
  assertDatabaseCapacity,
} from "./capacity.mjs";
import { materialize } from "./materialize.mjs";
export function boundStore(
  database,
  teamId,
  { maintenanceJobId = null, limits = capacityLimits() } = {},
) {
  let owner = null;
  const call = (work) => database.withTeamTransaction(teamId, work);
  return {
    readLink: () => database.readLink(teamId),
    readState: async () => {
      await assertDatabaseCapacity(database, teamId, limits);
      return database.readState(teamId);
    },
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
          [teamId, id, now + 600000, now],
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
      assertStateCapacity(state, limits);
      return database.commitCanonical(
        teamId,
        expected,
        head,
        state,
        ack,
        async (tx, projection) => {
          const link = await tx.sync.readLink();
          assert(
            link.lease_owner === owner,
            409,
            "동기화 실행 소유권이 바뀌었습니다.",
          );
          assertStateCapacity(state, limits, projection.pending);
          await materialize(tx, teamId, projection);
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
      call((tx) =>
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
