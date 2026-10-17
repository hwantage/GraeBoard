import { parseCompact, compactStyle } from "../shared/compact.js";
import { unpack } from "../shared/compact.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import { cell, sampleProperties } from "../shared/domain.js";

const dir = mkdtempSync(join(tmpdir(), "row-menu-test-"));
let db, server, base, admin, adminId, member, memberId, viewer, viewerId;
async function request(path, body, cookie = admin) {
  const response = await fetch(base + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "X-Requested-With": "WeeklyPlan",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: await response.json().then(unpack),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
before(async () => {
  db = openDatabase(join(dir, "db.sqlite"));
  server = createApp({
    db,
    rateLimits: false,
    staticDir: join(dir, "absent"),
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await request("/auth/setup", {
    username: "row-admin@example.com",
    password: "test-password-123",
    name: "관리자",
    teamName: "행 메뉴",
  });
  assert.equal(setup.status, 201);
  admin = setup.cookie;
  adminId = setup.data.user.id;
  for (const name of ["member", "viewer"]) {
    const created = await request("/admin/users", {
      username: `row-${name}@example.com`,
      password: "test-password-123",
      name,
      memberships: [],
    });
    const login = await request("/auth/login", {
      username: `row-${name}@example.com`,
      password: "test-password-123",
    });
    if (name === "member") {
      member = login.cookie;
      memberId = created.data.user.id;
    } else {
      viewer = login.cookie;
      viewerId = created.data.user.id;
    }
  }
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const created = await request("/admin/teams", {
    name: "행 메뉴 " + randomUUID().slice(0, 8),
    members: [
      { userId: adminId, role: "lead" },
      { userId: memberId, role: "member" },
      { userId: viewerId, role: "viewer" },
    ],
  });
  const teamId = created.data.id;
  const tasks = [];
  for (const title of ["A", "B", "C"])
    tasks.push(
      (await request("/tasks", { teamId, year: 2026, fields: { title } })).data
        .task,
    );
  return { teamId, tasks };
}
const at = (task, placement) => ({
  taskId: task.id,
  updatedAt: task.updatedAt,
  placement,
});
const rows = async (teamId) =>
  (await request(`/tasks?teamId=${teamId}&year=2026`)).data.tasks;

test("다중 삭제·복구는 권한·버전·팀을 검사하고 실패하면 전체를 보존한다", async () => {
  const { teamId, tasks } = await fixture();
  const versions = (tasks) =>
    tasks.map(({ id, updatedAt }) => ({ id, updatedAt }));
  const remove = (tasks, cookie = admin) =>
    request("/tasks/delete", { tasks: versions(tasks) }, cookie);
  assert.equal((await remove(tasks, viewer)).status, 403);
  assert.equal(
    (await remove([tasks[0], (await fixture()).tasks[0]])).status,
    400,
  );
  const own = (
    await request(
      "/tasks",
      { teamId, year: 2026, fields: { title: "내 업무" } },
      member,
    )
  ).data.task;
  assert.equal((await remove([own, tasks[0]], member)).status, 403);
  assert.equal((await rows(teamId)).length, 4);
  await request("/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: tasks[1].id,
        key: "title",
        value: "동시 변경",
        expectedVersion: tasks[1].cells.title.version,
      },
    ],
  });
  assert.equal((await remove(tasks.slice(0, 2))).status, 409);
  assert.equal((await rows(teamId)).length, 4);
  const current = (await rows(teamId)).filter((t) =>
    tasks.some((old) => old.id === t.id),
  );
  db.exec(`CREATE TEMP TRIGGER fail_bulk_delete BEFORE UPDATE OF deleted_at ON tasks
    WHEN NEW.id='${current[1].id}' AND NEW.deleted_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'bulk rollback'); END`);
  assert.equal((await remove(current)).status, 500);
  db.exec("DROP TRIGGER fail_bulk_delete");
  assert.equal((await rows(teamId)).length, 4);
  const deleted = await remove(current);
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (await rows(teamId)).map((t) => t.id),
    [own.id],
  );
  const restoring = current.map((t) => ({
    id: t.id,
    updatedAt: deleted.data.updatedAt[t.id],
  }));
  assert.equal(
    (
      await request("/tasks/restore", {
        tasks: [
          restoring[0],
          { ...restoring[1], updatedAt: current[1].updatedAt },
        ],
      })
    ).status,
    409,
  );
  assert.equal((await rows(teamId)).length, 1);
  assert.equal(
    (await request("/tasks/restore", { tasks: restoring })).status,
    200,
  );
  assert.equal((await rows(teamId)).length, 4);
});

test("삭제 이력에서 원본 업무를 복구하고 이전 삭제 이력으로 새 삭제를 되돌리지 않는다", async () => {
  const { teamId, tasks } = await fixture();
  const remove = async () => {
    const current = (await rows(teamId))[0];
    return request("/tasks/delete", {
      tasks: [{ id: current.id, updatedAt: current.updatedAt }],
    });
  };
  await remove();
  const history = async () =>
    (await request(`/audit?teamId=${teamId}&sheetId=original`)).data.entries;
  const first = (await history()).find((e) => e.action === "delete");
  assert.deepEqual(first.sheet, { id: "original", name: "원본" });
  assert.deepEqual(first.restorableTaskIds, [tasks[0].id]);
  assert.equal(
    (await request(`/audit/${first.id}/restore`, {}, viewer)).status,
    403,
  );
  assert.equal((await request(`/audit/${first.id}/restore`, {})).status, 200);
  assert.equal((await rows(teamId)).length, 3);
  assert.deepEqual(
    (await history()).find((e) => e.id === first.id).restorableTaskIds,
    [],
  );
  await remove();
  assert.equal((await request(`/audit/${first.id}/restore`, {})).status, 409);
  assert.equal((await rows(teamId)).length, 2);
});

test("행 위·아래 삽입은 위치를 저장하고 권한·팀·연도·기준 행 버전을 검사한다", async () => {
  const {
    teamId,
    tasks: [a, b],
  } = await fixture();
  const create = (title, insertAt, cookie = admin, year = 2026) =>
    request("/tasks", { teamId, year, fields: { title }, insertAt }, cookie);
  assert.equal((await create("B 위", at(b, "before"))).status, 201);
  assert.equal((await create("A 아래", at(a, "after"))).status, 201);
  assert.deepEqual(
    (await rows(teamId)).map((t) => t.cells.title.value),
    ["A", "A 아래", "B 위", "B", "C"],
  );
  const initialCount = (await rows(teamId)).length;
  assert.equal((await create("금지", at(a, "after"), viewer)).status, 403);
  assert.equal(
    (await create("다른 연도", at(a, "after"), admin, 2027)).status,
    400,
  );
  const foreign = (await fixture()).tasks[0];
  assert.equal((await create("다른 팀", at(foreign, "before"))).status, 400);
  await request("/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: b.id,
        key: "title",
        expectedVersion: b.cells.title.version,
        value: "B 수정",
      },
    ],
  });
  assert.equal((await create("옛 기준", at(b, "before"))).status, 409);
  assert.equal((await rows(teamId)).length, initialCount);
  const own = await create("팀원 삽입", at(a, "before"), member);
  assert.equal(own.status, 201);
  assert.equal(cell(own.data.task, "owner").value, "");
  assert.equal((await rows(teamId))[0].id, own.data.task.id);
});

