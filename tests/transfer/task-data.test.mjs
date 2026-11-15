import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { taskDataRows } from "../../shared/transfer/task-data.js";
import { unpack } from "../../shared/formatting/compact.js";
import {
  sqliteFixture,
  postgresFixture,
} from "../support/business-storage-fixture.mjs";
import { createExternalRouteApp } from "../support/external-route-fixture.mjs";
import { DocumentBusinessService } from "../../server/storage/documents/document-service.mjs";

test("task data is one property object per task, resolves labels and preserves scalar/array values without weekly or archive data", () => {
  const properties = [
    { id: "title", name: "작업", kind: "text" },
    { id: "owner", name: "담당자", kind: "member" },
    { id: "supporters", name: "협업자", kind: "member", multiple: true },
    {
      id: "status",
      name: "상태",
      kind: "option",
      values: [{ id: "done", label: "완료", archived: true }],
    },
    { id: "count", name: "건수", kind: "number" },
    { id: "deadline", name: "목표일", kind: "date" },
    { id: "progress", name: "진척률", kind: "text" },
    { id: "flag", name: "__proto__", kind: "text" },
    { id: "archived", name: "보관 속성", kind: "text", archived: true },
  ];
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    id: `id-${i}`,
    cells: Object.fromEntries(
      Object.entries({
        title: `업무 ${i + 1}`,
        owner: "a",
        supporters: ["b", "a"],
        status: "done",
        count: 0,
        deadline: "",
        progress: "120%",
        flag: false,
        archived: "보관 값",
        "2026-10-05": "리뷰 회의",
      }).map(([key, value]) => [
        key,
        {
          value,
          version: 10,
          style: { backgroundColor: "#0066cc", work: true },
        },
      ]),
    ),
    documents: [{ markdown: "not exported" }],
    formatting: { revision: 10, rules: [] },
  }));
  const users = [
    { id: "a", name: "가나다" },
    { id: "b", name: "라마바" },
  ];
  const result = taskDataRows(
    tasks,
    [...properties.map((p) => p.id), "2026-10-05"],
    users,
    { properties },
  );
  assert.equal(result.length, 10);
  assert.deepEqual(
    result[0],
    JSON.parse(
      '{"작업":"업무 1","담당자":"가나다","협업자":["라마바","가나다"],"상태":"완료","건수":0,"목표일":null,"진척률":"120%","__proto__":false}',
    ),
  );
  assert.equal(result[9].작업, "업무 10");
  assert.deepEqual(
    taskDataRows(tasks.slice(0, 1), ["status", "title"], users, { properties }),
    [{ 상태: "완료", 작업: "업무 1" }],
  );
  tasks[0].cells.owner.value = "unresolved";
  tasks[0].cells.supporters.value = "";
  tasks[0].cells.status.value = "unresolved-option";
  assert.deepEqual(
    taskDataRows(tasks.slice(0, 1), ["owner", "supporters", "status"], users, {
      properties,
    }),
    [{ 담당자: "unresolved", 협업자: [], 상태: "unresolved-option" }],
  );
  assert.deepEqual(taskDataRows([], [], users, { properties }), []);
});

