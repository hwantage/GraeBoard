import { createExternalRouteApp } from "./external-route-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
import { SettingsBusinessService } from "../server/storage/settings-service.mjs";
import { FilterBusinessService } from "../server/storage/filter-service.mjs";
import { PostgresSettingsRepository } from "../worker/storage/postgres-settings.mjs";
import { PostgresFilterRepository } from "../worker/storage/postgres-filters.mjs";
import {
  userWithTeams,
  transaction,
  json,
  teamSettings,
} from "../server/db.mjs";
import { defaultView, normalizeSettings } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { materialize } from "../worker/materialize.mjs";
import { canonical, entityId } from "../server/sync/protocol.mjs";
const reject = (work, status) =>
  assert.rejects(
    Promise.resolve().then(work),
    (error) => error.status === status,
  );
function viewerFor(f) {
  const id = randomUUID();
  f.db
    .prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,'!',?)",
    )
    .run(
      id,
      "viewer-" + id + "@example.test",
      "Viewer",
      new Date().toISOString(),
    );
  f.db
    .prepare("INSERT INTO memberships VALUES(?,?,'viewer')")
    .run(id, f.teamId);
  return userWithTeams(
    f.db,
    f.db.prepare("SELECT * FROM users WHERE id=?").get(id),
  );
}
// A repeated save retains business values but keeps the internal API's
// last-used filter ordering and team-update audit entry.
const withoutFilterStamp = (snapshot) => ({
  ...snapshot,
  ...(snapshot.filters
    ? { filters: snapshot.filters.map(({ updated_at, ...row }) => row) }
    : {}),
});
const withoutAudit = ({ audit, ...snapshot }) => snapshot;
async function contract({
  f,
  viewer,
  settings,
  filters,
  forUser,
  readSettings,
  readCell,
  writeCell,
  readAux,
  seedView,
  counters,
  snapshot,
  failOnce,
  visibility,
}) {
  const privateFilter = forUser(viewer).filters,
    before = await counters(),
    filterData = {
      propertyFilters: { description: ["second"] },
      propertyFilterModes: { description: "exclude" },
    };
  await privateFilter.save({
    teamId: f.teamId,
    scope: "personal",
    name: "Personal",
    data: filterData,
  });
  let listed = await privateFilter.list({ teamId: f.teamId }),
    personal = listed.filters.find((row) => row.name === "Personal");
  assert.ok(personal);
  assert.equal(personal.canEdit, true);
  await privateFilter.current({
    teamId: f.teamId,
    selectedId: personal.id,
    data: filterData,
  });
  assert.equal(
    (await privateFilter.list({ teamId: f.teamId })).current.selectedId,
    personal.id,
  );
  assert.equal(
    (await filters.list({ teamId: f.teamId })).filters.some(
      (row) => row.id === personal.id,
    ),
    false,
  );
  await reject(
    () => filters.update(personal.id, { name: "Private stolen" }),
    404,
  );
  await privateFilter.update(personal.id, { name: "Personal renamed" });
  await reject(
    () =>
      privateFilter.save({
        teamId: f.teamId,
        scope: "team",
        name: "Denied",
        data: {},
      }),
    403,
  );
  await reject(
    () =>
      privateFilter.save({
        teamId: f.teamId,
        scope: "personal",
        name: "Bad property",
        data: { propertyFilters: { nonexistent: ["x"] } },
      }),
    400,
  );
  assert.deepEqual(
    await counters(),
    before,
    "viewer personal filter/current never mutates P or audit or synthesizes shared people",
  );
  let all = await snapshot();
  await privateFilter.save({
    teamId: f.teamId,
    scope: "personal",
    name: "Personal renamed",
    data: filterData,
  });
  assert.deepEqual(
    withoutFilterStamp(await snapshot()),
    withoutFilterStamp(all),
    "personal save retry preserves data and shared state",
  );
  await filters.save({
    teamId: f.teamId,
    scope: "team",
    name: "Shared",
    data: filterData,
  });
  listed = await filters.list({ teamId: f.teamId });
  const shared = listed.filters.find((row) => row.name === "Shared");
  assert.ok(shared);
  all = await snapshot();
  await filters.save({
    teamId: f.teamId,
    scope: "team",
    name: "Shared",
    data: filterData,
  });
  assert.deepEqual(
    withoutFilterStamp(await snapshot()),
    withoutFilterStamp(all),
    "shared filter retry preserves P/audit and filter values",
  );
  await reject(() => privateFilter.update(shared.id, { name: "Denied" }), 403);
  await filters.save({
    teamId: f.teamId,
    scope: "team",
    name: "Second",
    data: {},
  });
  await reject(() => filters.update(shared.id, { name: "Second" }), 409);
  await privateFilter.current({
    teamId: f.teamId,
    selectedId: "",
    data: filterData,
  });
  await seedView({
    ...defaultView(2026),
    visibleFields: ["title", "description"],
    knownProperties: ["title", "description"],
    propertyFilters: { description: ["second"] },
  });
  let current = await readSettings();
  await reject(
    () =>
      forUser(viewer).settings.save(f.teamId, {
        theme: "mint",
        revision: current.revision,
      }),
    403,
  );
  const numberProperties = current.properties.map((p) =>
    p.id === "description" ? { ...p, kind: "number" } : p,
  );
  all = await snapshot();
  await reject(
    () =>
      settings.save(f.teamId, {
        properties: numberProperties,
        revision: current.revision,
      }),
    400,
  );
  assert.deepEqual(
    await snapshot(),
    all,
    "failed conversion preserves settings/cells/views/filter states/P/audit",
  );
  await writeCell("description", "42");
  current = await readSettings();
  let saved = (
    await settings.save(f.teamId, {
      properties: numberProperties,
      revision: current.revision,
    })
  ).settings;
  assert.equal((await readCell("description")).value, 42);
  all = await snapshot();
  await reject(
    () =>
      settings.save(f.teamId, {
        properties: numberProperties,
        revision: current.revision,
      }),
    409,
  );
  assert.deepEqual(
    await snapshot(),
    all,
    "stale settings retry leaves canonical work unchanged",
  );
  const archive = saved.properties.filter((p) => p.id !== "description");
  saved = (
    await settings.save(f.teamId, {
      properties: archive,
      revision: saved.revision,
    })
  ).settings;
  assert.equal(
    saved.properties.find((p) => p.id === "description").archived,
    true,
  );
  const aux = await readAux();
  assert.ok(aux.length >= 3);
  for (const item of aux) {
    assert.equal(
      Object.hasOwn(item.propertyFilters || {}, "description"),
      false,
    );
    if (item.visibleFields)
      assert.equal(item.visibleFields.includes("description"), false);
  }
  saved = (
    await settings.save(f.teamId, {
      properties: saved.properties.map((p) =>
        p.id === "description" ? { ...p, archived: false, kind: "text" } : p,
      ),
      revision: saved.revision,
    })
  ).settings;
  await writeCell("description", "Contract");
  saved = (
    await settings.save(f.teamId, {
      properties: saved.properties.map((p) =>
        p.id === "description" ? { ...p, kind: "member", multiple: false } : p,
      ),
      revision: saved.revision,
    })
  ).settings;
  assert.equal((await readCell("description")).value, f.user.id);
  saved = (
    await settings.save(f.teamId, {
      properties: saved.properties.map((p) =>
        p.id === "description" ? { ...p, kind: "text" } : p,
      ),
      revision: saved.revision,
    })
  ).settings;
  assert.equal((await readCell("description")).value, "Contract");
  all = await snapshot();
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() =>
      settings.save(f.teamId, { theme: "sky", revision: saved.revision }),
    ),
    /injected storage failure/,
  );
  assert.deepEqual(
    await snapshot(),
    all,
    "late settings capture failure rolls back normalized auxiliary rows too",
  );
  await settings.general(f.teamId, { name: "Renamed team" });
  all = await snapshot();
  await settings.general(f.teamId, { name: "Renamed team" });
  assert.deepEqual(
    withoutAudit(await snapshot()),
    withoutAudit(all),
    "unchanged general save preserves business and pending state",
  );
  await writeCell("description", "7");
  await visibility(true);
  current = await readSettings();
  saved = (
    await settings.save(f.teamId, {
      properties: current.properties.map((p) =>
        p.id === "description" ? { ...p, kind: "number" } : p,
      ),
      revision: current.revision,
    })
  ).settings;
  const hidden = await readCell("description");
  assert.equal(hidden.value, 7);
  assert.equal(
    hidden.hidden,
    true,
    "settings conversion keeps site-local exclusion visible state",
  );
  const pending = await visibility("pending");
  const change = pending
    .flatMap((op) => op.changes)
    .filter(
      (change) => change.entity === "cell" && change.key[1] === "description",
    )
    .at(-1);
  assert.equal(
    change.action,
    "edit",
    "hidden conversion is an edit, not canonical restore/delete",
  );
  assert.equal(change.desired.value, 7);
  await visibility(false);
  assert.equal((await readCell("description")).value, 7);
  assert.equal((await readCell("description")).hidden, false);
  await privateFilter.remove(personal.id);
  await filters.remove(shared.id);
  return { saved };
}
test("M6 SQLite settings/filter service preserves conversions, local preferences, retention and atomic capture", async (t) => {
  const f = sqliteBusinessFixture(t),
    viewer = viewerFor(f),
    forUser = (user) => ({
      settings: new SettingsBusinessService(
        f.app.locals.settingsRepository,
        user,
      ),
      filters: new FilterBusinessService(f.app.locals.filterRepository, user),
    }),
    services = forUser(f.user);
  const readSettings = () => {
    const value = teamSettings(
      f.db.prepare("SELECT * FROM teams WHERE id=?").get(f.teamId),
    );
    return { ...value, revision: value.revision || 0 };
  };
  const snapshot = () => ({
    teams: f.db.prepare("SELECT * FROM teams").all(),
    cells: f.db.prepare("SELECT * FROM cells ORDER BY task_id,key").all(),
    views: f.db.prepare("SELECT * FROM views ORDER BY id").all(),
    filters: f.db.prepare("SELECT * FROM saved_filters ORDER BY id").all(),
    current: f.db.prepare("SELECT * FROM filter_states ORDER BY user_id").all(),
    pending: f.db.prepare("SELECT * FROM sync_outbox ORDER BY local_seq").all(),
    audit: f.db.prepare("SELECT * FROM audit ORDER BY id").all(),
  });
  await contract({
    f,
    viewer,
    ...services,
    forUser,
    readSettings,
    readCell: (key) => ({
      value: JSON.parse(
        f.db
          .prepare("SELECT value FROM cells WHERE task_id=? AND key=?")
          .get(f.taskId, key).value,
      ),
      hidden: !!f.db
        .prepare("SELECT 1 FROM site_retention WHERE team_id=? AND kind='year'")
        .get(f.teamId),
    }),
    writeCell: (key, value) =>
      transaction(f.db, () =>
        f.db
          .prepare(
            "UPDATE cells SET value=?,version=version+1 WHERE task_id=? AND key=?",
          )
          .run(json(value), f.taskId, key),
      ),
    seedView: (data) =>
      f.db
        .prepare(
          "INSERT INTO views(id,user_id,team_id,year,name,data,updated_at) VALUES(?,?,?,2026,?,?,?)",
        )
        .run(
          randomUUID(),
          viewer.id,
          f.teamId,
          "__current",
          json(data),
          new Date().toISOString(),
        ),
    readAux: () =>
      [
        ...f.db.prepare("SELECT data FROM views").all(),
        ...f.db.prepare("SELECT data FROM saved_filters").all(),
        ...f.db.prepare("SELECT data FROM filter_states").all(),
      ].map((row) => JSON.parse(row.data)),
    counters: () => ({
      pending: f.db.prepare("SELECT count(*) n FROM sync_outbox").get().n,
      audit: f.db.prepare("SELECT count(*) n FROM audit").get().n,
    }),
    snapshot,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected storage failure");
      };
    },
    visibility: async (hidden) => {
      if (hidden === "pending") return f.adapter.readPending(f.teamId);
      f.adapter.withTeamTransaction(f.teamId, (tx) => {
        if (hidden)
          tx.sync.putExclusion({
            siteId: f.link.installation_id,
            kind: "year",
            key: ["2026"],
            revision: 1,
            createdAt: new Date().toISOString(),
          });
        else
          tx.query("DELETE FROM site_retention WHERE team_id=$1", [f.teamId]);
      });
    },
  });
  assert.equal(
    services.filters.list({ teamId: f.teamId }) instanceof Promise,
    false,
  );
});
test("M6 same settings/filter services run on real PG and injected external HTTP without local business rows", async (t) => {
  const f = sqliteBusinessFixture(t),
    viewer = viewerFor(f),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  await pg.control.query(
    "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,'Viewer','user',$3)",
    [viewer.id, viewer.username, new Date().toISOString()],
  );
  await pg.control.query(
    "INSERT INTO graeboard.memberships VALUES($1,$2,'viewer')",
    [viewer.id, f.teamId],
  );
  let fail = false;
  const contextFor = (user) => {
    const ctx = pg.createContext(user),
      data = ctx.data.bind(ctx);
    ctx.data = (id, work, options) =>
      data(
        id,
        async (s) => {
          const value = await work(s);
          if (fail && options?.write) {
            fail = false;
            const capture = s.capture.bind(s);
            s.capture = async (actor) => {
              await capture(actor);
              throw new Error("injected storage failure");
            };
          }
          return value;
        },
        options,
      );
    return ctx;
  };
  const forUser = (user) => {
      const context = contextFor(user);
      return {
        settings: new SettingsBusinessService(
          new PostgresSettingsRepository({ context }),
          user,
        ),
        filters: new FilterBusinessService(
          new PostgresFilterRepository({ context }),
          user,
        ),
      };
    },
    services = forUser(f.user),
    ctx = pg.createContext();
  const readSettings = () =>
    ctx.data(f.teamId, async (s) => {
      const row = await s.get("team", []);
      return {
        ...normalizeSettings(row.payload.settings),
        revision: row.revision,
      };
    });
  const snapshot = async () => ({
    rows: (
      await pg.pool.query(
        "SELECT * FROM graeboard.site_entities ORDER BY entity,entity_key",
      )
    ).rows,
    revisions: (
      await pg.pool.query(
        "SELECT * FROM graeboard.site_entity_revisions ORDER BY entity,entity_key",
      )
    ).rows,
    pending: (
      await pg.pool.query(
        "SELECT * FROM graeboard.sync_outbox ORDER BY local_seq",
      )
    ).rows,
    audit: (
      await pg.pool.query("SELECT * FROM graeboard.site_audit ORDER BY id")
    ).rows,
  });
  const result = await contract({
    f,
    viewer,
    ...services,
    forUser,
    readSettings,
    readCell: (key) =>
      ctx.data(f.teamId, async (s) => {
        const row = await s.get("cell", [f.taskId, key]);
        return { value: row.payload.value, hidden: row.deleted };
      }),
    writeCell: (key, value) =>
      ctx.data(
        f.teamId,
        async (s) => {
          const row = await s.get("cell", [f.taskId, key]);
          await s.put("cell", row.key, { ...row.payload, value });
        },
        { write: true },
      ),
    seedView: (data) =>
      ctx.data(
        f.teamId,
        (s) => s.put("view", [viewer.id, "2026"], data, { shared: false }),
        { write: true, privateWrite: true },
      ),
    readAux: () =>
      ctx.data(f.teamId, async (s) =>
        (
          await Promise.all(
            ["view", "filter", "personalFilter", "filterState"].map((e) =>
              s.list(e),
            ),
          )
        )
          .flat()
          .map((row) =>
            row.entity === "view" ? row.payload : row.payload.data,
          ),
      ),
    counters: async () => ({
      pending: Number(
        (await pg.pool.query("SELECT count(*) n FROM graeboard.sync_outbox"))
          .rows[0].n,
      ),
      audit: Number(
        (await pg.pool.query("SELECT count(*) n FROM graeboard.site_audit"))
          .rows[0].n,
      ),
    }),
    snapshot,
    failOnce() {
      fail = true;
    },
    visibility: async (hidden) => {
      if (hidden === "pending") return pg.adapter.readPending(f.teamId);
      await pg.adapter.withTeamTransaction(f.teamId, async (tx) => {
        if (hidden)
          await tx.sync.putExclusion({
            siteId: f.link.installation_id,
            kind: "year",
            key: ["2026"],
            revision: 1,
            createdAt: new Date().toISOString(),
          });
        else
          await tx.query("DELETE FROM site_retention WHERE team_id=$1", [
            f.teamId,
          ]);
        await materialize(tx, f.teamId, {
          state: await tx.sync.readState(),
          pending: await tx.sync.readPending(),
          exclusions: await tx.sync.readExclusions(),
        });
      });
    },
  });
  const app = createExternalRouteApp({
      env: pg.env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => contextFor(user),
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await app.close();
  });
  const eventCount = async () =>
    Number(
      (
        await pg.pool.query(
          "SELECT COUNT(*) n FROM graeboard.site_events WHERE kind='changed'",
        )
      ).rows[0].n,
    );
  const beforeEvents = await eventCount();
  const req = async (path, method, body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          Cookie: "weekly_session=" + f.user.id,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: unpack(await response.json()) };
  };
  let response = await req("/filters", "PUT", {
    teamId: f.teamId,
    scope: "team",
    name: "PG HTTP only",
    data: {},
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.db.prepare("SELECT count(*) n FROM saved_filters").get().n, 0);
  assert.ok(
    (await req("/filters?teamId=" + f.teamId, "GET")).body.filters.some(
      (row) => row.name === "PG HTTP only",
    ),
  );
  const oldSQLite = teamSettings(
      f.db.prepare("SELECT * FROM teams WHERE id=?").get(f.teamId),
    ),
    current = await readSettings();
  response = await req("/teams/" + f.teamId + "/settings", "PATCH", {
    revision: current.revision,
    defaultDensity: "dense",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await readSettings()).defaultDensity, "dense");
  assert.equal(
    teamSettings(f.db.prepare("SELECT * FROM teams WHERE id=?").get(f.teamId))
      .defaultDensity,
    oldSQLite.defaultDensity,
  );
  assert.equal(await eventCount(), beforeEvents + 2);
  response = await req("/teams/" + f.teamId + "/settings", "PATCH", {
    revision: current.revision,
    defaultDensity: "comfortable",
  });
  assert.equal(response.status, 409);
  assert.equal(await eventCount(), beforeEvents + 2);
});
