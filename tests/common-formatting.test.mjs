import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  insertTask,
  getTask,
  getTasksById,
  readFormatting,
  json,
  now,
} from "../server/db.mjs";
import { DEFAULT_SETTINGS, cell, weeksForPeriod } from "../shared/domain.js";
import {
  explicitStyle,
  copyRowFormatting,
  resetCellStyle,
  rowFontSize,
} from "../shared/formatting.js";
import { pack, unpack, stringify } from "../shared/compact.js";
import { encodeReport, decodeReport } from "../server/reports.mjs";
import { formatScopes } from "../src/format-selection.js";
import { applyBorderPreset } from "../shared/borders.js";

async function fixture(t) {
  const db = openDatabase(":memory:"),
    teamId = randomUUID(),
    userId = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "공통 서식",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
  ).run(userId, userId, "검증", "unused", "admin", now());
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(userId).digest("hex"),
    userId,
    Date.now() + 600000,
  );
  const app = createApp({ db, rateLimits: false }),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
  });
  const request = async (
    path,
    body,
    actor = userId,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          Cookie: `weekly_session=${actor}`,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : stringify(body),
      },
    );
    const raw = await response.json();
    return { status: response.status, raw, data: unpack(raw) };
  };
  const task = (cells = {}, defaultStyle = {}) =>
    insertTask(db, {
      teamId,
      year: 2026,
      actorId: userId,
      fields: { title: "업무" },
      cells,
      defaultStyle,
    });
  const sendFormat = async (scopes, extra = {}) => {
    const ids = [...new Set(scopes.flatMap((s) => s.rows || []))];
    const expectedTasks = Object.fromEntries(
      getTasksById(db, ids).map((t) => [t.id, t.updatedAt]),
    );
    const body = {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [],
      format: {
        teamId,
        expectedRevision: readFormatting(db, teamId).revision,
        scopes,
        expectedTasks,
        ...extra,
      },
    };
    const response = await request("/cells/batch", body);
    return { ...response, body };
  };
  const saveCell = (taskId, key, style) =>
    request("/cells/batch", {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [
        {
          taskId,
          key,
          style,
          expectedVersion: getTask(db, taskId).cells[key]?.version ?? 0,
          expectedFormatRevision: readFormatting(db, teamId).revision,
        },
      ],
    });
  const undo = (result) =>
    request("/cells/batch", {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [],
      format: {
        teamId,
        restore: result.operationId,
        expectedRevision: readFormatting(db, teamId).revision,
        expectedCells: Object.fromEntries(
          result.cells.map((c) => [`${c.taskId}:${c.key}`, c.version]),
        ),
      },
    });
  return { db, teamId, userId, request, task, sendFormat, saveCell, undo };
}

