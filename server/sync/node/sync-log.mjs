import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// The internal site's only link to its peer is Git, so what a cycle did and
// why a Git command failed is written to daily files beside the database:
// <directory>/<teamId>/<YYYY-MM-DD>.jsonl, one JSON entry per line, dated in
// Korean time. Nothing here may fail or slow synchronization: every write is
// best effort and a failed write is dropped.
export const SYNC_LOG_LEVELS = ["changes", "cycles", "git"];
export const SYNC_LOG_DEFAULT_LEVEL = "cycles";
export const SYNC_LOG_RETENTION_DAYS = 14;
export const SYNC_LOG_PAGE = 200;
const TEAM = /^[A-Za-z0-9-]{1,64}$/,
  DATE = /^\d{4}-\d{2}-\d{2}$/,
  DAY = 86400000,
  CHUNK = 1024 * 1024;

// The lines of a file from its end, each with the byte offset it starts at.
// Read in chunks so a large day (every Git command logged) costs one page,
// not the whole file. The offset stays valid while the file grows.
function* linesBackward(file, before) {
  const descriptor = openSync(file, "r");
  try {
    const size = fstatSync(descriptor).size;
    let end = Math.min(
        Number.isInteger(before) && before >= 0 ? before : size,
        size,
      ),
      // The start of a line whose beginning is in an earlier chunk.
      tail = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK),
        chunk = Buffer.alloc(end - start);
      readSync(descriptor, chunk, 0, chunk.length, start);
      const data = tail.length ? Buffer.concat([chunk, tail]) : chunk;
      let stop = data.length;
      for (;;) {
        const newline = stop > 0 ? data.lastIndexOf(10, stop - 1) : -1;
        if (newline < 0) break;
        if (stop > newline + 1)
          yield {
            offset: start + newline + 1,
            text: data.toString("utf8", newline + 1, stop),
          };
        stop = newline;
      }
      if (start === 0) {
        if (stop > 0) yield { offset: 0, text: data.toString("utf8", 0, stop) };
      } else tail = data.subarray(0, stop);
      end = start;
    }
  } finally {
    closeSync(descriptor);
  }
}

export const syncLogDate = (time = Date.now()) =>
  new Date(time + 9 * 3600000).toISOString().slice(0, 10);

// Entries the viewer lists as problems: a failed cycle, Git command or
// requested action, and every state change, worker exit and skipped image.
export const syncLogProblem = (entry) =>
  entry.ok === false || ["state", "worker", "image"].includes(entry.kind);

export function syncLogDirectory(db, explicit) {
  if (explicit !== undefined) return explicit ? resolve(explicit) : null;
  if (process.env.GRAEBOARD_SYNC_LOG_DIR)
    return resolve(process.env.GRAEBOARD_SYNC_LOG_DIR);
  const file = db
    ?.prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  return file ? join(dirname(file), "sync-logs") : null;
}

