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
    data: await response.json(),
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
  assert.equal(own.data.task.cells.owner.value, memberId);
  assert.equal((await rows(teamId))[0].id, own.data.task.id);
});

test("위·아래 삽입은 기준 행의 기본·셀별 서식만 상속하고 새 업무 값을 유지한다", async () => {
  const { teamId } = await fixture();
  const settings = JSON.parse(
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
    borderLeft: null,
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
    assert.equal(cell(stored, "owner").value, memberId);
    assert.equal(cell(stored, "status").value, "status-planned");
    assert.deepEqual(cell(stored, "supporters").value, []);
    assert.equal(cell(stored, "score").value, placement === "before" ? 0 : "");
    for (const key of ["description", "2026-12-07", "2027-01-04"])
      assert.equal(cell(stored, key).value, "");
  }
  assert.deepEqual(
    (await rows(teamId)).find((t) => t.id === source.id),
    source,
  );
  // 일반 업무 추가는 기준 행 없이 기존 팀 기본 서식을 사용한다.
  const plain = await request("/tasks", { teamId, year: 2026 });
  assert.deepEqual(plain.data.task.defaultStyle, settings.defaultStyle);
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
  assert.equal(stale.data.task.cells.owner.value, adminId);
  assert.notEqual(stale.data.task.cells.status?.value, "보관된 상태");
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
