import { unpack } from "../shared/compact.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import {
  DEFAULT_SETTINGS,
  defaultView,
  periodMonths,
  periodYears,
  weeksForPeriod,
  visibleWeeks,
} from "../shared/domain.js";

async function fixture(t) {
  const db = openDatabase(":memory:");
  const teamId = randomUUID(),
    userId = randomUUID(),
    peerId = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "기간 검증",
    json(DEFAULT_SETTINGS),
  );
  for (const uid of [userId, peerId]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(uid, uid, "검증", "unused", "admin", now());
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      uid,
      teamId,
      "lead",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(uid).digest("hex"),
      uid,
      Date.now() + 60000,
    );
  }
  const create = (year, title) =>
    insertTask(db, {
      teamId,
      year,
      actorId: userId,
      fields: { title, owner: userId },
    });
  const prior = create(2025, "이전 업무"),
    current = create(2026, "올해 업무"),
    carried = create(2026, "이어지는 업무"),
    future = create(2027, "내년 신규 업무"),
    later = create(2028, "그다음 해 업무");
  db.prepare("UPDATE tasks SET years=? WHERE id=?").run(
    "[2026,2027]",
    carried.id,
  );
  const app = createApp({ db, rateLimits: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  async function request(path, body, options = {}) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method: options.method || (body ? "POST" : "GET"),
        headers: {
          Cookie: `weekly_session=${options.user || userId}`,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: body ? json(body) : undefined,
      },
    );
    const data =
      response.status === 304
        ? null
        : response.headers.get("content-type")?.includes("json")
          ? await response.json().then(unpack)
          : await response.text();
    return { status: response.status, headers: response.headers, data };
  }
  return {
    db,
    teamId,
    userId,
    peerId,
    prior,
    current,
    carried,
    future,
    later,
    request,
  };
}

test("12개월 달력은 두 해까지만 포함하고 연말 주차를 중복하지 않는다", () => {
  assert.deepEqual(
    periodMonths(2026, 2).map((m) => m.key),
    [
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
    ],
  );
  const weeks = weeksForPeriod(2026, 2);
  const boundary = weeks.filter((w) => w.key === "2026-12-28");
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].year, 2027);
  assert.equal(boundary[0].month, 1);
  assert.equal(boundary[0].monthIndex, 12);
  const selected = visibleWeeks(2026, {
    ...defaultView(2026),
    startMonth: 2,
    fromMonth: 11,
    toMonth: 12,
  });
  assert(selected.some((w) => w.year === 2026 && w.month === 12));
  assert(selected.some((w) => w.year === 2027 && w.month === 1));
  assert(selected.every((w) => w.month === 12 || w.month === 1));
  for (let year = 2000; year <= 2100; year++)
    for (let month = 1; month <= (year === 2100 ? 1 : 12); month++) {
      const months = periodMonths(year, month),
        days = weeksForPeriod(year, month);
      assert.equal(months.length, 12);
      assert(new Set(months.map((m) => m.year)).size <= 2);
      assert.deepEqual(
        [...new Set(months.map((m) => m.year))],
        periodYears(year, month),
      );
      assert.equal(new Set(days.map((w) => w.key)).size, days.length);
      assert(days.length >= 52 && days.length <= 54);
      assert.deepEqual(
        [...new Set(days.map((w) => w.monthIndex))],
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      for (let i = 1; i < days.length; i++)
        assert.equal(
          Date.parse(days[i].key) - Date.parse(days[i - 1].key),
          7 * 86400000,
        );
    }
});

test("두 연도 조회는 업무를 한 번만 반환하고 월 이동 간 같은 캐시를 사용한다", async (t) => {
  const f = await fixture(t);
  const annual = await f.request(`/tasks?teamId=${f.teamId}&year=2026`);
  assert.deepEqual(
    new Set(annual.data.tasks.map((t) => t.id)),
    new Set([f.current.id, f.carried.id]),
  );
  const shifted = await f.request(
    `/tasks?teamId=${f.teamId}&year=2026&startMonth=2`,
  );
  assert.equal(shifted.status, 200);
  assert.deepEqual(
    new Set(shifted.data.tasks.map((t) => t.id)),
    new Set([f.current.id, f.carried.id, f.future.id]),
  );
  assert.equal(shifted.data.tasks.length, 3);
  assert.notEqual(shifted.headers.get("etag"), annual.headers.get("etag"));
  let taskReads = 0;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    if (sql.includes("SELECT * FROM tasks WHERE team_id")) taskReads++;
    return prepare(sql);
  };
  const moved = await f.request(
    `/tasks?teamId=${f.teamId}&year=2026&startMonth=3`,
    null,
    { headers: { "If-None-Match": shifted.headers.get("etag") } },
  );
  assert.equal(moved.status, 304);
  assert.equal(taskReads, 0);
  assert.equal(
    (await f.request(`/tasks?teamId=${f.teamId}&year=2100&startMonth=2`))
      .status,
    400,
  );
  assert.equal(
    (await f.request(`/tasks?teamId=${f.teamId}&year=2026&startMonth=13`))
      .status,
    400,
  );
});

