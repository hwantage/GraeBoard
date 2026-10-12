import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import { DEFAULT_SETTINGS, todayKey } from "../shared/domain.js";

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const dateAgo = (days) =>
  new Date(Date.parse(`${todayKey()}T00:00:00Z`) - days * DAY)
    .toISOString()
    .slice(0, 10);
async function fixture(t) {
  const db = openDatabase(":memory:");
  const team = randomUUID(),
    otherTeam = randomUUID();
  const admin = randomUUID(),
    otherAdmin = randomUUID(),
    lead = randomUUID();
  for (const id of [team, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      id,
      json(DEFAULT_SETTINGS),
    );
  for (const [id, role] of [
    [admin, "admin"],
    [otherAdmin, "admin"],
    [lead, "user"],
  ]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, id, "정리 검증", "unused", role, now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 1000 * DAY,
    );
  }
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(lead, team, "lead");
  const task = insertTask(db, {
    teamId: team,
    year: 2026,
    actorId: admin,
    fields: { title: "현재 업무", owner: lead },
  });
  const otherTask = insertTask(db, {
    teamId: otherTeam,
    year: 2026,
    actorId: admin,
    fields: { title: "다른 팀 업무" },
  });
  // Unrelated stored data must remain byte-for-byte intact.
  db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
    randomUUID(),
    team,
    2026,
    "보관 보고서",
    "2026-01-01",
    admin,
    ago(800),
    Buffer.from("snapshot bytes"),
  );
  db.prepare("INSERT INTO imports VALUES(?,?,?,?,?,?,NULL,NULL)").run(
    randomUUID(),
    team,
    admin,
    "old.xlsx",
    "{}",
    ago(800),
  );
  let app, server, base;
  async function start() {
    app = createApp({ db, rateLimits: false });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function stop() {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await start();
  t.after(async () => {
    await stop();
    db.close();
  });
  async function request(path, body, user = admin) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: `weekly_session=${user}`,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : json(body),
    });
    return { status: response.status, data: await response.json() };
  }
  function history({
    stamp = ago(400),
    target = randomUUID(),
    teamId = team,
    value = "한글 이력",
    action = "cells",
  } = {}) {
    const id = randomUUID();
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
      id,
      teamId,
      admin,
      action,
      target,
      json(value),
      json(value),
      stamp,
    );
    return id;
  }
  function operation(
    stamp = ago(400),
    response = {
      kind: "cell-audit",
      refs: [{ teamId: team, id: randomUUID() }],
    },
  ) {
    const id = randomUUID();
    db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
      id,
      admin,
      json(response),
      stamp,
    );
    return id;
  }
  return {
    db,
    admin,
    otherAdmin,
    lead,
    team,
    task,
    otherTask,
    otherTeam,
    request,
    history,
    operation,
    storage: (user = admin) =>
      request("/admin/history-cleanup/storage", undefined, user),
    preview: (beforeDate = dateAgo(365), user = admin, scopeId = team) =>
      request(
        `/admin/history-cleanup?${new URLSearchParams({ scopeId, beforeDate })}`,
        undefined,
        user,
      ),
    clean: (token, user = admin) =>
      request("/admin/history-cleanup", { token, confirmed: true }, user),
    restart: async () => {
      await stop();
      await start();
    },
  };
}

