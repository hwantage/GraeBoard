import { DatabaseSync } from "node:sqlite";
import { parseCompact } from "../shared/compact.js";
import { unpack } from "../shared/compact.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import {
  DEFAULT_SETTINGS,
  defaultView,
  weeksForYear,
  cell,
} from "../shared/domain.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-reports-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path),
    app,
    server,
    base;
  const teamId = randomUUID();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.properties.push(
    {
      id: "reviewers",
      name: "검토자",
      kind: "member",
      display: "text",
      multiple: true,
      values: [],
      visible: true,
    },
    {
      id: "supporters",
      name: "지원자",
      kind: "member",
      display: "text",
      multiple: true,
      values: [],
      archived: true,
    },
  );
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "보고서 검증",
    json(settings),
  );
  const people = Object.fromEntries(
    ["admin", "owner", "reviewer", "former", "filterOnly", "unused"].map(
      (key) => [
        key,
        {
          id: randomUUID(),
          name: `${key} 저장 당시 이름`,
        },
      ],
    ),
  );
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==";
  for (const [key, person] of Object.entries(people)) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,color,avatar_initials,avatar_image,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      person.id,
      `${key}@example.com`,
      person.name,
      "unused",
      key === "admin" ? "admin" : "user",
      "#123456",
      "AB",
      image,
      now(),
    );
    if (key !== "former")
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        person.id,
        teamId,
        key === "admin" ? "lead" : "member",
      );
  }
  const token = randomUUID();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    people.admin.id,
    Date.now() + 600000,
  );
  const task = insertTask(db, {
    teamId,
    year: 2026,
    actorId: people.admin.id,
    fields: {
      title: "장기 보관할 업무",
      owner: people.owner.id,
      reviewers: [people.reviewer.id],
      supporters: [people.former.id],
    },
    cells: Object.fromEntries(
      weeksForYear(2026).map(({ key }, i) => [
        key,
        {
          value: `보고 일정 ${i + 1}`,
          style: {
            bold: true,
            color: "#224466",
            backgroundColor: "#ddeeff",
            fontSize: 12,
            textMode: "wrap",
          },
        },
      ]),
    ),
  });
  const view = {
    ...defaultView(2026),
    propertyFilters: { reviewers: [people.filterOnly.id] },
    propertyFilterModes: { reviewers: "exclude" },
    widths: { title: 300 },
    rowHeights: { [task.id]: 70 },
  };
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
    db.close();
  }
  await start();
  t.after(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, { method = "GET", body } = {}) {
    const form = body instanceof FormData;
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: `weekly_session=${token}`,
        "X-Requested-With": "WeeklyPlan",
        ...(form ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : form ? body : json(body),
    });
    return {
      status: response.status,
      data: await response.json().then(unpack),
    };
  }
  return {
    get db() {
      return db;
    },
    teamId,
    task,
    people,
    image,
    view,
    request,
    save: () =>
      request("/reports", {
        method: "POST",
        body: {
          teamId,
          year: 2026,
          name: "최소 저장 검증",
          referenceDate: "2026-10-12",
          taskIds: [task.id],
          view,
        },
      }),
    async restart() {
      await stop();
      db = openDatabase(path);
      await start();
    },
  };
}

function storedReport(db, id) {
  const row = db
    .prepare("SELECT data, typeof(data) AS type FROM reports WHERE id=?")
    .get(id);
  assert.equal(
    row.type,
    "blob",
    "스냅샷은 문자열이나 base64가 아닌 압축 바이너리여야 한다",
  );
  const plain = gunzipSync(row.data);
  assert(
    row.data.length < plain.length / 2,
    "반복되는 업무·서식은 압축되어야 한다",
  );
  return parseCompact(plain.toString("utf8"));
}

const reportCell = (taskId, key, value, style) => ({
  kind: "cells",
  at: new Date().toISOString(),
  changes: [
    {
      taskId,
      key,
      expectedVersion: 0,
      ...(value === undefined ? {} : { value }),
      ...(style ? { style } : {}),
    },
  ],
});
const editReport = (f, report, operations) =>
  f.request(`/reports/${report.id}`, {
    method: "PATCH",
    body: { operationId: randomUUID(), revision: report.revision, operations },
  });

