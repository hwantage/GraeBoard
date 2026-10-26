import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  baseSql,
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

test("v29 → v30 preserves all legacy rows, identities, revisions and references; new installation has the identical schema", () => {
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
  for (const version of [0, 28, 31]) {
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
    assert.equal(JSON.parse(result.stdout).to, 30);
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
