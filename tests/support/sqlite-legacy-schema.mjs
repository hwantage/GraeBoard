import { stateHash } from "../../server/sync/core/protocol.mjs";

// A fresh v34 database put back into the released v33 shape: the copy tables
// regain their earlier names, the v34 history is removed and the
// synchronization state returns to protocol 1/2 with the earlier record names.
// Tests that exercise migrations up to v33 start from this shape.
const LEGACY = {
  sheetClone: "report",
  sheetCloneTask: "reportTask",
  sheetCloneCell: "reportCell",
};
const LEGACY_SCOPE = { sheetClone: "report", sheetCloneMemo: "reportMemo" };
export function revertToV33(db) {
  db.exec(`
    DROP INDEX sheet_clone_documents_version_idx;
    DROP INDEX sheet_clone_memos_version_idx;
    ALTER TABLE sheet_clone_memos RENAME COLUMN sheet_clone_id TO report_id;
    ALTER TABLE sheet_clone_memos RENAME TO report_memos;
    ALTER TABLE sheet_clone_documents RENAME COLUMN sheet_clone_id TO report_id;
    ALTER TABLE sheet_clone_documents RENAME TO report_documents;
    ALTER TABLE sheet_clones RENAME TO reports;
    CREATE INDEX report_documents_version_idx ON report_documents(version_id);
    CREATE INDEX report_memos_version_idx ON report_memos(version_id);
    DELETE FROM schema_migrations WHERE version>=34;
    PRAGMA user_version=33;
  `);
  for (const { team_id: teamId } of db
    .prepare("SELECT team_id FROM team_sync_links")
    .all()) {
    for (const row of db
      .prepare("SELECT * FROM sync_entities WHERE team_id=?")
      .all(teamId)) {
      const key = JSON.parse(row.entity_key);
      if (row.entity === "protocol") {
        const { version } = JSON.parse(row.payload);
        if (version === 3)
          db.prepare(
            "DELETE FROM sync_entities WHERE team_id=? AND entity='protocol'",
          ).run(teamId);
        else
          db.prepare(
            "UPDATE sync_entities SET payload=? WHERE team_id=? AND entity='protocol'",
          ).run('{"reducer":2,"version":2}', teamId);
        continue;
      }
      const entity = LEGACY[row.entity] || row.entity,
        legacyKey =
          row.entity === "document" && LEGACY_SCOPE[key[0]]
            ? [LEGACY_SCOPE[key[0]], ...key.slice(1)]
            : key;
      if (entity !== row.entity || legacyKey !== key)
        db.prepare(
          "UPDATE sync_entities SET entity=?,entity_key=? WHERE team_id=? AND entity=? AND entity_key=?",
        ).run(
          entity,
          JSON.stringify(legacyKey),
          teamId,
          row.entity,
          row.entity_key,
        );
    }
    const state = { entities: {}, receipts: {}, conflicts: {} };
    for (const row of db
      .prepare("SELECT * FROM sync_entities WHERE team_id=?")
      .all(teamId)) {
      const key = JSON.parse(row.entity_key);
      state.entities[JSON.stringify([row.entity, key])] = {
        entity: row.entity,
        key,
        generation: row.generation,
        version: row.version,
        payload: JSON.parse(row.payload),
        deleted: !!row.deleted,
      };
    }
    for (const row of db
      .prepare("SELECT op_id,receipt FROM sync_receipts WHERE team_id=?")
      .all(teamId))
      state.receipts[row.op_id] = JSON.parse(row.receipt);
    for (const row of db
      .prepare("SELECT conflict_id,payload FROM sync_conflicts WHERE team_id=?")
      .all(teamId))
      state.conflicts[row.conflict_id] = JSON.parse(row.payload);
    db.prepare(
      "UPDATE team_sync_links SET canonical_hash=CASE WHEN canonical_hash IS NULL THEN NULL ELSE ? END WHERE team_id=?",
    ).run(stateHash(state), teamId);
  }
}
