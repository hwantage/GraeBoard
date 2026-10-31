import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { once } from "node:events";
import { openDatabase } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { unpack } from "../shared/compact.js";
import {
  createSyncSetupConfig,
  patchSyncEnv,
} from "../server/sync/setup-config.mjs";
import { tokenPreview } from "../server/sync/credentials.mjs";
import {
  setupExamples,
  setupStep,
  validateSetupStep,
  syncVerification,
} from "../shared/sync-setup.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-setup-"));
  const path = join(dir, ".env");
  const db = openDatabase(join(dir, "test.sqlite"));
  const savedEnv = Object.fromEntries(
    [
      "GRAEBOARD_SYNC_KEY",
      "GRAEBOARD_SYNC_KEY_ID",
      "GRAEBOARD_SYNC_PROFILES",
      "GRAEBOARD_INSTALLATION_ID",
    ].map((key) => [key, process.env[key]]),
  );
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  let app,
    server,
    cookie = "";
  async function start(values = {}) {
    if (server) {
      await app.locals.sync.close();
      app.locals.cellEvents.close();
      app.locals.documentEvents.close();
      await new Promise((resolve) => server.close(resolve));
    }
    app = createApp({
      db,
      rateLimits: false,
      documentImagesDir: join(dir, "images"),
      syncOptions: {
        profiles: [],
        schedule: false,
        setupConfigPath: path,
        ...values,
      },
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  await start();
  async function api(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          cookie,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, data: unpack(await response.json()) };
  }
  const { data } = await api("/auth/setup", {
    username: "setup@example.com",
    password: "test-password-setup",
    name: "설정 관리자",
    teamName: "설정팀",
  });
  const teamId = data.user.teamIds[0],
    userId = data.user.id;
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { db, path, api, teamId, userId, start, sync: () => app.locals.sync };
}

test("setup API preserves dotenv, teams and identities across save, reopen and restart", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    f.path,
    "# operator settings\nDB_PATH='/keep/database.sqlite'\nDOCUMENT_IMAGES_DIR=/keep/images\nUNRELATED_SECRET=do-not-return\n",
  );
  const route = `/admin/teams/${f.teamId}/sync-setup`;
  const initial = await f.api(route);
  const saved = await f.api(
    route,
    {
      repository: "https://github.com/example/team-a",
      expectedRevision: initial.data.revision,
    },
    "PUT",
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.restartRequired, true);
  assert.equal(saved.data.installed, false);
  assert.doesNotMatch(
    JSON.stringify(saved.data),
    /do-not-return|GRAEBOARD_SYNC_KEY/,
  );
  const first = parseEnv(readFileSync(f.path, "utf8"));
  assert.equal(first.DB_PATH, "/keep/database.sqlite");
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.match(readFileSync(f.path, "utf8"), /# operator settings/);
  assert.equal(Buffer.from(first.GRAEBOARD_SYNC_KEY, "base64").length, 32);
  assert.deepEqual((await f.api(route)).data, saved.data);
  assert.equal(
    (
      await f.api(
        route,
        {
          repository: "https://github.com/example/team-a",
          expectedRevision: saved.data.revision,
        },
        "PUT",
      )
    ).status,
    200,
  );
  const teamB = (await f.api("/admin/teams", { name: "두 번째 팀" })).data.id;
  const routeB = `/admin/teams/${teamB}/sync-setup`;
  assert.equal(
    (
      await f.api(
        routeB,
        {
          repository: "https://github.com/example/team-b",
          expectedRevision: initial.data.revision,
        },
        "PUT",
      )
    ).status,
    409,
  );
  const revB = (await f.api(routeB)).data.revision;
  assert.equal(
    (
      await f.api(
        routeB,
        {
          repository: "https://github.com/example/team-a.git",
          expectedRevision: revB,
        },
        "PUT",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api(
        routeB,
        {
          repository: "https://github.com/example/team-b",
          expectedRevision: revB,
        },
        "PUT",
      )
    ).status,
    200,
  );
  const second = parseEnv(readFileSync(f.path, "utf8"));
  assert.equal(
    second.GRAEBOARD_INSTALLATION_ID,
    first.GRAEBOARD_INSTALLATION_ID,
  );
  assert.equal(second.GRAEBOARD_SYNC_KEY, first.GRAEBOARD_SYNC_KEY);
  assert.deepEqual(
    JSON.parse(second.GRAEBOARD_SYNC_PROFILES)[0],
    JSON.parse(first.GRAEBOARD_SYNC_PROFILES)[0],
  );
  process.env.GRAEBOARD_SYNC_KEY = second.GRAEBOARD_SYNC_KEY;
  await f.start({
    profiles: JSON.parse(second.GRAEBOARD_SYNC_PROFILES),
    installationId: second.GRAEBOARD_INSTALLATION_ID,
  });
  const restarted = (await f.api(route)).data;
  assert.equal(restarted.installed, true);
  assert.equal(restarted.restartRequired, false);
  assert.deepEqual(restarted.profile, saved.data.profile);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM team_sync_links").get().n,
    0,
  );
});

