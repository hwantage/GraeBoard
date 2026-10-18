import { unpack } from "../shared/compact.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { statusSummary } from "../shared/domain.js";
import { applyBorderPreset } from "../shared/borders.js";
import { createApp } from "../server/app.mjs";
import { openDatabase, getTask, passwordHash } from "../server/db.mjs";
import {
  defaultView,
  weeksForYear,
  visibleWeeks,
  filteredTasks,
  normalizeView,
  normalizeSettings,
  DEFAULT_SETTINGS,
  sampleProperties,
  displayValue,
} from "../shared/domain.js";

const dir = mkdtempSync(join(tmpdir(), "weekly-plan-test-"));
let db, server, base, admin, member, viewer, other, teamId, memberId, task;
async function request(
  path,
  { cookie = admin, method = "GET", body, headers = {} } = {},
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "X-Requested-With": "WeeklyPlan",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json")
    ? await r.json().then(unpack)
    : Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    data,
    cookie: r.headers.get("set-cookie")?.split(";")[0],
    headers: r.headers,
  };
}
const post = (path, body, cookie = admin) =>
  request(path, { method: "POST", body, cookie });
const batch = (changes, cookie = admin, operationId = randomUUID()) =>
  post(
    "/cells/batch",
    { operationId, createdAt: new Date().toISOString(), changes },
    cookie,
  );
const change = (key, value, version) => ({
  taskId: task.id,
  key,
  value,
  expectedVersion: version ?? getTask(db, task.id).cells[key]?.version ?? 0,
});

test("팀 기본 셀 높이는 검증하고 이전 설정 저장과 팀 양식 복사에서 보존한다", async () => {
  const tid = (await post("/admin/teams", { name: "기본 셀 높이" })).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.equal(settings.defaultDensity, "compact");
  const invalid = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: { ...settings, defaultDensity: "tiny" },
  });
  assert.equal(invalid.status, 400);
  for (const density of ["comfortable", "compact", "dense"]) {
    const result = await request(`/teams/${tid}/settings`, {
      method: "PATCH",
      body: { ...settings, defaultDensity: density },
    });
    assert.equal(result.status, 200);
    settings = result.data.settings;
    assert.equal(settings.defaultDensity, density);
  }
  const legacy = { ...settings };
  delete legacy.defaultDensity;
  const saved = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: legacy,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings.defaultDensity, "dense");
  const copied = await post("/admin/teams", {
    name: "셀 높이 양식 복사",
    templateTeamId: tid,
  });
  const bootstrap = (await request("/bootstrap")).data;
  assert.equal(
    bootstrap.teams.find((t) => t.id === copied.data.id).settings
      .defaultDensity,
    "dense",
  );
});

test("테두리 프리셋은 선택 영역의 바깥·안쪽 경계를 구분하고 안쪽 선을 한 번만 저장한다", () => {
  const line = { style: "solid", color: "#336699" };
  const old = { style: "double", color: "#9a2233" };
  // 2×2 선택의 왼쪽 위 셀: 위·왼쪽은 바깥, 오른쪽·아래는 안쪽.
  const topLeft = { Top: true, Left: true, Right: false, Bottom: false };
  // 오른쪽 아래 셀: 오른쪽·아래가 바깥, 위·왼쪽은 안쪽.
  const bottomRight = { Top: false, Left: false, Right: true, Bottom: true };
  const filled = {
    borderTop: old,
    borderRight: old,
    borderBottom: old,
    borderLeft: old,
    bold: true,
  };
  const sides = (style) =>
    ["Top", "Right", "Bottom", "Left"].map((side) =>
      style[`border${side}`] ? style[`border${side}`].style : "-",
    );
  const apply = (preset, outer, style = {}) =>
    sides(applyBorderPreset(style, preset, line, outer));
  assert.deepEqual(apply("all", topLeft), ["solid", "solid", "solid", "solid"]);
  // 안쪽 위·왼쪽 선은 이웃의 아래·오른쪽 선이 맡으므로 지운다.
  assert.deepEqual(apply("all", bottomRight, filled), [
    "-",
    "solid",
    "solid",
    "-",
  ]);
  assert.deepEqual(apply("inner", topLeft, filled), [
    "double",
    "solid",
    "solid",
    "double",
  ]);
  assert.deepEqual(apply("horizontal", topLeft), ["-", "-", "solid", "-"]);
  assert.deepEqual(apply("vertical", topLeft), ["-", "solid", "-", "-"]);
  assert.deepEqual(apply("outside", topLeft), ["solid", "-", "-", "solid"]);
  assert.deepEqual(apply("left", topLeft), ["-", "-", "-", "solid"]);
  assert.deepEqual(apply("left", bottomRight), ["-", "-", "-", "-"]);
  assert.deepEqual(apply("right", bottomRight), ["-", "solid", "-", "-"]);
  assert.deepEqual(apply("top", topLeft), ["solid", "-", "-", "-"]);
  assert.deepEqual(apply("bottom", bottomRight), ["-", "-", "solid", "-"]);
  assert.deepEqual(applyBorderPreset(filled, "right", null, bottomRight), {
    ...filled,
    borderRight: null,
  });
  const cleared = applyBorderPreset(filled, "none", line, topLeft);
  assert.deepEqual(cleared, {
    borderTop: null,
    borderRight: null,
    borderBottom: null,
    borderLeft: null,
    bold: true,
  });
});

test("셀 테두리와 주차 머리글 색은 검증·설정 호환·팀 양식·보고본·XLSX 왕복에서 유지된다", async () => {
  const tid = (
    await post("/admin/teams", { name: "경계선 검증", templateTeamId: teamId })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const left = { style: "double", color: "#2255aa" };
  const right = { style: "dashed", color: "#bb3344" };
  const weekHeader = { color: "#ffffff", backgroundColor: "#2255aa" };
  const saved = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: {
      ...settings,
      weekHeader,
      defaultStyle: { ...settings.defaultStyle, borderBottom: right },
    },
  });
  assert.equal(saved.status, 200);
  settings = saved.data.settings;
  const invalid = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: { ...settings, weekHeader: { ...weekHeader, color: "white" } },
  });
  assert.equal(invalid.status, 400);
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "테두리 원본" },
    })
  ).data.task;
  assert.deepEqual(created.defaultStyle.borderBottom, right);
  const changed = await batch([
    {
      taskId: created.id,
      key: "title",
      expectedVersion: created.cells.title.version,
      style: { borderLeft: left, borderTop: right, bold: true },
    },
  ]);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.cells[0].value, "테두리 원본");
  const invalidCells = await batch([
    {
      taskId: created.id,
      key: "title",
      expectedVersion: changed.data.cells[0].version,
      style: { borderLeft: { ...left, color: "red" } },
    },
  ]);
  assert.equal(invalidCells.status, 400);
  assert.deepEqual(getTask(db, created.id).cells.title.style.borderLeft, left);
  // 머리글 색을 생략한 저장은 기존 값을 지우지 않는다.
  const old = structuredClone(settings);
  delete old.weekHeader;
  const partialSave = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: old,
  });
  assert.equal(partialSave.status, 200);
  settings = partialSave.data.settings;
  assert.deepEqual(settings.weekHeader, weekHeader);
  const copied = await post("/admin/teams", {
    name: "경계선 양식",
    templateTeamId: tid,
  });
  assert.deepEqual(
    (await request("/admin/users")).data.teams.find(
      (t) => t.id === copied.data.id,
    ).settings.weekHeader,
    weekHeader,
  );
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "경계선 보고본",
    referenceDate: "2026-03-06",
    taskIds: [created.id],
    view: defaultView(2026),
  });
  assert.equal(report.status, 201, JSON.stringify(report.data));
  const exported = await post("/export", {
    teamId: tid,
    year: 2026,
    scope: "view",
    taskIds: [created.id],
    keys: ["title", "2026-03-02", "2026-03-16"],
    format: "xlsx",
  });
  assert.equal(exported.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.data);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A2").border.left.style, "double");
  assert.equal(sheet.getCell("A2").border.top.color.argb, "FFBB3344");
  for (const address of ["B1", "C1"]) {
    assert.equal(sheet.getCell(address).fill.fgColor.argb, "FF2255AA");
    assert.equal(sheet.getCell(address).font.color.argb, "FFFFFFFF");
    assert.equal(sheet.getCell(address).font.bold, true);
  }
  assert.equal(sheet.getCell("A1").fill.fgColor.argb, "FFEDF6F4");
  assert.equal(sheet.getCell("B2").border.left, undefined);
  sheet.getCell("A2").value = "테두리 재이관";
  const form = new FormData();
  form.set("teamId", tid);
  form.set("year", "2026");
  form.set(
    "file",
    new Blob([await workbook.xlsx.writeBuffer()]),
    "borders.xlsx",
  );
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200);
  const imported = await post(`/import/${preview.data.id}/apply`, {
    sheet: sheet.name,
    year: 2026,
    mode: "tasks",
    referenceDate: "2026-03-06",
    acceptWarnings: true,
    personMap: {},
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const restored = (
    await request(`/tasks?teamId=${tid}&year=2026`)
  ).data.tasks.find((t) => t.cells.title.value === "테두리 재이관");
  assert.deepEqual(restored.cells.title.style.borderLeft, {
    ...left,
    color: left.color.toUpperCase(),
  });
  assert.deepEqual(restored.cells.title.style.borderTop, {
    ...right,
    color: right.color.toUpperCase(),
  });
  const clear = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: { ...settings, weekHeader: {} },
  });
  assert.equal(clear.status, 200);
  assert.deepEqual(clear.data.settings.weekHeader, {});
  const snapshot = (await request(`/reports/${report.data.id}`)).data;
  assert.deepEqual(snapshot.settings.weekHeader, weekHeader);
});

test("주차 기본 경계선은 설정·양식·보고본과 현재 날짜 범위의 XLSX에 적용하고 셀 지정이 우선한다", async () => {
  const tid = (await post("/admin/teams", { name: "주차 기본 경계선" })).data
    .id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "움직이는 경계" },
    })
  ).data.task;
  const weekBorders = {
    left: { style: "double", color: "#2255aa" },
    right: { style: "thick", color: "#bb3344" },
  };
  const save = (body) =>
    request(`/teams/${tid}/settings`, { method: "PATCH", body });
  const inheritedLine = { style: "thick", color: "#607984" };
  const saved = await save({
    ...settings,
    weekBorders,
    defaultStyle: {
      ...settings.defaultStyle,
      borderLeft: inheritedLine,
      borderRight: inheritedLine,
    },
  });
  assert.equal(saved.status, 200);
  settings = saved.data.settings;
  assert.deepEqual(settings.weekBorders, weekBorders);
  assert.deepEqual(getTask(db, created.id).cells, created.cells);
  const inherited = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "상속된 기본 테두리" },
    })
  ).data.task;
  for (const invalid of [
    { left: { style: "invalid", color: "#2255aa" } },
    { right: { style: "solid", color: "red" } },
    { top: weekBorders.left },
  ])
    assert.equal(
      (await save({ ...settings, weekBorders: invalid })).status,
      400,
    );
  const omitted = { ...settings };
  delete omitted.weekBorders;
  const partial = await save(omitted);
  assert.equal(partial.status, 200);
  settings = partial.data.settings;
  assert.deepEqual(settings.weekBorders, weekBorders);
  const copied = await post("/admin/teams", {
    name: "주차 경계 양식",
    templateTeamId: tid,
  });
  assert.deepEqual(
    (await request("/admin/users")).data.teams.find(
      (t) => t.id === copied.data.id,
    ).settings.weekBorders,
    weekBorders,
  );
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "주차 경계 보고본",
    referenceDate: "2026-03-06",
    taskIds: [created.id],
    view: defaultView(2026),
  });
  assert.equal(report.status, 201);
  const exportSheet = async (keys, taskIds = [created.id]) => {
    const response = await post("/export", {
      teamId: tid,
      year: 2026,
      scope: "view",
      taskIds,
      keys,
      format: "xlsx",
    });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.data);
    return workbook.worksheets[0];
  };
  const keys = ["title", "2026-03-02", "2026-03-09", "2026-03-16", "status"];
  let sheet = await exportSheet(keys);
  for (const row of [1, 2]) {
    assert.equal(sheet.getCell(`B${row}`).border.left.style, "double");
    assert.equal(sheet.getCell(`D${row}`).border.right.style, "thick");
    assert.equal(sheet.getCell(`C${row}`).border?.left, undefined);
    assert.equal(sheet.getCell(`C${row}`).border?.right, undefined);
  }
  assert.deepEqual(getTask(db, created.id).cells, created.cells);
  const changed = await batch([
    {
      taskId: created.id,
      key: "2026-03-02",
      expectedVersion: 0,
      style: { borderLeft: { style: "solid", color: "#339966" } },
    },
    {
      taskId: created.id,
      key: "2026-03-16",
      expectedVersion: 0,
      style: { borderRight: null },
    },
    {
      taskId: created.id,
      key: "2026-03-09",
      expectedVersion: 0,
      style: {
        borderLeft: { style: "none", color: "#607984" },
        borderRight: { style: "none", color: "#607984" },
      },
    },
    {
      taskId: created.id,
      key: "title",
      expectedVersion: created.cells.title.version,
      style: { borderRight: null },
    },
    {
      taskId: created.id,
      key: "status",
      expectedVersion: created.cells.status?.version || 0,
      style: { borderLeft: { style: "none", color: "#607984" } },
    },
  ]);
  assert.equal(changed.status, 200);
  sheet = await exportSheet(keys, [created.id, inherited.id]);
  assert.equal(sheet.getCell("B2").border.left.style, "thin");
  assert.equal(sheet.getCell("B2").border.left.color.argb, "FF339966");
  assert.equal(sheet.getCell("D2").border.right.style, "thick");
  assert.equal(sheet.getCell("B3").border.left.style, "double");
  assert.equal(sheet.getCell("D3").border.right.color.argb, "FFBB3344");
  assert.equal(sheet.getCell("A3").border.right, undefined);
  assert.equal(sheet.getCell("E3").border.left, undefined);
  assert.equal(sheet.getCell("C3").border.left.color.argb, "FF607984");
  // One visible week owns both edges; hidden dates keep their own styles.
  sheet = await exportSheet(["title", "2026-03-09", "status"]);
  assert.equal(sheet.getCell("B2").border.left.style, "double");
  assert.equal(sheet.getCell("B2").border.right.style, "thick");
  const neighborLines = await batch(
    [
      ["title", "borderRight"],
      ["status", "borderLeft"],
    ].map(([key, side]) => ({
      taskId: created.id,
      key,
      expectedVersion: getTask(db, created.id).cells[key].version,
      style: { [side]: { style: "dashed", color: "#339966" } },
    })),
  );
  assert.equal(neighborLines.status, 200);
  sheet = await exportSheet(["title", "2026-03-09", "status"]);
  assert.equal(sheet.getCell("A2").border.right.style, "dashed");
  assert.equal(sheet.getCell("C2").border.left.style, "dashed");
  assert.equal(sheet.getCell("B2").border?.left, undefined);
  assert.equal(sheet.getCell("B2").border?.right, undefined);
  sheet = await exportSheet(["title", "status"]);
  assert.equal(sheet.getCell("A2").border?.left, undefined);
  assert.equal(sheet.getCell("B2").border?.right, undefined);
  const cleared = await save({ ...settings, weekBorders: {} });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.settings.weekBorders, {});
  assert.deepEqual(
    (await request(`/reports/${report.data.id}`)).data.settings.weekBorders,
    weekBorders,
  );
  sheet = await exportSheet(["title", "2026-03-09", "status"]);
  assert.equal(sheet.getCell("B2").border?.left, undefined);
  assert.equal(sheet.getCell("B2").border?.right, undefined);
});