test("보고본 편집은 삭제·추가·종류·선택값이 바뀐 원본 속성과 삭제된 원본 업무에 영향받지 않는다", async (t) => {
  const f = await fixture(t);
  let settings = parseCompact(
    f.db.prepare("SELECT settings FROM teams WHERE id=?").get(f.teamId)
      .settings,
  );
  settings.properties.push(
    {
      id: "legacy",
      name: "과거 메모",
      kind: "text",
      display: "text",
      values: [],
    },
    { id: "amount", name: "숫자", kind: "number", display: "text", values: [] },
    { id: "deadline", name: "기한", kind: "date", display: "text", values: [] },
    {
      id: "priority",
      name: "당시 선택값",
      kind: "option",
      display: "text",
      values: [
        {
          id: "old",
          label: "기존 값",
          backgroundColor: "#ffffff",
          dotColor: "#000000",
          emoji: "",
        },
      ],
    },
  );
  const configured = await f.request(`/teams/${f.teamId}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  settings = configured.data.settings;
  const { data: saved } = await f.save();
  const report = (await f.request(`/reports/${saved.id}`)).data;
  const otherId = (await f.save()).data.id;
  const other = (await f.request(`/reports/${otherId}`)).data;
  settings.properties = settings.properties.filter((p) => p.id !== "legacy");
  settings.properties.find((p) => p.id === "amount").kind = "text";
  settings.properties.find((p) => p.id === "priority").values = [];
  settings.properties.push({
    id: "new_field",
    name: "새 속성",
    kind: "text",
    display: "text",
    values: [],
  });
  const changed = await f.request(`/teams/${f.teamId}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const source = getTask(f.db, f.task.id);
  assert.equal(
    (
      await f.request(`/tasks/${source.id}`, {
        method: "DELETE",
        body: { updatedAt: source.updatedAt },
      })
    ).status,
    200,
  );
  const live = getTask(f.db, source.id);
  const taskId = randomUUID();
  const result = await editReport(f, report, [
    reportCell(source.id, "legacy", "보고본에서만 수정"),
    reportCell(source.id, "amount", 42),
    reportCell(source.id, "deadline", "2026-12-31"),
    reportCell(source.id, "priority", "old"),
    {
      kind: "create",
      at: now(),
      taskId,
      fields: {
        title: "보고용 추가 업무",
        amount: 77,
        owner: f.people.unused.id,
      },
    },
  ]);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.notEqual(result.data.revision, report.revision);
  assert.deepEqual(result.data.settings, report.settings);
  assert.deepEqual(result.data.view, report.view);
  assert.equal(result.data.tasks[0].cells.legacy.value, "보고본에서만 수정");
  assert.equal(result.data.tasks[0].cells.amount.value, 42);
  assert.equal(result.data.tasks[0].cells.priority.value, "old");
  assert.equal(result.data.tasks[1].cells.title.value, "보고용 추가 업무");
  assert.equal(
    result.data.users.find((u) => u.id === f.people.unused.id).name,
    f.people.unused.name,
  );
  assert.deepEqual(getTask(f.db, source.id), live);
  assert.equal(getTask(f.db, taskId), null);
  assert.deepEqual((await f.request(`/reports/${otherId}`)).data, other);
  const deleted = await editReport(f, result.data, [
    { kind: "delete", at: now(), taskIds: [source.id] },
  ]);
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    deleted.data.tasks.map((task) => task.id),
    [taskId],
  );
  await f.restart();
  assert.deepEqual(
    (await f.request(`/reports/${saved.id}`)).data,
    deleted.data,
  );
  assert.deepEqual(getTask(f.db, source.id), live);
});

