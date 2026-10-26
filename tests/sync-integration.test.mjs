import { recoverSync } from "../scripts/sync-recover.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase, json, getTask } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { canonical, stateHash } from "../server/sync/protocol.mjs";
import { SyncService } from "../server/sync/service.mjs";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { project } from "../server/sync/reducer.mjs";
import { materialize, readEntity } from "../server/sync/entities.mjs";
import { decodeSnapshot } from "../server/sync/snapshot.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-sync-")),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const teamId = randomUUID(),
    userId = randomUUID(),
    sites = [];
  for (const name of ["a", "b"]) {
    const db = openDatabase(join(dir, name + ".sqlite"));
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      teamId,
      "Sync",
      json(DEFAULT_SETTINGS),
    );
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
    ).run(userId, "test@example.com", "테스트", new Date().toISOString());
    db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
      userId,
      teamId,
    );
    const token = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(token).digest("hex"),
      userId,
      Date.now() + 86400000,
    );
    const transport = new GitCliTransport({
      directory: join(dir, name + ".git"),
      repository: remote,
      allowLocal: true,
    });
    const app = createApp({
      db,
      rateLimits: false,
      documentImagesDir: join(dir, name + "-images"),
      syncOptions: {
        installationId: randomUUID(),
        profiles: [{ profileId: name, teamId, repository: "test/data" }],
        transports: { [name]: transport },
        schedule: false,
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const api = async (path, body, method = body ? "POST" : "GET") => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method,
          headers: {
            cookie: "weekly_session=" + token,
            "X-Requested-With": "WeeklyPlan",
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      return { status: response.status, data: unpack(await response.json()) };
    };
    sites.push({ db, app, server, api, transport });
  }
  t.after(async () => {
    for (const s of sites) {
      s.app.locals.sync.close();
      s.app.locals.cellEvents.close();
      s.app.locals.documentEvents.close();
      await new Promise((r) => s.server.close(r));
      s.db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const [a, b] = sites;
  assert.equal(
    (
      await a.api(
        `/admin/teams/${teamId}/connection`,
        { profileId: "a", expectedRevision: 0 },
        "PUT",
      )
    ).status,
    200,
  );
  return { a, b, teamId, userId, dir };
}
test("actual API capture, genesis, two-way Git replay, idempotency and same-cell conflict preserve submissions", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = await a.api("/tasks", {
    teamId,
    year: 2026,
    fields: { title: "baseline" },
  });
  assert.equal(task.status, 201, JSON.stringify(task.data));
  const taskId = task.data.task.id;
  const enabled = await a.api(`/teams/${teamId}/sync/enable`, {});
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const original = a.app.locals.sync.store(teamId).readLink();
  b.app.locals.sync.store(teamId).writeLink({
    ...Object.fromEntries(
      ["repo_id", "bootstrap_id", "writer_epoch", "updated_at"].map((k) => [
        k,
        original[k],
      ]),
    ),
    profile_id: "b",
    installation_id: b.app.locals.sync.installationId,
    mode: "importing",
  });
  b.app.locals.sync.capture.refresh();
  await b.app.locals.sync.get(teamId).run({ receiveOnly: true });
  assert.equal(getTask(b.db, taskId).cells.title.value, "baseline");
  const save = async (site, value) => {
    const c = getTask(site.db, taskId).cells.title;
    return site.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [{ taskId, key: "title", value, expectedVersion: c.version }],
    });
  };
  assert.equal((await save(a, "inside")).status, 200);
  assert.equal((await save(b, "outside preserved")).status, 200);
  assert.equal(a.app.locals.sync.store(teamId).readPending().length, 1);
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  const sa = a.app.locals.sync.store(teamId).readState(),
    sb = b.app.locals.sync.store(teamId).readState();
  assert.equal(stateHash(sa), stateHash(sb));
  assert.equal(getTask(a.db, taskId).cells.title.value, "inside");
  assert.equal(getTask(b.db, taskId).cells.title.value, "inside");
  assert.equal(
    Object.values(sb.conflicts)[0].operation.changes.find(
      (c) => c.entity === "cell",
    ).desired.value,
    "outside preserved",
  );
  const version = getTask(a.db, taskId).cells.title.version;
  await a.app.locals.sync.get(teamId).run();
  assert.equal(getTask(a.db, taskId).cells.title.version, version);
});

async function joinPeer(a, b, teamId) {
  const enabled = await a.api(`/teams/${teamId}/sync/enable`, {});
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const original = a.app.locals.sync.store(teamId).readLink();
  b.app.locals.sync.store(teamId).writeLink({
    ...Object.fromEntries(
      ["repo_id", "bootstrap_id", "writer_epoch", "updated_at"].map((k) => [
        k,
        original[k],
      ]),
    ),
    profile_id: "b",
    installation_id: b.app.locals.sync.installationId,
    mode: "importing",
  });
  b.app.locals.sync.capture.refresh();
  await b.app.locals.sync.get(teamId).run({ receiveOnly: true });
}
const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};