test("기본 테두리 해제는 저장·JSON·XLSX에서 상속된 선을 다시 적용하지 않는다", async () => {
  const tid = (await post("/admin/teams", { name: "기본 테두리 해제" })).data
    .id;
  const settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const line = { style: "thick", color: "#dd2244" };
  const saved = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: {
      ...settings,
      defaultStyle: {
        ...settings.defaultStyle,
        borderTop: line,
        borderRight: line,
        borderBottom: line,
        borderLeft: line,
      },
    },
  });
  assert.equal(saved.status, 200);
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "테두리 해제" },
    })
  ).data.task;
  const clearedStyle = {
    borderTop: null,
    borderRight: null,
    borderBottom: null,
    borderLeft: null,
    bold: true,
  };
  const changed = await batch([
    {
      taskId: created.id,
      key: "title",
      expectedVersion: created.cells.title.version,
      style: clearedStyle,
    },
  ]);
  assert.equal(changed.status, 200);
  const stored = (await request(`/tasks?teamId=${tid}&year=2026`)).data
    .tasks[0];
  assert.deepEqual(stored.cells.title.style, clearedStyle);
  assert.deepEqual(stored.defaultStyle.borderTop, line);
  const options = {
    teamId: tid,
    year: 2026,
    scope: "view",
    taskIds: [created.id],
    keys: ["title", "2026-03-02"],
  };
  const exported = await post("/export", { ...options, format: "json" });
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.data.tasks[0].cells.title.style, clearedStyle);
  const xlsx = await post("/export", { ...options, format: "xlsx" });
  assert.equal(xlsx.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx.data);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A2").value, "테두리 해제");
  assert.equal(sheet.getCell("A2").font.bold, true);
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.equal(sheet.getCell("A2").border?.[side], undefined);
    assert.equal(sheet.getCell("B2").border[side].style, "thick");
  }
});

test("2,000셀을 넘는 전체 서식은 권한·충돌·재시도를 검사하고 값을 보존한다", async () => {
  const adminId = (await request("/bootstrap")).data.user.id;
  const target = (
    await post("/admin/teams", {
      name: "전체 서식 검증",
      members: [
        { userId: adminId, role: "lead" },
        { userId: memberId, role: "member" },
      ],
    })
  ).data.id;
  const tasks = [];
  for (let i = 0; i < 40; i++)
    tasks.push(
      (
        await post("/tasks", {
          teamId: target,
          year: 2026,
          fields: { title: `전체 서식 ${i}`, owner: memberId },
        })
      ).data.task,
    );
  const keys = ["owner", ...weeksForYear(2026).map((w) => w.key)];
  const changes = tasks.flatMap((t) =>
    keys.map((key) => ({
      taskId: t.id,
      key,
      expectedVersion: t.cells[key]?.version || 0,
      style: { fontSize: 14, backgroundColor: "#d1eee6" },
    })),
  );
  assert.ok(changes.length > 2000);
  assert.equal((await batch(changes, viewer)).status, 403);
  assert.equal(
    (await batch(changes.map((c) => ({ ...c, value: "" })))).status,
    400,
  );
  const conflict = changes.map((c, i) =>
    i === changes.length - 1
      ? { ...c, expectedVersion: c.expectedVersion + 1 }
      : c,
  );
  assert.equal((await batch(conflict, member)).status, 409);
  assert.deepEqual(getTask(db, tasks[0].id).cells, tasks[0].cells);
  const operationId = randomUUID();
  const result = await batch(changes, member, operationId);
  assert.equal(result.status, 200);
  assert.equal(result.data.cells.length, changes.length);
  assert.deepEqual(
    (await batch(changes, member, operationId)).data,
    result.data,
  );
  for (const t of tasks) {
    const saved = getTask(db, t.id);
    assert.equal(saved.cells.owner.value, memberId);
    assert.equal(saved.cells.title.value, t.cells.title.value);
    for (const key of keys) {
      assert.equal(saved.cells[key].style.fontSize, 14);
      assert.equal(saved.cells[key].style.backgroundColor, "#d1eee6");
      assert.equal(saved.cells[key].value, key === "owner" ? memberId : "");
    }
  }
  // A member can undo formatting on assignment cells without changing owners.
  const undone = await batch(
    result.data.before.map((c) => ({
      taskId: c.taskId,
      key: c.key,
      style: c.style,
      expectedVersion: c.version + 1,
    })),
    member,
  );
  assert.equal(undone.status, 200);
  assert.equal(getTask(db, tasks[0].id).cells.owner.value, memberId);
  assert.deepEqual(getTask(db, tasks[0].id).cells.owner.style, {
    ...tasks[0].cells.owner.style,
  });
});

test("팀원 아바타의 글자·배경색·이미지를 저장하고 잘못된 입력과 비관리자 수정을 거절한다", async () => {
  const body = {
    username: `avatar-${randomUUID()}@example.com`,
    name: "아바타 검증",
    password: "profile-test-password",
    active: true,
    memberships: [{ teamId, role: "member" }],
  };
  const created = await post("/admin/users", body);
  assert.equal(created.status, 201);
  const uid = created.data.user.id;
  assert.equal(created.data.user.avatarInitials, "");
  assert.equal(created.data.user.avatarImage, "");
  const patch = (extra, cookie = admin) =>
    request(`/admin/users/${uid}`, {
      method: "PATCH",
      cookie,
      body: { ...body, ...extra },
    });
  assert.equal(
    (await patch({ avatarInitials: "HK", color: "#cccccc" })).status,
    200,
  );
  const profile = async () =>
    (await request("/bootstrap")).data.users.find((u) => u.id === uid);
  assert.equal((await profile()).avatarInitials, "HK");
  assert.equal((await profile()).color, "#cccccc");
  // Omitted optional fields preserve the profile for older account clients.
  assert.equal((await patch({ name: "새 이름" })).status, 200);
  assert.equal((await profile()).avatarInitials, "HK");
  for (const initials of ["ABC", "A1", "a12", "0", "12", "123", "김민"]) {
    assert.equal((await patch({ avatarInitials: initials })).status, 200);
    assert.equal((await profile()).avatarInitials, initials);
  }
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==";
  assert.equal(
    (await patch({ avatarImage: image, avatarInitials: "" })).status,
    200,
  );
  assert.equal((await profile()).avatarImage, image);
  for (const invalid of [
    { avatarInitials: "ABCD" },
    { avatarInitials: "가나다" },
    { avatarInitials: "A김" },
    { avatarInitials: "1234" },
    { avatarInitials: "A!" },
    { avatarInitials: "김1" },
    { color: "red" },
    { avatarImage: "https://example.com/avatar.png" },
    { avatarImage: "data:image/svg+xml;base64,PHN2Zz4=" },
    { avatarImage: "data:image/png;base64,bm90LXBuZw==" },
  ])
    assert.equal((await patch(invalid)).status, 400);
  assert.equal((await patch({ color: "#000000" }, member)).status, 403);
  assert.equal(
    (await patch({ avatarImage: "", avatarInitials: "김" })).status,
    200,
  );
  assert.equal((await profile()).avatarInitials, "김");
  assert.equal((await profile()).avatarImage, "");
});

test("본인 프로필은 직접 수정하고 계정 권한·다른 사용자·로그인 정보는 변경할 수 없다", async () => {
  const password = "own-profile-test-password";
  const username = `self-profile-${randomUUID()}@example.com`;
  const created = await post("/admin/users", {
    username,
    password,
    name: "개인 프로필",
    active: true,
    memberships: [{ teamId, role: "viewer" }],
  });
  assert.equal(created.status, 201);
  const uid = created.data.user.id;
  const login = await post("/auth/login", { username, password });
  const ownCookie = login.cookie;
  const patch = (body, cookie = ownCookie) =>
    request("/auth/profile", { method: "PATCH", body, cookie });
  assert.equal((await patch({ avatarInitials: "MY" }, "")).status, 401);
  const saved = await patch({
    name: "내 프로필",
    color: "#3377bb",
    avatarInitials: "MY",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.id, uid);
  assert.equal(saved.data.user.name, "내 프로필");
  assert.equal(saved.data.user.avatarInitials, "MY");
  assert.equal(saved.data.user.color, "#3377bb");
  assert.equal(saved.data.user.systemRole, "user");
  assert.equal(saved.data.user.teamRoles[teamId], "viewer");
  assert.equal("password" in saved.data.user, false);
  const otherBefore = (await request("/bootstrap")).data.user;
  for (const body of [
    {},
    { name: "" },
    { avatarInitials: "ABCD" },
    { color: "red" },
    { avatarImage: "data:image/svg+xml;base64,PHN2Zz4=" },
    { id: otherBefore.id, name: "다른 사용자 수정" },
    { systemRole: "admin" },
    { memberships: [{ teamId, role: "lead" }] },
    { active: false },
    { username: "changed@example.com" },
    { password: "changed-password" },
  ])
    assert.equal((await patch(body)).status, 400);
  assert.deepEqual((await request("/bootstrap")).data.user, otherBefore);
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==";
  assert.equal(
    (await patch({ avatarImage: image, avatarInitials: "" })).status,
    200,
  );
  const stored = (await request("/bootstrap", { cookie: ownCookie })).data.user;
  assert.equal(stored.avatarImage, image);
  assert.equal(stored.name, "내 프로필");
  assert.equal(stored.color, "#3377bb");
  assert.equal(stored.avatarInitials, "");
  assert.equal(stored.username, username);
  assert.equal(stored.systemRole, "user");
  assert.deepEqual(stored.teamRoles, { [teamId]: "viewer" });
  assert.equal(
    (await patch({ avatarImage: "", avatarInitials: "나" })).status,
    200,
  );
  assert.equal((await post("/auth/login", { username, password })).status, 200);
});

test("팀에서 제외된 담당자의 최신 프로필을 표시하고 기존 값 보존만 허용한다", async () => {
  const avatarImage =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==";
  const adminId = (await request("/bootstrap")).data.user.id;
  const target = (
    await post("/admin/teams", {
      name: "이전 팀원 표시 검증",
      templateTeamId: teamId,
      members: [{ userId: adminId, role: "lead" }],
    })
  ).data.id;
  const account = {
    username: `former-${randomUUID()}@example.com`,
    name: "이전 이름",
    password: "profile-test-password",
    active: true,
    memberships: [{ teamId: target, role: "member" }],
  };
  const formerId = (await post("/admin/users", account)).data.user.id;
  const unrelatedId = (
    await post("/admin/users", {
      ...account,
      username: `unrelated-${randomUUID()}@example.com`,
      memberships: [],
    })
  ).data.user.id;
  const assigned = (
    await post("/tasks", {
      teamId: target,
      year: 2026,
      fields: {
        title: "기존 담당 업무",
        description: unrelatedId,
        owner: formerId,
        supporters: [formerId],
      },
    })
  ).data.task;
  assert.equal(
    (
      await request(`/admin/users/${formerId}`, {
        method: "PATCH",
        body: {
          ...account,
          name: "최신 이름",
          active: false,
          memberships: [],
          avatarInitials: "최",
          avatarImage,
          color: "#888888",
        },
      })
    ).status,
    200,
  );
  const boot = (await request("/bootstrap")).data;
  const former = boot.users.find((u) => u.id === formerId);
  assert.equal(former.name, "최신 이름");
  assert.equal(former.avatarInitials, "최");
  assert.equal(former.avatarImage, avatarImage);
  assert.equal(boot.users.filter((u) => u.id === formerId).length, 1);
  assert.equal(former.color, "#888888");
  assert.deepEqual(former.teamIds, []);
  assert(
    !boot.users.some((u) => u.id === unrelatedId),
    "관련 없는 계정을 표시용 목록에 포함하지 않는다",
  );
  const modify = (key, value, style) =>
    batch([
      {
        taskId: assigned.id,
        key,
        expectedVersion: getTask(db, assigned.id).cells[key]?.version || 0,
        ...(value !== undefined ? { value } : {}),
        ...(style ? { style } : {}),
      },
    ]);
  assert.equal(
    (await modify("owner", undefined, { fontSize: 14 })).status,
    200,
  );
  assert.equal((await modify("owner", formerId, { fontSize: 12 })).status, 200);
  assert.equal((await modify("supporters", [formerId, adminId])).status, 200);
  const exported = await post("/export", {
    teamId: target,
    year: 2026,
    format: "json",
    scope: "all",
  });
  assert.equal(
    exported.data.users.find((u) => u.id === formerId).name,
    "최신 이름",
  );
  assert.equal((await modify("owner", adminId)).status, 200);
  assert.equal((await modify("owner", formerId)).status, 400);
  assert.equal((await modify("supporters", [adminId])).status, 200);
  assert.equal((await modify("supporters", [formerId])).status, 400);
  assert.equal(
    (
      await post("/tasks", {
        teamId: target,
        year: 2026,
        fields: { title: "새 배정 금지", owner: formerId },
      })
    ).status,
    400,
  );
});

test("원본 행 범위·열 연결별 이관을 구별하고 미지정 담당자를 보존한다", async () => {
  const target = (
    await post("/admin/teams", {
      name: "범위 이관 검증",
      templateTeamId: teamId,
    })
  ).data.id;
  const wb = new ExcelJS.Workbook(),
    ws = wb.addWorksheet("일정");
  ws.getRow(1).values = ["", "", "진척도"];
  ws.getRow(3).values = ["작업"];
  ws.getRow(5).values = ["주간 업무", "기획", "75%"];
  ws.getRow(8).values = ["별도 참고 표"];
  const file = await wb.xlsx.writeBuffer();
  const preview = async (options) => {
    const form = new FormData();
    form.set("teamId", target);
    form.set("year", "2026");
    form.set("file", new Blob([file]), "range.xlsx");
    form.set("sheetOptions", JSON.stringify(options));
    return request("/import/preview", { method: "POST", body: form });
  };
  const options = {
    일정: {
      headerRow: 3,
      startRow: 5,
      endRow: 6,
      columns: { type: 2, title: 1 },
    },
  };
  const first = await preview(options),
    repeated = await preview({
      일정: { ...options.일정, columns: { title: 1, type: 2 } },
    });
  assert.equal(first.status, 200);
  assert.equal(first.data.id, repeated.data.id);
  assert.equal(first.data.sheets[0].count, 1);
  assert.ok(first.data.sheets[0].visibleFields.includes("progress"));
  const wider = await preview({ 일정: { ...options.일정, endRow: 8 } });
  assert.equal(wider.data.sheets[0].count, 2);
  assert.notEqual(wider.data.id, first.data.id);
  assert.equal(
    (await preview({ 일정: { columns: { unknown: 2 } } })).status,
    400,
  );
  const body = {
    sheet: "일정",
    year: 2026,
    personMap: {},
    mode: "tasks",
    referenceDate: "2026-10-09",
    acceptWarnings: true,
  };
  assert.equal(
    (await post(`/import/${first.data.id}/apply`, body)).status,
    200,
  );
  assert.equal(
    (await post(`/import/${first.data.id}/apply`, body)).data.repeated,
    true,
  );
  const tasks = (await request(`/tasks?teamId=${target}&year=2026`)).data.tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].cells.title.value, "주간 업무");
  assert.equal(tasks[0].cells.progress.value, "75%");
  assert.equal(tasks[0].cells.type.value, "type-plan");
  assert.equal(tasks[0].cells.owner, undefined);
});