test("setup rejects injected URLs, missing encryption keys, environment overrides and existing history", async (t) => {
  const f = await fixture(t),
    route = `/admin/teams/${f.teamId}/sync-setup`;
  const revision = (await f.api(route)).data.revision;
  for (const repository of [
    "https://token@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "file:///tmp/repo",
    "https://github.com/a/../b",
    "https://github.com/a/b\nGRAEBOARD_SYNC_KEY=bad",
  ]) {
    assert.equal(
      (await f.api(route, { repository, expectedRevision: revision }, "PUT"))
        .status,
      400,
    );
  }
  f.db
    .prepare("INSERT INTO sync_credentials VALUES(?,?,?)")
    .run("old", "old-ciphertext", new Date().toISOString());
  const body = {
    repository: "https://github.com/a/team",
    expectedRevision: revision,
  };
  assert.equal((await f.api(route, body, "PUT")).status, 409);
  assert.equal(
    f.db.prepare("SELECT ciphertext FROM sync_credentials").get().ciphertext,
    "old-ciphertext",
  );
  const config = createSyncSetupConfig({
    db: f.db,
    sync: f.sync(),
    path: f.path,
    env: { GRAEBOARD_INSTALLATION_ID: randomUUID() },
  });
  assert.throws(() => config.save(f.teamId, body), /서비스 환경/);
});

test("credential API enforces admin/team scope, encrypts and invalidates only an idle team's cache", async (t) => {
  const f = await fixture(t),
    installationId = randomUUID();
  process.env.GRAEBOARD_SYNC_KEY = randomBytes(32).toString("base64");
  const profiles = [
    { profileId: "a", teamId: f.teamId, repository: "test/team-a" },
  ];
  await f.start({ profiles, installationId });
  const credential = `/admin/teams/${f.teamId}/sync-credential`;
  assert.equal(
    (
      await f.api(
        credential,
        { profileId: "foreign", token: "fixture_token" },
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.api(credential, { profileId: "a", token: "fixture_token" }, "PUT"))
      .status,
    200,
  );
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  const oldService = f.sync().get(f.teamId),
    link = { ...f.sync().store(f.teamId).readLink() };
  assert.equal(oldService.transport.token, "fixture_token");
  f.db
    .prepare("UPDATE team_sync_links SET lease_owner='busy' WHERE team_id=?")
    .run(f.teamId);
  assert.equal(
    (
      await f.api(
        credential,
        { profileId: "a", token: "replacement_token" },
        "PUT",
      )
    ).status,
    409,
  );
  f.db
    .prepare("UPDATE team_sync_links SET lease_owner=NULL WHERE team_id=?")
    .run(f.teamId);
  const saved = await f.api(
    credential,
    { profileId: "a", token: "replacement_token" },
    "PUT",
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, { ok: true });
  assert.equal(f.sync().get(f.teamId).transport.token, "replacement_token");
  assert.notEqual(f.sync().get(f.teamId), oldService);
  assert.deepEqual({ ...f.sync().store(f.teamId).readLink() }, link);
  assert.doesNotMatch(
    f.db.prepare("SELECT ciphertext FROM sync_credentials").get().ciphertext,
    /replacement_token|fixture_token/,
  );
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.userId);
  assert.equal(
    (await f.api(credential, { profileId: "a", token: "forbidden" }, "PUT"))
      .status,
    403,
  );
  assert.equal(
    (await f.api(`/admin/teams/${f.teamId}/sync-setup`)).status,
    403,
  );
});

