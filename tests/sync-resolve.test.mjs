import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { entityId, stateHash } from "../server/sync/protocol.mjs";
import { reduceMany, project } from "../server/sync/reducer.mjs";
import { getTask } from "../server/db.mjs";
import { unpack } from "../shared/compact.js";

async function fixture(t, rows = 3) {
  const f = await performanceFixture({ rows, users: 1, clients: 1 });
  t.after(() => f.close());
  f.setLink("paused");
  const s = f.app.locals.sync.store(f.teamId),
    link = s.readLink();
  const entities = allEntities(f.db, link),
    key = entityId("cell", [f.taskIds[0], "title"]);
  const original = entities[key],
    actorRef = f.db.prepare("SELECT id FROM users LIMIT 1").get().id;
  const submitted = makeOperation({
    link,
    actorRef,
    before: { [key]: original },
    after: {
      [key]: {
        ...original,
        payload: { ...original.payload, value: "submitted" },
      },
    },
  });
  entities[key] = {
    ...original,
    payload: { ...original.payload, value: "canonical" },
    version: "winner",
  };
  const state = reduceMany({ entities, receipts: {}, conflicts: {} }, [
    submitted,
  ]);
  assert.equal(state.receipts[submitted.opId].result, "conflict");
  f.app.locals.sync.capture.without(() =>
    f.db
      .prepare("UPDATE cells SET value=? WHERE task_id=? AND key='title'")
      .run('"canonical"', f.taskIds[0]),
  );
  s.writeState(state, "a".repeat(40));
  s.writeLink({
    canonical_head: "a".repeat(40),
    canonical_hash: stateHash(state),
  });
  f.app.locals.sync.capture.refresh();
  const api = async (path, body, method = "POST") => {
    const response = await fetch(f.origin + "/api" + path, {
      method,
      headers: {
        cookie: "weekly_session=" + f.tokens[0],
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: unpack(await response.json()) };
  };
  const save = (value, taskId = f.taskIds[1]) =>
    api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId,
          key: "title",
          value,
          expectedVersion: getTask(f.db, taskId).cells.title.version,
        },
      ],
    });
  const resolve = (body = {}) =>
    api(`/teams/${f.teamId}/sync/conflicts/${submitted.opId}/resolve`, {
      expectedHead: "a".repeat(40),
      choice: "submitted",
      ...body,
    });
  const gate = () => {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      waiting = new Promise((r) => (release = r)),
      metrics = [];
    f.runtimeOptions.onResolvePrepared = async (value) => {
      metrics.push(value);
      if (value.attempt === 0) {
        enter();
        await waiting;
      }
    };
    return { entered, release, metrics };
  };
  return { ...f, s, key, state, submitted, api, save, resolve, gate };
}

test("resolve domain SELECT executions stay bounded as unrelated C grows", async (t) => {
  const counts = [];
  for (const rows of [3, 300]) {
    const f = await fixture(t, rows);
    let measured;
    f.runtimeOptions.onResolvePrepared = (value) => (measured = value);
    assert.equal((await f.resolve()).status, 200);
    assert.equal(getTask(f.db, f.taskIds[0]).cells.title.value, "submitted");
    assert.equal(measured.readEntityCount, 1);
    assert.equal(measured.domainSelectCount, 2);
    assert.equal(measured.changedEntityCount, 1);
    counts.push(measured.domainSelectCount);
  }
  assert.equal(counts[0], counts[1]);
});

test("actual resolve preserves unrelated concurrent API save without retry and captures a following dependency", async (t) => {
  const f = await fixture(t),
    gate = f.gate(),
    pending = f.resolve();
  await gate.entered;
  assert.equal(f.s.readPending().length, 0, "prepare must not enqueue");
  assert.equal((await f.save("concurrent")).status, 200);
  gate.release();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(gate.metrics.length, 1);
  assert.equal(getTask(f.db, f.taskIds[1]).cells.title.value, "concurrent");
  assert.equal(getTask(f.db, f.taskIds[0]).cells.title.value, "submitted");
  assert.equal((await f.save("following", f.taskIds[0])).status, 200);
  assert.ok(f.s.readPending().at(-1).dependsOn.includes(result.data.opId));
  const projected = project(f.state, f.s.readPending());
  assert.equal(projected.entities[f.key].payload.value, "following");
});