test("팀 삭제는 확인·관리자 권한을 검사하고 모든 연도의 데이터와 재시도 기록을 함께 삭제한다", async () => {
  const adminId = (await request("/bootstrap")).data.user.id;
  const tid = (
    await post("/admin/teams", {
      name: "삭제할 팀",
      templateTeamId: teamId,
      members: [
        { userId: adminId, role: "lead" },
        { userId: memberId, role: "member" },
      ],
    })
  ).data.id;
  const keepId = (
    await post("/admin/teams", { name: "보존할 팀", templateTeamId: teamId })
  ).data.id;
  const keep = (
    await post("/tasks", {
      teamId: keepId,
      year: 2026,
      fields: { title: "다른 팀 업무" },
    })
  ).data.task;
  const first = (
    await post("/tasks", {
      teamId: tid,
      year: 2025,
      fields: { title: "지난해 삭제 업무" },
    })
  ).data.task;
  const second = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "올해 삭제 업무" },
    })
  ).data.task;
  const opId = randomUUID();
  assert.equal(
    (
      await batch(
        [
          {
            taskId: first.id,
            key: "2025-10-06",
            value: "삭제할 일정",
            style: { fontSize: 18 },
            expectedVersion: 0,
          },
          {
            taskId: keep.id,
            key: "title",
            value: "보존된 다른 팀 업무",
            expectedVersion: 1,
          },
        ],
        admin,
        opId,
      )
    ).status,
    200,
  );
  // The response must be purged even if an old audit entry was removed.
  db.prepare("DELETE FROM audit WHERE team_id=? AND action='cells'").run(tid);
  const keepOpId = randomUUID();
  await batch(
    [
      {
        taskId: keep.id,
        key: "title",
        style: { bold: true },
        expectedVersion: 2,
      },
    ],
    admin,
    keepOpId,
  );
  await request(`/tasks/${first.id}`, {
    method: "DELETE",
    body: { updatedAt: getTask(db, first.id).updatedAt },
  });
  for (const year of [2025, 2026]) {
    assert.equal(
      (
        await request("/views", {
          method: "PUT",
          body: { teamId: tid, name: "__current", data: defaultView(year) },
        })
      ).status,
      200,
    );
  }
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "삭제할 보고본",
    referenceDate: "2026-10-09",
    taskIds: [second.id],
    view: defaultView(2026),
  });
  assert.equal(report.status, 201);
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet("팀 삭제 이관");
  sheet.addRow(["작업", "2026-10-09"]);
  sheet.addRow(["가져온 삭제 업무", "이관 일정"]);
  const form = new FormData();
  form.set("teamId", tid);
  form.set("year", "2026");
  form.set(
    "file",
    new Blob([await workbook.xlsx.writeBuffer()]),
    "delete-test.xlsx",
  );
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const priorOperations = new Set(
    db
      .prepare("SELECT id FROM operations")
      .all()
      .map((r) => r.id),
  );
  for (const mode of ["tasks", "report"])
    assert.equal(
      (
        await post(`/import/${preview.data.id}/apply`, {
          sheet: "팀 삭제 이관",
          year: 2026,
          mode,
          referenceDate: "2026-10-09",
          acceptWarnings: true,
          personMap: {},
        })
      ).status,
      200,
    );
  const importOperations = db
    .prepare("SELECT id FROM operations")
    .all()
    .map((r) => r.id)
    .filter((id) => !priorOperations.has(id));
  assert.equal(importOperations.length, 2);
  const keepBefore = getTask(db, keep.id),
    usersBefore = db.prepare("SELECT * FROM users ORDER BY id").all();
  const remove = (body = { confirmed: true }, cookie = admin) =>
    request(`/admin/teams/${tid}`, { method: "DELETE", body, cookie });
  for (const body of [{}, { confirmed: false }])
    assert.equal((await remove(body)).status, 400);
  for (const cookie of [member, viewer, other])
    assert.equal((await remove({ confirmed: true }, cookie)).status, 403);
  assert(getTask(db, first.id));
  // Prime normal and trash caches before the permanent deletion.
  await request(`/tasks?teamId=${tid}&year=2026`);
  await request(`/tasks?teamId=${tid}&year=2025&deleted=true`);
  const removed = await remove();
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(getTask(db, first.id), null);
  assert.equal(getTask(db, second.id), null);
  for (const table of [
    "tasks",
    "views",
    "filter_states",
    "saved_filters",
    "reports",
    "imports",
    "audit",
    "memberships",
    "team_revisions",
  ])
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE team_id=?`).get(tid)
        .n,
      0,
      table,
    );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM cells WHERE task_id IN (?,?)")
      .get(first.id, second.id).n,
    0,
  );
  for (const id of [opId, ...importOperations])
    assert.equal(
      db.prepare("SELECT id FROM operations WHERE id=?").get(id),
      undefined,
    );
  assert(db.prepare("SELECT id FROM operations WHERE id=?").get(keepOpId));
  assert.deepEqual(getTask(db, keep.id), keepBefore);
  assert.deepEqual(
    db.prepare("SELECT * FROM users ORDER BY id").all(),
    usersBefore,
  );
  assert.equal((await request(`/reports/${report.data.id}`)).status, 404);
  assert.equal((await request(`/tasks?teamId=${tid}&year=2026`)).status, 404);
  assert.equal((await remove()).status, 404);
  assert(!(await request("/bootstrap")).data.teams.some((t) => t.id === tid));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("팀 삭제는 실패 시 변경을 모두 되돌리고, 소속 팀이 없어지는 시스템 관리자도 막지 않는다", async () => {
  const tid = (await post("/admin/teams", { name: "삭제 복구 팀" })).data.id;
  const account = {
    username: `guard-${randomUUID().slice(0, 8)}@example.com`,
    password: "guard-test-password",
  };
  const soleAdmin = (
    await post("/admin/users", {
      ...account,
      name: "한 팀 소속 관리자",
      systemRole: "admin",
      active: true,
      memberships: [{ teamId: tid, role: "lead" }],
    })
  ).data.user;
  const row = (await post("/tasks", { teamId: tid, year: 2026 })).data.task;
  // 소속 없는 시스템 관리자가 만든 업무는 담당자를 비워 둔다.
  assert.equal(row.cells.owner?.value ?? "", "");
  const body = { confirmed: true };
  db.exec(
    "CREATE TEMP TRIGGER fail_team_delete BEFORE DELETE ON teams BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
  );
  try {
    assert.equal(
      (await request(`/admin/teams/${tid}`, { method: "DELETE", body })).status,
      500,
    );
    assert.deepEqual(getTask(db, row.id), row);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM memberships WHERE team_id=?")
        .get(tid).n,
      1,
    );
  } finally {
    db.exec("DROP TRIGGER fail_team_delete");
  }
  assert.equal(
    (await request(`/admin/teams/${tid}`, { method: "DELETE", body })).status,
    200,
  );
  // 팀이 모두 없어져도 시스템 관리자는 로그인해 모든 팀에 들어갈 수 있다.
  const token = (await post("/auth/login", account, "")).cookie;
  const boot = (await request("/bootstrap", { cookie: token })).data;
  assert.deepEqual(boot.user.teamIds, []);
  assert(boot.teams.some((t) => t.id === teamId));
  assert.equal(
    (
      await request(`/admin/users/${soleAdmin.id}`, {
        method: "PATCH",
        body: { name: soleAdmin.name, systemRole: "user", active: false },
      })
    ).status,
    200,
  );
});

test("새 팀은 필수 속성 세 개·상태 다섯 개와 9pt 기본값을 갖고 필수 속성 삭제를 막는다", async () => {
  const tid = (await post("/admin/teams", { name: "세 가지 기본 속성" })).data
    .id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.deepEqual(
    settings.properties.map((p) => [p.id, p.name, p.kind]),
    [
      ["title", "작업", "text"],
      ["owner", "팀원", "member"],
      ["status", "상태", "option"],
    ],
  );
  const options = settings.properties[2].values;
  assert.deepEqual(
    options.map((v) => v.label),
    ["예정", "검토 중", "진행 중", "완료", "보류"],
  );
  assert.equal(new Set(options.map((v) => v.dotColor)).size, 5);
  assert.equal(settings.defaultStyle.fontSize, 9);
  const view = normalizeView(defaultView(2026), settings);
  assert.deepEqual(view.visibleFields, ["title", "owner", "status"]);
  assert.equal(view.frozenColumns, 0);
  const created = (await post("/tasks", { teamId: tid, year: 2026 })).data.task;
  assert.equal(created.cells.status?.value ?? "", "");
  assert.equal(created.cells.owner?.value ?? "", "");
  assert.equal(created.defaultStyle.fontSize, 9);
  const save = (body) =>
    request(`/teams/${tid}/settings`, { method: "PATCH", body });
  for (const key of ["title", "owner", "status"]) {
    for (const corrupt of [
      (s) => (s.properties = s.properties.filter((p) => p.id !== key)),
      (s) => (s.properties.find((p) => p.id === key).archived = true),
      (s) => (s.properties.find((p) => p.id === key).kind = "number"),
    ]) {
      const invalid = structuredClone(settings);
      corrupt(invalid);
      assert.equal((await save(invalid)).status, 400);
    }
  }
  const invalid = structuredClone(settings);
  invalid.properties[1].multiple = true;
  assert.equal((await save(invalid)).status, 400);
  invalid.properties[1].multiple = false;
  invalid.properties[2].values = [];
  assert.equal((await save(invalid)).status, 400);
  assert.equal(getTask(db, created.id).cells.status?.value ?? "", "");
  await batch([
    {
      taskId: created.id,
      key: "status",
      value: "status-completed",
      expectedVersion: created.cells.status?.version ?? 0,
    },
  ]);
  settings.properties[2].values.find((v) => v.label === "완료").label = "종료";
  settings.properties[1].name = "담당 팀원";
  settings.properties[0].name = "업무 제목";
  const saved = await save(settings);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  settings = saved.data.settings;
  // 선택값 이름을 바꿔도 셀에 저장된 옵션 ID는 그대로다.
  const task = getTask(db, created.id);
  assert.equal(task.cells.status.value, "status-completed");
  assert.equal(
    statusSummary([task], settings).find((v) => v.label === "종료").count,
    1,
  );
  assert.equal(
    statusSummary([task], settings).find((v) => v.label === "예정").count,
    0,
  );
});

test("팀 양식 복사는 속성·순서·기본 서식·테마만 독립적으로 복제한다", async () => {
  const sourceId = (
    await post("/admin/teams", {
      name: "원본 양식",
      members: [{ userId: memberId, role: "member" }],
    })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === sourceId,
  ).settings;
  settings.theme = "lavender";
  settings.defaultStyle = {
    fontFamily: "Noto Serif KR",
    fontSize: 16,
    textMode: "wrap",
    verticalAlign: "middle",
  };
  settings.properties.unshift({
    id: `prop_${randomUUID()}`,
    name: "프로젝트",
    kind: "option",
    display: "square",
    visible: false,
    values: [
      {
        id: "a",
        label: "A",
        backgroundColor: "#efeaff",
        dotColor: "#a080c0",
        emoji: "📌",
      },
    ],
  });
  const saved = await request(`/teams/${sourceId}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  settings = saved.data.settings;
  await post("/tasks", {
    teamId: sourceId,
    year: 2026,
    fields: { title: "복사하면 안 되는 업무", owner: memberId },
  });
  const result = await post("/admin/teams", {
    name: "복사한 양식",
    templateTeamId: sourceId,
  });
  assert.equal(result.status, 201);
  const copiedId = result.data.id;
  const data = (await request("/admin/users")).data;
  const copied = data.teams.find((t) => t.id === copiedId);
  assert.deepEqual(copied.settings.properties, settings.properties);
  assert.deepEqual(copied.settings.defaultStyle, settings.defaultStyle);
  assert.equal(copied.settings.theme, "lavender");
  assert.equal(copied.settings.revision, 0);
  assert.equal(
    (await request(`/tasks?teamId=${copiedId}&year=2026`)).data.tasks.length,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT 1 FROM memberships WHERE team_id=? AND user_id=?")
      .get(copiedId, memberId),
    undefined,
  );
  const task = (await post("/tasks", { teamId: copiedId, year: 2026 })).data
    .task;
  assert.equal(task.defaultStyle.fontSize, 16);
  copied.settings.properties[0].name = "복사팀 프로젝트";
  assert.equal(
    (
      await request(`/teams/${copiedId}/settings`, {
        method: "PATCH",
        body: copied.settings,
      })
    ).status,
    200,
  );
  const original = (await request("/admin/users")).data.teams.find(
    (t) => t.id === sourceId,
  );
  assert.equal(original.settings.properties[0].name, "프로젝트");
  assert.equal(
    (
      await post("/admin/teams", {
        name: "없는 양식",
        templateTeamId: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        "/admin/teams",
        { name: "권한 없음", templateTeamId: sourceId },
        viewer,
      )
    ).status,
    403,
  );
});

