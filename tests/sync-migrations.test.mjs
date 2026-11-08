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
  accessTokenSql,
  accessTokenChecksum,
  maintenanceSql,
  sheetCloneChecksum,
} from "../server/migrations/sqlite.mjs";
import { sqliteSheetCloneConversion } from "../tools/sheet-clone-cutover/convert.mjs";
import { runCutover } from "../tools/sheet-clone-cutover/cutover.mjs";

// v34 converts what the rows store; these legacy rows hold no earlier name
// besides the copy tables themselves, so every row survives as it was.
const convert = sqliteSheetCloneConversion({ now: "2026-11-08T00:00:00.000Z" });
const RENAMED = {
  reports: "sheet_clones",
  report_documents: "sheet_clone_documents",
  report_memos: "sheet_clone_memos",
};
// node:sqlite rows have no prototype; a renamed column keeps its position.
const renamed = (table, rows) =>
  RENAMED[table]
    ? rows.map((row) =>
        Object.assign(
          Object.create(null),
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key === "report_id" ? "sheet_clone_id" : key,
              value,
            ]),
          ),
        ),
      )
    : rows;
const preserved = (after, before, skip = []) => {
  for (const [table, rows] of Object.entries(before))
    if (!skip.includes(table))
      assert.deepEqual(
        after[RENAMED[table] || table],
        renamed(table, rows),
        table,
      );
};

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

