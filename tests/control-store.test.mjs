import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
import { SqliteControlStore } from "../server/storage/control-store.mjs";
import { RequestContext } from "../worker/control.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../server/storage/postgres-tasks.mjs";
import { CalendarBusinessService } from "../server/storage/calendar-service.mjs";
import { PostgresCalendarRepository } from "../server/storage/postgres-calendar.mjs";
import { SettingsBusinessService } from "../server/storage/settings-service.mjs";
import { PostgresSettingsRepository } from "../server/storage/postgres-settings.mjs";
import { PostgresHistoryRepository } from "../server/storage/postgres-history.mjs";
import { PostgresControlRepository } from "../server/storage/postgres-control.mjs";
import { profileFor } from "../worker/config.mjs";

test("SQLite control read port keeps credentials private, uses local memberships and trusted team profiles", (t) => {
  const f = sqliteBusinessFixture(t),
    profile = { profileId: "local-pg", teamId: f.teamId },
    store = new SqliteControlStore({ db: f.db, profiles: [profile] });
  assert.equal(store.teamRow(f.teamId).profile_id, "local-pg");
  assert.equal(store.teamRow(f.teamId).status, "active");
  assert.equal(store.teamRow(randomUUID()), null);
  assert.equal(
    store.teams({
      ...f.user,
      systemRole: "user",
      id: randomUUID(),
      teamIds: [],
    }).length,
    0,
  );
  const user = store.users().find((user) => user.id === f.user.id);
  assert.equal(user.teamRoles[f.teamId], "lead");
  assert.equal(Object.hasOwn(user, "password"), false);
  assert.equal(store.members(f.teamId, { activeOnly: true })[0].role, "lead");
  const before = store.revision();
  assert.equal(store.revision(), before);
  f.db.prepare("UPDATE users SET active=0 WHERE id=?").run(f.user.id);
  assert.notEqual(store.revision(), before);
  assert.equal(store.members(f.teamId, { activeOnly: true }).length, 0);
  assert.equal(store.members(f.teamId).length, 1);
  store.saveCalendarPreferences(f.user.id, [1, 3, 5]);
  assert.deepEqual(store.calendarPreferences(f.user.id), {
    weekdays: [1, 3, 5],
  });
});

test("real PG team operations use SQLite-only actors/members/preferences with no PG control binding", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const localId = randomUUID();
  f.db
    .prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,'!',?)",
    )
    .run(
      localId,
      "local-only@example.test",
      "Local only",
      new Date().toISOString(),
    );
  f.db
    .prepare("INSERT INTO memberships VALUES(?,?,'member')")
    .run(localId, f.teamId);
  assert.equal(
    Number(
      (
        await pg.control.query(
          "SELECT count(*) n FROM graeboard.users WHERE id=$1",
          [localId],
        )
      ).rows[0].n,
    ),
    0,
    "there is no duplicate PG control user",
  );
  const configured = JSON.parse(pg.env.SYNC_PROFILES)[0];
  const env = {
    SYNC_PROFILES: JSON.stringify([
      {
        profileId: configured.profileId,
        teamId: f.teamId,
        database: configured.database || {
          binding: configured.databaseBinding,
        },
      },
    ]),
    [configured.database?.binding || configured.databaseBinding]:
      pg.env[configured.database?.binding || configured.databaseBinding],
  };
  let controlAccesses = 0;
  Object.defineProperty(env, "PG_CONTROL", {
    get() {
      controlAccesses++;
      throw new Error("PG control must never be accessed by this Node host");
    },
  });
  const controlStore = new SqliteControlStore({ db: f.db, env }),
    ctx = new RequestContext(
      env,
      f.user,
      {},
      new Request("http://node.example.test/api/contracts"),
      { waitUntil() {} },
      { controlStore },
    );
  ctx.hostAuthMode = "password";
  assert.throws(
    () => profileFor(env, configured.profileId, f.teamId),
    (e) => e.status === 503,
    "Worker profiles still require full Git/R2 bindings",
  );
  assert.equal(
    (await ctx.profile(f.teamId)).databaseBinding,
    configured.database?.binding || configured.databaseBinding,
  );
  const tasks = new TaskBusinessService(
      new PostgresTaskRepository({ context: ctx }),
      f.user,
    ),
    calendar = new CalendarBusinessService(
      new PostgresCalendarRepository({ context: ctx }),
      f.user,
    ),
    settings = new SettingsBusinessService(
      new PostgresSettingsRepository({ context: ctx }),
      f.user,
    );
  const before = await tasks.query({ teamId: f.teamId, year: 2026 });
  assert.equal(before.data.tasks[0].id, f.taskId);
  await tasks.saveBatch({
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: f.taskId,
        key: "owner",
        value: localId,
        expectedVersion: before.data.tasks[0].cells.owner.version,
      },
    ],
  });
  const saved = await tasks.query({ teamId: f.teamId, year: 2026 });
  assert.equal(saved.data.tasks[0].cells.owner.value, localId);
  const entry = await calendar.createEntry({
    body: {
      id: randomUUID(),
      teamId: f.teamId,
      userId: localId,
      date: "2026-10-27",
      title: "Local control owner",
    },
  });
  assert.equal(entry.userId, localId);
  const team = await calendar.getTeam({ params: { teamId: f.teamId } });
  assert.ok(team.members.some((user) => user.id === localId));
  await calendar.savePreferences({ body: { weekdays: [6, 2] } });
  assert.deepEqual(await calendar.getPreferences({}), { weekdays: [2, 6] });
  assert.deepEqual(
    JSON.parse(
      f.db
        .prepare("SELECT weekdays FROM calendar_preferences WHERE user_id=?")
        .get(f.user.id).weekdays,
    ),
    [2, 6],
  );
  const revision = await ctx.data(
    f.teamId,
    async (s) => (await s.get("team", [])).revision,
  );
  await settings.save(f.teamId, { revision, theme: "sky" });
  const boot = await ctx.bootstrap();
  assert.ok(
    boot.users.some(
      (user) => user.id === localId && user.name === "Local only",
    ),
  );
  assert.equal(boot.teams[0].settings.theme, "sky");
  assert.equal(boot.authMode, undefined);
  const history = await new PostgresHistoryRepository({ context: ctx }).query(
    f.user,
    { teamId: f.teamId },
  );
  assert.ok(history);
  const watcher = new PostgresControlRepository({ context: ctx });
  const beforeWatch = await watcher.watch(f.user, f.teamId);
  controlStore.saveCalendarPreferences(f.user.id, [1]);
  assert.notEqual(
    (await watcher.watch(f.user, f.teamId)).revision,
    beforeWatch.revision,
  );
  assert.equal(
    controlAccesses,
    0,
    "all ordinary PG data paths read local authoritative control ports",
  );
});