test("정리는 시스템 관리자만 미리보기·확인 후 실행하고, 토큰을 다른 계정·변경된 조건·재시작에서 재사용하지 못한다", async (t) => {
  const f = await fixture(t);
  f.history();
  assert.equal((await f.preview(dateAgo(365), f.lead)).status, 403);
  assert.equal((await f.clean(randomUUID(), f.lead)).status, 403);
  assert.equal((await f.storage(f.lead)).status, 403);
  assert.equal((await f.request("/admin/history-cleanup")).status, 400);
  assert.equal(
    (await f.preview(dateAgo(365), f.admin, randomUUID())).status,
    404,
  );
  for (const value of ["1999-12-31", "2026-02-30", "abc", dateAgo(-1)])
    assert.equal((await f.preview(value)).status, 400);
  const before = f.db.prepare("SELECT * FROM audit").all();
  const p = (await f.preview()).data;
  assert.deepEqual(f.db.prepare("SELECT * FROM audit").all(), before);
  assert.equal(
    (
      await f.request("/admin/history-cleanup", {
        token: p.token,
        confirmed: false,
      })
    ).status,
    400,
  );
  assert.equal((await f.clean(p.token, f.otherAdmin)).status, 410);
  await f.preview(dateAgo(30), f.admin, f.otherTeam);
  assert.equal((await f.clean(p.token)).status, 410);
  const valid = (await f.preview()).data;
  await f.restart();
  assert.equal((await f.clean(valid.token)).status, 410);
  assert.deepEqual(f.db.prepare("SELECT * FROM audit").all(), before);
});

test("한국 시간 날짜 경계·UTF-8 용량대로 선택한 팀만 정리하고 다른 팀과 공유 기록은 보존한다", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-12T03:00:00Z"),
  });
  const f = await fixture(t);
  const expiredOp = f.operation();
  const liveOp = f.operation(ago(1));
  const skewOp = f.operation(
    new Date(Date.now() - 7 * DAY - 4 * 60000).toISOString(),
  );
  const otherOp = f.operation(ago(400), {
    kind: "cell-audit",
    refs: [{ teamId: f.otherTeam, id: randomUUID() }],
  });
  const sharedOp = f.operation(ago(400), {
    kind: "cell-audit",
    refs: [
      { teamId: f.team, id: randomUUID() },
      { teamId: f.otherTeam, id: randomUUID() },
    ],
  });
  const importOp = f.operation(ago(800), { imported: 8, teamId: f.team });
  const boundary = "2025-10-11T15:00:00.000Z";
  const oldIds = [
    f.history({ target: expiredOp }),
    f.history({ stamp: "2025-10-11T14:59:59.999Z" }),
    f.history({ target: sharedOp }),
  ];
  const keepIds = [
    f.history({ stamp: boundary }),
    f.history({ stamp: "2025-10-11T15:00:00.001Z" }),
    f.history({ target: liveOp }),
    f.history({ target: skewOp }),
    f.history({ teamId: f.otherTeam, target: otherOp }),
    f.history({ teamId: f.otherTeam, target: sharedOp }),
    f.history({ teamId: null, action: "profile" }),
  ];
  const protectedTables = [
    "users",
    "teams",
    "memberships",
    "tasks",
    "cells",
    "reports",
    "imports",
    "team_revisions",
  ];
  const before = protectedTables.map((table) =>
    f.db.prepare(`SELECT * FROM ${table}`).all(),
  );
  const keepRows = keepIds.map((id) =>
    f.db.prepare("SELECT * FROM audit WHERE id=?").get(id),
  );
  const p = (await f.preview("2025-10-12")).data;
  assert.equal(p.cutoff, boundary);
  assert.equal(p.audit.stored.count, 7);
  assert.equal(p.audit.before.count, 5);
  assert.equal(p.audit.eligible.count, 3);
  assert.equal(
    p.audit.eligible.bytes,
    Buffer.byteLength(json("한글 이력")) * 6,
  );
  assert.equal(p.operations.stored.count, 3);
  assert.equal(p.operations.eligible.count, 1);
  assert.equal(JSON.stringify(p).includes("한글 이력"), false);
  const r = await f.clean(p.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.hasMore, false);
  for (const key of ["audit", "operations"])
    assert.deepEqual(r.data.deleted[key], {
      count: p[key].eligible.count,
      bytes: p[key].eligible.bytes,
    });
  for (const id of oldIds)
    assert.equal(
      f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(id),
      undefined,
    );
  assert.deepEqual(
    keepIds.map((id) => f.db.prepare("SELECT * FROM audit WHERE id=?").get(id)),
    keepRows,
  );
  assert.equal(
    f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(expiredOp),
    undefined,
  );
  for (const id of [liveOp, skewOp, importOp, sharedOp, otherOp])
    assert.ok(f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(id));
  assert.deepEqual(
    protectedTables.map((table) =>
      f.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
    before,
  );
  const latest = (await f.storage()).data.scopes.find(
    (scope) => scope.id === f.team,
  ).latest;
  assert.equal(latest.completed, true);
  assert.equal(latest.deleted.audit.count, 3);
  assert.equal(latest.scope.id, f.team);
  assert.equal((await f.clean(p.token)).status, 410);
});

