import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { DocumentBusinessService } from "../server/storage/documents/document-service.mjs";
import { SheetCloneBusinessService } from "../server/storage/sheet-clones/sheet-clone-service.mjs";
import { DocumentBrowserBusinessService } from "../server/storage/documents/document-browser-service.mjs";
import { PostgresDocumentRepository } from "../worker/storage/documents/postgres-documents.mjs";
import { PostgresSheetCloneRepository } from "../worker/storage/sheet-clones/postgres-sheet-clones.mjs";
import { PostgresDocumentBrowserRepository } from "../worker/storage/documents/postgres-document-browser.mjs";
import { DataSession } from "../worker/storage/data.mjs";
import { sheetCloneRoutes } from "../worker/sheet-clones/sheet-clones.mjs";
import { canonical, entityId } from "../server/sync/protocol.mjs";
import { packSheetClonePayload } from "../shared/sheet-clones/sheet-clone-sync-data.js";

// Edge reaches PostgreSQL over a link where each statement is a network round
// trip, so a document list, a sheetClone and the document browser must cost a fixed
// number of statements, not one read of every team document per task. Each read
// must also answer exactly as reading the team's whole document list does.
test("document, sheetClone and browser reads cost the same statements for few or many documents", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const statements = { count: 0, rows: 0 },
    // `whole` reads every document and sheetClone first, as these reads did
    // before, so the prefix reads answer from that list instead of SQL.
    services = (whole = false) => {
      const context = f.makeContext(),
        data = context.data.bind(context);
      context.data = (teamId, work, options) =>
        data(
          teamId,
          async (s) => {
            if (whole) {
              await s.list("document");
              await s.list("sheetClone");
            }
            const query = s.tx.query.bind(s.tx);
            s.tx.query = async (...args) => {
              statements.count++;
              const result = await query(...args);
              statements.rows += result.rows?.length || 0;
              return result;
            };
            return work(s);
          },
          options,
        );
      return {
        context,
        documents: new DocumentBusinessService(
          new PostgresDocumentRepository({ context }),
          f.user,
        ),
        sheetClones: new SheetCloneBusinessService(
          new PostgresSheetCloneRepository({ context }),
          f.user,
        ),
        browser: new DocumentBrowserBusinessService(
          new PostgresDocumentBrowserRepository({ context }),
          f.user,
        ),
      };
    };
  const session = (work) =>
      f.adapter.withTeamTransaction(f.teamId, (tx) =>
        work(new DataSession(tx, f.teamId)),
      ),
    insert = (entity, key, payload, deleted = 0) =>
      f.pool.query(
        "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,$2,$3,$4,$5,$6)",
        [
          f.teamId,
          entity,
          JSON.stringify(key),
          canonical(
            entity === "sheetClone" ? packSheetClonePayload(payload) : payload,
          ),
          Date.parse("2026-10-01T00:00:00Z") + Number(deleted),
          deleted,
        ],
      ),
    template = f.state.entities[entityId("task", [f.taskId])].payload,
    sheetClone = await session((s) => s.get("sheetClone", [f.sheetCloneId])),
    sheetCloneTasks = [...sheetClone.payload.data.tasks],
    saveSheetClone = () =>
      f.pool.query(
        "UPDATE graeboard.site_entities SET payload=$3 WHERE team_id=$1 AND entity='sheetClone' AND entity_key=$2",
        [
          f.teamId,
          JSON.stringify([f.sheetCloneId]),
          canonical(
            packSheetClonePayload({
              ...sheetClone.payload,
              data: { ...sheetClone.payload.data, tasks: sheetCloneTasks },
            }),
          ),
        ],
      );
  // A task that never had a document shows the empty main document; one whose
  // only document was deleted shows none.
  const empty = randomUUID(),
    cleared = randomUUID();
  for (const id of [empty, cleared]) {
    await insert("task", [id], { ...template, position: 50 });
    await insert("cell", [id, "title"], { value: "빈 업무" });
    sheetCloneTasks.push({ ...sheetCloneTasks[0], id });
  }
  await insert(
    "document",
    ["task", cleared, randomUUID()],
    { title: "삭제", position: 0, markdown: "지운 문서" },
    1,
  );
  await insert(
    "document",
    ["sheetClone", f.sheetCloneId, cleared, randomUUID()],
    { title: "삭제", position: 0, markdown: "지운 문서" },
    1,
  );
  const seededIds = [];
  let seeded = 0;
  // Each record: a task with two documents (one blank, out of key order by
  // position), the same task copied into the sheetClone with its own document.
  const seed = async (count) => {
    for (; seeded < count; seeded++) {
      const task = randomUUID();
      seededIds.push(task);
      await insert("task", [task], { ...template, position: 100 + seeded });
      await insert("cell", [task, "title"], { value: "업무 " + seeded });
      await insert("document", ["task", task, randomUUID()], {
        title: "둘째",
        position: 1,
        markdown: seeded % 2 ? "# 업무 " + seeded : " \n",
      });
      await insert("document", ["task", task, randomUUID()], {
        title: "첫째",
        position: 0,
        markdown: "본문 " + seeded,
      });
      sheetCloneTasks.push({ ...sheetCloneTasks[0], id: task });
      await insert(
        "document",
        ["sheetClone", f.sheetCloneId, task, randomUUID()],
        {
          title: "사본 문서",
          position: 0,
          markdown: seeded % 2 ? "사본 " + seeded : "",
        },
      );
    }
    await saveSheetClone();
  };
  const browse = { teamId: f.teamId, year: 2026 },
    reads = {
      taskDocuments: (s) =>
        s.documents.list({ kind: "task", taskId: f.taskId }),
      seededTask: (s) =>
        s.documents.list({ kind: "task", taskId: seededIds[1] }),
      emptyTask: (s) => s.documents.list({ kind: "task", taskId: empty }),
      clearedTask: (s) => s.documents.list({ kind: "task", taskId: cleared }),
      sheetCloneDocuments: (s) =>
        s.documents.list(
          {
            kind: "sheetClone",
            sheetCloneId: f.sheetCloneId,
            taskId: f.taskId,
          },
          { content: true },
        ),
      emptySheetCloneTask: (s) =>
        s.documents.list(
          { kind: "sheetClone", sheetCloneId: f.sheetCloneId, taskId: empty },
          { content: true },
        ),
      sheetClone: (s) => s.sheetClones.read(f.sheetCloneId),
      // Every seeded task's sheetClone documents in one request.
      sheetCloneBatch: (s) =>
        sheetCloneRoutes(
          s.context,
          `/sheet-clones/${f.sheetCloneId}/documents/batch`,
          "POST",
          { taskIds: seededIds },
        ),
      sheetClones: (s) => s.sheetClones.list({ teamId: f.teamId }),
      sources: (s) => s.browser.query("sources", browse),
      liveTasks: (s) => s.browser.query("tasks", { ...browse, limit: 100 }),
      sheetCloneTasks: (s) =>
        s.browser.query("tasks", {
          ...browse,
          source: f.sheetCloneId,
          limit: 100,
        }),
      sheetCloneTask: (s) =>
        s.browser.query("task", {
          ...browse,
          source: f.sheetCloneId,
          taskId: f.taskId,
        }),
    },
    measure = async () => {
      const result = {};
      for (const [name, read] of Object.entries(reads)) {
        statements.count = statements.rows = 0;
        const value = await read(services());
        result[name] = { ...statements, value };
      }
      return result;
    };
  await seed(3);
  const few = await measure();
  await seed(30);
  const many = await measure();
  for (const name of Object.keys(reads))
    assert.equal(many[name].count, few[name].count, name);
  // One owner's list, the sheetClone list and one browser task read only their
  // own rows, however many documents the team has.
  for (const name of [
    "taskDocuments",
    "seededTask",
    "emptyTask",
    "clearedTask",
    "sheetCloneDocuments",
    "emptySheetCloneTask",
    "sheetClones",
    "sheetCloneTask",
  ])
    assert.equal(many[name].rows, few[name].rows, name);

  // The same answers, byte for byte, as reading the whole document list.
  const whole = services(true);
  for (const [name, read] of Object.entries(reads))
    assert.equal(
      JSON.stringify(many[name].value),
      JSON.stringify(await read(whole)),
      name,
    );

  // What each read says about the seeded records.
  assert.deepEqual(
    many.emptyTask.value.documents.map(({ id, revision, hasContent }) => ({
      id,
      revision,
      hasContent,
    })),
    [{ id: "main", revision: 0, hasContent: false }],
  );
  assert.deepEqual(many.clearedTask.value.documents, []);
  // Ordered by position, not by key.
  assert.deepEqual(
    many.seededTask.value.documents.map((d) => [d.title, d.hasContent]),
    [
      ["첫째", true],
      ["둘째", true],
    ],
  );
  // With content, only stored documents, as the internal site answers.
  assert.deepEqual(many.emptySheetCloneTask.value.documents, []);
  const tasks = new Map(
    many.sheetClone.value.tasks.map((task) => [task.id, task]),
  );
  assert.equal(tasks.size, 33);
  assert.equal(tasks.get(empty).documentCount, 1);
  assert.equal(tasks.get(cleared).documentCount, 0);
  const copied = many.sheetClone.value.tasks.filter(
    (task) => ![f.taskId, empty, cleared].includes(task.id),
  );
  assert.ok(
    copied.every(
      (task, index) =>
        task.documentCount === 1 && task.hasDocument === index % 2 > 0,
    ),
  );
  const live = many.liveTasks.value.tasks.filter((task) =>
    task.title.startsWith("업무 "),
  );
  assert.equal(live.length, 30);
  assert.ok(
    live.every(
      (task) =>
        task.documentCount === 2 &&
        task.documents.find((d) => d.title === "둘째").hasContent ===
          Number(task.title.slice(3)) % 2 > 0,
    ),
  );
  const [, copy] = many.sources.value.sources;
  assert.equal(copy.id, f.sheetCloneId);
  assert.equal(copy.taskCount, copied.length);
  assert.equal(copy.documentCount, copied.length);
  assert.equal(
    many.sheetCloneTask.value.revision,
    many.sheetClone.value.revision,
  );
});

