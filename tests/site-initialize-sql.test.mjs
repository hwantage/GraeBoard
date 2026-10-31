import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  migratePostgres,
  postgresMigrations,
  siteKeyMigration,
  teamMaintenanceMigration,
  accessTokenMigrations,
} from "../server/migrations/postgres.mjs";
import { siteInitializeSql } from "../server/migrations/site-initialize-sql.mjs";

const schemas = "('graeboard','graeboard_site')";
// Everything a migration defines, without ownership or timestamps.
async function snapshot(pool) {
  const rows = async (sql) => (await pool.query(sql)).rows;
  return {
    columns: await rows(
      `SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema IN ${schemas} ORDER BY 1,2,ordinal_position`,
    ),
    indexes: await rows(
      `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ${schemas} ORDER BY 1,2,3`,
    ),
    constraints: await rows(
      `SELECT n.nspname,c.conrelid::regclass::text AS relation,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ${schemas} ORDER BY 1,2,3`,
    ),
    triggers: await rows(
      `SELECT event_object_schema,event_object_table,trigger_name,event_manipulation,action_statement FROM information_schema.triggers WHERE event_object_schema IN ${schemas} ORDER BY 1,2,3,4`,
    ),
    functions: await rows(
      `SELECT n.nspname,p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ${schemas} ORDER BY 1,2,3`,
    ),
    sequences: await rows(
      `SELECT sequence_schema,sequence_name,data_type,start_value,increment FROM information_schema.sequences WHERE sequence_schema IN ${schemas} ORDER BY 1,2`,
    ),
    history: await rows(
      "SELECT scope,version,checksum FROM graeboard_site.schema_migrations UNION ALL SELECT scope,version,checksum FROM graeboard.schema_migrations ORDER BY 1,2",
    ),
    data: {
      teams: await rows("SELECT id,name,settings FROM graeboard.teams"),
      team: await rows("SELECT * FROM graeboard.team_meta"),
      site: await rows("SELECT * FROM graeboard_site.site_meta"),
      control: await rows("SELECT * FROM graeboard_site.control_meta"),
    },
  };
}
const exists = async (pool, name) =>
  (await pool.query("SELECT to_regnamespace($1) AS n", [name])).rows[0].n !==
  null;

test("site initialization SQL quotes the team name and carries every released checksum", () => {
  const teamId = randomUUID(),
    sql = siteInitializeSql(teamId, "팀 '$(touch nope)'\nDROP SCHEMA x;");
  assert.throws(() => siteInitializeSql("not-a-uuid", "팀"), /team UUID/);
  assert.match(sql, /^-- GraeBoard 외부 DB 초기화 \(팀 UUID [0-9a-f-]{36}\)\n/);
  // The name only appears inside a quoted literal, never in a comment line.
  assert.match(sql, /'팀 ''\$\(touch nope\)''\nDROP SCHEMA x;'/);
  assert.doesNotMatch(sql.split("\n")[0], /팀 '/);
  for (const migration of [
    postgresMigrations.site,
    postgresMigrations.team,
    siteKeyMigration,
    accessTokenMigrations.site,
    teamMaintenanceMigration,
  ])
    assert.ok(sql.includes(`'${migration.checksum}'`));
  assert.match(sql, /\nBEGIN;\n[\s\S]*\nCOMMIT;\n/);
});

test("actual PostgreSQL: SQL Editor initialization equals the migrate command, refuses non-empty schemas and rolls back failures", async (t) => {
  const bin = process.env.TEST_PG_BIN;
  if (!bin || !existsSync(join(bin, "postgres"))) {
    t.skip("Set TEST_PG_BIN for actual PostgreSQL initialization");
    return;
  }
  const dir = mkdtempSync("/tmp/gb-site-init-"),
    data = join(dir, "pg"),
    pools = [];
  let started = false;
  const cmd = (name, args) => {
    const r = spawnSync(join(bin, name), args, {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
  };
  t.after(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (started) cmd("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });
  cmd("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  cmd("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-F -h '' -k ${dir} -p 5432`,
    "-w",
    "start",
  ]);
  started = true;
  const open = (database) => {
    const pool = new Pool({
      connectionString: `postgresql://${encodeURIComponent(process.env.USER)}@localhost/${database}?host=${encodeURIComponent(dir)}&port=5432`,
    });
    pools.push(pool);
    return pool;
  };
  const root = open("postgres");
  for (const name of ["cli", "editor", "broken"])
    await root.query(`CREATE DATABASE ${name}`);
  // Supabase-like roles; anon would receive new tables by default privilege.
  await root.query("CREATE ROLE anon NOLOGIN");
  await root.query("CREATE ROLE authenticated NOLOGIN");
  await root.query("CREATE ROLE graeboard_app LOGIN");
  const teamId = randomUUID(),
    teamName = "팀 'A'",
    script = siteInitializeSql(teamId, teamName);
  const cli = open("cli"),
    editor = open("editor"),
    broken = open("broken");
  await migratePostgres(cli, {
    scope: "site",
    teamId,
    teamName,
    initialize: true,
  });

  await editor.query("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon");
  const results = await editor.query(script);
  assert.deepEqual(results.at(-1).rows, [
    { team_uuid: teamId, site_version: 3, team_version: 2 },
  ]);
  assert.deepEqual(await snapshot(editor), await snapshot(cli));
  for (const { applied_at } of (
    await editor.query(
      "SELECT applied_at FROM graeboard_site.schema_migrations UNION ALL SELECT applied_at FROM graeboard.schema_migrations",
    )
  ).rows)
    assert.match(applied_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // The migrate command recognizes the result as current and changes nothing.
  assert.deepEqual(
    await migratePostgres(editor, { scope: "site", teamId, dryRun: true }),
    {
      engine: "postgres",
      scope: "site",
      from: 3,
      to: 3,
      applied: false,
      dryRun: true,
      teamFrom: 2,
      teamTo: 2,
    },
  );
  const privilege = async (role) =>
    (
      await editor.query(
        "SELECT has_schema_privilege($1,'graeboard','USAGE') AS schema, has_table_privilege($1,'graeboard.teams','SELECT') AS teams",
        [role],
      )
    ).rows[0];
  assert.deepEqual(await privilege("anon"), { schema: false, teams: false });
  assert.deepEqual(await privilege("graeboard_app"), {
    schema: true,
    teams: true,
  });

  // A second run is refused before any change.
  const before = await snapshot(editor);
  const client = await editor.connect();
  try {
    await assert.rejects(client.query(script), /이미 테이블이 있어/);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.deepEqual(await snapshot(editor), before);

  // A failure after the guard leaves neither schema behind.
  await broken.query("CREATE SCHEMA graeboard");
  await broken.query("CREATE TYPE graeboard.teams AS (id integer)");
  const failing = await broken.connect();
  try {
    await assert.rejects(failing.query(script), /already exists/);
    await failing.query("ROLLBACK");
  } finally {
    failing.release();
  }
  assert.equal(await exists(broken, "graeboard_site"), false);
  assert.equal(
    (await broken.query("SELECT to_regclass('graeboard.schema_migrations') r"))
      .rows[0].r,
    null,
  );
});
