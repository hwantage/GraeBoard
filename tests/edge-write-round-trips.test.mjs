import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { canonical } from "../server/sync/protocol.mjs";

// The external site pays a remote round trip for every SQL statement, so a
// save or an event poll must not issue more statements as the team grows.

const request = (changes) => ({
  operationId: randomUUID(),
  createdAt: new Date().toISOString(),
  changes,
});
const sqlText = (sql) => (typeof sql === "string" ? sql : sql.text);
// Reads of one entity issued by DataSession (get/getMany/list).
const reads = (log, entity) =>
  log.filter(
    (q) =>
      /^SELECT \* FROM site_entities/.test(q.sql) && q.params?.[1] === entity,
  );

test("PostgreSQL: a cell save checks every member's person record in one query", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  // The person check runs inside ctx.data before the route's work callback,
  // so the save is counted at the team connection: every statement of the
  // save, its person check included.
  let log = null;
  f.env.PG_TEAM.pool = {
    async connect() {
      const client = await f.pool.connect();
      // A fresh view per checkout, so a reused pool client is wrapped once.
      return Object.assign(Object.create(client), {
        query: (sql, params) => {
          log?.push({ sql: sqlText(sql), params });
          return client.query(sql, params);
        },
        release: (error) => client.release(error),
      });
    },
  };
  const cellVersion = async () =>
    Number(
      (
        await f.pool.query(
          "SELECT revision FROM graeboard.site_entities WHERE entity='cell' AND entity_key=$1",
          [canonical([f.taskId, "title"])],
        )
      ).rows[0]?.revision || 0,
    );
  const save = async (value) => {
    const expectedVersion = await cellVersion();
    log = [];
    const result = await new PostgresTaskRepository({
      context: f.makeContext(),
    }).saveBatch(
      f.user,
      request([{ taskId: f.taskId, key: "title", expectedVersion, value }]),
    );
    const queries = log;
    log = null;
    assert.equal(result.cells.length, 1);
    return queries;
  };
  const people = async () =>
    (
      await f.pool.query(
        "SELECT entity_key FROM graeboard.site_entities WHERE entity='person' ORDER BY entity_key",
      )
    ).rows.map((row) => JSON.parse(row.entity_key)[0]);
  const lastOperation = async () =>
    JSON.parse(
      (
        await f.pool.query(
          "SELECT payload FROM graeboard.sync_outbox ORDER BY local_seq DESC LIMIT 1",
        )
      ).rows[0].payload,
    );

  // A first save creates whatever person record is missing; the next one
  // finds them all and is the steady state measured below.
  await save("few warm-up");
  const few = await save("few members");
  assert.ok((await people()).includes(f.user.id));

  const members = Array.from({ length: 40 }, (_, index) => ({
    id: randomUUID(),
    name: "Member " + String(index).padStart(2, "0"),
  }));
  for (const member of members) {
    await f.control.query(
      "INSERT INTO graeboard.users(id,username,email,name,created_at) VALUES($1,$2,$2,$3,$4)",
      [
        member.id,
        member.name.replace(" ", "") + "@example.test",
        member.name,
        new Date().toISOString(),
      ],
    );
    await f.control.query(
      "INSERT INTO graeboard.memberships VALUES($1,$2,'member')",
      [member.id, f.teamId],
    );
  }
  // The save that first sees the new members writes their records in member
  // order (name, then id), ahead of the cell it saves.
  await save("many warm-up");
  assert.deepEqual(
    (await lastOperation()).changes
      .filter((change) => change.entity === "person")
      .map((change) => change.key[0]),
    members.map((member) => member.id),
  );
  assert.deepEqual(
    (await lastOperation()).changes
      .filter((change) => change.entity === "person")
      .map((change) => change.desired.name),
    members.map((member) => member.name),
  );
  const known = await people();
  for (const member of members) assert.ok(known.includes(member.id));

  const many = await save("many members");
  assert.equal(reads(few, "person").length, 1);
  assert.equal(reads(many, "person").length, 1);
  assert.equal(
    many.length,
    few.length,
    "a cell save must cost the same SQL round trips for 1 or 41 members",
  );
  assert.deepEqual(
    many.map((q) => q.sql),
    few.map((q) => q.sql),
  );
});