test("팀원은 직접 삽입한 미지정 행을 편집하고 다른 사람의 미지정 행은 편집하지 못한다", async () => {
  const {
    teamId,
    tasks: [source],
  } = await fixture();
  const insert = (fields = {}, cookie = member) =>
    request(
      "/tasks",
      {
        teamId,
        year: 2026,
        fields,
        insertAt: at(source, "after"),
      },
      cookie,
    );
  const own = await insert();
  assert.equal(own.status, 201);
  assert.equal(cell(own.data.task, "owner").value, "");
  assert.equal(own.data.task.createdBy, memberId);
  const edit = (task, key, value, cookie = member) =>
    request(
      "/cells/batch",
      {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: task.id,
            key,
            value,
            expectedVersion: task.cells[key]?.version || 0,
          },
        ],
      },
      cookie,
    );
  assert.equal(
    (await edit(own.data.task, "title", "미지정 업무 입력")).status,
    200,
  );
  assert.equal((await edit(own.data.task, "owner", memberId)).status, 403);
  const otherRow = await insert({}, admin);
  assert.equal(
    (await edit(otherRow.data.task, "title", "타인 업무 수정")).status,
    403,
  );
  assert.equal((await insert({ owner: memberId })).status, 201);
  assert.equal((await insert({ owner: "" })).status, 201);
  assert.equal((await insert({ owner: adminId })).status, 403);
  assert.equal(
    (await edit(own.data.task, "owner", adminId, admin)).status,
    200,
  );
  const assigned = (await rows(teamId)).find((t) => t.id === own.data.task.id);
  assert.equal((await edit(assigned, "title", "배정 후 수정")).status, 403);
});