// The sheetClone list reads names and dates in SQL without the sheetClone data. A
// sheetClone whose data jsonb cannot read still lists, from its whole payload.
test("sheetClone list reads metadata without data and keeps unreadable payloads", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const context = f.makeContext(),
    service = new SheetCloneBusinessService(
      new PostgresSheetCloneRepository({ context }),
      f.user,
    ),
    insert = (key, payload, deleted = 0) =>
      f.pool.query(
        "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'sheetClone',$2,$3,1,$4)",
        [f.teamId, JSON.stringify(key), canonical(payload), deleted],
      ),
    { data } = (
      await f.adapter.withTeamTransaction(f.teamId, (tx) =>
        new DataSession(tx, f.teamId).get("sheetClone", [f.sheetCloneId]),
      )
    ).payload,
    left = randomUUID(),
    unreadable = randomUUID();
  await f.pool.query(
    "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'person',$2,$3,1,0)",
    [f.teamId, JSON.stringify([left]), canonical({ name: "떠난 사람" })],
  );
  await insert([unreadable], {
    name: "읽기 어려운 사본",
    year: 2026,
    referenceDate: "2026-10-02",
    createdBy: left,
    createdAt: "2999-01-01T00:00:00.000Z",
    data: { ...data, view: { ...data.view, note: "\u0000 \ud800" } },
  });
  await insert(
    [randomUUID()],
    {
      name: "삭제한 사본",
      year: 2026,
      referenceDate: "2026-10-03",
      createdBy: f.user.id,
      createdAt: "2026-10-03T00:00:00.000Z",
      data,
    },
    1,
  );
  const { sheetClones } = await service.list({ teamId: f.teamId });
  assert.deepEqual(
    sheetClones.map(({ id, name, year, author }) => ({
      id,
      name,
      year,
      author,
    })),
    [
      {
        id: unreadable,
        name: "읽기 어려운 사본",
        year: 2026,
        author: "떠난 사람",
      },
      {
        id: f.sheetCloneId,
        name: "Contract sheetClone",
        year: 2026,
        author: "Contract",
      },
    ],
  );
  assert.deepEqual(Object.keys(sheetClones[0]), [
    "id",
    "name",
    "year",
    "referenceDate",
    "createdAt",
    "author",
  ]);
});
