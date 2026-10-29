import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDatabase, json, transaction, getTask } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { entityId } from "../server/sync/protocol.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-capture-")),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(join(dir, "data.sqlite")),
    teamId = randomUUID(),
    userId = randomUUID(),
    token = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Capture",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "capture@example.com", "관리자", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + 3600000,
  );
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: {
      installationId: randomUUID(),
      profiles: [{ profileId: "local", teamId, repository: "test/capture" }],
      transports: { local: transport },
      schedule: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const api = async (
    path,
    body,
    method = body ? "POST" : "GET",
    actorToken = token,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          cookie: "weekly_session=" + actorToken,
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const data = unpack(await response.json());
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await api(
    `/admin/teams/${teamId}/connection`,
    { profileId: "local", expectedRevision: 0 },
    "PUT",
  );
  return { db, teamId, userId, api, sync: app.locals.sync };
}

test("calendar commands without an audit row capture the authenticated writer, including concurrent requests", async (t) => {
  const { db, teamId, userId, api } = await fixture(t),
    second = randomUUID(),
    token = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
  ).run(second, "second@example.com", "Second", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'member')").run(
    second,
    teamId,
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    second,
    Date.now() + 3600000,
  );
  const [one, two] = await Promise.all([
    api("/calendar/entries", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-27",
      endDate: "2026-10-27",
      title: "first actor",
      tagIds: [],
    }),
    api(
      "/calendar/entries",
      {
        id: randomUUID(),
        teamId,
        userId: second,
        date: "2026-10-27",
        endDate: "2026-10-27",
        title: "second actor",
        tagIds: [],
      },
      "POST",
      token,
    ),
  ]);
  await api(
    `/calendar/entries/${two.id}`,
    { title: "second renamed", expectedTitle: "second actor" },
    "PATCH",
    token,
  );
  const ops = db
    .prepare(
      "SELECT payload FROM sync_outbox WHERE team_id=? ORDER BY local_seq",
    )
    .all(teamId)
    .map((row) => JSON.parse(row.payload));
  assert.equal(
    ops.find((op) =>
      op.changes.some((c) => c.entity === "calendar" && c.key[0] === one.id),
    ).actorRef,
    userId,
  );
  const secondOps = ops.filter((op) =>
    op.changes.some((c) => c.entity === "calendar" && c.key[0] === two.id),
  );
  assert.equal(secondOps.length, 2);
  assert.ok(secondOps.every((op) => op.actorRef === second));
});

test("offline task/calendar Undo and following child edits keep pending output generations before publication and after capture refresh", async (t) => {
  const { db, teamId, userId, api, sync } = await fixture(t);
  const task = (
    await api("/tasks", { teamId, year: 2026, fields: { title: "original" } })
  ).task;
  await api(
    `/tasks/${task.id}/document`,
    { markdown: "task body", expectedRevision: 0, operationId: randomUUID() },
    "PUT",
  );
  const entry = await api("/calendar/entries", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-27",
    title: "calendar",
  });
  await api(
    `/calendar/entries/${entry.id}/document`,
    {
      markdown: "calendar body",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
    "PUT",
  );
  await api(`/teams/${teamId}/sync/enable`, {});
  const store = sync.store(teamId);
  for (const refresh of [false, true]) {
    const deleted = await api(
      `/tasks/${task.id}`,
      { updatedAt: getTask(db, task.id).updatedAt },
      "DELETE",
    );
    await api(`/tasks/${task.id}/restore`, { updatedAt: deleted.updatedAt });
    if (refresh) sync.capture.refresh();
    const current = getTask(db, task.id),
      value = `restored ${refresh}`;
    await api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value,
          expectedVersion: current.cells.title.version,
        },
      ],
    });
    const document = await api(`/tasks/${task.id}/document`);
    await api(
      `/tasks/${task.id}/document`,
      {
        markdown: value,
        expectedRevision: document.revision,
        operationId: randomUUID(),
      },
      "PUT",
    );
    const pending = store.readPending(),
      deletion = pending.find((op) =>
        op.changes.some((c) => c.entity === "task" && c.action === "delete"),
      ),
      restoration = pending.find((op) =>
        op.changes.some((c) => c.entity === "task" && c.action === "restore"),
      );
    const restoredIndex = restoration.changes.findIndex(
      (c) => c.entity === "task",
    );
    assert.equal(
      restoration.changes[restoredIndex].baseVersion,
      `${deletion.opId}:${deletion.changes.findIndex((c) => c.entity === "task")}`,
    );
    for (const op of pending)
      for (const change of op.changes)
        if (["cell", "document"].includes(change.entity))
          assert.equal(
            change.generation,
            `${restoration.opId}:${restoredIndex}`,
          );
    await sync.get(teamId).run();
    assert.deepEqual(Object.keys(store.readState().conflicts), []);
    assert.equal(getTask(db, task.id).deletedAt, null);
    assert.equal(getTask(db, task.id).cells.title.value, value);
    assert.equal((await api(`/tasks/${task.id}/document`)).markdown, value);
  }
  const calendar = await api(`/calendar/entries/${entry.id}`),
    deletionId = randomUUID();
  await api(
    `/calendar/entries/${entry.id}`,
    {
      deletionId,
      expectedUpdatedAt: calendar.updatedAt,
      expectedRevision: calendar.revision,
      expectedTitle: calendar.title,
      expectedDate: calendar.date,
      expectedEndDate: calendar.endDate,
      expectedTagIds: calendar.tagIds,
      expectedCheckedTagIds: calendar.checkedTagIds,
    },
    "DELETE",
  );
  await api(`/calendar/entries/${entry.id}/restore`, { deletionId });
  sync.capture.refresh();
  const document = await api(`/calendar/entries/${entry.id}/document`);
  await api(
    `/calendar/entries/${entry.id}/document`,
    {
      markdown: "after calendar Undo",
      expectedRevision: document.revision,
      operationId: randomUUID(),
    },
    "PUT",
  );
  await sync.get(teamId).run();
  assert.deepEqual(Object.keys(store.readState().conflicts), []);
  assert.equal(
    (await api(`/calendar/entries/${entry.id}/document`)).markdown,
    "after calendar Undo",
  );
});

