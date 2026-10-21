import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import { DEFAULT_SETTINGS, weeksForYear, cell } from "../shared/domain.js";
import { pack, unpack, stringify, parseCompact } from "../shared/compact.js";

async function fixture(t) {
  const db = openDatabase(":memory:"),
    teamId = randomUUID(),
    userId = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "서식 저장 검증",
    json({
      ...DEFAULT_SETTINGS,
      properties: [
        ...DEFAULT_SETTINGS.properties,
        {
          id: "score",
          name: "점수",
          kind: "number",
          visible: true,
          values: [],
        },
      ],
    }),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
  ).run(userId, userId, "검증 계정", "unused", "admin", now());
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(userId).digest("hex"),
    userId,
    Date.now() + 600000,
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
  async function request(path, body, encoded = false) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: `weekly_session=${userId}`,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        body:
          body === undefined
            ? undefined
            : encoded
              ? JSON.stringify(body)
              : stringify(body),
      },
    );
    const raw = await response.json();
    return { status: response.status, raw, data: unpack(raw) };
  }
  const task = (cells = {}, defaultStyle = {}) =>
    insertTask(db, {
      teamId,
      year: 2026,
      actorId: userId,
      fields: { title: "검증 업무" },
      cells,
      defaultStyle,
    });
  const save = (changes, operationId = randomUUID()) =>
    request("/cells/batch", { operationId, createdAt: now(), changes });
  return { db, app, teamId, request, task, save };
}

test("축약 서식 사전은 순서가 다른 동일 서식을 공유하고 null·none·false를 보존한다", () => {
  const style = {
    borderTop: null,
    borderRight: { style: "none", color: "#123456" },
    borderBottom: { style: "double", color: "#654321" },
    borderLeft: null,
    fontFamily: "Noto Sans KR",
    fontSize: 9,
    textAlign: "center",
    verticalAlign: "top",
    bold: false,
    italic: true,
    underline: false,
    strike: true,
    textMode: "clip",
    color: "#123456",
    backgroundColor: "#abcdef",
  };
  const input = {
    cells: Array.from({ length: 2000 }, (_, i) => ({
      key: String(i),
      value: i % 2 ? "" : 0,
      version: i,
      style:
        i % 2
          ? { ...style }
          : Object.fromEntries(Object.entries(style).reverse()),
    })),
  };
  const wire = pack(input);
  assert.equal(wire.$styles.length, 1);
  assert.deepEqual(wire.$styles[0].bb, ["double", "#654321"]);
  assert.deepEqual(wire.$styles[0].br, ["none", "#123456"]);
  assert.equal(wire.$styles[0].bt, null);
  assert.equal(wire.$styles[0].b, false);
  assert.equal(JSON.stringify(wire).includes("borderTop"), false);
  assert(
    Buffer.byteLength(JSON.stringify(wire)) <
      Buffer.byteLength(JSON.stringify(input)) / 3,
  );
  const originalWire = JSON.stringify(wire);
  const decoded = unpack(wire);
  assert.deepEqual(decoded, input);
  assert.equal(
    JSON.stringify(wire),
    originalWire,
    "압축 원문을 변경하지 않는다",
  );
  assert.equal(decoded.cells[0].style, decoded.cells[1].style);
  assert.deepEqual(unpack(wire), input, "같은 압축 원문을 다시 해석할 수 있다");
  const namedProperties = {
    view: { widths: { style: 150, defaultStyle: 90 } },
    fields: { style: 0 },
    task: {
      defaultStyle: style,
      cells: {
        style: { value: "사용자 속성", style: { bold: true }, version: 2 },
      },
    },
  };
  assert.deepEqual(
    unpack(pack(namedProperties)),
    namedProperties,
    "style이라는 사용자 속성·열 너비를 서식 참조로 오인하지 않는다",
  );
});