test("업무 이력은 관계없는 행 규칙을 빼고 해당 업무의 서식과 수정 번호를 보존한다", async (t) => {
  const f = await fixture(t),
    other = f.task();
  assert.equal(
    (
      await f.sendFormat([
        { rows: [other.id], keys: null, style: { backgroundColor: "#ffe6dd" } },
      ])
    ).status,
    200,
  );
  const created = await f.request("/tasks", {
    teamId: f.teamId,
    year: 2026,
    fields: { title: "독립된 생성 이력" },
  });
  assert.equal(created.status, 201);
  const task = created.data.task;
  // Live responses still carry the complete team context for concurrency.
  assert.equal(task.formatting.rules.length, 1);
  const audit = (action) =>
    f.db
      .prepare(
        "SELECT before_json,after_json FROM audit WHERE target=? AND action=?",
      )
      .get(task.id, action);
  const creation = unpack(JSON.parse(audit("create").after_json));
  assert.equal(creation.formatting, undefined);
  assert.equal(creation.cells.title.version, 1);
  assert.equal(audit("create").after_json.includes("#ffe6dd"), false);

  assert.equal(
    (
      await f.sendFormat([
        { rows: [other.id, task.id], keys: ["title"], style: { bold: true } },
      ])
    ).status,
    200,
  );
  const current = getTask(f.db, task.id);
  const moved = await f.request(
    `/tasks/${task.id}`,
    {
      updatedAt: current.updatedAt,
      years: [2026, 2027],
    },
    f.userId,
    "PATCH",
  );
  assert.equal(moved.status, 200);
  assert.equal(moved.data.task.formatting.rules.length, 2);
  assert.equal(
    (
      await f.request(
        `/tasks/${task.id}`,
        {
          updatedAt: moved.data.task.updatedAt,
        },
        f.userId,
        "DELETE",
      )
    ).status,
    200,
  );
  for (const raw of [
    audit("task").before_json,
    audit("task").after_json,
    audit("delete").before_json,
  ]) {
    const wire = JSON.parse(raw),
      snapshot = unpack(wire);
    assert.equal(snapshot.formatting.rules.length, 1);
    assert.deepEqual(snapshot.formatting.rules[0].rows, [task.id]);
    assert.equal(cell(snapshot, "title").style.bold, true);
    assert.equal(raw.includes(other.id), false);
    assert.equal(raw.includes("#ffe6dd"), false);
    assert.ok(wire.$styles.some((s) => s.b === true));
    assert.equal(snapshot.cells.title.version, 1);
  }

  assert.equal(
    (
      await f.sendFormat(
        [{ rows: null, keys: null, style: { italic: true } }],
        {
          expectedTasks: { [other.id]: getTask(f.db, other.id).updatedAt },
        },
      )
    ).status,
    200,
  );
  const global = await f.request("/tasks", { teamId: f.teamId, year: 2026 });
  assert.equal(global.status, 201);
  const globalAudit = unpack(
    JSON.parse(
      f.db
        .prepare(
          "SELECT after_json FROM audit WHERE action='create' AND target=?",
        )
        .get(global.data.task.id).after_json,
    ),
  );
  assert.equal(globalAudit.formatting.rules.length, 1);
  assert.equal(globalAudit.formatting.rules[0].rows, null);
  assert.equal(cell(globalAudit, "2027-02-01").style.italic, true);
});

test("행 공통 서식은 빈 주차를 만들지 않고 다음 해 1월·2월과 숨긴 열에 이어진다", async (t) => {
  const f = await fixture(t),
    task = f.task({}, { fontSize: 9 });
  const result = await f.sendFormat([
    {
      rows: [task.id],
      keys: null,
      style: {
        backgroundColor: "#d1eee6",
        bold: true,
        borderBottom: { style: "double", color: "#856060" },
      },
    },
  ]);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.cells.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM cells").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM format_rules").get().n, 1);
  const stored = getTask(f.db, task.id);
  for (const key of [
    "title",
    "status",
    "2026-12-28",
    "2027-01-04",
    "2027-02-01",
    "2028-02-07",
  ]) {
    assert.equal(cell(stored, key).style.backgroundColor, "#d1eee6");
    assert.equal(cell(stored, key).style.fontSize, 9);
    assert.equal(explicitStyle(stored, key).borderBottom.style, "double");
  }
  for (const startMonth of [1, 2, 3]) {
    const weeks = weeksForPeriod(2026, startMonth);
    assert.equal(
      cell(stored, weeks.at(-1).key).style.backgroundColor,
      "#d1eee6",
    );
  }
  const snapshot = decodeReport(
    encodeReport({
      tasks: [stored],
      users: [],
      view: {},
      settings: DEFAULT_SETTINGS,
    }),
  );
  assert.deepEqual(
    cell(snapshot.tasks[0], "2027-02-01").style,
    cell(stored, "2027-02-01").style,
  );
  const copied = copyRowFormatting(stored);
  const duplicate = insertTask(f.db, {
    teamId: f.teamId,
    year: 2027,
    actorId: f.userId,
    ...copied,
  });
  assert.equal(cell(duplicate, "2028-02-07").style.backgroundColor, "#d1eee6");
  assert.equal(
    explicitStyle(duplicate, "2028-02-07").borderBottom.style,
    "double",
  );
});

