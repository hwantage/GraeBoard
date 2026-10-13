import { unpack } from "../shared/compact.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import { DEFAULT_SETTINGS, weeksForYear } from "../shared/domain.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-cell-operations-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path),
    app,
    server,
    base;
  const queries = [];
  const team = randomUUID(),
    otherTeam = randomUUID();
  const admin = randomUUID(),
    lead = randomUUID();
  for (const id of [team, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      id,
      json(DEFAULT_SETTINGS),
    );
  for (const [id, role] of [
    [admin, "admin"],
    [lead, "user"],
  ]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, id, "저장 검증", "unused", role, now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 600000,
    );
  }
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(lead, team, "lead");
  const task = insertTask(db, {
    teamId: team,
    year: 2026,
    actorId: admin,
    fields: { title: "원래 제목", owner: lead },
  });
  const otherTask = insertTask(db, {
    teamId: otherTeam,
    year: 2026,
    actorId: admin,
    fields: { title: "다른 팀 원래 제목" },
  });
  async function start() {
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    app = createApp({ db, rateLimits: false });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function stop() {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
  await start();
  t.after(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, { method = "GET", body, user = admin } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: `weekly_session=${user}`,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : json(body),
    });
    return { status: res.status, body: await res.json().then(unpack) };
  }
  return {
    get db() {
      return db;
    },
    queries,
    team,
    otherTeam,
    admin,
    lead,
    task,
    otherTask,
    request,
    async restart() {
      await stop();
      db = openDatabase(path);
      await start();
    },
    save(changes, operationId = randomUUID(), user = admin) {
      return request("/cells/batch", {
        method: "POST",
        user,
        body: { operationId, createdAt: new Date().toISOString(), changes },
      });
    },
  };
}

test("셀 저장은 전후 데이터를 한 번만 보관하고 재시작·후속 수정 후에도 같은 응답을 재생한다", async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  const changes = weeksForYear(2026)
    .slice(0, 32)
    .map((week) => ({
      taskId: f.task.id,
      key: week.key,
      value: "업무 내용과 서식 저장 ".repeat(200),
      style: { backgroundColor: "#ffeeaa", fontSize: 14 },
      expectedVersion: 0,
    }));
  f.queries.length = 0;
  const saved = await f.save(changes, operationId);
  assert.equal(saved.status, 200);
  assert.equal(
    f.queries.filter((sql) => /SELECT .*FROM audit\b/i.test(sql)).length,
    0,
    "정상 저장에서 과거 이력을 조회하지 않는다",
  );
  const stored = f.db
    .prepare("SELECT response FROM operations WHERE id=?")
    .get(operationId).response;
  assert.ok(
    Buffer.byteLength(stored) < Buffer.byteLength(json(saved.body)) / 100,
    "재시도 메타데이터에 셀 내용과 서식을 중복 저장하지 않는다",
  );
  assert.equal(stored.includes(changes[0].value), false);
  const history = (await f.request(`/audit?teamId=${f.team}`)).body.entries;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].before, saved.body.before);
  assert.deepEqual(history[0].after, saved.body.cells);
  await f.save([{ ...changes[0], value: "나중 수정", expectedVersion: 1 }]);
  await f.restart();
  f.queries.length = 0;
  assert.deepEqual(await f.save(changes, operationId), saved);
  const read = f.queries.find((sql) => /SELECT .*FROM audit\b/i.test(sql));
  assert.match(read, /WHERE id=\?/);
  const plan = f.db
    .prepare(`EXPLAIN QUERY PLAN ${read}`)
    .all(history[0].id, operationId, f.admin);
  assert.ok(
    plan.some((row) => /SEARCH audit USING INDEX.*\(id=\?\)/.test(row.detail)),
    "재시도는 이력 기본키 인덱스를 사용한다",
  );
  assert.equal(
    getTask(f.db, f.task.id).cells[changes[0].key].value,
    "나중 수정",
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM audit WHERE target=?")
      .get(operationId).n,
    1,
  );
  assert.equal((await f.save(changes, operationId, f.lead)).status, 403);
});

