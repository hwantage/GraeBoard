import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { defaultView } from "../shared/domain.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { parseCompact, unpack } from "../shared/compact.js";

async function openStream(
  t,
  origin,
  path,
  user,
  { multiplex = false, after = "" } = {},
) {
  const abort = new AbortController(),
    events = [];
  t.after(() => abort.abort());
  const response = await fetch(origin + (multiplex ? "/api/events" : path), {
    method: multiplex ? "POST" : "GET",
    signal: abort.signal,
    headers: {
      Cookie: "weekly_session=" + user,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    ...(multiplex
      ? {
          body: JSON.stringify({
            streams: [{ id: 5, path, lastEventId: after }],
          }),
        }
      : {}),
  });
  assert.equal(
    response.status,
    200,
    await (response.status === 200 ? Promise.resolve("") : response.text()),
  );
  const reader = response.body.getReader();
  let failure,
    ended = false;
  (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let type = frame.match(/^event: (.+)$/m)?.[1];
          if (!type) continue;
          let data = parseCompact(frame.match(/^data: (.+)$/m)?.[1] || "{}"),
            id = frame.match(/^id: (.+)$/m)?.[1];
          if (type === "stream") {
            id = data.lastEventId;
            type = data.event;
            data = parseCompact(data.data);
          }
          events.push({ type, data, id });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    } finally {
      ended = true;
    }
  })();
  return {
    events,
    close: () => abort.abort(),
    async next(type) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const i = events.findIndex((e) => e.type === type);
        if (i >= 0) return events.splice(i, 1)[0];
        assert.equal(ended, false, "SSE ended before " + type);
        await delay(15);
      }
      throw new Error("SSE timeout " + type + ": " + JSON.stringify(events));
    },
  };
}