test("initial publication preserves valid tombstones for API-created tags and documents deleted while paused", async (t) => {
  const { a, b, teamId } = await fixture(t);
  assert.equal(a.app.locals.sync.store(teamId).readLink().mode, "paused");
  const task = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "initialization" },
    }),
  ).task;
  const tag = ok(
    await a.api(`/calendar/teams/${teamId}/tags`, {
      id: randomUUID(),
      name: "created then deleted",
      color: "gray",
    }),
  );
  ok(
    await a.api(
      `/calendar/tags/${tag.id}`,
      { expectedRevision: tag.revision },
      "DELETE",
    ),
  );
  const documentId = randomUUID();
  ok(
    await a.api(`/tasks/${task.id}/documents`, {
      id: documentId,
      title: "temporary",
    }),
  );
  const documentPath = `/tasks/${task.id}/documents/${documentId}`;
  ok(
    await a.api(
      documentPath,
      {
        markdown: "last valid body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  ok(
    await a.api(
      documentPath,
      { expectedRevision: ok(await a.api(documentPath)).revision },
      "DELETE",
    ),
  );
  const pendingIds = a.app.locals.sync
    .store(teamId)
    .readPending()
    .map((op) => op.opId);
  assert.ok(pendingIds.length >= 5);
  assert.equal(await a.transport.readHead(), null);
  await joinPeer(a, b, teamId);
  const state = a.app.locals.sync.store(teamId).readState();
  assert.equal(
    stateHash(state),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
  for (const site of [a, b]) {
    const snapshot = site.app.locals.sync.store(teamId).readState();
    const tombstone = Object.values(snapshot.entities).find(
      (row) => row.entity === "document" && row.key.at(-1) === documentId,
    );
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.payload.markdown, "last valid body");
    assert.equal(
      Object.values(snapshot.entities).find(
        (row) => row.entity === "tag" && row.key[0] === tag.id,
      ).deleted,
      true,
    );
    assert.equal(
      site.db
        .prepare("SELECT COUNT(*) AS n FROM calendar_tags WHERE id=?")
        .get(tag.id).n,
      0,
    );
    assert.equal(
      site.db
        .prepare(
          "SELECT COUNT(*) AS n FROM task_documents WHERE task_id=? AND id=?",
        )
        .get(task.id, documentId).n,
      0,
    );
    assert.equal(site.app.locals.sync.store(teamId).readLink().mode, "active");
    assert.ok(pendingIds.every((id) => snapshot.receipts[id]));
    assert.equal(site.app.locals.sync.store(teamId).readPending().length, 0);
  }
  const head = await a.transport.readHead();
  await a.app.locals.sync.get(teamId).run();
  assert.equal(await a.transport.readHead(), head);
});