test("위·아래 삽입은 서식만 상속하고 선택값은 묶음 기준값만 유지한다", async () => {
  const { teamId } = await fixture();
  const settings = parseCompact(
    db.prepare("SELECT settings FROM teams WHERE id=?").get(teamId).settings,
  );
  settings.properties = sampleProperties();
  db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
    JSON.stringify(settings),
    teamId,
  );
  const baseStyle = {
    backgroundColor: "#edf2fa",
    color: "#123456",
    fontFamily: "Noto Serif KR",
    fontSize: 16,
    bold: true,
    italic: true,
    underline: true,
    strike: true,
    textAlign: "right",
    verticalAlign: "bottom",
    textMode: "wrap",
    borderTop: { style: "solid", color: "#336699" },
    borderRight: { style: "dashed", color: "#225588" },
    borderBottom: { style: "double", color: "#114477" },
  };
  const snapshot = {
    defaultStyle: baseStyle,
    cells: {
      title: {
        value: "서식 원본",
        style: { backgroundColor: "#ffddaa", bold: false, borderTop: null },
      },
      owner: { value: adminId, style: { textAlign: "center" } },
      status: { value: "status-completed", style: {} },
      category: { value: "category-ux", style: { color: "#556677" } },
      type: { value: "type-design", style: {} },
      supporters: { value: [adminId, memberId], style: { color: "#445566" } },
      score: { value: 95, style: { fontSize: 20 } },
      description: { value: "복사하지 않을 내용", style: { textMode: "clip" } },
      "2026-12-07": {
        value: "숨긴 일정",
        style: { backgroundColor: "#cceedd", borderBottom: null },
      },
      "2027-01-04": {
        value: "다른 연도 일정",
        style: { fontFamily: "Nanum Gothic Coding", italic: false },
      },
    },
  };
  const created = await request("/tasks", {
    teamId,
    year: 2026,
    copiedRow: snapshot,
  });
  assert.equal(created.status, 201);
  const source = created.data.task;
  for (const placement of ["before", "after"]) {
    const inserted = await request(
      "/tasks",
      {
        teamId,
        year: 2026,
        fields: placement === "before" ? { score: 0 } : {},
        insertAt: at(source, placement),
      },
      member,
    );
    assert.equal(inserted.status, 201);
    const stored = (await rows(teamId)).find(
      (t) => t.id === inserted.data.task.id,
    );
    assert.deepEqual(stored.defaultStyle, baseStyle);
    for (const [key, original] of Object.entries(snapshot.cells)) {
      assert.deepEqual(cell(stored, key).style, cell(source, key).style, key);
      if (Object.keys(original.style).length) {
        assert.deepEqual(stored.cells[key].style, original.style, key);
        assert.equal(stored.cells[key].version, 1);
      }
    }
    // 셀 데이터가 없던 주차도 기준 행의 기본 서식을 그대로 사용한다.
    assert.deepEqual(cell(stored, "2026-06-01").style, baseStyle);
    assert.equal(cell(stored, "title").value, "새 업무");
    assert.equal(cell(stored, "owner").value, "");
    assert.equal(cell(stored, "status").value, "");
    assert.equal(cell(stored, "category").value, "");
    assert.equal(cell(stored, "type").value, "");
    assert.deepEqual(cell(stored, "supporters").value, []);
    assert.equal(cell(stored, "score").value, placement === "before" ? 0 : "");
    for (const key of ["description", "2026-12-07", "2027-01-04"])
      assert.equal(cell(stored, key).value, "");
  }
  assert.deepEqual(
    (await rows(teamId)).find((t) => t.id === source.id),
    source,
  );
  for (const key of ["category", "status", "owner", "supporters"]) {
    const grouped = await request("/tasks", {
      teamId,
      year: 2026,
      fields: { [key]: cell(source, key).value },
      insertAt: at(source, "after"),
    });
    assert.equal(grouped.status, 201);
    const task = grouped.data.task;
    assert.deepEqual(cell(task, key).value, cell(source, key).value);
    for (const other of [
      "category",
      "status",
      "type",
      "owner",
      "supporters",
    ].filter((v) => v !== key))
      assert.deepEqual(
        cell(task, other).value,
        other === "supporters" ? [] : "",
      );
    assert.deepEqual(
      cell(task, "category").style,
      cell(source, "category").style,
    );
  }
  // 일반 업무 추가는 기준 행 없이 기존 팀 기본 서식을 사용한다.
  const plain = await request("/tasks", { teamId, year: 2026 });
  assert.deepEqual(plain.data.task.defaultStyle, settings.defaultStyle);
  assert.equal(cell(plain.data.task, "status").value, "");
  assert.equal(cell(plain.data.task, "owner").value, "");
});