test("시작 월은 개인 보기에 저장되고 두 해의 보고본과 현재 보기 반출에 보존된다", async (t) => {
  const f = await fixture(t);
  const view = {
    ...defaultView(2026),
    startMonth: 2,
    fromMonth: 11,
    toMonth: 12,
  };
  assert.equal(
    (
      await f.request(
        "/views",
        { teamId: f.teamId, name: "__current", data: view },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  const own = await f.request(`/views?teamId=${f.teamId}&year=2026`);
  assert.equal(own.data.views[0].data.startMonth, 2);
  assert.equal(
    (
      await f.request(`/views?teamId=${f.teamId}&year=2026`, null, {
        user: f.peerId,
      })
    ).data.views.length,
    0,
  );
  const taskIds = [f.current.id, f.carried.id, f.future.id];
  const report = await f.request("/reports", {
    teamId: f.teamId,
    year: 2026,
    referenceDate: "2027-01-08",
    name: "연말 연초",
    view,
    taskIds,
  });
  assert.equal(report.status, 201);
  const saved = await f.request(`/reports/${report.data.id}`);
  assert.equal(saved.data.view.startMonth, 2);
  assert.deepEqual(
    new Set(saved.data.tasks.map((t) => t.id)),
    new Set(taskIds),
  );
  const exported = await f.request("/export", {
    teamId: f.teamId,
    year: 2026,
    startMonth: 2,
    format: "json",
    scope: "view",
    taskIds,
    keys: ["title", "2026-12-28", "2027-01-04"],
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.startMonth, 2);
  assert.equal(exported.data.tasks.length, 3);
  const full = await f.request("/export", {
    teamId: f.teamId,
    year: 2026,
    startMonth: 2,
    format: "json",
    scope: "all",
  });
  assert.equal(full.data.startMonth, 1);
  assert.equal(full.data.tasks.length, 2);
  const outside = await f.request("/export", {
    teamId: f.teamId,
    year: 2026,
    startMonth: 2,
    format: "json",
    scope: "view",
    taskIds,
    keys: ["title", "2027-06-07"],
  });
  assert.equal(outside.status, 400);
});

test("통합 화면에서 추가·삽입은 기준 연도로 저장하고 서로 다른 연도의 행 이동을 처리한다", async (t) => {
  const f = await fixture(t);
  const added = await f.request("/tasks", {
    teamId: f.teamId,
    year: 2026,
    startMonth: 2,
    fields: { title: "기준 연도 추가" },
  });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.task.years, [2026]);
  const inserted = await f.request("/tasks", {
    teamId: f.teamId,
    year: 2026,
    startMonth: 2,
    fields: { title: "내년 행 앞에 삽입" },
    insertAt: {
      taskId: f.future.id,
      updatedAt: getTask(f.db, f.future.id).updatedAt,
      placement: "before",
    },
  });
  assert.equal(inserted.status, 201);
  assert.deepEqual(inserted.data.task.years, [2026]);
  assert(inserted.data.task.position < getTask(f.db, f.future.id).position);
  const move = {
    taskId: f.current.id,
    updatedAt: getTask(f.db, f.current.id).updatedAt,
    targetId: f.future.id,
    targetUpdatedAt: getTask(f.db, f.future.id).updatedAt,
    placement: "after",
    year: 2026,
  };
  assert.equal((await f.request("/tasks/reorder", move)).status, 400);
  assert.equal(
    (await f.request("/tasks/reorder", { ...move, startMonth: 2 })).status,
    200,
  );
  assert.deepEqual(getTask(f.db, f.current.id).years, [2026]);
  assert.deepEqual(getTask(f.db, f.future.id).years, [2027]);
});