test("정리는 500건씩 나뉘며 확인 이후 새 이력을 지우지 않고 중단·재개 결과를 기록한다", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 510; i++) {
    f.history();
    f.operation();
  }
  const p = (await f.preview()).data;
  const fresh = f.history({ stamp: now() });
  const first = (await f.clean(p.token)).data;
  assert.equal(first.hasMore, true);
  assert.equal(first.deleted.operations.count, 500);
  assert.equal(first.deleted.audit.count, 0);
  const p2 = (await f.preview()).data;
  const latest = (await f.storage()).data.scopes.find(
    (scope) => scope.id === f.team,
  ).latest;
  assert.equal(latest.completed, false);
  assert.equal(latest.deleted.operations.count, 500);
  assert.equal(p2.operations.eligible.count, 10);
  let result;
  do {
    result = (await f.clean(p2.token)).data;
    assert.ok(result.batch.operations.count + result.batch.audit.count <= 500);
  } while (result.hasMore);
  assert.equal(result.deleted.audit.count, 510);
  assert.equal(result.deleted.operations.count, 10);
  assert.ok(f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(fresh));
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM audit WHERE action='history-cleanup'")
      .get().n,
    2,
  );
});

test("JSON 10MiB 기준으로 분할하고 더 큰 단일 이력은 단독 처리한다", async (t) => {
  const f = await fixture(t);
  for (const size of [3, 3, 6])
    f.history({ value: "x".repeat(size * 1024 * 1024) });
  const p = (await f.preview()).data;
  let calls = 0,
    result;
  do {
    result = (await f.clean(p.token)).data;
    assert.equal(result.batch.audit.count, 1);
    calls++;
  } while (result.hasMore);
  assert.equal(calls, 3);
  assert.equal(result.deleted.audit.count, 3);
  assert.equal(result.deleted.audit.bytes, p.audit.eligible.bytes);
});

test("삭제 실패는 해당 묶음과 결과 로그를 함께 롤백하며 같은 미리보기로 재시도할 수 있다", async (t) => {
  const f = await fixture(t);
  f.operation();
  f.history();
  const before = f.db.prepare("SELECT * FROM audit").all();
  const ops = f.db.prepare("SELECT * FROM operations").all();
  const p = (await f.preview()).data;
  f.db.exec(
    "CREATE TEMP TRIGGER fail_cleanup BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'cleanup rollback test'); END",
  );
  assert.equal((await f.clean(p.token)).status, 500);
  assert.deepEqual(f.db.prepare("SELECT * FROM audit").all(), before);
  assert.deepEqual(f.db.prepare("SELECT * FROM operations").all(), ops);
  f.db.exec("DROP TRIGGER fail_cleanup");
  const result = await f.clean(p.token);
  assert.equal(result.status, 200);
  assert.equal(result.data.deleted.audit.count, 1);
});