test("열 공통 서식·셀 예외·속성별 재적용과 실행취소는 서로 다른 내용을 보존한다", async (t) => {
  const f = await fixture(t),
    a = f.task(),
    b = f.task(),
    key = "2026-12-28";
  const scope = { rows: [a.id, b.id], keys: [key] };
  assert.equal(
    (
      await f.sendFormat([
        { ...scope, style: { backgroundColor: "#d1eee6", bold: true } },
      ])
    ).status,
    200,
  );
  assert.equal(
    (await f.saveCell(a.id, key, { backgroundColor: "#cebdeb", bold: false }))
      .status,
    200,
  );
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#cebdeb");
  assert.equal(cell(getTask(f.db, b.id), key).style.backgroundColor, "#d1eee6");
  assert.equal(
    cell(getTask(f.db, b.id), "2027-01-04").style.backgroundColor,
    undefined,
  );
  const bold = await f.sendFormat([{ ...scope, style: { bold: true } }]);
  assert.equal(bold.status, 200);
  assert.deepEqual(getTask(f.db, a.id).cells[key].style, {
    backgroundColor: "#cebdeb",
  });
  assert.equal(cell(getTask(f.db, a.id), key).style.bold, true);
  const yellow = await f.sendFormat([
    { ...scope, style: { backgroundColor: "#ffe599" } },
  ]);
  assert.equal(yellow.status, 200);
  assert.deepEqual(getTask(f.db, a.id).cells[key].style, {});
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM cells WHERE key=?").get(key).n,
    1,
  );
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#ffe599");
  const undone = await f.undo(yellow.data);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#cebdeb");
  assert.equal(cell(getTask(f.db, b.id), key).style.backgroundColor, "#d1eee6");
  const redone = await f.undo(undone.data);
  assert.equal(redone.status, 200, JSON.stringify(redone.data));
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#ffe599");
  const replay = await f.request("/cells/batch", yellow.body);
  assert.deepEqual(replay.data, yellow.data);
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#ffe599");
});