test("v29 → v34 preserves all legacy rows, identities, revisions and references; new installation has the identical schema", () => {
  const upgraded = legacy(),
    fresh = new DatabaseSync(":memory:");
  try {
    const before = contents(upgraded);
    assert.deepEqual(
      migrateSqlite(upgraded, { dryRun: true, convert }).applied,
      false,
    );
    assert.equal(sqliteVersion(upgraded), 29);
    assert.deepEqual(contents(upgraded), before);
    assert.throws(
      () => migrateSqlite(upgraded),
      /renames stored sheet clone data; convert an existing database with the SheetClone cutover tool/,
    );
    assert.deepEqual(contents(upgraded), before);
    assert.equal(migrateSqlite(upgraded, { convert }).applied, true);
    const after = contents(upgraded);
    preserved(after, before);
    for (const table of Object.keys(RENAMED))
      assert.equal(after[table], undefined);
    assertSqliteHistory(upgraded);
    assertSqliteIntegrity(upgraded);
    assert.equal(migrateSqlite(upgraded, { convert }).applied, false);
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
          convert,
          afterDdl() {
            throw new Error("injected crash before history");
          },
        }),
      /injected crash/,
    );
    assert.equal(sqliteVersion(db), 29);
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), previousSchema);
    // An interruption after the v34 conversion keeps v33 and every row.
    assert.throws(
      () =>
        migrateSqlite(db, {
          convert,
          afterDdl(version) {
            if (version === 34) throw new Error("interrupted34");
          },
        }),
      /interrupted34/,
    );
    assert.equal(sqliteVersion(db), 29);
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), previousSchema);
    assert.equal(migrateSqlite(db, { convert }).applied, true);
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
    assert.throws(
      () => migrateSqlite(db, { convert }),
      /Unsupported SQLite schema/,
    );
    assert.equal(sqliteVersion(db), 29);
  } finally {
    db.close();
  }
  const migrated = legacy();
  try {
    migrateSqlite(migrated, { convert });
    migrated.exec("UPDATE schema_migrations SET checksum='tampered'");
    assert.throws(
      () => migrateSqlite(migrated, { convert }),
      /checksum mismatch/,
    );
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
    assert.throws(
      () => migrateSqlite(db, { convert }),
      /integrity\/foreign key/,
    );
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

test("CLI dry-run preserves original bytes and never creates a missing target; an existing earlier database is left to the cutover tool", () => {
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
    for (const args of [["--dry-run"], []]) {
      const result = run("--database", path, ...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /SheetClone cutover tool/);
      assert.deepEqual(readFileSync(path), bytes);
    }
    let result = run("--database", missing, "--initialize", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(missing), false);
    result = run("--db", missing, "--initialize");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).to, SQLITE_VERSION);
    result = run("--database", missing);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("released v30 upgrades atomically to v34, retaining the original migration checksum and all rows", () => {
  const db = legacy();
  try {
    db.exec(syncSql);
    db.prepare("INSERT INTO schema_migrations VALUES(30,?,?)").run(
      syncChecksum,
      "original-time",
    );
    db.exec("PRAGMA user_version=30");
    const before = contents(db);
    assert.equal(
      migrateSqlite(db, { dryRun: true, convert }).to,
      SQLITE_VERSION,
    );
    assert.deepEqual(contents(db), before);
    assert.throws(
      () =>
        migrateSqlite(db, {
          convert,
          afterDdl(version) {
            if (version === 31) throw new Error("interrupted31");
          },
        }),
      /interrupted31/,
    );
    assert.equal(sqliteVersion(db), 30);
    assert.deepEqual(contents(db), before);
    migrateSqlite(db, { convert });
    preserved(contents(db), before, ["schema_migrations"]);
    assert.deepEqual(
      db.prepare("SELECT * FROM schema_migrations WHERE version=30").get(),
      before.schema_migrations[0],
    );
    assertSqliteHistory(db);
    assertSqliteIntegrity(db);
    assert.equal(migrateSqlite(db, { convert }).applied, false);
  } finally {
    db.close();
  }
});

test("released v33 upgrades to v34 with every earlier checksum kept; an interrupted conversion keeps v33", () => {
  const db = legacy();
  try {
    db.exec(syncSql);
    db.exec(keySql);
    db.exec(maintenanceSql);
    db.exec(accessTokenSql);
    for (const [version, checksum] of [
      [30, syncChecksum],
      [31, keyChecksum],
      [32, maintenanceChecksum],
      [33, accessTokenChecksum],
    ])
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        version,
        checksum,
        "original" + version,
      );
    db.exec("PRAGMA user_version=33");
    const before = contents(db),
      shapeBefore = shape(db);
    assert.throws(
      () =>
        migrateSqlite(db, {
          convert: (connection) => {
            convert(connection);
            throw new Error("interrupted conversion");
          },
        }),
      /interrupted conversion/,
    );
    assert.equal(sqliteVersion(db), 33);
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), shapeBefore);
    assert.equal(migrateSqlite(db, { convert }).applied, true);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM schema_migrations WHERE version<34 ORDER BY version",
        )
        .all(),
      before.schema_migrations,
    );
    assert.equal(
      db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=34")
        .get().checksum,
      sheetCloneChecksum,
    );
    preserved(contents(db), before, ["schema_migrations"]);
    assert.match(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name='sheet_clone_memos'")
        .get().sql,
      /REFERENCES "sheet_clones"\(id\)/,
    );
    assertSqliteIntegrity(db);
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
          convert,
          afterDdl(version) {
            if (version === 32) throw new Error("interrupted32");
          },
        }),
      /interrupted32/,
    );
    assert.deepEqual(contents(db), before);
    assert.deepEqual(shape(db), shapeBefore);
    assert.equal(sqliteVersion(db), 31);
    migrateSqlite(db, { convert });
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

