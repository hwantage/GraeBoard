import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgresFixture } from "../support/business-storage-fixture.mjs";
import { CalendarBusinessService } from "../../server/storage/calendar/calendar-service.mjs";
import { TaskBusinessService } from "../../server/storage/tasks/task-service.mjs";
import { PostgresCalendarRepository } from "../../worker/storage/calendar/postgres-calendar.mjs";
import { PostgresTaskRepository } from "../../worker/storage/tasks/postgres-tasks.mjs";
import { calendarWeek } from "../../shared/calendar/calendar.js";
import { entityId } from "../../server/sync/core/protocol.mjs";
import { unpack } from "../../shared/formatting/compact.js";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";

// Edge reaches PostgreSQL over a link where each statement is a network round
// trip, so loading the calendar or the task list must cost a fixed number of
// statements, not one or two per entry, weekly item or document it shows.
test("calendar and task list reads cost the same statements for 3 or 30 records", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const statements = { count: 0 },
    context = f.makeContext(),
    data = context.data.bind(context);
  context.data = (teamId, work, options) =>
    data(
      teamId,
      (s) => {
        const query = s.tx.query.bind(s.tx);
        s.tx.query = (...args) => {
          statements.count++;
          return query(...args);
        };
        return work(s);
      },
      options,
    );
  const calendar = new CalendarBusinessService(
      new PostgresCalendarRepository({ context }),
      f.user,
    ),
    tasks = new TaskBusinessService(
      new PostgresTaskRepository({ context }),
      f.user,
    ),
    measure = async (read) => {
      statements.count = 0;
      const result = await read();
      return { count: statements.count, result };
    };
  const template = f.state.entities[entityId("task", [f.taskId])].payload,
    weekStart = calendarWeek("2026-11-11"),
    insert = (entity, key, payload) =>
      f.pool.query(
        "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,$2,$3,$4,1,0)",
        [f.teamId, entity, JSON.stringify(key), JSON.stringify(payload)],
      );
  let seeded = 0;
  // Each record: a task with a title, a weekly item, a tagged calendar entry
  // with a document, and that entry's tag.
  const seed = async (count) => {
    for (; seeded < count; seeded++) {
      const task = randomUUID(),
        entry = randomUUID(),
        tag = randomUUID();
      await insert("task", [task], {
        ...template,
        position: 100 + seeded,
      });
      await insert("cell", [task, "title"], { value: "업무 " + seeded });
      await insert("weekly", [f.user.id, weekStart, task], {
        title: "업무 " + seeded,
      });
      await insert("tag", [tag], {
        userId: f.user.id,
        name: "태그 " + seeded,
        color: "default",
        kind: "check",
      });
      await insert("calendar", [entry], {
        userId: f.user.id,
        date: "2026-11-11",
        endDate: "2026-11-11",
        lane: seeded,
        title: "일정 " + seeded,
        deletedAt: null,
        tags: [{ id: tag, checked: false }],
      });
      await insert("document", ["calendar", entry, "main"], {
        title: "일정 " + seeded,
        position: 0,
        markdown: seeded % 2 ? "본문 " + seeded : " \n",
      });
      await insert("document", ["task", task, randomUUID()], {
        title: "문서",
        position: 0,
        markdown: seeded % 2 ? "업무 문서" : "　",
      });
    }
  };
  const reads = {
    month: () =>
      calendar.listEntries({
        query: {
          teamId: f.teamId,
          userId: f.user.id,
          from: "2026-11-01",
          to: "2026-11-30",
        },
      }),
    members: () =>
      calendar.listMemberEntries({
        query: {
          teamId: f.teamId,
          userIds: f.user.id,
          from: "2026-11-01",
          to: "2026-11-30",
        },
      }),
    tags: () => calendar.listTags({ params: { teamId: f.teamId }, query: {} }),
    picker: () =>
      calendar.listTasks({
        query: { teamId: f.teamId, userId: f.user.id, weekStart, q: "업무" },
      }),
    filtered: () =>
      calendar.listTasks({
        query: {
          teamId: f.teamId,
          userId: f.user.id,
          weekStart,
          q: "업무",
          filters: JSON.stringify([
            { propertyId: "status", values: [""], mode: "include" },
          ]),
        },
      }),
    tasks: () => tasks.query({ teamId: f.teamId, year: 2026 }),
  };
  await seed(3);
  const few = {};
  for (const [name, read] of Object.entries(reads))
    few[name] = await measure(read);
  await seed(30);
  for (const [name, read] of Object.entries(reads)) {
    const many = await measure(read);
    assert.equal(many.count, few[name].count, name);
  }
  // The batched reads return what each record says.
  const month = (await reads.month()).entries.filter((e) =>
    e.title.startsWith("일정 "),
  );
  assert.equal(month.length, 30);
  assert.ok(
    month.every((e) => e.hasDocument === Number(e.title.slice(3)) % 2 > 0),
  );
  const weeklyItems = (await reads.month()).weekly.filter((w) =>
    w.title.startsWith("업무 "),
  );
  assert.equal(weeklyItems.length, 30);
  assert.ok(
    weeklyItems.every(
      (w) =>
        w.documentCount === 1 &&
        w.hasDocument === Number(w.title.slice(3)) % 2 > 0,
    ),
  );
  assert.deepEqual(
    (await reads.members()).members[f.user.id],
    await reads.month(),
  );
  assert.ok(
    (await reads.tags()).tags
      .filter((tag) => tag.name.startsWith("태그 "))
      .every((tag) => tag.usageCount === 1),
  );
  assert.ok(
    (await reads.picker()).tasks
      .filter((task) => task.title.startsWith("업무 "))
      .every(
        (task) =>
          task.added &&
          task.documentCount === 1 &&
          task.hasDocument === Number(task.title.slice(3)) % 2 > 0,
      ),
  );
  assert.deepEqual(
    (await reads.filtered()).tasks.map((task) => task.id),
    (await reads.picker()).tasks
      .filter((task) => task.status === "")
      .map((task) => task.id),
  );
  const listed = await reads.tasks(),
    body =
      listed.data ||
      (listed.encoded ? unpack(JSON.parse(listed.encoded.body)) : listed),
    seededTasks = body.tasks.filter((task) =>
      String(task.cells.title?.value).startsWith("업무 "),
    );
  assert.equal(seededTasks.length, 30);
  // markdown.trim() decides content: a full-width space alone is blank.
  assert.ok(
    seededTasks.every(
      (task) =>
        task.documentCount === 1 &&
        task.hasDocument === Number(task.cells.title.value.slice(3)) % 2 > 0,
    ),
  );
});