test("동일 밀리초에 변경해도 업무 버전이 달라져 오래된 삭제를 차단한다", async (t) => {
  const current = getTask(db, task.id),
    time = Date.parse(current.updatedAt) + 1000;
  t.mock.timers.enable({ apis: ["Date"], now: time });
  try {
    const first = await request(`/tasks/${task.id}`, {
      method: "PATCH",
      body: { updatedAt: current.updatedAt, position: 2000 },
    });
    assert.equal(first.status, 200);
    const second = await request(`/tasks/${task.id}`, {
      method: "PATCH",
      body: { updatedAt: first.data.task.updatedAt, position: 3000 },
    });
    assert.equal(second.status, 200);
    assert.notEqual(first.data.task.updatedAt, second.data.task.updatedAt);
    assert.equal(
      (
        await request(`/tasks/${task.id}`, {
          method: "DELETE",
          body: { updatedAt: first.data.task.updatedAt },
        })
      ).status,
      409,
    );
  } finally {
    t.mock.timers.reset();
  }
});
before(async () => {
  db = openDatabase(join(dir, "db.sqlite"));
  server = createApp({
    db,
    rateLimits: false,
    staticDir: join(dir, "absent"),
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await post(
    "/auth/setup",
    {
      username: "administrator@example.com",
      password: "test-password-123",
      name: "관리자",
      teamName: "기획팀",
    },
    "",
  );
  assert.equal(setup.status, 201);
  admin = setup.cookie;
  teamId = setup.data.user.teamIds[0];
  // 회귀 픽스처 팀은 예시 양식(분류·유형·설명·지원자·진척률·목표일·점수 열)을 쓴다.
  db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
    JSON.stringify({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
    teamId,
  );
  for (const [username, role] of [
    ["member", "member"],
    ["viewer", "viewer"],
  ]) {
    const u = await post("/admin/users", {
      username: `${username}@example.com`,
      password: "test-password-123",
      name: username,
      memberships: [{ teamId, role }],
    });
    assert.equal(u.status, 201);
    const auth = await post(
      "/auth/login",
      { username: `${username}@example.com`, password: "test-password-123" },
      "",
    );
    if (username === "member") {
      member = auth.cookie;
      memberId = u.data.user.id;
    } else viewer = auth.cookie;
  }
  const second = await post("/admin/teams", { name: "별도 팀" });
  const u = await post("/admin/users", {
    username: "other@example.com",
    password: "test-password-123",
    name: "별도 사용자",
    memberships: [{ teamId: second.data.id, role: "lead" }],
  });
  assert.equal(u.status, 201);
  other = (
    await post(
      "/auth/login",
      { username: "other@example.com", password: "test-password-123" },
      "",
    )
  ).cookie;
  task = (
    await post("/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: "권한 검증 업무",
        owner: memberId,
        status: "status-progress",
      },
    })
  ).data.task;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("첫 설정 재실행, 인증 누락 및 외부 출처를 거절한다", async () => {
  assert.equal(
    (
      await post("/auth/setup", {
        username: "new@example.com",
        password: "test-password-123",
        name: "새 사용자",
        teamName: "새 팀",
      })
    ).status,
    409,
  );
  assert.equal((await request("/bootstrap", { cookie: "" })).status, 401);
  assert.equal(
    (
      await request("/tasks", {
        method: "POST",
        body: { teamId, year: 2026 },
        headers: { Origin: "https://invalid.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/tasks", {
        method: "POST",
        body: { teamId, year: 2026 },
        headers: { "X-Requested-With": "" },
      })
    ).status,
    403,
  );
});
test("서버가 다른 팀과 열람자 권한을 차단한다", async () => {
  assert.equal(
    (await request(`/tasks?teamId=${teamId}&year=2026`, { cookie: other }))
      .status,
    403,
  );
  assert.equal(
    (await batch([change("title", "허용 안 됨")], viewer)).status,
    403,
  );
  assert.equal((await request("/admin/users", { cookie: member })).status, 403);
  assert.equal(
    (await batch([change("title", "허용 안 됨")], other)).status,
    403,
  );
});
test("팀원은 담당 업무를 편집하고 담당자 변경은 관리자에게 제한한다", async () => {
  assert.equal(
    (await batch([change("description", "팀원이 입력")], member)).status,
    200,
  );
  assert.equal((await batch([change("owner", "")], member)).status, 403);
  const own = (
    await post("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "관리자 소유" },
    })
  ).data.task;
  assert.equal(
    (
      await batch(
        [
          {
            taskId: own.id,
            key: "title",
            value: "타인 수정",
            expectedVersion: 1,
          },
        ],
        member,
      )
    ).status,
    403,
  );
});
test("신규 업무는 팀원·상태를 비우며 작성자는 미지정 업무를 편집할 수 있다", async () => {
  const adminId = (await request("/bootstrap")).data.user.id;
  for (const cookie of [admin, member]) {
    const result = await post("/tasks", { teamId, year: 2026 }, cookie);
    assert.equal(result.status, 201);
    const created = result.data.task;
    assert.equal(created.cells.owner?.value ?? "", "");
    assert.equal(created.cells.status?.value ?? "", "");
    const changed = await batch(
      [
        {
          taskId: created.id,
          key: "title",
          value: "미지정 업무 편집",
          expectedVersion: created.cells.title.version,
        },
        {
          taskId: created.id,
          key: "status",
          value: "status-completed",
          expectedVersion: created.cells.status?.version ?? 0,
        },
      ],
      cookie,
    );
    assert.equal(changed.status, 200);
    const stored = getTask(db, created.id);
    assert.equal(stored.cells.title.value, "미지정 업무 편집");
    assert.equal(stored.cells.owner?.value ?? "", "");
    assert.equal(stored.cells.status.value, "status-completed");
  }
  assert.equal(
    (await post("/tasks", { teamId, year: 2026 }, viewer)).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/tasks",
        { teamId, year: 2026, fields: { owner: adminId } },
        member,
      )
    ).status,
    403,
  );
  const assigned = await post("/tasks", {
    teamId,
    year: 2026,
    fields: { owner: memberId, status: "status-completed" },
  });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.data.task.cells.owner.value, memberId);
  assert.equal(assigned.data.task.cells.status.value, "status-completed");
});
test("충돌이 포함된 범위 수정은 모든 셀을 원상태로 유지한다", async () => {
  const before = getTask(db, task.id);
  const r = await batch([
    change("title", "반영되면 안 됨"),
    change("description", "오래된 수정", 0),
  ]);
  assert.equal(r.status, 409);
  assert.equal(r.data.details.current.value, "팀원이 입력");
  assert.deepEqual(getTask(db, task.id), before);
});
test("수식 문자열은 평가하지 않고 저장하며 같은 요청 재시도는 중복 적용하지 않는다", async () => {
  const operationId = randomUUID(),
    changes = [change("2026-10-05", "=SUM(A1:A9)")];
  const a = await batch(changes, admin, operationId),
    b = await batch(changes, admin, operationId);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  assert.equal(getTask(db, task.id).cells["2026-10-05"].value, "=SUM(A1:A9)");
  assert.equal(a.data.cells[0].version, 1);
  assert.equal((await batch(changes, member, operationId)).status, 403);
});
test("서식만 수정해도 값을 보존하고 버전을 증가시킨다", async () => {
  const r = await batch([
    {
      taskId: task.id,
      key: "2026-10-05",
      expectedVersion: 1,
      style: {
        color: "#aa2244",
        backgroundColor: "#ffeeaa",
        fontFamily: "Noto Serif KR",
        fontSize: 18,
        bold: true,
        textAlign: "center",
        textMode: "wrap",
      },
    },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.data.cells[0].value, "=SUM(A1:A9)");
  assert.equal(r.data.cells[0].version, 2);
  assert.equal(r.data.before[0].style.color, undefined);
});
test("6pt·7pt와 새 글꼴은 기본 서식·셀·XLSX 왕복에서 유지된다", async () => {
  const tid = (
    await post("/admin/teams", {
      name: "작은 글꼴 검증",
      templateTeamId: teamId,
    })
  ).data.id;
  const settings = normalizeSettings({});
  settings.defaultStyle = { fontFamily: "Pretendard", fontSize: 6 };
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: settings,
      })
    ).status,
    200,
  );
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "작은 글꼴 기본값" },
    })
  ).data.task;
  assert.equal(created.defaultStyle.fontSize, 6);
  assert.equal(created.defaultStyle.fontFamily, "Pretendard");
  const edit = { taskId: created.id, key: "2026-10-05", expectedVersion: 0 };
  for (const style of [
    { fontSize: 5 },
    { fontSize: 37 },
    { fontSize: 6.5 },
    { fontFamily: "알 수 없는 글꼴" },
  ]) {
    assert.equal((await batch([{ ...edit, style }])).status, 400);
  }
  assert.equal(
    (
      await batch([
        {
          ...edit,
          value: "일정",
          style: { fontSize: 7, fontFamily: "맑은 고딕" },
        },
      ])
    ).status,
    200,
  );
  const exported = await post("/export", {
    teamId: tid,
    year: 2026,
    scope: "view",
    taskIds: [created.id],
    keys: ["title", "2026-10-05"],
    format: "xlsx",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exported.data);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell("A2").font.size, 6);
  assert.equal(ws.getCell("A2").font.name, "Pretendard");
  assert.equal(ws.getCell("B2").font.size, 7);
  assert.equal(ws.getCell("B2").font.name, "맑은 고딕");
  ws.getCell("A2").value = "작은 글꼴 다시 가져오기";
  // Excel can emit the English family name on a Korean Windows system.
  ws.getCell("B2").font = { ...ws.getCell("B2").font, name: "Malgun Gothic" };
  const form = new FormData();
  form.set("teamId", tid);
  form.set("year", "2026");
  form.set("file", new Blob([await wb.xlsx.writeBuffer()]), "small-fonts.xlsx");
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200);
  const imported = await post(`/import/${preview.data.id}/apply`, {
    sheet: ws.name,
    year: 2026,
    mode: "tasks",
    referenceDate: "2026-10-09",
    acceptWarnings: true,
    personMap: {},
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const restored = (
    await request(`/tasks?teamId=${tid}&year=2026`)
  ).data.tasks.find((t) => t.cells.title.value === "작은 글꼴 다시 가져오기");
  assert.equal(restored.cells.title.style.fontSize, 6);
  assert.equal(restored.cells.title.style.fontFamily, "Pretendard");
  assert.equal(restored.cells["2026-10-05"].style.fontSize, 7);
  assert.equal(restored.cells["2026-10-05"].style.fontFamily, "맑은 고딕");
});

test("잘못된 날짜·주차·서식·숫자 입력은 저장하지 않는다", async () => {
  for (const c of [
    change("2026-10-06", "화요일은 주차 키 아님"),
    change("deadline", "2026-02-30"),
    {
      ...change("title", ""),
      style: { backgroundImage: "url(https://example.com)" },
    },
  ])
    assert.equal((await batch([c])).status, 400);
});
test("진척률은 백분율·문구·줄바꿈을 텍스트 그대로 저장한다", async () => {
  const created = await post("/tasks", {
    teamId,
    year: 2026,
    fields: { title: "자유 진척률", progress: "120% · 검토 중" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.cells.progress.value, "120% · 검토 중");
  for (const value of ["확인 중\n추가 검토", "120%", "", "35"]) {
    const result = await batch([change("progress", value)]);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(getTask(db, task.id).cells.progress.value, value);
  }
  // 진척률은 텍스트 속성이므로 숫자·목록은 받지 않는다.
  for (const value of [35, "x".repeat(10001), ["진행 중"]]) {
    assert.equal((await batch([change("progress", value)])).status, 400);
  }
});
test("복제 업무는 새 ID, 요청한 제목, 원본 주차와 서식을 가진다", async () => {
  const r = await post("/tasks", {
    teamId,
    year: 2026,
    sourceId: task.id,
    fields: { title: "검증 업무 사본" },
  });
  assert.equal(r.status, 201);
  assert.notEqual(r.data.task.id, task.id);
  assert.equal(r.data.task.cells.title.value, "검증 업무 사본");
  assert.equal(r.data.task.cells["2026-10-05"].style.fontSize, 18);
});
test("개인 보기의 배치와 숨김을 저장하며 필터 조건을 섞거나 다른 사용자에게 노출하지 않는다", async () => {
  const view = {
    ...defaultView(2026),
    propertyFilters: { status: ["status-progress"] },
    hiddenRows: [task.id],
    hiddenWeeks: ["2026-10-05"],
    collapsedMonths: [1, 2],
    widths: { title: 450 },
  };
  assert.equal(
    (
      await request("/views", {
        method: "PUT",
        body: { teamId, name: "__current", data: view },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/views", {
        method: "PUT",
        body: {
          teamId,
          name: "__current",
          data: { ...view, widths: { title: 460 } },
        },
      })
    ).status,
    200,
  );
  const own = await request(`/views?teamId=${teamId}&year=2026`),
    theirs = await request(`/views?teamId=${teamId}&year=2026`, {
      cookie: member,
    });
  assert.equal(own.data.views.length, 1);
  assert.equal(own.data.views[0].data.widths.title, 460);
  assert.equal(own.data.views[0].data.propertyFilters, undefined);
  assert.deepEqual(own.data.views[0].data.hiddenRows, [task.id]);
  assert.equal(theirs.data.views.length, 0);
});
test("주간 보고본은 원본 셀 수정 이후에도 고정된다", async () => {
  const before = getTask(db, task.id).cells.title.value;
  const report = await post("/reports", {
    teamId,
    year: 2026,
    name: "10월 9일 보고",
    referenceDate: "2026-10-09",
    taskIds: [task.id],
    view: defaultView(2026),
  });
  assert.equal(report.status, 201);
  assert.equal(
    (await batch([change("title", "이후 변경한 제목")])).status,
    200,
  );
  const stored = await request(`/reports/${report.data.id}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.data.tasks[0].cells.title.value, before);
  assert.equal(
    (await request(`/reports/${report.data.id}`, { cookie: other })).status,
    403,
  );
});
test("스냅샷 선택 삭제는 팀장 권한과 팀 범위를 검사하고 전체 선택을 원자적으로 삭제한다", async () => {
  const tid = (
    await post("/admin/teams", {
      name: "스냅샷 삭제 검증",
      members: [{ userId: memberId, role: "lead" }],
    })
  ).data.id;
  const create = async (team, name, cookie = admin) => {
    const result = await post(
      "/reports",
      {
        teamId: team,
        year: 2026,
        name,
        referenceDate: "2026-10-12",
        taskIds: [],
        view: defaultView(2026),
      },
      cookie,
    );
    assert.equal(result.status, 201);
    return result.data.id;
  };
  const first = await create(tid, "삭제 하나", member);
  const second = await create(tid, "삭제 둘", member);
  const keep = await create(tid, "유지");
  const foreign = await create(teamId, "다른 팀 스냅샷");
  const remove = (team, ids, cookie = admin) =>
    request("/reports", {
      method: "DELETE",
      body: { teamId: team, ids },
      cookie,
    });
  for (const cookie of [viewer, other])
    assert.equal((await remove(teamId, [foreign], cookie)).status, 403);
  assert.equal((await remove(tid, [], member)).status, 400);
  assert.equal((await remove(tid, [first, foreign], member)).status, 404);
  assert.equal(
    (await request(`/reports/${first}`, { cookie: member })).status,
    200,
  );
  assert.equal((await remove(tid, [first, randomUUID()], member)).status, 404);
  assert.equal(
    (await request(`/reports/${first}`, { cookie: member })).status,
    200,
  );
  assert.equal((await remove(tid, [first, second, first], member)).status, 200);
  assert.equal((await request(`/reports/${first}`)).status, 404);
  assert.equal((await request(`/reports/${second}`)).status, 404);
  assert.equal((await request(`/reports/${keep}`)).status, 200);
  assert.equal((await request(`/reports/${foreign}`)).status, 200);
  assert.deepEqual(
    (await request(`/reports?teamId=${tid}`)).data.reports.map((r) => r.id),
    [keep],
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE team_id=? AND action='report-delete'",
      )
      .get(tid).n,
    2,
  );
});
test("연도 이월은 같은 업무 ID를 유지하고 삭제·복구는 버전 충돌을 검사한다", async () => {
  const current = getTask(db, task.id);
  let r = await request(`/tasks/${task.id}`, {
    method: "PATCH",
    body: { updatedAt: current.updatedAt, years: [2026, 2027] },
  });
  assert.equal(r.status, 200);
  const rows = await request(`/tasks?teamId=${teamId}&year=2027`);
  assert.ok(rows.data.tasks.some((t) => t.id === task.id));
  assert.equal(
    (
      await request(`/tasks/${task.id}`, {
        method: "DELETE",
        body: { updatedAt: "2000-01-01" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/tasks/${task.id}`, {
        method: "DELETE",
        body: { updatedAt: getTask(db, task.id).updatedAt },
      })
    ).status,
    200,
  );
  assert.ok(
    !(await request(`/tasks?teamId=${teamId}&year=2026`)).data.tasks.some(
      (t) => t.id === task.id,
    ),
  );
  // 편집 권한이 없으면 휴지통 복구도 할 수 없다.
  assert.equal(
    (await post(`/tasks/${task.id}/restore`, {}, viewer)).status,
    403,
  );
  assert.equal((await post(`/tasks/${task.id}/restore`, {})).status, 200);
  // 자기 업무를 지운 팀원은 실행취소로 바로 되살릴 수 있다.
  const own = (
    await post("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "팀원 업무", owner: memberId },
    })
  ).data.task;
  assert.equal(
    (
      await request(`/tasks/${own.id}`, {
        method: "DELETE",
        body: { updatedAt: getTask(db, own.id).updatedAt },
        cookie: member,
      })
    ).status,
    200,
  );
  assert.equal(
    (await post(`/tasks/${own.id}/restore`, {}, member)).status,
    200,
  );
  assert.equal(getTask(db, own.id).deletedAt, null);
});
test("업무 추가 재실행은 삭제 당시 버전과 다르면 복구와 이력 기록 전에 거절한다", async () => {
  const created = (
    await post("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "재실행 충돌" },
    })
  ).data.task;
  const remove = () =>
    request(`/tasks/${created.id}`, {
      method: "DELETE",
      body: { updatedAt: getTask(db, created.id).updatedAt },
    });
  const first = await remove();
  assert.equal(first.status, 200);
  assert.equal(first.data.updatedAt, getTask(db, created.id).updatedAt);
  assert.equal(
    (
      await post(`/tasks/${created.id}/restore`, {
        updatedAt: first.data.updatedAt,
      })
    ).status,
    200,
  );
  const second = await remove();
  const before = getTask(db, created.id);
  const auditCount = db
    .prepare("SELECT count(*) AS n FROM audit WHERE target=?")
    .get(created.id).n;
  assert.equal(
    (
      await post(`/tasks/${created.id}/restore`, {
        updatedAt: first.data.updatedAt,
      })
    ).status,
    409,
  );
  assert.deepEqual(getTask(db, created.id), before);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM audit WHERE target=?").get(created.id)
      .n,
    auditCount,
  );
  assert.equal(
    (
      await post(`/tasks/${created.id}/restore`, {
        updatedAt: second.data.updatedAt,
      })
    ).status,
    200,
  );
  assert.equal(getTask(db, created.id).deletedAt, null);
});