test("행 생성은 비어 있는 주차와 불필요한 null을 저장하지 않고 0·명시적 서식을 유지한다", async (t) => {
  const f = await fixture(t);
  const weeks = weeksForYear(2026).map((w) => w.key);
  const cells = Object.fromEntries(
    weeks.map((key) => [
      key,
      {
        value: "",
        style: {
          borderTop: null,
          borderRight: null,
          borderBottom: null,
          borderLeft: null,
        },
      },
    ]),
  );
  cells[weeks[0]].value = "착수";
  cells.score = { value: 0, style: {} };
  cells[weeks[1]].style.backgroundColor = "#abcdef";
  cells[weeks[2]].style.borderBottom = { style: "none", color: "#123456" };
  const created = await f.request("/tasks", {
    teamId: f.teamId,
    year: 2026,
    copiedRow: { cells, defaultStyle: {} },
  });
  assert.equal(created.status, 201);
  const stored = getTask(f.db, created.data.task.id);
  assert.equal(
    Object.keys(stored.cells).filter((key) => /^\d/.test(key)).length,
    3,
  );
  assert.equal(stored.cells[weeks[0]].value, "착수");
  assert.equal(stored.cells.score.value, 0);
  assert.deepEqual(stored.cells[weeks[0]].style, {});
  assert.deepEqual(stored.cells[weeks[1]].style, {
    backgroundColor: "#abcdef",
  });
  assert.deepEqual(stored.cells[weeks[2]].style, {
    borderBottom: { style: "none", color: "#123456" },
  });
  assert.equal(stored.cells[weeks[3]], undefined);
  const inherited = f.task(
    {
      title: {
        value: "상속 해제",
        style: { bold: false, borderTop: null, fontSize: 12 },
      },
      [weeks[0]]: {
        value: "",
        style: { borderTop: { style: "solid", color: "#123456" } },
      },
    },
    {
      bold: true,
      fontSize: 12,
      borderTop: { style: "solid", color: "#123456" },
    },
  );
  assert.deepEqual(inherited.cells.title.style, {
    bold: false,
    borderTop: null,
  });
  assert.equal(cell(inherited, "title").style.fontSize, 12);
  assert.deepEqual(
    inherited.cells[weeks[0]].style.borderTop,
    { style: "solid", color: "#123456" },
    "같아 보이는 명시적 선도 주차 경계선보다 우선하므로 보존한다",
  );
});

test("3천 셀 서식은 DB·요청·응답·이력에 한 번만 저장하고 복원·재시도한다", async (t) => {
  const f = await fixture(t);
  const tasks = Array.from({ length: 60 }, () => f.task());
  const keys = weeksForYear(2026).map((w) => w.key);
  const style = {
    backgroundColor: "#d1eee6",
    borderRight: { style: "double", color: "#856060" },
  };
  const changes = tasks.flatMap((task) =>
    keys.map((key) => ({
      taskId: task.id,
      key,
      style: { ...style },
      expectedVersion: 0,
    })),
  );
  const operationId = randomUUID();
  const body = { operationId, createdAt: now(), changes };
  const encoded = pack(body);
  assert.equal(encoded.$styles.length, 1);
  const saved = await f.request("/cells/batch", encoded, true);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.cells.length, 3180);
  assert.equal(
    saved.raw.$styles.length,
    1,
    "빈 서식은 그대로 두고 변경 후 공통 서식만 사전으로 전달한다",
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM styles").get().n, 2);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(DISTINCT style_id) n FROM cells WHERE key<>'title'",
      )
      .get().n,
    1,
  );
  const rawStyle = f.db
    .prepare("SELECT data FROM styles WHERE id<>0")
    .get().data;
  assert.deepEqual(JSON.parse(rawStyle), {
    bg: "#d1eee6",
    br: ["double", "#856060"],
  });
  const history = f.db
    .prepare("SELECT * FROM audit WHERE target=?")
    .get(operationId);
  const snapshot = JSON.parse(history.after_json);
  assert.equal(snapshot.$styles.length, 1);
  assert.deepEqual(parseCompact(history.after_json), saved.data.cells);
  const list = await f.request(`/tasks?teamId=${f.teamId}&year=2026`);
  assert.equal(list.raw.$styles.length, 1);
  assert.deepEqual(list.data.tasks[0].cells[keys[0]].style, style);
  const audit = await f.request(
    `/audit?teamId=${f.teamId}&taskId=${tasks[0].id}`,
  );
  assert.equal(
    audit.data.entries.length,
    1,
    "사전으로 저장한 이력도 업무별로 검색한다",
  );
  assert.deepEqual((await f.request("/cells/batch", body)).data, saved.data);
  const undone = await f.request(`/audit/${history.id}/restore`, {
    versions: Object.fromEntries(
      changes.map((c) => [`${c.taskId}:${c.key}`, 1]),
    ),
  });
  assert.equal(undone.status, 200);
  assert.equal(getTask(f.db, tasks[0].id).cells[keys[0]].version, 2);
  assert.deepEqual(getTask(f.db, tasks[0].id).cells[keys[0]].style, {});
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM styles").get().n,
    1,
    "더 이상 참조하지 않는 서식은 제거한다",
  );
  assert.deepEqual(
    (await f.request("/cells/batch", body)).data,
    saved.data,
    "사전 정리 후에도 이력 자체로 최초 응답을 재생한다",
  );
  assert.equal(
    (await f.save([{ ...changes[0], expectedVersion: 0 }])).status,
    409,
    "빈 셀을 다시 만들 때 과거 버전을 허용하지 않는다",
  );
});

