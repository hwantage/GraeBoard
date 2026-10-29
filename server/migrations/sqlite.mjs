import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_VERSION = 33;
export const baseSql = readFileSync(
  new URL("./sqlite/029-base.sql", import.meta.url),
  "utf8",
);
export const syncSql = readFileSync(
  new URL("./sqlite/030-sync.sql", import.meta.url),
  "utf8",
);
export const syncChecksum = createHash("sha256").update(syncSql).digest("hex");

export const keySql = readFileSync(
  new URL("./sqlite/031-setup-keys.sql", import.meta.url),
  "utf8",
);
export const keyChecksum = createHash("sha256").update(keySql).digest("hex");
export const maintenanceSql = readFileSync(
  new URL("./sqlite/032-sync-maintenance.sql", import.meta.url),
  "utf8",
);
export const maintenanceChecksum = createHash("sha256")
  .update(maintenanceSql)
  .digest("hex");
export const accessTokenSql = readFileSync(
  new URL("./sqlite/033-access-tokens.sql", import.meta.url),
  "utf8",
);
export const accessTokenChecksum = createHash("sha256")
  .update(accessTokenSql)
  .digest("hex");
const migrations = [
  { version: 30, sql: syncSql, checksum: syncChecksum },
  { version: 31, sql: keySql, checksum: keyChecksum },
  { version: 32, sql: maintenanceSql, checksum: maintenanceChecksum },
  { version: 33, sql: accessTokenSql, checksum: accessTokenChecksum },
];

// Read the released v29 definition, never the current application's initializer.
// Checking the actual shape prevents a mislabeled/partially converted DB from
// being accepted merely because PRAGMA user_version has the expected integer.
let baselineObjects;
function schemaObjects(db) {
  return db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}
function normalized(sql) {
  return sql.replace(/\s+/g, " ").trim();
}
export function assertSqliteBaseline(db) {
  if (!baselineObjects) {
    const reference = new DatabaseSync(":memory:");
    try {
      reference.exec(baseSql);
      baselineObjects = schemaObjects(reference);
    } finally {
      reference.close();
    }
  }
  const actual = new Map(
    schemaObjects(db).map((row) => [
      `${row.type}:${row.name}`,
      normalized(row.sql),
    ]),
  );
  for (const row of baselineObjects)
    if (actual.get(`${row.type}:${row.name}`) !== normalized(row.sql))
      throw new Error(
        `Unsupported SQLite schema: ${row.name} differs from released v29; data preserved`,
      );
}

export function sqliteVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}
export function assertSqliteHistory(db, { version = SQLITE_VERSION } = {}) {
  if (![30, 31, 32, 33].includes(version) || sqliteVersion(db) !== version)
    throw new Error(
      "DB migration required: npm run migrate -- --engine sqlite --database /absolute/path.sqlite",
    );
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get()
  )
    throw new Error("SQLite migration history missing");
  const rows = db
    .prepare("SELECT version,checksum FROM schema_migrations ORDER BY version")
    .all();
  const expected = migrations.filter((m) => m.version <= version);
  if (
    rows.length !== expected.length ||
    rows.some((row, i) => row.version !== expected[i].version)
  )
    throw new Error("Unsupported or incomplete SQLite migration history");
  if (rows.some((row, i) => row.checksum !== expected[i].checksum))
    throw new Error("SQLite migration checksum mismatch");
}
export function assertSqliteIntegrity(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("SQLite integrity/foreign key check failed");
}
export function migrateSqlite(
  db,
  { dryRun = false, initialize = false, afterDdl } = {},
) {
  const from = sqliteVersion(db);
  if (from === SQLITE_VERSION) {
    assertSqliteHistory(db);
    assertSqliteIntegrity(db);
    return { from, to: from, applied: false };
  }
  if (![0, 29, 30, 31, 32].includes(from))
    throw new Error(`Unsupported SQLite version ${from}; data preserved`);
  if (from === 0) {
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all().length
    )
      throw new Error(
        "Version 0 database contains tables; refusing initialization",
      );
    if (!initialize) throw new Error("Empty database requires --initialize");
  }
  if (from === 29) assertSqliteBaseline(db);
  if (from >= 30) assertSqliteHistory(db, { version: from });
  assertSqliteIntegrity(db);
  if (dryRun) {
    assertSqliteIntegrity(db);
    return {
      from,
      to: SQLITE_VERSION,
      applied: false,
      dryRun: true,
      checksum: accessTokenChecksum,
    };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Recheck under the exclusive writer boundary; concurrent invocations never duplicate a migration.
    if (sqliteVersion(db) !== from)
      throw new Error("Database changed during migration; retry");
    if (from === 0) db.exec(baseSql);
    for (const migration of migrations.filter((m) => m.version > from)) {
      db.exec(migration.sql);
      const hook = afterDdl?.(migration.version);
      if (hook && typeof hook.then === "function")
        throw new Error("SQLite migration hooks must be synchronous");
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        migration.version,
        migration.checksum,
        new Date().toISOString(),
      );
      db.exec(`PRAGMA user_version=${migration.version}`);
    }
    assertSqliteIntegrity(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    from,
    to: SQLITE_VERSION,
    applied: true,
    checksum: accessTokenChecksum,
  };
}
