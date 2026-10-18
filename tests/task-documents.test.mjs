import {
  reportDocumentContents,
  readReport,
  storeReportDocuments,
  syncReportDocuments,
} from "../server/document-storage.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import sharp from "sharp";
import {
  documentImagePath,
  documentImageUrls,
} from "../server/document-images.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, insertTask, getTask, json, now } from "../server/db.mjs";
import { getTaskDocument } from "../server/task-documents.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { MAX_DOCUMENT_BYTES } from "../shared/task-documents.js";
import { backupDatabase } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";
import {
  decodeReport,
  encodeReport,
  reportBrowseIndex,
  reportDocumentIndex,
} from "../server/reports.mjs";

test("큰 사본의 목록 캐시와 별개로 문서 조회·저장의 메타데이터 캐시를 재사용한다", async (t) => {
  const f = await fixture(t);
  await f.save("캐시 검증 본문");
  const id = await f.report();
  const report = decodeReport(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(id).data,
  );
  report.settings.properties.push({
    id: "description",
    name: "설명",
    kind: "text",
    display: "text",
    values: [],
    visible: true,
  });
  const task = report.tasks[0];
  report.tasks = Array.from({ length: 10000 }, (_, i) => ({
    ...task,
    id: i ? randomUUID() : task.id,
    position: i,
    cells: { ...task.cells, description: { value: "가".repeat(1000) } },
  }));
  const data = encodeReport(report);
  f.db.prepare("UPDATE reports SET data=? WHERE id=?").run(data, id);
  const index = reportDocumentIndex(data);
  // Property values exceed the browse cache budget; document metadata still fits.
  reportBrowseIndex(data);
  assert.ok(reportDocumentIndex(data) === index);
  const path = `/reports/${id}/tasks/${task.id}/documents/main`;
  assert.equal((await f.req(path)).data.markdown, "캐시 검증 본문");
  assert.equal((await f.saveReport(id, "캐시 이후 저장")).status, 200);
  assert.equal((await f.req(path)).data.markdown, "캐시 이후 저장");
  assert.ok(reportDocumentIndex(data) === index);
});

test("사본 본문 자동 저장은 표 BLOB을 다시 쓰지 않고 최신 참조를 복제·반출·복구한다", async (t) => {
  const f = await fixture(t);
  await f.save("원본 본문");
  const id = await f.report();
  const path = `/reports/${id}`;
  const docPath = `${path}/tasks/${f.task.id}/documents/main`;
  const initial = (await f.req(path)).data;
  const before = f.db
    .prepare("SELECT data FROM reports WHERE id=?")
    .get(id).data;
  const saved = await f.saveReport(id, "사본의 최신 본문");
  assert.equal(saved.status, 200);
  assert.deepEqual(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(id).data,
    before,
  );
  assert.equal((await f.req(path)).data.revision, initial.revision);
  assert.equal((await f.req(docPath)).data.markdown, "사본의 최신 본문");
  await f.saveReport(id, "");
  assert.equal((await f.req(path)).data.tasks[0].hasDocument, false);
  await f.saveReport(id, "본문만 다시 저장");
  assert.deepEqual(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(id).data,
    before,
  );
  assert.equal((await f.req(path)).data.tasks[0].hasDocument, true);
  const clone = await f.req("/reports", "POST", {
    teamId: f.teamId,
    sourceId: id,
    year: 2026,
    name: "최신 본문 복제",
    referenceDate: "2026-10-17",
    view: defaultView(2026),
    taskIds: [],
  });
  assert.equal(clone.status, 201);
  assert.equal(
    (await f.req(`/reports/${clone.data.id}/tasks/${f.task.id}/document`)).data
      .markdown,
    "본문만 다시 저장",
  );
  const exported = await f.req("/export", "POST", {
    teamId: f.teamId,
    year: 2026,
    format: "json",
    scope: "all",
  });
  assert.equal(exported.status, 200);
  assert.ok(
    exported.data.reports.every(
      (report) =>
        report.data.tasks[0].documents[0].markdown === "본문만 다시 저장",
    ),
  );
  const backup = backupDatabase(f.path, join(f.dir, "fast-body.sqlite"));
  const recovered = openDatabase(
    restoreDatabase(backup, join(f.dir, "fast-restored.sqlite")),
  );
  try {
    const row = recovered.prepare("SELECT * FROM reports WHERE id=?").get(id);
    assert.equal(
      reportDocumentContents(recovered, readReport(recovered, row)).tasks[0]
        .documents[0].markdown,
      "본문만 다시 저장",
    );
  } finally {
    recovered.close();
  }
  const renamed = await f.req(docPath, "PATCH", {
    title: "바뀐 제목",
    expectedTitle: "문서 1",
  });
  assert.equal(renamed.status, 200);
  assert.equal((await f.req(docPath)).data.markdown, "본문만 다시 저장");
  const deleted = await f.req(path, "PATCH", {
    operationId: randomUUID(),
    revision: initial.revision,
    operations: [{ kind: "delete", taskIds: [f.task.id], at: now() }],
  });
  assert.equal(deleted.status, 200);
  const history = (await f.req(`/audit?teamId=${f.teamId}&sheetId=${id}`)).data
    .entries;
  const deletion = history.find((entry) =>
    entry.restorableTaskIds.includes(f.task.id),
  );
  assert.equal(
    (
      await f.req(`/audit/${deletion.id}/restore`, "POST", {
        revision: deleted.data.revision,
      })
    ).status,
    200,
  );
  assert.equal((await f.req(docPath)).data.markdown, "본문만 다시 저장");
  assert.equal((await f.req(docPath)).data.title, "바뀐 제목");
  assert.equal(getTaskDocument(f.db, f.task.id).markdown, "원본 본문");
});

test("사본 문서 일괄 조회는 권한·없는 행을 검사하고 문서 없는 행도 함께 반환한다", async (t) => {
  const f = await fixture(t);
  const created = await f.req("/reports", "POST", {
    teamId: f.teamId,
    year: 2026,
    name: "일괄 조회",
    referenceDate: "2026-10-17",
    view: defaultView(2026),
    taskIds: [f.task.id, f.unassigned.id],
  });
  const id = created.data.id;
  const path = `/reports/${id}/documents/batch`;
  const taskIds = [f.task.id, f.unassigned.id];
  await f.saveReport(id, "조회 직전에 추가한 문서");
  const found = await f.req(path, "POST", { taskIds }, "viewer");
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.tasks, [
    {
      id: f.task.id,
      documents: [
        { id: "main", title: "문서 1", markdown: "조회 직전에 추가한 문서" },
      ],
    },
    { id: f.unassigned.id, documents: [] },
  ]);
  assert.equal(
    (await f.req(path, "POST", { taskIds }, "outsider")).status,
    403,
  );
  assert.equal(
    (await f.req(path, "POST", { taskIds: [...taskIds, randomUUID()] })).status,
    404,
  );
  assert.equal(
    (await f.req(path, "POST", { taskIds: Array(101).fill(f.task.id) })).status,
    400,
  );
});

test("큰 문서 여러 행의 일괄 조회는 응답 크기를 나누고 다음 행부터 이어 읽는다", async (t) => {
  const f = await fixture(t);
  const id = await f.report();
  const row = f.db.prepare("SELECT * FROM reports WHERE id=?").get(id);
  const report = readReport(f.db, row);
  const tasks = storeReportDocuments(
    f.db,
    [f.task, f.unassigned].map((task) => ({
      ...task,
      documents: Array.from({ length: 20 }, (_, index) => ({
        id: randomUUID(),
        title: `문서 ${index + 1}`,
        markdown: "x".repeat(MAX_DOCUMENT_BYTES),
      })),
    })),
    f.teamId,
    f.people.lead.id,
  );
  f.db
    .prepare("UPDATE reports SET data=? WHERE id=?")
    .run(encodeReport({ ...report, tasks }), id);
  syncReportDocuments(f.db, id, tasks);
  const path = `/reports/${id}/documents/batch`;
  const first = await f.req(path, "POST", {
    taskIds: tasks.map((task) => task.id),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.data.tasks.map((task) => task.id),
    [f.task.id],
  );
  assert.equal(first.data.tasks[0].documents.length, 20);
  const second = await f.req(path, "POST", { taskIds: [f.unassigned.id] });
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.data.tasks.map((task) => task.id),
    [f.unassigned.id],
  );
  assert.ok(
    second.data.tasks[0].documents.every(
      (doc) => doc.markdown.length === MAX_DOCUMENT_BYTES,
    ),
  );
});