test("보고본 편집은 현재 팀의 새 속성·잘못된 자료형·다른 업무 ID를 거절하고 전체 저장을 취소한다", async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  const report = (await f.request(`/reports/${saved.data.id}`)).data;
  const task = getTask(f.db, f.task.id);
  for (const invalid of [
    reportCell(task.id, "new_field", "현재에만 있는 속성"),
    reportCell(task.id, "title", 12),
    reportCell(task.id, "status", "존재하지 않는 값"),
    reportCell(task.id, "owner", randomUUID()),
    reportCell(randomUUID(), "title", "다른 업무"),
    { kind: "delete", at: now(), taskIds: [randomUUID()] },
    {
      kind: "create",
      at: now(),
      taskId: randomUUID(),
      sourceId: randomUUID(),
      fields: {},
    },
    {
      kind: "format",
      id: randomUUID(),
      at: now(),
      scopes: [{ rows: [task.id], keys: ["new_field"], style: { bold: true } }],
    },
  ]) {
    const result = await editReport(f, report, [
      reportCell(task.id, "title", "부분 저장되면 안 됨"),
      invalid,
    ]);
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual((await f.request(`/reports/${report.id}`)).data, report);
    assert.deepEqual(getTask(f.db, task.id), task);
  }
});

test("보고본은 팀장만 편집하고 오래된 수정본은 덮어쓰지 않는다", async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  const report = (await f.request(`/reports/${saved.data.id}`)).data;
  const changes = [reportCell(f.task.id, "title", "먼저 저장")];
  f.db
    .prepare("UPDATE users SET system_role='user' WHERE id=?")
    .run(f.people.admin.id);
  for (const role of ["member", "viewer"]) {
    f.db
      .prepare("UPDATE memberships SET role=? WHERE user_id=? AND team_id=?")
      .run(role, f.people.admin.id, f.teamId);
    assert.equal((await editReport(f, report, changes)).status, 403);
  }
  f.db
    .prepare("UPDATE memberships SET role='lead' WHERE user_id=? AND team_id=?")
    .run(f.people.admin.id, f.teamId);
  const first = await editReport(f, report, changes);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const stale = await editReport(f, report, [
    reportCell(f.task.id, "title", "오래된 화면"),
  ]);
  assert.equal(stale.status, 409);
  assert.deepEqual((await f.request(`/reports/${report.id}`)).data, first.data);
  f.db
    .prepare("DELETE FROM memberships WHERE user_id=? AND team_id=?")
    .run(f.people.admin.id, f.teamId);
  assert.equal((await editReport(f, first.data, changes)).status, 403);
});

test("보고본의 행 복제·순서·공통 서식·셀 서식과 과거 팀원은 원본에 쓰지 않고 저장한다", async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  const report = (await f.request(`/reports/${saved.data.id}`)).data;
  const source = getTask(f.db, f.task.id);
  const copyId = randomUUID();
  const result = await editReport(f, report, [
    {
      kind: "create",
      at: now(),
      taskId: copyId,
      sourceId: source.id,
      fields: {},
      insertAt: { taskId: source.id, placement: "after" },
    },
    {
      kind: "format",
      id: randomUUID(),
      at: now(),
      scopes: [
        {
          rows: [copyId],
          keys: null,
          style: { fontSize: 18, color: "#123456" },
        },
      ],
    },
    reportCell(copyId, "title", "복제한 보고용 업무", {
      bold: true,
      color: "#abcdef",
    }),
    reportCell(copyId, "owner", f.people.former.id),
    {
      kind: "reorder",
      at: now(),
      taskIds: [copyId],
      targetId: source.id,
      placement: "before",
    },
  ]);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const copy = result.data.tasks.find((task) => task.id === copyId);
  assert.equal(cell(copy, "title").style.bold, true);
  assert.equal(cell(copy, "title").style.fontSize, 18);
  assert.equal(cell(copy, "title").style.color, "#abcdef");
  assert.equal(cell(copy, weeksForYear(2026)[0].key).style.color, "#123456");
  assert.equal(copy.cells.owner.value, f.people.former.id);
  assert(
    copy.position <
      result.data.tasks.find((task) => task.id === source.id).position,
  );
  assert.deepEqual(getTask(f.db, source.id), source);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
    1,
  );
});

