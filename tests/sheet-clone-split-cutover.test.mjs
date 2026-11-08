// The SheetClone cutover of one team whose sites cannot reach each other's
// database (tools/sheet-clone-cutover/sheet-clone-split-*.mjs): the internal
// host has the SQLite file and Git, the external host PostgreSQL and Git, and
// three small files travel between them. Each site lives in its own
// directory: the internal commands get no PostgreSQL address, the external
// ones no SQLite file or sync key. The databases and history are those the
// released f744ead code wrote (tests/fixtures/sheet-clone-legacy).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { openDatabase } from "../server/db.mjs";
import { postgresMigrations } from "../server/migrations/postgres.mjs";
import { createApp } from "../server/app.mjs";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { sealToken } from "../server/sync/credentials.mjs";
import { canonical, stateHash } from "../server/sync/protocol.mjs";
import { checkpointFiles } from "../server/sync/checkpoint.mjs";
import { decodeSnapshot } from "../server/sync/snapshot.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { createWorker } from "../worker/entry.mjs";
import { runTeam } from "../worker/sync.mjs";
import { profileFor } from "../shared/sync-profiles.js";
import { runCutover } from "../tools/sheet-clone-cutover/cutover.mjs";
import {
  applyInternal,
  prepareInternal,
} from "../tools/sheet-clone-cutover/sheet-clone-split-internal.mjs";
import {
  applyExternal,
  finalizeExternal,
  postgresTarget,
} from "../tools/sheet-clone-cutover/sheet-clone-split-external.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";

const { Pool, Client } = pg;
const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin",
  ROOT = new URL("../", import.meta.url).pathname,
  FIXTURE = new URL("./fixtures/sheet-clone-legacy/", import.meta.url),
  PRELOAD = pathToFileURL(
    new URL("./sheet-clone-split-git-fixture.mjs", import.meta.url).pathname,
  ).href,
  INTERNAL_CLI = join(
    ROOT,
    "tools/sheet-clone-cutover/sheet-clone-split-internal-cli.mjs",
  ),
  EXTERNAL_CLI = join(
    ROOT,
    "tools/sheet-clone-cutover/sheet-clone-split-external-cli.mjs",
  ),
  read = (name) => readFileSync(new URL(name, FIXTURE), "utf8"),
  manifest = JSON.parse(read("manifest.json")),
  ORIGINS = [manifest.origins.internal, manifest.origins.external].sort(),
  GITHUB = "https://github.com/fixture/team",
  { teamId } = manifest,
  { R2 } = manifest.copies,
  { T1 } = manifest.tasks,
  OUTSIDE_USER = "897806d1-39e9-4732-a768-e5f8ac7f7631";
const skip = !existsSync(join(pgBin, "initdb"));
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const ok = (result) => {
  assert.ok(result.status < 300, JSON.stringify(result));
  return result.data;
};

// Every row of every table: a refused phase must leave all of them.
function sqliteRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const value = (v) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v;
    return createHash("sha256")
      .update(
        canonical(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all()
            .map(({ name }) => [
              name,
              db
                .prepare(`SELECT * FROM "${name}"`)
                .all()
                .map((row) =>
                  Object.entries(row).map(([key, v]) => [key, value(v)]),
                ),
            ]),
        ),
      )
      .digest("hex");
  } finally {
    db.close();
  }
}
function sqlite(path, sql, ...params) {
  const db = new DatabaseSync(path);
  try {
    return /^\s*SELECT/i.test(sql)
      ? db.prepare(sql).all(...params)
      : db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
const sqliteVersion = (path) =>
  sqlite(path, "SELECT user_version v FROM pragma_user_version")[0].v;
const sqliteLink = (path) => ({
  ...sqlite(
    path,
    "SELECT mode,canonical_head,canonical_hash FROM team_sync_links WHERE team_id=?",
    teamId,
  )[0],
});
const sqliteState = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return readState(db);
  } finally {
    db.close();
  }
};
// C as stored, read here independently of the tool and the store.
function readState(db) {
  const entities = {},
    receipts = {},
    conflicts = {};
  for (const row of db
    .prepare(
      "SELECT * FROM sync_entities WHERE team_id=? ORDER BY entity,entity_key",
    )
    .all(teamId)) {
    const key = JSON.parse(row.entity_key);
    entities[JSON.stringify([row.entity, key])] = {
      entity: row.entity,
      key,
      generation: row.generation,
      version: row.version,
      payload: row.payload === null ? null : JSON.parse(row.payload),
      deleted: !!Number(row.deleted),
    };
  }
  for (const row of db
    .prepare("SELECT op_id,receipt FROM sync_receipts WHERE team_id=?")
    .all(teamId))
    receipts[row.op_id] = JSON.parse(row.receipt);
  for (const row of db
    .prepare("SELECT conflict_id,payload FROM sync_conflicts WHERE team_id=?")
    .all(teamId))
    conflicts[row.conflict_id] = JSON.parse(row.payload);
  return { entities, receipts, conflicts };
}