async function fixture(t, { imagesFromEnv = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "task-documents-")),
    path = join(dir, "source.sqlite");
  const db = openDatabase(path),
    teamId = randomUUID(),
    otherTeam = randomUUID();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.properties.push({
    id: "supporters",
    name: "지원자",
    kind: "member",
    display: "text",
    multiple: true,
    values: [],
    visible: true,
  });
  for (const team of [teamId, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      team,
      "문서 검증",
      json(settings),
    );
  const people = {};
  for (const role of ["lead", "member", "supporter", "viewer", "outsider"]) {
    const id = randomUUID(),
      token = randomUUID();
    db.prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,?,?)",
    ).run(id, `${role}@example.com`, role, "unused", now());
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      id,
      role === "outsider" ? otherTeam : teamId,
      role === "lead" || role === "viewer" ? role : "member",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(token).digest("hex"),
      id,
      Date.now() + 3600000,
    );
    people[role] = { id, token };
  }
  const task = insertTask(db, {
    teamId,
    year: 2026,
    actorId: people.lead.id,
    fields: {
      title: "문서가 있는 업무",
      owner: people.member.id,
      supporters: [people.supporter.id],
    },
  });
  const unassigned = insertTask(db, {
    teamId,
    year: 2026,
    actorId: people.lead.id,
    fields: { title: "다른 사람의 업무", owner: people.lead.id },
  });
  const images = join(dir, "custom-images");
  const previousImageDirectory = process.env.DOCUMENT_IMAGES_DIR;
  if (imagesFromEnv) process.env.DOCUMENT_IMAGES_DIR = images;
  let app;
  try {
    app = createApp({
      db,
      rateLimits: false,
      ...(imagesFromEnv ? {} : { documentImagesDir: images }),
    });
  } finally {
    if (previousImageDirectory === undefined)
      delete process.env.DOCUMENT_IMAGES_DIR;
    else process.env.DOCUMENT_IMAGES_DIR = previousImageDirectory;
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function req(path, method = "GET", body, role = "lead", headers = {}) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          ...(role ? { Cookie: `weekly_session=${people[role].token}` } : {}),
          "X-Requested-With": "WeeklyPlan",
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : json(body) }),
      },
    );
    return {
      status: response.status,
      data:
        response.status === 304
          ? null
          : response.headers.get("content-type")?.includes("json")
            ? unpack(await response.json())
            : Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
    };
  }
  const save = (
    markdown,
    expectedRevision = 0,
    role = "lead",
    taskId = task.id,
    operationId = randomUUID(),
  ) =>
    req(
      `/tasks/${taskId}/document`,
      "PUT",
      { markdown, expectedRevision, operationId },
      role,
    );
  const report = async (name = "보존 보고본") =>
    (
      await req("/reports", "POST", {
        teamId,
        year: 2026,
        name,
        referenceDate: "2026-10-14",
        view: defaultView(2026),
        taskIds: [task.id],
      })
    ).data.id;
  async function saveReport(
    reportId,
    markdown,
    taskId = task.id,
    role = "lead",
    expectedRevision,
    operationId = randomUUID(),
  ) {
    const path = `/reports/${reportId}/tasks/${taskId}/document`;
    const revision = expectedRevision ?? (await req(path)).data.revision;
    return req(
      path,
      "PUT",
      { markdown, expectedRevision: revision, operationId },
      role,
    );
  }
  return {
    db,
    dir,
    path,
    images,
    task,
    unassigned,
    teamId,
    people,
    req,
    save,
    report,
    saveReport,
  };
}

test("문서 API: 권한·UTF-8 크기·자료형·버전·재시도·목록 메타데이터", async (t) => {
  const f = await fixture(t),
    route = `/tasks/${f.task.id}/document`;
  assert.deepEqual((await f.req(route)).data, {
    id: "main",
    title: "문서 1",
    markdown: "",
    revision: 0,
    updatedAt: null,
  });
  const beforeList = await f.req(`/tasks?teamId=${f.teamId}&year=2026`);
  assert.equal((await f.req(route, "GET", undefined, "viewer")).status, 200);
  assert.equal((await f.req(route, "GET", undefined, "outsider")).status, 403);
  assert.equal((await f.save("금지", 0, "viewer")).status, 403);
  assert.equal((await f.save("금지", 0, "outsider")).status, 403);
  assert.equal(
    (await f.save("금지", 0, "member", f.unassigned.id)).status,
    403,
  );
  for (const markdown of [
    null,
    {},
    "한".repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3)),
  ])
    assert.equal((await f.save(markdown)).status, 400);
  const operationId = randomUUID(),
    markdown = "# 한글 문서\n\n- [ ] 검토\n\n**중요**";
  const saved = await f.save(markdown, 0, "member", f.task.id, operationId);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.hasDocument, true);
  assert.equal(saved.data.documentCount, 1);
  assert.deepEqual(
    (await f.save(markdown, 0, "member", f.task.id, operationId)).data,
    saved.data,
  );
  const auditCount = () =>
    f.db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action='document'")
      .get().n;
  assert.equal(auditCount(), 1);
  assert.equal((await f.save(markdown, 1)).data.revision, 1);
  assert.equal(auditCount(), 1);
  const conflict = await f.save("다른 입력", 0);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details.current.markdown, markdown);
  const list = await f.req(
    `/tasks?teamId=${f.teamId}&year=2026`,
    "GET",
    undefined,
    "lead",
    { "If-None-Match": beforeList.headers.get("etag") },
  );
  assert.equal(list.status, 200);
  assert.equal(
    list.data.tasks.find((t) => t.id === f.task.id).hasDocument,
    true,
  );
  assert.ok(!JSON.stringify(list.data).includes("한글 문서"));
  assert.ok(!("document" in list.data.tasks[0]));
  assert.equal(
    (await f.save("지원자가 수정", 1, "supporter")).data.revision,
    2,
  );
  assert.equal(
    (await f.save(markdown, 0, "member", f.task.id, operationId)).status,
    409,
    "후속 수정 뒤 성공 응답을 재적용하지 않음",
  );
  f.db
    .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
    .run(f.people.member.id);
  assert.equal(
    (await f.save(markdown, 0, "member", f.task.id, operationId)).status,
    403,
    "재시도에도 현재 권한 적용",
  );
  const cleared = await f.save(" \n\n", 2);
  assert.equal(cleared.data.hasDocument, false);
  assert.equal(cleared.data.documentCount, 1, "본문을 비워도 문서는 남는다");
  assert.equal(cleared.data.revision, 3);
  assert.ok(!getTask(f.db, f.task.id).hasDocument);
  assert.equal((await f.req(route)).data.markdown, " \n\n", "원문 그대로 저장");
});

