import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { DocumentBusinessService } from "../server/storage/documents/document-service.mjs";
import { SheetCloneBusinessService } from "../server/storage/sheet-clone-service.mjs";
import { PostgresSheetCloneRepository } from "../worker/storage/postgres-sheet-clones.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";
import { DataSession } from "../worker/data.mjs";
import {
  streamScope,
  eventTouches,
  sheetQuiet,
} from "../worker/event-scope.mjs";

const changed = (...entities) => ({
  kind: "changed",
  payload: { entities: entities.map(([entity, key]) => ({ entity, key })) },
});
const save = (markdown, expectedRevision) => ({
  markdown,
  expectedRevision,
  operationId: randomUUID(),
});

test("stream scopes skip events that name none of their records", () => {
  const team = streamScope("/teams/t"),
    copy = streamScope("/sheet-clones/r"),
    memo = streamScope("/sheet-clones/r/memos/m", {
      kind: "sheetCloneMemo",
      prefix: ["sheetCloneMemo", "r"],
      documentId: "m",
    }),
    memos = streamScope("/sheet-clones/r/memos", {
      kind: "sheetCloneMemo",
      prefix: ["sheetCloneMemo", "r"],
    }),
    taskDoc = streamScope("/tasks/a/documents/main", {
      kind: "task",
      prefix: ["task", "a"],
      documentId: "main",
    });
  const memoSave = changed(["document", ["sheetCloneMemo", "r", "m"]]),
    otherMemo = changed(["document", ["sheetCloneMemo", "r", "n"]]),
    copyEdit = changed(["sheetClone", ["r"]]),
    copyRowDoc = changed(["document", ["sheetClone", "r", "a", "main"]]),
    calendarDoc = changed(["document", ["calendar", "e", "main"]]),
    taskEdit = changed(["task", ["a"]]),
    cell = changed(["cell", ["a", "title"]]),
    rule = changed(["rule", ["x"]]),
    sync = { kind: "changed", payload: { teamId: "t", source: "sync" } },
    cells = { kind: "cells", payload: null };

  // A copy memo's body reaches only its own stream and the memo list.
  assert.deepEqual(
    [team, copy, memo, memos].map((s) => eventTouches(s, memoSave)),
    [false, false, true, true],
  );
  assert.equal(eventTouches(memo, otherMemo), false);
  assert.equal(eventTouches(memos, otherMemo), true);
  // A copy edit reaches the copy, its copies list (team) and its documents,
  // which may have lost their row.
  assert.deepEqual(
    [team, copy, memo, memos].map((s) => eventTouches(s, copyEdit)),
    [true, true, true, true],
  );
  assert.equal(eventTouches(copy, copyRowDoc), true);
  assert.equal(eventTouches(team, copyRowDoc), false);
  // Calendar and task documents stay team-wide, as on the internal site.
  assert.equal(eventTouches(team, calendarDoc), true);
  assert.equal(eventTouches(copy, calendarDoc), false);
  assert.equal(eventTouches(memo, calendarDoc), false);
  // Cell values follow the cell stream; task rows also reach the team.
  assert.equal(eventTouches(team, cell), false);
  assert.equal(eventTouches(team, taskEdit), true);
  assert.equal(eventTouches(copy, taskEdit), false);
  assert.equal(eventTouches(taskDoc, taskEdit), true);
  assert.equal(eventTouches(team, cells), false);
  // Records outside the scoped kinds, and events without names, reach all.
  for (const scope of [team, copy, memo, memos, taskDoc]) {
    assert.equal(eventTouches(scope, rule), true);
    assert.equal(eventTouches(scope, sync), true);
  }
  // The cell stream keeps its rows for documents, calendar entries and copies.
  assert.equal(sheetQuiet(memoSave), true);
  assert.equal(sheetQuiet(calendarDoc), true);
  assert.equal(sheetQuiet(copyEdit), true);
  assert.equal(sheetQuiet(changed(["document", ["task", "a", "main"]])), true);
  assert.equal(sheetQuiet(taskEdit), false);
  assert.equal(sheetQuiet(cell), false);
  assert.equal(sheetQuiet(sync), false);
});