test("M6 external PG task uses same backend for snapshot/save/dedicated+multiplex SSE and revalidates non-admin permissions", async (t) => {
  const pg = await postgresFixture(t),
    f = pg;
  if (!pg) return;
  const member = randomUUID(),
    outsider = randomUUID(),
    viewer = randomUUID();
  for (const [id, role] of [
    [member, "member"],
    [outsider, null],
    [viewer, "viewer"],
  ]) {
    f.db
      .prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
      )
      .run(id, id, id, new Date().toISOString());
    f.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(
        createHash("sha256").update(id).digest("hex"),
        id,
        Date.now() + 600000,
      );
    await pg.control.query(
      "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$1,$2,$1,'user',$3)",
      [id, id + "@example.test", new Date().toISOString()],
    );
    if (role) {
      f.db
        .prepare("INSERT INTO memberships VALUES(?,?,?)")
        .run(id, f.teamId, role);
      await pg.control.query(
        "INSERT INTO graeboard.memberships VALUES($1,$2,$3)",
        [id, f.teamId, role],
      );
    }
  }
  const taskId = randomUUID();
  await pg.makeContext().data(
    f.teamId,
    async (s) => {
      const original = await s.get("task", [f.taskId]);
      await s.put("task", [taskId], { ...original.payload, position: 200 });
      await s.put("cell", [taskId, "title"], {
        value: "PostgreSQL only",
        style: {},
      });
    },
    { write: true },
  );
  assert.equal(
    f.db.prepare("SELECT id FROM tasks WHERE id=?").get(taskId),
    undefined,
  );
  const app = createExternalRouteApp({
      env: pg.env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => pg.makeContext(user, request),
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = async (
    path,
    { user = member, method = "GET", body } = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Cookie: "weekly_session=" + user,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json().then(unpack),
    };
  };
  const teamStream = await openStream(
    t,
    origin,
    "/api/teams/" + f.teamId + "/events",
    member,
  );
  const firstTeamEvent = await teamStream.next("document");
  const created = await request("/api/tasks", {
    method: "POST",
    body: {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "Created through external PG route" },
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const createdId = created.body.task.id;
  const structural = await teamStream.next("document");
  assert.notEqual(structural.data.revision, firstTeamEvent.data.revision);
  assert.equal(
    f.db.prepare("SELECT id FROM tasks WHERE id=?").get(createdId),
    undefined,
  );
  let legacyTaskLookups = 0;
  const originalPrepare = f.db.prepare.bind(f.db);
  const lookupSpy = t.mock.method(f.db, "prepare", (sql) => {
    if (sql === "SELECT team_id FROM tasks WHERE id=?") legacyTaskLookups++;
    return originalPrepare(sql);
  });
  const patched = await request("/api/tasks/" + createdId, {
    method: "PATCH",
    body: { updatedAt: created.body.task.updatedAt, years: [2026, 2027] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  lookupSpy.mock.restore();
  assert.equal(
    legacyTaskLookups,
    0,
    "PG task mutation must not consult legacy SQLite owner lookup",
  );
  await teamStream.next("document");
  teamStream.close();
  assert.deepEqual(patched.body.task.years, [2026, 2027]);
  const move = await request("/api/tasks/reorder", {
    method: "POST",
    body: {
      taskId: createdId,
      updatedAt: patched.body.task.updatedAt,
      targetId: taskId,
      targetUpdatedAt: (
        await request("/api/tasks?teamId=" + f.teamId + "&year=2026")
      ).body.tasks.find((row) => row.id === taskId).updatedAt,
      year: 2026,
      placement: "before",
    },
  });
  assert.equal(move.status, 200, JSON.stringify(move.body));
  const remove = await request("/api/tasks/" + createdId, {
    method: "DELETE",
    body: { updatedAt: move.body.task.updatedAt },
  });
  assert.equal(remove.status, 200, JSON.stringify(remove.body));
  const restore = await request("/api/tasks/" + createdId + "/restore", {
    method: "POST",
    body: { updatedAt: remove.body.updatedAt },
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  const pendingBeforeView = (
    await pg.pool.query("SELECT COUNT(*) AS n FROM graeboard.sync_outbox")
  ).rows[0].n;
  const personal = await request("/api/views", {
    user: viewer,
    method: "PUT",
    body: {
      teamId: f.teamId,
      name: "__current",
      data: { ...defaultView(2026), hiddenRows: [createdId] },
    },
  });
  assert.equal(personal.status, 200, JSON.stringify(personal.body));
  assert.equal(
    (await pg.pool.query("SELECT COUNT(*) AS n FROM graeboard.sync_outbox"))
      .rows[0].n,
    pendingBeforeView,
  );
  assert.deepEqual(
    (
      await request("/api/views?teamId=" + f.teamId + "&year=2026", {
        user: viewer,
      })
    ).body.views[0].data.hiddenRows,
    [createdId],
  );
  assert.deepEqual(
    (await request("/api/views?teamId=" + f.teamId + "&year=2026")).body.views,
    [],
  );
  const path = "/api/tasks?teamId=" + f.teamId + "&year=2026",
    snapshot = await request(path),
    task = snapshot.body.tasks.find((row) => row.id === taskId);
  assert.equal(snapshot.status, 200);
  assert.equal(task.cells.title.value, "PostgreSQL only");
  assert.match(snapshot.headers.get("x-cell-event-id"), /^pg:/);
  assert.equal((await request(path, { user: outsider })).status, 403);
  const eventPath =
    "/api/cells/events?teamId=" +
    f.teamId +
    "&year=2026&after=" +
    snapshot.headers.get("x-cell-event-id");
  assert.equal((await request(eventPath, { user: outsider })).status, 403);
  const dedicated = await openStream(t, origin, eventPath, member),
    multiplex = await openStream(t, origin, eventPath, member, {
      multiplex: true,
      after: snapshot.headers.get("x-cell-event-id"),
    });
  await dedicated.next("ready");
  await multiplex.next("ready");
  const command = {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId,
        key: "title",
        expectedVersion: task.cells.title.version,
        value: "PG save with live Node delivery",
      },
    ],
  };
  assert.ok(
    [403, 404].includes(
      (
        await request("/api/cells/batch", {
          user: viewer,
          method: "POST",
          body: command,
        })
      ).status,
    ),
  );
  const save = await request("/api/cells/batch", {
    method: "POST",
    body: command,
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const event = await dedicated.next("cells"),
    mux = await multiplex.next("cells");
  assert.deepEqual(event.data.cells, save.body.cells);
  assert.deepEqual(mux.data.cells, save.body.cells);
  assert.equal(mux.id, event.id);
  assert.equal(
    f.db.prepare("SELECT id FROM tasks WHERE id=?").get(taskId),
    undefined,
  );
  const latest = await request(path);
  assert.equal(latest.headers.get("x-cell-event-id"), event.id);
  assert.equal(
    latest.body.tasks.find((row) => row.id === taskId).cells.title.version,
    save.body.cells[0].version,
  );
  const replay = await openStream(t, origin, eventPath, member);
  assert.deepEqual((await replay.next("cells")).data.cells, save.body.cells);
  replay.close();
  const original = latest.body.tasks.find((row) => row.id === f.taskId);
  const removed = await request(`/api/tasks/${f.taskId}`, {
    user: f.user.id,
    method: "DELETE",
    body: { updatedAt: original.updatedAt },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const deletion = (
    await request(`/api/audit?teamId=${f.teamId}&taskId=${f.taskId}&limit=1`)
  ).body.entries[0];
  assert.equal(deletion.action, "delete");
  const restored = await request(`/api/audit/${deletion.id}/restore`, {
    user: f.user.id,
    method: "POST",
    body: {},
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.tasks[0].deletedAt, null);
  await pg.control.query("DELETE FROM graeboard.memberships WHERE user_id=$1", [
    member,
  ]);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM memberships WHERE user_id=?")
      .get(member).n,
    1,
    "external membership revocation is independent of SQLite",
  );
  assert.equal((await dedicated.next("access-revoked")).data.status, 403);
  assert.equal((await multiplex.next("access-revoked")).data.status, 403);
  assert.equal((await request(path)).status, 403);
});