// Slide files are in their own schema. A title lookup reads them only for
// slide links, in the transaction it already opens for the team, with one
// statement for any number of them; whether the schema exists is asked in the
// round trip that opens the transaction.
test("document link titles read linked slide files in one statement", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  await migrateSlideSchema(f.pool);
  const slides = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of slides.entries())
    await f.pool.query(
      `INSERT INTO graeboard_slides.slide_files(id,team_id,title,revision,byte_length,content_hash,created_by,created_at,updated_by,updated_at,create_request_id)
      VALUES($1,$2,$3,1,2,$4,$5,$6,$5,$6,$1)`,
      [
        id,
        f.teamId,
        "자료 " + index,
        "0".repeat(64),
        f.user.id,
        new Date().toISOString(),
      ],
    );
  const measured = { opens: 0, statements: 0, first: 0 },
    context = f.makeContext(),
    data = context.data.bind(context);
  context.data = (teamId, work, options) => {
    measured.opens++;
    measured.first += options?.first?.length || 0;
    return data(
      teamId,
      (s) => {
        const query = s.tx.query.bind(s.tx);
        s.tx.query = (...args) => {
          measured.statements++;
          return query(...args);
        };
        return work(s);
      },
      options,
    );
  };
  const service = new CalendarBusinessService(
    new PostgresCalendarRepository({ context }),
    f.user,
  );
  const measure = async (paths) => {
    Object.assign(measured, { opens: 0, statements: 0, first: 0 });
    const { links } = await service.resolveLinks({
      query: { links: paths.join(",") },
    });
    return { ...measured, titles: links.map((link) => link.title).sort() };
  };
  const task = `/links/task/${f.taskId}`,
    slide = (id) => `/links/slide/${f.teamId}/${id}`;
  const without = await measure([task]),
    one = await measure([task, slide(slides[0])]),
    three = await measure([task, ...slides.map(slide)]);
  assert.equal(without.first, 0, "no slide link, no slide store question");
  assert.deepEqual(
    [one.opens, one.statements, one.first],
    [without.opens, without.statements + 1, 1],
  );
  assert.deepEqual(
    [three.opens, three.statements, three.first],
    [one.opens, one.statements, one.first],
  );
  assert.deepEqual(
    three.titles,
    [...without.titles, "자료 0", "자료 1", "자료 2"].sort(),
  );
});
