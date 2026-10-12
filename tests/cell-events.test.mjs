import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";

async function fixture(t, cellEventOptions = {}) {
  const db = openDatabase(":memory:");
  const team = randomUUID(),
    otherTeam = randomUUID();
  const admin = randomUUID(),
    member = randomUUID();
  for (const id of [team, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      id,
      json(DEFAULT_SETTINGS),
    );
  for (const [id, role] of [
    [admin, "admin"],
    [member, "user"],
  ]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, id, "SSE 검증", "unused", role, now());
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(id, team, "lead");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 60000,
    );
  }
  const task = insertTask(db, {
    teamId: team,
    year: 2026,
    actorId: admin,
    fields: { title: "기존 업무", owner: member },
  });
  const otherTask = insertTask(db, {
    teamId: otherTeam,
    year: 2026,
    actorId: admin,
    fields: { title: "다른 팀 업무", owner: admin },
  });
  const app = createApp({ db, rateLimits: false, cellEventOptions });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.close();
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  async function request(
    path,
    { method = "GET", body, user = admin, headers = {} } = {},
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(user ? { Cookie: `weekly_session=${user}` } : {}),
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : json(body),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.status === 304 ? null : await res.json(),
    };
  }
  async function snapshot(id = team, year = 2026, headers) {
    return request(`/tasks?teamId=${id}&year=${year}`, { headers });
  }
  async function save(
    value,
    {
      id = task.id,
      key = "title",
      operationId = randomUUID(),
      expectedVersion,
      user = admin,
    } = {},
  ) {
    return request("/cells/batch", {
      method: "POST",
      user,
      body: {
        operationId,
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: id,
            key,
            value,
            expectedVersion:
              expectedVersion ?? getTask(db, id).cells[key]?.version ?? 0,
          },
        ],
      },
    });
  }
  async function stream(
    after,
    {
      id = team,
      year = 2026,
      startMonth = 1,
      user = member,
      headers = {},
    } = {},
  ) {
    const abort = new AbortController();
    const res = await fetch(
      `${base}/cells/events?${new URLSearchParams({ teamId: id, year: String(year), startMonth: String(startMonth), after })}`,
      {
        headers: { Cookie: `weekly_session=${user}`, ...headers },
        signal: abort.signal,
      },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(
      res.headers.get("content-encoding"),
      null,
      "SSE를 압축 버퍼에 가두지 않는다",
    );
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const queue = [],
      all = [];
    let pending;
    const reader = res.body.getReader();
    const done = (async () => {
      const decoder = new TextDecoder();
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
            const type = frame.match(/^event: (.+)$/m)?.[1];
            if (!type) continue;
            const event = {
              type,
              id: frame.match(/^id: (.+)$/m)?.[1],
              data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "{}"),
            };
            all.push(event);
            if (pending) {
              const resolve = pending;
              pending = undefined;
              resolve(event);
            } else queue.push(event);
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) throw e;
      }
    })();
    const result = {
      all,
      close: () => abort.abort(),
      async next() {
        if (queue.length) return queue.shift();
        let timeout;
        try {
          return await Promise.race([
            new Promise((resolve) => {
              pending = resolve;
            }),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("SSE 이벤트 수신 시간 초과")),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
          pending = undefined;
        }
      },
      done,
    };
    streams.push(result);
    return result;
  }
  return {
    db,
    app,
    team,
    otherTeam,
    admin,
    member,
    task,
    otherTask,
    request,
    save,
    snapshot,
    stream,
  };
}

