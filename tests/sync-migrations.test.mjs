import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../server/db.mjs";
import {
  SQLITE_VERSION,
  keySql,
  keyChecksum,
  maintenanceChecksum,
  baseSql,
  syncSql,
  syncChecksum,
  migrateSqlite,
  assertSqliteHistory,
  assertSqliteIntegrity,
  sqliteVersion,
} from "../server/migrations/sqlite.mjs";

function legacy(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(baseSql);
  db.exec(`
    INSERT INTO teams VALUES('team','기존 팀','{"revision":8}');
    INSERT INTO users(id,username,name,password,system_role,created_at) VALUES('person','existing@example.test','기존 사용자','preserved-password-hash','admin','2026-01-01');
    INSERT INTO memberships VALUES('person','team','lead');
    INSERT INTO sessions VALUES('preserved-session','person',1893456000000);
    INSERT INTO styles VALUES(1,'{"bg":"#abcdef"}');
    INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES('task','team','[2025,2026]',2.5,'person','2026-01-01','2026-10-01');
    INSERT INTO cells VALUES('task','title','"보존할 업무 🙂"',1,14);
    INSERT INTO document_versions VALUES('version','team','main','content-hash','# 보존 본문','1','2026-01-01','person');
    INSERT INTO task_documents(task_id,version_id,has_content,revision,updated_at,actor_id) VALUES('task','version',1,12,'2026-10-01','person');
    INSERT INTO annual_memos VALUES('team',2026,'memo','메모',0,'version',1,6,'2026-01-01','person','memo-op','hash');
    INSERT INTO reports VALUES('report','team',2026,'보존 사본','2026-01-01','person','2026-01-01',X'1f8b0800000000000003');
    INSERT INTO report_documents VALUES('report','task','main','version');
    INSERT INTO report_memos VALUES('report','memo','메모',0,'version',1,6,'2026-01-01','person',NULL,NULL);
    INSERT INTO saved_filters VALUES('filter','team','team',NULL,'공용','{}','2026-01-01');
    INSERT INTO views VALUES('view','person','team',2026,'__current','{}','2026-01-01');
    INSERT INTO filter_states VALUES('person','team','filter','{}');
    INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,title,revision,updated_at,actor_id,version_id) VALUES('event','team','person','2026-10-01','2026-10-02','보존 일정',7,'2026-01-01','person','version');
    INSERT INTO calendar_tags(id,team_id,user_id,name,color,kind) VALUES('tag','team','person','확인','mint','check');
    INSERT INTO calendar_entry_tags VALUES('event','tag',0,1);
    INSERT INTO calendar_weekly_items VALUES('team','person','2026-09-27','task','보존 업무','2026-01-01');
    INSERT INTO audit VALUES('audit','team','person','edit','task','{}','{}','2026-01-01');
    INSERT INTO operations VALUES('api-operation','person','{}','2026-01-01');
  `);
  return db;
}
function contents(db) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  return Object.fromEntries(
    names.map((name) => [
      name,
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}
function shape(db) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}

test("v29 → v32 preserves all legacy rows, identities, revisions and references; new installation has the identical schema", () => {
  const upgraded = legacy(),
    fresh = new DatabaseSync(":memory:");
  try {
    const before = contents(upgraded);
    assert.deepEqual(migrateSqlite(upgraded, { dryRun: true }).applied, false);
    assert.equal(sqliteVersion(upgraded), 29);
    assert.deepEqual(contents(upgraded), before);
    assert.equal(migrateSqlite(upgraded).applied, true);
    const after = contents(upgraded);
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(after[table], rows, table);
    assertSqliteHistory(upgraded);
    assertSqliteIntegrity(upgraded);
    assert.equal(migrateSqlite(upgraded).applied, false);
    migrateSqlite(fresh, { initialize: true });
    assert.deepEqual(shape(fresh), shape(upgraded));
  } finally {
    upgraded.close();
    fresh.close();
  }
});

test("migration DDL/history/version roll back together and the same migration can be retried", () => {
  const db = legacy();
  try {
    const before = contents(db),
      previousSchema = shape(db);
    assert.throws(
      () =>
        migrateSqlite(db, {
          afterDdl() {
            throw new Error("injected crash before history");
          },
        }),
      /injected crash/,
    );
    assert.equal(sqliteVersion(db), 29);
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), previousSchema);
    assert.equal(migrateSqlite(db).applied, true);
    assertSqliteHistory(db);
  } finally {
    db.close();
  }
});

