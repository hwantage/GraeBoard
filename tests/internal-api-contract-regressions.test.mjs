import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { sqliteFixture } from "./business-storage-fixture.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { unpack } from "../shared/compact.js";
import { defaultView } from "../shared/domain.js";
import { MAX_TASK_DOCUMENTS } from "../shared/task-documents.js";
import { encodeReport, decodeReport } from "../server/reports.mjs";
import { userWithTeams } from "../server/db.mjs";

async function fixture(t) {
  const f = sqliteFixture(t);
  const server = f.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const addUser = (role) => {
    const id = randomUUID();
    f.db
      .prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
      )
      .run(
        id,
        id + "@example.test",
        role || "outsider",
        new Date().toISOString(),
      );
    if (role)
      f.db
        .prepare("INSERT INTO memberships VALUES(?,?,?)")
        .run(id, f.teamId, role);
    f.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(
        createHash("sha256").update(id).digest("hex"),
        id,
        Date.now() + 60000,
      );
    return userWithTeams(
      f.db,
      f.db.prepare("SELECT * FROM users WHERE id=?").get(id),
    );
  };
  const call = async (
    path,
    { method = "GET", body, user = f.user, clientId } = {},
  ) => {
    const form = body instanceof FormData;
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: `weekly_session=${user.id}`,
        Origin: base,
        "X-Requested-With": "WeeklyPlan",
        ...(form ? {} : { "Content-Type": "application/json" }),
        ...(clientId ? { "X-Client-ID": clientId } : {}),
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    return { status: response.status, body: unpack(await response.json()) };
  };
  const expect = async (path, options, status, message) => {
    const response = await call(path, options);
    assert.equal(response.status, status, JSON.stringify(response));
    if (message) assert.equal(response.body.error, message);
    return response.body;
  };
  return { ...f, call, expect, viewer: addUser("viewer"), outsider: addUser() };
}
const save = (expectedRevision, markdown = "changed") => ({
  expectedRevision,
  markdown,
  operationId: randomUUID(),
});

test("B4/B6 calendar restores membership order, scope wording, missing-ID status and stamped conflicts", async (t) => {
  const f = await fixture(t),
    tags = `/api/calendar/teams/${f.teamId}/tags?scope=team&userId=${f.user.id}`;
  await f.expect(
    tags,
    { user: f.outsider },
    403,
    "이 팀에 접근할 권한이 없습니다.",
  );
  await f.expect(
    tags,
    {},
    400,
    "팀 공용 태그에는 개인 소유자를 지정할 수 없습니다.",
  );
  const entries = `/api/calendar?teamId=${f.teamId}&scope=team&userId=${f.user.id}&from=2026-10-01&to=2026-10-07`;
  await f.expect(
    entries,
    { user: f.outsider },
    403,
    "이 팀에 접근할 권한이 없습니다.",
  );
  await f.expect(
    entries,
    {},
    400,
    "팀 공용 일정에는 개인 소유자를 지정할 수 없습니다.",
  );
  await f.expect(
    `/api/calendar/teams/${f.teamId}/rule`,
    { method: "PUT", body: {}, user: f.outsider },
    403,
    "이 팀에 접근할 권한이 없습니다.",
  );
  await f.expect(
    "/api/calendar/entries/missing/document",
    {},
    404,
    "일정을 찾을 수 없습니다. 삭제되었을 수 있습니다.",
  );
  const result = await f.expect(
    `/api/calendar/entries/${f.entryId}/document`,
    { method: "PUT", body: save(10) },
    409,
    "다른 사용자가 일정을 수정했습니다. 입력은 보존됩니다. 최신 문서를 확인하세요.",
  );
  assert.equal(typeof result.details.current.sync.session, "string");
  assert.equal(typeof result.details.current.sync.sequence, "number");
});

