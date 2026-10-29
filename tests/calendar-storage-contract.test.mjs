import { createExternalRouteApp } from "./external-route-fixture.mjs";
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
} from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import {
  DEFAULT_SETTINGS,
  sampleProperties,
  todayKey,
} from "../shared/domain.js";
import { calendarWeek } from "../shared/calendar.js";
import { unpack } from "../shared/compact.js";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { CalendarBusinessService } from "../server/storage/calendar-service.mjs";
import { PostgresCalendarRepository } from "../worker/storage/postgres-calendar.mjs";
import { RequestContext } from "../worker/control.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import {
  canonical,
  emptyState,
  entityId,
  initialToken,
} from "../server/sync/protocol.mjs";

function fixture(t) {
  const dir = mkdtempSync("/tmp/gb-calendar-contract-"),
    db = openDatabase(join(dir, "data.sqlite")),
    teamId = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID(),
    refId = randomUUID(),
    stamp = new Date().toISOString();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Calendar contract",
    json({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
  );
  for (const [id, name, role, active] of [
    [userId, "Admin", "admin", 1],
    [viewerId, "Viewer", "user", 1],
    [refId, "Imported person", "user", 0],
  ])
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,active,created_at) VALUES(?,?,?,'!',?,?,?)",
    ).run(id, id + "@example.test", name, role, active, stamp);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO memberships VALUES(?,?,'viewer')").run(
    viewerId,
    teamId,
  );
  db.prepare(
    "INSERT INTO sync_person_refs(team_id,person_id,profile,local_user_id) VALUES(?,?,?,?)",
  ).run(teamId, refId, json({ name: "Imported person" }), refId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(userId).digest("hex"),
    userId,
    Date.now() + 600000,
  );
  const task = insertTask(db, {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      actorId: userId,
      fields: { title: "Contract task", owner: userId },
    }),
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
    adapter = new SqliteDatabase(db),
    state = { ...emptyState(), entities: allEntities(db, link) };
  const personToken = initialToken(link.bootstrap_id, "person", [refId]);
  state.entities[entityId("person", [refId])] = {
    entity: "person",
    key: [refId],
    payload: { name: "Imported person" },
    generation: personToken,
    version: personToken,
    deleted: false,
  };
  adapter.withTeamTransaction(teamId, (tx) => {
    const { team_id, ...fields } = link;
    tx.sync.writeLink(fields);
    tx.sync.writeState(state, link.canonical_head);
  });
  const user = userWithTeams(
      db,
      db.prepare("SELECT * FROM users WHERE id=?").get(userId),
    ),
    viewer = userWithTeams(
      db,
      db.prepare("SELECT * FROM users WHERE id=?").get(viewerId),
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
    teamId,
    user,
    viewer,
    refId,
    taskId: task.id,
    link,
    state,
    app,
  };
}
const rejects = (fn, status) =>
  assert.rejects(Promise.resolve().then(fn), (e) => e.status === status);