test("CSV·XLSX 내보내기는 범위, 한글, 서식과 수식 비실행을 지킨다", async () => {
  const body = {
    teamId,
    year: 2026,
    scope: "view",
    taskIds: [task.id],
    keys: ["title", "2026-10-05"],
  };
  const csv = await post("/export", { ...body, format: "csv" });
  assert.equal(csv.status, 200);
  assert.match(csv.data.toString(), /'=SUM\(A1:A9\)/);
  const xlsx = await post("/export", { ...body, format: "xlsx" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.data);
  assert.equal(wb.worksheets[0].rowCount, 2);
  const c = wb.worksheets[0].getCell("B2");
  assert.equal(c.value, "=SUM(A1:A9)");
  assert.equal(c.type, ExcelJS.ValueType.String);
  assert.equal(c.font.size, 18);
  assert.equal(c.fill.fgColor.argb, "FFFFEEAA");
  const data = await post("/export", { ...body, format: "json" });
  assert.equal(data.data.schemaVersion, 6);
  assert.deepEqual(Object.keys(data.data.tasks[0].cells).sort(), [
    "2026-10-05",
    "title",
  ]);
});
test("XLSX 미리보기는 원본을 변경하지 않고 담당자 확인 후 한 번만 반영한다", async () => {
  const wb = new ExcelJS.Workbook(),
    ws = wb.addWorksheet("2026-10-09");
  ws.addRow(["작업", "책임자", "2026-10-09", "진척률", "목표일"]);
  ws.addRow([
    "가져온 업무",
    "member",
    { formula: "1+1", result: 2 },
    "확인 중",
    "10/9",
  ]);
  ws.getCell("C2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEEDDCC" },
  };
  ws.getColumn(3).hidden = true;
  ws.getColumn(1).width = 42;
  ws.getRow(2).hidden = true;
  ws.getRow(2).height = 60;
  const form = new FormData();
  form.set("teamId", teamId);
  form.set("year", "2026");
  form.set("file", new Blob([await wb.xlsx.writeBuffer()]), "test.xlsx");
  const count = db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.sheets[0].count, 1);
  assert.ok(preview.data.sheets[0].warningCount > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, count);
  const body = {
    sheet: "2026-10-09",
    year: 2026,
    mode: "tasks",
    referenceDate: "2026-10-09",
    acceptWarnings: true,
    personMap: {},
  };
  assert.equal(
    (await post(`/import/${preview.data.id}/apply`, body)).status,
    400,
  );
  body.personMap = { member: memberId };
  const a = await post(`/import/${preview.data.id}/apply`, body),
    b = await post(`/import/${preview.data.id}/apply`, body);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.data.repeated, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,
    count + 1,
  );
  const imported = (
    await request(`/tasks?teamId=${teamId}&year=2026`)
  ).data.tasks.find((t) => t.cells.title.value === "가져온 업무");
  assert.equal(imported.cells["2026-10-05"].value, "2");
  assert.equal(imported.cells.deadline.value, "2026-10-09");
  assert.equal(imported.cells.progress.value, "확인 중");
  assert.doesNotMatch(
    String(imported.cells.description?.value || ""),
    /확인 중/,
  );
  const views = (await request(`/views?teamId=${teamId}&year=2026`)).data.views;
  const v = views.find((v) => v.name === "__current").data;
  assert.ok(v.hiddenRows.includes(imported.id));
  assert.deepEqual(v.hiddenWeeks, ["2026-10-05"]);
  assert.equal(v.rowHeights[imported.id], 80);
  assert.equal(v.widths.title, 294);
});
test("마지막 시스템 관리자 해제를 거절하고, 시스템 권한 변경은 팀 내 권한을 유지한다", async () => {
  const u = (await request("/bootstrap")).data.user;
  for (const body of [
    { name: u.name, systemRole: "user", active: true },
    { name: u.name, active: false },
  ])
    assert.equal(
      (await request(`/admin/users/${u.id}`, { method: "PATCH", body })).status,
      400,
    );
  const after = (await request("/bootstrap")).data.user;
  assert.equal(after.systemRole, "admin");
  assert.equal(after.teamRoles[teamId], "lead");
  assert.equal(
    (
      await post("/admin/users", {
        username: `dup-team-${randomUUID().slice(0, 8)}@example.com`,
        password: "test-password-123",
        name: "중복 팀",
        memberships: [
          { teamId, role: "member" },
          { teamId, role: "viewer" },
        ],
      })
    ).status,
    400,
  );
});
test("아이디는 이메일로 받고 소문자로 저장하며 기존 아이디는 로그인 후 이메일로 바꿀 수 있다", async () => {
  const invalid = await post("/admin/users", {
    username: "not-an-email",
    password: "test-password-123",
    name: "형식 오류",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, "아이디는 이메일 주소로 입력하세요.");
  const created = await post("/admin/users", {
    username: "  Mixed.Case@Example.COM ",
    password: "test-password-123",
    name: "대소문자",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, "mixed.case@example.com");
  assert.equal(
    (
      await post(
        "/auth/login",
        { username: "MIXED.case@example.com", password: "test-password-123" },
        "",
      )
    ).status,
    200,
  );
  // 이메일 이전에 만든 아이디도 계속 로그인할 수 있다.
  const legacyId = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    legacyId,
    "legacy-user",
    "기존 아이디",
    passwordHash("test-password-123"),
    "user",
    new Date().toISOString(),
  );
  const login = (username) =>
    post("/auth/login", { username, password: "test-password-123" }, "");
  assert.equal((await login("legacy-user")).status, 200);
  const patch = (body) =>
    request(`/admin/users/${legacyId}`, { method: "PATCH", body });
  // 아이디를 생략하면 기존 아이디를 유지한다.
  assert.equal(
    (await patch({ name: "기존 아이디", active: true })).status,
    200,
  );
  assert.equal((await login("legacy-user")).status, 200);
  assert.equal(
    (
      await patch({
        name: "기존 아이디",
        active: true,
        username: "mixed.case@example.com",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await patch({
        name: "기존 아이디",
        active: true,
        username: "Legacy@Example.com",
      })
    ).status,
    200,
  );
  assert.equal((await login("legacy-user")).status, 401);
  assert.equal((await login("legacy@example.com")).status, 200);
});
test("조건부 조회 캐시는 변경 즉시 무효화되고 팀 접근 검사 후에만 제공된다", async () => {
  const url = `/tasks?teamId=${teamId}&year=2026`,
    first = await request(url),
    etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(
    (await request(url, { headers: { "If-None-Match": etag } })).status,
    304,
  );
  assert.equal(
    (await request(url, { cookie: other, headers: { "If-None-Match": etag } }))
      .status,
    403,
  );
  assert.equal(
    (await batch([change("description", "캐시 변경 검증")])).status,
    200,
  );
  const changed = await request(url, { headers: { "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal(
    changed.data.tasks.find((t) => t.id === task.id).cells.description.value,
    "캐시 변경 검증",
  );
});
test("업무별 이력과 복구 버전 검사 및 비활성 계정 차단", async () => {
  const before = getTask(db, task.id).cells.description.value;
  const result = await batch([change("description", "복구할 변경")]);
  const entries = (await request(`/audit?teamId=${teamId}&taskId=${task.id}`))
    .data.entries;
  const entry = entries.find((e) => e.target === result.data.operationId);
  assert.ok(entry);
  const versions = { [`${task.id}:description`]: result.data.cells[0].version };
  assert.equal(
    (await post(`/audit/${entry.id}/restore`, { versions: {} })).status,
    409,
  );
  assert.equal(
    (await post(`/audit/${entry.id}/restore`, { versions })).status,
    200,
  );
  assert.equal(getTask(db, task.id).cells.description.value, before);
  assert.ok(
    (
      await request(`/audit?teamId=${teamId}&taskId=${task.id}`)
    ).data.entries.filter((e) => e.action === "cells").length > 1,
  );
  const members = (await request("/admin/users")).data.users;
  const u = members.find((u) => u.id === memberId);
  const edit = await request(`/admin/users/${memberId}`, {
    method: "PATCH",
    body: { name: u.name, active: false },
  });
  assert.equal(edit.status, 200);
  assert.equal((await request("/bootstrap", { cookie: member })).status, 401);
  assert.equal(
    (
      await post(
        "/auth/login",
        { username: "member@example.com", password: "test-password-123" },
        "",
      )
    ).status,
    401,
  );
  assert.equal(getTask(db, task.id).cells.owner.value, memberId);
});
test("달력은 윤년과 연도 경계를 누락하지 않고 개인 필터의 OR·AND를 적용한다", () => {
  for (const year of [2024, 2026, 2028, 2100]) {
    const weeks = weeksForYear(year);
    assert.ok(weeks[0].key <= `${year}-01-01`);
    assert.ok(weeks.at(-1).end >= `${year}-12-31`);
    assert.ok(weeks.length <= 54);
    assert.equal(new Set(weeks.map((w) => w.key)).size, weeks.length);
  }
  assert.ok(
    !visibleWeeks(2026, {
      ...defaultView(2026),
      hiddenWeeks: ["2026-10-05"],
      collapsedMonths: [1],
    }).some((w) => w.key === "2026-10-05" || w.month === 1),
  );
});

test("팀 이름 변경과 팀원 중복 배속은 다른 팀 배정을 보존하고 서버 권한을 검사한다", async () => {
  const uid = (
    await post("/admin/users", {
      username: "unassigned-new@example.com",
      password: "test-password-123",
      name: "새 팀원",
      memberships: [],
    })
  ).data.user.id;
  const adminId = (await request("/bootstrap")).data.user.id;
  const first = (await post("/admin/teams", { name: "새 팀 1" })).data.id;
  const second = (await post("/admin/teams", { name: "새 팀 2" })).data.id;
  for (const tid of [first, second]) {
    assert.equal(
      (
        await request(`/teams/${tid}`, {
          method: "PATCH",
          body: { name: tid === first ? "이름 변경 팀" : "새 팀 2" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/teams/${tid}/members`, {
          method: "PUT",
          body: {
            members: [
              { userId: adminId, role: "lead" },
              { userId: uid, role: tid === first ? "lead" : "member" },
            ],
          },
        })
      ).status,
      200,
    );
  }
  let data = (await request("/admin/users")).data;
  const otherId = data.users.find((u) => u.username === "other@example.com").id;
  const assigned = data.users.find((u) => u.id === uid);
  assert.deepEqual(new Set(assigned.teamIds), new Set([first, second]));
  // 같은 사용자가 팀마다 다른 팀 내 권한을 가진다.
  assert.deepEqual(assigned.teamRoles, { [first]: "lead", [second]: "member" });
  assert.equal(data.teams.find((t) => t.id === first).name, "이름 변경 팀");
  assert.equal(
    (
      await request(`/teams/${first}`, {
        method: "PATCH",
        cookie: viewer,
        body: { name: "불법 변경" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/teams/${first}/members`, {
        method: "PUT",
        body: { members: [{ userId: randomUUID(), role: "member" }] },
      })
    ).status,
    400,
  );
  data = (await request("/admin/users")).data;
  assert.equal(data.teams.find((t) => t.id === first).name, "이름 변경 팀");
  const token = (
    await post(
      "/auth/login",
      { username: "unassigned-new@example.com", password: "test-password-123" },
      "",
    )
  ).cookie;
  // 팀장은 자기 팀의 이름·구성원을 관리하지만 팀원인 팀은 관리하지 못한다.
  assert.equal(
    (
      await request(`/teams/${first}`, {
        method: "PATCH",
        cookie: token,
        body: { name: "팀장이 바꾼 이름" },
      })
    ).status,
    200,
  );
  const directory = await request(`/teams/${first}/members`, {
    cookie: token,
  });
  assert.equal(directory.status, 200);
  assert(directory.data.users.some((u) => u.id === otherId));
  assert(!("teamRoles" in directory.data.users[0]));
  assert.equal(
    (
      await request(`/teams/${first}/members`, {
        method: "PUT",
        cookie: token,
        body: {
          members: [
            { userId: adminId, role: "lead" },
            { userId: uid, role: "lead" },
            { userId: otherId, role: "viewer" },
          ],
        },
      })
    ).status,
    200,
  );
  // 그 사이 바뀐 목록을 기준으로 저장하면 덮어쓰지 않고 409를 돌려준다.
  const stale = await request(`/teams/${first}/members`, {
    method: "PUT",
    cookie: token,
    body: {
      previous: [{ userId: adminId, role: "lead" }],
      members: [{ userId: uid, role: "lead" }],
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (await request(`/teams/${first}/members`, { cookie: token })).data.members
      .length,
    3,
  );
  for (const [method, path] of [
    ["GET", `/teams/${second}/members`],
    ["PATCH", `/teams/${second}`],
  ])
    assert.equal(
      (
        await request(path, {
          method,
          cookie: token,
          body: method === "PATCH" ? { name: "권한 없음" } : undefined,
        })
      ).status,
      403,
    );
  assert.equal(
    (await post("/admin/teams", { name: "팀장 생성 시도" }, token)).status,
    403,
  );
  // 열람자로 추가된 사용자는 담당자로 지정할 수 없다.
  assert.equal(
    (
      await post("/tasks", {
        teamId: first,
        year: 2026,
        fields: { owner: otherId },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/teams/${first}/members`, {
        method: "PUT",
        body: { members: [{ userId: adminId, role: "lead" }] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/tasks?teamId=${first}&year=2026`, { cookie: token }))
      .status,
    403,
  );
  assert.equal(
    (await request(`/tasks?teamId=${second}&year=2026`, { cookie: token }))
      .status,
    200,
  );
});

test("동적 속성의 이름·값·모양 변경은 업무 연결과 과거 보고본을 보존하고 내보내기에 표시명을 쓴다", async () => {
  const tid = (
    await post("/admin/teams", { name: "속성 시험", templateTeamId: teamId })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const pid = `prop_${randomUUID()}`,
    oid = `opt_${randomUUID()}`;
  settings.properties.push({
    id: pid,
    name: "프로젝트",
    display: "dot",
    values: [
      {
        id: oid,
        label: "A 프로젝트",
        backgroundColor: "#ffeeaa",
        dotColor: "#aa2233",
        emoji: "🚀",
      },
    ],
  });
  let save = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  settings = save.data.settings;
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "속성 업무", [pid]: oid },
    })
  ).data.task;
  const invalid = await batch([
    { taskId: created.id, key: pid, value: "없는 옵션", expectedVersion: 1 },
  ]);
  assert.equal(invalid.status, 400);
  assert.equal(
    (await batch([change(pid, oid, 0)])).status,
    400,
    "다른 팀 속성은 거절",
  );
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "속성 보고",
    referenceDate: "2026-10-09",
    view: { ...defaultView(2026), visibleFields: ["title", pid], groupBy: pid },
    taskIds: [created.id],
  });
  assert.equal(report.status, 201);
  const stale = structuredClone(settings);
  const property = settings.properties.find((p) => p.id === pid);
  property.name = "제품 프로젝트";
  property.values[0].label = "A 서비스";
  property.display = "emoji";
  save = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(save.status, 200);
  assert.equal(
    (await request(`/teams/${tid}/settings`, { method: "PATCH", body: stale }))
      .status,
    409,
  );
  assert.equal(getTask(db, created.id).cells[pid].value, oid);
  const frozen = (await request(`/reports/${report.data.id}`)).data;
  assert.equal(
    frozen.settings.properties.find((p) => p.id === pid).name,
    "프로젝트",
  );
  assert.equal(
    frozen.settings.properties.find((p) => p.id === pid).values[0].label,
    "A 프로젝트",
  );
  const xlsx = await post("/export", {
    teamId: tid,
    year: 2026,
    format: "xlsx",
    scope: "view",
    taskIds: [created.id],
    keys: ["title", pid],
  });
  assert.equal(xlsx.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.data);
  assert.equal(wb.worksheets[0].getCell("B1").value, "제품 프로젝트");
  assert.equal(wb.worksheets[0].getCell("B2").value, "A 서비스");
  const form = new FormData();
  form.set("teamId", tid);
  form.set("year", "2026");
  form.set("file", new Blob([xlsx.data]), "properties.xlsx");
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200);
  const imported = await post(`/import/${preview.data.id}/apply`, {
    sheet: "2026",
    year: 2026,
    mode: "tasks",
    referenceDate: "2026-10-09",
    acceptWarnings: true,
    personMap: {},
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const importedTasks = (await request(`/tasks?teamId=${tid}&year=2026`)).data
    .tasks;
  assert.equal(importedTasks.length, 2);
  assert.equal(
    importedTasks.find((t) => t.id !== created.id).cells[pid].value,
    oid,
  );

  const malformed = structuredClone(save.data.settings);
  malformed.properties.push({ ...malformed.properties[0] });
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: malformed,
      })
    ).status,
    400,
  );
  const archived = structuredClone(save.data.settings);
  archived.properties = archived.properties.filter((p) => p.id !== pid);
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: archived,
      })
    ).status,
    200,
  );
  const archivedConfig = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.equal(
    archivedConfig.properties.find((p) => p.id === pid).archived,
    true,
  );
  assert.equal(getTask(db, created.id).cells[pid].value, oid);
});