test("문서 복제·행 붙여넣기·휴지통·백업 복구·JSON과 스냅샷이 독립 본문을 보존", async (t) => {
  const f = await fixture(t),
    original = "# 저장 당시\n\n원본 문서";
  await f.save(original);
  const duplicate = (
    await f.req("/tasks", "POST", {
      teamId: f.teamId,
      year: 2026,
      sourceId: f.task.id,
    })
  ).data.task;
  const copied = (
    await f.req("/tasks", "POST", {
      teamId: f.teamId,
      year: 2026,
      copiedRow: {
        cells: { title: { value: "붙여넣기", style: {} } },
        defaultStyle: {},
        documents: [{ id: "main", title: "문서 1", markdown: original }],
      },
    })
  ).data.task;
  const reportId = await f.report();
  let snapshot = (await f.req(`/reports/${reportId}`)).data;
  assert.equal(snapshot.tasks[0].hasDocument, true);
  assert.ok(!("document" in snapshot.tasks[0]));
  const reportDocPath = `/reports/${reportId}/tasks/${f.task.id}/document?revision=${snapshot.revision}`;
  assert.equal((await f.req(reportDocPath)).data.markdown, original);
  assert.equal(
    (await f.req(reportDocPath, "GET", undefined, "outsider")).status,
    403,
  );
  await f.save("원본만 수정", 1);
  assert.equal(
    (await f.req(`/tasks/${duplicate.id}/document`)).data.markdown,
    original,
  );
  assert.equal(
    (await f.req(`/tasks/${copied.id}/document`)).data.markdown,
    original,
  );
  const exported = await f.req("/export", "POST", {
    teamId: f.teamId,
    year: 2026,
    format: "json",
    scope: "all",
  });
  assert.equal(exported.data.schemaVersion, 5);
  assert.equal(
    exported.data.tasks.find((t) => t.id === f.task.id).documents[0].markdown,
    "원본만 수정",
  );
  assert.equal(
    exported.data.reports[0].data.tasks[0].documents[0].markdown,
    original,
  );
  const deleted = await f.req(`/tasks/${f.task.id}`, "DELETE", {
    updatedAt: getTask(f.db, f.task.id).updatedAt,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await f.req(`/tasks/${f.task.id}/document`)).status, 404);
  assert.equal((await f.save("삭제 후 저장", 2)).status, 404);
  assert.equal((await f.req(reportDocPath)).data.markdown, original);
  assert.equal(
    (await f.req(`/tasks/${f.task.id}/restore`, "POST", {})).status,
    200,
  );
  assert.equal(
    (await f.req(`/tasks/${f.task.id}/document`)).data.markdown,
    "원본만 수정",
  );
  const backup = backupDatabase(f.path, join(f.dir, "backup.sqlite"));
  const recovered = openDatabase(
    restoreDatabase(backup, join(f.dir, "recovered.sqlite")),
  );
  try {
    assert.equal(getTaskDocument(recovered, f.task.id).markdown, "원본만 수정");
    assert.equal(
      reportDocumentContents(
        recovered,
        readReport(
          recovered,
          recovered.prepare("SELECT * FROM reports WHERE id=?").get(reportId),
        ),
      ).tasks[0].documents[0].markdown,
      original,
    );
  } finally {
    recovered.close();
  }
});

test("보고본 문서 수정은 revision·권한·원자성·재시도를 검사하며 원본을 바꾸지 않음", async (t) => {
  const f = await fixture(t);
  await f.save("원본");
  const reportId = await f.report(),
    report = (await f.req(`/reports/${reportId}`)).data;
  const path = `/reports/${reportId}/tasks/${f.task.id}/document`;
  const initial = (await f.req(path)).data;
  const body = {
    operationId: randomUUID(),
    expectedRevision: initial.revision,
    markdown: "보고본만 수정",
  };
  for (const role of ["viewer", "outsider"])
    assert.equal((await f.req(path, "PUT", body, role)).status, 403);
  assert.equal(
    (await f.saveReport(reportId, "없는 업무", f.unassigned.id, "lead", 0))
      .status,
    404,
  );
  assert.equal(
    (
      await f.req(path, "PUT", {
        ...body,
        markdown: "한".repeat(MAX_DOCUMENT_BYTES),
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.req(`/reports/${reportId}`)).data.revision,
    report.revision,
  );
  const saved = await f.req(path, "PUT", body);
  assert.equal(saved.status, 200);
  assert.notEqual(saved.data.revision, initial.revision);
  assert.deepEqual((await f.req(path, "PUT", body)).data, saved.data);
  const conflict = await f.req(path, "PUT", {
    ...body,
    operationId: randomUUID(),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details.current.markdown, "보고본만 수정");
  assert.equal(
    (await f.req(`/reports/${reportId}`)).data.revision,
    report.revision,
    "문서 저장은 표 revision을 변경하지 않는다",
  );
  assert.equal((await f.req(path)).data.markdown, "보고본만 수정");
  assert.equal(
    (await f.req(`/tasks/${f.task.id}/document`)).data.markdown,
    "원본",
  );
  const newId = randomUUID();
  const copied = await f.req(`/reports/${reportId}`, "PATCH", {
    operationId: randomUUID(),
    revision: report.revision,
    operations: [
      {
        kind: "create",
        at: now(),
        taskId: newId,
        sourceId: f.task.id,
        fields: {},
      },
    ],
  });
  assert.equal(copied.status, 200);
  assert.equal(
    (
      await f.req(
        `/reports/${reportId}/tasks/${newId}/document?revision=${copied.data.revision}`,
      )
    ).data.markdown,
    "보고본만 수정",
  );
  // The detail popup sends copiedRow along with sourceId so its local draft
  // can display the lazily loaded body immediately. Preserve the server ref.
  const detailCopyId = randomUUID();
  const detailCopy = await f.req(`/reports/${reportId}`, "PATCH", {
    operationId: randomUUID(),
    revision: copied.data.revision,
    operations: [
      {
        kind: "create",
        at: now(),
        taskId: detailCopyId,
        sourceId: f.task.id,
        fields: {},
        copiedRow: {
          cells: { title: { value: "상세 복제", style: {} } },
          defaultStyle: {},
          documents: [
            { id: "main", title: "문서 1", markdown: "보고본만 수정" },
          ],
        },
      },
    ],
  });
  assert.equal(detailCopy.status, 200);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM document_versions").get().n,
    2,
  );
  const refs = f.db
    .prepare("SELECT version_id FROM report_documents WHERE report_id=?")
    .all(reportId);
  assert.equal(refs.length, 3);
  assert.equal(new Set(refs.map((r) => r.version_id)).size, 1);
  const changedCopy = await f.saveReport(
    reportId,
    "복제한 행만 변경",
    detailCopyId,
  );
  assert.equal(changedCopy.status, 200);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM document_versions").get().n,
    3,
  );
  assert.equal(
    (
      await f.req(
        `/reports/${reportId}/tasks/${f.task.id}/document?revision=${detailCopy.data.revision}`,
      )
    ).data.markdown,
    "보고본만 수정",
  );
});

test("본문 없는 기존 스냅샷과 문서 삭제 표시, 팀 영구 삭제", async (t) => {
  const f = await fixture(t),
    reportId = await f.report();
  const report = (await f.req(`/reports/${reportId}`)).data;
  assert.equal(
    (
      await f.req(
        `/reports/${reportId}/tasks/${f.task.id}/document?revision=${report.revision}`,
      )
    ).data.markdown,
    "",
  );
  assert.equal((await f.saveReport(reportId, "처음 작성")).status, 200);
  const cleared = await f.saveReport(reportId, "");
  assert.equal(cleared.status, 200);
  assert.ok(!cleared.data.hasDocument);
  await f.save("삭제할 문서");
  f.db
    .prepare("UPDATE users SET system_role='admin' WHERE id=?")
    .run(f.people.lead.id);
  assert.equal(
    (await f.req(`/admin/teams/${f.teamId}`, "DELETE", { confirmed: true }))
      .status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM task_documents").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM document_versions").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM report_documents").get().n,
    0,
  );
});