test("unsupported versions, occupied version zero, malformed v29 and altered history are rejected without resetting data", () => {
  for (const version of [0, 28, SQLITE_VERSION + 1]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE irreplaceable(value TEXT); INSERT INTO irreplaceable VALUES('keep'); PRAGMA user_version=${version}`,
      );
      assert.throws(
        () => migrateSqlite(db, { initialize: true }),
        /Unsupported|contains tables/,
      );
      assert.equal(
        db.prepare("SELECT value FROM irreplaceable").get().value,
        "keep",
      );
    } finally {
      db.close();
    }
  }
  const db = legacy();
  try {
    db.exec("DROP TABLE calendar_preferences");
    assert.throws(() => migrateSqlite(db), /Unsupported SQLite schema/);
    assert.equal(sqliteVersion(db), 29);
  } finally {
    db.close();
  }
  const migrated = legacy();
  try {
    migrateSqlite(migrated);
    migrated.exec("UPDATE schema_migrations SET checksum='tampered'");
    assert.throws(() => migrateSqlite(migrated), /checksum mismatch/);
    assert.equal(
      migrated.prepare("SELECT version FROM cells").get().version,
      14,
    );
  } finally {
    migrated.close();
  }
});

test("integrity failures are refused before conversion and empty initialization is explicit", () => {
  const db = legacy();
  try {
    db.exec("PRAGMA foreign_keys=OFF; DELETE FROM users WHERE id='person'");
    assert.throws(() => migrateSqlite(db), /integrity\/foreign key/);
    assert.equal(sqliteVersion(db), 29);
  } finally {
    db.close();
  }
  const empty = new DatabaseSync(":memory:");
  try {
    assert.throws(() => migrateSqlite(empty), /requires --initialize/);
  } finally {
    empty.close();
  }
});

test("CLI dry-run preserves original bytes and never creates a missing target; explicit target conversion is executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-migration-"));
  const path = join(dir, "legacy.sqlite"),
    missing = join(dir, "new.sqlite");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ["scripts/migrate.mjs", "--engine", "sqlite", ...args],
      { encoding: "utf8" },
    );
  try {
    legacy(path).close();
    const bytes = readFileSync(path);
    let result = run("--database", path, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(path), bytes);
    result = run("--database", missing, "--initialize", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(missing), false);
    result = run("--db", path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).to, SQLITE_VERSION);
    result = run("--database", path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT value FROM cells").get().value,
        '"보존할 업무 🙂"',
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("released v30 upgrades atomically to v32, retaining the original migration checksum and all rows", () => {
  const db = legacy();
  try {
    db.exec(syncSql);
    db.prepare("INSERT INTO schema_migrations VALUES(30,?,?)").run(
      syncChecksum,
      "original-time",
    );
    db.exec("PRAGMA user_version=30");
    const before = contents(db);
    assert.equal(migrateSqlite(db, { dryRun: true }).to, SQLITE_VERSION);
    assert.deepEqual(contents(db), before);
    assert.throws(
      () =>
        migrateSqlite(db, {
          afterDdl(version) {
            if (version === 31) throw new Error("interrupted31");
          },
        }),
      /interrupted31/,
    );
    assert.equal(sqliteVersion(db), 30);
    assert.deepEqual(contents(db), before);
    migrateSqlite(db);
    for (const [table, rows] of Object.entries(before))
      if (table !== "schema_migrations")
        assert.deepEqual(contents(db)[table], rows, table);
    assert.deepEqual(
      db.prepare("SELECT * FROM schema_migrations WHERE version=30").get(),
      before.schema_migrations[0],
    );
    assertSqliteHistory(db);
    assertSqliteIntegrity(db);
    assert.equal(migrateSqlite(db).applied, false);
  } finally {
    db.close();
  }
});

test("released v31 index upgrade preserves old checksums, rolls back DDL and uses the general sequence index", () => {
  const db = legacy();
  try {
    db.exec(syncSql);
    db.exec(keySql);
    db.prepare("INSERT INTO schema_migrations VALUES(30,?,'original30')").run(
      syncChecksum,
    );
    db.prepare("INSERT INTO schema_migrations VALUES(31,?,'original31')").run(
      keyChecksum,
    );
    db.exec("PRAGMA user_version=31");
    const before = contents(db),
      shapeBefore = shape(db);
    assert.throws(
      () =>
        migrateSqlite(db, {
          afterDdl(version) {
            if (version === 32) throw new Error("interrupted32");
          },
        }),
      /interrupted32/,
    );
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), shapeBefore);
    assert.equal(sqliteVersion(db), 31);
    migrateSqlite(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM schema_migrations WHERE version<32 ORDER BY version",
        )
        .all(),
      before.schema_migrations,
    );
    assert.equal(
      db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=32")
        .get().checksum,
      maintenanceChecksum,
    );
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT local_seq FROM sync_outbox WHERE team_id=? ORDER BY local_seq DESC LIMIT 1",
      )
      .all("team");
    assert.match(JSON.stringify(plan), /sync_outbox_team_sequence/);
    assert.doesNotMatch(
      JSON.stringify(plan),
      /USE TEMP B-TREE|SCAN sync_outbox/,
    );
  } finally {
    db.close();
  }
});

test("v31 startup preserves the database and directs operators to the explicit migration before booting v32", () => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-v31-startup-")),
    path = join(dir, "existing.sqlite");
  let db = legacy(path);
  try {
    db.exec(syncSql);
    db.exec(keySql);
    db.prepare("INSERT INTO schema_migrations VALUES(30,?,'original30')").run(
      syncChecksum,
    );
    db.prepare("INSERT INTO schema_migrations VALUES(31,?,'original31')").run(
      keyChecksum,
    );
    db.exec("PRAGMA user_version=31");
    const before = contents(db);
    db.close();
    db = null;
    const bytes = readFileSync(path);
    assert.throws(
      () => openDatabase(path),
      (error) => {
        assert.match(error.message, /v31/);
        assert.match(
          error.message,
          /npm run migrate -- --engine sqlite --database/,
        );
        assert.doesNotMatch(error.message, /지원하는 변환 경로가 없/);
        return true;
      },
    );
    assert.deepEqual(readFileSync(path), bytes);
    const migrated = spawnSync(
      process.execPath,
      ["scripts/migrate.mjs", "--engine", "sqlite", "--database", path],
      { encoding: "utf8" },
    );
    assert.equal(migrated.status, 0, migrated.stderr);
    const { from, to, applied } = JSON.parse(migrated.stdout);
    assert.deepEqual(
      { from, to, applied },
      { from: 31, to: SQLITE_VERSION, applied: true },
    );
    db = openDatabase(path);
    assert.equal(sqliteVersion(db), SQLITE_VERSION);
    assertSqliteHistory(db);
    assertSqliteIntegrity(db);
    const after = contents(db);
    for (const [table, rows] of Object.entries(before))
      if (table !== "schema_migrations")
        assert.deepEqual(after[table], rows, table);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