test("PostgreSQL: a cell events poll reads every task it names in one query", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const template = JSON.parse(
    (
      await f.pool.query(
        "SELECT payload FROM graeboard.site_entities WHERE entity='task' AND entity_key=$1",
        [canonical([f.taskId])],
      )
    ).rows[0].payload,
  );
  assert.ok(template.years.includes(2026));
  const addTask = async (id, years = template.years) => {
    await f.pool.query(
      "INSERT INTO graeboard.site_entities VALUES($1,'task',$2,$3,1,0)",
      [f.teamId, canonical([id]), canonical({ ...template, years })],
    );
    await f.pool.query(
      "INSERT INTO graeboard.site_entity_revisions VALUES($1,'task',$2,1)",
      [f.teamId, canonical([id])],
    );
  };
  const addEvent = (taskIds) =>
    f.pool.query(
      "INSERT INTO graeboard.site_events(team_id,kind,payload,created_at) VALUES($1,'cells',$2,$3)",
      [
        f.teamId,
        canonical({
          cells: taskIds.map((taskId) => ({
            taskId,
            key: "title",
            value: "evented " + taskId,
            style: {},
            version: 2,
          })),
          operationId: randomUUID(),
          updatedAt: Object.fromEntries(taskIds.map((id) => [id, "stamp"])),
        }),
        new Date().toISOString(),
      ],
    );
  const cursor = async () =>
    "pg:" +
    Number(
      (
        await f.pool.query(
          "SELECT COALESCE(MAX(cursor),0) AS cursor FROM graeboard.site_events",
        )
      ).rows[0].cursor,
    );
  // Wraps the DataSession transaction the way the external routes see it.
  const poll = async (after) => {
    const context = f.makeContext(),
      original = context.data.bind(context),
      log = [];
    context.data = (teamId, work, options) =>
      original(
        teamId,
        async (s) => {
          const query = s.tx.query;
          s.tx.query = (sql, params) => {
            log.push({ sql: sqlText(sql), params });
            return query(sql, params);
          };
          return work(s);
        },
        options,
      );
    const batch = await new PostgresTaskRepository({ context }).readEvents(
      f.user,
      { teamId: f.teamId, year: 2026, startMonth: 1 },
      after,
    );
    assert.equal(batch.reset, false);
    return { batch, log };
  };

  let after = await cursor();
  await addEvent([f.taskId]);
  const few = await poll(after);
  assert.deepEqual(
    few.batch.events.flatMap((event) =>
      event.payload.cells.map((cell) => cell.taskId),
    ),
    [f.taskId],
  );

  // Forty more tasks across three events, one repeated, one outside the
  // subscribed year and one never stored: only visible tasks are delivered.
  const tasks = Array.from({ length: 40 }, () => randomUUID()),
    outside = randomUUID(),
    missing = randomUUID();
  for (const id of tasks) await addTask(id);
  await addTask(outside, [2020]);
  after = await cursor();
  await addEvent(tasks.slice(0, 15));
  await addEvent([...tasks.slice(15, 30), outside, tasks[0]]);
  await addEvent([...tasks.slice(30), missing, f.taskId]);
  const many = await poll(after);
  assert.equal(many.batch.events.length, 3);
  assert.deepEqual(
    many.batch.events.map((event) =>
      event.payload.cells.map((cell) => cell.taskId),
    ),
    [
      tasks.slice(0, 15),
      [...tasks.slice(15, 30), tasks[0]],
      [...tasks.slice(30), f.taskId],
    ],
  );
  assert.deepEqual(Object.keys(many.batch.events[1].payload.updatedAt), [
    ...tasks.slice(15, 30),
    tasks[0],
  ]);

  assert.equal(reads(few.log, "task").length, 1);
  assert.equal(reads(many.log, "task").length, 1);
  assert.equal(
    many.log.length,
    few.log.length,
    "an events poll must cost the same SQL round trips for 1 or 43 tasks",
  );
  assert.deepEqual(
    many.log.map((q) => q.sql),
    few.log.map((q) => q.sql),
  );
});