test("행 붙여넣기는 복사 당시 값·일정·기본 서식을 보존하고 담당자 권한을 지킨다", async () => {
  const {
    teamId,
    tasks: [a],
  } = await fixture();
  const copiedRow = {
    defaultStyle: {
      fontSize: 16,
      borderBottom: { style: "thick", color: "#336699" },
    },
    cells: {
      title: {
        value: "복사 당시 작업",
        style: { bold: true, borderBottom: null },
      },
      owner: { value: adminId, style: {} },
      "2026-12-07": {
        value: "숨긴 일정도 복사",
        style: { backgroundColor: "#aaccff" },
      },
    },
  };
  const paste = (row, cookie = admin) =>
    request(
      "/tasks",
      { teamId, year: 2026, copiedRow: row, insertAt: at(a, "after") },
      cookie,
    );
  const copied = await paste(copiedRow);
  assert.equal(copied.status, 201);
  const stored = (await rows(teamId)).find((t) => t.id === copied.data.task.id);
  assert.deepEqual(stored.defaultStyle, copiedRow.defaultStyle);
  for (const [key, c] of Object.entries(copiedRow.cells)) {
    assert.equal(stored.cells[key].value, c.value);
    assert.deepEqual(stored.cells[key].style, c.style);
    assert.equal(stored.cells[key].version, 1);
  }
  const own = await paste(copiedRow, member);
  assert.equal(own.status, 201);
  assert.equal(own.data.task.cells.owner.value, memberId);
  assert.equal((await paste(copiedRow, viewer)).status, 403);
  assert.equal(
    (
      await paste({
        ...copiedRow,
        cells: { unknown: { value: "bad", style: {} } },
      })
    ).status,
    400,
  );
  assert.equal(
    (await paste({ ...copiedRow, defaultStyle: { fontSize: 99 } })).status,
    400,
  );
  // 지금은 고를 수 없는 값(열람자 담당자, 없는 선택값)만 빼고 붙여넣는다.
  const stale = await paste({
    ...copiedRow,
    cells: {
      ...copiedRow.cells,
      owner: { value: viewerId, style: {} },
      status: { value: "보관된 상태", style: {} },
    },
  });
  assert.equal(stale.status, 201);
  assert.equal(stale.data.task.cells.title.value, "복사 당시 작업");
  assert.equal(cell(stale.data.task, "owner").value, "");
  assert.notEqual(stale.data.task.cells.status?.value, "보관된 상태");
});