test("행·열 교차점은 항목별 최신 적용을 따르고 개별 셀 수정은 공통 서식과 다른 항목만 저장한다", async (t) => {
  const f = await fixture(t),
    a = f.task(),
    b = f.task(),
    key = "2027-01-04";
  await f.sendFormat([
    {
      rows: [a.id],
      keys: null,
      style: { backgroundColor: "#ff0000", bold: true },
    },
  ]);
  await f.sendFormat([
    { rows: [a.id, b.id], keys: [key], style: { backgroundColor: "#0000ff" } },
  ]);
  await f.sendFormat([{ rows: [a.id], keys: null, style: { italic: true } }]);
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#0000ff");
  assert.equal(
    cell(getTask(f.db, a.id), "2027-02-01").style.backgroundColor,
    "#ff0000",
  );
  assert.equal(cell(getTask(f.db, b.id), key).style.italic, undefined);
  const saved = await f.saveCell(a.id, key, {
    ...cell(getTask(f.db, a.id), key).style,
    bold: false,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(getTask(f.db, a.id).cells[key].style, { bold: false });
  const stale = await f.request("/cells/batch", {
    operationId: randomUUID(),
    createdAt: now(),
    changes: [
      {
        taskId: a.id,
        key,
        expectedVersion: saved.data.cells[0].version,
        expectedFormatRevision: 0,
        style: { color: "#123456" },
      },
    ],
  });
  assert.equal(stale.status, 409);
  const override = await f.sendFormat([
    { rows: [a.id], keys: null, style: { backgroundColor: "#00ff00" } },
  ]);
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#00ff00");
  assert.equal(cell(getTask(f.db, a.id), key).style.bold, false);
  assert.equal((await f.undo(override.data)).status, 200);
  assert.equal(cell(getTask(f.db, a.id), key).style.backgroundColor, "#0000ff");
});

test("1,000행 열 서식은 셀 1,000개를 생성하지 않고 조회·전송·스냅샷에서 공통 규칙을 한 번만 보낸다", async (t) => {
  const f = await fixture(t),
    tasks = Array.from({ length: 1000 }, () => f.task());
  const response = await f.sendFormat([
    {
      rows: tasks.map((t) => t.id),
      keys: ["2026-12-28"],
      style: { backgroundColor: "#d1eee6" },
    },
  ]);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM cells WHERE key='2026-12-28'").get().n,
    0,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM format_rules").get().n, 1);
  const list = await f.request(`/tasks?teamId=${f.teamId}&year=2026`);
  assert.equal(list.raw.$formats.length, 1);
  assert.equal(list.raw.$styles.length, 1);
  assert.equal(list.data.tasks[0].formatting, list.data.tasks[999].formatting);
  const roundtrip = unpack(pack({ tasks: list.data.tasks }));
  assert.equal(roundtrip.tasks[0].formatting, roundtrip.tasks[999].formatting);
  assert.equal(
    cell(roundtrip.tasks[999], "2026-12-28").style.backgroundColor,
    "#d1eee6",
  );
});

test("서식 요청은 낡은 업무·잘못된 열·타 팀 업무를 원자적으로 거절한다", async (t) => {
  const f = await fixture(t),
    a = f.task();
  const scope = { rows: [a.id], keys: null, style: { bold: true } };
  assert.equal(
    (await f.sendFormat([scope], { expectedTasks: { [a.id]: "old" } })).status,
    409,
  );
  assert.equal(
    (await f.sendFormat([{ ...scope, keys: ["not-a-property"] }])).status,
    400,
  );
  assert.equal(
    (await f.sendFormat([{ ...scope, rows: [randomUUID()] }])).status,
    404,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM format_rules").get().n, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM audit WHERE action='format'").get().n,
    0,
  );
});

test("같은 공통 서식 재적용은 규칙·셀·이력을 늘리지 않고 빈 변경도 생략한다", async (t) => {
  const f = await fixture(t),
    a = f.task();
  const scope = {
    rows: [a.id],
    keys: null,
    style: { backgroundColor: "#123456", bold: true },
  };
  const first = await f.sendFormat([scope]);
  const stamp = getTask(f.db, a.id).updatedAt;
  const noop = await f.sendFormat([scope]);
  assert.equal(noop.status, 200);
  assert.equal(noop.data.formatOperation, undefined);
  assert.deepEqual(noop.data.cells, []);
  assert.equal(
    readFormatting(f.db, f.teamId).revision,
    first.data.formatRevision,
  );
  assert.equal(getTask(f.db, a.id).updatedAt, stamp);
  assert.deepEqual(
    (await f.request("/cells/batch", noop.body)).data,
    noop.data,
  );
  await f.sendFormat([{ rows: [a.id], keys: ["title"], style: {} }]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM format_rules").get().n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM audit WHERE action='format'").get().n,
    1,
  );
});