test("표의 미저장 변경과 문서 저장은 충돌하지 않고 표의 재시도도 새 문서를 보존한다", async (t) => {
  const f = await fixture(t);
  await f.save("원문");
  const id = await f.report();
  const sheet = (await f.req(`/reports/${id}`)).data;
  const request = {
    operationId: randomUUID(),
    revision: sheet.revision,
    operations: [
      {
        kind: "cells",
        at: now(),
        changes: [
          {
            taskId: f.task.id,
            key: "title",
            value: "표에서 고친 제목",
            expectedVersion: f.task.cells.title.version,
          },
        ],
      },
    ],
  };
  const doc = await f.saveReport(id, "독립 문서 저장");
  assert.equal(doc.status, 200);
  const beforeSheet = (await f.req(`/reports/${id}`)).data;
  assert.equal(
    beforeSheet.tasks[0].cells.title.value,
    f.task.cells.title.value,
  );
  assert.equal(beforeSheet.revision, sheet.revision);
  const savedSheet = await f.req(`/reports/${id}`, "PATCH", request);
  assert.equal(savedSheet.status, 200);
  assert.notEqual(savedSheet.data.revision, sheet.revision);
  assert.equal(
    (await f.req(`/reports/${id}/tasks/${f.task.id}/document`)).data.markdown,
    "독립 문서 저장",
  );
  const secondDoc = await f.saveReport(
    id,
    "표 저장 후 문서 저장",
    f.task.id,
    "lead",
    doc.data.revision,
  );
  assert.equal(secondDoc.status, 200, "문서 revision은 표 저장과 무관하다");
  const replay = await f.req(`/reports/${id}`, "PATCH", request);
  assert.equal(
    replay.status,
    200,
    "표 응답 유실 후 재시도는 중간 문서 저장과 무관하다",
  );
  assert.equal(
    (await f.req(`/reports/${id}/tasks/${f.task.id}/document`)).data.markdown,
    "표 저장 후 문서 저장",
  );
  assert.equal(
    (
      await f.req(`/reports/${id}`, "PATCH", {
        ...request,
        operationId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(`/reports/${id}`, "PATCH", {
        operationId: randomUUID(),
        revision: savedSheet.data.revision,
        operations: [
          {
            kind: "document",
            at: now(),
            taskId: f.task.id,
            markdown: "표 요청에 섞은 문서",
          },
        ],
      })
    ).status,
    400,
  );
});

test("이미지 업로드는 권한·실제 형식·크기를 검사하고 팀별 파일을 재사용한다", async (t) => {
  const f = await fixture(t, { imagesFromEnv: true });
  const png = await sharp({
    create: { width: 48, height: 32, channels: 4, background: "#347d73" },
  })
    .png()
    .toBuffer();
  const upload = (
    role = "member",
    taskId = f.task.id,
    bytes = png,
    filename = "메모.png",
  ) => {
    const body = new FormData();
    body.append("image", new Blob([bytes], { type: "image/png" }), filename);
    return f.req(`/tasks/${taskId}/document/images`, "POST", body, role);
  };
  for (const role of ["viewer", "outsider"])
    assert.equal((await upload(role)).status, 403);
  assert.equal((await upload("member", f.unassigned.id)).status, 403);
  assert.equal((await upload(null)).status, 401);
  assert.equal(
    existsSync(f.images),
    false,
    "권한 없는 요청은 파일을 남기지 않는다",
  );
  for (const bytes of [
    Buffer.from("not an image"),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    ),
  ])
    assert.equal((await upload("member", f.task.id, bytes)).status, 400);
  assert.equal(
    (await upload("member", f.task.id, Buffer.alloc(10 * 1024 * 1024 + 1)))
      .status,
    413,
  );
  const first = await upload();
  assert.equal(first.status, 201);
  const url = first.data.url;
  assert.match(
    url,
    new RegExp(`^/api/document-images/${f.teamId}/[a-f0-9]{64}\\.webp$`),
  );
  assert.equal(
    (await upload("supporter", f.task.id, png, "다른이름.png")).data.url,
    url,
  );
  assert.equal(readdirSync(join(f.images, f.teamId)).length, 1);
  const image = await f.req(url.slice(4), "GET", undefined, "viewer");
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  assert.match(image.headers.get("cache-control"), /no-store/);
  assert.equal((await sharp(image.data).metadata()).width, 48);
  assert.equal(
    (await f.req(url.slice(4), "GET", undefined, "outsider")).status,
    403,
  );
  assert.equal((await f.req(url.slice(4), "GET", undefined, null)).status, 401);
  assert.equal((await f.save(`![메모](${url})`, 0, "member")).status, 200);
  const missing = url.replace(/[a-f0-9]{64}\.webp$/, "0".repeat(64) + ".webp");
  assert.equal((await f.save(`![없음](${missing})`, 1)).status, 400);
  assert.equal(
    (await f.save(`![다른 팀](${url.replace(f.teamId, randomUUID())})`, 1))
      .status,
    400,
  );
  assert.equal(
    (await f.save(`\`![예제](${missing})\``, 1)).status,
    200,
    "코드에 쓴 예제 URL은 실제 이미지가 아니다",
  );
  assert.deepEqual(documentImageUrls(`![메모][ref]\n\n[ref]: ${url}`), [url]);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM document_versions").get().n,
    1,
  );
});

test("문서 이미지가 스냅샷·행 복사·JSON·설정 경로의 백업 복구에서 보존된다", async (t) => {
  const f = await fixture(t);
  const png = await sharp({
    create: { width: 100, height: 60, channels: 3, background: "#caebda" },
  })
    .png()
    .toBuffer();
  const form = () => {
    const body = new FormData();
    body.append("image", new Blob([png]), "image.png");
    return body;
  };
  const uploaded = await f.req(
    `/tasks/${f.task.id}/document/images`,
    "POST",
    form(),
  );
  assert.equal(uploaded.status, 201);
  const url = uploaded.data.url;
  const markdown = `# 이미지 문서\n\n![붙여넣은 메모](${url}#width=64)\n\n![다른 크기로 보기](${url}#width=96)`;
  assert.deepEqual(
    documentImageUrls(markdown),
    [url],
    "표시 너비가 달라도 실제 파일은 한 번만 보관한다",
  );
  for (const suffix of [
    "#width=0",
    "#width=31",
    "#width=4097",
    "#width=NaN",
    "#width=1e3",
    "#width=80&x=1",
    "?width=80",
  ]) {
    assert.equal((await f.save(`![잘못된 크기](${url}${suffix})`)).status, 400);
  }
  assert.equal((await f.save(markdown)).status, 200);
  const id = await f.report();
  const imagePath = `/reports/${id}/tasks/${f.task.id}/document/images`;
  assert.equal((await f.req(imagePath, "POST", form(), "viewer")).status, 403);
  assert.equal((await f.req(imagePath, "POST", form())).data.url, url);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM document_versions").get().n,
    1,
    "붙여넣기 업로드만으로 문서를 복사하지 않는다",
  );
  assert.equal(
    (await f.saveReport(id, markdown + "\n\n보관 메모")).status,
    200,
  );
  await f.save("원본에서 이미지 삭제", 1);
  const copied = await f.req("/tasks", "POST", {
    teamId: f.teamId,
    year: 2026,
    copiedRow: {
      cells: { title: { value: "보관 문서 복사", style: {} } },
      defaultStyle: {},
      documents: [{ id: "main", title: "문서 1", markdown }],
    },
  });
  assert.equal(copied.status, 201);
  const exported = await f.req("/export", "POST", {
    teamId: f.teamId,
    year: 2026,
    format: "json",
    scope: "all",
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.documentImages.length, 1);
  assert.equal(exported.data.documentImages[0].url, url);
  assert.deepEqual(
    Buffer.from(exported.data.documentImages[0].base64, "base64"),
    readFileSync(documentImagePath(f.images, url)),
  );
  assert.equal(readdirSync(join(f.images, f.teamId)).length, 1);
  const backup = join(f.dir, "bundle.sqlite");
  backupDatabase(f.path, backup, { documentImagesDir: f.images });
  assert.ok(existsSync(documentImagePath(backup + ".images", url)));
  const restoredImages = join(f.dir, "restored-assets");
  const restoredPath = restoreDatabase(backup, join(f.dir, "restored.sqlite"), {
    documentImagesDir: restoredImages,
  });
  assert.deepEqual(
    readFileSync(documentImagePath(restoredImages, url)),
    readFileSync(documentImagePath(f.images, url)),
  );
  const restored = openDatabase(restoredPath);
  try {
    assert.match(
      reportDocumentContents(
        restored,
        readReport(
          restored,
          restored.prepare("SELECT * FROM reports WHERE id=?").get(id),
        ),
      ).tasks[0].documents[0].markdown,
      /api\/document-images/,
    );
    assert.equal(
      restored.prepare("SELECT count(*) AS n FROM sessions").get().n,
      0,
    );
  } finally {
    restored.close();
  }
  writeFileSync(documentImagePath(backup + ".images", url), "corrupt");
  const rejectedPath = join(f.dir, "rejected.sqlite");
  assert.throws(
    () =>
      restoreDatabase(backup, rejectedPath, {
        documentImagesDir: join(f.dir, "rejected-assets"),
      }),
    /무결성/,
  );
  assert.equal(existsSync(rejectedPath), false);
  rmSync(documentImagePath(f.images, url));
  const incomplete = join(f.dir, "incomplete.sqlite");
  assert.throws(() =>
    backupDatabase(f.path, incomplete, { documentImagesDir: f.images }),
  );
  assert.equal(existsSync(incomplete), false);
  assert.equal(existsSync(incomplete + ".images"), false);
  assert.equal(
    (await f.req(`/tasks/${f.task.id}/document/images`, "POST", form())).status,
    201,
  );
  assert.equal(existsSync(documentImagePath(f.images, url)), true);
  f.db
    .prepare("UPDATE users SET system_role='admin' WHERE id=?")
    .run(f.people.lead.id);
  assert.equal(
    (await f.req(`/admin/teams/${f.teamId}`, "DELETE", { confirmed: true }))
      .status,
    200,
  );
  assert.equal(existsSync(join(f.images, f.teamId)), false);
  assert.equal(
    existsSync(documentImagePath(backup + ".images", url)),
    true,
    "팀 삭제는 별도 백업 파일을 삭제하지 않는다",
  );
});