test("v31 startup preserves the database and directs operators to the cutover tool before booting v34", () => {
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
        assert.match(error.message, /npm run cutover:sheet-clone/);
        assert.doesNotMatch(error.message, /지원하는 변환 경로가 없/);
        return true;
      },
    );
    assert.deepEqual(readFileSync(path), bytes);
    const migrated = spawnSync(
      process.execPath,
      ["tools/sheet-clone-cutover/cli.mjs", "--database", path],
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
    preserved(contents(db), before, ["schema_migrations"]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an installation that never shared history converts its SQLite database alone from each of v29-v33 through the cutover tool", async () => {
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      ["tools/sheet-clone-cutover/cli.mjs", "--database", ...args],
      { encoding: "utf8" },
    );
  const released = [
    [30, syncSql, syncChecksum],
    [31, keySql, keyChecksum],
    [32, maintenanceSql, maintenanceChecksum],
    [33, accessTokenSql, accessTokenChecksum],
  ];
  // The legacy rows at a released version, as that release left them.
  const at = (path, version, { history = true } = {}) => {
    const db = legacy(path);
    for (const [v, sql, checksum] of released.filter(([v]) => v <= version)) {
      db.exec(sql);
      if (history)
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
          v,
          checksum,
          "released" + v,
        );
    }
    if (!history && version >= 30) db.exec("DROP TABLE schema_migrations");
    db.exec(`PRAGMA user_version=${version}`);
    return db;
  };
  const dir = mkdtempSync(join(tmpdir(), "graeboard-cutover-internal-"));
  try {
    for (const version of [29, 30, 31, 32, 33]) {
      const path = join(dir, `v${version}.sqlite`);
      let db = at(path, version);
      const before = contents(db);
      db.close();
      const bytes = readFileSync(path);
      // The preview converts a copy and writes nothing.
      const preview = cli(path, "--dry-run");
      assert.equal(preview.status, 0, preview.stderr);
      const planned = JSON.parse(preview.stdout);
      assert.deepEqual(
        [planned.from, planned.to, planned.applied, planned.dryRun],
        [version, SQLITE_VERSION, false, true],
        `v${version}`,
      );
      assert.deepEqual(readFileSync(path), bytes, `v${version}`);
      const applied = cli(path);
      assert.equal(applied.status, 0, applied.stderr);
      const result = JSON.parse(applied.stdout);
      assert.deepEqual(
        [result.from, result.to, result.applied, result.checksum],
        [version, SQLITE_VERSION, true, sheetCloneChecksum],
        `v${version}`,
      );
      db = new DatabaseSync(path, { readOnly: true });
      assertSqliteHistory(db);
      assertSqliteIntegrity(db);
      preserved(contents(db), before, ["schema_migrations"]);
      db.close();
      // A rerun validates the converted database and changes nothing.
      const converted = readFileSync(path),
        rerun = cli(path);
      assert.equal(rerun.status, 0, rerun.stderr);
      const again = JSON.parse(rerun.stdout);
      assert.deepEqual(
        [again.from, again.to, again.applied],
        [SQLITE_VERSION, SQLITE_VERSION, false],
      );
      assert.deepEqual(readFileSync(path), converted);
    }

    // Refused before anything is read or written.
    const refused = (path, pattern) => {
      const bytes = readFileSync(path);
      for (const args of [[path, "--dry-run"], [path]]) {
        const run = cli(...args);
        assert.equal(run.status, 1, run.stdout);
        assert.match(run.stderr, pattern);
      }
      assert.deepEqual(readFileSync(path), bytes);
    };
    // An already converted database whose recorded history differs is
    // reported by its checks, not by its version number.
    const tampered = join(dir, "v31.sqlite");
    let db = new DatabaseSync(tampered);
    db.prepare(
      "UPDATE schema_migrations SET checksum='x' WHERE version=34",
    ).run();
    db.close();
    refused(tampered, /SQLite migration checksum mismatch/);
    const future = join(dir, "future.sqlite");
    db = at(future, 33);
    db.exec("PRAGMA user_version=35");
    db.close();
    refused(future, /Unsupported SQLite version 35; data preserved/);
    // Labelled v31 without the history a released v31 has.
    const unlabelled = join(dir, "unlabelled.sqlite");
    at(unlabelled, 31, { history: false }).close();
    refused(unlabelled, /SQLite migration history missing/);
    // A team with shared history needs the whole cutover.
    const shared = join(dir, "shared.sqlite");
    db = at(shared, 33);
    db.prepare(
      "INSERT INTO team_sync_links(team_id,repo_id,bootstrap_id,installation_id,writer_epoch,profile_id,mode,canonical_head,updated_at) VALUES('team','repo','boot','site','epoch','profile','paused',?,'2026-01-01')",
    ).run("a".repeat(40));
    db.close();
    refused(
      shared,
      /teams with shared history \(team\) need the whole cutover/,
    );
    // And a v29 database has no team to cut over with Git.
    const v29 = join(dir, "v29-whole.sqlite");
    at(v29, 29).close();
    await assert.rejects(
      runCutover({ teamId: "team", sqlitePath: v29, dryRun: true }),
      /a v29 database has no synchronization history; convert it with --database alone/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