test("재시도는 원래 시각으로 7일 내 응답을 재생하고 만료·정리·재시작 뒤에도 작업을 다시 적용하지 않는다", async (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await fixture(t);
  const payload = {
    operationId: randomUUID(),
    createdAt: now(),
    changes: [
      { taskId: f.task.id, key: "title", value: "수정", expectedVersion: 1 },
    ],
  };
  const saved = await f.request("/cells/batch", payload);
  assert.equal(saved.status, 200);
  t.mock.timers.setTime(start + 6 * DAY);
  assert.deepEqual(await f.request("/cells/batch", payload), saved);
  t.mock.timers.setTime(start + 7 * DAY);
  assert.equal((await f.request("/cells/batch", payload)).status, 410);
  t.mock.timers.setTime(start + 8 * DAY);
  const p = (await f.preview(todayKey())).data;
  assert.equal(p.operations.eligible.count, 1);
  await f.clean(p.token);
  await f.restart();
  // Even a payload whose version would now succeed must not be re-applied.
  payload.changes[0].expectedVersion = 2;
  const before = getTask(f.db, f.task.id);
  assert.equal((await f.request("/cells/batch", payload)).status, 410);
  const missingTime = { ...payload };
  delete missingTime.createdAt;
  assert.equal((await f.request("/cells/batch", missingTime)).status, 400);
  assert.equal(
    (
      await f.request("/cells/batch", {
        ...payload,
        createdAt: new Date(Date.now() + 6 * 60000).toISOString(),
      })
    ).status,
    400,
  );
  assert.deepEqual(getTask(f.db, f.task.id), before);
  const current = { ...payload, operationId: randomUUID(), createdAt: now() };
  assert.equal((await f.request("/cells/batch", current)).status, 200);
});

test("만료된 미리보기는 삭제하지 않고 다시 확인하게 한다", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t);
  const id = f.history();
  const p = (await f.preview()).data;
  t.mock.timers.setTime(Date.now() + 16 * 60000);
  assert.equal((await f.clean(p.token)).status, 410);
  assert.ok(f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(id));
});

test("여러 팀을 수정한 유효한 셀 요청은 정리 후에도 전후 값과 순서가 같은 응답을 재생한다", async (t) => {
  const f = await fixture(t);
  const payload = {
    operationId: randomUUID(),
    createdAt: now(),
    changes: [f.otherTask, f.task].map((task) => ({
      taskId: task.id,
      key: "title",
      value: "저장한 값",
      expectedVersion: 1,
    })),
  };
  const saved = await f.request("/cells/batch", payload);
  assert.equal(saved.status, 200);
  // Exercise protection independently of the normal timestamp ordering.
  f.db
    .prepare("UPDATE audit SET created_at=? WHERE target=?")
    .run(ago(400), payload.operationId);
  f.history();
  f.operation();
  const p = (await f.preview()).data;
  assert.equal(p.audit.eligible.count, 1);
  assert.equal((await f.clean(p.token)).status, 200);
  await f.restart();
  assert.deepEqual(await f.request("/cells/batch", payload), saved);
});

test("팀별 저장 용량은 실제 본문·서식·압축 스냅샷 바이트를 합산하고 공유 기록을 중복 계산하지 않는다", async (t) => {
  const f = await fixture(t);
  f.history();
  f.history({ teamId: f.otherTeam, value: "다른 팀" });
  f.history({ teamId: null, value: "공통" });
  const own = f.operation();
  const shared = f.operation(ago(400), {
    kind: "cell-audit",
    refs: [
      { teamId: f.team, id: randomUUID() },
      { teamId: f.otherTeam, id: randomUUID() },
    ],
  });
  const foreign = f.operation(ago(400), {
    kind: "cell-audit",
    refs: [{ teamId: f.otherTeam, id: randomUUID() }],
  });
  const { scopes } = (await f.storage()).data;
  const team = scopes.find((scope) => scope.id === f.team);
  const other = scopes.find((scope) => scope.id === f.otherTeam);
  const common = scopes.find((scope) => scope.id === "system");
  const byteLength = (value) => Buffer.byteLength(json(value));
  assert.equal(
    team.currentBytes,
    byteLength(DEFAULT_SETTINGS) +
      byteLength(f.task.years) +
      byteLength(f.task.defaultStyle) +
      Object.values(f.task.cells).reduce(
        (sum, cell) => sum + byteLength(cell.value) + byteLength(cell.style),
        0,
      ),
  );
  assert.equal(team.reportBytes, Buffer.byteLength("snapshot bytes"));
  assert.equal(team.importBytes, Buffer.byteLength("{}"));
  assert.equal(team.audit.bytes, byteLength("한글 이력") * 2);
  assert.equal(other.audit.bytes, byteLength("다른 팀") * 2);
  assert.equal(common.audit.bytes, byteLength("공통") * 2);
  for (const [scope, op] of [
    [team, own],
    [other, foreign],
    [common, shared],
  ]) {
    assert.equal(scope.operations.count, 1);
    assert.equal(
      scope.operations.bytes,
      Buffer.byteLength(
        f.db.prepare("SELECT response FROM operations WHERE id=?").get(op)
          .response,
      ),
    );
    assert.equal(
      scope.totalBytes,
      scope.currentBytes +
        scope.reportBytes +
        scope.importBytes +
        scope.audit.bytes +
        scope.operations.bytes,
    );
  }
  assert.equal(
    scopes.reduce((sum, scope) => sum + scope.operations.count, 0),
    3,
  );
});