async function contract({
  service,
  forUser,
  teamId,
  user,
  viewer,
  refId,
  taskId,
  counts,
  failOnce,
  tombstone = async () => {},
}) {
  const before = await counts();
  assert.deepEqual(
    (await service.savePreferences({ body: { weekdays: [5, 1, 1] } })).weekdays,
    [1, 5],
  );
  assert.deepEqual((await service.getPreferences({})).weekdays, [1, 5]);
  assert.equal(
    (await counts()).pending,
    before.pending,
    "personal preferences never enter P",
  );
  const tagId = randomUUID(),
    tagBody = { id: tagId, name: "Check", color: "blue", kind: "check" };
  let tag = await service.createTag({ params: { teamId }, body: tagBody });
  assert.equal(tag.userId, user.id);
  const afterTag = await counts();
  assert.deepEqual(
    await service.createTag({ params: { teamId }, body: tagBody }),
    tag,
  );
  assert.deepEqual(await counts(), afterTag);
  assert.deepEqual(
    service.repository.resourceChanges?.() || [],
    [],
    "replayed tag has no committed resource notification",
  );
  await rejects(
    () =>
      service.createTag({
        params: { teamId },
        body: { ...tagBody, id: randomUUID(), name: "check" },
      }),
    409,
  );
  const view = forUser(viewer);
  await rejects(
    () =>
      view.createEntry({
        body: {
          id: randomUUID(),
          teamId,
          userId: user.id,
          date: "2026-10-26",
          title: "Private denied",
        },
      }),
    403,
  );
  const shared = await view.createEntry({
    body: {
      id: randomUUID(),
      teamId,
      userId: null,
      date: "2026-10-26",
      title: "Shared viewer card",
    },
  });
  assert.equal(shared.userId, null);
  const sharedTag = await view.createTag({
    params: { teamId },
    body: { ...tagBody, id: randomUUID(), userId: null, name: "Shared check" },
  });
  assert.equal(sharedTag.userId, null);
  assert.ok(
    (
      await view.listTags({ params: { teamId }, query: { scope: "team" } })
    ).tags.some((tag) => tag.id === sharedTag.id),
  );
  const reference = await service.createEntry({
    body: {
      id: randomUUID(),
      teamId,
      userId: refId,
      date: "2026-10-26",
      title: "Imported person card",
    },
  });
  assert.equal(reference.userId, refId);
  await rejects(
    () =>
      service.createEntry({
        body: {
          id: randomUUID(),
          teamId,
          userId: randomUUID(),
          date: "2026-10-26",
          title: "Unknown person",
        },
      }),
    404,
  );
  const body = {
    id: randomUUID(),
    teamId,
    userId: user.id,
    date: "2026-10-26",
    endDate: "2026-10-28",
    title: " Entry ",
    tagIds: [tagId],
    checkedTagIds: [],
  };
  let entry = await service.createEntry({ body });
  assert.equal(entry.title, "Entry");
  const created = await counts();
  assert.deepEqual(await service.createEntry({ body }), entry);
  assert.deepEqual(await counts(), created);
  await service.checkTag({
    params: { id: entry.id, tagId },
    body: { checked: true, expectedChecked: false },
  });
  await rejects(
    () =>
      service.checkTag({
        params: { id: entry.id, tagId },
        body: { checked: false, expectedChecked: false },
      }),
    409,
  );
  tag = await service.updateTag({
    params: { id: tagId },
    body: {
      name: "Label",
      color: "blue",
      kind: "label",
      expectedRevision: tag.revision,
    },
  });
  assert.equal(tag.usageCount, 1);
  assert.deepEqual(
    (await service.getEntry({ params: { id: entry.id } })).checkedTagIds,
    [],
  );
  const tagRevision = tag.revision;
  assert.equal(
    (
      await service.updateTag({
        params: { id: tagId },
        body: {
          name: "Label",
          color: "blue",
          kind: "label",
          expectedRevision: 0,
        },
      })
    ).revision,
    tagRevision,
    "unchanged retry accepts old tag revision",
  );
  await rejects(
    () =>
      service.updateTag({
        params: { id: tagId },
        body: { name: "Stale", color: "blue", expectedRevision: 0 },
      }),
    409,
  );
  entry = await service.updateEntry({
    params: { id: entry.id },
    body: { title: "Edited", expectedTitle: "Entry" },
  });
  await rejects(
    () =>
      service.updateEntry({
        params: { id: entry.id },
        body: { title: "Conflict", expectedTitle: "Entry" },
      }),
    409,
  );
  const range = {
    date: "2026-11-02",
    endDate: "2026-11-04",
    expectedDate: "2026-10-26",
    expectedEndDate: "2026-10-28",
  };
  entry = await service.updateEntry({ params: { id: entry.id }, body: range });
  assert.equal(
    (await service.updateEntry({ params: { id: entry.id }, body: range })).date,
    range.date,
    "lost range response is idempotent",
  );
  const copy = await service.copyEntry({
    params: { id: entry.id },
    body: { id: randomUUID() },
  });
  assert.match(copy.title, /Edited \(1\)/);
  assert.equal(copy.preview, "");
  await rejects(
    () =>
      service.copyEntry({ params: { id: entry.id }, body: { id: shared.id } }),
    409,
  );
  const distant = await service.createEntry({
    body: {
      id: randomUUID(),
      teamId,
      userId: user.id,
      date: "2028-02-01",
      title: "Unrelated future layout",
    },
  });
  const visible = await service.listEntries({
    query: { teamId, userId: user.id, from: "2026-11-01", to: "2026-11-30" },
  });
  assert.ok(visible.entries.some((item) => item.id === entry.id));
  assert.ok(visible.layout.some((item) => item.id === copy.id));
  assert.ok(
    !visible.layout.some((item) => item.id === distant.id),
    "layout omits disconnected calendar history",
  );
  const placed = await service.updateEntry({
    params: { id: copy.id },
    body: {
      lane: 0,
      expectedLane: copy.lane,
      expectedDate: copy.date,
      expectedEndDate: copy.endDate,
    },
  });
  assert.equal(placed.lane, 0);
  assert.equal((await service.getEntry({ params: { id: entry.id } })).lane, 1);
  const untagged = await service.updateEntry({
    params: { id: copy.id },
    body: { tagIds: [], expectedTagIds: copy.tagIds },
  });
  assert.deepEqual(untagged.tagIds, []);
  assert.equal(
    (await service.getTask({ params: { id: taskId } })).task.id,
    taskId,
  );
  const team = await service.getTeam({ params: { teamId } });
  const rule = await service.saveRule({
    params: { teamId },
    body: {
      propertyId: "status",
      values: [""],
      mode: "include",
      expectedRevision: team.rule.revision,
    },
  });
  assert.equal(rule.rule.propertyId, "status");
  assert.equal(rule.ruleProblem, "");
  await rejects(
    () =>
      service.saveRule({
        params: { teamId },
        body: {
          propertyId: "status",
          values: [""],
          mode: "include",
          expectedRevision: team.rule.revision,
        },
      }),
    409,
  );
  const weekStart = calendarWeek(todayKey()),
    weeklyBody = { teamId, userId: user.id, weekStart, taskIds: [taskId] };
  assert.equal((await service.addWeekly({ body: weeklyBody })).added, 1);
  assert.equal((await service.addWeekly({ body: weeklyBody })).existing, 1);
  const selected = await service.listTasks({
    query: { teamId, userId: user.id, weekStart, q: "contract" },
  });
  assert.equal(selected.tasks[0].added, true);
  const imported = await service.importWeekly({
    body: { teamId, userId: user.id, weekStart },
  });
  assert.equal(imported.existing, 1);
  assert.equal(imported.matched, 1);
  await rejects(
    () =>
      service.listEntries({
        query: {
          teamId,
          scope: "team",
          userId: user.id,
          from: "2026-10-01",
          to: "2026-10-31",
        },
      }),
    400,
  );
  entry = await service.getEntry({ params: { id: entry.id } });
  const deletion = {
    deletionId: randomUUID(),
    expectedUpdatedAt: entry.updatedAt,
    expectedRevision: entry.revision,
    expectedTitle: entry.title,
    expectedDate: entry.date,
    expectedEndDate: entry.endDate,
    expectedTagIds: entry.tagIds,
    expectedCheckedTagIds: entry.checkedTagIds,
  };
  await service.deleteEntry({ params: { id: entry.id }, body: deletion });
  await tombstone(entry.id);
  await rejects(() => service.getEntry({ params: { id: entry.id } }), 404);
  entry = await service.restoreEntry({
    params: { id: entry.id },
    body: { deletionId: deletion.deletionId },
  });
  assert.equal(entry.title, "Edited");
  await rejects(
    () =>
      service.deleteEntry({
        params: { id: entry.id },
        body: { ...deletion, expectedUpdatedAt: entry.updatedAt },
      }),
    409,
  );
  const saved = await counts();
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.updateEntry({
        params: { id: entry.id },
        body: { title: "Rolled back", expectedTitle: "Edited" },
      }),
    ),
    /injected storage failure/,
  );
  assert.equal(
    (await service.getEntry({ params: { id: entry.id } })).title,
    "Edited",
  );
  assert.deepEqual(
    await counts(),
    saved,
    "late failure rolls back domain/audit/P/revisions",
  );
  assert.deepEqual(
    service.repository.resourceChanges?.() || [],
    [],
    "failed transaction has no committed resource notification",
  );
  await service.deleteTag({
    params: { id: tagId },
    body: { expectedRevision: tagRevision },
  });
  assert.deepEqual(
    (await service.getEntry({ params: { id: entry.id } })).tagIds,
    [],
  );
  return { entry };
}

