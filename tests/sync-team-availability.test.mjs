import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unpack } from "../shared/compact.js";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { RequestContext } from "../worker/control.mjs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";

async function apiFor(t, app, userId) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, method = "GET", body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: `weekly_session=${userId}`,
        Origin: base,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = unpack(await response.json());
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
}
const flags = (teams) => Object.fromEntries(teams.map((t) => [t.id, t.sync]));
const absent = { available: false, configured: false };
const offered = { available: true, configured: false };
const saved = { available: true, configured: true };

test("Node bootstrap/admin teams distinguish unconfigured, offered and every persisted connection without running sync", async (t) => {
  const f = sqliteBusinessFixture(t),
    none = randomUUID(),
    offeredId = randomUUID();
  for (const id of [none, offeredId])
    f.db
      .prepare("INSERT INTO teams VALUES(?,?,?)")
      .run(id, id, JSON.stringify(DEFAULT_SETTINGS));
  f.app.locals.sync.profiles.push({
    profileId: "offered",
    teamId: offeredId,
    repository: "example/offered",
  });
  f.app.locals.sync.get = () => assert.fail("bootstrap must not run sync");
  const api = await apiFor(t, f.app, f.user.id);
  const expected = {
    [f.teamId]: saved,
    [none]: absent,
    [offeredId]: offered,
  };
  for (const mode of ["active", "paused", "recovery", "disconnected"])
    for (const path of ["/api/bootstrap", "/api/admin/users"]) {
      f.db
        .prepare("UPDATE team_sync_links SET mode=? WHERE team_id=?")
        .run(mode, f.teamId);
      const value = await api(path);
      assert.deepEqual(flags(value.teams), expected);
      assert.ok(!JSON.stringify(value.teams).includes("example/offered"));
    }
  await api(`/api/admin/teams/${offeredId}/connection`, "PUT", {
    profileId: "offered",
    expectedRevision: 0,
  });
  expected[offeredId] = saved;
  assert.deepEqual(flags((await api("/api/bootstrap")).teams), expected);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n, 0);
  // A member sees flags for authorized teams only, even when other profiles exist.
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.user.id);
  assert.deepEqual(flags((await api("/api/bootstrap")).teams), {
    [f.teamId]: saved,
  });
});

test("Edge bootstrap/admin teams use existing data reads and preserve saved connections across missing profiles and DB errors", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const none = randomUUID(),
    offeredId = randomUUID(),
    pendingId = randomUUID();
  await pg.control.query(
    "INSERT INTO graeboard.teams(id,name,profile_id,status) VALUES($1,'None',NULL,'unconnected'),($2,'Offered',NULL,'unconnected'),($3,'Saved setup','saved-setup','unconnected')",
    [none, offeredId, pendingId],
  );
  const installed = JSON.parse(pg.env.SYNC_PROFILES);
  installed.push({
    profileId: "offered",
    teamId: offeredId,
    repository: "example/offered",
    databaseBinding: "PG_OFFERED",
    bucketBinding: "BUCKET_OFFERED",
    githubSecret: "TOKEN_OFFERED",
  });
  pg.env.SYNC_PROFILES = installed;
  const dataReads = [],
    app = createExternalRouteApp({
      env: pg.env,
      defaultUserId: f.user.id,
      contextFor(user, request) {
        const ctx = new RequestContext(pg.env, user, {}, request, {
          waitUntil() {},
        });
        const data = ctx.data.bind(ctx);
        ctx.data = (teamId, ...args) => {
          dataReads.push(teamId);
          return data(teamId, ...args);
        };
        return ctx;
      },
    });
  t.after(() => app.close());
  const api = await apiFor(t, app, f.user.id),
    expected = {
      [f.teamId]: saved,
      [none]: absent,
      [offeredId]: offered,
      [pendingId]: saved,
    };
  for (const mode of ["active", "paused", "recovery", "disconnected"]) {
    await pg.pool.query(
      "UPDATE graeboard.team_sync_links SET mode=$1 WHERE team_id=$2",
      [mode, f.teamId],
    );
    for (const path of ["/api/bootstrap", "/api/admin/users"]) {
      dataReads.length = 0;
      assert.deepEqual(flags((await api(path)).teams), expected);
      assert.deepEqual(dataReads, [f.teamId]);
    }
  }
  // Successful data access distinguishes an explicit profile from a real link.
  await pg.pool.query(
    "DELETE FROM graeboard.team_sync_links WHERE team_id=$1",
    [f.teamId],
  );
  expected[f.teamId] = offered;
  assert.deepEqual(flags((await api("/api/bootstrap")).teams), expected);
  await pg.adapter.withTeamTransaction(f.teamId, (tx) => {
    const { team_id, ...fields } = f.link;
    return tx.sync.writeLink(fields);
  });
  expected[f.teamId] = saved;
  const original = installed.shift();
  const missingProfile = await api("/api/bootstrap");
  assert.deepEqual(flags(missingProfile.teams), expected);
  assert.ok(
    missingProfile.teams.find((t) => t.id === f.teamId).connectionError,
  );
  installed.unshift(original);
  const connectionString = pg.env.PG_TEAM.connectionString;
  delete pg.env.PG_TEAM.connectionString;
  const inaccessible = await api("/api/admin/users");
  assert.deepEqual(flags(inaccessible.teams), expected);
  assert.ok(inaccessible.teams.find((t) => t.id === f.teamId).connectionError);
  pg.env.PG_TEAM.connectionString = connectionString;
  assert.equal(
    Number(
      (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox"))
        .rows[0].n,
    ),
    0,
  );
});