test("날짜 뒤 열 배치는 구 설정 저장·팀 양식·보고본·내보내기에서 유지된다", async () => {
  const tid = (await post("/admin/teams", { name: "날짜 뒤 열 배치" })).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.ok(settings.properties.every((p) => p.placement === "beforeWeeks"));
  settings.properties.push(
    {
      id: "progress",
      name: "진척률",
      kind: "text",
      display: "text",
      visible: true,
      placement: "afterWeeks",
      values: [],
    },
    {
      id: "deadline",
      name: "목표일",
      kind: "date",
      display: "text",
      visible: true,
      placement: "afterWeeks",
      values: [],
    },
  );
  const save = (body) =>
    request(`/teams/${tid}/settings`, {
      method: "PATCH",
      body,
    });
  let result = await save(settings);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  settings = result.data.settings;
  const created = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: {
        title: "뒤쪽 속성 검증",
        progress: "37% 검토",
        deadline: "2026-12-31",
      },
    })
  ).data.task;
  const before = getTask(db, created.id);
  const view = normalizeView(defaultView(2026), settings);
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "날짜 뒤 배치 보고",
    referenceDate: "2026-10-10",
    taskIds: [created.id],
    view,
  });
  assert.equal(report.status, 201);

  const body = { teamId: tid, year: 2026, scope: "all" };
  const headers = [
    "작업",
    "팀원",
    "상태",
    ...weeksForYear(2026).map((w) => w.key),
    "진척률",
    "목표일",
  ];
  const csv = await post("/export", { ...body, format: "csv" });
  assert.equal(csv.status, 200);
  assert.equal(
    csv.data
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split("\r\n")[0],
    headers.map((h) => `"${h}"`).join(","),
  );
  const xlsx = await post("/export", { ...body, format: "xlsx" });
  assert.equal(xlsx.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.data);
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), headers);
  assert.equal(
    wb.worksheets[0].getRow(2).getCell(headers.length - 1).value,
    "37% 검토",
  );
  assert.equal(
    wb.worksheets[0].getRow(2).getCell(headers.length).value,
    "2026-12-31",
  );
  const current = await post("/export", {
    ...body,
    scope: "view",
    format: "xlsx",
    taskIds: [created.id],
    keys: ["title", "2026-03-02", "deadline", "progress"],
  });
  assert.equal(current.status, 200);
  await wb.xlsx.load(current.data);
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), [
    "작업",
    "2026-03-02",
    "목표일",
    "진척률",
  ]);
  const jsonExport = await post("/export", { ...body, format: "json" });
  assert.equal(
    jsonExport.data.team.settings.properties.find((p) => p.id === "progress")
      .placement,
    "afterWeeks",
  );

  const copy = await post("/admin/teams", {
    name: "배치 복사",
    templateTeamId: tid,
  });
  assert.equal(copy.status, 201);
  const copied = (await request("/admin/users")).data.teams.find(
    (t) => t.id === copy.data.id,
  );
  assert.deepEqual(copied.settings.properties, settings.properties);
  // 배치를 생략한 저장은 기존 배치를 유지한다.
  {
    const legacy = structuredClone(settings);
    for (const p of legacy.properties) delete p.placement;
    result = await save(legacy);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    settings = result.data.settings;
    for (const id of ["progress", "deadline"])
      assert.equal(
        settings.properties.find((p) => p.id === id).placement,
        "afterWeeks",
      );
  }
  const invalid = structuredClone(settings);
  invalid.properties.find((p) => p.id === "progress").placement = "middle";
  assert.equal((await save(invalid)).status, 400);
  const stale = structuredClone(settings);
  settings.properties.find((p) => p.id === "progress").placement =
    "beforeWeeks";
  result = await save(settings);
  assert.equal(result.status, 200);
  assert.equal(
    result.data.settings.properties.find((p) => p.id === "progress").placement,
    "beforeWeeks",
  );
  assert.equal((await save(stale)).status, 409);
  const frozen = (await request(`/reports/${report.data.id}`)).data;
  assert.equal(
    frozen.settings.properties.find((p) => p.id === "progress").placement,
    "afterWeeks",
  );
  assert.deepEqual(getTask(db, created.id).cells, before.cells);
});

test("기본 속성 값 변경은 스타일을 보존하며 셀 버전을 올려 오래된 편집을 차단한다", async () => {
  const tid = (
    await post("/admin/teams", {
      name: "기본 속성 변경",
      templateTeamId: teamId,
    })
  ).data.id;
  const t = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "분류 변경 검증", category: "category-ux" },
    })
  ).data.task;
  const styled = await batch([
    {
      taskId: t.id,
      key: "category",
      expectedVersion: 1,
      style: { bold: true },
    },
  ]);
  assert.equal(styled.status, 200);
  const settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  settings.properties.find((p) => p.id === "category").values[0].label =
    "UX 프로젝트";
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: settings,
      })
    ).status,
    200,
  );
  // 셀은 옵션 ID를 저장하므로 이름 변경이 셀 값·버전을 건드리지 않는다.
  const changed = getTask(db, t.id).cells.category;
  assert.equal(changed.value, "category-ux");
  assert.equal(changed.style.bold, true);
  assert.equal(changed.version, 2);
  const renamed = (await request("/admin/users")).data.teams.find(
    (team) => team.id === tid,
  ).settings;
  assert.equal(
    displayValue(getTask(db, t.id), "category", [], renamed),
    "UX 프로젝트",
  );
  assert.equal(
    (
      await batch([
        {
          taskId: t.id,
          key: "category",
          expectedVersion: 1,
          style: { italic: true },
        },
      ])
    ).status,
    409,
  );
});