for (const storage of ["sqlite", "postgres"]) {
  test(`${storage} HTTP exports the same simple arrays for all/view/copy without loading documents or images and keeps detailed JSON`, async (t) => {
    const f =
      storage === "sqlite" ? sqliteFixture(t) : await postgresFixture(t);
    if (!f) return;
    let lightweight = false;
    const app =
      storage === "sqlite"
        ? f.app
        : createExternalRouteApp({
            env: f.env,
            defaultUserId: f.user.id,
            contextFor(user, request) {
              const ctx = f.makeContext(user, request),
                data = ctx.data.bind(ctx);
              ctx.data = (teamId, work, options) =>
                data(
                  teamId,
                  async (s) => {
                    const list = s.list.bind(s);
                    s.list = (entity, ...args) => {
                      if (
                        lightweight &&
                        ["document", "sheetClone", "view", "filter"].includes(
                          entity,
                        )
                      )
                        throw new Error(`unexpected archive read: ${entity}`);
                      return list(entity, ...args);
                    };
                    return work(s);
                  },
                  options,
                );
              const images = ctx.imageStore.bind(ctx);
              ctx.imageStore = (...args) => {
                if (lightweight) throw new Error("unexpected image read");
                return images(...args);
              };
              return ctx;
            },
          });
    if (storage === "sqlite") {
      const prepare = f.db.prepare.bind(f.db);
      t.mock.method(f.db, "prepare", (sql) => {
        if (lightweight && /\bmarkdown\b/i.test(sql))
          throw new Error("unexpected document body read");
        return prepare(sql);
      });
    }
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (storage === "postgres") await app.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = async (path, body, status = 200) => {
      const response = await fetch(origin + "/api" + path, {
        headers: {
          Cookie: `weekly_session=${f.user.id}`,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, status, await response.clone().text());
      return response;
    };
    for (let i = 2; i <= 10; i++)
      await send(
        "/tasks",
        {
          teamId: f.teamId,
          year: 2026,
          fields: {
            title: `업무 ${i}`,
            owner: f.user.id,
            status: "status-completed",
            progress: "120%",
          },
        },
        storage === "sqlite" ? 201 : 200,
      );
    const docs = new DocumentBusinessService(
      storage === "sqlite"
        ? f.app.locals.documentRepository
        : f.makeRepository(f.user),
      f.user,
    );
    const scope = { kind: "task", taskId: f.taskId, documentId: "main" },
      before = await docs.read(scope);
    await docs.save(scope, {
      operationId: randomUUID(),
      expectedRevision: before.revision,
      markdown: "보관 전용 본문 ".repeat(10000),
    });
    const clone = unpack(
      await (await send(`/sheet-clones/${f.sheetCloneId}`)).json(),
    );
    const request = {
      teamId: f.teamId,
      year: 2026,
      scope: "all",
      format: "json-data",
    };
    lightweight = true;
    const wholeResponse = await send("/export", request),
      wholeText = await wholeResponse.text(),
      whole = JSON.parse(wholeText);
    assert.match(
      wholeResponse.headers.get("content-disposition"),
      /graeboard-2026-tasks\.json/,
    );
    assert.equal(whole.length, 10);
    assert.equal(whole[0].작업, "initial");
    assert.equal(whole[1].상태, "완료");
    assert.equal(whole[1].진척률, "120%");
    assert.ok(whole.every((row) => row.팀원 === "Contract"));
    assert.ok(
      whole.every(
        (row) => !Object.hasOwn(row, "id") && !Object.hasOwn(row, "cells"),
      ),
    );
    const view = await (
      await send("/export", {
        ...request,
        scope: "view",
        taskIds: [f.taskId],
        keys: ["title", "owner", "2026-10-05"],
      })
    ).json();
    assert.deepEqual(view, [{ 작업: "initial", 팀원: "Contract" }]);
    const allTasks = unpack(
      await (await send(`/tasks?teamId=${f.teamId}&year=2026`)).json(),
    ).tasks;
    const last = allTasks.find((task) => task.cells.title.value === "업무 10");
    assert.deepEqual(
      await (
        await send("/export", {
          ...request,
          scope: "view",
          taskIds: [last.id, f.taskId],
          keys: ["title"],
        })
      ).json(),
      [{ 작업: "업무 10" }, { 작업: "initial" }],
    );
    assert.deepEqual(
      await (
        await send("/export", {
          ...request,
          scope: "view",
          taskIds: [],
          keys: ["title"],
        })
      ).json(),
      [],
    );
    const copyRequest = {
      ...request,
      sheetCloneId: f.sheetCloneId,
      revision: clone.revision,
    };
    assert.deepEqual(await (await send("/export", copyRequest)).json(), [
      { 작업: "initial", 팀원: "Contract", 상태: null },
    ]);
    assert.deepEqual(
      await (
        await send("/export", {
          ...copyRequest,
          scope: "view",
          taskIds: [f.taskId],
          keys: ["title"],
        })
      ).json(),
      [{ 작업: "initial" }],
    );
    await send("/export", { ...copyRequest, revision: "stale" }, 409);
    await send(
      "/export",
      { ...request, scope: "view", taskIds: [randomUUID()], keys: ["title"] },
      409,
    );
    await send(
      "/export",
      { ...request, teamId: randomUUID() },
      storage === "sqlite" ? 404 : 403,
    );
    lightweight = false;
    const detailText = await (
        await send("/export", { ...request, format: "json" })
      ).text(),
      detail = unpack(JSON.parse(detailText));
    assert.equal(detail.schemaVersion, 7);
    assert.equal(detail.tasks.length, 10);
    assert.match(detail.tasks[0].documents[0].markdown, /보관 전용 본문/);
    assert.ok(detail.sheetClones.length > 0);
    t.diagnostic(
      JSON.stringify({
        storage,
        simpleBytes: Buffer.byteLength(wholeText),
        detailedBytes: Buffer.byteLength(detailText),
        rows: whole.length,
      }),
    );
  });
}
