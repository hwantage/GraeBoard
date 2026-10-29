import { DatabaseAdapter } from "../../shared/database-adapter.js";
import { createTeamStore, executeSync } from "../../shared/sync-team-store.mjs";
import { assertSqliteHistory, sqliteVersion } from "../migrations/sqlite.mjs";

const statements = new WeakMap();
function execute(db, sql, params) {
  const bindings = [];
  const translated = sql.replace(/\$(\d+)/g, (_, n) => {
    bindings.push(params[Number(n) - 1]);
    return "?";
  });
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(translated);
  if (!statement) {
    statement = db.prepare(translated);
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(translated, statement);
  }
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    const rows = statement.all(...bindings).map((row) => ({ ...row }));
    return { rows, rowCount: rows.length };
  }
  const result = statement.run(...bindings);
  return { rows: [], rowCount: Number(result.changes) };
}

export function sqliteTeamStore(db, teamId) {
  return createTeamStore(teamId, (generator) =>
    executeSync(generator, (sql, params) => execute(db, sql, params)),
  );
}

export class SqliteDatabase extends DatabaseAdapter {
  constructor(db) {
    super();
    this.db = db;
    this.engine = "sqlite";
    this.active = false;
  }
  withTeamTransaction(teamId, work, { readOnly = false, createTeam } = {}) {
    if (work.constructor.name === "AsyncFunction")
      throw new Error("SQLite transaction callbacks must be synchronous");
    if (this.active)
      throw new Error("Nested SQLite adapter transaction is not allowed");
    this.active = true;
    let begun = false;
    try {
      this.db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      begun = true;
      if (!this.db.prepare("SELECT id FROM teams WHERE id=?").get(teamId)) {
        if (readOnly || createTeam?.id !== teamId)
          throw new Error("Unknown team");
        this.db
          .prepare("INSERT INTO teams(id,name,settings) VALUES(?,?,?)")
          .run(teamId, createTeam.name, createTeam.settings);
      }
      let open = true;
      const run = (sql, params = []) => {
        if (!open) throw new Error("Transaction is closed");
        return execute(this.db, sql, params);
      };
      const store = createTeamStore(teamId, (generator) =>
        executeSync(generator, run),
      );
      let result;
      try {
        result = work({ teamId, sync: store, store, query: run, db: this.db });
        if (result && typeof result.then === "function") {
          result.catch(() => {});
          throw new Error(
            "SQLite transaction callbacks must not return promises",
          );
        }
      } finally {
        open = false;
      }
      this.db.exec("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.active = false;
    }
  }
  readSnapshot(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readSnapshot(), {
      readOnly: true,
    });
  }
  readState(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readState(), {
      readOnly: true,
    });
  }
  readLink(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readLink(), {
      readOnly: true,
    });
  }
  readPending(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readPending(), {
      readOnly: true,
    });
  }
  health() {
    assertSqliteHistory(this.db);
    return {
      engine: this.engine,
      version: sqliteVersion(this.db),
      ready: true,
    };
  }
}