test("셀 저장 후 SSE로 변경 셀을 전달하고 HTTP 스냅샷과 같은 버전을 사용한다", async (t) => {
  const f = await fixture(t);
  const initial = await f.snapshot();
  const s = await f.stream(initial.headers.get("x-cell-event-id"), {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal((await s.next()).type, "ready");
  const saved = await f.save("실시간 값");
  assert.equal(saved.status, 200);
  const event = await s.next();
  assert.equal(event.type, "cells");
  assert.deepEqual(event.data.cells, saved.body.cells);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "실시간 값");
  assert.deepEqual(Object.keys(event.data).sort(), [
    "cells",
    "operationId",
    "updatedAt",
  ]);
  const current = await f.snapshot();
  assert.equal(current.headers.get("x-cell-event-id"), event.id);
  const unchanged = await f.snapshot(f.team, 2026, {
    "If-None-Match": current.headers.get("etag"),
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("x-cell-event-id"), event.id);
});

test("충돌·롤백·중복 재시도와 개인 View·서식만 저장한 작업은 값 알림을 추가하지 않는다", async (t) => {
  const f = await fixture(t);
  const cursor = (await f.snapshot()).headers.get("x-cell-event-id");
  const operationId = randomUUID();
  assert.equal(
    (await f.save("성공", { operationId, expectedVersion: 1 })).status,
    200,
  );
  assert.equal(
    (await f.save("성공", { operationId, expectedVersion: 1 })).status,
    200,
  );
  const failed = await f.request("/cells/batch", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: f.task.id,
          key: "title",
          value: "롤백될 값",
          expectedVersion: 2,
        },
        {
          taskId: f.otherTask.id,
          key: "title",
          value: "충돌",
          expectedVersion: 99,
        },
      ],
    },
  });
  assert.equal(failed.status, 409);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "성공");
  const styled = await f.request("/cells/batch", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: f.task.id,
          key: "title",
          style: { bold: true },
          expectedVersion: 2,
        },
      ],
    },
  });
  assert.equal(styled.status, 200);
  const view = { ...defaultView(2026), hiddenRows: [f.task.id] };
  assert.equal(
    (
      await f.request("/views", {
        method: "PUT",
        user: f.member,
        body: { teamId: f.team, name: "__current", data: view },
      })
    ).status,
    200,
  );
  const ownViews = await f.request(`/views?teamId=${f.team}&year=2026`, {
    user: f.admin,
  });
  assert.deepEqual(ownViews.body.views, []);
  const replay = await f.stream(cursor);
  assert.equal((await replay.next()).data.cells[0].value, "성공");
  assert.equal((await replay.next()).type, "ready");
  assert.equal(replay.all.filter((e) => e.type === "cells").length, 1);
});

test("Last-Event-ID 이후 누락된 변경만 재전송하며 팀·연도 범위를 분리한다", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("UPDATE tasks SET years=? WHERE id=?")
    .run("[2026,2027]", f.task.id);
  const original = (await f.snapshot()).headers.get("x-cell-event-id");
  await f.save("첫 변경");
  const first = (await f.snapshot()).headers.get("x-cell-event-id");
  await f.save("끊긴 동안 변경");
  const replay = await f.stream(original, {
    headers: { "Last-Event-ID": first },
  });
  assert.equal((await replay.next()).data.cells[0].value, "끊긴 동안 변경");
  assert.equal((await replay.next()).type, "ready");
  const nextYear = await f.stream(first, { year: 2027 });
  assert.equal((await nextYear.next()).data.cells[0].value, "끊긴 동안 변경");
  assert.equal((await nextYear.next()).type, "ready");
  const unrelatedYear = await f.stream(original, { year: 2025 });
  assert.equal((await unrelatedYear.next()).type, "ready");
  const otherTeam = await f.stream(original, {
    id: f.otherTeam,
    user: f.admin,
  });
  assert.equal((await otherTeam.next()).type, "ready");
  await f.save("다른 팀의 새 값", { id: f.otherTask.id });
  assert.equal((await otherTeam.next()).data.cells[0].taskId, f.otherTask.id);
  assert.equal(otherTeam.all.filter((e) => e.type === "cells").length, 1);
});

test("재전송 한도를 넘거나 서버 세대가 바뀌면 최신 스냅샷으로 복구하도록 알린다", async (t) => {
  const f = await fixture(t, { replayCount: 1 });
  const cursor = (await f.snapshot()).headers.get("x-cell-event-id");
  await f.save("1");
  await f.save("2");
  const expired = await f.stream(cursor);
  assert.equal((await expired.next()).type, "reset");
  const restarted = await f.stream(`${randomUUID()}:2`);
  assert.equal((await restarted.next()).type, "reset");
  const fresh = await f.snapshot();
  assert.equal(fresh.body.tasks[0].cells.title.value, "2");
  const restored = await f.stream(fresh.headers.get("x-cell-event-id"));
  assert.equal((await restored.next()).type, "ready");
  await f.save("복구 뒤 변경");
  assert.equal((await restored.next()).data.cells[0].value, "복구 뒤 변경");
});