test("컬럼 정렬은 숫자와 이름을 비교하고 기본 순서를 복원하며 속성 묶음 순서를 유지한다", async () => {
  const { normalizeSettings } = await import("../shared/domain.js");
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    properties: sampleProperties(),
  });
  const pid = `prop_${randomUUID()}`;
  settings.properties.push({
    id: pid,
    name: "프로젝트",
    display: "square",
    values: [
      { id: "c", label: "C" },
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const rows = [
    ["one", 30, "가", 10, "a"],
    ["two", 10, "나", 2, "c"],
    ["three", 20, "다", "", "a"],
  ].map(([id, position, title, score, group]) => ({
    id,
    position,
    cells: {
      title: { value: title },
      score: { value: score },
      [pid]: { value: group },
    },
  }));
  const v = defaultView(2026),
    ids = (x) => x.map((t) => t.id);
  assert.deepEqual(
    ids(
      filteredTasks(
        rows,
        { ...v, sortKey: "score", sortDirection: "asc" },
        settings,
      ),
    ),
    ["two", "one", "three"],
  );
  assert.deepEqual(
    ids(
      filteredTasks(
        rows,
        { ...v, sortKey: "title", sortDirection: "desc" },
        settings,
      ),
    ),
    ["three", "two", "one"],
  );
  assert.deepEqual(ids(filteredTasks(rows, v, settings)), [
    "two",
    "three",
    "one",
  ]);
  assert.deepEqual(
    ids(
      filteredTasks(
        rows,
        { ...v, groupBy: pid, sortKey: "title", sortDirection: "asc" },
        settings,
      ),
    ),
    ["two", "one", "three"],
  );
});

test("팀 기본 서식은 새 업무에 고정되고 빈 일정·복제·반출에도 적용된다", async () => {
  const { cell, normalizeSettings } = await import("../shared/domain.js");
  const id = (await post("/admin/teams", { name: "서식 검증" })).data.id;
  let settings = normalizeSettings();
  const old = (await post("/tasks", { teamId: id, year: 2026 })).data.task;
  let r = await request(`/teams/${id}/settings`, {
    method: "PATCH",
    body: {
      ...settings,
      defaultStyle: {
        fontFamily: "Nanum Gothic Coding",
        fontSize: 18,
        textMode: "wrap",
        verticalAlign: "top",
        color: "#24796d",
      },
    },
  });
  assert.equal(r.status, 200);
  settings = r.data.settings;
  const created = (await post("/tasks", { teamId: id, year: 2026 })).data.task;
  assert.equal(cell(created, "title").style.fontSize, 18);
  assert.equal(
    cell(created, "2026-10-05").style.fontFamily,
    "Nanum Gothic Coding",
  );
  assert.equal(cell(getTask(db, old.id), "title").style.fontSize, 9);
  r = await request(`/teams/${id}/settings`, {
    method: "PATCH",
    body: { ...settings, defaultStyle: { fontSize: 14 } },
  });
  assert.equal(r.status, 200);
  settings = r.data.settings;
  assert.equal(cell(getTask(db, created.id), "title").style.fontSize, 18);
  const copy = (
    await post("/tasks", { teamId: id, year: 2026, sourceId: created.id })
  ).data.task;
  assert.equal(cell(copy, "2026-11-02").style.fontSize, 18);
  const next = (await post("/tasks", { teamId: id, year: 2026 })).data.task;
  assert.equal(cell(next, "title").style.fontSize, 14);
  assert.equal(
    (
      await request(`/teams/${id}/settings`, {
        method: "PATCH",
        body: { ...settings, defaultStyle: { fontSize: 99 } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/teams/${teamId}/settings`, {
        method: "PATCH",
        body: settings,
        cookie: viewer,
      })
    ).status,
    403,
  );
  const { makeWorkbook } = await import("../server/transfer.mjs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    await makeWorkbook([created], ["title", "2026-10-05"], [], 2026, settings),
  );
  assert.equal(wb.worksheets[0].getCell("A2").font.size, 18);
  assert.equal(wb.worksheets[0].getCell("B2").font.name, "Nanum Gothic Coding");
});

test("번호 순서 이동은 같은 묶음에만 적용하며 잘못된 요청과 이전 버전을 거절한다", async () => {
  const id = (
    await post("/admin/teams", { name: "순서 검증", templateTeamId: teamId })
  ).data.id;
  const rows = [];
  for (const [title, category] of [
    ["A", "category-ux"],
    ["B", "category-ux"],
    ["C", "category-ux"],
    ["D", "category-new"],
  ])
    rows.push(
      (
        await post("/tasks", {
          teamId: id,
          year: 2026,
          fields: { title, category },
        })
      ).data.task,
    );
  const body = {
    taskId: rows[0].id,
    targetId: rows[2].id,
    year: 2026,
    placement: "after",
    groupBy: "category",
    updatedAt: rows[0].updatedAt,
    targetUpdatedAt: rows[2].updatedAt,
  };
  const moved = await post("/tasks/reorder", body);
  assert.equal(moved.status, 200);
  assert.deepEqual(
    (await request(`/tasks?teamId=${id}&year=2026`)).data.tasks.map(
      (t) => t.cells.title.value,
    ),
    ["B", "C", "A", "D"],
  );
  assert.equal((await post("/tasks/reorder", body)).status, 409);
  const cross = {
    ...body,
    updatedAt: moved.data.task.updatedAt,
    targetId: rows[3].id,
    targetUpdatedAt: rows[3].updatedAt,
  };
  assert.equal((await post("/tasks/reorder", cross)).status, 400);
  assert.equal(
    (await post("/tasks/reorder", { ...cross, groupBy: "prop_unknown" }))
      .status,
    400,
  );
  assert.equal(
    (await post("/tasks/reorder", { ...cross, year: 2027 })).status,
    400,
  );
  assert.equal((await post("/tasks/reorder", cross, viewer)).status, 403);
  assert.deepEqual(
    (await request(`/tasks?teamId=${id}&year=2026`)).data.tasks.map(
      (t) => t.cells.title.value,
    ),
    ["B", "C", "A", "D"],
  );
});

test("여러 행 이동은 기존 순서와 제외된 행을 유지하고 모든 행의 권한·버전을 검사한다", async () => {
  const adminId = (await request("/bootstrap")).data.user.id;
  const tid = (
    await post("/admin/teams", {
      name: "여러 행 이동",
      templateTeamId: teamId,
      members: [{ userId: adminId, role: "lead" }],
    })
  ).data.id;
  const account = {
    username: `row-mover-${randomUUID()}@example.com`,
    password: "row-move-test-password",
  };
  const moverId = (
    await post("/admin/users", {
      ...account,
      name: "행 이동 팀원",
      active: true,
      memberships: [{ teamId: tid, role: "member" }],
    })
  ).data.user.id;
  const mover = (await post("/auth/login", account)).cookie;
  const rows = [];
  for (const title of ["A", "B", "C", "D", "E", "F"])
    rows.push(
      (
        await post("/tasks", {
          teamId: tid,
          year: 2026,
          fields: {
            title,
            category: title === "F" ? "category-new" : "category-ux",
            owner: title === "A" ? moverId : adminId,
          },
        })
      ).data.task,
    );
  const read = async () =>
    (await request(`/tasks?teamId=${tid}&year=2026`)).data.tasks;
  const payload = (indices = [2, 0]) => ({
    tasks: indices.map((i) => ({
      id: rows[i].id,
      updatedAt: getTask(db, rows[i].id).updatedAt,
    })),
    targetId: rows[3].id,
    targetUpdatedAt: getTask(db, rows[3].id).updatedAt,
    year: 2026,
    placement: "after",
    groupBy: "category",
  });
  const initial = await read();
  const noChange = async (body, status, cookie = admin) => {
    assert.equal((await post("/tasks/reorder", body, cookie)).status, status);
    assert.deepEqual(await read(), initial);
  };
  await noChange(payload([0, 2]), 403, mover);
  await noChange(payload(), 403, viewer);
  await noChange(payload([0, 5]), 400);
  await noChange(payload([0, 0]), 400);
  await noChange(payload([0, 3]), 400);
  await noChange({ ...payload(), year: 2027 }, 400);
  await noChange({ ...payload(), tasks: [] }, 400);
  const stale = payload();
  stale.tasks[1].updatedAt = "stale";
  await noChange(stale, 409);
  await noChange({ ...payload(), targetUpdatedAt: "stale" }, 409);
  const moved = await post("/tasks/reorder", payload());
  assert.equal(moved.status, 200);
  assert.deepEqual(
    moved.data.tasks.map((t) => t.cells.title.value),
    ["A", "C"],
  );
  assert.deepEqual(
    (await read()).map((t) => t.cells.title.value),
    ["B", "D", "A", "C", "E", "F"],
  );
  for (const i of [1, 3, 4, 5])
    assert.equal(getTask(db, rows[i].id).position, rows[i].position);
  const back = {
    ...payload([2, 0]),
    targetId: rows[1].id,
    targetUpdatedAt: getTask(db, rows[1].id).updatedAt,
    placement: "before",
  };
  assert.equal((await post("/tasks/reorder", back)).status, 200);
  assert.deepEqual(
    (await read()).map((t) => t.cells.title.value),
    ["A", "C", "B", "D", "E", "F"],
  );
});

test("여러 행 저장 도중 실패하면 모두 취소하고 순서 간격이 좁으면 재배치한다", async () => {
  const tid = (await post("/admin/teams", { name: "행 이동 원자성" })).data.id;
  const rows = [];
  for (const title of ["A", "B", "C", "D", "E"])
    rows.push(
      (await post("/tasks", { teamId: tid, year: 2026, fields: { title } }))
        .data.task,
    );
  const read = async () =>
    (await request(`/tasks?teamId=${tid}&year=2026`)).data.tasks;
  const payload = () => ({
    tasks: rows
      .slice(0, 2)
      .map((t) => ({ id: t.id, updatedAt: getTask(db, t.id).updatedAt })),
    targetId: rows[3].id,
    targetUpdatedAt: getTask(db, rows[3].id).updatedAt,
    year: 2026,
    placement: "after",
  });
  const initial = await read();
  const auditCount = () =>
    db.prepare("SELECT COUNT(*) AS n FROM audit WHERE team_id=?").get(tid).n;
  const originalAuditCount = auditCount();
  db.exec(
    `CREATE TEMP TRIGGER fail_second_row BEFORE UPDATE OF position ON tasks WHEN OLD.id='${rows[1].id}' BEGIN SELECT RAISE(ABORT, 'test row move rollback'); END`,
  );
  try {
    assert.equal((await post("/tasks/reorder", payload())).status, 500);
    assert.deepEqual(await read(), initial);
    assert.equal(auditCount(), originalAuditCount);
  } finally {
    db.exec("DROP TRIGGER fail_second_row");
  }
  db.prepare("UPDATE tasks SET position=? WHERE id=?").run(
    rows[3].position + 1e-8,
    rows[4].id,
  );
  assert.equal((await post("/tasks/reorder", payload())).status, 200);
  const reordered = await read();
  assert.deepEqual(
    reordered.map((t) => t.cells.title.value),
    ["C", "D", "A", "B", "E"],
  );
  assert.equal(new Set(reordered.map((t) => t.position)).size, 5);
  assert.ok(reordered.every((t) => Number.isFinite(t.position)));
  assert.equal(auditCount(), originalAuditCount + 2);
});

test("동적 속성 다중 필터는 값 사이 OR·속성 사이 AND이며 구 보기 필터를 보존한다", async () => {
  const { normalizeSettings } = await import("../shared/domain.js");
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    properties: sampleProperties(),
  });
  settings.properties.push({
    id: "prop_project",
    name: "프로젝트",
    display: "text",
    values: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const rows = [
    ["one", "a", "status-planned"],
    ["two", "b", "status-progress"],
    ["three", "", "status-planned"],
  ].map(([id, project, status], i) => ({
    id,
    position: i,
    cells: { prop_project: { value: project }, status: { value: status } },
  }));
  const view = {
    ...defaultView(2026),
    propertyFilters: { prop_project: ["a", "b"], status: ["status-planned"] },
  };
  assert.deepEqual(
    filteredTasks(rows, view, settings).map((t) => t.id),
    ["one"],
  );
  view.propertyFilters.status.push("status-progress");
  assert.deepEqual(
    filteredTasks(rows, view, settings).map((t) => t.id),
    ["one", "two"],
  );
  view.propertyFilters.prop_project = [""];
  assert.deepEqual(
    filteredTasks(rows, view, settings).map((t) => t.id),
    ["three"],
  );
  const bad = await request("/filters", {
    method: "PUT",
    body: {
      teamId,
      scope: "personal",
      name: "bad-property",
      data: {
        propertyFilters: { prop_other_team: ["a"] },
      },
    },
  });
  assert.equal(bad.status, 400);
});

test("컬럼 필터의 제외 모드는 보기·보고본과 값 이름 변경에 보존되고 잘못된 모드는 거절한다", async () => {
  const tid = (await post("/admin/teams", { name: "제외 필터 검증" })).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const view = {
    ...normalizeView(defaultView(2026), settings),
    propertyFilters: { status: ["status-completed"] },
    propertyFilterModes: { status: "exclude" },
  };
  const save = (data, name = "제외 보기") =>
    request("/filters", {
      method: "PUT",
      body: {
        teamId: tid,
        scope: "personal",
        name,
        data: {
          propertyFilters: data.propertyFilters,
          propertyFilterModes: data.propertyFilterModes,
        },
      },
    });
  assert.equal((await save(view)).status, 200);
  const load = async (name = "제외 보기") =>
    (await request(`/filters?teamId=${tid}`)).data.filters.find(
      (v) => v.name === name,
    ).data;
  assert.deepEqual((await load()).propertyFilterModes, { status: "exclude" });
  assert.deepEqual((await load()).propertyFilters, {
    status: ["status-completed"],
  });
  const legacy = { ...view };
  delete legacy.propertyFilterModes;
  assert.equal((await save(legacy, "구 일치 보기")).status, 200);
  assert.deepEqual((await load("구 일치 보기")).propertyFilterModes, {});
  for (const modes of [
    { status: "invalid" },
    { prop_other_team: "exclude" },
    Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`prop_${i}`, "exclude"]),
    ),
  ]) {
    assert.equal(
      (await save({ ...view, propertyFilterModes: modes })).status,
      400,
    );
  }
  const report = await post("/reports", {
    teamId: tid,
    year: 2026,
    name: "완료 제외 보고본",
    referenceDate: "2026-03-06",
    taskIds: [],
    view,
  });
  assert.equal(report.status, 201);
  assert.deepEqual(
    (await request(`/reports/${report.data.id}`)).data.view.propertyFilterModes,
    { status: "exclude" },
  );
  settings.properties
    .find((p) => p.id === "status")
    .values.find((v) => v.label === "완료").label = "종료";
  const renamed = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  // 이름을 바꿔도 필터는 옵션 ID로 저장되어 그대로 적용된다.
  assert.deepEqual((await load()).propertyFilters.status, ["status-completed"]);
  assert.deepEqual((await load()).propertyFilterModes, { status: "exclude" });
  assert.deepEqual(
    (await request(`/reports/${report.data.id}`)).data.view.propertyFilters
      .status,
    ["status-completed"],
  );
});

test("속성 값 신규·수정은 15자로 제한하고 기존 긴 값과 무관한 설정 저장은 보존한다", async () => {
  const tid = (
    await post("/admin/teams", {
      name: "속성 길이 검증",
      templateTeamId: teamId,
    })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const pid = `prop_${randomUUID()}`,
    oid = `opt_${randomUUID()}`;
  settings.properties.push({
    id: pid,
    name: "프로젝트",
    display: "text",
    values: [
      {
        id: oid,
        label: "가".repeat(15),
        backgroundColor: "#edf6f4",
        dotColor: "#177b70",
        emoji: "📌",
      },
    ],
  });
  const save = (body) =>
    request(`/teams/${tid}/settings`, { method: "PATCH", body });
  let result = await save(settings);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  settings = result.data.settings;
  const invalid = structuredClone(settings);
  invalid.properties.find((p) => p.id === pid).values[0].label += "나";
  result = await save(invalid);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /15자/);
  const afterFailure = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.equal(afterFailure.revision, settings.revision);
  assert.equal(
    afterFailure.properties.find((p) => p.id === pid).values[0].label.length,
    15,
  );

  // Simulate a pre-limit definition in this test's temporary database only.
  const legacyLabel = "예전에 저장한 긴 프로젝트 이름";
  settings.properties.find((p) => p.id === pid).values[0].label = legacyLabel;
  db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
    JSON.stringify(settings),
    tid,
  );
  settings.defaultStyle = { ...settings.defaultStyle, fontSize: 18 };
  result = await save(settings);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(
    result.data.settings.properties.find((p) => p.id === pid).values[0].label,
    legacyLabel,
  );
  settings = result.data.settings;
  settings.properties.find((p) => p.id === pid).values[0].label =
    legacyLabel + " 변경";
  assert.equal((await save(settings)).status, 400);
  settings.properties.find((p) => p.id === pid).values[0].label = "짧게 수정";
  result = await save(settings);
  assert.equal(result.status, 200);
  assert.equal(
    result.data.settings.properties.find((p) => p.id === pid).values[0].label,
    "짧게 수정",
  );
});

test("모든 업무 정보 열을 속성으로 관리하고 다섯 종류의 값과 XLSX를 보존한다", async () => {
  const actor = (await request("/bootstrap")).data.user;
  const tid = (
    await post("/admin/teams", {
      name: "통합 속성",
      members: [{ userId: actor.id, role: "lead" }],
    })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  assert.equal(settings.properties.length, 3);
  const props = [
    {
      name: "추가 선택",
      kind: "option",
      display: "dot",
      values: [{ id: "first", label: "선택 A" }],
    },
    { name: "추가 메모", kind: "text", display: "text", values: [] },
    { name: "추가 날짜", kind: "date", display: "text", values: [] },
    { name: "추가 숫자", kind: "number", display: "text", values: [] },
    {
      name: "추가 담당",
      kind: "member",
      display: "avatar",
      multiple: false,
      values: [],
    },
    {
      name: "추가 협업",
      kind: "member",
      display: "text",
      multiple: true,
      values: [],
    },
  ].map((p) => ({ ...p, id: `prop_${randomUUID()}`, visible: true }));
  delete props[0].visible;
  settings.properties.push(...props);
  settings.properties.find((p) => p.id === "title").name = "업무 제목";
  let saved = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  settings = saved.data.settings;
  assert.equal(
    settings.properties.find((p) => p.id === props[0].id).visible,
    true,
  );
  assert.equal(
    (
      await request("/views", {
        method: "PUT",
        body: {
          teamId: tid,
          name: "__current",
          data: normalizeView(defaultView(2026), settings),
        },
      })
    ).status,
    200,
  );
  // Omitting an optional visibility flag must not hide a previously visible column.
  delete settings.properties.find((p) => p.id === props[0].id).visible;
  saved = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  settings = saved.data.settings;
  const view = (await request(`/views?teamId=${tid}&year=2026`)).data.views[0]
    .data;
  assert(view.visibleFields.includes(props[0].id));
  const values = [
    "first",
    "추가 설명\n둘째 줄",
    "2026-10-20",
    -12.5,
    actor.id,
    [actor.id],
  ];
  const created = await post("/tasks", {
    teamId: tid,
    year: 2026,
    fields: {
      title: "종류별 업무",
      ...Object.fromEntries(props.map((p, i) => [p.id, values[i]])),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const [i, p] of props.entries())
    assert.deepEqual(created.data.task.cells[p.id].value, values[i]);
  for (const [index, bad] of [
    [0, "없는 선택"],
    [2, "2026-02-30"],
    [3, "숫자 아님"],
    [4, randomUUID()],
    [5, actor.id],
  ]) {
    const r = await batch([
      {
        taskId: created.data.task.id,
        key: props[index].id,
        value: bad,
        expectedVersion: 1,
      },
    ]);
    assert.equal(r.status, 400, JSON.stringify(r.data));
  }
  const exported = await post("/export", {
    teamId: tid,
    year: 2026,
    format: "xlsx",
    scope: "view",
    taskIds: [created.data.task.id],
    keys: ["title", ...props.map((p) => p.id)],
  });
  assert.equal(exported.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exported.data);
  assert.equal(wb.worksheets[0].getCell("A1").value, "업무 제목");
  assert.equal(wb.worksheets[0].getCell("F2").value, actor.name);
  const form = new FormData();
  form.set("teamId", tid);
  form.set("year", "2026");
  form.set("file", new Blob([exported.data]), "types.xlsx");
  const preview = await request("/import/preview", {
    method: "POST",
    body: form,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const imported = await post(`/import/${preview.data.id}/apply`, {
    sheet: "2026",
    year: 2026,
    mode: "tasks",
    referenceDate: "2026-10-09",
    acceptWarnings: true,
    personMap: { [actor.name]: actor.id },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const rows = (await request(`/tasks?teamId=${tid}&year=2026`)).data.tasks;
  assert.equal(rows.length, 2);
  const copy = rows.find((t) => t.id !== created.data.task.id);
  for (const [i, p] of props.entries())
    assert.deepEqual(copy.cells[p.id].value, values[i]);
});

test("작업 열 보호·선택 열 삭제와 복원·표시 순서 및 종류 변환을 원자적으로 저장한다", async () => {
  const { fieldsFor } = await import("../shared/domain.js");
  const tid = (
    await post("/admin/teams", { name: "열 설정 보호", templateTeamId: teamId })
  ).data.id;
  let settings = (await request("/admin/users")).data.teams.find(
    (t) => t.id === tid,
  ).settings;
  const pid = `prop_${randomUUID()}`;
  settings.properties.push({
    id: pid,
    name: "전환 값",
    kind: "text",
    display: "text",
    visible: true,
    values: [],
  });
  let result = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  settings = result.data.settings;
  const task = (
    await post("/tasks", {
      teamId: tid,
      year: 2026,
      fields: { title: "보존 업무", category: "category-ux", [pid]: "12.5" },
    })
  ).data.task;
  const initial = normalizeView(defaultView(2026), settings);
  assert.equal(
    (
      await request("/views", {
        method: "PUT",
        body: { teamId: tid, name: "__current", data: initial },
      })
    ).status,
    200,
  );
  for (const corrupt of [
    (s) => (s.properties.find((p) => p.id === "title").archived = true),
    (s) => (s.properties = s.properties.filter((p) => p.id !== "title")),
  ]) {
    const data = structuredClone(settings);
    corrupt(data);
    assert.equal(
      (await request(`/teams/${tid}/settings`, { method: "PATCH", body: data }))
        .status,
      400,
    );
  }
  const invalid = structuredClone(settings);
  invalid.properties.find((p) => p.id === pid).kind = "date";
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: invalid,
      })
    ).status,
    400,
  );
  assert.equal(getTask(db, task.id).cells[pid].value, "12.5");
  assert.equal(getTask(db, task.id).cells[pid].version, 1);
  const number = settings.properties.find((p) => p.id === pid);
  number.kind = "number";
  number.visible = false;
  settings.properties.find((p) => p.id === "category").archived = true;
  settings.properties.find((p) => p.id === "supporters").archived = true;
  settings.properties.find((p) => p.id === "title").name = "업무명 변경";
  settings.properties = [
    number,
    ...settings.properties.filter((p) => p.id !== pid),
  ];
  result = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  settings = result.data.settings;
  assert.equal(getTask(db, task.id).cells[pid].value, 12.5);
  assert.equal(getTask(db, task.id).cells[pid].version, 2);
  assert.equal(fieldsFor(settings)[0].key, pid);
  assert(
    !fieldsFor(settings).some(
      (f) => f.key === "category" || f.key === "supporters",
    ),
  );
  assert.equal(getTask(db, task.id).cells.category.value, "category-ux");
  let view = (await request(`/views?teamId=${tid}&year=2026`)).data.views[0]
    .data;
  assert(!view.visibleFields.includes(pid));
  assert(!view.visibleFields.includes("category"));
  assert.equal((await post("/tasks", { teamId: tid, year: 2026 })).status, 201);
  settings.properties.find((p) => p.id === pid).visible = true;
  settings.properties.find((p) => p.id === "category").archived = false;
  result = await request(`/teams/${tid}/settings`, {
    method: "PATCH",
    body: settings,
  });
  assert.equal(result.status, 200);
  view = (await request(`/views?teamId=${tid}&year=2026`)).data.views[0].data;
  assert(view.visibleFields.includes(pid));
  assert(view.visibleFields.includes("category"));
  assert.equal(getTask(db, task.id).cells.category.value, "category-ux");
});

test("팀 테마는 팀별로 저장하고 기존 설정 저장·권한·충돌 검사를 보존한다", async () => {
  const created = await post("/admin/teams", {
    name: "테마 팀",
    theme: "lavender",
  });
  assert.equal(created.status, 201);
  const tid = created.data.id;
  const second = (await post("/admin/teams", { name: "기본 테마 팀" })).data.id;
  const settingsFor = async (id) =>
    (await request("/bootstrap")).data.teams.find((t) => t.id === id).settings;
  let settings = await settingsFor(tid);
  assert.equal(settings.theme, "lavender");
  assert.equal((await settingsFor(second)).theme, "mint");
  const stale = structuredClone(settings);
  const patch = (body, cookie = admin) =>
    request(`/teams/${tid}`, {
      method: "PATCH",
      body: { name: "테마 팀", ...body },
      cookie,
    });
  assert.equal((await patch({ theme: "sky" }, viewer)).status, 403);
  assert.equal((await patch({ theme: "unknown" })).status, 400);
  assert.equal(
    (await post("/admin/teams", { name: "잘못된 테마", theme: "unknown" }))
      .status,
    400,
  );
  assert.equal(
    (await patch({ theme: "sky", settingsRevision: 0 })).status,
    200,
  );
  settings = await settingsFor(tid);
  assert.equal(settings.theme, "sky");
  assert.equal(settings.revision, 1);
  assert.deepEqual(settings.properties, stale.properties);
  assert.equal(
    (await patch({ theme: "rose", settingsRevision: 0 })).status,
    409,
  );
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: { ...stale, revision: 0 },
      })
    ).status,
    409,
  );
  // 테마를 생략한 설정 저장은 팀 테마를 유지한다.
  for (const body of [{ ...settings, theme: undefined }]) {
    assert.equal(
      (await request(`/teams/${tid}/settings`, { method: "PATCH", body }))
        .status,
      200,
    );
    assert.equal((await settingsFor(tid)).theme, "sky");
  }
  assert.equal((await patch({ theme: "rose" })).status, 200);
  assert.equal((await patch({ theme: "sand" })).status, 200);
  assert.equal((await patch({ name: "이름만 변경" })).status, 200);
  settings = await settingsFor(tid);
  assert.equal(settings.theme, "sand");
  assert.equal((await settingsFor(second)).theme, "mint");
  assert.equal(
    (
      await request(`/teams/${tid}/settings`, {
        method: "PATCH",
        body: { ...settings, theme: "bad-theme" },
      })
    ).status,
    400,
  );
  assert.equal((await settingsFor(tid)).theme, "sand");
});
async function filterFixture() {
  const tid = (await post("/admin/teams", { name: `필터 ${randomUUID()}` }))
    .data.id;
  const sessions = {};
  const userIds = {};
  for (const role of ["lead", "secondLead", "member", "viewer"]) {
    const username = `${role}-${randomUUID()}@example.com`;
    const password = "filter-role-test-password";
    const created = await post("/admin/users", {
      username,
      password,
      name: role,
      memberships: [
        { teamId: tid, role: role === "secondLead" ? "lead" : role },
      ],
    });
    assert.equal(created.status, 201);
    userIds[role] = created.data.user.id;
    sessions[role] = (await post("/auth/login", { username, password })).cookie;
  }
  const list = (cookie = sessions.lead) =>
    request(`/filters?teamId=${tid}`, { cookie });
  const save = (scope, name, data = {}, cookie = sessions.lead) =>
    request("/filters", {
      method: "PUT",
      cookie,
      body: { teamId: tid, scope, name, data },
    });
  const patch = (id, body, cookie = sessions.lead) =>
    request(`/filters/${id}`, { method: "PATCH", cookie, body });
  const remove = (id, cookie = sessions.lead) =>
    request(`/filters/${id}`, { method: "DELETE", cookie });
  return { tid, sessions, userIds, list, save, patch, remove };
}

test("필터 저장소·API·현재 선택에는 연도가 없고 개인 배치와 독립적으로 저장한다", async () => {
  const f = await filterFixture();
  const data = {
    propertyFilters: { status: ["status-completed"] },
    propertyFilterModes: { status: "exclude" },
  };
  assert.equal((await f.save("personal", "내 조건", data)).status, 200);
  const filter = (await f.list()).data.filters[0];
  assert.deepEqual(filter.data, data);
  for (const table of ["saved_filters", "filter_states"])
    assert.equal(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "year"),
      false,
    );
  assert.equal(
    (
      await request(`/filters?teamId=${f.tid}&year=2026`, {
        cookie: f.sessions.lead,
      })
    ).status,
    400,
  );
  for (const extra of [
    { year: 2026 },
    { widths: { title: 300 } },
    { groupBy: "status" },
  ])
    assert.equal(
      (await f.save("personal", "잘못된 필터", { ...data, ...extra })).status,
      400,
    );
  const saveCurrent = (body) =>
    request("/filters/current", {
      method: "PUT",
      cookie: f.sessions.lead,
      body: { teamId: f.tid, data, selectedId: filter.id, ...body },
    });
  assert.equal((await saveCurrent({})).status, 200);
  assert.equal((await saveCurrent({ year: 2026 })).status, 400);
  assert.equal((await saveCurrent({ selectedId: randomUUID() })).status, 404);
  const state = { selectedId: filter.id, data };
  for (const year of [2026, 2027]) {
    const layout = {
      ...defaultView(year),
      widths: { title: year - 1700 },
      ...data,
    };
    assert.equal(
      (
        await request("/views", {
          method: "PUT",
          cookie: f.sessions.lead,
          body: { teamId: f.tid, name: "__current", data: layout },
        })
      ).status,
      200,
    );
    assert.deepEqual((await f.list()).data.current, state);
    const views = (
      await request(`/views?teamId=${f.tid}&year=${year}`, {
        cookie: f.sessions.lead,
      })
    ).data.views;
    assert.equal(views.length, 1);
    assert.equal(views[0].data.propertyFilters, undefined);
    assert.equal(views[0].data.widths.title, year - 1700);
    const exported = await post(
      "/export",
      { teamId: f.tid, year, format: "json", scope: "all" },
      f.sessions.lead,
    );
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.data.filters, [filter]);
    assert.deepEqual(exported.data.currentFilters, state);
    assert.equal(exported.data.views[0].data.propertyFilters, undefined);
  }
  assert.equal(
    (
      await request("/views", {
        method: "PUT",
        cookie: f.sessions.lead,
        body: {
          teamId: f.tid,
          name: "이름 있는 필터",
          data: defaultView(2026),
        },
      })
    ).status,
    400,
  );
  const updated = { ...data, propertyFilters: { status: ["status-progress"] } };
  assert.equal((await f.patch(filter.id, { data: updated })).status, 200);
  assert.deepEqual((await f.list()).data.current, {
    selectedId: filter.id,
    data: updated,
  });
  assert.equal((await f.remove(filter.id)).status, 200);
  assert.deepEqual((await f.list()).data.filters, []);
  assert.equal((await f.list()).data.current.selectedId, "");
});

test("팀 공용은 팀장만 저장·수정·삭제하고 개인용은 본인에게만 노출한다", async () => {
  const f = await filterFixture();
  const data = { propertyFilters: { status: ["status-completed"] } };
  assert.equal((await f.save("team", "같은 이름", data)).status, 200);
  const shared = (await f.list()).data.filters[0];
  for (const [role, cookie] of Object.entries(f.sessions)) {
    assert.equal(
      (await f.save("personal", "같은 이름", {}, cookie)).status,
      200,
    );
    const response = (await f.list(cookie)).data;
    assert.equal(response.filters.length, 2);
    assert.equal(
      response.filters.find((v) => v.id === shared.id).canEdit,
      role === "lead" || role === "secondLead",
    );
    assert.equal(
      response.filters.filter((v) => v.scope === "personal").length,
      1,
    );
  }
  const personal = (await f.list()).data.filters.find(
    (v) => v.scope === "personal",
  );
  for (const cookie of [f.sessions.member, f.sessions.viewer, admin]) {
    assert.equal((await f.save("team", "같은 이름", {}, cookie)).status, 403);
    assert.equal((await f.save("team", "새 공용", {}, cookie)).status, 403);
    assert.equal(
      (await f.patch(shared.id, { name: "탈취", data: {} }, cookie)).status,
      403,
    );
    assert.equal((await f.remove(shared.id, cookie)).status, 403);
  }
  for (const cookie of [
    f.sessions.secondLead,
    f.sessions.member,
    f.sessions.viewer,
    admin,
  ]) {
    assert.equal(
      (await f.patch(personal.id, { name: "타인의 개인용" }, cookie)).status,
      404,
    );
    assert.equal((await f.remove(personal.id, cookie)).status, 404);
    assert.equal(
      (
        await request("/filters/current", {
          method: "PUT",
          cookie,
          body: { teamId: f.tid, selectedId: personal.id, data: {} },
        })
      ).status,
      404,
    );
  }
  assert.equal((await f.patch(personal.id, { scope: "team" })).status, 400);
  assert.equal((await f.list(other)).status, 403);
  assert.equal(
    (await f.patch(shared.id, { name: "다른 팀" }, other)).status,
    403,
  );
  assert.equal((await f.remove(shared.id, other)).status, 403);
  const another = (await post("/admin/teams", { name: "다른 팀 필터" })).data
    .id;
  assert.deepEqual(
    (await request(`/filters?teamId=${another}`)).data.filters,
    [],
  );
  const exported = await post(
    "/export",
    { teamId: f.tid, year: 2026, scope: "all", format: "json" },
    f.sessions.member,
  );
  assert.equal(exported.status, 200);
  assert.equal(exported.data.filters.length, 2);
  assert.equal(
    exported.data.filters.some((v) => v.id === personal.id),
    false,
  );
  assert.equal(
    (
      await f.patch(
        shared.id,
        { name: "팀장 수정", data: {} },
        f.sessions.secondLead,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.list(f.sessions.viewer)).data.filters.find(
      (v) => v.id === shared.id,
    ).name,
    "팀장 수정",
  );
  db.prepare(
    "UPDATE memberships SET role='member' WHERE user_id=? AND team_id=?",
  ).run(f.userIds.secondLead, f.tid);
  assert.equal(
    (await f.patch(shared.id, { name: "권한 회수 후" }, f.sessions.secondLead))
      .status,
    403,
  );
  assert.equal((await f.remove(shared.id, f.sessions.secondLead)).status, 403);
  assert.equal((await f.remove(shared.id)).status, 200);
  assert.equal((await f.list(f.sessions.member)).data.filters.length, 1);
});

test("필터 이름·조건 수정은 같은 구분의 중복과 잘못된 속성을 거절하고 다른 항목을 보존한다", async () => {
  const f = await filterFixture();
  const data = {
    propertyFilters: { status: ["status-completed"] },
    propertyFilterModes: { status: "exclude" },
  };
  for (const name of ["첫 필터", "다른 필터"])
    assert.equal((await f.save("personal", name, data)).status, 200);
  assert.equal((await f.save("team", "팀 이름", data)).status, 200);
  const original = (await f.list()).data.filters.find(
    (v) => v.name === "첫 필터",
  );
  const otherFilter = (await f.list()).data.filters.find(
    (v) => v.name === "다른 필터",
  );
  assert.equal((await f.patch(original.id, { name: "다른 필터" })).status, 409);
  for (const body of [
    {},
    { name: " " },
    { name: "a".repeat(61) },
    { data: { year: 2027 } },
    { data: { propertyFilters: { missing: ["x"] } } },
    {
      name: "실패해야 하는 이름",
      data: { propertyFilterModes: { status: "invalid" } },
    },
  ])
    assert.equal((await f.patch(original.id, body)).status, 400);
  assert.deepEqual(
    (await f.list()).data.filters.find((v) => v.id === original.id),
    original,
  );
  assert.equal(
    (await f.patch(original.id, { name: "  팀 이름  " })).status,
    200,
  );
  let changed = (await f.list()).data.filters.find((v) => v.id === original.id);
  assert.equal(changed.name, "팀 이름");
  assert.deepEqual(changed.data, data);
  assert.equal((await f.patch(original.id, { data: {} })).status, 200);
  changed = (await f.list()).data.filters.find((v) => v.id === original.id);
  assert.deepEqual(changed.data, {
    propertyFilters: {},
    propertyFilterModes: {},
  });
  assert.deepEqual(
    (await f.list()).data.filters.find((v) => v.id === otherFilter.id),
    otherFilter,
  );
  assert.equal(
    (await f.patch(randomUUID(), { name: "없는 필터" })).status,
    404,
  );
});

test("속성 보관 시 팀·개인 저장 필터와 현재 필터에서 해당 조건을 제거한다", async () => {
  const f = await filterFixture();
  const settings = (
    await request("/bootstrap", { cookie: f.sessions.lead })
  ).data.teams.find((t) => t.id === f.tid).settings;
  const property = { ...sampleProperties().find((p) => p.id === "category") };
  settings.properties.push(property);
  assert.equal(
    (
      await request(`/teams/${f.tid}/settings`, {
        method: "PATCH",
        cookie: f.sessions.lead,
        body: settings,
      })
    ).status,
    200,
  );
  const data = {
    propertyFilters: {
      category: ["category-ux"],
      status: ["status-completed"],
    },
    propertyFilterModes: { category: "exclude" },
  };
  for (const scope of ["team", "personal"])
    assert.equal((await f.save(scope, "보관 검사", data)).status, 200);
  assert.equal(
    (
      await request("/filters/current", {
        method: "PUT",
        cookie: f.sessions.member,
        body: { teamId: f.tid, selectedId: "", data },
      })
    ).status,
    200,
  );
  const latest = (
    await request("/bootstrap", { cookie: f.sessions.lead })
  ).data.teams.find((t) => t.id === f.tid).settings;
  latest.properties.find((p) => p.id === "category").archived = true;
  assert.equal(
    (
      await request(`/teams/${f.tid}/settings`, {
        method: "PATCH",
        cookie: f.sessions.lead,
        body: latest,
      })
    ).status,
    200,
  );
  const expected = {
    propertyFilters: { status: ["status-completed"] },
    propertyFilterModes: {},
  };
  for (const filter of (await f.list()).data.filters)
    assert.deepEqual(filter.data, expected);
  assert.deepEqual(
    (await f.list(f.sessions.member)).data.current.data,
    expected,
  );
  assert.equal(
    (
      await request(`/admin/teams/${f.tid}`, {
        method: "DELETE",
        body: { confirmed: true },
      })
    ).status,
    200,
  );
  for (const table of ["saved_filters", "filter_states"])
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE team_id=?`)
        .get(f.tid).n,
      0,
    );
});