test("현재 점선 서식의 행은 같은 행 아래에 그대로 붙여넣고 옛 서식은 거절한다", async () => {
  const {
    teamId,
    tasks: [original],
  } = await fixture();
  const title = "디자인 시스템 컴포넌트 가이드 정리";
  const week = "2026-11-02";
  const updated = await request("/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: original.id,
        key: "title",
        expectedVersion: original.cells.title.version,
        value: title,
      },
      {
        taskId: original.id,
        key: week,
        expectedVersion: 0,
        value: "컴포넌트 가이드 검토",
      },
    ],
  });
  assert.equal(updated.status, 200);
  const savedStyle = {
    borderRight: { style: "dashed", color: "#856060" },
    borderBottom: null,
  };
  const savedDefault = {
    fontSize: 14,
    borderBottom: { style: "dashed", color: "#335577" },
  };
  const addStyle = (style) =>
    db
      .prepare("INSERT INTO styles(data) VALUES(?) RETURNING id")
      .get(JSON.stringify(compactStyle(style))).id;
  db.prepare("UPDATE cells SET style_id=? WHERE task_id=? AND key=?").run(
    addStyle(savedStyle),
    original.id,
    week,
  );
  db.prepare("UPDATE tasks SET default_style=? WHERE id=?").run(
    addStyle(savedDefault),
    original.id,
  );
  const source = (await rows(teamId)).find((task) => task.id === original.id);
  const copiedRow = {
    defaultStyle: source.defaultStyle,
    cells: Object.fromEntries(
      Object.entries(source.cells).map(([key, c]) => [
        key,
        { value: c.value, style: c.style },
      ]),
    ),
  };
  const pasted = await request("/tasks", {
    teamId,
    year: 2026,
    copiedRow,
    insertAt: at(source, "after"),
  });
  assert.equal(pasted.status, 201, JSON.stringify(pasted.data));
  const stored = await rows(teamId);
  const copy = stored.find((task) => task.id === pasted.data.task.id);
  assert.equal(
    stored[stored.findIndex((task) => task.id === source.id) + 1].id,
    copy.id,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(copy.cells).map(([key, c]) => [key, c.value]),
    ),
    Object.fromEntries(
      Object.entries(source.cells).map(([key, c]) => [key, c.value]),
    ),
  );
  assert.deepEqual(copy.cells[week].style, savedStyle);
  assert.deepEqual(copy.defaultStyle, savedDefault);
  const untouched = stored.find((task) => task.id === original.id);
  assert.deepEqual(untouched.cells[week].style, savedStyle);
  assert.deepEqual(untouched.defaultStyle, savedDefault);
  // 자동 변환 없이 현재 선 종류와 유효한 색상만 허용한다.
  for (const border of [
    { style: "dotted", color: "#856060" },
    { style: "groove", color: "#856060" },
    { style: "dashed", color: "invalid" },
    { style: "dashed", color: "#856060", extra: true },
  ]) {
    const invalid = await request("/tasks", {
      teamId,
      year: 2026,
      insertAt: at(source, "after"),
      copiedRow: { ...copiedRow, defaultStyle: { borderRight: border } },
    });
    assert.equal(invalid.status, 400);
  }
  assert.equal((await rows(teamId)).length, stored.length);
});

test("삽입 간격 재배치는 생성과 함께 저장하고 생성 실패 시 모두 되돌린다", async () => {
  const { teamId, tasks } = await fixture();
  // B가 반드시 중간 행이어야 간격 재배치 분기를 검증한다. 같은 밀리초에
  // 생성된 행의 무작위 UUID 순서에 따라 B가 첫 행이 되는 경우를 피한다.
  const place = db.prepare(
    "UPDATE tasks SET position=7,created_at=? WHERE id=?",
  );
  tasks.forEach((task, index) =>
    place.run(
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      task.id,
    ),
  );
  const positions = () =>
    db
      .prepare(
        "SELECT id,position,updated_at FROM tasks WHERE team_id=? ORDER BY id",
      )
      .all(teamId);
  const before = positions();
  db.exec(
    "CREATE TRIGGER fail_row_insert BEFORE INSERT ON cells WHEN NEW.value='\"실패\"' BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  try {
    const failed = await request("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "실패" },
      insertAt: at(tasks[1], "before"),
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(positions(), before);
  } finally {
    db.exec("DROP TRIGGER fail_row_insert");
  }
  const inserted = await request("/tasks", {
    teamId,
    year: 2026,
    fields: { title: "사이" },
    insertAt: at(tasks[1], "before"),
  });
  assert.equal(inserted.status, 201);
  const ordered = await rows(teamId);
  const index = ordered.findIndex((t) => t.id === tasks[1].id);
  assert.equal(ordered[index - 1].id, inserted.data.task.id);
  assert.equal(new Set(ordered.map((t) => t.position)).size, ordered.length);
});
