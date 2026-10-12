import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { openDatabase, json, now, passwordHash } from "../server/db.mjs";
import { DEFAULT_SETTINGS, todayKey } from "../shared/domain.js";

async function fixture(t) {
  const db = openDatabase(":memory:");
  const team = randomUUID(),
    admin = randomUUID(),
    lead = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    team,
    "검증팀",
    json(DEFAULT_SETTINGS),
  );
  for (const [id, role, name] of [
    [admin, "admin", "관리자"],
    [lead, "user", "팀장"],
  ]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, `${id}@example.com`, name, "unused", role, now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 86400000,
    );
  }
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(lead, team, "lead");
  const app = createApp({ db, rateLimits: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = "GET", body, token = admin } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "X-Requested-With": "WeeklyPlan",
        ...(token ? { Cookie: `weekly_session=${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? json(body) : undefined,
    });
    return {
      status: response.status,
      data: await response.json(),
      token: response.headers
        .get("set-cookie")
        ?.split(";")[0]
        .slice("weekly_session=".length),
    };
  }
  function get(path = "", user = admin) {
    return request(`/admin/audit${path}`, { token: user });
  }
  function log({
    teamId = null,
    actor = admin,
    action = "profile",
    target = lead,
    stamp = "2026-10-11T15:00:00.000Z",
    before = { name: "이전 이름" },
    after = { name: "변경 이름" },
  } = {}) {
    const id = randomUUID();
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
      id,
      teamId,
      actor,
      action,
      target,
      json(before),
      json(after),
      stamp,
    );
    return id;
  }
  return { db, team, admin, lead, get, log, request };
}

test("실제 로그인·로그아웃은 오늘의 공통 감사 로그에 한 건씩 저장하고 세션 확인은 중복 기록하지 않는다", async (t) => {
  const f = await fixture(t);
  const password = "local-test-only-password";
  const username = `${f.lead}@example.com`;
  f.db
    .prepare("UPDATE users SET password=? WHERE id=?")
    .run(passwordHash(password), f.lead);
  const login = await f.request("/auth/login", {
    method: "POST",
    token: null,
    body: { username: username.toUpperCase(), password },
  });
  assert.equal(login.status, 200);
  assert.ok(login.token);
  const query = new URLSearchParams({
    from: todayKey(),
    to: todayKey(),
    actorId: f.lead,
  });
  const entries = (await f.get(`?${query}&action=login`)).data.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorId, f.lead);
  assert.equal(entries[0].actorUsername, username);
  assert.equal(entries[0].target, f.lead);
  assert.equal(entries[0].targetName, "팀장");
  assert.equal(entries[0].targetUsername, username);
  assert.deepEqual((await f.get(`/${entries[0].id}`)).data, {
    before: null,
    after: { name: "팀장", username },
  });
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.request("/bootstrap", { token: login.token })).status,
      200,
    );
  assert.equal((await f.get(`?${query}`)).data.entries.length, 1);
  assert.equal(
    (
      await f.request("/auth/logout", {
        method: "POST",
        token: login.token,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/bootstrap", { token: login.token })).status,
    401,
  );
  const logout = (await f.get(`?${query}&action=logout`)).data.entries;
  assert.equal(logout.length, 1);
  assert.equal(logout[0].targetName, "팀장");
  assert.deepEqual((await f.get(`/${logout[0].id}`)).data, {
    before: null,
    after: { name: "팀장", username },
  });
  assert.equal(
    (
      await f.request("/auth/logout", {
        method: "POST",
        token: login.token,
      })
    ).status,
    401,
  );
  assert.equal((await f.get(`?${query}`)).data.entries.length, 2);
});

test("로그인 실패와 비밀번호 변경에 따른 세션 재발급은 로그인 성공 기록을 만들지 않는다", async (t) => {
  const f = await fixture(t);
  const password = "local-test-only-password";
  const username = `${f.admin}@example.com`;
  f.db.prepare("UPDATE users SET password=?").run(passwordHash(password));
  f.db.prepare("UPDATE users SET active=0 WHERE id=?").run(f.lead);
  for (const body of [
    { username, password: "wrong-password" },
    { username: "missing@example.com", password },
    { username: `${f.lead}@example.com`, password },
  ])
    assert.equal(
      (await f.request("/auth/login", { method: "POST", token: null, body }))
        .status,
      401,
    );
  const changed = await f.request("/auth/password", {
    method: "POST",
    body: { currentPassword: password, password: "changed-test-password" },
  });
  assert.equal(changed.status, 200);
  const logs = (await f.get("", changed.token)).data.entries;
  assert.deepEqual(
    logs.map((entry) => entry.action),
    ["password"],
  );
});

test("공통 감사 로그의 목록·상세는 시스템 관리자에게만 공개한다", async (t) => {
  const f = await fixture(t);
  const common = f.log(),
    teamLog = f.log({ teamId: f.team });
  for (const path of ["", `/${common}`]) {
    assert.equal((await f.get(path, null)).status, 401);
    assert.equal((await f.get(path, f.lead)).status, 403);
  }
  const list = await f.get();
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.entries.map((e) => e.id),
    [common],
  );
  assert.equal(list.data.entries[0].actor, "관리자");
  assert.equal(list.data.entries[0].targetName, "팀장");
  assert.deepEqual((await f.get(`/${common}`)).data, {
    before: { name: "이전 이름" },
    after: { name: "변경 이름" },
  });
  assert.equal((await f.get(`/${teamLog}`)).status, 404);
  f.db.prepare("DELETE FROM audit WHERE id=?").run(common);
  assert.equal((await f.get(`/${common}`)).status, 404);
});

test("날짜 범위는 한국 시간의 양 끝 날짜를 포함하고 수행자·작업 조건을 함께 적용한다", async (t) => {
  const f = await fixture(t);
  f.log({ stamp: "2026-10-11T14:59:59.999Z" });
  const first = f.log();
  const last = f.log({ stamp: "2026-10-12T14:59:59.999Z" });
  f.log({ stamp: "2026-10-12T15:00:00.000Z" });
  f.log({ actor: f.lead });
  f.log({ action: "password" });
  f.log({ teamId: f.team });
  const params = new URLSearchParams({
    from: "2026-10-12",
    to: "2026-10-12",
    actorId: f.admin,
    action: "profile",
  });
  const response = await f.get(`?${params}`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.data.entries.map((e) => e.id),
    [last, first],
  );
  assert.deepEqual(
    (await f.get("?from=2020-01-01&to=2020-01-01")).data.entries,
    [],
  );
});

test("같은 시각의 기록도 50건씩 중복·누락 없이 이어지고 새 기록은 다음 페이지에 끼어들지 않는다", async (t) => {
  const f = await fixture(t);
  const expected = Array.from({ length: 121 }, () => f.log())
    .sort()
    .reverse();
  let page = (await f.get()).data;
  assert.equal(page.entries.length, 50);
  const seen = page.entries.map((e) => e.id);
  f.log({ stamp: "2026-10-12T01:00:00.000Z" });
  // A boundary row can disappear during cleanup; its values still locate the next page.
  f.db.prepare("DELETE FROM audit WHERE id=?").run(page.nextCursor.id);
  while (page.nextCursor) {
    const q = new URLSearchParams({
      cursorAt: page.nextCursor.createdAt,
      cursorId: page.nextCursor.id,
    });
    page = (await f.get(`?${q}`)).data;
    assert.ok(page.entries.length <= 50);
    seen.push(...page.entries.map((e) => e.id));
  }
  assert.deepEqual(seen, expected);
});

test("목록은 큰 상세 JSON을 읽거나 전송하지 않고 상세 조회 시에만 반환한다", async (t) => {
  const f = await fixture(t);
  const large = "상세".repeat(500000);
  const id = f.log({ after: { name: large } });
  const list = await f.get();
  assert.ok(JSON.stringify(list.data).length < 1500);
  assert.ok(!("after" in list.data.entries[0]));
  assert.equal((await f.get(`/${id}`)).data.after.name.length, large.length);
  const before = f.db.prepare("SELECT * FROM audit").all();
  await f.get();
  await f.get(`/${id}`);
  assert.deepEqual(f.db.prepare("SELECT * FROM audit").all(), before);
});

test("잘못된 날짜·커서·필터를 거절하고 실제 페이지 쿼리는 정렬 인덱스를 사용한다", async (t) => {
  const f = await fixture(t);
  for (const query of [
    "from=2026-02-30",
    "from=2026-10-13&to=2026-10-12",
    "actorId=bad",
    "cursorAt=2026-10-12T00:00:00.000Z",
    `cursorId=${randomUUID()}`,
    `cursorAt=invalid&cursorId=${randomUUID()}`,
    "limit=9999",
    "action=",
  ])
    assert.equal((await f.get(`?${query}`)).status, 400, query);
  assert.equal((await f.get("/bad-id")).status, 400);
  const queries = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  f.log();
  const params = {
    cursorAt: "2026-10-12T00:00:00.000Z",
    cursorId: randomUUID(),
  };
  await f.get(`?${new URLSearchParams(params)}`);
  const sql = queries.find((s) =>
    s.includes("ORDER BY a.created_at DESC,a.id DESC"),
  );
  const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
    params.cursorAt,
    params.cursorId,
    51,
  );
  assert.ok(
    plan.some((r) => r.detail.includes("audit_system_idx")),
    json(plan),
  );
  assert.ok(!plan.some((r) => r.detail.includes("TEMP B-TREE")), json(plan));
});