test("connection check names a missing internal token and setup reports an environment token", async (t) => {
  const f = await fixture(t),
    tokenEnv = "GRAEBOARD_SETUP_TEST_TOKEN";
  t.after(() => delete process.env[tokenEnv]);
  process.env.GRAEBOARD_SYNC_KEY = randomBytes(32).toString("base64");
  await f.start({
    profiles: [
      {
        profileId: "a",
        teamId: f.teamId,
        repository: "test/team-a",
        tokenEnv,
      },
    ],
    installationId: randomUUID(),
  });
  const setupRoute = `/admin/teams/${f.teamId}/sync-setup`;
  const before = (await f.api(setupRoute)).data;
  assert.equal(before.credentialStored, false);
  assert.equal(before.tokenEnvironment, false);
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  const missing = await f.api(`/teams/${f.teamId}/sync/check`, {});
  assert.equal(missing.status, 409);
  assert.match(missing.data.error, /내부 GitHub 토큰이 등록되지 않았습니다/);
  process.env[tokenEnv] = "environment_token";
  assert.equal((await f.api(setupRoute)).data.tokenEnvironment, true);
  f.sync().clear(f.teamId);
  assert.equal(f.sync().get(f.teamId).transport.token, "environment_token");
});

test("setup shows only a token prefix and deletes the stored credential of an idle team", async (t) => {
  assert.equal(
    tokenPreview("ghp_" + "x".repeat(10) + "y".repeat(26)),
    "ghp_" + "x".repeat(10),
  );
  assert.equal(tokenPreview("short_token"), "short");
  assert.equal(tokenPreview(undefined), "");
  const f = await fixture(t);
  process.env.GRAEBOARD_SYNC_KEY = randomBytes(32).toString("base64");
  await f.start({
    profiles: [{ profileId: "a", teamId: f.teamId, repository: "test/team-a" }],
    installationId: randomUUID(),
  });
  const credential = `/admin/teams/${f.teamId}/sync-credential`,
    setupRoute = `/admin/teams/${f.teamId}/sync-setup`,
    token = "github_pat_11ABCDEFGH" + "0".repeat(12) + "_" + "s".repeat(59);
  assert.equal(
    (await f.api(credential, { profileId: "a", token }, "PUT")).status,
    200,
  );
  const stored = (await f.api(setupRoute)).data;
  assert.equal(stored.credentialStored, true);
  assert.equal(stored.tokenPreview, "github_pat_11ABCDEFGH");
  assert.doesNotMatch(JSON.stringify(stored), /s{20}/);
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(f.sync().get(f.teamId).transport.token, token);
  f.db
    .prepare("UPDATE team_sync_links SET lease_owner='busy' WHERE team_id=?")
    .run(f.teamId);
  assert.equal(
    (await f.api(credential, { profileId: "a" }, "DELETE")).status,
    409,
  );
  f.db
    .prepare("UPDATE team_sync_links SET lease_owner=NULL WHERE team_id=?")
    .run(f.teamId);
  const link = { ...f.sync().store(f.teamId).readLink() };
  const deleted = await f.api(credential, { profileId: "a" }, "DELETE");
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { ok: true });
  assert.equal(f.db.prepare("SELECT 1 FROM sync_credentials").get(), undefined);
  const after = (await f.api(setupRoute)).data;
  assert.equal(after.credentialStored, false);
  assert.equal(after.tokenPreview, "");
  assert.equal(f.sync().get(f.teamId).transport.token, undefined);
  assert.deepEqual({ ...f.sync().store(f.teamId).readLink() }, link);
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.userId);
  assert.equal(
    (await f.api(credential, { profileId: "a" }, "DELETE")).status,
    403,
  );
});