test("external streams send a copy, its memo and the team only the events naming their records", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  f.env.EVENT_STREAM_POLL_MS = 40;
  const documents = new DocumentBusinessService(
      f.makeRepository(f.user),
      f.user,
    ),
    memoId = randomUUID(),
    memo = {
      kind: "sheetCloneMemo",
      sheetCloneId: f.sheetCloneId,
      documentId: memoId,
    },
    taskDoc = { kind: "task", taskId: f.taskId, documentId: "main" };
  await documents.create(
    { kind: "sheetCloneMemo", sheetCloneId: f.sheetCloneId },
    {
      id: memoId,
    },
  );
  await documents.save(
    memo,
    save("메모 처음", (await documents.read(memo)).revision),
  );
  const cursor = async () =>
    "pg:" +
    (
      await f.pool.query(
        "SELECT COALESCE(MAX(cursor),0) AS c FROM graeboard.site_events WHERE team_id=$1",
        [f.teamId],
      )
    ).rows[0].c;
  const sendEvent = (payload) =>
    f.pool.query(
      "INSERT INTO graeboard.site_events(team_id,kind,payload,created_at) VALUES($1,'changed',$2,$3)",
      [f.teamId, JSON.stringify(payload), new Date().toISOString()],
    );

  // Saving a copy memo reads the copy's row only to know it is live.
  const reads = [],
    get = DataSession.prototype.get;
  DataSession.prototype.get = function (entity, key) {
    reads.push(entity);
    return get.call(this, entity, key);
  };
  try {
    await documents.save(
      memo,
      save("메모 둘째", (await documents.read(memo)).revision),
    );
  } finally {
    DataSession.prototype.get = get;
  }
  assert.equal(reads.includes("sheetClone"), false, reads.join(","));

  const app = createExternalRouteApp({ env: f.env, defaultUserId: f.user.id });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    at = await cursor();
  const response = await fetch(origin + "/api/events", {
    method: "POST",
    headers: {
      Cookie: "weekly_session=" + f.user.id,
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    body: JSON.stringify({
      streams: [
        {
          id: 1,
          path: `/api/sheet-clones/${f.sheetCloneId}/events`,
          lastEventId: at,
        },
        {
          id: 2,
          path: `/api/sheet-clones/${f.sheetCloneId}/memos/${memoId}/events`,
          lastEventId: at,
        },
        { id: 3, path: `/api/teams/${f.teamId}/events`, lastEventId: at },
      ],
    }),
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    pending = reader.read();
  const frames = [];
  // Reads frames for `ms`; returns those whose event is "document".
  const collect = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const next = await Promise.race([
        pending,
        new Promise((resolve) =>
          setTimeout(() => resolve(null), end - Date.now()),
        ),
      ]);
      if (!next) break;
      pending = reader.read();
      assert.equal(next.done, false);
      buffer += decoder.decode(next.value);
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (block.startsWith("event: stream") && data) {
          const frame = JSON.parse(data);
          if (frame.event === "document")
            frames.push({ id: frame.id, data: JSON.parse(frame.data) });
        }
      }
    }
    return frames.splice(0);
  };
  const ids = (list) => [...new Set(list.map((frame) => frame.id))].sort();

  // Reconnecting at the current cursor sends nothing.
  assert.deepEqual(await collect(400), []);
  // A task document reaches the team, not the copy or its memo.
  await documents.save(
    taskDoc,
    save("업무 문서", (await documents.read(taskDoc)).revision),
  );
  assert.deepEqual(ids(await collect(600)), [3]);
  // The memo's body reaches only the memo.
  await documents.save(
    memo,
    save("메모 셋째", (await documents.read(memo)).revision),
  );
  const memoFrames = await collect(600);
  assert.deepEqual(ids(memoFrames), [2]);
  assert.equal(memoFrames[0].data.markdown, "메모 셋째");
  // Renaming the copy reaches the copy and the team; the memo is unchanged.
  const sheetClones = new SheetCloneBusinessService(
    new PostgresSheetCloneRepository({ context: f.makeContext(f.user) }),
    f.user,
  );
  const { name } = await sheetClones.read(f.sheetCloneId);
  await sheetClones.rename(f.sheetCloneId, {
    name: name + " 2",
    expectedName: name,
  });
  assert.deepEqual(ids(await collect(600)), [1, 3]);
  // An event that names nothing (a received commit) reaches every stream.
  await sendEvent({ teamId: f.teamId, source: "sync" });
  assert.deepEqual(ids(await collect(600)), [1, 3]);

  // The cell stream keeps its rows across a document save but not a task edit.
  const tasks = new PostgresTaskRepository({
      context: f.makeContext(f.user),
    }),
    period = { teamId: f.teamId, year: 2026, startMonth: 1 },
    before = await cursor();
  await documents.save(
    taskDoc,
    save("업무 문서 둘째", (await documents.read(taskDoc)).revision),
  );
  const quiet = await tasks.readEvents(f.user, period, before);
  assert.equal(quiet.reset, false);
  assert.deepEqual(quiet.events, []);
  await sendEvent({
    teamId: f.teamId,
    entities: [{ entity: "task", key: [f.taskId] }],
  });
  assert.equal(
    (await tasks.readEvents(f.user, period, quiet.cursor)).reset,
    true,
  );
  // Leave before the fixture stops PostgreSQL, so the stream's poll ends.
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 200));
});
