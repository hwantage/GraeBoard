import { syncSlideFiles } from "../sync/core/slide-file-branch.mjs";

// Runs slide file synchronization for the internal site: a pass shortly after
// a local change and a periodic pass for every team with an active
// synchronization link. It shares the team's Git clone and credentials with
// task synchronization but none of its state: a failure here never touches
// the task cursor, lease or outbox.
export function createSlideFileSync({
  db,
  sync,
  repository,
  intervalMs = 60000,
  log = (...args) => console.error(...args),
}) {
  const running = new Map();
  const timers = new Map();
  let ticker = null;
  let stopped = false;

  const active = (teamId) =>
    db
      .prepare(
        "SELECT 1 FROM team_sync_links WHERE team_id=? AND mode='active'",
      )
      .get(teamId);
  // One pass at a time per team; a request during a pass is answered by it.
  function run(teamId) {
    if (stopped || !active(teamId)) return Promise.resolve(null);
    if (running.has(teamId)) return running.get(teamId);
    const pass = (async () => {
      try {
        const result = await syncSlideFiles({
          transport: sync.get(teamId).transport,
          store: repository,
          teamId,
          site: "internal",
          warn: log,
        });
        // More chunks or a lost race: continue without waiting for the timer.
        if (result.pending || result.raced) schedule(teamId, 1000);
        return result;
      } catch (error) {
        log("GraeBoard slide synchronization failed", teamId, error.message);
        return null;
      } finally {
        running.delete(teamId);
      }
    })();
    running.set(teamId, pass);
    return pass;
  }
  function schedule(teamId, delayMs = 2000) {
    if (stopped || timers.has(teamId)) return;
    const timer = setTimeout(() => {
      timers.delete(teamId);
      void run(teamId);
    }, delayMs);
    timer.unref?.();
    timers.set(teamId, timer);
  }
  function start() {
    if (ticker || stopped) return;
    ticker = setInterval(() => {
      for (const row of db
        .prepare("SELECT team_id FROM team_sync_links WHERE mode='active'")
        .all())
        void run(row.team_id);
    }, intervalMs);
    ticker.unref?.();
  }
  async function close() {
    stopped = true;
    clearInterval(ticker);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await Promise.all(running.values());
  }
  return { run, schedule, start, close };
}