test("공통 서식 지우기와 한 셀 지우기·행 복사는 기본값과 다음 연도 서식을 보존한다", async (t) => {
  const f = await fixture(t),
    a = f.task({}, { fontSize: 10 });
  const row = { rows: [a.id], keys: null };
  await f.sendFormat([
    { ...row, style: { backgroundColor: "#d1eee6", bold: true, fontSize: 30 } },
  ]);
  assert.equal(rowFontSize(getTask(f.db, a.id)), 30);
  const titleReset = await f.saveCell(
    a.id,
    "title",
    resetCellStyle(getTask(f.db, a.id), "title"),
  );
  assert.equal(titleReset.status, 200);
  assert.deepEqual(getTask(f.db, a.id).cells.title.style, {
    backgroundColor: null,
    bold: null,
    fontSize: 10,
  });
  assert.equal(cell(getTask(f.db, a.id), "title").style.backgroundColor, null);
  assert.equal(
    cell(getTask(f.db, a.id), "2027-02-01").style.backgroundColor,
    "#d1eee6",
  );
  const cleared = await f.sendFormat([
    { rows: [a.id], keys: ["2027-01-04"], reset: true, style: {} },
  ]);
  assert.equal(cleared.status, 200);
  assert.equal(
    cell(getTask(f.db, a.id), "2027-01-04").style.backgroundColor,
    undefined,
  );
  const response = await f.request("/tasks", {
    teamId: f.teamId,
    year: 2026,
    sourceId: a.id,
    expectedUpdatedAt: getTask(f.db, a.id).updatedAt,
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const duplicate = response.data.task;
  assert.equal(cell(duplicate, "2027-01-04").style.backgroundColor, null);
  assert.equal(cell(duplicate, "2027-01-04").style.fontSize, 10);
  assert.equal(cell(duplicate, "2027-02-01").style.backgroundColor, "#d1eee6");
  assert.equal(cell(duplicate, "title").style.backgroundColor, null);
  await f.sendFormat([{ ...row, style: {}, reset: true }]);
  const reset = getTask(f.db, a.id);
  assert.equal(rowFontSize(reset), 10);
  assert.equal(cell(reset, "2027-02-01").style.backgroundColor, undefined);
  assert.deepEqual(reset.cells.title.style, {});
});

test("공통 서식은 권한·팀 경계를 검사하고 다른 사용자의 실행취소를 거절한다", async (t) => {
  const f = await fixture(t),
    a = f.task();
  const member = randomUUID();
  f.db
    .prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,?,?)",
    )
    .run(member, member, "팀원", "unused", now());
  f.db
    .prepare("INSERT INTO memberships VALUES(?,?,?)")
    .run(member, f.teamId, "member");
  f.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      createHash("sha256").update(member).digest("hex"),
      member,
      Date.now() + 600000,
    );
  const saved = await f.sendFormat([
    { rows: [a.id], keys: null, style: { bold: true } },
  ]);
  const request = {
    operationId: randomUUID(),
    createdAt: now(),
    format: {
      teamId: f.teamId,
      expectedRevision: saved.data.formatRevision,
      scopes: [{ rows: [a.id], keys: null, style: { bold: false } }],
      expectedTasks: { [a.id]: getTask(f.db, a.id).updatedAt },
    },
  };
  const edited = await f.request("/cells/batch", request, member);
  assert.equal(edited.status, 200);
  request.operationId = randomUUID();
  request.format.expectedRevision = edited.data.formatRevision;
  assert.equal(
    (
      await f.request(
        "/cells/batch",
        {
          ...request,
          format: {
            ...request.format,
            scopes: [{ rows: null, keys: ["title"], style: { bold: false } }],
          },
        },
        member,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/cells/batch",
        {
          operationId: randomUUID(),
          createdAt: now(),
          format: {
            teamId: f.teamId,
            restore: saved.data.operationId,
            expectedRevision: edited.data.formatRevision,
          },
        },
        member,
      )
    ).status,
    403,
  );
  const other = randomUUID();
  f.db
    .prepare("INSERT INTO teams VALUES(?,?,?)")
    .run(other, "다른 팀", json(DEFAULT_SETTINGS));
  const foreign = insertTask(f.db, {
    teamId: other,
    year: 2026,
    actorId: f.userId,
    fields: { title: "외부 업무" },
  });
  assert.equal(
    (
      await f.sendFormat([
        { rows: [a.id, foreign.id], keys: null, style: { italic: true } },
      ])
    ).status,
    404,
  );
  assert.equal(
    readFormatting(f.db, f.teamId).revision,
    edited.data.formatRevision,
  );
});