test("여러 팀의 섞인 셀 순서·이력 복원을 보존하고 팀 삭제 때 참조도 제거한다", async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  const changes = [
    {
      taskId: f.task.id,
      key: "2026-10-05",
      value: "팀 A 첫 번째",
      expectedVersion: 0,
    },
    {
      taskId: f.otherTask.id,
      key: "2026-10-05",
      value: "팀 B 첫 번째",
      expectedVersion: 0,
    },
    {
      taskId: f.task.id,
      key: "title",
      value: "팀 A 두 번째",
      expectedVersion: 1,
    },
    {
      taskId: f.otherTask.id,
      key: "title",
      value: "팀 B 두 번째",
      expectedVersion: 1,
    },
  ];
  const saved = await f.save(changes, operationId);
  assert.equal(saved.status, 200);
  assert.deepEqual(await f.save(changes, operationId), saved);
  const histories = [];
  for (const [teamId, taskId] of [
    [f.team, f.task.id],
    [f.otherTeam, f.otherTask.id],
  ]) {
    const entries = (await f.request(`/audit?teamId=${teamId}`)).body.entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(
      entries[0].after,
      saved.body.cells.filter((cell) => cell.taskId === taskId),
    );
    assert.deepEqual(
      entries[0].before,
      saved.body.before.filter((cell) => cell.taskId === taskId),
    );
    histories.push(entries[0]);
  }
  const restored = await f.request(`/audit/${histories[0].id}/restore`, {
    method: "POST",
    body: {
      versions: Object.fromEntries(
        histories[0].after.map((cell) => [
          `${cell.taskId}:${cell.key}`,
          cell.version,
        ]),
      ),
    },
  });
  assert.equal(restored.status, 200);
  assert.equal(getTask(f.db, f.task.id).cells.title.value, "원래 제목");
  assert.deepEqual(
    await f.save(changes, operationId),
    saved,
    "복원 이후에도 최초 응답을 재생한다",
  );
  const keepId = randomUUID();
  const keep = await f.save(
    [
      {
        taskId: f.otherTask.id,
        key: "title",
        value: "보존",
        expectedVersion: 2,
      },
    ],
    keepId,
  );
  f.db.prepare("DELETE FROM audit WHERE id=?").run(histories[0].id);
  assert.equal(
    (
      await f.request(`/admin/teams/${f.team}`, {
        method: "DELETE",
        body: { confirmed: true },
      })
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT id FROM operations WHERE id=?").get(operationId),
    undefined,
  );
  assert.ok(
    f.db.prepare("SELECT id FROM audit WHERE id=?").get(histories[1].id),
  );
  assert.deepEqual(
    await f.save(
      [
        {
          taskId: f.otherTask.id,
          key: "title",
          value: "보존",
          expectedVersion: 2,
        },
      ],
      keepId,
    ),
    keep,
  );
});

test("재시도 참조 이력이 없으면 410으로 거절하고 현재 버전의 입력도 다시 적용하지 않는다", async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  assert.equal(
    (
      await f.save(
        [
          {
            taskId: f.task.id,
            key: "title",
            value: "저장됨",
            expectedVersion: 1,
          },
        ],
        operationId,
      )
    ).status,
    200,
  );
  const before = getTask(f.db, f.task.id);
  f.db.prepare("DELETE FROM audit WHERE target=?").run(operationId);
  const retry = await f.save(
    [
      {
        taskId: f.task.id,
        key: "title",
        value: "재적용 금지",
        expectedVersion: 2,
      },
    ],
    operationId,
  );
  assert.equal(retry.status, 410);
  assert.deepEqual(getTask(f.db, f.task.id), before);
});

test("재시도 참조 저장이 실패하면 셀과 이력을 함께 롤백한다", async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  const before = getTask(f.db, f.task.id);
  f.db.exec(
    "CREATE TEMP TRIGGER reject_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'test operation rollback'); END",
  );
  const failed = await f.save(
    [
      {
        taskId: f.task.id,
        key: "title",
        value: "반영 금지",
        expectedVersion: 1,
      },
    ],
    operationId,
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(getTask(f.db, f.task.id), before);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM audit WHERE target=?")
      .get(operationId).n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT id FROM operations WHERE id=?").get(operationId),
    undefined,
  );
});

test("이력 참조 재시도도 삭제 업무를 읽되 현재 팀 접근 권한을 검사한다", async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  const changes = [
    {
      taskId: f.task.id,
      key: "title",
      value: "팀장 저장",
      expectedVersion: 1,
    },
  ];
  const saved = await f.save(changes, operationId, f.lead);
  assert.equal(saved.status, 200);
  const task = getTask(f.db, f.task.id);
  assert.equal(
    (
      await f.request(`/tasks/${task.id}`, {
        method: "DELETE",
        body: { updatedAt: task.updatedAt },
      })
    ).status,
    200,
  );
  assert.deepEqual(await f.save(changes, operationId, f.lead), saved);
  f.db
    .prepare("DELETE FROM memberships WHERE user_id=? AND team_id=?")
    .run(f.lead, f.team);
  assert.equal((await f.save(changes, operationId, f.lead)).status, 403);
});