test("conflict resolution projects immediately and a follow-up API edit depends on it before any publication", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", { teamId, year: 2026, fields: { title: "base" } }),
  ).task;
  await joinPeer(a, b, teamId);
  const save = (site, value) =>
    site.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value,
          expectedVersion: getTask(site.db, task.id).cells.title.version,
        },
      ],
    });
  ok(await save(a, "inside"));
  ok(await save(b, "outside preserved"));
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  const conflict = ok(
    await b.api(`/teams/${teamId}/sync/conflicts`),
  ).conflicts.find((row) => !row.resolved);
  assert.ok(conflict);
  const beforeHead = await b.transport.readHead();
  const resolution = ok(
    await b.api(
      `/teams/${teamId}/sync/conflicts/${conflict.conflictId}/resolve`,
      {
        choice: "submitted",
        expectedHead: conflict.expectedHead,
      },
    ),
  );
  assert.equal(getTask(b.db, task.id).cells.title.value, "outside preserved");
  assert.equal(
    await b.transport.readHead(),
    beforeHead,
    "Resolution must project before Git runs",
  );
  ok(await save(b, "follow-up edit"));
  const pending = b.app.locals.sync.store(teamId).readPending();
  assert.equal(pending.length, 2);
  assert.ok(pending[1].dependsOn.includes(resolution.opId));
  assert.equal(
    pending[1].changes.find((row) => row.entity === "cell").base.value,
    "outside preserved",
  );
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  for (const site of [a, b]) {
    assert.equal(getTask(site.db, task.id).cells.title.value, "follow-up edit");
    assert.equal(site.app.locals.sync.store(teamId).readPending().length, 0);
    assert.equal(
      Object.values(
        site.app.locals.sync.store(teamId).readState().conflicts,
      ).filter((row) => !row.resolution).length,
      0,
    );
  }
  assert.equal(
    stateHash(a.app.locals.sync.store(teamId).readState()),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
});
test("T9/T16/T17 domain capture preserves report bodies, tag replacement, inactive references and local-only preferences", async (t) => {
  const { a, b, teamId, userId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "shared task" },
    }),
  ).task;
  const historical = randomUUID(),
    historicalEntry = randomUUID();
  a.db
    .prepare(
      "INSERT INTO users(id,username,name,password,active,created_at) VALUES(?,?,?,'!',0,?)",
    )
    .run(
      historical,
      "past@example.com",
      "퇴사한 참조",
      new Date().toISOString(),
    );
  a.db
    .prepare(
      "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,lane,title,updated_at,actor_id) VALUES(?,?,?,?,?,0,?,?,?)",
    )
    .run(
      historicalEntry,
      teamId,
      historical,
      "2026-10-27",
      "2026-10-27",
      "historical schedule",
      new Date().toISOString(),
      userId,
    );

  ok(
    await a.api(
      `/tasks/${task.id}/document`,
      {
        markdown: "first body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  await joinPeer(a, b, teamId);
  assert.equal(
    b.db.prepare("SELECT active FROM users WHERE id=?").get(historical).active,
    0,
  );
  assert.equal(
    b.db
      .prepare("SELECT COUNT(*) n FROM memberships WHERE user_id=?")
      .get(historical).n,
    0,
  );
  assert.equal(
    ok(await b.api(`/calendar/entries/${historicalEntry}`)).title,
    "historical schedule",
  );
  const listed = ok(
    await b.api(
      `/calendar?teamId=${teamId}&scope=personal&from=2026-10-01&to=2026-10-31&userId=${historical}`,
    ),
  );
  assert.ok(listed.entries.some((entry) => entry.id === historicalEntry));
  const memoId = randomUUID();
  ok(
    await a.api(`/teams/${teamId}/years/2026/memos`, {
      id: memoId,
      title: "shared memo",
    }),
  );
  ok(
    await a.api(
      `/teams/${teamId}/years/2026/memos/${memoId}`,
      { markdown: "memo body", expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  const report = ok(
    await a.api("/reports", {
      teamId,
      year: 2026,
      name: "snapshot",
      referenceDate: "2026-10-27",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  const reportPath = `/reports/${report.id}/tasks/${task.id}/document`;
  const before = ok(await a.api(reportPath));
  ok(
    await a.api(
      reportPath,
      {
        markdown: "independent copy body",
        expectedRevision: before.revision,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  const tag1 = ok(
    await a.api(`/calendar/teams/${teamId}/tags`, {
      id: randomUUID(),
      name: "first",
      color: "green",
      kind: "check",
    }),
  );
  const tag2 = ok(
    await a.api(`/calendar/teams/${teamId}/tags`, {
      id: randomUUID(),
      name: "second",
      color: "blue",
      kind: "check",
    }),
  );
  const entry = ok(
    await a.api("/calendar/entries", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-27",
      title: "schedule",
      tagIds: [tag1.id, tag2.id],
    }),
  );
  ok(
    await a.api(
      `/calendar/entries/${entry.id}/document`,
      {
        markdown: "calendar body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  assert.equal(
    ok(await b.api(`/tasks/${task.id}/document`)).markdown,
    "first body",
  );
  assert.equal(ok(await b.api(reportPath)).markdown, "independent copy body");
  assert.equal(
    ok(await b.api(`/teams/${teamId}/years/2026/memos/${memoId}`)).markdown,
    "memo body",
  );
  assert.equal(
    ok(await b.api(`/calendar/entries/${entry.id}/document`)).markdown,
    "calendar body",
  );
  let current = ok(await a.api(`/calendar/entries/${entry.id}`));
  // This path normally deletes and reinserts the association rows.
  ok(
    await a.api(
      `/calendar/entries/${entry.id}`,
      { tagIds: [tag2.id, tag1.id], expectedTagIds: current.tagIds },
      "PATCH",
    ),
  );
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  assert.deepEqual(ok(await b.api(`/calendar/entries/${entry.id}`)).tagIds, [
    tag2.id,
    tag1.id,
  ]);
  assert.equal(b.app.locals.sync.store(teamId).readPending().length, 0);
  assert.deepEqual(
    Object.values(a.app.locals.sync.store(teamId).readState().conflicts),
    [],
  );
  const pending = a.app.locals.sync.store(teamId).readPending().length;
  ok(
    await a.api("/calendar/preferences", { weekdays: [1, 2, 3, 4, 5] }, "PUT"),
  );
  assert.equal(a.app.locals.sync.store(teamId).readPending().length, pending);
  assert.equal(
    b.db.prepare("SELECT password FROM users WHERE id=?").get(userId).password,
    "!",
  );
});

test("T20 local document/year exclusions survive normal saves, resync and explicit restore", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "retained" },
    }),
  ).task;
  ok(
    await a.api(
      `/tasks/${task.id}/document`,
      {
        markdown: "retained body",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  await joinPeer(a, b, teamId);
  const store = a.app.locals.sync.store(teamId),
    state = store.readState();
  const record =
    state.entities[JSON.stringify(["document", ["task", task.id, "main"]])];
  const base = `/admin/teams/${teamId}/maintenance`;
  const preview = ok(
    await a.api(base + "/preview", {
      kind: "document",
      entity: "document",
      key: record.key,
      generation: record.generation,
    }),
  );
  let job = ok(
    await a.api(base + "/execute", { token: preview.token, confirmed: true }),
  );
  while (job.hasMore)
    job = ok(await a.api(base + "/resume", { jobId: job.jobId }));
  assert.equal(
    ok(await a.api(`/tasks/${task.id}/documents`)).documents.length,
    0,
  );
  assert.equal((await a.api(`/tasks/${task.id}/document`)).status, 409);
  assert.equal(
    ok(await b.api(`/tasks/${task.id}/document`)).markdown,
    "retained body",
  );
  const before = getTask(a.db, task.id),
    cell = before.cells.title;
  ok(
    await a.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: task.id,
          key: "title",
          value: "visible edit",
          expectedVersion: cell.version,
        },
      ],
    }),
  );
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  assert.equal(
    ok(await b.api(`/tasks/${task.id}/document`)).markdown,
    "retained body",
  );
  assert.equal(
    ok(await a.api(`/tasks/${task.id}/documents`)).documents.length,
    0,
  );
  const listing = ok(await a.api(base)),
    retention = listing.retention[0];
  job = ok(
    await a.api(base + "/restore", {
      retentionId: retention.id,
      expectedRevision: retention.revision,
    }),
  );
  while (job.hasMore)
    job = ok(await a.api(base + "/resume", { jobId: job.jobId }));
  assert.equal(
    ok(await a.api(`/tasks/${task.id}/document`)).markdown,
    "retained body",
  );
});

test("T1/T12 two real CLI writers race, replay checkpoint plus tail, and converge without duplicate revisions", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", { teamId, year: 2026, fields: { title: "race" } }),
  ).task;
  await joinPeer(a, b, teamId);
  const edit = async (site, key, value) =>
    ok(
      await site.api("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: task.id,
            key,
            value,
            expectedVersion: getTask(site.db, task.id).cells[key]?.version || 0,
          },
        ],
      }),
    );
  await Promise.all([
    edit(a, "title", "inside title"),
    edit(b, "2026-10-26", "outside week"),
  ]);
  await Promise.all([
    a.app.locals.sync.get(teamId).run(),
    b.app.locals.sync.get(teamId).run(),
  ]);
  await Promise.all([
    a.app.locals.sync.get(teamId).run(),
    b.app.locals.sync.get(teamId).run(),
  ]);
  assert.equal(
    stateHash(a.app.locals.sync.store(teamId).readState()),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
  assert.equal(
    getTask(a.db, task.id).cells["2026-10-26"].value,
    "outside week",
  );
  assert.equal(getTask(b.db, task.id).cells.title.value, "inside title");
  ok(await a.api(`/teams/${teamId}/sync/checkpoint`, {}));
  await a.api(`/teams/${teamId}/sync/pause`, {});
  const checkpointHead = await a.transport.readHead();
  assert.equal(
    (await a.api(`/teams/${teamId}/sync/checkpoint`, {})).status,
    409,
  );
  assert.equal(await a.transport.readHead(), checkpointHead);
  ok(await a.api(`/teams/${teamId}/sync/resume`, {}));
  await edit(a, "title", "after checkpoint");
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  assert.equal(getTask(b.db, task.id).cells.title.value, "after checkpoint");
  assert.equal(
    stateHash(a.app.locals.sync.store(teamId).readState()),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
});

test("T13/T15 copied installation is fenced; drained receipt reconciliation resumes paused; rewritten history keeps last good C", async (t) => {
  const { a, b, teamId, dir } = await fixture(t);
  const task = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "recovery" },
    }),
  ).task;
  await joinPeer(a, b, teamId);
  const store = b.app.locals.sync.store(teamId),
    old = store.readLink();
  const copiedInstallation = randomUUID();
  store.writeLink({ installation_id: copiedInstallation });
  b.db
    .prepare("INSERT INTO site_retention VALUES(?,?,?,?,?,?,?)")
    .run(
      teamId,
      copiedInstallation,
      "year",
      '["2025"]',
      "",
      7,
      new Date().toISOString(),
    );
  await b.app.locals.sync.get(teamId).run();
  assert.equal(store.readLink().mode, "recovery");
  await b.app.locals.sync.close();
  const whileStopped = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "created while restored site stopped" },
    }),
  ).task;
  await a.app.locals.sync.get(teamId).run();
  const recoveryHead = a.app.locals.sync
    .store(teamId)
    .readLink().canonical_head;
  const result = await recoverSync({
    db: b.db,
    teamId,
    installationId: old.installation_id,
    profiles: [{ profileId: "b", teamId, repository: "test/data" }],
    imagesDir: join(dir, "b-images"),
    confirmDrained: true,
    transports: { b: b.transport },
  });
  assert.equal(result.mode, "paused");
  assert.equal(result.canonicalHead, recoveryHead);
  assert.equal(
    getTask(b.db, whileStopped.id).cells.title.value,
    "created while restored site stopped",
  );
  assert.deepEqual(
    b.db
      .prepare(
        "SELECT site_id,kind,entity_key,revision FROM site_retention WHERE team_id=?",
      )
      .all(teamId)
      .map((r) => ({ ...r })),
    [
      {
        site_id: old.installation_id,
        kind: "year",
        entity_key: '["2025"]',
        revision: 7,
      },
    ],
  );
  assert.equal(getTask(b.db, task.id).cells.title.value, "recovery");
  const good = a.app.locals.sync.store(teamId).readLink().canonical_head;
  const bad = await a.transport.createCandidate(null, {
    "manifest.json": "{}",
  });
  await a.transport.git([
    "push",
    "--force",
    "origin",
    bad + ":refs/heads/sync-v1",
  ]);
  await assert.rejects(a.app.locals.sync.get(teamId).run(), /rewritten/);
  assert.equal(a.app.locals.sync.store(teamId).readLink().canonical_head, good);
  assert.equal(a.app.locals.sync.store(teamId).readLink().mode, "recovery");
  assert.equal(getTask(a.db, task.id).cells.title.value, "recovery");
});

