import { siteKeyMigrationSql } from "../scripts/site-key-migration-sql.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { openDatabase, json } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { createWorker } from "../worker/entry.mjs";
import { onRequest as pagesRequest } from "../functions/[[path]].js";
import { refreshDirectory } from "../worker/directory.mjs";
import { refreshSetupKeys } from "../worker/setup-keys.mjs";
import { portableHash } from "../server/storage/logical-format.mjs";
import { profiles } from "../worker/config.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
import {
  backupExternal,
  readExternalBackup,
  restoreExternal,
} from "../server/storage/external-backup.mjs";

const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
const skip = !existsSync(join(pgBin, "initdb"));
async function database(t) {
  const dir = mkdtempSync(join(tmpdir(), "gb-team-site-"));
  const data = join(dir, "pg");
  const command = (name, args) =>
    execFileSync(join(pgBin, name), args, { stdio: "pipe" });
  command("initdb", [
    "-D",
    data,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "-E",
    "UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-F -h '' -k ${dir} -p 5432`,
    "-w",
    "start",
  ]);
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(dir)}&port=5432`;
  const pool = new Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, pool, url };
}
test(
  "one-project site migration is atomic, repeatable and refuses a different team or an occupied legacy database",
  { skip },
  async (t) => {
    const { pool } = await database(t),
      teamId = randomUUID();
    const options = { scope: "site", initialize: true, teamId };
    await migratePostgres(pool, { ...options, dryRun: true });
    assert.equal(
      (await pool.query("SELECT to_regclass('graeboard_site.users') AS name"))
        .rows[0].name,
      null,
    );
    await assert.rejects(
      migratePostgres(pool, {
        ...options,
        afterDdl() {
          throw new Error("injected");
        },
      }),
      /injected/,
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('graeboard.team_meta') AS name"))
        .rows[0].name,
      null,
    );
    assert.equal((await migratePostgres(pool, options)).applied, true);
    assert.equal((await migratePostgres(pool, options)).applied, false);
    await assert.rejects(
      migratePostgres(pool, { ...options, teamId: randomUUID() }),
      /identity mismatch/,
    );
    assert.equal(
      (
        await new PostgresDatabase(pool, {
          scope: "control",
          site: true,
        }).health()
      ).ready,
      true,
    );
    assert.equal(
      (await new PostgresDatabase(pool, { teamId }).health()).ready,
      true,
    );
    await pool.query(
      "INSERT INTO graeboard_site.users(id,username,email,name,created_at) VALUES('kept','kept','kept','Keep','today')",
    );
    await assert.rejects(
      migratePostgres(pool, { scope: "control", initialize: true }),
      /scope\/version/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT name FROM graeboard_site.users WHERE id='kept'",
        )
      ).rows[0].name,
      "Keep",
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO graeboard_site.teams(id,name) VALUES($1,'foreign')",
        [randomUUID()],
      ),
      /foreign key/,
    );
  },
);

test(
  "existing team v1 gains a site schema without rewriting business data and rolls back an interrupted upgrade",
  { skip },
  async (t) => {
    const { pool } = await database(t),
      teamId = randomUUID();
    await migratePostgres(pool, {
      scope: "team",
      initialize: true,
      teamId,
      teamName: "Preserved",
    });
    const before = (await pool.query("SELECT * FROM graeboard.teams")).rows;
    await assert.rejects(
      migratePostgres(pool, {
        scope: "site",
        teamId,
        afterDdl() {
          throw new Error("interrupted");
        },
      }),
      /interrupted/,
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('graeboard_site.users') AS name"))
        .rows[0].name,
      null,
    );
    await assert.rejects(
      migratePostgres(pool, { scope: "site", teamId: randomUUID() }),
      /identity mismatch/,
    );
    await migratePostgres(pool, { scope: "site", teamId });
    assert.deepEqual(
      (await pool.query("SELECT * FROM graeboard.teams")).rows,
      before,
    );
    assert.equal(
      (await migratePostgres(pool, { scope: "site", teamId })).applied,
      false,
    );
  },
);

test(
  "internal team selection → one-project external Google approval → ongoing membership revocation through real Git and PostgreSQL",
  { skip, timeout: 120000 },
  async (t) => {
    const { dir, pool, url } = await database(t);
    const remote = join(dir, "remote.git"),
      teamId = randomUUID(),
      otherTeam = randomUUID();
    const lead = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID(),
      added = randomUUID();
    const sourceId = randomUUID(),
      siteId = randomUUID(),
      nativeFetch = globalThis.fetch;
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const github = githubEmulator(remote);
    const readme = github.text(["hash-object", "-w", "--stdin"], {
      input: "fixture",
    });
    const tree = github.text(["mktree"], {
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
      assert.equal(target.hostname, "127.0.0.1");
      return nativeFetch(input, init);
    };
    t.after(() => {
      globalThis.fetch = nativeFetch;
    });
    const db = openDatabase(join(dir, "internal.sqlite"));
    for (const [id, name] of [
      [teamId, "Shared team"],
      [otherTeam, "Private other team"],
    ])
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        id,
        name,
        json(DEFAULT_SETTINGS),
      );
    const tokens = new Map();
    for (const [id, team, role, systemRole] of [
      [lead, teamId, "lead", "user"],
      [member, teamId, "member", "admin"],
      [outsider, otherTeam, "lead", "admin"],
    ]) {
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'private-password-hash',?,?)",
      ).run(
        id,
        `${id}@internal.test`,
        id === outsider ? "Other team private name" : role,
        systemRole,
        new Date().toISOString(),
      );
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(id, team, role);
      const token = randomUUID();
      tokens.set(id, token);
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        id,
        Date.now() + 86400000,
      );
    }
    const transport = new GitCliTransport({
      directory: join(dir, "inside.git"),
      repository: remote,
      allowLocal: true,
    });
    const app = createApp({
      db,
      rateLimits: false,
      documentImagesDir: join(dir, "images"),
      syncOptions: {
        installationId: sourceId,
        profiles: [
          {
            profileId: "inside",
            teamId,
            repository: "fixture/team",
            peerInstallationId: siteId,
          },
        ],
        transports: { inside: transport },
        schedule: false,
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const work = [];
    t.after(async () => {
      await Promise.allSettled(work);
      await app.locals.sync.close();
      app.locals.cellEvents.close();
      app.locals.documentEvents.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    });
    const inside = async (
      path,
      body,
      method = body ? "POST" : "GET",
      actor = lead,
    ) => {
      const res = await nativeFetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method,
          headers: {
            Cookie: "weekly_session=" + tokens.get(actor),
            "Content-Type": "application/json",
            "X-Requested-With": "WeeklyPlan",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { status: res.status, body: unpack(await res.json()) };
    };
    const success = (value) => {
      assert.ok(value.status < 300, JSON.stringify(value));
      return value.body;
    };
    success(
      await inside(
        `/admin/teams/${teamId}/connection`,
        { profileId: "inside", expectedRevision: 0 },
        "PUT",
      ),
    );
    const task = success(
      await inside("/tasks", {
        teamId,
        year: 2026,
        fields: { title: "Team data" },
      }),
    ).task;
    success(await inside(`/teams/${teamId}/sync/enable`, {}));
    assert.equal(
      (await inside(`/teams/${teamId}/setup-key`, {}, "POST", member)).status,
      403,
    );
    assert.equal(
      (await inside(`/teams/${teamId}/setup-key`, {}, "POST", outsider)).status,
      403,
    );
    let issuedToken = success(
      await inside(`/teams/${teamId}/setup-key`, {}),
    ).token;
    const supersededToken = issuedToken;
    issuedToken = success(await inside(`/teams/${teamId}/setup-key`, {})).token;
    assert.doesNotMatch(
      JSON.stringify(success(await inside(`/teams/${teamId}/setup-key`))),
      /gbk_|tokenHash|token_hash/,
    );
    await app.locals.sync.get(teamId).run();
    const keyHead = await transport.readHead("sync-setup/" + sourceId);
    const keyJson = (await transport.readFile(keyHead, "keys.json")).toString();
    assert.ok(
      !keyJson.includes(issuedToken) && !keyJson.includes(supersededToken),
    );
    assert.equal(JSON.parse(keyJson).keys.length, 1);
    const head = await transport.readHead("sync-directory/" + sourceId);
    const directory = JSON.parse(
      (await transport.readFile(head, "directory.json")).toString(),
    );
    assert.deepEqual(
      new Set(directory.members.map((m) => m.id)),
      new Set([lead, member]),
    );
    assert.doesNotMatch(
      JSON.stringify(directory),
      /Other team private name|private-password-hash|system_role/,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM team_sync_links WHERE team_id=?")
        .get(otherTeam).n,
      0,
    );
    await migratePostgres(pool, { scope: "site", initialize: true, teamId });
    const profile = {
      profileId: "outside",
      teamId,
      repository: "fixture/team",
      databaseBinding: "PG_SITE",
      bucketBinding: "R2_TEAM",
      githubSecret: "GIT_TOKEN",
    };
    const env = {
      APP_ORIGIN: "https://graeboard.pages.dev",
      ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      ACCESS_AUDIENCE: "fixture",
      SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
      INSTALLATION_ID: siteId,
      PEER_INSTALLATION_ID: sourceId,
      SITE_TEAM_ID: teamId,
      PG_SITE: { connectionString: url },
      R2_TEAM: bucket(),
      GIT_TOKEN: "fixture-secret",
      SYNC_PROFILES: JSON.stringify([profile]),
    };
    assert.throws(() =>
      profiles({
        ...env,
        SYNC_PROFILES: JSON.stringify([
          profile,
          { ...profile, teamId: otherTeam },
        ]),
      }),
    );
    assert.throws(() => profiles({ ...env, SITE_TEAM_ID: otherTeam }));
    const errors = [],
      cookies = new Map();
    const worker = createWorker({
      verify: async (request) => ({
        issuer: env.ACCESS_ISSUER,
        subject: request.headers.get("test-google"),
        email: request.headers.get("test-google") + "@gmail.test",
        expiresAt: Date.now() + 3600000,
      }),
      onError: (error) => errors.push(error),
    });
    const outside = async (
      google,
      path,
      body,
      method = body ? "POST" : "GET",
      suppliedCookie,
    ) => {
      const response = await pagesRequest({
        request: new Request(env.APP_ORIGIN + "/api" + path, {
          method,
          headers: {
            "test-google": google,
            "X-Requested-With": "WeeklyPlan",
            "Content-Type": "application/json",
            Cookie: suppliedCookie ?? cookies.get(google) ?? "",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env: {
          GRAEBOARD_BACKEND: {
            fetch: (request) =>
              worker.fetch(request, env, {
                waitUntil: (promise) => work.push(promise),
              }),
          },
        },
      });
      if (response.headers.has("set-cookie"))
        cookies.set(google, response.headers.get("set-cookie").split(";")[0]);
      const result = {
        status: response.status,
        body: unpack(await response.json()),
      };
      if (response.status >= 500)
        throw errors.at(-1) || new Error(JSON.stringify(result));
      return result;
    };
    assert.deepEqual(
      success(await outside("lead-google", "/setup")).accounts.map((a) => a.id),
      [lead],
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: member,
          setupToken: issuedToken,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: supersededToken,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: env.SETUP_TOKEN,
        })
      ).status,
      403,
    );
    success(await inside(`/teams/${teamId}/setup-key`, undefined, "DELETE"));
    await app.locals.sync.get(teamId).run();
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: issuedToken,
        })
      ).status,
      403,
    );
    issuedToken = success(await inside(`/teams/${teamId}/setup-key`, {})).token;
    await app.locals.sync.get(teamId).run();
    await refreshSetupKeys(env);
    const keyId = issuedToken.split(".")[0].slice(4);
    const expiresAt = (
      await pool.query(
        "SELECT expires_at FROM graeboard_site.setup_link_keys WHERE id=$1",
        [keyId],
      )
    ).rows[0].expires_at;
    await pool.query(
      "UPDATE graeboard_site.setup_link_keys SET expires_at=$2 WHERE id=$1",
      [keyId, new Date(Date.now() - 1000).toISOString()],
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: issuedToken,
        })
      ).status,
      403,
    );
    await pool.query(
      "UPDATE graeboard_site.setup_link_keys SET expires_at=$2 WHERE id=$1",
      [keyId, expiresAt],
    );
    const parallel = await Promise.all(
      [1, 2].map(() =>
        outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: issuedToken,
        }),
      ),
    );
    assert.deepEqual(parallel.map((r) => r.status).sort(), [201, 409]);
    const linkedIdentity = (
      await pool.query(
        "SELECT * FROM graeboard_site.access_identities WHERE user_id=$1",
        [lead],
      )
    ).rows[0];
    await pool.query(
      "DELETE FROM graeboard_site.access_identities WHERE user_id=$1",
      [lead],
    );
    assert.equal(
      (
        await outside("lead-google", "/auth/setup", {
          userId: lead,
          setupToken: issuedToken,
        })
      ).status,
      403,
    );
    await pool.query(
      "INSERT INTO graeboard_site.access_identities VALUES($1,$2,$3)",
      [linkedIdentity.issuer, linkedIdentity.subject, lead],
    );
    await Promise.allSettled(work);
    await app.locals.sync.get(teamId).run();
    const consumed = success(await inside(`/teams/${teamId}/setup-key`)).key;
    assert.ok(consumed.usedAt && consumed.appliedAt);
    assert.equal(
      success(await outside("lead-google", "/bootstrap")).user.id,
      lead,
    );
    assert.equal((await outside("member-google", "/bootstrap")).status, 401);
    assert.equal(
      (
        await outside(
          "member-google",
          "/bootstrap",
          null,
          "GET",
          cookies.get("lead-google"),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await outside("member-google", "/auth/link-request", {
          userId: outsider,
        })
      ).status,
      400,
    );
    success(
      await outside("member-google", "/auth/link-request", { userId: member }),
    );
    assert.equal(
      (
        await outside("member-google", "/auth/select-account", {
          userId: member,
        })
      ).status,
      403,
    );
    let requests = success(
      await outside("lead-google", `/teams/${teamId}/access-requests`),
    ).requests.filter((r) => r.status === "pending");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].email, "member-google@gmail.test");
    success(
      await outside(
        "lead-google",
        `/teams/${teamId}/access-requests/${requests[0].id}/approve`,
        {},
      ),
    );
    success(
      await outside("member-google", "/auth/select-account", {
        userId: member,
      }),
    );
    assert.equal(
      success(await outside("member-google", "/bootstrap")).user.id,
      member,
    );
    assert.equal(
      success(await outside("member-google", "/bootstrap")).user.systemRole,
      "user",
    );
    const leadRequest = success(
      await outside("lead-google", `/teams/${teamId}/access-requests`),
    ).requests.find((r) => r.userId === lead);
    assert.equal(
      (
        await outside(
          "lead-google",
          `/teams/${teamId}/access-requests/${leadRequest.id}/reject`,
          {},
        )
      ).status,
      409,
    );
    success(
      await outside("lead-google", "/admin/sync/import", {
        teamId,
        profileId: "outside",
      }),
    );
    assert.equal(
      success(
        await outside("member-google", `/tasks?teamId=${teamId}&year=2026`),
      ).tasks[0].id,
      task.id,
    );
    assert.equal(
      (await outside("member-google", `/tasks?teamId=${otherTeam}&year=2026`))
        .status,
      403,
    );
    assert.equal(
      (await outside("member-google", `/teams/${teamId}/access-requests`))
        .status,
      403,
    );
    assert.equal(
      (
        await outside(
          "lead-google",
          `/teams/${teamId}/members`,
          { members: [] },
          "PUT",
        )
      ).status,
      403,
    );
    assert.equal(
      (await outside("lead-google", "/admin/teams", { name: "Foreign" }))
        .status,
      403,
    );
    await Promise.allSettled(work);
    const control = new PostgresDatabase(pool, {
      scope: "control",
      site: true,
    });
    const adapter = new PostgresDatabase(pool, { teamId });
    const images = {
      list: async () => [],
      read: async () => null,
      install: async () => {
        throw new Error("Unexpected image");
      },
    };
    const backup = join(dir, "backup");
    await backupExternal({
      control,
      teams: [{ adapter, teamId, images }],
      destination: backup,
    });
    const snapshot = await readExternalBackup(backup);
    assert.equal(snapshot.manifest.version, 3);
    assert.equal(snapshot.control.tables.access_requests.length, 2);
    assert.equal(snapshot.control.tables.access_sessions, undefined);
    await pool.query("CREATE DATABASE restored");
    const restoreUrl = new URL(url);
    restoreUrl.pathname = "/restored";
    const restoredPool = new Pool({ connectionString: restoreUrl.href });
    try {
      await migratePostgres(restoredPool, {
        scope: "site",
        initialize: true,
        teamId,
      });
      const restoredControl = new PostgresDatabase(restoredPool, {
        scope: "control",
        site: true,
      });
      const restoredTeam = new PostgresDatabase(restoredPool, { teamId });
      const options = {
        source: backup,
        control: restoredControl,
        teams: [
          {
            adapter: restoredTeam,
            teamId,
            images,
            profileId: "outside",
            installationId: siteId,
          },
        ],
      };
      await assert.rejects(
        restoreExternal({
          ...options,
          control: new PostgresDatabase(restoredPool, { scope: "control" }),
        }),
        /layouts/,
      );
      assert.equal(
        (await restoreExternal({ ...options, dryRun: true })).verified,
        true,
      );
      await restoreExternal(options);
      await restoreExternal(options);
      assert.equal(
        (
          await restoredPool.query(
            "SELECT count(*) n FROM graeboard_site.access_identities",
          )
        ).rows[0].n,
        "2",
      );
      assert.equal(
        (
          await restoredPool.query(
            "SELECT count(*) n FROM graeboard_site.access_sessions",
          )
        ).rows[0].n,
        "0",
      );
      assert.deepEqual(
        (
          await restoredPool.query(
            "SELECT entity_key,payload FROM graeboard.site_entities WHERE entity='task' ORDER BY entity_key",
          )
        ).rows,
        (
          await pool.query(
            "SELECT entity_key,payload FROM graeboard.site_entities WHERE entity='task' ORDER BY entity_key",
          )
        ).rows,
      );
    } finally {
      await restoredPool.end();
    }
    // Released site v2 backups have the same rows but no setup-key tables.
    const oldBackup = join(dir, "backup-v2");
    cpSync(backup, oldBackup, { recursive: true });
    const oldControl = JSON.parse(
      readFileSync(join(oldBackup, "control.json")),
    );
    delete oldControl.tables.setup_link_keys;
    delete oldControl.tables.setup_key_state;
    oldControl.hash = portableHash(oldControl.tables);
    writeFileSync(join(oldBackup, "control.json"), JSON.stringify(oldControl));
    const { hash: oldHash, ...oldManifest } = JSON.parse(
      readFileSync(join(oldBackup, "manifest.json")),
    );
    oldManifest.version = 2;
    oldManifest.control.hash = portableHash(oldControl);
    writeFileSync(
      join(oldBackup, "manifest.json"),
      JSON.stringify({ ...oldManifest, hash: portableHash(oldManifest) }),
    );
    await pool.query("CREATE DATABASE restored_v2");
    restoreUrl.pathname = "/restored_v2";
    const oldPool = new Pool({ connectionString: restoreUrl.href });
    try {
      await migratePostgres(oldPool, {
        scope: "site",
        initialize: true,
        teamId,
      });
      await restoreExternal({
        source: oldBackup,
        control: new PostgresDatabase(oldPool, {
          scope: "control",
          site: true,
        }),
        teams: [
          {
            adapter: new PostgresDatabase(oldPool, { teamId }),
            teamId,
            images,
            profileId: "outside",
            installationId: siteId,
          },
        ],
      });
      assert.equal(
        (
          await oldPool.query(
            "SELECT count(*) n FROM graeboard_site.access_identities",
          )
        ).rows[0].n,
        "2",
      );
      assert.equal(
        (
          await oldPool.query(
            "SELECT count(*) n FROM graeboard_site.setup_link_keys",
          )
        ).rows[0].n,
        "0",
      );
    } finally {
      await oldPool.end();
    }
    db.prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,'private-added-hash',?)",
    ).run(
      added,
      "added@internal.test",
      "Added member",
      new Date().toISOString(),
    );
    success(
      await inside(
        `/teams/${teamId}/members`,
        {
          members: [
            { userId: lead, role: "lead" },
            { userId: member, role: "member" },
            { userId: added, role: "member" },
          ],
        },
        "PUT",
      ),
    );
    await app.locals.sync.get(teamId).run();
    await refreshDirectory(env, { force: true });
    assert.ok(
      success(await outside("new-google", "/auth/accounts")).accounts.some(
        (a) => a.id === added,
      ),
    );
    assert.equal((await outside("new-google", "/bootstrap")).status, 401);
    success(
      await inside(
        `/teams/${teamId}/members`,
        {
          members: [
            { userId: lead, role: "lead" },
            { userId: member, role: "viewer" },
          ],
        },
        "PUT",
      ),
    );
    await app.locals.sync.get(teamId).run();
    await refreshDirectory(env, { force: true });
    assert.equal(
      success(await outside("member-google", "/bootstrap")).user.teamRoles[
        teamId
      ],
      "viewer",
    );
    assert.equal(
      (
        await outside("member-google", "/tasks", {
          teamId,
          year: 2026,
          fields: { title: "Denied" },
        })
      ).status,
      403,
    );
    success(
      await inside(
        `/teams/${teamId}/members`,
        { members: [{ userId: lead, role: "lead" }] },
        "PUT",
      ),
    );
    await app.locals.sync.get(teamId).run();
    await refreshDirectory(env, { force: true });
    assert.equal((await outside("member-google", "/bootstrap")).status, 401);
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*) n FROM graeboard_site.access_identities WHERE user_id=$1",
          [member],
        )
      ).rows[0].n,
      "0",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*) n FROM graeboard_site.users WHERE id=$1",
          [outsider],
        )
      ).rows[0].n,
      "0",
    );
    // Internal replacement of the sole linked lead removes approval power.
    // A new lead can recover the installation with its secret, without
    // granting the former lead or ordinary Google users automatic ownership.
    success(
      await inside(
        `/teams/${teamId}/members`,
        {
          members: [
            { userId: lead, role: "viewer" },
            { userId: added, role: "lead" },
            { userId: member, role: "member" },
          ],
        },
        "PUT",
      ),
    );
    await app.locals.sync.get(teamId).run();
    await refreshDirectory(env, { force: true });
    assert.equal(
      success(await outside("lead-google", "/bootstrap")).user.systemRole,
      "user",
    );
    assert.equal(
      (await outside("lead-google", `/teams/${teamId}/access-requests`)).status,
      403,
    );
    assert.equal(
      (
        await outside("member-google", "/auth/select-account", {
          userId: member,
        })
      ).status,
      403,
    );
    assert.deepEqual(
      success(await outside("new-google", "/setup")).accounts.map((a) => a.id),
      [added],
    );
    assert.equal(
      (
        await outside("new-google", "/auth/setup", {
          userId: added,
          setupToken: "wrong",
        })
      ).status,
      403,
    );
    const newLeaderSession = randomUUID();
    tokens.set(added, newLeaderSession);
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(newLeaderSession).digest("hex"),
      added,
      Date.now() + 86400000,
    );
    issuedToken = success(
      await inside(`/teams/${teamId}/setup-key`, {}, "POST", added),
    ).token;
    await app.locals.sync.get(teamId).run();
    success(
      await outside("new-google", "/auth/setup", {
        userId: added,
        setupToken: issuedToken,
      }),
    );
    success(
      await outside("member-google", "/auth/link-request", { userId: member }),
    );
    requests = success(
      await outside("new-google", `/teams/${teamId}/access-requests`),
    ).requests.filter((r) => r.status === "pending");
    success(
      await outside(
        "new-google",
        `/teams/${teamId}/access-requests/${requests[0].id}/approve`,
        {},
      ),
    );
    success(
      await outside("member-google", "/auth/select-account", {
        userId: member,
      }),
    );
    success(
      await inside(
        `/admin/users/${member}`,
        { name: "member", active: false },
        "PATCH",
        outsider,
      ),
    );
    // Business synchronization pause must still allow directory revocation.
    success(await inside(`/teams/${teamId}/sync/pause`, {}, "POST", outsider));
    await refreshDirectory(env, { force: true });
    assert.equal((await outside("member-google", "/bootstrap")).status, 401);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 31);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      db.prepare("SELECT name FROM teams WHERE id=?").get(otherTeam).name,
      "Private other team",
    );
    assert.deepEqual(github.unexpectedCalls, []);
  },
);

test(
  "site v1 -> v2 SQL and CLI preserve identity/approvals, roll back failure and reject foreign sites",
  { skip },
  async (t) => {
    const { pool } = await database(t),
      teamId = randomUUID();
    await migratePostgres(pool, { scope: "site", initialize: true, teamId });
    await pool.query(
      "DROP TABLE graeboard_site.setup_link_keys,graeboard_site.setup_key_state; DELETE FROM graeboard_site.schema_migrations WHERE version=2",
    );
    await pool.query(
      "INSERT INTO graeboard_site.users(id,username,email,name,created_at) VALUES('lead','lead','lead','Kept','today'); INSERT INTO graeboard_site.access_identities VALUES('issuer','subject','lead')",
    );
    const before = (
      await pool.query("SELECT * FROM graeboard_site.access_identities")
    ).rows;
    await assert.rejects(
      migratePostgres(pool, {
        scope: "site",
        teamId,
        afterDdl() {
          throw new Error("injected31");
        },
      }),
      /injected31/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT to_regclass('graeboard_site.setup_link_keys') AS name",
        )
      ).rows[0].name,
      null,
    );
    await migratePostgres(pool, { scope: "site", teamId, dryRun: true });
    assert.equal(
      (
        await pool.query(
          "SELECT MAX(version) AS v FROM graeboard_site.schema_migrations",
        )
      ).rows[0].v,
      1,
    );
    const client = await pool.connect();
    try {
      await assert.rejects(
        client.query(siteKeyMigrationSql(randomUUID())),
        /identity mismatch/,
      );
      await client.query("ROLLBACK");
      await client.query(siteKeyMigrationSql(teamId));
      await client.query(siteKeyMigrationSql(teamId));
    } finally {
      client.release();
    }
    assert.deepEqual(
      (await pool.query("SELECT * FROM graeboard_site.access_identities")).rows,
      before,
    );
    assert.equal(
      (await migratePostgres(pool, { scope: "site", teamId })).to,
      2,
    );
  },
);
