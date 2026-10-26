import express from "express";
import sharp from "sharp";
import {
  installDocumentImageRoutes,
  documentImagePath,
} from "../server/document-images.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, getTask, json } from "../server/db.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { entityId } from "../server/sync/protocol.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { documentStream } from "./document-events-helper.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-retention-events-"));
  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(join(directory, "site.sqlite"));
  const teamId = randomUUID(),
    userId = randomUUID(),
    token = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Review",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "review@example.com", "Review", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + 86400000,
  );
  const transport = new GitCliTransport({
    directory: join(directory, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    syncOptions: {
      installationId: randomUUID(),
      profiles: [{ profileId: "test", teamId, repository: "test/data" }],
      transports: { test: transport },
      schedule: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(baseURL + "/api" + path, {
      method,
      headers: {
        Cookie: `weekly_session=${token}`,
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: unpack(await response.json()) };
  };
  t.after(async () => {
    app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, teamId, userId, token, baseURL, api, app, directory };
}
const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};

test("document exclusion and restore invalidate conditional task snapshots", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "badge" },
    }),
  ).task;
  ok(
    await f.api(
      `/tasks/${task.id}/document`,
      { markdown: "body", expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  ok(
    await f.api(
      `/admin/teams/${f.teamId}/connection`,
      { profileId: "test", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const tasks = (etag) =>
    fetch(`${f.baseURL}/api/tasks?teamId=${f.teamId}&year=2026`, {
      headers: {
        Cookie: `weekly_session=${f.token}`,
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
  const initial = await tasks(),
    before = initial.headers.get("etag");
  assert.equal(unpack(await initial.json()).tasks[0].documentCount, 1);
  assert.equal((await tasks(before)).status, 304);
  const key = ["task", task.id, "main"],
    store = f.app.locals.sync.store(f.teamId);
  const path = `/admin/teams/${f.teamId}/maintenance`;
  const preview = ok(
    await f.api(path + "/preview", {
      kind: "document",
      entity: "document",
      key,
      generation:
        store.readState().entities[entityId("document", key)].generation,
    }),
  );
  ok(await f.api(path + "/execute", { token: preview.token, confirmed: true }));
  const excluded = await tasks(before),
    hidden = excluded.headers.get("etag");
  assert.equal(excluded.status, 200);
  assert.notEqual(hidden, before);
  assert.equal(unpack(await excluded.json()).tasks[0].documentCount, 0);
  const retention = ok(await f.api(path)).retention[0];
  ok(
    await f.api(path + "/restore", {
      retentionId: retention.id,
      expectedRevision: retention.revision,
    }),
  );
  const restored = await tasks(hidden);
  assert.equal(restored.status, 200);
  assert.notEqual(restored.headers.get("etag"), hidden);
  assert.equal(unpack(await restored.json()).tasks[0].documentCount, 1);
});

test("unused-image cleanup preserves a deleted report document through Git and audit restore without resetting cells", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "source" },
    }),
  ).task;
  const report = ok(
    await f.api("/reports", {
      teamId: f.teamId,
      year: 2026,
      name: "restore image",
      referenceDate: "2026-10-27",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  const docPath = `/reports/${report.id}/tasks/${task.id}/document`;
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#f09234" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), "image.png");
  const upload = await fetch(f.baseURL + "/api" + docPath + "/images", {
    method: "POST",
    headers: {
      Cookie: `weekly_session=${f.token}`,
      "X-Requested-With": "WeeklyPlan",
    },
    body: form,
  });
  assert.equal(upload.status, 201);
  const image = unpack(await upload.json());
  const markdown = `![restorable](${image.url})`;
  ok(
    await f.api(
      docPath,
      { markdown, expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  ok(
    await f.api(
      `/admin/teams/${f.teamId}/connection`,
      { profileId: "test", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const current = ok(await f.api(`/reports/${report.id}`));
  const deleted = ok(
    await f.api(
      `/reports/${report.id}`,
      {
        operationId: randomUUID(),
        revision: current.revision,
        operations: [
          { kind: "delete", at: new Date().toISOString(), taskIds: [task.id] },
        ],
      },
      "PATCH",
    ),
  );
  await f.app.locals.sync.get(f.teamId).run();
  const tombstone = f.app.locals.sync.store(f.teamId).readState().entities[
    entityId("document", ["report", report.id, task.id, "main"])
  ];
  assert.equal(
    tombstone.deleted,
    true,
    JSON.stringify({
      tombstone,
      pending: f.app.locals.sync.store(f.teamId).readPending(),
      conflicts: f.app.locals.sync.store(f.teamId).readState().conflicts,
    }),
  );
  const old = new Date(Date.now() - 2 * 86400000);
  utimesSync(
    documentImagePath(join(f.directory, "images"), image.url),
    old,
    old,
  );
  const stream = await documentStream(
    t,
    f.baseURL,
    "/api/cells",
    f.token,
    `?teamId=${f.teamId}&year=2026&after=${encodeURIComponent(f.app.locals.cellEvents.cursor())}`,
  );
  assert.equal((await stream.next()).event, "ready");
  const path = `/admin/teams/${f.teamId}/maintenance`;
  const preview = ok(await f.api(path + "/preview", { kind: "images" }));
  assert.equal(
    preview.images.count,
    0,
    "Restorable tombstone/audit references must survive unused-image cleanup",
  );
  assert.ok(
    preview.protected.some(
      (row) => row.reason.includes("복원 이력") && row.count === 1,
    ),
  );
  ok(await f.api(path + "/execute", { token: preview.token, confirmed: true }));
  ok(
    await f.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value: "SSE barrier",
          expectedVersion: getTask(f.db, task.id).cells.title.version,
        },
      ],
    }),
  );
  assert.equal(
    (await stream.next()).event,
    "cells",
    "Images-only cleanup must not reset an existing cell subscription",
  );
  stream.close();
  const entry = ok(
    await f.api(`/audit?teamId=${f.teamId}&sheetId=${report.id}`),
  ).entries.find((row) => row.restorableTaskIds.length);
  ok(await f.api(`/audit/${entry.id}/restore`, { revision: deleted.revision }));
  assert.equal(ok(await f.api(docPath)).markdown, markdown);
  const restored = await fetch(f.baseURL + image.url, {
    headers: { Cookie: `weekly_session=${f.token}` },
  });
  assert.equal(restored.status, 200);
  assert.ok((await restored.arrayBuffer()).byteLength > 0);
});

test("local cleanup revokes open and new multiplexed document subscriptions for every owner; restore preserves bodies", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "retention" },
    }),
  ).task;
  const taskPath = `/tasks/${task.id}/documents/main`;
  ok(
    await f.api(
      taskPath,
      {
        markdown: "task original body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  const memoId = randomUUID(),
    annualPath = `/teams/${f.teamId}/years/2026/memos`;
  ok(await f.api(annualPath, { id: memoId, title: "memo" }));
  ok(
    await f.api(
      `${annualPath}/${memoId}`,
      {
        markdown: "memo original body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  const report = ok(
    await f.api("/reports", {
      teamId: f.teamId,
      year: 2026,
      name: "snapshot",
      referenceDate: "2026-10-27",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  const entry = ok(
    await f.api("/calendar/entries", {
      id: randomUUID(),
      teamId: f.teamId,
      userId: f.userId,
      date: "2026-10-27",
      title: "calendar",
    }),
  );
  const calendarPath = `/calendar/entries/${entry.id}/document`;
  ok(
    await f.api(
      calendarPath,
      {
        markdown: "calendar original body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  ok(
    await f.api(
      `/admin/teams/${f.teamId}/connection`,
      { profileId: "test", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const targets = [
    {
      key: ["task", task.id, "main"],
      path: taskPath,
      markdown: "task original body",
    },
    {
      key: ["report", report.id, task.id, "main"],
      path: `/reports/${report.id}/tasks/${task.id}/document`,
      markdown: "task original body",
    },
    {
      key: ["annual", "2026", memoId],
      path: `${annualPath}/${memoId}`,
      markdown: "memo original body",
    },
    {
      key: ["reportMemo", report.id, memoId],
      path: `/reports/${report.id}/memos/${memoId}`,
      markdown: "memo original body",
    },
    {
      key: ["calendar", entry.id, "main"],
      path: calendarPath,
      markdown: "calendar original body",
    },
  ];
  const streams = targets.map((target, id) => ({
    id,
    path: `/api${target.path}/events`,
  }));
  const open = await documentStream(t, f.baseURL, "/api", f.token, "", {
    streams,
  });
  const direct = await documentStream(
    t,
    f.baseURL,
    "/api" + targets[1].path,
    f.token,
  );
  assert.equal((await direct.next()).data.markdown, targets[1].markdown);
  for (const [id, target] of targets.entries()) {
    const message = await open.next();
    assert.equal(message.data.id, id);
    assert.equal(JSON.parse(message.data.data).markdown, target.markdown);
  }
  const store = f.app.locals.sync.store(f.teamId),
    beforeHead = store.readLink().canonical_head;
  const base = `/admin/teams/${f.teamId}/maintenance`;
  for (const [id, target] of targets.entries()) {
    const record = store.readState().entities[entityId("document", target.key)];
    assert.ok(record, JSON.stringify(target.key));
    const preview = ok(
      await f.api(base + "/preview", {
        kind: "document",
        entity: "document",
        key: target.key,
        generation: record.generation,
      }),
    );
    let job = ok(
      await f.api(base + "/execute", { token: preview.token, confirmed: true }),
    );
    while (job.hasMore)
      job = ok(await f.api(base + "/resume", { jobId: job.jobId }));
    const denied = await open.next();
    assert.equal(denied.data.id, id);
    assert.equal(denied.data.event, "access-revoked");
    assert.deepEqual(JSON.parse(denied.data.data), { status: 409 });
    assert.deepEqual(await open.next(), { event: "closed", data: { id } });
    if (id === 1)
      assert.deepEqual(await direct.next(), {
        event: "access-revoked",
        data: { status: 409 },
      });
    assert.equal((await f.api(target.path)).status, 409);
    if (id === 4) {
      assert.equal(
        ok(await f.api(`/calendar/entries/${entry.id}`)).preview,
        "",
      );
      const calendar = ok(
        await f.api(
          `/calendar?teamId=${f.teamId}&userId=${f.userId}&from=2026-10-01&to=2026-10-31`,
        ),
      );
      assert.equal(
        calendar.entries.find((item) => item.id === entry.id).preview,
        "",
      );
    }
    const sources = ok(
      await f.api(`/document-browser/sources?teamId=${f.teamId}&year=2026`),
    ).sources;
    assert.equal(
      sources.find((source) => source.id === "live").documentCount,
      0,
    );
    assert.equal(sources.find((source) => source.id === "live").taskCount, 0);
    assert.equal(
      sources.find((source) => source.id === report.id).documentCount,
      id < 1 ? 1 : 0,
    );
    assert.equal(
      sources.find((source) => source.id === report.id).taskCount,
      id < 1 ? 1 : 0,
    );
    const reconnect = await documentStream(t, f.baseURL, "/api", f.token, "", {
      streams: [streams[id]],
    });
    const blocked = await reconnect.next();
    assert.equal(blocked.data.event, "rejected");
    assert.deepEqual(JSON.parse(blocked.data.data), { status: 409 });
    assert.deepEqual(await reconnect.next(), { event: "closed", data: { id } });
  }
  assert.equal(store.readLink().canonical_head, beforeHead);
  assert.equal(store.readPending().length, 0);
  for (const target of targets) {
    const retention = ok(await f.api(base)).retention.find(
      (row) => JSON.stringify(row.key) === JSON.stringify(target.key),
    );
    assert.ok(retention, JSON.stringify(target.key));
    let job = ok(
      await f.api(base + "/restore", {
        retentionId: retention.id,
        expectedRevision: retention.revision,
      }),
    );
    while (job.hasMore)
      job = ok(await f.api(base + "/resume", { jobId: job.jobId }));
    assert.equal(ok(await f.api(target.path)).markdown, target.markdown);
    if (target.key[0] === "calendar")
      assert.equal(
        ok(await f.api(`/calendar/entries/${entry.id}`)).preview,
        target.markdown,
      );
  }
  const restored = await documentStream(t, f.baseURL, "/api", f.token, "", {
    streams,
  });
  for (const target of targets)
    assert.equal(
      JSON.parse((await restored.next()).data.data).markdown,
      target.markdown,
    );
  restored.close();
  assert.equal(store.readLink().canonical_head, beforeHead);
  assert.equal(store.readPending().length, 0);
});

test("image upload rechecks exact document exclusion after asynchronous decoding", async (t) => {
  const f = await fixture(t);
  const task = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "image" },
    }),
  ).task;
  ok(
    await f.api(
      `/tasks/${task.id}/document`,
      { markdown: "body", expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  const report = ok(
    await f.api("/reports", {
      teamId: f.teamId,
      year: 2026,
      name: "image copy",
      referenceDate: "2026-10-27",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#337799" },
  })
    .png()
    .toBuffer();
  const user = { id: f.userId, systemRole: "admin", teams: [] };
  const app = express();
  let excludeAfterDecode;
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  installDocumentImageRoutes(app, {
    db: f.db,
    taskAccess: () => ({ id: task.id, teamId: f.teamId }),
    teamAccess: () => ({}),
    managedTeam: () => ({}),
    documentImagesDir: join(f.directory, "delayed-images"),
    refreshUser: () => {
      if (excludeAfterDecode)
        f.db
          .prepare("INSERT INTO site_retention VALUES(?,?,?,?,?,?,?)")
          .run(
            f.teamId,
            "test-site",
            "document",
            JSON.stringify(excludeAfterDecode),
            "",
            1,
            new Date().toISOString(),
          );
      return user;
    },
    calendarImageAccess: () => {
      throw new Error("unused");
    },
    memoImageAccess: () => {
      throw new Error("unused");
    },
  });
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const target of [
    {
      key: ["task", task.id, "main"],
      path: `/tasks/${task.id}/document/images`,
    },
    {
      key: ["report", report.id, task.id, "main"],
      path: `/reports/${report.id}/tasks/${task.id}/document/images`,
    },
  ]) {
    const upload = async () => {
      const body = new FormData();
      body.append(
        "image",
        new Blob([bytes], { type: "image/png" }),
        "pixel.png",
      );
      return fetch(
        `http://127.0.0.1:${server.address().port}/api${target.path}`,
        { method: "POST", body },
      );
    };
    excludeAfterDecode = target.key;
    const rejected = await upload();
    assert.equal(rejected.status, 409, JSON.stringify(await rejected.json()));
    f.db.prepare("DELETE FROM site_retention WHERE team_id=?").run(f.teamId);
    excludeAfterDecode = null;
    const accepted = await upload();
    assert.equal(accepted.status, 201, JSON.stringify(await accepted.json()));
  }
});

test("year cleanup resets live cell streams and replay buffers while preserving the remaining year", async (t) => {
  const f = await fixture(t);
  const original = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "old-year body" },
    }),
  ).task;
  const shared = ok(
    await f.api("/tasks", {
      teamId: f.teamId,
      year: 2026,
      fields: { title: "two-year body" },
    }),
  ).task;
  ok(
    await f.api(
      `/tasks/${shared.id}`,
      { years: [2026, 2027], updatedAt: shared.updatedAt },
      "PATCH",
    ),
  );
  ok(
    await f.api(
      `/admin/teams/${f.teamId}/connection`,
      { profileId: "test", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await f.api(`/teams/${f.teamId}/sync/enable`, {}));
  const cursor = f.app.locals.cellEvents.cursor();
  const direct = await documentStream(
    t,
    f.baseURL,
    "/api/cells",
    f.token,
    `?teamId=${f.teamId}&year=2026&after=${encodeURIComponent(cursor)}`,
  );
  const streams = [2026, 2027].map((year, index) => ({
    id: index + 1,
    path: `/api/cells/events?teamId=${f.teamId}&year=${year}`,
    lastEventId: cursor,
  }));
  const multiplex = await documentStream(t, f.baseURL, "/api", f.token, "", {
    streams,
  });
  assert.equal((await direct.next()).event, "ready");
  for (const id of [1, 2]) {
    const frame = await multiplex.next();
    assert.equal(frame.data.id, id);
    assert.equal(frame.data.event, "ready");
  }
  const save = async (taskId, value) =>
    ok(
      await f.api("/cells/batch", {
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
      }),
    );
  await save(original.id, "buffered private year");
  assert.equal((await direct.next()).event, "cells");
  assert.equal((await multiplex.next()).data.event, "cells");
  await save(shared.id, "buffered both years");
  assert.equal((await direct.next()).event, "cells");
  for (const id of [1, 2]) {
    const frame = await multiplex.next();
    assert.equal(frame.data.id, id);
    assert.equal(frame.data.event, "cells");
  }
  const base = `/admin/teams/${f.teamId}/maintenance`;
  const preview = ok(
    await f.api(base + "/preview", { kind: "year", year: 2026 }),
  );
  let job = ok(
    await f.api(base + "/execute", { token: preview.token, confirmed: true }),
  );
  while (job.hasMore)
    job = ok(await f.api(base + "/resume", { jobId: job.jobId }));
  assert.equal((await direct.next()).event, "reset");
  for (const id of [1, 2]) {
    const frame = await multiplex.next();
    assert.equal(frame.data.id, id);
    assert.equal(frame.data.event, "reset");
  }
  assert.equal(
    ok(await f.api(`/tasks?teamId=${f.teamId}&year=2026`)).tasks.length,
    0,
  );
  const remaining = ok(
    await f.api(`/tasks?teamId=${f.teamId}&year=2027`),
  ).tasks;
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].years, [2027]);
  const reconnect = await documentStream(
    t,
    f.baseURL,
    "/api/cells",
    f.token,
    `?teamId=${f.teamId}&year=2026&after=${encodeURIComponent(cursor)}`,
  );
  assert.equal((await reconnect.next()).event, "reset");
  assert.equal((await reconnect.next()).event, "ready");
  reconnect.close();
  const replay = await documentStream(t, f.baseURL, "/api", f.token, "", {
    streams,
  });
  for (const id of [1, 2])
    for (const event of ["reset", "ready"]) {
      const frame = await replay.next();
      assert.equal(frame.data.id, id);
      assert.equal(frame.data.event, event);
    }
  replay.close();
  await save(shared.id, "remaining-year edit");
  const visible = await multiplex.next();
  assert.equal(visible.data.id, 2);
  assert.equal(visible.data.event, "cells");
  assert.equal(
    unpack(JSON.parse(visible.data.data)).cells[0].value,
    "remaining-year edit",
  );
  // A reset is a deterministic barrier: if the hidden scope received the last
  // publish, its cells frame would be observed before this reset.
  f.app.locals.cellEvents.invalidateTeam(f.teamId);
  assert.equal((await direct.next()).event, "reset");
  for (const id of [1, 2]) {
    const frame = await multiplex.next();
    assert.equal(frame.data.id, id);
    assert.equal(frame.data.event, "reset");
  }
  const retention = ok(await f.api(base)).retention.find(
    (row) => row.kind === "year",
  );
  job = ok(
    await f.api(base + "/restore", {
      retentionId: retention.id,
      expectedRevision: retention.revision,
    }),
  );
  while (job.hasMore)
    job = ok(await f.api(base + "/resume", { jobId: job.jobId }));
  assert.equal((await direct.next()).event, "reset");
  for (const id of [1, 2]) {
    const frame = await multiplex.next();
    assert.equal(frame.data.id, id);
    assert.equal(frame.data.event, "reset");
  }
  assert.equal(
    ok(await f.api(`/tasks?teamId=${f.teamId}&year=2026`)).tasks.length,
    2,
  );
  await save(original.id, "restored-year edit");
  assert.equal((await direct.next()).event, "cells");
  const restored = await multiplex.next();
  assert.equal(restored.data.id, 1);
  assert.equal(restored.data.event, "cells");
  direct.close();
  multiplex.close();
});
