import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import {
  openDatabase,
  insertTask,
  userWithTeams,
  json,
  getTask,
} from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import {
  DEFAULT_SETTINGS,
  sampleProperties,
  defaultView,
} from "../shared/domain.js";
import { encodeReport } from "../server/reports.mjs";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { PostgresDocumentRepository } from "../server/storage/postgres-documents.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { RequestContext } from "../worker/control.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { materialize } from "../worker/materialize.mjs";
import { canonical, emptyState } from "../server/sync/protocol.mjs";

export function sqliteFixture(t, { documents = true } = {}) {
  const dir = mkdtempSync("/tmp/gb-document-contract-"),
    db = openDatabase(join(dir, "data.sqlite")),
    teamId = randomUUID(),
    userId = randomUUID(),
    adapter = new SqliteDatabase(db),
    stamp = new Date().toISOString();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Repository contract",
    json({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "contract@example.test", "Contract", stamp);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(userId).digest("hex"),
    userId,
    Date.now() + 600000,
  );
  const task = insertTask(db, {
      teamId,
      year: 2026,
      actorId: userId,
      fields: { title: "initial", description: "second", owner: userId },
    }),
    reportId = randomUUID(),
    entryId = randomUUID(),
    link = {
      team_id: teamId,
      repo_id: randomUUID(),
      bootstrap_id: randomUUID(),
      installation_id: randomUUID(),
      writer_epoch: randomUUID(),
      profile_id: "contract",
      mode: "paused",
      canonical_head: "a".repeat(40),
      updated_at: stamp,
    },
    state = emptyState();
  if (documents) {
    db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
      reportId,
      teamId,
      2026,
      "Contract report",
      "2026-10-01",
      userId,
      stamp,
      encodeReport({
        settings: DEFAULT_SETTINGS,
        view: defaultView(2026),
        users: [{ id: userId, name: "Contract" }],
        tasks: [getTask(db, task.id)],
      }),
    );
    db.prepare(
      "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,title,updated_at,actor_id) VALUES(?,?,?,'2026-10-01','2026-10-01','Contract calendar',?,?)",
    ).run(entryId, teamId, userId, stamp, userId);
  }
  state.entities = allEntities(db, link);
  adapter.withTeamTransaction(teamId, (tx) => {
    const { team_id, ...fields } = link;
    tx.sync.writeLink(fields);
    tx.sync.writeState(state, link.canonical_head);
  });
  const user = userWithTeams(
      db,
      db.prepare("SELECT * FROM users WHERE id=?").get(userId),
    ),
    app = createApp({
      db,
      rateLimits: false,
      syncOptions: { schedule: false, installationId: link.installation_id },
    });
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    db,
    adapter,
    app,
    user,
    teamId,
    taskId: task.id,
    reportId,
    entryId,
    link,
    state,
  };
}

export async function postgresFixture(t, providedFixture) {
  const bin = process.env.TEST_PG_BIN;
  if (!bin || !existsSync(join(bin, "postgres"))) {
    t.skip("Set TEST_PG_BIN for actual PostgreSQL document contract");
    return;
  }
  const f = providedFixture || sqliteFixture(t),
    dir = mkdtempSync("/tmp/gb-document-pg-"),
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
  const url = (database) =>
      `postgresql://${encodeURIComponent(process.env.USER)}@localhost/${database}?host=${encodeURIComponent(dir)}&port=5432`,
    root = new Pool({ connectionString: url("postgres") });
  pools.push(root);
  await root.query("CREATE DATABASE control");
  await root.query("CREATE DATABASE team");
  const control = new Pool({ connectionString: url("control") }),
    pool = new Pool({ connectionString: url("team") });
  pools.push(control, pool);
  await migratePostgres(control, { scope: "control", initialize: true });
  await migratePostgres(pool, {
    scope: "team",
    teamId: f.teamId,
    initialize: true,
  });
  await control.query(
    "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,'contract@example.test','contract@example.test','Contract','admin',$2)",
    [f.user.id, new Date().toISOString()],
  );
  await control.query(
    "INSERT INTO graeboard.teams(id,name,profile_id,status) VALUES($1,'Contract','contract','active')",
    [f.teamId],
  );
  await control.query(
    "INSERT INTO graeboard.memberships VALUES($1,$2,'lead')",
    [f.user.id, f.teamId],
  );
  const adapter = new PostgresDatabase(pool, { teamId: f.teamId });
  await adapter.withTeamTransaction(f.teamId, async (tx) => {
    const { team_id, ...fields } = f.link;
    await tx.sync.writeLink(fields);
    await tx.sync.writeState(f.state, f.link.canonical_head);
    for (const record of Object.values(f.state.entities)) {
      await tx.query("INSERT INTO site_entities VALUES($1,$2,$3,$4,1,0)", [
        f.teamId,
        record.entity,
        canonical(record.key),
        canonical(record.payload),
      ]);
      await tx.query("INSERT INTO site_entity_revisions VALUES($1,$2,$3,1)", [
        f.teamId,
        record.entity,
        canonical(record.key),
      ]);
    }
  });
  const env = {
    PG_CONTROL: { connectionString: url("control") },
    PG_TEAM: { connectionString: url("team") },
    BUCKET: {},
    TOKEN: "synthetic-contract-token",
    SYNC_PROFILES: JSON.stringify([
      {
        profileId: "contract",
        teamId: f.teamId,
        repository: "example/private",
        databaseBinding: "PG_TEAM",
        bucketBinding: "BUCKET",
        githubSecret: "TOKEN",
      },
    ]),
  };
  const makeRepository = (user) =>
    new PostgresDocumentRepository({
      context: new RequestContext(
        env,
        user,
        {},
        new Request("https://example.test/api/documents"),
        { waitUntil() {} },
      ),
    });
  return {
    ...f,
    pool,
    control,
    adapter,
    makeRepository,
    env,
    makeContext: (
      user = f.user,
      request = new Request("https://example.test/api/business"),
    ) => new RequestContext(env, user, {}, request, { waitUntil() {} }),
    createContext: (
      user = f.user,
      request = new Request("https://example.test/api/business"),
    ) => new RequestContext(env, user, {}, request, { waitUntil() {} }),
  };
}

// Stable shared fixture API: no report/calendar seeds unless explicitly requested.
export const sqliteBusinessFixture = (t) =>
  sqliteFixture(t, { documents: false });
export const postgresBusinessFixture = (t, fixture) =>
  postgresFixture(t, fixture);
