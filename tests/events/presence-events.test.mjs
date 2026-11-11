import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../server/app.mjs";
import { openDatabase, json, now } from "../../server/db.mjs";
import { DEFAULT_SETTINGS } from "../../shared/domain.js";
import { createPresenceEvents } from "../../server/events/presence-events.mjs";

async function fixture(t) {
  const db = openDatabase(":memory:");
  const team = randomUUID(),
    otherTeam = randomUUID();
  for (const id of [team, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      id,
      json(DEFAULT_SETTINGS),
    );
  const users = {};
  for (const [name, teamId] of [
    ["lead", team],
    ["member", team],
    ["outsider", otherTeam],
  ]) {
    const id = randomUUID();
    users[name] = id;
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, id, name, "unused", "user", now());
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(id, teamId, "lead");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 60000,
    );
  }
  const app = createApp({ db, rateLimits: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const streams = [];
  t.after(async () => {
    for (const close of streams) close();
    app.locals.presenceEvents.shutdown();
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const post = (user, body, clientId = randomUUID()) =>
    fetch(`${base}/presence`, {
      method: "POST",
      headers: {
        Cookie: `weekly_session=${user}`,
        "X-Requested-With": "WeeklyPlan",
        "X-Client-ID": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  async function stream(user, teamId = team) {
    const abort = new AbortController();
    const res = await fetch(`${base}/presence/events?teamId=${teamId}`, {
      headers: { Cookie: `weekly_session=${user}` },
      signal: abort.signal,
    });
    if (res.status !== 200) return { status: res.status };
    streams.push(() => abort.abort());
    const queue = [];
    let pending;
    void (async () => {
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!/^event: presence$/m.test(frame)) continue;
            const event = JSON.parse(frame.match(/^data: (.+)$/m)[1]);
            if (pending) pending(event);
            else queue.push(event);
            pending = undefined;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();
    return {
      status: res.status,
      next: () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : Promise.race([
              new Promise((resolve) => (pending = resolve)),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("수신 시간 초과")), 2000),
              ),
            ]),
    };
  }
  return { team, otherTeam, users, post, stream };
}

test("같은 팀 사람에게 선택·편집 셀을 SSE로 알리고 해제하면 지운다", async (t) => {
  const f = await fixture(t);
  const watcher = await f.stream(f.users.member);
  assert.deepEqual(await watcher.next(), { cells: [] });
  const tab = randomUUID();
  const at = { teamId: f.team, taskId: randomUUID(), key: "title" };
  assert.equal(
    (await f.post(f.users.lead, { ...at, editing: false }, tab)).status,
    200,
  );
  const [shown] = (await watcher.next()).cells;
  assert.match(shown.color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(shown, {
    userId: f.users.lead,
    name: "lead",
    color: shown.color,
    taskId: at.taskId,
    key: "title",
    editing: false,
  });
  await f.post(f.users.lead, { ...at, editing: true }, tab);
  assert.equal((await watcher.next()).cells[0].editing, true);
  // The person's own stream never lists their own cell.
  const self = await f.stream(f.users.lead);
  assert.deepEqual(await self.next(), { cells: [] });
  await f.post(
    f.users.lead,
    { teamId: f.team, taskId: null, key: null, editing: false },
    tab,
  );
  assert.deepEqual(await watcher.next(), { cells: [] });
});

test("팀 밖의 사용자는 위치를 보내거나 받을 수 없고 다른 팀 위치는 섞이지 않는다", async (t) => {
  const f = await fixture(t);
  const cell = { taskId: randomUUID(), key: "title", editing: false };
  assert.equal(
    (await f.post(f.users.outsider, { teamId: f.team, ...cell })).status,
    403,
  );
  assert.equal((await f.stream(f.users.outsider)).status, 403);
  assert.equal(
    (await f.post(f.users.lead, { teamId: f.team, ...cell }, "not-a-tab"))
      .status,
    400,
  );
  const watcher = await f.stream(f.users.member);
  await watcher.next();
  await f.post(f.users.outsider, { teamId: f.otherTeam, ...cell });
  await f.post(f.users.lead, { teamId: f.team, ...cell, key: "owner" });
  assert.deepEqual(
    (await watcher.next()).cells.map((entry) => entry.key),
    ["owner"],
  );
});

test("다시 보내지 않은 탭의 위치는 만료되고 팀 권한을 잃으면 구독을 닫는다", async () => {
  let allowed = true;
  const presence = createPresenceEvents({
    refreshUser: (req) => req.user,
    teamAccess: () => {
      if (!allowed) throw Object.assign(new Error("denied"), { status: 403 });
    },
    ttlMs: 30,
    heartbeatMs: 20,
  });
  const writes = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    set() {},
    flushHeaders() {},
    write: (chunk) => writes.push(chunk),
    end() {
      this.writableEnded = true;
      this.emit("close");
    },
  });
  presence.subscribe({ user: { id: "watcher" } }, res, "team");
  presence.update({ id: "other", name: "다른 사람" }, randomUUID(), {
    teamId: "team",
    taskId: "task",
    key: "title",
  });
  const frames = () =>
    writes.filter((chunk) => chunk.includes("event: presence"));
  const cells = () =>
    frames().map((chunk) => JSON.parse(chunk.split("data: ")[1]).cells.length);
  assert.deepEqual(cells(), [0, 1]);
  // Ids let a tab joining a shared stream ask for the current list.
  const ids = frames().map((chunk) => chunk.match(/^id: (.+)$/m)[1]);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0].split(":")[0], ids[1].split(":")[0]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(cells(), [0, 1, 0]);
  allowed = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(writes.some((chunk) => chunk.startsWith("event: access-revoked")));
  assert.equal(res.writableEnded, true);
  presence.shutdown();
});

test("한 사람이 보내는 탭 위치는 20개까지만 보관한다", () => {
  const presence = createPresenceEvents({
    refreshUser: (req) => req.user,
    teamAccess: () => {},
  });
  const writes = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    set() {},
    flushHeaders() {},
    write: (chunk) => writes.push(chunk),
    end() {
      this.writableEnded = true;
      this.emit("close");
    },
  });
  presence.subscribe({ user: { id: "watcher" } }, res, "team");
  for (let i = 0; i < 25; i++)
    presence.update({ id: "busy", name: "탭 많은 사람" }, randomUUID(), {
      teamId: "team",
      taskId: `task-${i}`,
      key: "title",
    });
  const last = writes
    .filter((chunk) => chunk.includes("event: presence"))
    .at(-1);
  const cells = JSON.parse(last.split("data: ")[1]).cells;
  assert.equal(cells.length, 20);
  assert.equal(cells[0].taskId, "task-5");
  presence.shutdown();
});

test("같은 셀에 있어도 이름·색이 바뀌면 다시 알린다", () => {
  const presence = createPresenceEvents({
    refreshUser: (req) => req.user,
    teamAccess: () => {},
  });
  const writes = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    set() {},
    flushHeaders() {},
    write: (chunk) => writes.push(chunk),
    end() {
      this.writableEnded = true;
      this.emit("close");
    },
  });
  presence.subscribe({ user: { id: "watcher" } }, res, "team");
  const tab = randomUUID(),
    cell = { teamId: "team", taskId: "task", key: "title" };
  presence.update(
    { id: "other", name: "이전 이름", color: "#111111" },
    tab,
    cell,
  );
  presence.update(
    { id: "other", name: "새 이름", color: "#222222" },
    tab,
    cell,
  );
  const last = writes
    .filter((chunk) => chunk.includes("event: presence"))
    .at(-1);
  assert.deepEqual(
    JSON.parse(last.split("data: ")[1]).cells.map(({ name, color }) => [
      name,
      color,
    ]),
    [["새 이름", "#222222"]],
  );
  presence.shutdown();
});