test("큰 배치는 SSE 버퍼에 복제하지 않고 스냅샷 재동기화를 요청한다", async (t) => {
  const f = await fixture(t, { maxEventBytes: 100 });
  const s = await f.stream((await f.snapshot()).headers.get("x-cell-event-id"));
  await s.next();
  assert.equal((await f.save("큰 입력".repeat(300))).status, 200);
  assert.equal((await s.next()).type, "reset");
  assert.equal(
    (await f.snapshot()).body.tasks[0].cells.title.value,
    "큰 입력".repeat(300),
  );
});

test("SSE 구독 및 전송 시 인증·팀 접근을 재검사하고 권한 회수·로그아웃 후 전달을 중단한다", async (t) => {
  const f = await fixture(t, { heartbeatMs: 25 });
  const path = `/cells/events?teamId=${f.team}&year=2026`;
  assert.equal((await f.request(path, { user: null })).status, 401);
  assert.equal(
    (
      await f.request(`/cells/events?teamId=${f.otherTeam}&year=2026`, {
        user: f.member,
      })
    ).status,
    403,
  );
  const cursor = (await f.snapshot()).headers.get("x-cell-event-id");
  const memberStream = await f.stream(cursor);
  assert.equal((await memberStream.next()).type, "ready");
  f.db.prepare("DELETE FROM memberships WHERE user_id=?").run(f.member);
  await f.save("권한 없는 사람에게 전달 금지");
  assert.equal((await memberStream.next()).type, "access-revoked");
  assert.equal(
    memberStream.all.some((e) => e.type === "cells"),
    false,
  );
  const adminStream = await f.stream(cursor, { user: f.admin });
  await adminStream.next();
  await adminStream.next();
  assert.equal(
    (await f.request("/auth/logout", { method: "POST", body: {} })).status,
    200,
  );
  assert.equal((await adminStream.next()).type, "access-revoked");
});

test("두 해의 SSE는 공통 업무를 중복하지 않고 한 작업을 하나의 이벤트로 재전송한다", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("UPDATE tasks SET years=? WHERE id=?")
    .run("[2026,2027]", f.task.id);
  const onlyCurrent = insertTask(f.db, {
    teamId: f.team,
    year: 2026,
    actorId: f.admin,
    fields: { title: "올해만" },
  });
  const onlyFuture = insertTask(f.db, {
    teamId: f.team,
    year: 2027,
    actorId: f.admin,
    fields: { title: "내년만" },
  });
  const later = insertTask(f.db, {
    teamId: f.team,
    year: 2028,
    actorId: f.admin,
    fields: { title: "그다음 해" },
  });
  const before = await f.request(
    `/tasks?teamId=${f.team}&year=2026&startMonth=2`,
  );
  assert.equal(before.body.tasks.length, 3);
  const cursor = before.headers.get("x-cell-event-id");
  const live = await f.stream(cursor, { startMonth: 2 });
  assert.equal((await live.next()).type, "ready");
  const ids = [f.task.id, onlyCurrent.id, onlyFuture.id, later.id];
  const saved = await f.request("/cells/batch", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: ids.map((taskId) => ({
        taskId,
        key: "title",
        value: "연말 연초 실시간",
        expectedVersion: getTask(f.db, taskId).cells.title.version,
      })),
    },
  });
  assert.equal(saved.status, 200);
  const event = await live.next();
  assert.equal(event.type, "cells");
  assert.equal(event.data.cells.length, 3);
  assert.deepEqual(
    new Set(event.data.cells.map((c) => c.taskId)),
    new Set(ids.slice(0, 3)),
  );
  live.close();
  const replay = await f.stream(cursor, { startMonth: 2 });
  const repeated = await replay.next();
  assert.equal(repeated.id, event.id);
  assert.deepEqual(repeated.data, event.data);
  assert.equal((await replay.next()).type, "ready");
  const caughtUp = await f.stream(event.id, { startMonth: 2 });
  assert.equal((await caughtUp.next()).type, "ready");
});