test("보고본 저장 응답 유실 후 같은 요청을 재시도해도 행과 이력이 중복되지 않는다", async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  const report = (await f.request(`/reports/${saved.data.id}`)).data;
  const body = {
    operationId: randomUUID(),
    revision: report.revision,
    operations: [
      {
        kind: "create",
        taskId: randomUUID(),
        at: now(),
        fields: { title: "응답 유실 재시도" },
      },
    ],
  };
  const first = await f.request(`/reports/${report.id}`, {
    method: "PATCH",
    body,
  });
  assert.equal(first.status, 200);
  await f.restart();
  const retry = await f.request(`/reports/${report.id}`, {
    method: "PATCH",
    body,
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, first.data);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM audit WHERE action='report-edit'")
      .get().count,
    1,
  );
  const altered = structuredClone(body);
  altered.operations[0].fields.title = "다른 요청 내용";
  assert.equal(
    (
      await f.request(`/reports/${report.id}`, {
        method: "PATCH",
        body: altered,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await editReport(f, first.data, [
        reportCell(f.task.id, "title", "이후 저장"),
      ])
    ).status,
    200,
  );
  assert.equal(
    (await f.request(`/reports/${report.id}`, { method: "PATCH", body }))
      .status,
    409,
  );
});

test("스냅샷은 참조된 사용자 이름만 압축 저장하고 재시작·원본 변경 뒤에도 내용과 서식을 보존한다", async (t) => {
  const f = await fixture(t);
  const result = await f.save();
  assert.equal(result.status, 201);
  const id = result.data.id;
  const saved = storedReport(f.db, id);
  assert.deepEqual(saved.tasks, [f.task]);
  assert.deepEqual(
    [...saved.users].sort((a, b) => a.name.localeCompare(b.name)),
    ["owner", "reviewer", "former", "filterOnly"]
      .map((key) => f.people[key])
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  assert.equal(saved.view.widths.title, 300);
  assert.equal(saved.view.rowHeights[f.task.id], 70);
  assert.equal(saved.view.propertyFilterModes.reviewers, "exclude");
  // 원본 프로필은 건드리지 않고 보고서에서만 제거한다.
  assert(
    f.db
      .prepare("SELECT avatar_image FROM users WHERE id=?")
      .get(f.people.owner.id).avatar_image,
  );
  f.db
    .prepare("UPDATE cells SET value=? WHERE task_id=? AND key='title'")
    .run(json("이후 업무 변경"), f.task.id);
  f.db.prepare("UPDATE users SET name='이후 이름 변경'").run();
  await f.restart();
  const opened = await f.request(`/reports/${id}`);
  assert.equal(opened.status, 200);
  for (const key of ["tasks", "view", "settings"])
    assert.deepEqual(opened.data[key], saved[key]);
  assert.deepEqual(
    opened.data.users.map(({ id, name }) => ({ id, name })),
    saved.users,
  );
  const exported = await f.request("/export", {
    method: "POST",
    body: { teamId: f.teamId, year: 2026, format: "json", scope: "all" },
  });
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.data.reports[0].data, saved);
});

test("스냅샷 조회는 현재 아바타만 연결하고 저장 당시 이름·본문과 최소 저장 형식을 보존한다", async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  assert.equal(saved.status, 201);
  const path = `/reports/${saved.data.id}`;
  const stored = Buffer.from(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(saved.data.id).data,
  );
  let opened = await f.request(path);
  assert.equal(opened.status, 200);
  for (const person of opened.data.users) {
    assert.equal(person.color, "#123456");
    assert.equal(person.avatarInitials, "AB");
    assert.equal(person.avatarImage, f.image);
    assert.deepEqual(Object.keys(person).sort(), [
      "avatarImage",
      "avatarInitials",
      "color",
      "id",
      "name",
    ]);
  }
  assert.equal(opened.data.users.length, 4);
  assert(!opened.data.users.some((user) => user.id === f.people.unused.id));
  // 원본 업무·팀 소속에서 사라진 계정도 스냅샷에 남은 ID로 찾는다.
  f.db
    .prepare("DELETE FROM memberships WHERE user_id=?")
    .run(f.people.owner.id);
  f.db
    .prepare("DELETE FROM cells WHERE task_id=? AND key='owner'")
    .run(f.task.id);
  f.db
    .prepare(
      "UPDATE users SET name=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
    )
    .run("현재 담당자", "#3377bb", "한글", "", f.people.owner.id);
  opened = await f.request(path);
  assert.equal(opened.status, 200);
  assert.deepEqual(
    opened.data.users.find((user) => user.id === f.people.owner.id),
    {
      ...f.people.owner,
      color: "#3377bb",
      avatarInitials: "한글",
      avatarImage: "",
    },
  );
  assert.equal(opened.data.tasks[0].cells.owner.value, f.people.owner.id);
  f.db
    .prepare("UPDATE users SET avatar_initials='' WHERE id=?")
    .run(f.people.owner.id);
  opened = await f.request(path);
  assert.equal(
    opened.data.users.find((user) => user.id === f.people.owner.id)
      .avatarInitials,
    "현",
  );
  assert.deepEqual(
    Buffer.from(
      f.db.prepare("SELECT data FROM reports WHERE id=?").get(saved.data.id)
        .data,
    ),
    stored,
  );
});