for (const action of ["same cell", "parent delete"])
  test(`actual resolve rechecks ${action} after preparation without losing its operation`, async (t) => {
    const f = await fixture(t),
      gate = f.gate(),
      pending = f.resolve();
    await gate.entered;
    const mutation =
      action === "same cell"
        ? await f.save("new local edit", f.taskIds[0])
        : await f.api(
            `/tasks/${f.taskIds[0]}`,
            { updatedAt: getTask(f.db, f.taskIds[0]).updatedAt },
            "DELETE",
          );
    assert.equal(mutation.status, 200, JSON.stringify(mutation));
    const immutable = f.s.readPendingRows().map((row) => row.operation);
    gate.release();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(
      gate.metrics.length,
      2,
      "intersecting P must cause fresh projection",
    );
    assert.deepEqual(f.s.readPending().slice(0, immutable.length), immutable);
    if (action === "same cell")
      assert.equal(
        getTask(f.db, f.taskIds[0]).cells.title.value,
        "new local edit",
      );
    else assert.ok(getTask(f.db, f.taskIds[0]).deletedAt);
    const projected = project(f.state, f.s.readPending());
    assert.ok(
      projected.held.includes(result.data.opId),
      "conflicting resolution must remain as a held immutable submission",
    );
  });

test("actual resolve rejects stale head and revoked authority after async preparation", async (t) => {
  for (const cause of ["head", "permission"]) {
    const f = await fixture(t),
      gate = f.gate(),
      pending = f.resolve();
    await gate.entered;
    if (cause === "head") f.s.writeLink({ canonical_head: "b".repeat(40) });
    else {
      f.db.prepare("UPDATE users SET system_role='user'").run();
      f.db.prepare("DELETE FROM memberships WHERE team_id=?").run(f.teamId);
    }
    gate.release();
    const result = await pending;
    assert.equal(
      result.status,
      cause === "head" ? 409 : 403,
      JSON.stringify(result),
    );
    assert.equal(f.s.readPending().length, 0);
    assert.equal(getTask(f.db, f.taskIds[0]).cells.title.value, "canonical");
  }
});

test("resolve materialization failure rolls back P, visible data and audit and emits no SSE", async (t) => {
  const f = await fixture(t),
    gate = f.gate();
  let published = 0;
  const publish = f.app.locals.cellEvents.publish;
  f.app.locals.cellEvents.publish = (...args) => {
    published++;
    return publish(...args);
  };
  const auditBefore = f.db.prepare("SELECT COUNT(*) n FROM audit").get().n;
  const pending = f.resolve();
  await gate.entered;
  f.db.exec(
    "CREATE TEMP TRIGGER fail_resolution BEFORE UPDATE ON cells BEGIN SELECT RAISE(ABORT,'resolution materialization failure'); END",
  );
  gate.release();
  const result = await pending;
  assert.equal(result.status, 500);
  assert.equal(f.s.readPending().length, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
    auditBefore,
  );
  assert.equal(getTask(f.db, f.taskIds[0]).cells.title.value, "canonical");
  assert.equal(published, 0);
});

test("resolve replans changed site-local exclusion and preserves hidden original data", async (t) => {
  const f = await fixture(t),
    gate = f.gate(),
    pending = f.resolve();
  await gate.entered;
  f.db
    .prepare("INSERT INTO site_retention VALUES(?,?,?,?,?,?,?)")
    .run(
      f.teamId,
      f.s.readLink().installation_id,
      "year",
      "[2026]",
      "",
      1,
      new Date().toISOString(),
    );
  gate.release();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(gate.metrics.length, 2);
  assert.equal(
    getTask(f.db, f.taskIds[0]).cells.title.value,
    "canonical",
    "hidden original remains physically intact",
  );
  assert.equal(
    project(f.state, f.s.readPending()).entities[f.key].payload.value,
    "submitted",
    "canonical submission remains pending independently of L",
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM site_retention WHERE team_id=?")
      .get(f.teamId).n,
    1,
  );
});

// Establish a canonical conflict after creating its business rows through the
// ordinary API. Only fixture setup acknowledges those initial local operations.
function semanticConflict(f, entity, key, base, desired) {
  const initialPending = f.s.readPending(),
    link = f.s.readLink();
  const seeded = reduceMany(f.s.readState(), initialPending),
    entities = seeded.entities,
    id = entityId(entity, key);
  const current = entities[id],
    original = { ...current, payload: { ...current.payload, ...base } };
  const submitted = makeOperation({
    link,
    actorRef: f.submitted.actorRef,
    before: { [id]: original },
    after: {
      [id]: { ...original, payload: { ...original.payload, ...desired } },
    },
  });
  const next = reduceMany(seeded, [submitted]);
  assert.equal(next.receipts[submitted.opId].result, "conflict");
  f.s.writeState(next, link.canonical_head);
  f.s.acknowledge(initialPending.map((op) => op.opId));
  const state = f.s.readState();
  f.s.writeLink({ canonical_hash: stateHash(state) });
  f.app.locals.sync.capture.refresh();
  return {
    id,
    state,
    resolve: () =>
      f.api(`/teams/${f.teamId}/sync/conflicts/${submitted.opId}/resolve`, {
        expectedHead: link.canonical_head,
        choice: "submitted",
      }),
  };
}

