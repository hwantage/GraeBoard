import { gzipSync } from "node:zlib";
import { getTasks, now } from "./db.mjs";

export function createTaskCache(db) {
  const entries = new Map();
  const limit = 64 * 1024 * 1024;
  let bytes = 0;
  const cachedTasks = (teamId, year, deleted) => {
    const key = `${teamId}:${year}:${deleted ? 1 : 0}`;
    const version =
      db
        .prepare("SELECT version FROM team_revisions WHERE team_id=?")
        .get(teamId)?.version || 0;
    const etag = `"${key}:${version}"`,
      existing = entries.get(key);
    if (existing?.etag === etag) return existing;
    if (existing) {
      bytes -= existing.size;
      entries.delete(key);
    }
    const body = Buffer.from(
        JSON.stringify({
          tasks: getTasks(db, teamId, year, deleted),
          serverTime: now(),
        }),
      ),
      gzip = gzipSync(body, { level: 1 }),
      entry = { etag, body, gzip, size: body.length + gzip.length };
    while (bytes + entry.size > limit && entries.size) {
      const first = entries.keys().next().value;
      bytes -= entries.get(first).size;
      entries.delete(first);
    }
    if (entry.size <= limit) {
      entries.set(key, entry);
      bytes += entry.size;
    }
    return entry;
  };
  cachedTasks.clearTeam = (teamId) => {
    for (const [key, entry] of entries) {
      if (key.startsWith(`${teamId}:`)) {
        bytes -= entry.size;
        entries.delete(key);
      }
    }
  };
  return cachedTasks;
}