test("동일한 값·서식 저장은 셀·버전·업무시각·감사 기록을 늘리지 않는다", async (t) => {
  const f = await fixture(t),
    task = f.task();
  const baseline = f.db
    .prepare("SELECT version FROM team_revisions WHERE team_id=?")
    .get(f.teamId).version;
  const changes = [
    { taskId: task.id, key: "title", value: "검증 업무", expectedVersion: 1 },
    {
      taskId: task.id,
      key: "2026-01-05",
      style: { borderTop: null },
      expectedVersion: 0,
    },
  ];
  const id = randomUUID(),
    saved = await f.save(changes, id);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.cells, []);
  assert.deepEqual(saved.data.before, []);
  assert.deepEqual(getTask(f.db, task.id), task);
  assert.equal(
    f.db
      .prepare("SELECT version FROM team_revisions WHERE team_id=?")
      .get(f.teamId).version,
    baseline,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit").get().n, 0);
  assert.deepEqual((await f.save(changes, id)).data, saved.data);
  const events = [];
  const publish = f.app.locals.cellEvents.publish;
  f.app.locals.cellEvents.publish = (result, tasks) => {
    events.push(result);
    publish(result, tasks);
  };
  const mixed = await f.save([
    changes[1],
    { ...changes[0], value: "실제 변경" },
    {
      taskId: task.id,
      key: "2026-01-12",
      style: { bold: true },
      expectedVersion: 0,
    },
  ]);
  assert.equal(mixed.data.cells.length, 2);
  assert.deepEqual(
    events.at(-1).cells.map((c) => c.key),
    ["title", "2026-01-12"],
    "no-op을 제외하고 값과 개별 서식 변경을 SSE로 전달한다",
  );
  const unchanged = getTask(f.db, task.id);
  const conflict = await f.save([
    {
      taskId: task.id,
      key: "2026-01-19",
      style: { bold: true },
      expectedVersion: 0,
    },
    changes[0],
  ]);
  assert.equal(conflict.status, 409);
  assert.deepEqual(
    getTask(f.db, task.id),
    unchanged,
    "변경 없는 것으로 보이는 오래된 버전도 전체 배치를 거절한다",
  );
});

test("잘못된 서식 참조·색상·테두리·축약 키로 검증을 우회할 수 없다", async (t) => {
  const f = await fixture(t),
    task = f.task();
  const change = {
    taskId: task.id,
    key: "title",
    style: { $s: 0 },
    expectedVersion: 1,
  };
  for (const styles of [
    [{ bg: "bad" }],
    [{ br: ["solid"] }],
    [{ br: ["groove", "#123456"] }],
    [{ fs: 0 }],
    [{ invalid: true }],
  ]) {
    const result = await f.request(
      "/cells/batch",
      {
        $styles: styles,
        $data: {
          operationId: randomUUID(),
          createdAt: now(),
          changes: [change],
        },
      },
      true,
    );
    assert.equal(result.status, 400);
  }
  const invalidRef = await f.request(
    "/cells/batch",
    {
      $styles: [{}],
      $data: {
        operationId: randomUUID(),
        createdAt: now(),
        changes: [{ ...change, style: { $s: 99 } }],
      },
    },
    true,
  );
  assert.equal(invalidRef.status, 400);
  assert.deepEqual(getTask(f.db, task.id), task);
});
