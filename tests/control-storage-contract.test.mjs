import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { parseCompact, unpack } from "../shared/compact.js";
import { ControlBusinessService } from "../server/storage/control-service.mjs";
import { PostgresControlRepository } from "../server/storage/postgres-control.mjs";
import { createPostgresBusinessStorage } from "../server/storage/business-storage.mjs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
const rejected = (work, status) =>
  assert.rejects(Promise.resolve().then(work), (e) => e.status === status);
async function cellStream(t, base, path, cookie, after, multiplex = false) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + (multiplex ? "/api/events" : path), {
    method: multiplex ? "POST" : "GET",
    signal: controller.signal,
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    ...(multiplex
      ? {
          body: JSON.stringify({
            streams: [{ id: 7, path, lastEventId: after }],
          }),
        }
      : {}),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(type) {
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        for (;;) {
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = frame.match(/^event: (.+)$/m)?.[1];
            if (!event) continue;
            let data = parseCompact(frame.match(/^data: (.+)$/m)?.[1] || "{}"),
              id = frame.match(/^id: (.+)$/m)?.[1];
            if (event === "stream") {
              assert.equal(data.id, 7);
              id = data.lastEventId;
              event = data.event;
              data = parseCompact(data.data);
            }
            if (event === type) return { id, data };
          }
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "SSE ended before " + type);
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
async function contract(f, service) {
  const initial = await service.bootstrap();
  assert.ok(initial.teams.some((t) => t.id === f.teamId));
  assert.ok(initial.users.some((u) => u.id === f.user.id));
  const profile = await service.execute("profile", { color: "#123456" });
  assert.equal(profile.user.color, "#123456");
  assert.equal(profile.user.name, f.user.name);
  await rejected(
    () =>
      service.execute(
        "updateUser",
        { name: f.user.name, active: false, systemRole: "user" },
        f.user.id,
      ),
    400,
  );
  const input = {
    username: "new@example.test",
    password: "a-test-password",
    name: "New member",
    memberships: [{ teamId: f.teamId, role: "member" }],
  };
  const created = await service.execute("createUser", input);
  assert.equal(created.user.teamRoles[f.teamId], "member");
  await rejected(() => service.execute("createUser", input), 409);
  const members = (await service.execute("members", {}, f.teamId)).members;
  const next = members.map((m) =>
    m.userId === created.user.id ? { ...m, role: "viewer" } : m,
  );
  await service.execute(
    "replaceMembers",
    { members: next, previous: members },
    f.teamId,
  );
  await rejected(
    () =>
      service.execute(
        "replaceMembers",
        { members, previous: members },
        f.teamId,
      ),
    409,
  );
  assert.deepEqual(
    (await service.execute("members", {}, f.teamId)).members
      .map((m) => ({ ...m }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
    next
      .map((m) => ({ ...m }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  );
  const team = await service.execute("createTeam", {
    name: "Temporary control team",
    members: [{ userId: created.user.id, role: "viewer" }],
  });
  assert.ok(team.id);
  await service.execute("deleteTeam", { confirmed: true }, team.id);
  const forbidden = new ControlBusinessService(service.repository, {
    ...f.user,
    systemRole: "user",
    teamRoles: { [f.teamId]: "viewer" },
  });
  await rejected(() => forbidden.execute("listUsers"), 403);
  await rejected(() => forbidden.execute("members", {}, f.teamId), 403);
  return created.user.id;
}
test("M6 control contract keeps SQLite synchronous bootstrap, profile, users, membership CAS and atomic admin commands", async (t) => {
  const f = sqliteBusinessFixture(t),
    service = new ControlBusinessService(
      f.app.locals.controlRepository,
      f.user,
    );
  const userId = await contract(f, service);
  assert.equal(service.bootstrap() instanceof Promise, false);
  f.db.exec(
    "CREATE TEMP TRIGGER reject_control_audit BEFORE INSERT ON audit WHEN NEW.action='user-update' BEGIN SELECT RAISE(ABORT,'control rollback'); END",
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      service.execute(
        "updateUser",
        { name: "Must roll back", active: true, memberships: [] },
        userId,
      ),
    ),
    /control rollback/,
  );
  assert.equal(
    f.db.prepare("SELECT name FROM users WHERE id=?").get(userId).name,
    "New member",
  );
  assert.equal(
    f.db
      .prepare("SELECT role FROM memberships WHERE user_id=? AND team_id=?")
      .get(userId, f.teamId).role,
    "viewer",
  );
});
test("M6 PostgreSQL Access control obeys same commands and atomically rolls back user/membership changes", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const service = new ControlBusinessService(
    new PostgresControlRepository({ context: pg.createContext() }),
    f.user,
  );
  const createdUser = await contract(f, service);
  await pg.control.query(
    "CREATE FUNCTION graeboard.reject_control_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'control rollback'; END $$; CREATE TRIGGER reject_control_audit BEFORE INSERT ON graeboard.control_audit FOR EACH ROW EXECUTE FUNCTION graeboard.reject_control_audit()",
  );
  await assert.rejects(
    service.execute(
      "updateUser",
      { name: "Must roll back", active: true, memberships: [] },
      createdUser,
    ),
    /control rollback/,
  );
  assert.equal(
    (
      await pg.control.query("SELECT name FROM graeboard.users WHERE id=$1", [
        createdUser,
      ])
    ).rows[0].name,
    "New member",
  );
  assert.equal(
    (
      await pg.control.query(
        "SELECT role FROM graeboard.memberships WHERE user_id=$1 AND team_id=$2",
        [createdUser, f.teamId],
      )
    ).rows[0].role,
    "viewer",
  );
  await pg.control.query(
    "DROP TRIGGER reject_control_audit ON graeboard.control_audit; DROP FUNCTION graeboard.reject_control_audit()",
  );
});

test("M6 Node SQLite control authorizes PG-only HTTP and dedicated/multiplex cell SSE without a PG control mirror, denies viewer writes and revokes live streams", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  assert.throws(
    () =>
      createApp({
        db: f.db,
        controlRepository: new PostgresControlRepository({
          context: pg.createContext(),
        }),
      }),
    /matching SQLite control/,
    "broken password+Access-control configuration is rejected at construction",
  );
  await pg.control.query("DROP SCHEMA graeboard CASCADE");
  const env = {
    PG_TEAM: pg.env.PG_TEAM,
    SYNC_PROFILES: JSON.stringify([
      { profileId: "contract", teamId: f.teamId, databaseBinding: "PG_TEAM" },
    ]),
  };
  await pg.pool.query(
    "UPDATE graeboard.site_entities SET payload=jsonb_set(payload::jsonb,'{years}','[2029]')::text WHERE entity='task'",
  );
  f.db.prepare("DELETE FROM cells").run();
  f.db.prepare("DELETE FROM tasks").run();
  const retired = randomUUID();
  await pg.pool.query(
    "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'person',$2,$3,1,0)",
    [
      f.teamId,
      JSON.stringify([retired]),
      JSON.stringify({ name: "Former owner" }),
    ],
  );
  const app = createApp({
      db: f.db,
      rateLimits: false,
      storage: createPostgresBusinessStorage({ env }),
      documentImagesDir: f.dir + "/images",
      syncOptions: { schedule: false, installationId: f.link.installation_id },
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (
    path,
    method = "GET",
    body,
    cookie = "weekly_session=" + f.user.id,
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: unpack(await response.json()),
      headers: response.headers,
    };
  };
  let response = await api("/api/bootstrap");
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.years.includes(2029));
  assert.ok(
    response.data.users.some(
      (u) => u.id === retired && u.name === "Former owner",
    ),
  );
  assert.equal(
    response.data.authMode,
    undefined,
    "password host auth is preserved",
  );
  const memberInput = {
    username: "node-pg-member@example.test",
    password: "a-real-test-password",
    name: "Node PG member",
    memberships: [{ teamId: f.teamId, role: "member" }],
  };
  const created = await api("/api/admin/users", "POST", memberInput);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const memberId = created.data.user.id;
  const login = await api(
    "/api/auth/login",
    "POST",
    { username: memberInput.username, password: memberInput.password },
    "",
  );
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const memberCookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(memberCookie.startsWith("weekly_session="));
  const viewerInput = {
    ...memberInput,
    username: "node-pg-viewer@example.test",
    name: "Node PG viewer",
    memberships: [{ teamId: f.teamId, role: "viewer" }],
  };
  const viewer = await api("/api/admin/users", "POST", viewerInput);
  assert.equal(viewer.status, 201, JSON.stringify(viewer.data));
  const viewerLogin = await api(
    "/api/auth/login",
    "POST",
    { username: viewerInput.username, password: viewerInput.password },
    "",
  );
  assert.equal(viewerLogin.status, 200, JSON.stringify(viewerLogin.data));
  const viewerCookie = viewerLogin.headers.get("set-cookie").split(";")[0];
  const snap = await api(
    `/api/tasks?teamId=${f.teamId}&year=2029`,
    "GET",
    undefined,
    memberCookie,
  );
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  assert.equal(snap.data.tasks[0].id, f.taskId);
  response = await api(
    "/api/tasks",
    "POST",
    {
      teamId: f.teamId,
      year: 2029,
      fields: { title: "new Node-authorized PG task" },
    },
    memberCookie,
  );
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const task = response.data.task;
  const viewerSnapshot = await api(
      `/api/tasks?teamId=${f.teamId}&year=2029`,
      "GET",
      undefined,
      viewerCookie,
    ),
    after = viewerSnapshot.headers.get("x-cell-event-id");
  assert.equal(viewerSnapshot.status, 200, JSON.stringify(viewerSnapshot.data));
  assert.ok(viewerSnapshot.data.tasks.some((row) => row.id === task.id));
  assert.match(after, /^pg:/);
  const eventPath = `/api/cells/events?teamId=${f.teamId}&year=2029&after=${after}`,
    dedicated = await cellStream(t, base, eventPath, memberCookie, after),
    multiplex = await cellStream(t, base, eventPath, memberCookie, after, true);
  await dedicated.next("ready");
  await multiplex.next("ready");
  const command = {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value: "saved in PG",
          expectedVersion: task.cells.title.version,
        },
      ],
    },
    storedState = async () =>
      (
        await pg.pool.query(
          "SELECT (SELECT payload FROM graeboard.site_entities WHERE entity='cell' AND entity_key=$1) payload, (SELECT count(*) FROM graeboard.site_operations) operations, (SELECT count(*) FROM graeboard.site_audit) audit, (SELECT count(*) FROM graeboard.site_events) events, (SELECT count(*) FROM graeboard.sync_outbox) pending",
          [JSON.stringify([task.id, "title"])],
        )
      ).rows[0];
  const beforeDenied = await storedState(),
    viewerSave = await api("/api/cells/batch", "POST", command, viewerCookie);
  assert.ok([403, 404].includes(viewerSave.status), JSON.stringify(viewerSave));
  assert.deepEqual(
    await storedState(),
    beforeDenied,
    "viewer denial must not change PG data, replay, audit, events or pending",
  );
  const save = await api("/api/cells/batch", "POST", command, memberCookie);
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const dedicatedEvent = await dedicated.next("cells"),
    multiplexEvent = await multiplex.next("cells");
  assert.deepEqual(dedicatedEvent.data.cells, save.data.cells);
  assert.deepEqual(multiplexEvent.data.cells, save.data.cells);
  assert.equal(dedicatedEvent.id, multiplexEvent.id);
  assert.match(dedicatedEvent.id, /^pg:/);
  const latestSnapshot = await api(
    `/api/tasks?teamId=${f.teamId}&year=2029`,
    "GET",
    undefined,
    memberCookie,
  );
  assert.equal(
    latestSnapshot.headers.get("x-cell-event-id"),
    dedicatedEvent.id,
  );
  assert.equal(
    latestSnapshot.data.tasks.find((row) => row.id === task.id).cells.title
      .version,
    save.data.cells[0].version,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM tasks").get().n,
    0,
    "team records have no SQLite mirror",
  );
  assert.equal(
    (
      await pg.pool.query(
        "SELECT payload::jsonb->'value' value FROM graeboard.site_entities WHERE entity='cell' AND entity_key=$1",
        [JSON.stringify([task.id, "title"])],
      )
    ).rows[0].value,
    "saved in PG",
  );
  response = await api(
    `/api/tasks/${task.id}/documents`,
    "GET",
    undefined,
    memberCookie,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await api(
    `/api/reports?teamId=${f.teamId}`,
    "GET",
    undefined,
    memberCookie,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await api("/api/admin/history-cleanup/storage");
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.scopes.some((s) => s.id === f.teamId));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(base + `/api/teams/${f.teamId}/events`, {
    headers: { Cookie: memberCookie },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  let frames = decoder.decode((await reader.read()).value);
  assert.match(frames, /event: document/);
  const members = (await api(`/api/teams/${f.teamId}/members`)).data.members;
  response = await api(`/api/teams/${f.teamId}/members`, "PUT", {
    previous: members,
    members: members.filter((m) => m.userId !== memberId),
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const denied = await api(
    `/api/tasks?teamId=${f.teamId}&year=2029`,
    "GET",
    undefined,
    memberCookie,
  );
  assert.equal(
    denied.status,
    403,
    "SQLite control membership is the sole authority",
  );
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      frames += decoder.decode(row.value);
    }
  } finally {
    clearTimeout(deadline);
  }
  assert.match(frames, /access-revoked/);
  assert.equal((await dedicated.next("access-revoked")).data.status, 403);
  assert.equal((await multiplex.next("access-revoked")).data.status, 403);
  assert.equal(
    (await pg.control.query("SELECT to_regclass('graeboard.users') name"))
      .rows[0].name,
    null,
    "no PostgreSQL identity or membership table was used",
  );
});