test("원본과 사본 문서 제목의 생성·이름 변경은 50자까지 허용하고 초과 입력을 거부한다", async (t) => {
  const f = await fixture(t);
  const copy = await f.report("제목 제한 사본");
  for (const base of [
    `/tasks/${f.task.id}/documents`,
    `/reports/${copy}/tasks/${f.task.id}/documents`,
  ]) {
    const id = randomUUID();
    const before = (await f.req(base)).data.documents;
    assert.equal(
      (await f.req(base, "POST", { id, title: "가".repeat(51) })).status,
      400,
    );
    assert.deepEqual((await f.req(base)).data.documents, before);
    assert.equal(
      (await f.req(base, "POST", { id, title: "가".repeat(50) })).status,
      201,
    );
    assert.equal(
      (
        await f.req(`${base}/${id}`, "PATCH", {
          title: "나".repeat(51),
          expectedTitle: "가".repeat(50),
        })
      ).status,
      400,
    );
    assert.equal((await f.req(`${base}/${id}`)).data.title, "가".repeat(50));
    assert.equal(
      (
        await f.req(`${base}/${id}`, "PATCH", {
          title: "나".repeat(50),
          expectedTitle: "가".repeat(50),
        })
      ).status,
      200,
    );
    assert.equal((await f.req(`${base}/${id}`)).data.title, "나".repeat(50));
  }
});

test("여러 문서의 추가·제목·본문·삭제와 사본끼리의 독립성, 분기 API 제거", async (t) => {
  const f = await fixture(t);
  const base = `/tasks/${f.task.id}/documents`,
    second = randomUUID();
  assert.equal((await f.req(base)).data.documents.length, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM task_documents").get().n,
    0,
    "조회는 문서를 만들지 않는다",
  );
  assert.equal(getTask(f.db, f.task.id).documentCount, 0);
  await f.save("최초 원본");
  assert.equal(
    (await f.req(base, "POST", { id: second, title: "설계" }, "member")).status,
    201,
  );
  assert.equal(
    (await f.req(base, "POST", { id: second, title: "설계" }, "member")).data
      .documents.length,
    2,
    "추가 재시도는 중복을 만들지 않는다",
  );
  assert.equal(getTask(f.db, f.task.id).documentCount, 2);
  const originalList = await f.req(`/tasks?teamId=${f.teamId}&year=2026`);
  assert.equal(
    originalList.data.tasks.find((task) => task.id === f.task.id).documentCount,
    2,
    "표에는 빈 문서 탭을 포함한 개수만 보낸다",
  );
  const put = (path, markdown, revision, role = "member") =>
    f.req(
      path,
      "PUT",
      { markdown, expectedRevision: revision, operationId: randomUUID() },
      role,
    );
  assert.equal((await put(`${base}/${second}`, "두 번째 본문", 0)).status, 200);
  assert.equal(
    (
      await f.req(`${base}/${second}`, "PATCH", {
        title: "설계안",
        expectedTitle: "설계",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(`${base}/${second}`, "PATCH", {
        title: "오래된 이름",
        expectedTitle: "설계",
      })
    ).status,
    409,
  );
  const first = await f.report("사본 A"),
    other = await f.report("사본 B");
  const copyBase = `/reports/${first}/tasks/${f.task.id}/documents`,
    otherBase = `/reports/${other}/tasks/${f.task.id}/documents`;
  const originalCopy = (await f.req(`/reports/${first}`)).data;
  assert.equal(originalCopy.tasks[0].documentCount, 2);
  const initial = (await f.req(`${copyBase}/${second}`)).data;
  assert.equal(
    (await put(`${copyBase}/${second}`, "사본 A만", initial.revision)).status,
    200,
    "담당자가 아니어도 사본은 편집 가능",
  );
  assert.equal(
    (await f.req(`${otherBase}/${second}`)).data.markdown,
    "두 번째 본문",
  );
  assert.equal(
    (await f.req(`${base}/${second}`)).data.markdown,
    "두 번째 본문",
  );
  await put(`${base}/${second}`, "원본만 변경", 1);
  assert.equal(
    (await f.req(`${copyBase}/${second}`)).data.markdown,
    "사본 A만",
  );
  assert.equal(
    (await f.req(`${otherBase}/${second}`)).data.markdown,
    "두 번째 본문",
  );
  const third = randomUUID();
  assert.equal(
    (
      await f.req(
        copyBase,
        "POST",
        { id: third, title: "사본 추가 문서" },
        "member",
      )
    ).status,
    201,
  );
  await put(
    `${copyBase}/${third}`,
    "추가 본문",
    (await f.req(`${copyBase}/${third}`)).data.revision,
  );
  const updatedCopy = (await f.req(`/reports/${first}`)).data;
  assert.equal(updatedCopy.tasks[0].documentCount, 3);
  assert.equal(
    updatedCopy.revision,
    originalCopy.revision,
    "문서 개수가 바뀌어도 표의 낙관적 잠금은 독립적이다",
  );
  assert.equal(
    (await f.req(`/reports/${other}`)).data.tasks[0].documentCount,
    2,
  );
  assert.equal((await f.req(base)).data.documents.length, 2);
  assert.equal((await f.req(otherBase)).data.documents.length, 2);
  assert.equal(
    (
      await f.req(
        `${copyBase}/${third}`,
        "DELETE",
        { expectedRevision: 0 },
        "member",
      )
    ).status,
    409,
  );
  const revision = (await f.req(`${copyBase}/${second}`)).data.revision;
  assert.equal(
    (
      await f.req(
        `${copyBase}/${second}`,
        "DELETE",
        { expectedRevision: revision },
        "viewer",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        `${copyBase}/${second}`,
        "DELETE",
        { expectedRevision: revision },
        "member",
      )
    ).status,
    200,
  );
  assert.equal((await f.req(`${base}/${second}`)).status, 200);
  assert.equal((await f.req(`${copyBase}/${second}`)).status, 404);
  assert.equal(
    (await f.req(`/tasks/${f.task.id}/document/versions`)).status,
    404,
  );
  const all = (await f.req(`${copyBase}?content=1`)).data.documents;
  assert.equal(all.length, 2);
  assert.equal(all.find((doc) => doc.id === third).markdown, "추가 본문");
  const clone = await f.req(
    "/reports",
    "POST",
    {
      teamId: f.teamId,
      sourceId: first,
      year: 2026,
      name: "사본 A 복제",
      referenceDate: "2026-10-16",
      view: defaultView(2026),
      taskIds: [],
    },
    "member",
  );
  assert.equal(clone.status, 201, JSON.stringify(clone.data));
  assert.deepEqual(
    (
      await f.req(
        `/reports/${clone.data.id}/tasks/${f.task.id}/documents?content=1`,
      )
    ).data.documents,
    all,
  );
  const clonedTask = (await f.req(`/reports/${clone.data.id}`)).data.tasks[0];
  assert.equal(clonedTask.documentCount, 2);
  assert.equal(
    clonedTask.documents,
    undefined,
    "표 조회에 본문이나 참조 목록을 싣지 않는다",
  );
  const removed = await f.req(`${base}/${second}`, "DELETE", {
    expectedRevision: (await f.req(`${base}/${second}`)).data.revision,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.documentCount, 1);
  assert.equal(getTask(f.db, f.task.id).documentCount, 1);
  assert.equal(
    (await f.req(`/reports/${first}`)).data.tasks[0].documentCount,
    2,
  );
});

test("사본을 반복 자동 저장해도 최신 참조만 보관하고 셀 복원은 독립 문서를 되돌리지 않는다", async (t) => {
  const f = await fixture(t);
  await f.save("원본 본문");
  const id = await f.report(),
    path = `/reports/${id}`,
    doc = `${path}/tasks/${f.task.id}/document`;
  for (let n = 0; n < 6; n++)
    assert.equal((await f.saveReport(id, `문서 ${n}`)).status, 200);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM report_documents WHERE report_id=?")
      .get(id).n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM document_versions").get().n,
    2,
    "원본과 사본의 현재 본문만 필요하다",
  );
  const initial = (await f.req(path)).data;
  const patch = async (report, operations) =>
    f.req(path, "PATCH", {
      operationId: randomUUID(),
      revision: report.revision,
      operations,
    });
  let saved = await patch(initial, [
    {
      kind: "cells",
      at: now(),
      changes: [
        {
          taskId: f.task.id,
          key: "title",
          value: "사본 제목",
          expectedVersion: 0,
        },
      ],
    },
  ]);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await f.saveReport(id, "독립적으로 먼저 저장한 문서");
  saved = await patch(saved.data, [
    { kind: "restore", at: now(), tasks: initial.tasks },
  ]);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(
    saved.data.tasks[0].cells.title.value,
    initial.tasks[0].cells.title.value,
  );
  assert.equal((await f.req(doc)).data.markdown, "독립적으로 먼저 저장한 문서");
  const restore = {
    ...saved.data.tasks[0],
    documents: (await f.req(`${path}/tasks/${f.task.id}/documents?content=1`))
      .data.documents,
  };
  saved = await patch(saved.data, [
    { kind: "delete", at: now(), taskIds: [f.task.id] },
  ]);
  assert.equal(saved.status, 200);
  assert.equal((await f.req(doc)).status, 404);
  saved = await patch(saved.data, [
    { kind: "restore", at: now(), tasks: [restore] },
  ]);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await f.req(doc)).data.markdown, "독립적으로 먼저 저장한 문서");
  assert.equal(getTaskDocument(f.db, f.task.id).markdown, "원본 본문");
  const foreign = { ...restore, teamId: randomUUID() };
  assert.equal(
    (
      await patch(saved.data, [
        { kind: "restore", at: now(), tasks: [foreign] },
      ])
    ).status,
    400,
  );
});