test("a disconnected team's sync history resets so its repository can change and connect anew", async (t) => {
  const f = await fixture(t),
    syncDir = join(tmpdir(), `graeboard-reset-${randomUUID()}`),
    savedDir = process.env.GRAEBOARD_SYNC_DIR,
    key = randomBytes(32).toString("base64");
  process.env.GRAEBOARD_SYNC_DIR = syncDir;
  process.env.GRAEBOARD_SYNC_KEY = key;
  t.after(() => {
    if (savedDir === undefined) delete process.env.GRAEBOARD_SYNC_DIR;
    else process.env.GRAEBOARD_SYNC_DIR = savedDir;
    rmSync(syncDir, { recursive: true, force: true });
  });
  writeFileSync(f.path, `GRAEBOARD_SYNC_KEY=${key}\n`);
  await f.start({
    profiles: [
      {
        profileId: "a",
        teamId: f.teamId,
        repository: "https://github.com/example/old-data",
        peerInstallationId: randomUUID(),
      },
    ],
    installationId: randomUUID(),
  });
  const task = await f.api("/tasks", {
    teamId: f.teamId,
    year: 2026,
    fields: { title: "보존할 업무" },
  });
  assert.equal(task.status, 201);
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/sync-credential`,
        { profileId: "a", token: "github_pat_" + "o".repeat(40) },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  const reset = `/admin/teams/${f.teamId}/sync-reset`,
    oldLink = { ...f.sync().store(f.teamId).readLink() };
  assert.equal((await f.api(reset, { confirmed: true })).status, 409);
  f.db
    .prepare("UPDATE team_sync_links SET mode='disconnected' WHERE team_id=?")
    .run(f.teamId);
  assert.equal((await f.api(reset, {})).status, 400);
  f.db
    .prepare(
      "INSERT INTO sync_conflicts(team_id,conflict_id,op_id,payload) VALUES(?,?,?,?)",
    )
    .run(f.teamId, "c1", "o1", "{}");
  assert.equal((await f.api(reset, { confirmed: true })).status, 409);
  f.db.prepare("UPDATE sync_conflicts SET resolution='current'").run();
  f.db
    .prepare(
      "INSERT INTO site_retention(team_id,site_id,kind,entity_key,revision,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(f.teamId, "site", "year", "2025", 1, new Date().toISOString());
  assert.equal((await f.api(reset, { confirmed: true })).status, 409);
  f.db.prepare("DELETE FROM site_retention").run();
  f.db
    .prepare(
      "INSERT INTO sync_entities(team_id,entity,entity_key,generation,version,payload) VALUES(?,?,?,?,?,?)",
    )
    .run(f.teamId, "task", "k", "g", "v", "{}");
  f.db
    .prepare(
      "INSERT INTO sync_outbox(op_id,team_id,payload,created_at) VALUES(?,?,?,?)",
    )
    .run("op", f.teamId, "{}", new Date().toISOString());
  mkdirSync(join(syncDir, "a"), { recursive: true });
  const done = await f.api(reset, { confirmed: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  for (const table of [
    "team_sync_links",
    "sync_entities",
    "sync_outbox",
    "sync_conflicts",
  ])
    assert.equal(
      f.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE team_id=?`)
        .get(f.teamId).n,
      0,
      table,
    );
  assert.equal(existsSync(join(syncDir, "a")), false);
  // A token issued for the old repository must not carry over to the new one.
  assert.equal(f.db.prepare("SELECT 1 FROM sync_credentials").get(), undefined);
  assert.equal(
    (await f.api(`/admin/teams/${f.teamId}/sync-setup`)).data.tokenPreview,
    "",
  );
  assert.ok(
    f.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(task.data.task.id),
  );
  const entry = f.db
    .prepare("SELECT team_id,target,before_json FROM audit WHERE action=?")
    .get("sync-reset");
  assert.equal(entry.team_id, null);
  assert.equal(entry.target, f.teamId);
  assert.equal(
    JSON.parse(entry.before_json).repository,
    "https://github.com/example/old-data",
  );
  const route = `/admin/teams/${f.teamId}/sync-setup`;
  const changed = await f.api(
    route,
    {
      repository: "https://github.com/example/new-data",
      expectedRevision: (await f.api(route)).data.revision,
    },
    "PUT",
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(
    f.sync().profiles.find((p) => p.teamId === f.teamId).repository,
    "https://github.com/example/new-data",
  );
  assert.equal(
    (
      await f.api(
        `/admin/teams/${f.teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  assert.notEqual(f.sync().store(f.teamId).readLink().repo_id, oldLink.repo_id);
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.userId);
  assert.equal((await f.api(reset, { confirmed: true })).status, 403);
});

test("only system administrators receive the team's external DB initialization SQL", async (t) => {
  const f = await fixture(t),
    route = `/admin/teams/${f.teamId}/external-db-sql`;
  const response = await f.api(route);
  assert.equal(response.status, 200);
  assert.ok(
    response.data.sql.includes(
      `INSERT INTO graeboard.team_meta VALUES(1,'${f.teamId}');`,
    ),
  );
  assert.ok(response.data.sql.includes("'설정팀'"));
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.userId);
  assert.equal((await f.api(route)).status, 403);
});

test("setup targets the linked replacement profile rather than the original credential", async (t) => {
  const f = await fixture(t);
  const original = {
    profileId: "original",
    teamId: f.teamId,
    repository: "test/original",
    peerInstallationId: randomUUID(),
  };
  const replacement = {
    ...original,
    profileId: "replacement",
    repository: "test/replacement",
    replaces: "original",
  };
  await f.start({
    profiles: [original, replacement],
    installationId: randomUUID(),
  });
  f.sync().store(f.teamId).writeLink({
    repo_id: randomUUID(),
    bootstrap_id: randomUUID(),
    installation_id: f.sync().installationId,
    writer_epoch: randomUUID(),
    profile_id: "replacement",
    mode: "recovery",
    updated_at: new Date().toISOString(),
  });
  const state = await f.api(`/admin/teams/${f.teamId}/sync-setup`);
  assert.equal(state.status, 200);
  assert.equal(state.data.profile.profileId, "replacement");
  assert.equal(state.data.profile.repository, "test/replacement");
});

test("staged profile correction preserves IDs and key; existing connection history prevents edits", async (t) => {
  const f = await fixture(t),
    route = `/admin/teams/${f.teamId}/sync-setup`;
  const initial = (await f.api(route)).data;
  const saved = (
    await f.api(
      route,
      {
        repository: "https://github.com/example/typo",
        expectedRevision: initial.revision,
      },
      "PUT",
    )
  ).data;
  const key = parseEnv(readFileSync(f.path, "utf8")).GRAEBOARD_SYNC_KEY;
  const corrected = await f.api(
    route,
    {
      repository: "https://github.com/example/correct",
      expectedRevision: saved.revision,
    },
    "PUT",
  );
  assert.equal(corrected.status, 200);
  assert.equal(
    corrected.data.profile.repository,
    "https://github.com/example/correct",
  );
  assert.equal(
    corrected.data.profile.peerInstallationId,
    saved.profile.peerInstallationId,
  );
  assert.equal(corrected.data.installationId, saved.installationId);
  assert.equal(parseEnv(readFileSync(f.path, "utf8")).GRAEBOARD_SYNC_KEY, key);
  f.sync().store(f.teamId).writeLink({
    repo_id: randomUUID(),
    bootstrap_id: randomUUID(),
    installation_id: saved.installationId,
    writer_epoch: randomUUID(),
    profile_id: saved.profile.profileId,
    mode: "paused",
    updated_at: new Date().toISOString(),
  });
  assert.equal(
    (
      await f.api(
        route,
        {
          repository: "https://github.com/example/replace",
          expectedRevision: corrected.data.revision,
        },
        "PUT",
      )
    ).status,
    409,
  );
  assert.equal(parseEnv(readFileSync(f.path, "utf8")).GRAEBOARD_SYNC_KEY, key);
});

test("dotenv patch refuses multiline/duplicate targets and preserves unrelated multiline values", () => {
  const profiles = [
    { profileId: "old", name: "Team's profile", repository: "example/old" },
  ];
  assert.deepEqual(
    JSON.parse(
      parseEnv(
        patchSyncEnv("", { GRAEBOARD_SYNC_PROFILES: JSON.stringify(profiles) }),
      ).GRAEBOARD_SYNC_PROFILES,
    ),
    profiles,
  );
  assert.throws(
    () =>
      patchSyncEnv("GRAEBOARD_SYNC_PROFILES='[\n]'", {
        GRAEBOARD_SYNC_PROFILES: "[]",
      }),
    /여러 줄/,
  );
  assert.throws(
    () =>
      patchSyncEnv("GRAEBOARD_SYNC_PROFILES=[]\nGRAEBOARD_SYNC_PROFILES=[]", {
        GRAEBOARD_SYNC_PROFILES: "[]",
      }),
    /중복/,
  );
  const text = "UNRELATED='line1\nline2'\n# keep\n";
  assert.equal(
    parseEnv(patchSyncEnv(text, { GRAEBOARD_SYNC_PROFILES: "[]" })).UNRELATED,
    "line1\nline2",
  );
});

test("setup examples separate external secrets and bind the exact team and persistent identities", () => {
  const team = { id: randomUUID(), name: "팀 '$(touch nope)'" };
  const setup = {
    installationId: randomUUID(),
    profile: { profileId: "existing", peerInstallationId: randomUUID() },
  };
  const draft = {
    repository: "https://github.com/example/data.git",
    appOrigin: "https://team.pages.dev",
    issuer: "https://company.cloudflareaccess.com",
    audience: "a".repeat(64),
    bucket: "team-images",
    gateway: "team-gateway",
    projectRef: "a".repeat(20),
    accountId: "c".repeat(32),
  };
  for (const step of Object.values(setupStep))
    assert.equal(validateSetupStep(step, draft), "");
  assert.match(
    validateSetupStep(setupStep.repository, {
      ...draft,
      repository: "https://github.com/example",
    }),
    /GitHub 저장소 주소/,
  );
  assert.match(
    validateSetupStep(setupStep.cloudflare, {
      ...draft,
      appOrigin: "https://password@team.pages.dev",
    }),
    /HTTPS/,
  );
  assert.match(
    validateSetupStep(setupStep.supabase, { ...draft, projectRef: "short" }),
    /Reference ID/,
  );
  assert.match(
    validateSetupStep(setupStep.deploy, {
      ...draft,
      accountId: "c".repeat(31),
    }),
    /Account ID/,
  );
  const examples = setupExamples(team, setup, draft),
    profiles = JSON.parse(examples.edge.SYNC_PROFILES);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].teamId, team.id);
  assert.equal(profiles[0].repository, "example/data");
  assert.equal(profiles[0].databaseBinding, "PG_SITE");
  assert.equal(examples.edge.INSTALLATION_ID, setup.profile.peerInstallationId);
  assert.equal(examples.edge.PEER_INSTALLATION_ID, setup.installationId);
  assert.equal(JSON.parse(examples.gateway).vars.SITE_TEAM_ID, team.id);
  assert.deepEqual(JSON.parse(examples.gateway).triggers.crons, []);
  assert.equal(examples.edge.GIT_TEAM, undefined);
  // The fork's single variable carries the deploy targets and both configs;
  // the workflow adds the Worker address and keys itself.
  const site = JSON.parse(examples.siteConfig);
  assert.equal(site.cloudflareAccountId, "c".repeat(32));
  assert.equal(site.supabaseProjectRef, "a".repeat(20));
  assert.deepEqual(site.gateway, JSON.parse(examples.gateway));
  assert.deepEqual(site.edge, examples.edge);
  assert.equal(site.edge.RESOURCE_ORIGIN, undefined);
});

test("completion requires fresh verified matching peer receipt, no pending/error/conflict and active mode", () => {
  const now = Date.now();
  const status = {
    mode: "active",
    canonicalHead: "current",
    pending: 0,
    conflicts: 0,
    remoteStatus: {
      verified: true,
      mode: "active",
      appliedCanonicalHead: "current",
      observedAt: new Date(now).toISOString(),
    },
  };
  assert.equal(syncVerification(status, now), true);
  for (const patch of [
    { pending: 1 },
    { conflicts: 1 },
    { lastError: "failed" },
    { mode: "paused" },
    { canonicalHead: "newer" },
  ])
    assert.equal(syncVerification({ ...status, ...patch }, now), false);
  assert.equal(syncVerification(status, now + 180001), false);
  assert.equal(
    syncVerification(
      { ...status, remoteStatus: { ...status.remoteStatus, verified: false } },
      now,
    ),
    false,
  );
});

test("profiles saved after an env-file restart apply immediately and keep saving without another restart", async (t) => {
  const f = await fixture(t),
    route = `/admin/teams/${f.teamId}/sync-setup`;
  const initial = (await f.api(route)).data;
  const first = (
    await f.api(
      route,
      {
        repository: "https://github.com/example/first",
        expectedRevision: initial.revision,
      },
      "PUT",
    )
  ).data;
  // The first installation identity is only loaded by a restart.
  assert.equal(first.restartRequired, true);
  assert.equal(first.installed, false);
  assert.equal(f.sync().profiles.length, 0);
  // Reproduce `node --env-file-if-exists=.env`: the service environment now
  // carries the file values and the sync module reads them.
  const env = parseEnv(readFileSync(f.path, "utf8"));
  for (const key of Object.keys(env))
    if (key.startsWith("GRAEBOARD_")) process.env[key] = env[key];
  await f.start({ profiles: undefined, installationId: undefined });
  assert.equal((await f.api(route)).data.restartRequired, false);
  assert.equal((await f.api(route)).data.installed, true);
  const teamB = (await f.api("/admin/teams", { name: "둘째 팀" })).data.id;
  const routeB = `/admin/teams/${teamB}/sync-setup`;
  const savedB = await f.api(
    routeB,
    {
      repository: "https://github.com/example/second",
      expectedRevision: (await f.api(routeB)).data.revision,
    },
    "PUT",
  );
  assert.equal(savedB.status, 200);
  assert.equal(savedB.data.installed, true);
  assert.equal(savedB.data.restartRequired, false);
  assert.equal(
    f.sync().profiles.find((p) => p.teamId === teamB)?.repository,
    "https://github.com/example/second",
  );
  // Correcting a never-connected profile updates the running profile in place.
  const corrected = await f.api(
    routeB,
    {
      repository: "https://github.com/example/second-fixed",
      expectedRevision: savedB.data.revision,
    },
    "PUT",
  );
  assert.equal(corrected.status, 200);
  assert.deepEqual(
    {
      ...corrected.data.profile,
      repository: savedB.data.profile.repository,
    },
    savedB.data.profile,
  );
  assert.equal(f.sync().profiles.filter((p) => p.teamId === teamB).length, 1);
  assert.equal(
    f.sync().profiles.find((p) => p.teamId === teamB).repository,
    "https://github.com/example/second-fixed",
  );
  const file = parseEnv(readFileSync(f.path, "utf8"));
  assert.equal(JSON.parse(file.GRAEBOARD_SYNC_PROFILES).length, 2);
  assert.equal(file.GRAEBOARD_INSTALLATION_ID, env.GRAEBOARD_INSTALLATION_ID);
  assert.equal(file.GRAEBOARD_SYNC_KEY, env.GRAEBOARD_SYNC_KEY);
  // A third team also saves without a restart in between.
  const teamC = (await f.api("/admin/teams", { name: "셋째 팀" })).data.id;
  const routeC = `/admin/teams/${teamC}/sync-setup`;
  assert.equal(
    (
      await f.api(
        routeC,
        {
          repository: "https://github.com/example/third",
          expectedRevision: (await f.api(routeC)).data.revision,
        },
        "PUT",
      )
    ).status,
    200,
  );
  // Token storage and the connection use the applied profile immediately.
  assert.equal(
    (
      await f.api(
        `/admin/teams/${teamB}/sync-credential`,
        { profileId: corrected.data.profile.profileId, token: "fixture_token" },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        `/admin/teams/${teamB}/connection`,
        { profileId: corrected.data.profile.profileId, expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        routeB,
        {
          repository: "https://github.com/example/other",
          expectedRevision: (await f.api(routeB)).data.revision,
        },
        "PUT",
      )
    ).status,
    409,
  );
  // A real service override still differs from what this process loaded.
  process.env.GRAEBOARD_SYNC_PROFILES = "[]";
  const teamD = (await f.api("/admin/teams", { name: "넷째 팀" })).data.id;
  const routeD = `/admin/teams/${teamD}/sync-setup`;
  assert.match(
    (
      await f.api(
        routeD,
        {
          repository: "https://github.com/example/fourth",
          expectedRevision: (await f.api(routeD)).data.revision,
        },
        "PUT",
      )
    ).data.error,
    /서비스 환경/,
  );
  // The file written during the session boots a real restart with all teams.
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(f.path, "utf8")),
  ))
    if (key.startsWith("GRAEBOARD_")) process.env[key] = value;
  await f.start({ profiles: undefined, installationId: undefined });
  assert.deepEqual(
    f
      .sync()
      .profiles.map((p) => p.teamId)
      .sort(),
    [f.teamId, teamB, teamC].sort(),
  );
  assert.equal((await f.api(routeB)).data.installed, true);
});

test("setup refuses a profile list that would not boot and reports an unwritable file", async (t) => {
  const f = await fixture(t);
  // An operator-edited profile that the service would reject at startup must
  // not be written back, and must not be applied to the running service.
  const text =
    'GRAEBOARD_SYNC_PROFILES=\'[{"profileId":"bad id!","teamId":"other","repository":"example/x"}]\'\n';
  writeFileSync(f.path, text);
  await f.start({ installationId: randomUUID() });
  const route = `/admin/teams/${f.teamId}/sync-setup`;
  const rejected = await f.api(
    route,
    {
      repository: "https://github.com/example/new",
      expectedRevision: (await f.api(route)).data.revision,
    },
    "PUT",
  );
  assert.equal(rejected.status, 409);
  assert.match(rejected.data.error, /프로필 구성을 적용할 수 없습니다/);
  assert.equal(f.sync().profiles.length, 0);
  assert.equal(readFileSync(f.path, "utf8"), text);
  const config = createSyncSetupConfig({
    db: f.db,
    sync: f.sync(),
    path: join(f.path, "missing", ".env"),
    env: {},
  });
  assert.throws(
    () =>
      config.save(f.teamId, {
        repository: "https://github.com/example/new",
        expectedRevision: config.status(f.teamId).revision,
      }),
    /환경 파일을 쓸 수 없습니다/,
  );
});

test("dotenv patch rewrites managed keys in place and keeps export prefixes and line endings", () => {
  const text =
    "export GRAEBOARD_SYNC_KEY=old\r\nDB_PATH=/keep\r\nGRAEBOARD_SYNC_PROFILES='[]'\r\n";
  assert.equal(
    patchSyncEnv(text, {
      GRAEBOARD_SYNC_KEY: "new",
      GRAEBOARD_SYNC_PROFILES: "[1]",
      GRAEBOARD_SYNC_KEY_ID: "default",
    }),
    "export GRAEBOARD_SYNC_KEY='new'\r\nDB_PATH=/keep\r\nGRAEBOARD_SYNC_PROFILES='[1]'\r\nGRAEBOARD_SYNC_KEY_ID='default'\r\n",
  );
});
