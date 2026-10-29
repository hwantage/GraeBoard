import { sqliteTeamStore } from "../storage/sqlite.mjs";

export function createNodeLeaseStores(db, installationId) {
  const ownedLeases = new Map();
  function store(teamId) {
    const raw = sqliteTeamStore(db, teamId);
    return {
      ...raw,
      acquire(owner) {
        const now = Date.now(),
          current = raw.readLink();
        if (!current) return false;
        if (current.installation_id !== installationId) {
          db.prepare(
            "UPDATE team_sync_links SET mode='recovery',last_error='Installation identity changed' WHERE team_id=?",
          ).run(teamId);
          return false;
        }
        if (
          db
            .prepare(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')",
            )
            .get(teamId)
        )
          return false;
        const acquired = !!db
          .prepare(
            "UPDATE team_sync_links SET lease_owner=?,lease_until=? WHERE team_id=? AND (lease_owner IS NULL OR lease_until<?)",
          )
          .run(owner, now + 600000, teamId, now).changes;
        if (acquired) ownedLeases.set(teamId, owner);
        return acquired;
      },
      release(owner) {
        db.prepare(
          "UPDATE team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=? AND lease_owner=?",
        ).run(teamId, owner);
        if (ownedLeases.get(teamId) === owner) ownedLeases.delete(teamId);
      },
    };
  }
  return {
    store,
    releaseAll() {
      for (const [teamId, owner] of ownedLeases) store(teamId).release(owner);
    },
  };
}