test(
  "T12 captured checkpoint loses a real fast-forward race without absorbing or losing later local P",
  { timeout: 20000 },
  async (t) => {
    const { a, b, teamId } = await fixture(t);
    const task = ok(
      await a.api("/tasks", {
        teamId,
        year: 2026,
        fields: { title: "checkpoint base" },
      }),
    ).task;
    await joinPeer(a, b, teamId);
    const raw = a.app.locals.sync.store(teamId),
      adapter = new SqliteDatabase(a.db),
      head = raw.readLink().canonical_head,
      before = raw.readState();
    let enter, release, captured, checkpointOid, published;
    const entered = new Promise((resolve) => (enter = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const transport = new Proxy(a.transport, {
      get(target, name) {
        if (name === "createCandidate")
          return async (parent, files, ...rest) => {
            if (
              Object.keys(files).some((path) => path.startsWith("snapshots/"))
            ) {
              captured = { parent, files };
              enter();
              await gate;
              checkpointOid = await target.createCandidate(
                parent,
                files,
                ...rest,
              );
              return checkpointOid;
            }
            return target.createCandidate(parent, files, ...rest);
          };
        if (name === "publish")
          return async (oid, parent, ...rest) => {
            const result = await target.publish(oid, parent, ...rest);
            if (oid === checkpointOid) published = result;
            return result;
          };
        const value = target[name];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // The service and storage contracts are production implementations. This
    // bounded fixture inserts a deterministic pause at the transport boundary.
    const store = {
      ...raw,
      commitCanonical(expected, next, state, acks) {
        a.app.locals.sync.capture.without(() =>
          adapter.commitCanonical(
            teamId,
            expected,
            next,
            state,
            acks,
            (_tx, { pending }) => {
              const visible = project(state, pending).entities,
                previous = {};
              for (const [key, record] of Object.entries(visible)) {
                const current = readEntity(
                  a.db,
                  teamId,
                  record.entity,
                  record.key,
                );
                if (current) previous[key] = current;
              }
              materialize(a.db, teamId, visible, previous);
            },
          ),
        );
        a.app.locals.sync.capture.acknowledged(teamId, acks);
      },
    };
    const service = new SyncService({
        transport,
        store,
        identity: { teamId, repoId: raw.readLink().repo_id },
      }),
      checkpoint = service.checkpoint();
    await entered;
    assert.equal(captured.parent, head);
    const frozen = decodeSnapshot(
      Object.entries(captured.files).find(([path]) =>
        path.startsWith("snapshots/"),
      )[1],
    );
    assert.equal(frozen.atCommit, head);
    assert.equal(stateHash(frozen.state), stateHash(before));
    const save = async (site, key, value) =>
      ok(
        await site.api("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key,
              value,
              expectedVersion:
                getTask(site.db, task.id).cells[key]?.version || 0,
            },
          ],
        }),
      );
    await save(a, "title", "local P after snapshot");
    const pending = raw.readPending(),
      localVersion = getTask(a.db, task.id).cells.title.version;
    await save(b, "2026-10-26", "independent peer commit");
    await b.app.locals.sync.get(teamId).run();
    const peerHead = await b.transport.readHead();
    assert.notEqual(peerHead, head);
    release();
    await checkpoint;
    assert.equal(published, false);
    assert.equal(await a.transport.readHead(), peerHead);
    assert.deepEqual(raw.readPending(), pending);
    assert.equal(
      getTask(a.db, task.id).cells.title.value,
      "local P after snapshot",
    );
    assert.equal(
      getTask(a.db, task.id).cells["2026-10-26"].value,
      "independent peer commit",
    );
    assert.equal(
      stateHash(raw.readState()),
      stateHash(b.app.locals.sync.store(teamId).readState()),
    );
    await a.app.locals.sync.get(teamId).run();
    await b.app.locals.sync.get(teamId).run();
    assert.equal(raw.readPending().length, 0);
    assert.equal(getTask(a.db, task.id).cells.title.version, localVersion);
    assert.equal(
      getTask(b.db, task.id).cells.title.value,
      "local P after snapshot",
    );
  },
);

test(
  "T25 actual status branches publish confirmation once and unchanged refresh does not create an acknowledgement loop",
  { timeout: 20000 },
  async (t) => {
    const { a, b, teamId } = await fixture(t);
    ok(
      await a.api("/tasks", {
        teamId,
        year: 2026,
        fields: { title: "status" },
      }),
    );
    await joinPeer(a, b, teamId);
    const aId = a.app.locals.sync.installationId,
      bId = b.app.locals.sync.installationId;
    a.app.locals.sync.profiles[0].peerInstallationId = bId;
    b.app.locals.sync.profiles[0].peerInstallationId = aId;
    a.app.locals.sync.clear(teamId);
    b.app.locals.sync.clear(teamId);
    const canonicalHead = await a.transport.readHead(),
      aStatus = await a.transport.readHead("sync-status/" + aId),
      bStatus = await b.transport.readHead("sync-status/" + bId);
    assert.ok(aStatus && bStatus);
    for (let i = 0; i < 2; i++) {
      await a.app.locals.sync.get(teamId).run();
      await b.app.locals.sync.get(teamId).run();
    }
    assert.equal(await a.transport.readHead(), canonicalHead);
    assert.equal(await a.transport.readHead("sync-status/" + aId), aStatus);
    assert.equal(await b.transport.readHead("sync-status/" + bId), bStatus);
    const status = ok(await a.api(`/teams/${teamId}/sync`));
    assert.equal(status.remoteStatus.verified, true);
    assert.equal(status.remoteStatus.appliedCanonicalHead, canonicalHead);
    const old = JSON.parse(
        (await b.transport.readFile(bStatus, "status.json")).toString(),
      ),
      stale = await b.transport.createCandidate(bStatus, {
        "status.json": canonical({
          ...old,
          observedAt: new Date(Date.now() - 240000).toISOString(),
        }),
      });
    assert.equal(
      await b.transport.publish(stale, bStatus, "sync-status/" + bId),
      true,
    );
    await a.app.locals.sync.get(teamId).run();
    assert.equal(
      ok(await a.api(`/teams/${teamId}/sync`)).remoteStatus.verified,
      false,
    );
    assert.equal(await a.transport.readHead(), canonicalHead);
    assert.equal(await a.transport.readHead("sync-status/" + aId), aStatus);
  },
);