test("업무별 공통 서식 이력을 찾고 관리자 복원은 이후 변경과 충돌을 검사한다", async (t) => {
  const f = await fixture(t),
    a = f.task(),
    b = f.task();
  const first = await f.sendFormat([
    { rows: [a.id], keys: null, style: { backgroundColor: "#123456" } },
  ]);
  const entries = (await f.request(`/audit?teamId=${f.teamId}&taskId=${a.id}`))
    .data.entries;
  const entry = entries.find((e) => e.target === first.data.operationId);
  assert.equal(entry.action, "format");
  assert.equal(
    (
      await f.request(`/audit?teamId=${f.teamId}&taskId=${b.id}`)
    ).data.entries.some((e) => e.id === entry.id),
    false,
  );
  const restored = await f.request(`/audit/${entry.id}/restore`, {
    versions: {},
    formatRevision: first.data.formatRevision,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(
    cell(getTask(f.db, a.id), "2027-01-04").style.backgroundColor,
    undefined,
  );
  await f.sendFormat([{ rows: [a.id], keys: null, style: { bold: true } }]);
  assert.equal(
    (
      await f.request(`/audit/${entry.id}/restore`, {
        versions: {},
        formatRevision: readFormatting(f.db, f.teamId).revision,
      })
    ).status,
    409,
  );
});

test("재적용으로 지워진 셀 예외에 후속 편집이 있으면 공통 서식 실행취소도 원자적으로 거절한다", async (t) => {
  const f = await fixture(t),
    a = f.task(),
    key = "2026-12-28";
  await f.saveCell(a.id, key, { bold: false });
  const saved = await f.sendFormat([
    { rows: [a.id], keys: null, style: { bold: true } },
  ]);
  await f.saveCell(a.id, key, { italic: true });
  const revision = readFormatting(f.db, f.teamId).revision;
  assert.equal((await f.undo(saved.data)).status, 409);
  assert.equal(readFormatting(f.db, f.teamId).revision, revision);
  assert.equal(cell(getTask(f.db, a.id), key).style.bold, true);
  assert.equal(cell(getTask(f.db, a.id), key).style.italic, true);
});

test("행·열의 합집합 테두리는 실제 외곽선과 동일하고 다음 해 행 내부에도 적용한다", async (t) => {
  const f = await fixture(t),
    tasks = [f.task(), f.task(), f.task()];
  const columns = [
    { key: "title" },
    { key: "owner" },
    ...weeksForPeriod(2026, 1),
  ];
  const ranges = [
    { r1: 0, r2: 1, c1: 0, c2: columns.length - 1, kind: "rows" },
    { r1: 0, r2: 2, c1: 2, c2: 3, kind: "columns" },
  ];
  const line = { style: "double", color: "#856060" };
  const has = (r, c) =>
    ranges.some((a) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2);
  for (const preset of [
    "all",
    "none",
    "outside",
    "inner",
    "vertical",
    "horizontal",
  ]) {
    await f.sendFormat([
      { rows: tasks.map((t) => t.id), keys: null, reset: true, style: {} },
    ]);
    const scopes = formatScopes(ranges, tasks, columns, {}, false, {
      preset,
      border: line,
    });
    const response = await f.sendFormat(scopes);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    for (let r = 0; r < tasks.length; r++) {
      const stored = getTask(f.db, tasks[r].id);
      for (let c = 0; c < columns.length; c++) {
        const expected = has(r, c)
          ? applyBorderPreset({}, preset, line, {
              Top: !has(r - 1, c),
              Bottom: !has(r + 1, c),
              Left: !has(r, c - 1),
              Right: !has(r, c + 1),
            })
          : {};
        assert.deepEqual(
          explicitStyle(stored, columns[c].key),
          expected,
          `${preset}: ${r},${c}`,
        );
      }
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM cells").get().n, 3);
    const future = explicitStyle(getTask(f.db, tasks[0].id), "2027-02-01");
    assert.deepEqual(
      future,
      applyBorderPreset({}, preset, line, {
        Top: true,
        Bottom: false,
        Left: false,
        Right: false,
      }),
    );
  }
});