test("빈 스냅샷에는 관계없는 팀원 프로필을 저장하지 않는다", async (t) => {
  const f = await fixture(t);
  const result = await f.request("/reports", {
    method: "POST",
    body: {
      teamId: f.teamId,
      year: 2026,
      name: "빈 보고서",
      referenceDate: "2026-10-12",
      taskIds: [],
      view: defaultView(2026),
    },
  });
  assert.equal(result.status, 201);
  const opened = await f.request(`/reports/${result.data.id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.data.users, []);
});

test("XLSX 보고서 가져오기도 이름만 압축 저장하고 원본 업무를 추가하지 않는다", async (t) => {
  const f = await fixture(t);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("과거 보고서");
  sheet.addRow(["작업", "담당자", "검토자", "2026-10-05"]);
  sheet.addRow([
    "엑셀 보관 업무",
    f.people.owner.name,
    f.people.reviewer.name,
    "당시 일정",
  ]);
  sheet.getCell("D2").font = { bold: true, color: { argb: "FF224466" } };
  const body = new FormData();
  body.set("teamId", f.teamId);
  body.set("year", "2026");
  body.set(
    "file",
    new Blob([await workbook.xlsx.writeBuffer()]),
    "report.xlsx",
  );
  const preview = await f.request("/import/preview", { method: "POST", body });
  assert.equal(preview.status, 200);
  const before = f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const applied = await f.request(`/import/${preview.data.id}/apply`, {
    method: "POST",
    body: {
      sheet: "과거 보고서",
      year: 2026,
      mode: "report",
      referenceDate: "2026-10-05",
      acceptWarnings: true,
      personMap: {
        [f.people.owner.name]: f.people.owner.id,
        [f.people.reviewer.name]: f.people.reviewer.id,
      },
    },
  });
  assert.equal(applied.status, 200, json(applied.data));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, before);
  const { id } = f.db.prepare("SELECT id FROM reports").get();
  const saved = storedReport(f.db, id);
  assert.deepEqual(
    saved.users.sort((a, b) => a.name.localeCompare(b.name)),
    [f.people.owner, f.people.reviewer],
  );
  assert.equal(saved.tasks[0].cells.title.value, "엑셀 보관 업무");
  assert.equal(saved.tasks[0].cells["2026-10-05"].style.bold, true);
  const opened = await f.request(`/reports/${id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.data.tasks, saved.tasks);
});

test("이전 DB 형식은 변환·삭제하지 않고 새 DB 사용을 요구한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-old-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.sqlite");
  const db = openDatabase(path);
  db.exec(
    "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('보존'); PRAGMA user_version=13;",
  );
  db.close();
  assert.throws(() => openDatabase(path), /v13.*지원하지 않습니다/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT value FROM sentinel").get().value, "보존");
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 13);
  check.close();
});