test("M6 calendar service uses SQLite repository with atomic audit/outbox, replay and shared policies", async (t) => {
  const f = fixture(t),
    repository = f.app.locals.calendarRepository,
    forUser = (user) => new CalendarBusinessService(repository, user);
  const counts = () => ({
    pending: f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
    audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    entries: f.db.prepare("SELECT * FROM calendar_entries ORDER BY id").all(),
    tags: f.db.prepare("SELECT * FROM calendar_tags ORDER BY id").all(),
  });
  await contract({
    ...f,
    service: forUser(f.user),
    forUser,
    counts,
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected storage failure");
      };
    },
  });
  assert.equal(forUser(f.user).getPreferences({}) instanceof Promise, false);
});

test("M6 same calendar service and external HTTP routes accept a real PostgreSQL repository", async (t) => {
  const bin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
  if (!existsSync(join(bin, "postgres"))) {
    t.skip("TEST_PG_BIN required");
    return;
  }
  const f = fixture(t),
    dir = mkdtempSync("/tmp/gb-calendar-pg-"),
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
  const url = (name) =>
      `postgresql://${encodeURIComponent(process.env.USER)}@localhost/${name}?host=${encodeURIComponent(dir)}&port=5432`,
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
    initialize: true,
    teamId: f.teamId,
  });
  for (const u of [f.user, f.viewer])
    await control.query(
      "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,$3,$4,$5)",
      [u.id, u.username, u.name, u.systemRole, new Date().toISOString()],
    );
  await control.query(
    "INSERT INTO graeboard.teams(id,name,profile_id,status) VALUES($1,'Calendar','contract','active')",
    [f.teamId],
  );
  for (const u of [f.user, f.viewer])
    await control.query("INSERT INTO graeboard.memberships VALUES($1,$2,$3)", [
      u.id,
      f.teamId,
      u.teamRoles[f.teamId],
    ]);
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
    TOKEN: "fixture",
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
  let fail = false;
  const makeRepository = (user) => {
      const context = new RequestContext(
          env,
          user,
          {},
          new Request("https://example.test/api/calendar"),
          { waitUntil() {} },
        ),
        original = context.data.bind(context);
      context.data = (teamId, work, options) =>
        original(
          teamId,
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
      return new PostgresCalendarRepository({ context });
    },
    forUser = (user) => new CalendarBusinessService(makeRepository(user), user);
  const counts = async () => ({
    pending: Number(
      (await pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox")).rows[0]
        .n,
    ),
    audit: Number(
      (await pool.query("SELECT COUNT(*) n FROM graeboard.site_audit")).rows[0]
        .n,
    ),
    rows: (
      await pool.query(
        "SELECT entity,entity_key,payload,revision,deleted FROM graeboard.site_entities ORDER BY entity,entity_key",
      )
    ).rows,
  });
  const result = await contract({
    ...f,
    service: forUser(f.user),
    forUser,
    counts,
    failOnce: () => {
      fail = true;
    },
    tombstone: (id) =>
      pool.query(
        "UPDATE graeboard.site_entities SET deleted=1 WHERE entity='calendar' AND entity_key=$1",
        [canonical([id])],
      ),
  });
  const app = createExternalRouteApp({
      env: env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => makeRepository(user).context,
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/calendar/entries/${result.entry.id}`,
    { headers: { cookie: "weekly_session=" + f.user.id } },
  );
  assert.equal(response.status, 200);
  assert.equal(unpack(await response.json()).title, "Edited");
  const eventCount = async () =>
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) n FROM graeboard.site_events WHERE kind='changed'",
        )
      ).rows[0].n,
    );
  const beforeEvents = await eventCount();
  const patch = (body) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/calendar/entries/${result.entry.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: "weekly_session=" + f.user.id,
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
          Origin: `http://127.0.0.1:${server.address().port}`,
        },
        body: JSON.stringify(body),
      },
    );
  const updated = await patch({
    title: "external HTTP PG edit",
    expectedTitle: "Edited",
  });
  assert.equal(updated.status, 200, await updated.text());
  assert.deepEqual(await eventCount(), beforeEvents + 1);
  assert.equal(
    (await patch({ title: "external HTTP PG edit", expectedTitle: "Edited" }))
      .status,
    200,
  );
  assert.equal(
    await eventCount(),
    beforeEvents + 1,
    "lost HTTP response retry emits no duplicate event",
  );
  fail = true;
  assert.equal(
    (
      await patch({
        title: "HTTP failure",
        expectedTitle: "external HTTP PG edit",
      })
    ).status,
    500,
  );
  assert.equal(
    await eventCount(),
    beforeEvents + 1,
    "failure emits no precommit event",
  );
  assert.equal(
    (await forUser(f.user).getEntry({ params: { id: result.entry.id } })).title,
    "external HTTP PG edit",
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM calendar_entries").get().n,
    0,
    "external HTTP route read injected PG, not local SQLite",
  );
});