export function createSyncLog(directory) {
  const settingsPath = directory && join(directory, "settings.json"),
    ready = new Set(),
    // Teams deleted while this process runs: a late entry of a cycle that was
    // still finishing must not bring the folder back.
    removed = new Set();
  let settings = { levels: {} },
    settingsStamp = null,
    pruned = null;
  const valid = (teamId, date) =>
    !!directory &&
    typeof teamId === "string" &&
    TEAM.test(teamId) &&
    (date === undefined || (typeof date === "string" && DATE.test(date)));
  const path = (teamId, date) => join(directory, teamId, date + ".jsonl");
  // Another thread or an operator may change the file, so it is read again
  // whenever its modification time or size differs.
  function readSettings() {
    if (!directory) return settings;
    try {
      const stat = statSync(settingsPath),
        stamp = stat.mtimeMs + ":" + stat.size;
      if (stamp !== settingsStamp) {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
        settings = {
          levels:
            parsed?.levels && typeof parsed.levels === "object"
              ? parsed.levels
              : {},
        };
        settingsStamp = stamp;
      }
    } catch {
      // Missing or unreadable settings mean the default level.
      settings = { levels: {} };
      settingsStamp = null;
    }
    return settings;
  }
  function level(teamId) {
    const value = readSettings().levels[teamId];
    return SYNC_LOG_LEVELS.includes(value) ? value : SYNC_LOG_DEFAULT_LEVEL;
  }
  function prune(now = Date.now()) {
    if (!directory) return;
    const oldest = syncLogDate(now - (SYNC_LOG_RETENTION_DAYS - 1) * DAY);
    let teams = [];
    try {
      teams = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Nothing written yet.
    }
    for (const team of teams) {
      if (!team.isDirectory() || !TEAM.test(team.name)) continue;
      const folder = join(directory, team.name);
      try {
        for (const name of readdirSync(folder)) {
          const date = name.replace(/\.jsonl$/, "");
          if (name.endsWith(".jsonl") && DATE.test(date) && date < oldest)
            rmSync(join(folder, name), { force: true });
        }
        // A folder left empty (its team is gone or idle) is removed; rmdir
        // refuses a folder that still holds files.
        if (!readdirSync(folder).length) {
          rmdirSync(folder);
          ready.delete(team.name);
        }
      } catch {
        // Old files of this team stay until the next attempt.
      }
    }
  }
  function write(teamId, entry) {
    if (!valid(teamId) || removed.has(teamId)) return;
    try {
      const now = Date.now(),
        date = syncLogDate(now);
      if (!ready.has(teamId)) {
        // Never recreate a data directory that was removed on purpose.
        if (!existsSync(dirname(directory))) return;
        mkdirSync(join(directory, teamId), { recursive: true, mode: 0o700 });
        ready.add(teamId);
      }
      appendFileSync(
        path(teamId, date),
        JSON.stringify({ at: new Date(now).toISOString(), ...entry }) + "\n",
        { mode: 0o600 },
      );
      if (pruned !== date) {
        pruned = date;
        prune(now);
      }
    } catch {
      ready.delete(teamId);
    }
  }
  return {
    directory,
    level,
    write,
    prune,
    // Detailed levels only add entries; failures are written at every level.
    git(teamId, entry) {
      if (entry.ok === false || level(teamId) === "git")
        write(teamId, { kind: "git", ...entry });
    },
    setLevel(teamId, value) {
      if (!valid(teamId) || !SYNC_LOG_LEVELS.includes(value))
        throw new Error("Invalid synchronization log level");
      const levels = { ...readSettings().levels, [teamId]: value };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = settingsPath + "." + process.pid + ".tmp";
      writeFileSync(temporary, JSON.stringify({ levels }, null, 2) + "\n", {
        mode: 0o600,
      });
      renameSync(temporary, settingsPath);
      settingsStamp = null;
    },
    dates(teamId) {
      if (!valid(teamId)) return [];
      try {
        return readdirSync(join(directory, teamId))
          .map((name) => name.replace(/\.jsonl$/, ""))
          .filter((date, i, all) => DATE.test(date) && all.indexOf(date) === i)
          .sort()
          .reverse();
      } catch {
        return [];
      }
    },
    file(teamId, date) {
      if (!valid(teamId, date)) return null;
      const file = path(teamId, date);
      return existsSync(file) ? file : null;
    },
    // Newest first. Each entry's `line` is the byte offset its line starts
    // at; `before` is the `next` of the previous page.
    read(teamId, { date, before, limit = SYNC_LOG_PAGE, problems } = {}) {
      const entries = [];
      let next = null;
      if (!valid(teamId, date)) return { entries, next };
      try {
        for (const { offset, text } of linesBackward(
          path(teamId, date),
          before,
        )) {
          let entry;
          try {
            entry = JSON.parse(text);
          } catch {
            // A line cut short by a crash is skipped.
            continue;
          }
          if (!entry || typeof entry !== "object") continue;
          if (problems && !syncLogProblem(entry)) continue;
          if (entries.length === limit) {
            next = entries.at(-1).line;
            break;
          }
          entries.push({ ...entry, line: offset });
        }
      } catch {
        // A missing or unreadable file is an empty day.
      }
      return { entries, next };
    },
    removeTeam(teamId) {
      if (!valid(teamId)) return;
      removed.add(teamId);
      ready.delete(teamId);
      try {
        rmSync(join(directory, teamId), { recursive: true, force: true });
      } catch {
        // Left for manual removal.
      }
    },
  };
}