test("선택 날짜보다 새로운 만료 재시도 기록은 남기고 최근 날짜를 선택해도 유효한 기록은 보호한다", async (t) => {
  const f = await fixture(t);
  const old = f.operation(ago(400));
  const expiredButNewer = f.operation(ago(8));
  const live = f.operation(ago(1));
  f.history({ stamp: ago(1), target: live });
  const p = (await f.preview()).data;
  assert.equal(p.operations.before.count, 1);
  assert.equal(p.operations.eligible.count, 1);
  await f.clean(p.token);
  assert.equal(
    f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(old),
    undefined,
  );
  assert.ok(
    f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(expiredButNewer),
  );
  const recent = (await f.preview(todayKey())).data;
  assert.equal(recent.operations.before.count, 2);
  assert.equal(recent.operations.eligible.count, 1);
  assert.equal(recent.audit.before.count, 1);
  assert.equal(recent.audit.eligible.count, 0);
  await f.clean(recent.token);
  assert.ok(f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(live));
});

test("시스템 공통 정리는 공통·공유 기록만 삭제하며 팀 이력과 단일 팀 재시도는 그대로 둔다", async (t) => {
  const f = await fixture(t);
  const teamHistory = f.history();
  const commonHistory = f.history({ teamId: null, action: "profile" });
  const own = f.operation();
  const shared = f.operation(ago(400), {
    kind: "cell-audit",
    refs: [
      { teamId: f.team, id: randomUUID() },
      { teamId: f.otherTeam, id: randomUUID() },
    ],
  });
  const p = (await f.preview(dateAgo(365), f.admin, "system")).data;
  assert.equal(p.audit.eligible.count, 1);
  assert.equal(p.operations.eligible.count, 1);
  const result = await f.clean(p.token);
  assert.equal(result.status, 200);
  assert.ok(f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(teamHistory));
  assert.ok(f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(own));
  assert.equal(
    f.db.prepare("SELECT 1 FROM audit WHERE id=?").get(commonHistory),
    undefined,
  );
  assert.equal(
    f.db.prepare("SELECT 1 FROM operations WHERE id=?").get(shared),
    undefined,
  );
});

test("팀별 날짜 후보 검색은 팀·날짜 인덱스를 사용한다", async (t) => {
  const f = await fixture(t);
  const queries = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  f.history();
  f.operation();
  const preview = (await f.preview()).data;
  await f.clean(preview.token);
  for (const table of ["audit", "operations"]) {
    const query = queries.find(
      (sql) =>
        sql.startsWith("SELECT id,") && sql.includes(`FROM ${table} WHERE`),
    );
    const params =
      table === "audit"
        ? [f.team, preview.cutoff, preview.operationCutoff, 500]
        : [f.team, preview.operationCutoff, 500];
    const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params);
    assert.ok(
      plan.some((row) => row.detail.includes(`SEARCH ${table} USING INDEX`)),
      json(plan),
    );
  }
});
