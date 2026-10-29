import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
const data = (result) => result.data || unpack(JSON.parse(result.encoded.body));
async function taskCommands({ service, teamId, user, counts, failOnce }) {
  const first = (
    await service.create({
      teamId,
      year: 2026,
      fields: { title: "first", owner: user.id, supporters: [user.id] },
    })
  ).task;
  const duplicate = (
    await service.create({ teamId, year: 2026, sourceId: first.id })
  ).task;
  assert.equal(duplicate.cells.title.value, "first");
  assert.equal(duplicate.cells.owner.value, user.id);
  assert.deepEqual(duplicate.cells.supporters.value, []);
  const second = (
    await service.create({
      teamId,
      year: 2026,
      copiedRow: {
        cells: { title: { value: "pasted", style: { bold: true } } },
        defaultStyle: {},
        rowStyle: {},
      },
    })
  ).task;
  assert.equal(second.cells.title.value, "pasted");
  assert.equal(second.cells.title.style.bold, true);
  assert.deepEqual(
    (await service.getMany([second.id, first.id])).map((task) => task.id),
    [second.id, first.id],
  );
  assert.equal((await service.locate(second.id)).id, second.id);
  const updated = (
    await service.update(first.id, {
      updatedAt: first.updatedAt,
      years: [2026, 2027],
    })
  ).task;
  assert.deepEqual(updated.years, [2026, 2027]);
  const stable = await counts();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.update(first.id, { updatedAt: first.updatedAt, years: [2028] }),
    ),
    (error) => error.status === 409,
  );
  assert.deepEqual(await counts(), stable);
  await assert.rejects(
    Promise.resolve().then(() =>
      service.reorder({
        taskId: second.id,
        updatedAt: second.updatedAt,
        targetId: updated.id,
        targetUpdatedAt: updated.updatedAt,
        year: 2026,
        placement: "before",
        groupBy: "title",
      }),
    ),
    (error) => error.status === 400,
  );
  assert.deepEqual(await counts(), stable);
  const reordered = await service.reorder({
    taskId: second.id,
    updatedAt: second.updatedAt,
    targetId: updated.id,
    targetUpdatedAt: updated.updatedAt,
    year: 2026,
    placement: "before",
  });
  assert.equal(reordered.tasks[0].id, second.id);
  assert.ok(reordered.tasks[0].position < updated.position);
  const current = await service.getMany([first.id, second.id]),
    beforeDelete = await counts();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.remove({
        tasks: [
          { id: current[0].id, updatedAt: current[0].updatedAt },
          { id: current[1].id, updatedAt: second.updatedAt },
        ],
      }),
    ),
    (error) => error.status === 409,
  );
  assert.deepEqual(await counts(), beforeDelete);
  failOnce();
  await assert.rejects(
    Promise.resolve().then(() =>
      service.create({
        teamId,
        year: 2026,
        fields: { title: "atomic failure" },
      }),
    ),
    /injected task failure/,
  );
  assert.deepEqual(await counts(), beforeDelete);
  const removed = await service.remove({
    tasks: current.map((task) => ({ id: task.id, updatedAt: task.updatedAt })),
  });
  const visible = data(await service.query({ teamId, year: 2026 }));
  assert.ok(
    !visible.tasks.some((task) => [first.id, second.id].includes(task.id)),
  );
  const restored = await service.restore({
    tasks: current.map((task) => ({
      id: task.id,
      updatedAt: removed.updatedAt[task.id],
    })),
  });
  assert.deepEqual(
    new Set(restored.tasks.map((task) => task.id)),
    new Set([first.id, second.id]),
  );
  assert.equal((await service.locate(second.id)).cells.title.value, "pasted");
  const privateBefore = await counts();
  await service.saveView({
    teamId,
    name: "__current",
    data: { ...defaultView(2026), hiddenRows: [first.id] },
  });
  assert.deepEqual(
    await counts(),
    privateBefore,
    "Personal view must not enter shared P/audit/event state",
  );
  assert.deepEqual(
    (await service.readViews({ teamId, year: 2026 })).views[0].data.hiddenRows,
    [first.id],
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      service.saveView({
        teamId,
        name: "__current",
        data: { ...defaultView(2026), visibleFields: ["not-a-property"] },
      }),
    ),
    (error) => error.status === 400,
  );
}

test("M6 same task command contract: SQLite creation/copy/CAS/reorder/delete/restore/private views and post-capture rollback", async (t) => {
  const f = sqliteFixture(t),
    service = new TaskBusinessService(f.app.locals.taskRepository, f.user);
  await taskCommands({
    service,
    teamId: f.teamId,
    user: f.user,
    counts: () => ({
      tasks: f.db
        .prepare(
          "SELECT id,years,position,deleted_at,updated_at FROM tasks ORDER BY id",
        )
        .all(),
      pending: f.db.prepare("SELECT COUNT(*) n FROM sync_outbox").get().n,
      audit: f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    }),
    failOnce() {
      const flush = f.db.syncCapture.flush;
      f.db.syncCapture.flush = function () {
        this.flush = flush;
        flush.call(this);
        throw new Error("injected task failure");
      };
    },
  });
});
test("M6 same task command contract: actual PostgreSQL creation/copy/CAS/reorder/delete/restore/private views and post-capture rollback", async (t) => {
  const pg = await postgresFixture(t),
    f = pg;
  if (!pg) return;
  const context = pg.makeContext(),
    repository = new PostgresTaskRepository({ context }),
    notices = [],
    service = new TaskBusinessService(repository, f.user, {
      documentEvents: { invalidate: (key) => notices.push(key) },
    }),
    original = context.data.bind(context);
  let fail = false;
  context.data = (teamId, work, options) =>
    original(
      teamId,
      async (s) => {
        const result = await work(s);
        if (fail && options?.write) {
          fail = false;
          const capture = s.capture.bind(s);
          s.capture = async (actor) => {
            await capture(actor);
            throw new Error("injected task failure");
          };
        }
        return result;
      },
      options,
    );
  await taskCommands({
    service,
    teamId: f.teamId,
    user: f.user,
    counts: async () => ({
      notices: [...notices],
      tasks: (
        await pg.pool.query(
          "SELECT entity_key,payload,revision FROM graeboard.site_entities WHERE entity='task' ORDER BY entity_key",
        )
      ).rows,
      pending: Number(
        (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox"))
          .rows[0].n,
      ),
      audit: Number(
        (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.site_audit"))
          .rows[0].n,
      ),
      events: Number(
        (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.site_events"))
          .rows[0].n,
      ),
    }),
    failOnce() {
      fail = true;
    },
  });
  const current = data(await service.query({ teamId: f.teamId, year: 2026 })),
    task = current.tasks.find((task) => task.id === f.taskId);
  const format = {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    format: {
      teamId: f.teamId,
      expectedRevision: current.formatting.revision,
      scopes: [{ rows: [task.id], keys: ["title"], style: { italic: true } }],
      expectedTasks: { [task.id]: task.updatedAt },
    },
  };
  const before = notices.length;
  const formatted = await service.saveBatch(format);
  assert.equal(notices.length, before + 1);
  assert.deepEqual(await service.saveBatch(format), formatted);
  assert.equal(
    notices.length,
    before + 1,
    "Exact format replay must not publish resource invalidation",
  );
});
