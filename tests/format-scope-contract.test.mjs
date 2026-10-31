import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { unpack } from "../shared/compact.js";

const data = (result) =>
  result.data ||
  (result.encoded ? unpack(JSON.parse(result.encoded.body)) : result);
const read = async (service, teamId) =>
  data(await service.query({ teamId, year: 2026 }));
// Query results carry the shared formatting on each task.
const revision = (current) => current.tasks[0]?.formatting?.revision ?? 0;

// Cells in and out of a column scope carry their own alignment; a column rule
// must clear it only inside the scope, and leave every other cell untouched.
async function columnFormat(service, teamId) {
  const tasks = [];
  for (const title of ["a", "b"])
    tasks.push(
      (await service.create({ teamId, year: 2026, fields: { title } })).task,
    );
  let current = await read(service, teamId);
  const changes = [];
  for (const task of tasks)
    for (const key of ["title", "progress"]) {
      const cell = current.tasks.find((t) => t.id === task.id).cells[key];
      changes.push({
        taskId: task.id,
        key,
        style: { textAlign: "center", bold: key === "title" },
        expectedVersion: cell?.version || 0,
        expectedFormatRevision: revision(current),
      });
    }
  await service.saveBatch({
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes,
  });
  current = await read(service, teamId);
  const formatted = await service.saveBatch({
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    format: {
      teamId,
      expectedRevision: revision(current),
      scopes: [
        { rows: null, keys: ["progress"], style: { textAlign: "right" } },
      ],
      expectedTasks: Object.fromEntries(
        current.tasks.map((task) => [task.id, task.updatedAt]),
      ),
    },
  });
  const after = await read(service, teamId);
  return {
    changed: data(formatted)
      .cells.map((c) => `${c.taskId === tasks[0].id ? "a" : "b"}:${c.key}`)
      .sort(),
    styles: Object.fromEntries(
      tasks.flatMap((task, index) =>
        ["title", "progress"].map((key) => [
          `${"ab"[index]}:${key}`,
          after.tasks.find((t) => t.id === task.id).cells[key]?.style || {},
        ]),
      ),
    ),
    rules: after.tasks[0].formatting.rules.map(({ keys, rows, style }) => ({
      keys,
      rows,
      style,
    })),
  };
}

test("a column format clears own styles only inside the column, alike on SQLite and actual PostgreSQL", async (t) => {
  const sqlite = sqliteFixture(t);
  const expected = await columnFormat(
    new TaskBusinessService(sqlite.app.locals.taskRepository, sqlite.user),
    sqlite.teamId,
  );
  assert.deepEqual(expected.changed, ["a:progress", "b:progress"]);
  assert.equal(expected.styles["a:progress"].textAlign, undefined);
  assert.equal(expected.styles["a:title"].textAlign, "center");
  const pg = await postgresFixture(t);
  if (!pg) return;
  const actual = await columnFormat(
    new TaskBusinessService(
      new PostgresTaskRepository({ context: pg.makeContext() }),
      pg.user,
    ),
    pg.teamId,
  );
  assert.deepEqual(actual, expected);
});
