import { gzipSync, gunzipSync } from "node:zlib";
import { getTasks, now } from "./db.mjs";

export function createTaskCache(db, { limit = 64 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const etagFor = (teamId, year, deleted) => {
    const version =
      db
        .prepare("SELECT version FROM team_revisions WHERE team_id=?")
        .get(teamId)?.version || 0;
    return `"${teamId}:${year}:${deleted ? 1 : 0}:${version}"`;
  };
  // 호출자가 이미 ETag를 계산했으면 넘겨서 revision을 두 번 읽지 않게 한다.
  const cachedTasks = (
    teamId,
    year,
    deleted,
    etag = etagFor(teamId, year, deleted),
  ) => {
    const key = `${teamId}:${year}:${deleted ? 1 : 0}`;
    const existing = entries.get(key);
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
      gzip = gzipSync(body, { level: 1 });
    // Large annual payloads still fit when stored compressed. Retaining neither
    // form caused every concurrent request to rebuild the entire dataset.
    const entry =
      body.length + gzip.length <= limit
        ? { etag, body, gzip, size: body.length + gzip.length }
        : compressedEntry(etag, gzip);
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
  cachedTasks.etag = etagFor;
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

function compressedEntry(etag, gzip) {
  return {
    etag,
    gzip,
    size: gzip.length,
    // Older clients may request identity encoding. Do not retain a second,
    // oversized buffer after serving their response.
    get body() {
      return gunzipSync(gzip);
    },
  };
}