test("B5 document and memo error contracts preserve scope-specific revisions, titles, permissions and limits", async (t) => {
  const f = await fixture(t),
    taskBase = `/api/tasks/${f.taskId}/documents`,
    reportBase = `/api/reports/${f.reportId}/tasks/${f.taskId}/documents`,
    memoBase = `/api/teams/${f.teamId}/years/2026/memos`;
  await f.expect(
    `${taskBase}/main`,
    { method: "DELETE", body: { expectedRevision: 10 } },
    409,
    "문서가 변경되었습니다. 최신 문서를 확인한 뒤 삭제하세요.",
  );
  await f.expect(
    `${taskBase}/main`,
    { method: "PUT", body: save(randomUUID()) },
    400,
  );
  await f.expect(`${reportBase}/main`, { method: "PUT", body: save(10) }, 400);
  const title = await f.expect(
    taskBase,
    { method: "POST", body: { id: randomUUID(), title: "가".repeat(51) } },
    400,
  );
  assert.ok(
    JSON.stringify(title).includes("문서 제목은 50자까지 입력할 수 있습니다."),
  );
  const id = randomUUID();
  const repeated = await f.expect(
    `${memoBase}/reorder`,
    { method: "POST", body: { ids: [id, id], expectedIds: [id] } },
    400,
  );
  assert.ok(
    JSON.stringify(repeated).includes("같은 메모를 중복 지정할 수 없습니다."),
  );
  await f.expect(
    `/api/reports/${f.reportId}/memos`,
    { method: "POST", body: { id }, user: f.viewer },
    403,
    "메모 편집 권한이 없습니다.",
  );
  const service = new DocumentBusinessService(
    f.app.locals.documentRepository,
    f.user,
  );
  for (const [scope, message] of [
    [
      { kind: "task", taskId: f.taskId },
      `업무마다 문서를 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
    ],
    [
      { kind: "annual", teamId: f.teamId, year: 2026 },
      `메모는 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
    ],
  ]) {
    let count = service.list(scope).documents.length;
    while (count++ < MAX_TASK_DOCUMENTS)
      service.create(scope, { id: randomUUID() });
    assert.throws(
      () => service.create(scope, { id: randomUUID() }),
      (error) => error.status === 400 && error.message === message,
    );
  }
  assert.throws(
    () =>
      new DocumentBusinessService(
        f.app.locals.documentRepository,
        f.viewer,
      ).imageAccess({ kind: "report", reportId: f.reportId, taskId: f.taskId }),
    (error) =>
      error.status === 403 &&
      error.message === "사본에 이미지를 추가할 권한이 없습니다.",
  );
});

test("B7 reports, import and history preserve the established authorization and validation order", async (t) => {
  const f = await fixture(t);
  const report = {
    teamId: f.teamId,
    year: 2026,
    name: "Mismatch",
    referenceDate: "2026-10-01",
    view: defaultView(2027),
    taskIds: [],
  };
  await f.expect(
    "/api/reports",
    { method: "POST", body: report, user: f.viewer },
    403,
    "사본을 만들 권한이 없습니다.",
  );
  const preview = (reportId) => {
    const form = new FormData();
    form.set("teamId", f.teamId);
    form.set("year", "2026");
    if (reportId) form.set("reportId", reportId);
    return form;
  };
  await f.expect(
    "/api/import/preview",
    { method: "POST", body: preview(), user: f.viewer },
    403,
    "팀장만 자료를 가져올 수 있습니다.",
  );
  await f.expect(
    "/api/import/preview",
    { method: "POST", body: preview(randomUUID()) },
    404,
    "사본을 찾을 수 없습니다.",
  );
  await f.expect(
    "/api/import/preview",
    { method: "POST", body: preview() },
    400,
    "가져올 XLSX 파일을 선택하세요.",
  );
  await f.expect(
    "/api/import/missing/apply",
    {
      method: "POST",
      body: {
        sheet: "test",
        year: 2026,
        personMap: {},
        mode: "copy",
        referenceDate: "2026-10-01",
        acceptWarnings: true,
      },
    },
    404,
    "이관 미리보기를 찾을 수 없습니다.",
  );
  await f.expect(
    `/api/audit?teamId=${f.teamId}&limit=bad`,
    { user: f.outsider },
    403,
    "이 팀에 접근할 권한이 없습니다.",
  );
  await f.expect(
    `/api/audit?teamId=${f.teamId}&limit=&taskId=&unused=1`,
    {},
    200,
  );
  await f.expect(
    "/api/audit/missing/restore",
    { method: "POST", body: { extra: true } },
    404,
    "이력을 찾을 수 없습니다.",
  );
});