// The two sites of one fixture history, each in its own directory, and the
// repository both left at the recorded head.
async function sites(t, label, port) {
  const root = mkdtempSync(join(tmpdir(), "gb-split-")),
    remote = join(root, "remote.git"),
    inside = join(root, "internal"),
    outside = join(root, "external"),
    handoff = join(root, "handoff"),
    // Short: a Unix socket path has a small limit.
    socket = join(root, "s"),
    pgData = join(outside, "pg"),
    pools = [];
  for (const dir of [join(inside, "data"), socket, handoff])
    mkdirSync(dir, { recursive: true });
  let pgStarted = false;
  t.after(async () => {
    for (const pool of pools) await pool.end().catch(() => {});
    if (pgStarted)
      spawnSync(join(pgBin, "pg_ctl"), [
        "-D",
        pgData,
        "-m",
        "immediate",
        "stop",
      ]);
    rmSync(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      remote,
      "fetch",
      new URL("sync.bundle", FIXTURE).pathname,
      "refs/*:refs/*",
    ],
    { stdio: "ignore" },
  );
  const base = manifest.sync[label],
    git = (...args) =>
      execFileSync("git", ["-C", remote, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
  git("update-ref", "refs/heads/sync-v1", base.head);

  // The internal site keeps its Git token as the server stores it: sealed
  // with its sync key in the database.
  const dbPath = join(inside, "data", "weekly-plan.sqlite"),
    syncKey = randomBytes(32).toString("base64"),
    internalToken =
      "github_pat_fixtureInternal" + randomUUID().replaceAll("-", ""),
    externalToken =
      "github_pat_fixtureExternal" + randomUUID().replaceAll("-", "");
  {
    const db = new DatabaseSync(dbPath);
    db.exec(read(`internal-${label}.sql`));
    const previous = process.env.GRAEBOARD_SYNC_KEY;
    process.env.GRAEBOARD_SYNC_KEY = syncKey;
    try {
      db.prepare("INSERT INTO sync_credentials VALUES(?,?,?)").run(
        manifest.profiles.internal,
        sealToken(internalToken, manifest.profiles.internal),
        "2026-11-07T00:00:00.000Z",
      );
    } finally {
      if (previous === undefined) delete process.env.GRAEBOARD_SYNC_KEY;
      else process.env.GRAEBOARD_SYNC_KEY = previous;
    }
    db.close();
  }

  const command = (bin, args) => {
    const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  command("initdb", [
    "-D",
    pgData,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    pgData,
    "-l",
    join(outside, "pg.log"),
    "-o",
    `-k ${socket} -p ${port} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  pgStarted = true;
  const url = (name) =>
      `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=${port}`,
    pool = (name) => {
      const created = new Pool({ connectionString: url(name) });
      pools.push(created);
      return created;
    },
    admin = pool("postgres");
  const load = async (name, files) => {
    await admin.query(`CREATE DATABASE ${name}`);
    const client = new Client({ connectionString: url(name) });
    await client.connect();
    for (const file of files) await client.query(read(file));
    await client.end();
  };
  await load("control", ["external-control.sql"]);
  await load("team", [`external-team-${label}.sql`]);

  const internalJournal = join(inside, "journal"),
    externalJournal = join(outside, "journal"),
    gitDir = join(outside, "git-cache"),
    originArgs = ORIGINS.flatMap((origin) => ["--site-origin", origin]);
  // Each command as the operator runs it on that host, with that host's
  // environment only.
  const run = (cli, cwd, env, args) => {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--import", PRELOAD, cli, ...args],
      { cwd, env, encoding: "utf8", timeout: 240000 },
    );
    let output = null;
    if (r.status === 0) output = JSON.parse(r.stdout);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output };
  };
  const internalEnv = {
      PATH: process.env.PATH,
      GRAEBOARD_SYNC_PROFILES: JSON.stringify([
        {
          profileId: manifest.profiles.internal,
          teamId,
          repository: manifest.repository,
        },
      ]),
      GRAEBOARD_SYNC_DIR: join(inside, "data", "sync"),
      GRAEBOARD_SYNC_KEY: syncKey,
      SHEET_CLONE_SPLIT_TEST_REMOTE: remote,
    },
    externalEnv = (database = "team") => ({
      PATH: process.env.PATH,
      SITE_PG_URL: url(database),
      SITE_GIT_TOKEN: externalToken,
      SHEET_CLONE_SPLIT_TEST_REMOTE: remote,
    });
  const internalCli = (phase, extra, env = internalEnv) =>
      run(INTERNAL_CLI, inside, env, [
        phase,
        "--database",
        dbPath,
        "--team-id",
        teamId,
        ...originArgs,
        "--journal",
        internalJournal,
        ...extra,
      ]),
    externalCli = (
      phase,
      extra,
      { env = externalEnv(), origins = originArgs, scope = "team" } = {},
    ) =>
      run(EXTERNAL_CLI, outside, env, [
        phase,
        "--team-id",
        teamId,
        ...origins,
        "--pg-url-env",
        "SITE_PG_URL",
        "--pg-scope",
        scope,
        "--repository",
        manifest.repository,
        "--git-token-env",
        "SITE_GIT_TOKEN",
        "--git-dir",
        gitDir,
        ...extra,
      ]);
  const file = (name) => join(handoff, name);
  // The phases as functions, for interruptions the commands cannot show;
  // bound to the same journals and options as the commands.
  const internalOptions = () => ({
      sqlitePath: dbPath,
      teamId,
      origins: ORIGINS,
      journalDir: internalJournal,
      transport: new GitCliTransport({
        directory: join(inside, "data", "sync", manifest.profiles.internal),
        repository: remote,
        allowLocal: true,
      }),
      binding: {
        database: dbPath,
        teamId,
        origins: ORIGINS,
        profileId: manifest.profiles.internal,
        repository: GITHUB,
      },
    }),
    externalOptions = (team) => ({
      teamId,
      origins: ORIGINS,
      pool: team,
      pgScope: "team",
      transport: new GitCliTransport({
        directory: gitDir,
        repository: remote,
        allowLocal: true,
      }),
      journalDir: externalJournal,
      binding: {
        teamId,
        origins: ORIGINS,
        pgUrlEnv: "SITE_PG_URL",
        pgScope: "team",
        repository: GITHUB,
        gitDir,
      },
    });
  // Another writer's commit on parent (same tree).
  const foreign = (parent) => {
    const index = join(root, randomUUID() + ".index"),
      env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync("git", ["-C", remote, "read-tree", parent], { env });
    const tree = execFileSync("git", ["-C", remote, "write-tree"], {
      env,
      encoding: "utf8",
    }).trim();
    rmSync(index, { force: true });
    return execFileSync(
      "git",
      ["-C", remote, "commit-tree", tree, "-p", parent, "-m", "other writer"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "x",
          GIT_AUTHOR_EMAIL: "x@x",
          GIT_COMMITTER_NAME: "x",
          GIT_COMMITTER_EMAIL: "x@x",
        },
        encoding: "utf8",
      },
    ).trim();
  };
  return {
    root,
    remote,
    inside,
    outside,
    base,
    git,
    dbPath,
    url,
    admin,
    pool,
    load,
    team: pool("team"),
    syncKey,
    secrets: [internalToken, externalToken, syncKey, url("team")],
    internalJournal,
    externalJournal,
    internalCli,
    externalCli,
    externalEnv,
    internalEnv,
    file,
    internalOptions,
    externalOptions,
    foreign,
    head: () => git("rev-parse", "refs/heads/sync-v1"),
  };
}
const teamVersion = async (team) =>
  Number(
    (
      await team.query(
        "SELECT MAX(version) v FROM graeboard.schema_migrations WHERE scope='team'",
      )
    ).rows[0].v,
  );
const pgLink = async (team) => ({
  ...(
    await team.query(
      "SELECT mode,canonical_head,canonical_hash FROM graeboard.team_sync_links WHERE team_id=$1",
      [teamId],
    )
  ).rows[0],
});
const pgState = (team) =>
  new PostgresDatabase(team, { teamId }).readState(teamId);
const pgEntities = async (team) =>
  (
    await team.query(
      "SELECT entity,entity_key,payload FROM graeboard.sync_entities WHERE team_id=$1 ORDER BY entity,entity_key",
      [teamId],
    )
  ).rows;
const legacyNames = (state) =>
  Object.values(state.entities).filter(
    (r) =>
      r.entity.startsWith("report") ||
      (r.entity === "document" && String(r.key[0]).startsWith("report")),
  ).length;
const added = (git, oid) =>
  git("diff-tree", "--no-commit-id", "--name-only", "-r", oid)
    .split("\n")
    .filter(Boolean);
const refused = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
};

test("PostgreSQL target binding distinguishes endpoints when cluster identity is denied and never stores connection credentials", async () => {
  const pool = (host, password) => ({
    options: {
      connectionString: `postgresql://operator:${password}@${host}/team`,
    },
    query: async (sql) => {
      if (sql.includes("current_database")) return { rows: [{ name: "team" }] };
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    },
  });
  const first = await postgresTarget(
      pool("first.invalid", "fixture-secret-one"),
    ),
    second = await postgresTarget(pool("second.invalid", "fixture-secret-two"));
  assert.equal(first.system, null);
  assert.equal(first.database, second.database);
  assert.notEqual(first.endpoint, second.endpoint);
  assert.deepEqual(
    first,
    await postgresTarget(pool("first.invalid", "rotated-fixture-secret")),
  );
  assert.doesNotMatch(
    JSON.stringify([first, second]),
    /secret|invalid|operator/,
  );
});

for (const [label, from, to, port] of [
  ["v1", 1, 3, 55481],
  ["v2", 2, 4, 55482],
])
  test(
    `f744ead sync ${label}: the separate-site commands cut both sites over to protocol ${to} in four phases, repeat nothing when rerun, match the one-step cutover, and the sites then synchronize both ways`,
    { skip, timeout: 600000 },
    async (t) => {
      const s = await sites(t, label, port),
        { base, git, dbPath, team } = s;
      const historyBefore = git("rev-list", base.head),
        rowsBefore = sqliteRows(dbPath),
        entitiesBefore = await pgEntities(team),
        // A recorded hash is rewritten; protocol 1 links may record none.
        { canonical_hash: hashBefore } = await pgLink(team);
      assert.ok(
        !Object.keys(s.internalEnv).some((k) => /PG|POSTGRES/i.test(k)),
      );
      assert.ok(
        !Object.keys(s.externalEnv()).some((k) =>
          /SQLITE|DB_PATH|GRAEBOARD/i.test(k),
        ),
      );

      // 1. Internal prepare: a plan and a journal; nothing else changes.
      const prepared = s.internalCli("prepare", ["--out", s.file("plan.json")]);
      assert.equal(prepared.status, 0, prepared.stderr);
      const plan = JSON.parse(readFileSync(s.file("plan.json"), "utf8"));
      assert.deepEqual(
        {
          teamId: plan.teamId,
          baseHead: plan.baseHead,
          baseHash: plan.baseHash,
          fromProtocol: plan.fromProtocol,
          toProtocol: plan.toProtocol,
          origins: plan.origins,
          sqliteFrom: plan.sqliteFrom,
        },
        {
          teamId,
          baseHead: base.head,
          baseHash: base.hash,
          fromProtocol: from,
          toProtocol: to,
          origins: ORIGINS,
          sqliteFrom: 33,
        },
      );
      assert.notEqual(plan.resultHash, base.hash);
      assert.equal(prepared.output.resultHash, plan.resultHash);
      assert.equal(sqliteRows(dbPath), rowsBefore);
      assert.equal(await teamVersion(team), 2);
      assert.equal(s.head(), base.head);
      // The plan names identities and hashes only: no path, credential or
      // document text, and no field beyond its format.
      const planText = readFileSync(s.file("plan.json"), "utf8");
      for (const leak of [s.root, ...s.secrets, "markdown", "/links/"])
        assert.ok(!planText.includes(leak), leak);
      assert.deepEqual(Object.keys(plan).sort(), [
        "artifact",
        "baseHash",
        "baseHead",
        "bootstrapId",
        "conversion",
        "format",
        "fromProtocol",
        "migrations",
        "origins",
        "repoId",
        "resultHash",
        "sqliteFrom",
        "teamId",
        "toProtocol",
        "toolDigest",
        "version",
      ]);
      assert.equal(statSync(s.internalJournal).mode & 0o777, 0o700);
      assert.equal(
        statSync(join(s.internalJournal, "internal-journal.json")).mode & 0o777,
        0o600,
      );
      // Prepare again: the same plan, nothing else.
      const again = s.internalCli("prepare", ["--out", s.file("plan.json")]);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(again.output.planDigest, prepared.output.planDigest);

      // 2. External apply, first as a dry run (nothing written at all).
      refused(
        s.externalCli("apply", ["--plan", s.file("plan.json"), "--dry-run"], {
          scope: "site",
        }),
        /requires an existing site schema/,
      );
      assert.equal(
        (await team.query("SELECT to_regnamespace('graeboard_site') name"))
          .rows[0].name,
        null,
      );
      const dry = s.externalCli("apply", [
        "--plan",
        s.file("plan.json"),
        "--dry-run",
      ]);
      assert.equal(dry.status, 0, dry.stderr);
      assert.equal(dry.output.dryRun, true);
      assert.equal(await teamVersion(team), 2);
      assert.equal(existsSync(s.externalJournal), false);
      assert.equal(existsSync(s.file("external-ready.json")), false);
      const applyArgs = [
        "--plan",
        s.file("plan.json"),
        "--journal",
        s.externalJournal,
        "--out",
        s.file("external-ready.json"),
      ];
      const applied = s.externalCli("apply", applyArgs);
      assert.equal(applied.status, 0, applied.stderr);
      // PostgreSQL holds the planned state with its cursor still at the
      // recorded head; the internal site and Git are untouched.
      assert.equal(await teamVersion(team), 3);
      assert.deepEqual(await pgLink(team), {
        mode: "paused",
        canonical_head: base.head,
        canonical_hash: hashBefore === null ? null : plan.resultHash,
      });
      assert.equal(stateHash(await pgState(team)), plan.resultHash);
      assert.equal(legacyNames(await pgState(team)), 0);
      assert.equal(sqliteRows(dbPath), rowsBefore);
      assert.equal(sqliteVersion(dbPath), 33);
      assert.equal(s.head(), base.head);
      const ready = readFileSync(s.file("external-ready.json"), "utf8");
      const reapplied = s.externalCli("apply", applyArgs);
      assert.equal(reapplied.status, 0, reapplied.stderr);
      assert.equal(readFileSync(s.file("external-ready.json"), "utf8"), ready);
      for (const leak of [s.root, ...s.secrets])
        assert.ok(!ready.includes(leak), leak);

      // 3. Internal apply: SQLite converted, boundary and checkpoint on the
      // recorded head, the internal cursor on the checkpoint.
      const applyInside = [
        "--ready",
        s.file("external-ready.json"),
        "--out",
        s.file("internal-complete.json"),
      ];
      const inside = s.internalCli("apply", applyInside);
      assert.equal(inside.status, 0, inside.stderr);
      const checkpoint = s.head(),
        boundary = git("rev-parse", checkpoint + "^");
      assert.equal(git("rev-parse", boundary + "^"), base.head);
      assert.deepEqual(
        {
          boundary: inside.output.boundary,
          checkpoint: inside.output.checkpoint,
        },
        { boundary, checkpoint },
      );
      assert.equal(sqliteVersion(dbPath), 34);
      assert.deepEqual(sqliteLink(dbPath), {
        mode: "paused",
        canonical_head: checkpoint,
        canonical_hash: plan.resultHash,
      });
      assert.equal(stateHash(sqliteState(dbPath)), plan.resultHash);
      assert.equal(legacyNames(sqliteState(dbPath)), 0);
      assert.equal((await pgLink(team)).canonical_head, base.head);
      // The old history is intact; the boundary adds its one event and the
      // checkpoint the snapshot of the converted state.
      assert.equal(git("rev-list", base.head), historyBefore);
      assert.deepEqual(added(git, boundary), [
        `events/sheet-clone-1-${base.head}.json`,
      ]);
      const event = (oid) =>
        JSON.parse(
          git(
            "show",
            `${oid}:${added(git, oid).find((p) => p.startsWith("events/"))}`,
          ),
        );
      assert.equal(event(checkpoint).kind, "checkpoint");
      assert.equal(event(checkpoint).atCommit, boundary);
      const snapshot = decodeSnapshot(
        execFileSync(
          "git",
          ["-C", s.remote, "show", `${checkpoint}:${event(checkpoint).path}`],
          {
            maxBuffer: 64 * 1024 * 1024,
          },
        ),
      );
      assert.equal(stateHash(snapshot.state), plan.resultHash);

      // 4. External finalize: the external cursor on the same checkpoint.
      const finalizeArgs = [
        "--completion",
        s.file("internal-complete.json"),
        "--journal",
        s.externalJournal,
      ];
      const finalized = s.externalCli("finalize", finalizeArgs);
      assert.equal(finalized.status, 0, finalized.stderr);
      assert.deepEqual(
        {
          checkpoint: finalized.output.checkpoint,
          resultHash: finalized.output.resultHash,
        },
        {
          checkpoint: inside.output.checkpoint,
          resultHash: inside.output.resultHash,
        },
      );
      assert.deepEqual(await pgLink(team), {
        mode: "paused",
        canonical_head: checkpoint,
        canonical_hash: plan.resultHash,
      });

      // Every phase again, with its journal: the same output, no change.
      const rows = sqliteRows(dbPath),
        entities = await pgEntities(team);
      for (const [result, first] of [
        [s.internalCli("prepare", ["--out", s.file("plan.json")]), null],
        [s.externalCli("apply", applyArgs), applied],
        [s.internalCli("apply", applyInside), inside],
        [s.externalCli("finalize", finalizeArgs), finalized],
      ]) {
        if (!first) {
          // Prepare refuses once the internal apply has started.
          refused(result, /rerun apply, not prepare/);
          continue;
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output.resultHash, first.output.resultHash);
        assert.equal(result.output.checkpoint, first.output.checkpoint);
      }
      assert.equal(sqliteRows(dbPath), rows);
      assert.deepEqual(await pgEntities(team), entities);
      assert.equal(s.head(), checkpoint);
      assert.notDeepEqual(entities, entitiesBefore);
      // No credential, address or local path reached a file of the run.
      for (const name of readdirSync(s.file(".."), { recursive: true })) {
        const path = join(s.file(".."), name);
        if (
          !/(handoff|journal|git-cache|data\/sync)/.test(path) ||
          statSync(path).isDirectory()
        )
          continue;
        const text = readFileSync(path, "utf8");
        for (const leak of s.secrets) assert.ok(!text.includes(leak), path);
      }
      for (const result of [prepared, applied, inside, finalized])
        for (const leak of s.secrets) assert.ok(!result.stdout.includes(leak));

      // The one-step tool on copies of the same released databases and
      // history writes the same boundary and the same converted state.
      const other = join(s.root, "one-step");
      mkdirSync(other);
      const otherRemote = join(other, "remote.git");
      execFileSync("git", ["init", "--bare", otherRemote], { stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-C",
          otherRemote,
          "fetch",
          new URL("sync.bundle", FIXTURE).pathname,
          "refs/*:refs/*",
        ],
        { stdio: "ignore" },
      );
      execFileSync("git", [
        "-C",
        otherRemote,
        "update-ref",
        "refs/heads/sync-v1",
        base.head,
      ]);
      const otherDb = join(other, "inside.sqlite");
      {
        const db = new DatabaseSync(otherDb);
        db.exec(read(`internal-${label}.sql`));
        db.close();
      }
      await s.load("onestep", [`external-team-${label}.sql`]);
      const oneStepTeam = s.pool("onestep"),
        oneStep = await runCutover({
          teamId,
          sqlitePath: otherDb,
          pool: oneStepTeam,
          pgScope: "team",
          transport: new GitCliTransport({
            directory: join(other, "tool.git"),
            repository: otherRemote,
            allowLocal: true,
          }),
          origins: ORIGINS,
          journalDir: join(other, "journal"),
        });
      assert.equal(oneStep.resultHash, plan.resultHash);
      const boundaryEvent = `events/sheet-clone-1-${base.head}.json`,
        show = (repo, spec) =>
          execFileSync("git", ["-C", repo, "show", spec], { encoding: "utf8" });
      assert.equal(
        show(s.remote, `${boundary}:${boundaryEvent}`),
        show(otherRemote, `${oneStep.boundary}:${boundaryEvent}`),
      );
      assert.equal(
        stateHash(sqliteState(otherDb)),
        stateHash(sqliteState(dbPath)),
      );
      assert.equal(
        stateHash(await pgState(oneStepTeam)),
        stateHash(await pgState(team)),
      );

      // The sites start (internal first) and synchronize both ways.
      const github = githubEmulator(s.remote),
        nativeFetch = globalThis.fetch,
        work = [];
      globalThis.fetch = (input, init) => {
        const target = new URL(typeof input === "string" ? input : input.url);
        if (target.origin === "https://api.github.com")
          return github.fetch(target.href, init);
        assert.equal(target.hostname, "127.0.0.1", "unexpected live HTTP");
        return nativeFetch(input, init);
      };
      t.after(() => (globalThis.fetch = nativeFetch));
      const imagesDir = join(s.inside, "images");
      cpSync(new URL("images", FIXTURE).pathname, imagesDir, {
        recursive: true,
      });
      const db = openDatabase(dbPath);
      t.after(() => db.close());
      const app = createApp({
        db,
        rateLimits: false,
        documentImagesDir: imagesDir,
        syncOptions: {
          installationId: manifest.installations.internal,
          profiles: [
            {
              profileId: manifest.profiles.internal,
              teamId,
              repository: manifest.repository,
              peerInstallationId: manifest.installations.external,
            },
          ],
          transports: {
            [manifest.profiles.internal]: new GitCliTransport({
              directory: join(s.inside, "app.git"),
              repository: s.remote,
              allowLocal: true,
            }),
          },
          schedule: false,
        },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const token = randomUUID();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        manifest.users.lead,
        Date.now() + 3600000,
      );
      const call = async (response) => {
        const text = await response.text();
        let data = text;
        try {
          data = unpack(JSON.parse(text));
        } catch {}
        return { status: response.status, data };
      };
      const internalApi = async (path, body, method = body ? "POST" : "GET") =>
        call(
          await nativeFetch(
            `http://127.0.0.1:${server.address().port}/api${path}`,
            {
              method,
              headers: {
                cookie: "weekly_session=" + token,
                "X-Requested-With": "WeeklyPlan",
                "Content-Type": "application/json",
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
          ),
        );
      const env = {
        APP_ORIGIN: manifest.origins.external,
        ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
        ACCESS_AUDIENCE: "fixture",
        SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
        INSTALLATION_ID: manifest.installations.external,
        PEER_INSTALLATION_ID: manifest.installations.internal,
        PG_CONTROL: { connectionString: s.url("control") },
        PG_TEAM: { connectionString: s.url("team") },
        R2_TEAM: bucket(),
        GIT_TOKEN: "fixture-secret",
        SYNC_PROFILES: JSON.stringify([
          {
            profileId: manifest.profiles.external,
            teamId,
            repository: manifest.repository,
            databaseBinding: "PG_TEAM",
            bucketBinding: "R2_TEAM",
            githubSecret: "GIT_TOKEN",
          },
        ]),
      };
      const worker = createWorker({
        verify: async () => ({
          issuer: env.ACCESS_ISSUER,
          subject: "external-subject",
          email: "outside@example.com",
          expiresAt: Date.now() + 3600000,
        }),
      });
      const externalApi = async (path, body, method = body ? "POST" : "GET") =>
        call(
          await worker.fetch(
            new Request(env.APP_ORIGIN + "/api" + path, {
              method,
              headers: {
                "X-Requested-With": "WeeklyPlan",
                "Content-Type": "application/json",
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            }),
            env,
            { waitUntil: (promise) => work.push(promise) },
          ),
        );
      const flush = async () => {
        for (let i = 0; i < work.length; i++) await work[i];
        work.length = 0;
      };
      const pgStore = new PostgresDatabase(team, { teamId });
      const converge = async () => {
        for (let i = 0; i < 4; i++) {
          await flush();
          if ((await pgStore.readLink(teamId))?.mode === "active")
            await runTeam(
              env,
              profileFor(env, manifest.profiles.external, teamId),
            );
          await app.locals.sync.get(teamId).run();
        }
        await flush();
      };
      for (const [send, site] of [
        [internalApi, "internal"],
        [externalApi, "external"],
      ]) {
        const status = ok(await send(`/teams/${teamId}/sync`));
        assert.equal(status.mode, "paused", site);
        assert.equal(status.protocol, to, site);
        assert.equal(status.canonicalHead, checkpoint, site);
        assert.equal(status.pending, 0, site);
        assert.equal(status.conflicts, 0, site);
        ok(await send(`/teams/${teamId}/sync/resume`, {}));
      }
      await converge();
      // A sheet clone cell edited inside reaches the external site.
      const clone = ok(await internalApi(`/sheet-clones/${R2}`));
      ok(
        await internalApi(
          `/sheet-clones/${R2}`,
          {
            operationId: randomUUID(),
            revision: clone.revision,
            operations: [
              {
                kind: "cells",
                at: new Date().toISOString(),
                changes: [
                  {
                    taskId: T1,
                    key: "2026-11-02",
                    expectedVersion: 0,
                    value: "분리 전환 후 사내",
                  },
                ],
              },
            ],
          },
          "PATCH",
        ),
      );
      await converge();
      assert.equal(
        ok(await externalApi(`/sheet-clones/${R2}`)).tasks.find(
          (task) => task.id === T1,
        ).cells["2026-11-02"].value,
        "분리 전환 후 사내",
      );
      // A calendar entry created outside reaches the internal site.
      const entryId = randomUUID();
      ok(
        await externalApi("/calendar/entries", {
          id: entryId,
          teamId,
          userId: OUTSIDE_USER,
          date: "2026-11-10",
          endDate: "2026-11-10",
          title: "분리 전환 후 외부 일정",
          tagIds: [],
        }),
      );
      await converge();
      // (A personal entry: the internal site shows it in that member's
      // calendar.)
      assert.deepEqual(
        {
          ...db
            .prepare(
              "SELECT title,user_id,deleted_at FROM calendar_entries WHERE id=?",
            )
            .get(entryId),
        },
        {
          title: "분리 전환 후 외부 일정",
          user_id: OUTSIDE_USER,
          deleted_at: null,
        },
      );
      const listed = ok(
        await internalApi(
          `/calendar?teamId=${teamId}&scope=personal&userId=${OUTSIDE_USER}&from=2026-11-01&to=2026-11-30`,
        ),
      );
      assert.ok(
        listed.entries.some((entry) => entry.id === entryId),
        JSON.stringify(listed).slice(0, 500),
      );
      for (const [send, site] of [
        [internalApi, "internal"],
        [externalApi, "external"],
      ]) {
        const status = ok(await send(`/teams/${teamId}/sync`));
        assert.equal(status.pending, 0, site);
        assert.equal(status.conflicts, 0, site);
        assert.equal(status.mode, "active", site);
      }
      const internalHead = app.locals.sync
        .store(teamId)
        .readLink().canonical_head;
      assert.equal(
        (await pgStore.readLink(teamId)).canonical_head,
        internalHead,
      );
      assert.notEqual(internalHead, checkpoint);
      assert.equal(
        git("merge-base", "--is-ancestor", checkpoint, internalHead),
        "",
      );
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        stateHash(await pgStore.readState(teamId)),
      );
    },
  );

test(
  "site-scope commands migrate a legacy site v1/team v1 in place and recheck the site identity and checksum on resume",
  { skip, timeout: 600000 },
  async (t) => {
    const s = await sites(t, "v1", 55484),
      { team } = s;
    await team.query(
      "DELETE FROM graeboard.schema_migrations WHERE version=2; DROP INDEX graeboard.sync_outbox_team_sequence",
    );
    await team.query(
      "CREATE SCHEMA graeboard_site; SET search_path TO graeboard_site,pg_catalog; CREATE TABLE schema_migrations(scope TEXT NOT NULL,version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);" +
        postgresMigrations.site.sql,
    );
    await team.query(
      "INSERT INTO graeboard_site.schema_migrations VALUES('site',1,$1,$2)",
      [postgresMigrations.site.checksum, new Date().toISOString()],
    );
    await team.query("INSERT INTO graeboard_site.site_meta VALUES(1,$1)", [
      teamId,
    ]);
    const external = (phase, args) =>
      s.externalCli(phase, args, { scope: "site" });
    const prepared = s.internalCli("prepare", ["--out", s.file("plan.json")]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const dry = external("apply", ["--plan", s.file("plan.json"), "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(await teamVersion(team), 1);
    assert.equal(
      (
        await team.query(
          "SELECT MAX(version) v FROM graeboard_site.schema_migrations",
        )
      ).rows[0].v,
      1,
    );
    const applyArgs = [
      "--plan",
      s.file("plan.json"),
      "--journal",
      s.externalJournal,
      "--out",
      s.file("ready.json"),
    ];
    const applied = external("apply", applyArgs);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(await teamVersion(team), 3);
    assert.equal(
      (
        await team.query(
          "SELECT MAX(version) v FROM graeboard_site.schema_migrations",
        )
      ).rows[0].v,
      3,
    );
    await team.query("UPDATE graeboard_site.site_meta SET team_id=$1", [
      randomUUID(),
    ]);
    refused(external("apply", applyArgs), /site\/team identity mismatch/);
    await team.query("UPDATE graeboard_site.site_meta SET team_id=$1", [
      teamId,
    ]);
    await team.query(
      "UPDATE graeboard_site.schema_migrations SET checksum=$1 WHERE version=1",
      ["0".repeat(64)],
    );
    refused(external("apply", applyArgs), /checksum/);
    await team.query(
      "UPDATE graeboard_site.schema_migrations SET checksum=$1 WHERE version=1",
      [postgresMigrations.site.checksum],
    );
    const internal = s.internalCli("apply", [
      "--ready",
      s.file("ready.json"),
      "--out",
      s.file("completion.json"),
    ]);
    assert.equal(internal.status, 0, internal.stderr);
    const final = external("finalize", [
      "--completion",
      s.file("completion.json"),
      "--journal",
      s.externalJournal,
    ]);
    assert.equal(final.status, 0, final.stderr);
    assert.equal(final.output.checkpoint, internal.output.checkpoint);
    assert.equal(final.output.resultHash, internal.output.resultHash);
    assert.equal(
      (await pgLink(team)).canonical_head,
      internal.output.checkpoint,
    );
  },
);

test(
  "the separate-site commands refuse wrong input, identities, tool code, heads and writes between phases before any change, resume after every interruption, and never accept a forged completion",
  { skip, timeout: 600000 },
  async (t) => {
    const s = await sites(t, "v2", 55483),
      { base, git, dbPath, team } = s,
      rowsBefore = sqliteRows(dbPath),
      entitiesBefore = await pgEntities(team);
    const unchanged = async () => {
      assert.equal(sqliteRows(dbPath), rowsBefore);
      assert.deepEqual(await pgEntities(team), entitiesBefore);
      assert.equal(await teamVersion(team), 2);
      assert.equal(s.head(), base.head);
    };

    // Missing, empty or unset values are refused before anything is read.
    const prepareOut = ["--out", s.file("plan.json")];
    for (const [args, pattern] of [
      [["prepare"], /--database is required/],
      [
        [
          "prepare",
          "--database",
          "",
          "--team-id",
          teamId,
          "--journal",
          s.internalJournal,
          ...prepareOut,
        ],
        /--database is required and must not be empty/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--journal",
          "",
          ...prepareOut,
        ],
        /--journal is required and must not be empty/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--journal",
          "/journal",
          ...prepareOut,
        ],
        /filesystem root; check that the path variable is set/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--journal",
          s.internalJournal,
        ],
        /--out is required/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--journal",
          s.internalJournal,
          "--out",
          join(s.internalJournal, "plan.json"),
        ],
        /outside the journal/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          "team",
          "--journal",
          s.internalJournal,
          ...prepareOut,
        ],
        /--team-id must be the team's UUID/,
      ],
      [
        [
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--site-origin",
          "https://a.example/",
          "--journal",
          s.internalJournal,
          ...prepareOut,
        ],
        /without path or trailing slash/,
      ],
      [
        [
          "apply",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          "--journal",
          s.internalJournal,
          "--out",
          s.file("c.json"),
        ],
        /--ready is required/,
      ],
      [["export"], /Name one phase/],
    ]) {
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", INTERNAL_CLI, ...args],
        {
          cwd: s.inside,
          env: s.internalEnv,
          encoding: "utf8",
        },
      );
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, pattern, args.join(" "));
    }
    const externalBase = (journal) => [
      "--team-id",
      teamId,
      "--pg-url-env",
      "SITE_PG_URL",
      "--repository",
      manifest.repository,
      "--git-token-env",
      "SITE_GIT_TOKEN",
      "--git-dir",
      join(s.outside, "git-cache"),
      ...(journal ? ["--journal", journal] : []),
    ];
    for (const [args, env, pattern] of [
      [
        [
          "apply",
          "--plan",
          s.file("plan.json"),
          ...externalBase(s.externalJournal),
          "--out",
          s.file("r.json"),
        ],
        { ...s.externalEnv(), SITE_PG_URL: "" },
        /SITE_PG_URL is empty or not set/,
      ],
      [
        [
          "apply",
          "--plan",
          s.file("plan.json"),
          ...externalBase(s.externalJournal),
          "--out",
          s.file("r.json"),
        ],
        { ...s.externalEnv(), SITE_GIT_TOKEN: "" },
        /SITE_GIT_TOKEN is empty or not set/,
      ],
      [
        [
          "apply",
          "--plan",
          s.file("plan.json"),
          ...externalBase(""),
          "--out",
          s.file("r.json"),
        ],
        s.externalEnv(),
        /--journal is required and must not be empty/,
      ],
      [
        [
          "apply",
          "--plan",
          s.file("plan.json"),
          ...externalBase(s.externalJournal),
          "--out",
          s.file("r.json"),
          "--pg-url-env",
          "lower",
        ],
        s.externalEnv(),
        /must name an environment variable/,
      ],
      [
        [
          "apply",
          "--plan",
          s.file("plan.json"),
          ...externalBase(s.externalJournal),
          "--dry-run",
        ],
        s.externalEnv(),
        /--dry-run writes nothing/,
      ],
      [
        [
          "finalize",
          "--plan",
          s.file("plan.json"),
          ...externalBase(s.externalJournal),
        ],
        s.externalEnv(),
        /belong to apply/,
      ],
      [
        [
          "apply",
          "--plan",
          s.file("missing.json"),
          ...externalBase(s.externalJournal),
          "--out",
          s.file("r.json"),
        ],
        s.externalEnv(),
        /does not exist/,
      ],
    ]) {
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", EXTERNAL_CLI, ...args],
        {
          cwd: s.outside,
          env,
          encoding: "utf8",
        },
      );
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, pattern, args.join(" "));
      for (const leak of s.secrets) assert.ok(!r.stderr.includes(leak));
    }
    assert.equal(existsSync(s.internalJournal), false);
    assert.equal(existsSync(s.externalJournal), false);
    await unchanged();

    // An internal site that is not paused, or Git ahead of the recorded
    // head: refused, nothing written.
    for (const mode of ["active", "disconnected", "recovery"]) {
      sqlite(
        dbPath,
        "UPDATE team_sync_links SET mode=? WHERE team_id=?",
        mode,
        teamId,
      );
      refused(
        s.internalCli("prepare", prepareOut),
        new RegExp(`synchronization is ${mode}`),
      );
    }
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET mode='paused' WHERE team_id=?",
      teamId,
    );
    const rowsPaused = sqliteRows(dbPath);
    const ahead = s.foreign(base.head);
    git("update-ref", "refs/heads/sync-v1", ahead, base.head);
    refused(
      s.internalCli("prepare", prepareOut),
      /remote head [a-f0-9]{40} is not the head the internal site recorded/,
    );
    git("update-ref", "refs/heads/sync-v1", base.head, ahead);
    assert.equal(existsSync(s.file("plan.json")), false);
    assert.equal(sqliteRows(dbPath), rowsPaused);
    const prepared = s.internalCli("prepare", prepareOut);
    assert.equal(prepared.status, 0, prepared.stderr);
    const plan = JSON.parse(readFileSync(s.file("plan.json"), "utf8"));

    // External apply against a plan that is not this site's, another
    // option or another tool: refused before PostgreSQL changes.
    const applyArgs = (planFile) => [
      "--plan",
      planFile,
      "--journal",
      s.externalJournal,
      "--out",
      s.file("external-ready.json"),
    ];
    const tampered = (name, change) => {
      const path = s.file(name);
      writeFileSync(path, JSON.stringify({ ...plan, ...change }));
      return path;
    };
    for (const [change, pattern] of [
      [
        { resultHash: "0".repeat(64) },
        /resultHash is [a-f0-9]{64}, the plan has 0{64}/,
      ],
      [
        { baseHash: "1".repeat(64) },
        /baseHash is [a-f0-9]{64}, the plan has 1{64}/,
      ],
      [
        { baseHead: "2".repeat(40) },
        /baseHead is [a-f0-9]{40}, the plan has 2{40}/,
      ],
      [{ fromProtocol: 1, toProtocol: 3 }, /fromProtocol is 2, the plan has 1/],
      [{ repoId: randomUUID() }, /not the plan's repository/],
      [{ bootstrapId: randomUUID() }, /not the plan's repository/],
      [{ teamId: randomUUID() }, /the plan is for team/],
      [{ toolDigest: "3".repeat(64) }, /another version of this tool/],
      [{ origins: [manifest.origins.internal] }, /converts the links of/],
      [
        {
          migrations: {
            ...plan.migrations,
            sqlite: { version: 34, checksum: "4".repeat(64) },
          },
        },
        /malformed \(migrations\)/,
      ],
      [{ extra: true }, /malformed \(extra\)/],
      [
        { artifact: "external-ready" },
        /not a SheetClone split cutover internal plan/,
      ],
    ])
      refused(
        s.externalCli("apply", applyArgs(tampered("bad-plan.json", change))),
        pattern,
      );
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json")), {
        origins: ["--site-origin", manifest.origins.internal],
      }),
      /converts the links of/,
    );
    // Not paused, a command saved after the plan, Git moved: refused.
    for (const mode of ["active", "disconnected", "recovery"]) {
      await team.query(
        "UPDATE graeboard.team_sync_links SET mode=$1 WHERE team_id=$2",
        [mode, teamId],
      );
      refused(
        s.externalCli("apply", applyArgs(s.file("plan.json"))),
        new RegExp(`synchronization is ${mode}`),
      );
    }
    await team.query(
      "UPDATE graeboard.team_sync_links SET mode='paused' WHERE team_id=$1",
      [teamId],
    );
    const held = randomUUID();
    await team.query(
      "INSERT INTO graeboard.sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES($1,$2,'{}',NULL,'held',$3)",
      [held, teamId, new Date().toISOString()],
    );
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json"))),
      /pending or held commands/,
    );
    await team.query("DELETE FROM graeboard.sync_outbox WHERE op_id=$1", [
      held,
    ]);
    git("update-ref", "refs/heads/sync-v1", ahead, base.head);
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json"))),
      /is not the head the external site recorded/,
    );
    git("update-ref", "refs/heads/sync-v1", base.head, ahead);
    assert.deepEqual(readdirSync(s.externalJournal), []);
    assert.equal(existsSync(s.file("external-ready.json")), false);
    await unchanged();

    // A failure inside the PostgreSQL conversion's transaction rolls it back.
    const ext = s.externalOptions(team);
    await assert.rejects(
      applyExternal({
        ...ext,
        plan,
        readyPath: s.file("external-ready.json"),
        hooks: {
          before: async (name) => {
            if (name === "convert")
              await team.query(
                "CREATE FUNCTION public.split_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected external fault'; END$$; CREATE TRIGGER split_fault BEFORE UPDATE ON graeboard.sync_entities FOR EACH ROW EXECUTE FUNCTION public.split_fault()",
              );
          },
        },
      }),
      /injected external fault/,
    );
    await team.query(
      "DROP TRIGGER split_fault ON graeboard.sync_entities; DROP FUNCTION public.split_fault()",
    );
    await unchanged();
    await assert.rejects(
      applyExternal({
        ...ext,
        plan,
        readyPath: s.file("external-ready.json"),
        hooks: {
          before: async (name) => {
            if (name === "convert")
              await team.query(
                "UPDATE graeboard.team_sync_links SET repo_id=$1 WHERE team_id=$2",
                [randomUUID(), teamId],
              );
          },
        },
      }),
      /not the plan's repository/,
    );
    assert.equal(await teamVersion(team), 2);
    await team.query(
      "UPDATE graeboard.team_sync_links SET repo_id=$1 WHERE team_id=$2",
      [plan.repoId, teamId],
    );
    await unchanged();
    // A failed journal write before COMMIT must roll the entire migration
    // back; a retry still starts from the same source proof.
    const externalTemporary = join(
      s.externalJournal,
      "external-journal.json.tmp",
    );
    await assert.rejects(
      applyExternal({
        ...ext,
        plan,
        readyPath: s.file("external-ready.json"),
        hooks: {
          before: async (name) => {
            if (name === "convert") mkdirSync(externalTemporary);
          },
        },
      }),
      { code: "ERR_FS_EISDIR" },
    );
    rmSync(externalTemporary, { recursive: true });
    await unchanged();
    // Interrupted after the commit, before the ready file: the rerun goes on.
    await assert.rejects(
      applyExternal({
        ...ext,
        plan,
        readyPath: s.file("external-ready.json"),
        hooks: {
          after: async (name) => {
            if (name === "convert")
              throw new Error("crash after external convert");
          },
        },
      }),
      /crash after external convert/,
    );
    assert.equal(await teamVersion(team), 3);
    assert.equal(existsSync(s.file("external-ready.json")), false);
    // Another PostgreSQL database under the same variable: refused.
    await s.load("other", ["external-team-v2.sql"]);
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json")), {
        env: s.externalEnv("other"),
      }),
      /PostgreSQL database differs from the one this journal converted/,
    );
    const applied = s.externalCli("apply", applyArgs(s.file("plan.json")));
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal((await pgLink(team)).canonical_head, base.head);
    assert.equal(sqliteVersion(dbPath), 33);
    const jobId = randomUUID();
    await team.query(
      "INSERT INTO graeboard.site_maintenance_jobs VALUES($1,$2,'backup','running','{}','{}',$3)",
      [jobId, teamId, new Date().toISOString()],
    );
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json"))),
      /maintenance or backup job is unfinished/,
    );
    await team.query(
      "DELETE FROM graeboard.site_maintenance_jobs WHERE job_id=$1",
      [jobId],
    );
    await team.query(
      "UPDATE graeboard.team_sync_links SET bootstrap_bundle='{}' WHERE team_id=$1",
      [teamId],
    );
    refused(
      s.externalCli("apply", applyArgs(s.file("plan.json"))),
      /first snapshot is pending/,
    );
    await team.query(
      "UPDATE graeboard.team_sync_links SET bootstrap_bundle=NULL WHERE team_id=$1",
      [teamId],
    );
    // A plan of another journal is refused by this one.
    refused(
      s.externalCli(
        "apply",
        applyArgs(tampered("bad-plan.json", { baseHash: "5".repeat(64) })),
      ),
      /baseHash|another plan/,
    );

    // Internal apply: a forged ready file, writes or an identity change
    // since the plan, or Git ahead: refused before SQLite changes.
    const applyInside = (ready = s.file("external-ready.json")) => [
      "--ready",
      ready,
      "--out",
      s.file("internal-complete.json"),
    ];
    const ready = JSON.parse(
      readFileSync(s.file("external-ready.json"), "utf8"),
    );
    for (const [change, pattern] of [
      [{ planDigest: "6".repeat(64) }, /belongs to another plan/],
      [{ resultHash: "7".repeat(64) }, /differs from the plan/],
      [{ toolDigest: "8".repeat(64) }, /another version of this tool/],
      [
        { artifact: "plan" },
        /not a SheetClone split cutover external ready file/,
      ],
    ]) {
      writeFileSync(
        s.file("bad-ready.json"),
        JSON.stringify({ ...ready, ...change }),
      );
      refused(
        s.internalCli("apply", applyInside(s.file("bad-ready.json"))),
        pattern,
      );
    }
    const pending = randomUUID();
    sqlite(
      dbPath,
      "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES(?,?,'{}',NULL,'pending',?)",
      pending,
      teamId,
      new Date().toISOString(),
    );
    refused(s.internalCli("apply", applyInside()), /pending or held/);
    sqlite(dbPath, "DELETE FROM sync_outbox WHERE op_id=?", pending);
    // C and its head alone cannot detect a local application write made
    // while capture is stopped. The original source proof must reject it.
    const sourcePosition = sqlite(
      dbPath,
      "SELECT position FROM tasks WHERE id=?",
      T1,
    )[0].position;
    const sourceRevision = sqlite(
      dbPath,
      "SELECT version FROM team_revisions WHERE team_id=?",
      teamId,
    )[0].version;
    sqlite(
      dbPath,
      "UPDATE tasks SET position=? WHERE id=?",
      sourcePosition + 100,
      T1,
    );
    const changedSource = sqliteRows(dbPath);
    refused(s.internalCli("apply", applyInside()), /database contents changed/);
    assert.equal(sqliteRows(dbPath), changedSource);
    assert.equal(sqliteVersion(dbPath), 33);
    assert.equal(s.head(), base.head);
    sqlite(
      dbPath,
      "UPDATE tasks SET position=? WHERE id=?",
      sourcePosition,
      T1,
    );
    sqlite(
      dbPath,
      "UPDATE team_revisions SET version=? WHERE team_id=?",
      sourceRevision,
      teamId,
    );
    const { repo_id: repoId } = sqlite(
      dbPath,
      "SELECT repo_id FROM team_sync_links WHERE team_id=?",
      teamId,
    )[0];
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
      randomUUID(),
      teamId,
    );
    refused(s.internalCli("apply", applyInside()), /not the plan's repository/);
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
      repoId,
      teamId,
    );
    git("update-ref", "refs/heads/sync-v1", ahead, base.head);
    refused(
      s.internalCli("apply", applyInside()),
      /remote head moved to [a-f0-9]{40}, which this cutover did not publish/,
    );
    git("update-ref", "refs/heads/sync-v1", base.head, ahead);
    // A journal edited to claim another tool version is refused.
    const journalPath = join(s.internalJournal, "internal-journal.json"),
      journalText = readFileSync(journalPath, "utf8");
    writeFileSync(
      journalPath,
      journalText.replace(
        /"toolDigest": "[a-f0-9]{64}"/,
        `"toolDigest": "${"9".repeat(64)}"`,
      ),
    );
    refused(
      s.internalCli("apply", applyInside()),
      /written by another version of this tool/,
    );
    writeFileSync(journalPath, journalText);
    assert.equal(sqliteRows(dbPath), rowsPaused);
    assert.equal(s.head(), base.head);

    // Interruptions of the internal apply, each resumed by a rerun.
    const inside = s.internalOptions(),
      applyNow = (hooks, transport = inside.transport) =>
        applyInternal({
          ...inside,
          transport,
          readyPath: s.file("external-ready.json"),
          completionPath: s.file("internal-complete.json"),
          hooks,
        });
    const crash = (stage) => ({
      after: async (name) => {
        if (name === stage) throw new Error("crash after " + stage);
      },
    });
    // A failure inside the SQLite transaction rolls it back.
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name === "convert")
            sqlite(
              dbPath,
              "CREATE TRIGGER split_fault BEFORE UPDATE ON sync_entities BEGIN SELECT RAISE(ABORT,'injected internal fault'); END",
            );
        },
      }),
      /injected internal fault/,
    );
    sqlite(dbPath, "DROP TRIGGER split_fault");
    assert.equal(sqliteRows(dbPath), rowsPaused);
    assert.equal(sqliteVersion(dbPath), 33);
    // The connection can change after the outer checks. The migration must
    // recheck it inside its transaction, before committing any DDL or data.
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name === "convert")
            sqlite(
              dbPath,
              "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
              randomUUID(),
              teamId,
            );
        },
      }),
      /not the plan's repository/,
    );
    assert.equal(sqliteVersion(dbPath), 33);
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
      repoId,
      teamId,
    );
    const internalTemporary = join(
      s.internalJournal,
      "internal-journal.json.tmp",
    );
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name === "convert") mkdirSync(internalTemporary);
        },
      }),
      { code: "ERR_FS_EISDIR" },
    );
    rmSync(internalTemporary, { recursive: true });
    assert.equal(sqliteVersion(dbPath), 33);
    assert.equal(sqliteRows(dbPath), rowsPaused);
    // Committed, then lost before the journal: Git is untouched until the rerun.
    await assert.rejects(applyNow(crash("convert")), /crash after convert/);
    assert.equal(sqliteVersion(dbPath), 34);
    assert.equal(s.head(), base.head);
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
      randomUUID(),
      teamId,
    );
    refused(s.internalCli("apply", applyInside()), /not the plan's repository/);
    assert.equal(s.head(), base.head);
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET repo_id=? WHERE team_id=?",
      repoId,
      teamId,
    );
    const convertedPosition = sqlite(
      dbPath,
      "SELECT position FROM tasks WHERE id=?",
      T1,
    )[0].position;
    const convertedRevision = sqlite(
      dbPath,
      "SELECT version FROM team_revisions WHERE team_id=?",
      teamId,
    )[0].version;
    sqlite(
      dbPath,
      "UPDATE tasks SET position=? WHERE id=?",
      convertedPosition + 100,
      T1,
    );
    refused(s.internalCli("apply", applyInside()), /database contents changed/);
    assert.equal(s.head(), base.head);
    sqlite(
      dbPath,
      "UPDATE tasks SET position=? WHERE id=?",
      convertedPosition,
      T1,
    );
    sqlite(
      dbPath,
      "UPDATE team_revisions SET version=? WHERE team_id=?",
      convertedRevision,
      teamId,
    );
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET bootstrap_bundle='{}' WHERE team_id=?",
      teamId,
    );
    refused(s.internalCli("apply", applyInside()), /first snapshot is pending/);
    sqlite(
      dbPath,
      "UPDATE team_sync_links SET bootstrap_bundle=NULL WHERE team_id=?",
      teamId,
    );
    sqlite(
      dbPath,
      "INSERT INTO site_maintenance_jobs VALUES(?,?,'backup','running','{}','{}',?)",
      jobId,
      teamId,
      new Date().toISOString(),
    );
    refused(
      s.internalCli("apply", applyInside()),
      /maintenance or backup job is unfinished/,
    );
    sqlite(dbPath, "DELETE FROM site_maintenance_jobs WHERE job_id=?", jobId);
    // A normal push would incorrectly succeed if the ref went back to an
    // ancestor. The explicit expected-head lease must reject that race too.
    const ancestor = git("rev-parse", base.head + "^");
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name === "boundary")
            git("update-ref", "refs/heads/sync-v1", ancestor, base.head);
        },
      }),
      /remote head changed while publishing the boundary/,
    );
    assert.equal(s.head(), ancestor);
    git("update-ref", "refs/heads/sync-v1", base.head, ancestor);
    // Another writer publishes on the recorded head while the boundary is
    // published: compare-and-swap refuses, and the rerun shows that head.
    let intruder;
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name !== "boundary") return;
          intruder = s.foreign(base.head);
          git("update-ref", "refs/heads/sync-v1", intruder, base.head);
        },
      }),
      /remote head changed while publishing the boundary/,
    );
    assert.equal(s.head(), intruder);
    refused(
      s.internalCli("apply", applyInside()),
      new RegExp(`remote head moved to ${intruder}`),
    );
    assert.equal(s.head(), intruder);
    assert.equal(sqliteLink(dbPath).canonical_head, base.head);
    // (The other writer's commit is taken back by the operator, not the tool.)
    git("update-ref", "refs/heads/sync-v1", base.head, intruder);
    // Published, then the connection lost before the journal recorded it.
    await assert.rejects(applyNow(crash("boundary")), /crash after boundary/);
    const boundary = s.head();
    assert.equal(git("rev-parse", boundary + "^"), base.head);
    let checkpointRace;
    await assert.rejects(
      applyNow({
        before: async (name) => {
          if (name === "checkpoint") {
            checkpointRace = s.foreign(boundary);
            git("update-ref", "refs/heads/sync-v1", checkpointRace, boundary);
          }
        },
      }),
      /remote head changed while publishing the checkpoint/,
    );
    assert.equal(s.head(), checkpointRace);
    assert.equal(sqliteLink(dbPath).canonical_head, base.head);
    git("update-ref", "refs/heads/sync-v1", boundary, checkpointRace);
    await assert.rejects(
      applyNow(crash("checkpoint")),
      /crash after checkpoint/,
    );
    const checkpoint = s.head();
    assert.equal(git("rev-parse", checkpoint + "^"), boundary);
    assert.equal(sqliteLink(dbPath).canonical_head, base.head);
    await assert.rejects(applyNow(crash("cursor")), /crash after cursor/);
    assert.equal(sqliteLink(dbPath).canonical_head, checkpoint);
    await assert.rejects(
      applyNow(crash("completion")),
      /crash after completion/,
    );
    const completed = s.internalCli("apply", applyInside());
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(
      {
        boundary: completed.output.boundary,
        checkpoint: completed.output.checkpoint,
      },
      { boundary, checkpoint },
    );
    assert.equal(
      git("rev-list", "--count", `${base.head}..${checkpoint}`),
      "2",
    );
    // A command saved after completion is reported on a rerun, never moved.
    const late = randomUUID();
    sqlite(
      dbPath,
      "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES(?,?,'{}',NULL,'pending',?)",
      late,
      teamId,
      new Date().toISOString(),
    );
    refused(
      s.internalCli("apply", applyInside()),
      /1 commands are pending or held/,
    );
    sqlite(dbPath, "DELETE FROM sync_outbox WHERE op_id=?", late);

    // External finalize: a forged completion is refused by Git itself.
    const completion = JSON.parse(
        readFileSync(s.file("internal-complete.json"), "utf8"),
      ),
      finalizeArgs = (file) => [
        "--completion",
        file,
        "--journal",
        s.externalJournal,
      ];
    for (const [change, pattern] of [
      [{ checkpoint: boundary }, /is not this cutover's checkpoint/],
      [{ checkpoint: base.head }, /is not this cutover's checkpoint/],
      [{ boundary: base.head }, /is not this cutover's boundary/],
      [
        { boundary: checkpoint, checkpoint: boundary },
        /is not this cutover's boundary/,
      ],
      [{ resultHash: "a".repeat(64) }, /differs from the plan/],
      [{ planDigest: "b".repeat(64) }, /belongs to another plan or ready file/],
      [
        { readyDigest: "c".repeat(64) },
        /belongs to another plan or ready file/,
      ],
      [{ toolDigest: "d".repeat(64) }, /another version of this tool/],
      [
        { checkpoint: "e".repeat(40) },
        /Cutover stopped|is not this cutover's checkpoint/,
      ],
    ]) {
      writeFileSync(
        s.file("bad-complete.json"),
        JSON.stringify({ ...completion, ...change }),
      );
      refused(
        s.externalCli("finalize", finalizeArgs(s.file("bad-complete.json"))),
        pattern,
      );
    }
    // The remote head on another commit of the boundary (not carrying the
    // checkpoint): refused.
    const sibling = s.foreign(boundary);
    git("update-ref", "refs/heads/sync-v1", sibling, checkpoint);
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      /remote head moved to|does not carry/,
    );
    git("update-ref", "refs/heads/sync-v1", checkpoint, sibling);
    // Even a descendant of the valid checkpoint is another writer, and
    // must be rejected on retries instead of trusting a done journal flag.
    const descendant = s.foreign(checkpoint);
    git("update-ref", "refs/heads/sync-v1", descendant, checkpoint);
    refused(s.internalCli("apply", applyInside()), /remote head moved to/);
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      /remote head moved to/,
    );
    assert.equal((await pgLink(team)).canonical_head, base.head);
    git("update-ref", "refs/heads/sync-v1", checkpoint, descendant);
    // A commit on the boundary that claims the checkpoint's result with
    // another state.
    const forgedCheckpoint = await (async () => {
      const state = await pgState(team),
        record = Object.values(state.entities).find((r) => r.entity === "task");
      const other = {
          ...state,
          entities: {
            ...state.entities,
            [JSON.stringify([record.entity, record.key])]: {
              ...record,
              payload: { ...record.payload, title: "forged" },
            },
          },
        },
        { files, envelope } = checkpointFiles({
          head: boundary,
          bootstrapId: plan.bootstrapId,
          identity: { teamId, repoId: plan.repoId },
          state: other,
        });
      const forged = JSON.stringify({
          ...envelope,
          resultHash: plan.resultHash,
        }),
        transport = new GitCliTransport({
          directory: join(s.root, "forger.git"),
          repository: s.remote,
          allowLocal: true,
        }),
        eventPath = Object.keys(files).find((p) => p.startsWith("events/"));
      await transport.readHead();
      const oid = await transport.createCandidate(boundary, {
        ...files,
        [eventPath]: forged,
      });
      // Published in place of the checkpoint, so the external host reads it.
      await transport.git(["push", "origin", `+${oid}:refs/heads/sync-v1`]);
      return oid;
    })();
    writeFileSync(
      s.file("bad-complete.json"),
      JSON.stringify({ ...completion, checkpoint: forgedCheckpoint }),
    );
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("bad-complete.json"))),
      /is not this cutover's checkpoint: its snapshot is not the converted state/,
    );
    // The real completion while the remote head is that other commit.
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      new RegExp(`remote head moved to ${forgedCheckpoint}`),
    );
    git("update-ref", "refs/heads/sync-v1", checkpoint, forgedCheckpoint);
    // Not drained or not paused: refused, nothing moved.
    const conflict = randomUUID();
    await team.query(
      "INSERT INTO graeboard.sync_conflicts(team_id,conflict_id,op_id,payload,resolution) VALUES($1,$2,$3,'{}',NULL)",
      [teamId, conflict, randomUUID()],
    );
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      /1 unresolved conflicts/,
    );
    await team.query(
      "DELETE FROM graeboard.sync_conflicts WHERE conflict_id=$1",
      [conflict],
    );
    await team.query(
      "UPDATE graeboard.team_sync_links SET mode='active' WHERE team_id=$1",
      [teamId],
    );
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      /synchronization is active/,
    );
    await team.query(
      "UPDATE graeboard.team_sync_links SET mode='paused' WHERE team_id=$1",
      [teamId],
    );
    assert.equal((await pgLink(team)).canonical_head, base.head);
    const application = (
      await team.query(
        "SELECT entity,entity_key,payload FROM graeboard.site_entities WHERE team_id=$1 AND entity='task' LIMIT 1",
        [teamId],
      )
    ).rows[0];
    await team.query(
      "UPDATE graeboard.site_entities SET payload=$1 WHERE team_id=$2 AND entity=$3 AND entity_key=$4",
      [
        JSON.stringify({
          ...JSON.parse(application.payload),
          title: "late external write",
        }),
        teamId,
        application.entity,
        application.entity_key,
      ],
    );
    refused(
      s.externalCli("finalize", finalizeArgs(s.file("internal-complete.json"))),
      /database contents changed/,
    );
    assert.equal((await pgLink(team)).canonical_head, base.head);
    await team.query(
      "UPDATE graeboard.site_entities SET payload=$1 WHERE team_id=$2 AND entity=$3 AND entity_key=$4",
      [application.payload, teamId, application.entity, application.entity_key],
    );
    // Moved, then lost before the journal: the rerun finds it done.
    await assert.rejects(
      finalizeExternal({
        ...s.externalOptions(team),
        completion,
        hooks: crash("cursor"),
      }),
      /crash after cursor/,
    );
    assert.equal((await pgLink(team)).canonical_head, checkpoint);
    const finalized = s.externalCli(
      "finalize",
      finalizeArgs(s.file("internal-complete.json")),
    );
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(finalized.output.checkpoint, completed.output.checkpoint);
    assert.equal(finalized.output.resultHash, completed.output.resultHash);
    for (const site of ["internal", "external"]) {
      if (site === "internal")
        sqlite(
          dbPath,
          "UPDATE team_sync_links SET canonical_hash=? WHERE team_id=?",
          "f".repeat(64),
          teamId,
        );
      else
        await team.query(
          "UPDATE graeboard.team_sync_links SET canonical_hash=$1 WHERE team_id=$2",
          ["f".repeat(64), teamId],
        );
      const result =
        site === "internal"
          ? s.internalCli("apply", applyInside())
          : s.externalCli(
              "finalize",
              finalizeArgs(s.file("internal-complete.json")),
            );
      refused(result, /checkpoint cursor has another canonical hash/);
      if (site === "internal")
        sqlite(
          dbPath,
          "UPDATE team_sync_links SET canonical_hash=? WHERE team_id=?",
          plan.resultHash,
          teamId,
        );
      else
        await team.query(
          "UPDATE graeboard.team_sync_links SET canonical_hash=$1 WHERE team_id=$2",
          [plan.resultHash, teamId],
        );
    }
    for (const link of [sqliteLink(dbPath), await pgLink(team)])
      assert.deepEqual(link, {
        mode: "paused",
        canonical_head: checkpoint,
        canonical_hash: plan.resultHash,
      });
    // Prepare refuses this journal now, and a converted database in a new one.
    refused(
      s.internalCli("prepare", ["--out", s.file("plan2.json")]),
      /rerun apply, not prepare/,
    );
    refused(
      spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          PRELOAD,
          INTERNAL_CLI,
          "prepare",
          "--database",
          dbPath,
          "--team-id",
          teamId,
          ...ORIGINS.flatMap((origin) => ["--site-origin", origin]),
          "--journal",
          join(s.root, "fresh-journal"),
          "--out",
          s.file("plan2.json"),
        ],
        { cwd: s.inside, env: s.internalEnv, encoding: "utf8" },
      ),
      /already converted; nothing to prepare/,
    );
    assert.equal(existsSync(s.file("plan2.json")), false);
  },
);