test("사본 이름 변경은 중복·이전 이름 충돌·열람자 권한을 확인한다", async (t) => {
  const f = await fixture(t),
    a = await f.report("첫 사본"),
    b = await f.report("둘째 사본");
  const path = `/reports/${a}/name`;
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { name: "둘째 사본", expectedName: "첫 사본" },
        "member",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { name: "새 이름", expectedName: "첫 사본" },
        "viewer",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { name: "새 이름", expectedName: "첫 사본" },
        "member",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { name: "덮어쓰기", expectedName: "첫 사본" },
        "member",
      )
    ).status,
    409,
  );
  assert.equal((await f.req(`/reports/${b}`)).data.name, "둘째 사본");
});

test("사본 생성 응답 유실 재시도는 원래 사본이 삭제되어도 중복 없이 성공한다", async (t) => {
  const f = await fixture(t);
  await f.save("복사할 본문");
  const source = await f.report("출발 사본");
  const data = {
    id: randomUUID(),
    sourceId: source,
    teamId: f.teamId,
    year: 2026,
    name: "도착 사본",
    referenceDate: "2026-10-16",
    view: defaultView(2026),
    taskIds: [],
  };
  const first = await f.req("/reports", "POST", data, "member");
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(
    (
      await f.req(
        "/reports",
        "DELETE",
        { teamId: f.teamId, ids: [source] },
        "member",
      )
    ).status,
    200,
  );
  assert.deepEqual(
    await f
      .req("/reports", "POST", data, "member")
      .then(({ status, data }) => ({ status, data })),
    { status: 201, data: { id: first.data.id } },
  );
  assert.equal(
    (await f.req("/reports", "POST", { ...data, name: "다른 요청" }, "member"))
      .status,
    409,
  );
  assert.equal((await f.req("/reports", "POST", data, "viewer")).status, 403);
  assert.equal(
    (await f.req(`/reports?teamId=${f.teamId}`)).data.reports.length,
    1,
  );
  assert.equal(
    (await f.req(`/reports/${first.data.id}/tasks/${f.task.id}/documents/main`))
      .data.markdown,
    "복사할 본문",
  );
});

test("문서 브라우저 집계는 가상 빈 문서를 제외하고 등록된 빈 탭·접힌 사본을 포함한다", async (t) => {
  const f = await fixture(t);
  const base = `/document-browser/sources?teamId=${f.teamId}&year=2026`;
  assert.equal((await f.req(base)).data.sources[0].documentCount, 0);
  const empty = randomUUID();
  await f.req(`/tasks/${f.task.id}/documents`, "POST", {
    id: empty,
    title: "등록한 빈 문서",
  });
  const reportId = await f.report();
  const result = (await f.req(base)).data.sources;
  for (const id of ["live", reportId]) {
    const source = result.find((source) => source.id === id);
    assert.equal(source.taskCount, 1);
    assert.equal(source.documentCount, 2);
    assert.equal(source.data, undefined);
  }
  const list = (
    await f.req(
      `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=live`,
    )
  ).data;
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].documents[1].title, "등록한 빈 문서");
  assert.equal(list.tasks[0].documents[1].hasContent, 0);
  assert.equal(JSON.stringify(list).includes('"markdown"'), false);
  await f.req(`/tasks/${f.task.id}/documents/${empty}`, "DELETE", {
    expectedRevision: 0,
  });
  assert.equal(
    (await f.req(base)).data.sources.find((s) => s.id === "live").documentCount,
    1,
  );
  assert.equal(
    (await f.req(base)).data.sources.find((s) => s.id === reportId)
      .documentCount,
    2,
  );
});