test("B8/B9 settings, filters and tasks retain audit, ordering, missing-ID and duplicate-selection behavior", async (t) => {
  const f = await fixture(t),
    filter = { teamId: f.teamId, scope: "team", name: "saved", data: {} };
  await f.expect("/api/filters", { method: "PUT", body: filter }, 200);
  const saved = f.db
    .prepare("SELECT * FROM saved_filters WHERE name='saved'")
    .get();
  f.db
    .prepare(
      "UPDATE saved_filters SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
    .run(saved.id);
  await f.expect("/api/filters", { method: "PUT", body: filter }, 200);
  assert.ok(
    f.db
      .prepare("SELECT updated_at FROM saved_filters WHERE id=?")
      .get(saved.id).updated_at > "2000",
  );
  await f.expect(
    "/api/filters/missing",
    { method: "PATCH", body: { name: "rename" } },
    404,
  );
  const teamName = f.db
    .prepare("SELECT name FROM teams WHERE id=?")
    .get(f.teamId).name;
  const audits = () =>
    f.db
      .prepare("SELECT count(*) n FROM audit WHERE action='team-update'")
      .get().n;
  const before = audits();
  await f.expect(
    `/api/teams/${f.teamId}`,
    { method: "PATCH", body: { name: teamName } },
    200,
  );
  assert.equal(audits(), before + 1);
  for (const method of ["GET", "PUT"])
    await f.expect(
      `/api/teams/${f.teamId}/members`,
      { method, ...(method === "PUT" ? { body: {} } : {}), user: f.outsider },
      403,
      "이 팀에 접근할 권한이 없습니다.",
    );
  await f.expect(
    "/api/tasks/missing",
    { method: "PATCH", body: { updatedAt: "old" } },
    404,
    "업무를 찾을 수 없습니다.",
  );
  await f.expect(
    `/api/tasks?teamId=${f.teamId}&year=bad`,
    { user: f.outsider },
    403,
    "이 팀에 접근할 권한이 없습니다.",
  );
  const missing = randomUUID();
  await f.expect(
    "/api/tasks/reorder",
    {
      method: "POST",
      body: {
        tasks: [
          { id: missing, updatedAt: "old" },
          { id: missing, updatedAt: "old" },
        ],
        targetId: f.taskId,
        targetUpdatedAt: "old",
        year: 2026,
        placement: "before",
      },
    },
    400,
    "같은 업무를 중복 선택할 수 없습니다.",
  );
  const task = f.db
    .prepare("SELECT updated_at FROM tasks WHERE id=?")
    .get(f.taskId);
  const updated = await f.expect(
    `/api/tasks/${f.taskId}`,
    {
      method: "PATCH",
      body: { updatedAt: task.updated_at, years: [2026, 2026] },
    },
    200,
  );
  assert.deepEqual(updated.task.years, [2026, 2026]);
});

test("B2 resource invalidations carry the editing client ID through HTTP report and membership commands", async (t) => {
  const f = await fixture(t),
    calls = [],
    events = f.app.locals.documentEvents,
    invalidate = events.invalidate;
  events.invalidate = function (...args) {
    calls.push(args);
    return invalidate.apply(this, args);
  };
  const clientId = randomUUID();
  await f.expect(
    "/api/reports",
    {
      method: "POST",
      clientId,
      body: {
        teamId: f.teamId,
        year: 2026,
        name: "client event",
        referenceDate: "2026-10-01",
        view: defaultView(2026),
        taskIds: [f.taskId],
      },
    },
    201,
  );
  assert.ok(calls.some(([key]) => key === `team:${f.teamId}`));
  assert.ok(calls.some(([key]) => key.startsWith("report:")));
  assert.ok(
    calls.every(([, source]) => source === clientId),
    JSON.stringify(calls),
  );
  calls.length = 0;
  await f.expect(
    `/api/teams/${f.teamId}/members`,
    {
      method: "PUT",
      clientId,
      body: {
        members: [
          { userId: f.user.id, role: "lead" },
          { userId: f.viewer.id, role: "viewer" },
        ],
      },
    },
    200,
  );
  assert.ok(calls.length);
  assert.ok(
    calls.every(([, source]) => source === clientId),
    JSON.stringify(calls),
  );
});

test("B10 batch report documents read their task references once, including all requested tasks", (t) => {
  const f = sqliteFixture(t),
    report = decodeReport(
      f.db.prepare("SELECT data FROM reports WHERE id=?").get(f.reportId).data,
    ),
    other = randomUUID();
  report.tasks.push({ ...report.tasks[0], id: other });
  f.db
    .prepare("UPDATE reports SET data=? WHERE id=?")
    .run(encodeReport(report), f.reportId);
  const prepare = f.db.prepare,
    reads = [];
  f.db.prepare = function (sql) {
    if (/FROM report_documents r JOIN/.test(sql)) reads.push(sql);
    return prepare.call(this, sql);
  };
  try {
    const result = new DocumentBusinessService(
      f.app.locals.documentRepository,
      f.user,
    ).readBatch(f.reportId, [f.taskId, other]);
    assert.deepEqual(
      result.tasks.map((task) => task.id),
      [f.taskId, other],
    );
    assert.equal(
      reads.length,
      1,
      "one batch reference read; no initial one-task lookup",
    );
  } finally {
    f.db.prepare = prepare;
  }
});