test("resolve replans concurrent tag-name uniqueness and preserves the accepted rename", async (t) => {
  const f = await fixture(t);
  const createTag = (name) =>
    f.api(`/calendar/teams/${f.teamId}/tags`, {
      id: randomUUID(),
      name,
      color: "green",
      kind: "label",
    });
  const first = await createTag("Canonical tag"),
    second = await createTag("Other tag");
  assert.equal(first.status, 201, JSON.stringify(first));
  assert.equal(second.status, 201, JSON.stringify(second));
  const conflict = semanticConflict(
    f,
    "tag",
    [first.data.id],
    { name: "Original tag" },
    { name: "Shared name" },
  );
  const gate = f.gate(),
    pending = conflict.resolve();
  await gate.entered;
  const renamed = await f.api(
    `/calendar/tags/${second.data.id}`,
    {
      name: "Shared name",
      color: second.data.color,
      expectedRevision: second.data.revision,
    },
    "PATCH",
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed));
  const immutable = f.s.readPending();
  assert.equal(immutable.length, 1);
  gate.release();
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(
    gate.metrics.length,
    2,
    "different tag IDs still interfere through the unique-name constraint",
  );
  assert.deepEqual(f.s.readPending().slice(0, immutable.length), immutable);
  assert.equal(
    f.db.prepare("SELECT name FROM calendar_tags WHERE id=?").get(first.data.id)
      .name,
    "Canonical tag",
  );
  assert.equal(
    f.db
      .prepare("SELECT name FROM calendar_tags WHERE id=?")
      .get(second.data.id).name,
    "Shared name",
  );
  const projected = project(conflict.state, f.s.readPending());
  assert.ok(projected.held.includes(result.data.opId));
  assert.equal(projected.entities[conflict.id].payload.name, "Canonical tag");
  assert.equal(
    reduceMany(conflict.state, f.s.readPending()).conflicts[result.data.opId]
      .reason,
    "Duplicate name",
  );
  assert.equal(
    stateHash(f.s.readState()),
    stateHash(conflict.state),
    "resolution remains P until publication",
  );
});

test("resolve replans a calendar entry when its referenced tag is concurrently deleted", async (t) => {
  const f = await fixture(t);
  const tag = await f.api(`/calendar/teams/${f.teamId}/tags`, {
    id: randomUUID(),
    name: "Referenced tag",
    color: "green",
    kind: "label",
  });
  assert.equal(tag.status, 201, JSON.stringify(tag));
  const entry = await f.api("/calendar/entries", {
    id: randomUUID(),
    teamId: f.teamId,
    userId: tag.data.userId,
    date: "2026-10-19",
    title: "Canonical entry",
    tagIds: [],
  });
  assert.equal(entry.status, 201, JSON.stringify(entry));
  const conflict = semanticConflict(
    f,
    "calendar",
    [entry.data.id],
    { title: "Original entry" },
    {
      title: "Submitted entry",
      tags: [{ id: tag.data.id, checked: false }],
    },
  );
  const gate = f.gate(),
    pending = conflict.resolve();
  await gate.entered;
  const deleted = await f.api(
    `/calendar/tags/${tag.data.id}`,
    { expectedRevision: tag.data.revision },
    "DELETE",
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted));
  const immutable = f.s.readPending();
  assert.equal(immutable.length, 1);
  assert.deepEqual(
    immutable[0].changes.map((change) => change.entity),
    ["tag"],
    "only the dependency changes while the calendar entry stays untouched",
  );
  gate.release();
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(
    gate.metrics.length,
    2,
    "calendar desired tag reference must fence a concurrent tag deletion",
  );
  assert.deepEqual(f.s.readPending().slice(0, immutable.length), immutable);
  assert.equal(
    f.db.prepare("SELECT id FROM calendar_tags WHERE id=?").get(tag.data.id),
    undefined,
  );
  assert.equal(
    f.db
      .prepare("SELECT title FROM calendar_entries WHERE id=?")
      .get(entry.data.id).title,
    "Canonical entry",
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM calendar_entry_tags WHERE entry_id=?")
      .get(entry.data.id).n,
    0,
  );
  const projected = project(conflict.state, f.s.readPending());
  assert.ok(projected.held.includes(result.data.opId));
  assert.equal(
    projected.entities[conflict.id].payload.title,
    "Canonical entry",
  );
  assert.equal(
    projected.entities[entityId("tag", [tag.data.id])].deleted,
    true,
  );
  assert.equal(
    reduceMany(conflict.state, f.s.readPending()).conflicts[result.data.opId]
      .reason,
    "Missing or foreign calendar tag",
  );
  assert.equal(stateHash(f.s.readState()), stateHash(conflict.state));
});

test("async resolution keeps validation failures as HTTP 400 and never enqueues malformed frontier", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { choice: "invalid" },
    { frontier: [f.submitted.opId, "toString"] },
    { frontier: [f.submitted.opId, {}] },
    { choice: "edited", desired: { unknown: true } },
  ]) {
    assert.equal((await f.resolve(body)).status, 400);
    assert.equal(f.s.readPending().length, 0);
  }
});