test("작업 이름 검색은 모든 문서를 표시하고 첫 문서 삭제 시 다음 문서로 바뀐다", async (t) => {
  const f = await fixture(t);
  await f.save("첫 문서의 본문");
  const second = randomUUID();
  await f.req(`/tasks/${f.task.id}/documents`, "POST", {
    id: second,
    title: "후속 검색 문서",
  });
  const copy = await f.report();
  for (const source of ["live", copy]) {
    const path = `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}&q=문서가`;
    const found = (await f.req(path)).data.tasks[0];
    assert.deepEqual(
      found.documents.map((doc) => doc.id),
      ["main", second],
    );
    const main = `${source === "live" ? "" : `/reports/${source}`}/tasks/${f.task.id}/documents/main`;
    assert.equal(
      (
        await f.req(main, "DELETE", {
          expectedRevision: (await f.req(main)).data.revision,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (await f.req(path)).data.tasks[0].documents.map((doc) => doc.id),
      [second],
    );
  }
});

test("문서 브라우저는 작업 이름만 검색하고 미리보기는 사본의 최신 독립 참조를 따른다", async (t) => {
  const f = await fixture(t);
  await f.save("원본에만 있는 고유문구");
  const second = randomUUID();
  await f.req(`/tasks/${f.task.id}/documents`, "POST", {
    id: second,
    title: "문서전용검색어",
  });
  const a = await f.report("첫 사본"),
    b = await f.report("둘째 사본");
  const blob = f.db.prepare("SELECT data FROM reports WHERE id=?").get(a).data;
  await f.saveReport(a, "사본에서만 찾는 바다별 검색어");
  assert.deepEqual(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(a).data,
    blob,
  );
  const list = async (source, q) =>
    (
      await f.req(
        `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}&q=${encodeURIComponent(q)}`,
      )
    ).data;
  for (const source of ["live", a, b]) {
    for (const q of ["고유문구", "바다별", "문서전용검색어", "문서 1"]) {
      const excluded = await list(source, q);
      assert.equal(excluded.matchedTaskCount, 0);
      assert.equal(excluded.matchedDocumentCount, 0);
      assert.deepEqual(excluded.tasks, []);
      assert.equal(excluded.taskCount, 1);
      assert.equal(excluded.documentCount, 2);
    }
    const matched = await list(source, " 문서가 있는 ");
    assert.equal(matched.matchedTaskCount, 1);
    assert.equal(matched.matchedDocumentCount, 2);
    assert.deepEqual(
      matched.tasks[0].documents.map((doc) => doc.id),
      ["main", second],
    );
  }
  const found = await list(a, "문서가 있는");
  assert.equal(found.tasks[0].id, f.task.id);
  assert.equal(found.tasks[0].documents[0].id, "main");
  assert.equal(
    found.tasks[0].documents[0].preview,
    "사본에서만 찾는 바다별 검색어",
  );
  assert.equal(found.tasks[0].documents[0].markdown, undefined);
  for (const source of ["live", b])
    assert.equal(
      (await list(source, "")).tasks[0].documents[0].preview,
      "원본에만 있는 고유문구",
    );
  await f.req(`/reports/${a}/tasks/${f.task.id}/documents/main`, "PATCH", {
    title: "찾을 제목",
    expectedTitle: "문서 1",
  });
  assert.equal((await list(a, "찾을 제목")).matchedDocumentCount, 0);
  assert.equal((await list(a, "문서가 있는 업무")).matchedTaskCount, 1);
  const report = (await f.req(`/reports/${a}`)).data;
  const renamed = await f.req(`/reports/${a}`, "PATCH", {
    operationId: randomUUID(),
    revision: report.revision,
    operations: [
      {
        kind: "cells",
        at: now(),
        changes: [
          {
            taskId: f.task.id,
            key: "title",
            value: "검토 Alpha 작업",
            expectedVersion: report.tasks[0].cells.title.version,
          },
        ],
      },
    ],
  });
  assert.equal(renamed.status, 200);
  assert.equal((await list(a, " alpha ")).matchedDocumentCount, 2);
  assert.equal((await list(a, "문서가 있는 업무")).matchedTaskCount, 0);
  for (const source of ["live", b]) {
    assert.equal((await list(source, "alpha")).matchedTaskCount, 0);
    assert.equal(
      (await list(source, "문서가 있는 업무")).matchedDocumentCount,
      2,
    );
  }
});

test("문서 미리보기는 페이지와 문서별로 구분한 짧은 한 줄이며 긴 본문은 검색 대상에서 제외한다", async (t) => {
  const f = await fixture(t);
  const markdown =
    "# 시작\n\n- **첫 항목**\n- [x] [설계 링크](https://example.com/design)\n\n![설계 이미지](/images/design.png)\n\n" +
    "긴 본문 내용입니다. ".repeat(500) +
    "끝부분고유검색어";
  assert.equal((await f.save(markdown)).status, 200);
  const emptyId = randomUUID();
  await f.req(`/tasks/${f.task.id}/documents`, "POST", {
    id: emptyId,
    title: "빈 문서",
  });
  await f.save("다른 작업의 main 본문", 0, "lead", f.unassigned.id);
  const copy = await f.report();
  const list = async (source, extra = "") => {
    const response = await f.req(
      `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}${extra}`,
    );
    assert.equal(response.status, 200);
    return response.data;
  };
  for (const source of ["live", copy]) {
    assert.equal(
      (await list(source, "&q=끝부분고유검색어")).matchedDocumentCount,
      0,
    );
    const found = await list(source, "&q=문서가");
    assert.equal(found.matchedDocumentCount, 2);
    const doc = found.tasks[0].documents[0];
    assert.equal(doc.id, "main");
    assert.ok(
      doc.preview.startsWith("시작 첫 항목 설계 링크 설계 이미지 긴 본문"),
    );
    assert.ok(doc.preview.endsWith("…"));
    assert.ok(Array.from(doc.preview).length <= 240);
    assert.equal(/[\n\r#*]|https:|끝부분고유검색어/.test(doc.preview), false);
    assert.equal(doc.markdown, undefined);
    const all = await list(source);
    assert.equal(
      all.tasks
        .find((task) => task.id === f.task.id)
        .documents.find((doc) => doc.id === emptyId).preview,
      "",
    );
  }
  const first = await list("live", "&limit=1");
  assert.equal(first.tasks.length, 1);
  assert.equal(first.nextOffset, 1);
  const second = await list("live", "&limit=1&offset=1");
  assert.equal(second.tasks.length, 1);
  assert.equal(second.nextOffset, null);
  assert.notEqual(first.tasks[0].id, second.tasks[0].id);
  for (const result of [first, second]) {
    const task = result.tasks[0];
    assert.equal(
      task.documents[0].preview.startsWith("다른 작업의 main 본문"),
      task.id === f.unassigned.id,
    );
  }
  assert.equal((await f.save("원본만 갱신한 본문", 1)).status, 200);
  assert.equal(
    (await list("live")).tasks.find((task) => task.id === f.task.id)
      .documents[0].preview,
    "원본만 갱신한 본문",
  );
  assert.ok(
    (await list(copy)).tasks[0].documents[0].preview.startsWith("시작 첫 항목"),
  );
});

test("문서 브라우저 담당자는 원본과 사본의 속성을 따르고 변경·미지정을 반영한다", async (t) => {
  const f = await fixture(t);
  await f.save("담당자를 표시할 문서");
  const copy = await f.report();
  const owner = async (source) => {
    const list = (
      await f.req(
        `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}`,
      )
    ).data;
    return list.owners[list.tasks[0].ownerId]?.name || "";
  };
  assert.equal(await owner("live"), "member");
  assert.equal(await owner(copy), "member");
  const changeOwner = async (value) =>
    f.req("/cells/batch", "POST", {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [
        {
          taskId: f.task.id,
          key: "owner",
          value,
          expectedVersion: getTask(f.db, f.task.id).cells.owner.version,
        },
      ],
    });
  assert.equal((await changeOwner(f.people.lead.id)).status, 200);
  assert.equal(await owner("live"), "lead");
  assert.equal(await owner(copy), "member");
  const report = (await f.req(`/reports/${copy}`)).data;
  const result = await f.req(`/reports/${copy}`, "PATCH", {
    operationId: randomUUID(),
    revision: report.revision,
    operations: [
      {
        kind: "cells",
        at: now(),
        changes: [
          {
            taskId: f.task.id,
            key: "owner",
            value: f.people.supporter.id,
            expectedVersion: report.tasks.find((task) => task.id === f.task.id)
              .cells.owner.version,
          },
        ],
      },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(await owner(copy), "supporter");
  assert.equal(await owner("live"), "lead");
  assert.equal((await changeOwner("")).status, 200);
  assert.equal(await owner("live"), "");
  assert.equal(await owner(copy), "supporter");
});

test("문서 브라우저 프로필은 페이지에서 중복하지 않고 사본의 저장된 이름과 현재 아바타를 함께 표시한다", async (t) => {
  const f = await fixture(t);
  await f.save("프로필 검증 첫 문서");
  const copy = await f.report();
  const blob = f.db
    .prepare("SELECT data FROM reports WHERE id=?")
    .get(copy).data;
  await f.save("프로필 검증 둘째 문서", 0, "lead", f.unassigned.id);
  f.db
    .prepare("UPDATE cells SET value=? WHERE task_id=? AND key='owner'")
    .run(json(f.people.member.id), f.unassigned.id);
  const image = `data:image/png;base64,${(
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#3467bc" },
    })
      .png()
      .toBuffer()
  ).toString("base64")}`;
  f.db
    .prepare(
      "UPDATE users SET name=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
    )
    .run("현재 이름", "#3467bc", "M1", image, f.people.member.id);
  const list = async (source, extra = "") =>
    (
      await f.req(
        `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}${extra}`,
      )
    ).data;
  for (const source of ["live", copy]) {
    const result = await list(source);
    assert.equal(Object.keys(result.owners).length, 1);
    const profile = result.owners[f.people.member.id];
    assert.equal(profile.name, source === "live" ? "현재 이름" : "member");
    assert.equal(profile.color, "#3467bc");
    assert.equal(profile.avatarInitials, "M1");
    assert.equal(profile.avatarImage, image);
    assert.equal(JSON.stringify(result).split(image).length - 1, 1);
    assert.equal(profile.username, undefined);
    assert.equal(profile.teamRoles, undefined);
  }
  assert.equal((await list("live")).tasks.length, 2);
  assert.deepEqual((await list("live", "&q=없는검색어")).owners, {});
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.people.member.id);
  const formerOwner = (await list("live", "&groupBy=owner")).owners[
    f.people.member.id
  ];
  assert.equal(formerOwner.name, "현재 이름");
  assert.equal(formerOwner.avatarImage, image);
  assert.equal(
    (await list("live", "&groupBy=owner")).groups[0].label,
    "현재 이름",
  );
  const detail = await f.req(
    `/document-browser/task?teamId=${f.teamId}&year=2026&source=live&taskId=${f.task.id}`,
  );
  const formerMember = detail.data.users.find(
    (user) => user.id === f.people.member.id,
  );
  assert.equal(formerMember?.name, "현재 이름");
  assert.equal(formerMember.avatarImage, image);
  assert.equal(
    (
      await f.req(
        `/document-browser/tasks?teamId=${f.teamId}&year=2026`,
        "GET",
        undefined,
        "member",
      )
    ).status,
    403,
  );
  assert.equal(
    (await list(copy)).owners[f.people.member.id].avatarImage,
    image,
  );
  assert.deepEqual(
    f.db.prepare("SELECT data FROM reports WHERE id=?").get(copy).data,
    blob,
  );
});

test("문서 브라우저 모든 조회는 팀 권한·범위·페이지 한도를 검사한다", async (t) => {
  const f = await fixture(t);
  await f.save("검증 본문");
  const copy = await f.report();
  for (const path of [
    `/document-browser/sources?teamId=${f.teamId}&year=2026`,
    ...["live", copy].flatMap((source) => [
      `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${source}&q=검증`,
      `/document-browser/task?teamId=${f.teamId}&year=2026&source=${source}&taskId=${f.task.id}`,
    ]),
  ]) {
    assert.equal((await f.req(path, "GET", undefined, "viewer")).status, 200);
    assert.equal((await f.req(path, "GET", undefined, "outsider")).status, 403);
    assert.equal((await f.req(path, "GET", undefined, null)).status, 401);
  }
  const base = `/document-browser/tasks?teamId=${f.teamId}&source=live`;
  assert.equal((await f.req(`${base}&year=2025`)).data.taskCount, 0);
  assert.equal(
    (await f.req(`${base}&year=2025&startMonth=2`)).data.taskCount,
    0,
  );
  for (const year of ["1999", "2101", "2026.5", "invalid"])
    assert.equal((await f.req(`${base}&year=${year}`)).status, 400);
  assert.equal((await f.req(`${base}&year=2026&limit=101`)).status, 400);
  assert.equal((await f.req(`${base}&year=2026&offset=-1`)).status, 400);
  assert.equal(
    (
      await f.req(
        `/document-browser/task?teamId=${f.teamId}&year=2026&source=${copy}&taskId=${f.unassigned.id}`,
      )
    ).status,
    404,
  );
});

test("문서 브라우저 집계·목록·작업 이름 검색은 선택 연도만 조회하고 여러 연도 작업을 중복하지 않는다", async (t) => {
  const f = await fixture(t);
  await f.save("두 연도에 등록한 작업의 문서");
  f.db
    .prepare("UPDATE tasks SET years=? WHERE id=?")
    .run(json([2026, 2027]), f.task.id);
  const currentCopy = await f.report();
  const nextTask = (
    await f.req("/tasks", "POST", {
      teamId: f.teamId,
      year: 2027,
      fields: { title: "다음 해에만 등록한 작업" },
    })
  ).data.task;
  await f.req(`/tasks/${nextTask.id}/documents/main`, "PUT", {
    markdown: "다음연도전용검색어",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  const nextCopy = (
    await f.req("/reports", "POST", {
      teamId: f.teamId,
      year: 2027,
      name: "다음 연도 사본",
      referenceDate: "2027-01-01",
      view: defaultView(2027),
      taskIds: [f.task.id, nextTask.id],
    })
  ).data.id;
  for (const [year, count, copy] of [
    [2026, 1, currentCopy],
    [2027, 2, nextCopy],
  ]) {
    const query = `teamId=${f.teamId}&year=${year}&startMonth=2`;
    const sources = (await f.req(`/document-browser/sources?${query}`)).data
      .sources;
    assert.deepEqual(
      sources.map((s) => s.id),
      ["live", copy],
    );
    for (const source of sources) {
      assert.equal(source.taskCount, count);
      assert.equal(source.documentCount, count);
      const list = (
        await f.req(`/document-browser/tasks?${query}&source=${source.id}`)
      ).data;
      assert.equal(list.taskCount, count);
      assert.equal(list.documentCount, count);
      assert.equal(
        list.tasks.filter((task) => task.id === f.task.id).length,
        1,
      );
      const search = (
        await f.req(
          `/document-browser/tasks?${query}&source=${source.id}&q=다음`,
        )
      ).data;
      assert.equal(search.matchedDocumentCount, year === 2027 ? 1 : 0);
    }
  }
  assert.equal(
    (
      await f.req(
        `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=${nextCopy}`,
      )
    ).status,
    404,
  );
});

test("문서 브라우저 묶음 보기와 페이지는 다중 구성원 조합·미입력·전체 수를 유지한다", async (t) => {
  const f = await fixture(t);
  await f.save("첫 본문");
  await f.save("두 번째 본문", 0, "lead", f.unassigned.id);
  const base = `/document-browser/tasks?teamId=${f.teamId}&year=2026&source=live&groupBy=supporters&limit=1`;
  const first = (await f.req(base)).data;
  assert.equal(first.taskCount, 2);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.groups.length, 2);
  assert.equal(first.groups.at(-1).label, "미입력");
  assert.equal(first.nextOffset, 1);
  const second = (await f.req(`${base}&offset=1`)).data;
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  assert.equal(second.nextOffset, null);
  const matched = (await f.req(`${base}&q=다른 사람`)).data;
  assert.equal(matched.taskCount, 2);
  assert.equal(matched.matchedTaskCount, 1);
  assert.equal(matched.groups.at(-1).matchedTaskCount, 1);
  // Reversed selections belong to the same combination, as in the annual grid.
  const members = [f.people.member.id, f.people.supporter.id];
  for (const [taskId, value] of [
    [f.task.id, members],
    [f.unassigned.id, [...members].reverse()],
  ]) {
    const task = (
      await f.req(
        `/document-browser/task?teamId=${f.teamId}&year=2026&source=live&taskId=${taskId}`,
      )
    ).data.task;
    const saved = await f.req("/cells/batch", "POST", {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [
        {
          taskId,
          key: "supporters",
          value,
          expectedVersion: task.cells.supporters?.version || 0,
        },
      ],
    });
    assert.equal(saved.status, 200);
  }
  const combined = (await f.req(base)).data;
  assert.equal(combined.groups.length, 1);
  assert.equal(combined.groups[0].taskCount, 2);
  assert.equal(combined.groups[0].key, [...members].sort().join(","));
});
