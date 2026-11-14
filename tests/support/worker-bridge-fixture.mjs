import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { openDatabase, json } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { DEFAULT_SETTINGS } from "../../shared/domain.js";
import { unpack } from "../../shared/formatting/compact.js";
import { GitCliTransport } from "../../server/sync/node/git-cli.mjs";
import { migratePostgres } from "../../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../../worker/storage/postgres.mjs";
import { createWorker } from "../../worker/entry.mjs";
import { runTeam } from "../../worker/sync/sync.mjs";
import { profileFor } from "../../shared/sync/sync-profiles.js";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";

export const bridgePgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
export const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};

// One team on the internal SQLite app and on the external PostgreSQL worker,
// joined through one bare Git repository (Git CLI inside, the GitHub API
// emulator outside). Both sites are synchronizing when this returns.
export async function bridgeFixture(t, { port }) {
  const dir = mkdtempSync(join(tmpdir(), "gb-bridge-")),
    remote = join(dir, "remote.git"),
    socket = join(dir, "socket"),
    pgData = join(dir, "pg"),
    teamId = randomUUID(),
    internalUser = randomUUID(),
    externalInstallation = randomUUID(),
    internalInstallation = randomUUID(),
    nativeFetch = globalThis.fetch,
    pools = [],
    work = [],
    phases = [],
    log = console.log;
  mkdirSync(socket);
  let pgStarted = false,
    db,
    server,
    app;
  console.log = (...args) =>
    args[0] === "GraeBoard sync phase"
      ? phases.push(JSON.parse(args[1]))
      : log(...args);
  t.after(async () => {
    console.log = log;
    await Promise.allSettled(work);
    globalThis.fetch = nativeFetch;
    if (app) {
      await app.locals.sync.close();
      app.locals.cellEvents.close();
      app.locals.documentEvents.close();
    }
    if (server) await new Promise((r) => server.close(r));
    db?.close();
    await Promise.all(pools.map((p) => p.end()));
    if (pgStarted)
      spawnSync(
        join(bridgePgBin, "pg_ctl"),
        ["-D", pgData, "-m", "immediate", "-w", "stop"],
        { stdio: "ignore" },
      );
    rmSync(dir, { recursive: true, force: true });
  });
  const command = (bin, args) => {
      const r = spawnSync(join(bridgePgBin, bin), args, { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    },
    url = (name) =>
      `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=${port}`;
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const github = githubEmulator(remote),
    readme = github.text(["hash-object", "-w", "--stdin"], {
      input: "fixture",
    }),
    tree = github.text(["mktree"], {
      input: `100644 blob ${readme}\tREADME.md\n`,
    });
  github.text([
    "update-ref",
    "refs/heads/main",
    github.text(["commit-tree", tree, "-m", "init"]),
  ]);
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" ? input : input.url);
    if (target.origin === "https://api.github.com")
      return github.fetch(target.href, init);
    assert.equal(
      target.hostname,
      "127.0.0.1",
      "unexpected live HTTP in integration fixture",
    );
    return nativeFetch(input, init);
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
    join(dir, "pg.log"),
    "-o",
    `-k ${socket} -p ${port} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  pgStarted = true;
  const root = new Pool({ connectionString: url("postgres") });
  pools.push(root);
  await root.query("CREATE DATABASE control");
  await root.query("CREATE DATABASE team");
  const control = new Pool({ connectionString: url("control") }),
    team = new Pool({ connectionString: url("team") });
  pools.push(control, team);
  await migratePostgres(control, { scope: "control", initialize: true });
  await migratePostgres(team, { scope: "team", initialize: true, teamId });
  const pgStore = new PostgresDatabase(team, { teamId });
  db = openDatabase(join(dir, "inside.sqlite"));
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Bridge",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'private-password-hash','admin',?)",
  ).run(internalUser, "inside@example.com", "Inside", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
    internalUser,
    teamId,
  );
  const token = randomUUID();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    internalUser,
    Date.now() + 86400000,
  );
  app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: {
      installationId: internalInstallation,
      profiles: [
        {
          profileId: "inside",
          teamId,
          repository: "fixture/team",
          peerInstallationId: externalInstallation,
        },
      ],
      transports: {
        inside: new GitCliTransport({
          directory: join(dir, "inside.git"),
          repository: remote,
          allowLocal: true,
        }),
      },
      schedule: false,
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const inside = async (path, body, method = body ? "POST" : "GET") => {
    const response = await nativeFetch(
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
    );
    return { status: response.status, data: unpack(await response.json()) };
  };
  const env = {
      APP_ORIGIN: "https://bridge.example.com",
      ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      ACCESS_AUDIENCE: "fixture",
      SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
      INSTALLATION_ID: externalInstallation,
      PEER_INSTALLATION_ID: internalInstallation,
      SYNC_PHASE_LOG: "1",
      PG_CONTROL: { connectionString: url("control") },
      PG_TEAM: { connectionString: url("team") },
      R2_TEAM: bucket(),
      GIT_TOKEN: "fixture-secret",
      SYNC_PROFILES: JSON.stringify([
        {
          profileId: "outside",
          teamId,
          repository: "fixture/team",
          databaseBinding: "PG_TEAM",
          bucketBinding: "R2_TEAM",
          githubSecret: "GIT_TOKEN",
        },
      ]),
    },
    worker = createWorker({
      verify: async () => ({
        issuer: env.ACCESS_ISSUER,
        subject: "external-subject",
        email: "outside@example.com",
        expiresAt: Date.now() + 3600000,
      }),
    });
  const outside = async (path, body, method = body ? "POST" : "GET") => {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + "/api" + path, {
        method,
        headers: {
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      { waitUntil: (p) => work.push(p) },
    );
    return { status: response.status, data: unpack(await response.json()) };
  };
  // The external site's background work, then one of its sync runs.
  const drain = async () => {
    for (let i = 0; i < work.length; i++) await work[i];
    const link = await pgStore.readLink(teamId);
    if (link?.mode === "active")
      await runTeam(env, profileFor(env, "outside", teamId));
  };
  // Both sites publish and receive until neither has anything left.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await app.locals.sync.get(teamId).run();
      await drain();
    }
    await app.locals.sync.get(teamId).run();
  };
  ok(
    await outside("/auth/setup", {
      name: "Outside",
      setupToken: env.SETUP_TOKEN,
    }),
  );
  ok(
    await inside(
      `/admin/teams/${teamId}/connection`,
      { profileId: "inside", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await inside(`/teams/${teamId}/sync/enable`, {}));
  await app.locals.sync.get(teamId).run();
  ok(await inside(`/teams/${teamId}/sync/checkpoint`, {}));
  assert.equal(
    ok(await outside("/admin/sync/import", { teamId, profileId: "outside" }))
      .phase,
    "complete",
  );
  await drain();
  return {
    teamId,
    db,
    app,
    team,
    pgStore,
    github,
    phases,
    inside,
    outside,
    drain,
    settle,
    internalStore: () => app.locals.sync.store(teamId),
  };
}
