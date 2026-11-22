import { syncSlideFiles } from "../sync/core/slide-file-branch.mjs";

// Runs slide file synchronization for the internal site: one periodic pass
// per active team. Saves update the store immediately; each tick publishes
// the latest available revisions and retries any unfinished work.
export function createSlideFileSync({
  db,
  sync,
  repository,
  intervalMs = 60000,
  log = (...args) => console.error(...args),
}) {
  const running = new Map();
  let ticker = null;
  let stopped = false;

  // Not while task synchronization is paused or recovering, and not while a
  // run, maintenance or an upgrade holds its lease.
  const idle = "mode='active' AND (lease_owner IS NULL OR lease_until < ?)";
  const active = (teamId) =>
    db
      .prepare(`SELECT 1 FROM team_sync_links WHERE team_id=? AND ${idle}`)
      .get(teamId, Date.now());
  // One pass at a time per team; a request during a pass is answered by it.
  function run(teamId) {
    if (stopped || !active(teamId)) return Promise.resolve(null);
    if (running.has(teamId)) return running.get(teamId);
    const pass = (async () => {
      try {
        return await syncSlideFiles({
          transport: sync.get(teamId).transport,
          store: repository,
          teamId,
          site: "internal",
          warn: log,
        });
      } catch (error) {
        log("GraeBoard slide synchronization failed", teamId, error.message);
        return null;
      }
    })().finally(() => running.delete(teamId));
    running.set(teamId, pass);
    return pass;
  }
  function start() {
    if (ticker || stopped) return;
    ticker = setInterval(() => {
      for (const row of db
        .prepare(`SELECT team_id FROM team_sync_links WHERE ${idle}`)
        .all(Date.now()))
        void run(row.team_id);
    }, intervalMs);
    ticker.unref?.();
  }
  async function close() {
    stopped = true;
    clearInterval(ticker);
    await Promise.all(running.values());
  }
  return { run, start, close };
}
