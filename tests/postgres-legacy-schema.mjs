import { entityId, stateHash } from "../server/sync/protocol.mjs";

// A fresh team v3 schema put back into the released team v2 shape: the v3
// tables and history are removed and the stored rows return to the earlier
// sheet clone names (sync protocol 1/2). Tests of migrations up to team v2
// start from this shape; the team v3 conversion then runs on it.
const LEGACY = {
  sheetClone: "report",
  sheetCloneTask: "reportTask",
  sheetCloneCell: "reportCell",
};
const LEGACY_SCOPE = { sheetClone: "report", sheetCloneMemo: "reportMemo" };
const legacyKey = (entity, key) =>
  entity === "document" && LEGACY_SCOPE[key[0]]
    ? [LEGACY_SCOPE[key[0]], ...key.slice(1)]
    : key;
export async function revertTeamToV2(pool) {
  await pool.query(
    "DROP TABLE graeboard.sync_conversions, graeboard.data_conversions; DELETE FROM graeboard.schema_migrations WHERE version>=3",
  );
  for (const table of ["sync_entities", "site_entities"])
    for (const row of (
      await pool.query(
        `SELECT team_id,entity,entity_key,payload FROM graeboard.${table}`,
      )
    ).rows) {
      if (row.entity === "protocol") {
        if (JSON.parse(row.payload).version === 3)
          await pool.query(
            `DELETE FROM graeboard.${table} WHERE team_id=$1 AND entity='protocol'`,
            [row.team_id],
          );
        else
          await pool.query(
            `UPDATE graeboard.${table} SET payload='{"reducer":2,"version":2}' WHERE team_id=$1 AND entity='protocol'`,
            [row.team_id],
          );
        continue;
      }
      const key = JSON.parse(row.entity_key),
        entity = LEGACY[row.entity] || row.entity,
        previous = legacyKey(row.entity, key);
      if (entity !== row.entity || previous !== key)
        await pool.query(
          `UPDATE graeboard.${table} SET entity=$4,entity_key=$5 WHERE team_id=$1 AND entity=$2 AND entity_key=$3`,
          [
            row.team_id,
            row.entity,
            row.entity_key,
            entity,
            JSON.stringify(previous),
          ],
        );
    }
  for (const { team_id: teamId, canonical_hash } of (
    await pool.query(
      "SELECT team_id,canonical_hash FROM graeboard.team_sync_links",
    )
  ).rows) {
    if (!canonical_hash) continue;
    const state = { entities: {}, receipts: {}, conflicts: {} };
    for (const row of (
      await pool.query(
        "SELECT * FROM graeboard.sync_entities WHERE team_id=$1",
        [teamId],
      )
    ).rows) {
      const key = JSON.parse(row.entity_key);
      state.entities[entityId(row.entity, key)] = {
        entity: row.entity,
        key,
        generation: row.generation,
        version: row.version,
        payload: JSON.parse(row.payload),
        deleted: !!row.deleted,
      };
    }
    for (const row of (
      await pool.query(
        "SELECT op_id,receipt FROM graeboard.sync_receipts WHERE team_id=$1",
        [teamId],
      )
    ).rows)
      state.receipts[row.op_id] = JSON.parse(row.receipt);
    for (const row of (
      await pool.query(
        "SELECT conflict_id,payload FROM graeboard.sync_conflicts WHERE team_id=$1",
        [teamId],
      )
    ).rows)
      state.conflicts[row.conflict_id] = JSON.parse(row.payload);
    await pool.query(
      "UPDATE graeboard.team_sync_links SET canonical_hash=$2 WHERE team_id=$1",
      [teamId, stateHash(state)],
    );
  }
}
// C without its protocol marker: the records a conversion must keep.
export const withoutMarker = ({ entities, ...rest }) => {
  const { [entityId("protocol", [])]: marker, ...records } = entities;
  return { ...rest, entities: records };
};