test("cached display references see newly registered users and rollback retains the first before/final after payload", async (t) => {
  const { db, teamId, api, sync } = await fixture(t);
  const task = (
    await api("/tasks", { teamId, year: 2026, fields: { title: "original" } })
  ).task;
  await api(`/teams/${teamId}/sync/enable`, {});
  const save = async (value) =>
    api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value,
          expectedVersion: getTask(db, task.id).cells.title.version,
        },
      ],
    });
  await save("warm user reference cache");
  const person = (
    await api("/admin/users", {
      username: "new-capture@example.com",
      password: "local-capture-test-password",
      name: "새 표시 이름",
    })
  ).user;
  await save(`display ${person.id}`);
  const pending = sync.store(teamId).readPending();
  const reference = pending
    .flatMap((op) => op.changes)
    .find((c) => c.entity === "person" && c.key[0] === person.id);
  assert.equal(reference.desired.name, "새 표시 이름");
  const beforeCount = pending.length,
    beforeValue = getTask(db, task.id).cells.title.value;
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare(
          "UPDATE cells SET value='\"rolled back\"' WHERE task_id=? AND key='title'",
        ).run(task.id);
        throw new Error("rollback");
      }),
    /rollback/,
  );
  assert.equal(sync.store(teamId).readPending().length, beforeCount);
  assert.equal(getTask(db, task.id).cells.title.value, beforeValue);
  transaction(db, () => {
    db.prepare(
      "UPDATE cells SET value='\"intermediate\"' WHERE task_id=? AND key='title'",
    ).run(task.id);
    db.prepare(
      "UPDATE cells SET value='\"final\"' WHERE task_id=? AND key='title'",
    ).run(task.id);
  });
  const last = sync.store(teamId).readPending().at(-1),
    change = last.changes.find(
      (c) => entityId(c.entity, c.key) === entityId("cell", [task.id, "title"]),
    );
  assert.equal(change.base.value, beforeValue);
  assert.equal(change.desired.value, "final");
  await sync.get(teamId).run();
  assert.deepEqual(Object.keys(sync.store(teamId).readState().conflicts), []);
});

test("cell saves reuse their transaction before-image without losing styles, creation or trigger fallback", async (t) => {
  const { db, teamId, api, sync } = await fixture(t);
  const task = (
    await api("/tasks", { teamId, year: 2026, fields: { title: "before" } })
  ).task;
  const save = (changes) =>
    api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes,
    });
  await save([
    {
      taskId: task.id,
      key: "title",
      value: "styled",
      style: { bold: true },
      expectedVersion: getTask(db, task.id).cells.title.version,
    },
  ]);
  await api(`/teams/${teamId}/sync/enable`, {});
  const store = sync.store(teamId),
    canonicalCell =
      store.readState().entities[entityId("cell", [task.id, "title"])];
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")),
    originalGet = proto.get;
  let beforeReads = 0;
  proto.get = function (...args) {
    if (this.sourceSQL.startsWith("SELECT c.* FROM cells c JOIN tasks"))
      beforeReads++;
    return originalGet.apply(this, args);
  };
  try {
    await save([
      {
        taskId: task.id,
        key: "title",
        value: "changed",
        style: {},
        expectedVersion: getTask(db, task.id).cells.title.version,
      },
      {
        taskId: task.id,
        key: "2026-11-02",
        value: "new cell",
        expectedVersion: 0,
      },
    ]);
    assert.equal(
      beforeReads,
      0,
      "capture must reuse the same-transaction business read",
    );
    const op = store.readPending().at(-1),
      edited = op.changes.find(
        (c) => c.entity === "cell" && c.key[1] === "title",
      ),
      created = op.changes.find(
        (c) => c.entity === "cell" && c.key[1] === "2026-11-02",
      );
    assert.deepEqual(edited.base, { value: "styled", style: { bold: true } });
    assert.deepEqual(edited.desired, { value: "changed", style: {} });
    assert.equal(edited.baseVersion, canonicalCell.version);
    assert.equal(edited.generation, canonicalCell.generation);
    assert.equal(created.base, null);
    assert.equal(created.action, "create");
    const hint = sync.capture.cellSaving;
    sync.capture.cellSaving = () => {};
    try {
      await save([
        {
          taskId: task.id,
          key: "title",
          value: "fallback",
          expectedVersion: getTask(db, task.id).cells.title.version,
        },
      ]);
    } finally {
      sync.capture.cellSaving = hint;
    }
    assert.ok(
      beforeReads > 0,
      "ordinary SQL paths still obtain their before-image from the trigger",
    );
    assert.deepEqual(
      store
        .readPending()
        .at(-1)
        .changes.find((c) => c.entity === "cell").base,
      edited.desired,
    );
  } finally {
    proto.get = originalGet;
  }
  await sync.get(teamId).run();
  assert.equal(store.readPending().length, 0);
  assert.equal(getTask(db, task.id).cells.title.value, "fallback");
  assert.equal(getTask(db, task.id).cells["2026-11-02"].value, "new cell");
});
