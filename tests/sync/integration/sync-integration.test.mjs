import { commitCanonicalForTest } from "../../support/canonical-storage-fixture.mjs";
import { recoverSync } from "../../../scripts/sync/sync-recover.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase, json, getTask } from "../../../server/db.mjs";
import { createApp } from "../../../server/app.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../../../shared/domain.js";
import { unpack } from "../../../shared/formatting/compact.js";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";
import { canonical, stateHash } from "../../../server/sync/core/protocol.mjs";
import { SyncService } from "../../../server/sync/core/service.mjs";
import { SqliteDatabase } from "../../../server/storage/sqlite.mjs";
import { project } from "../../../server/sync/core/reducer.mjs";
import {
  materialize,
  readEntity,
} from "../../../server/sync/node/entities.mjs";
import { decodeSnapshot } from "../../../server/sync/core/snapshot.mjs";
import { syncLogDate } from "../../../server/sync/node/sync-log.mjs";
import {
  conflictChanges,
  diffSides,
} from "../../../shared/sync/conflict-diff.js";

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
        logDir: join(dir, name + "-sync-logs"),
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
test("connection check reports an empty GitHub repository and succeeds after its first commit", async (t) => {
  const { a, teamId } = await fixture(t);
  a.transport.repository = "https://github.com/fixture/team";
  // A GitHub-backed check always carries a token; a missing one is rejected earlier.
  a.transport.token = "fixture_token";
  const fetcher = globalThis.fetch,
    calls = [];
  let state = "empty";
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (!String(url).startsWith("https://api.github.com/"))
      return fetcher(url, init);
    const path = new URL(url).pathname.replace("/repos/fixture/team", "");
    calls.push({ path, method: init.method });
    if (!path)
      return Response.json({ private: true, id: 1, default_branch: "main" });
    if (path === "/git/ref/heads/main") {
      if (state === "ready")
        return Response.json({ object: { sha: "a".repeat(40) } });
      return Response.json(
        {
          message:
            state === "empty"
              ? "Git Repository is empty."
              : "private upstream failure",
        },
        { status: 409 },
      );
    }
    if (path === "/git/ref/heads/sync-v1")
      return Response.json({}, { status: 404 });
    if (path === "/git/refs" && init.method === "POST")
      return Response.json({}, { status: 201 });
    if (
      path.startsWith("/git/refs/heads/graeboard-probe/") &&
      init.method === "DELETE"
    )
      return new Response(null, { status: 204 });
    throw new Error("Unexpected GitHub request " + path);
  });
  const route = `/teams/${teamId}/sync/check`;
  const empty = await a.api(route, {});
  assert.equal(empty.status, 400);
  assert.equal(
    empty.data.error,
    "GitHub에서 README를 만들어 저장소를 초기화하세요.",
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  state = "conflict";
  const conflict = await a.api(route, {});
  assert.equal(conflict.status, 500);
  assert.doesNotMatch(conflict.data.error, /README|private upstream/);
  state = "ready";
  const ready = await a.api(route, {});
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.equal(ready.data.ready, true);
  assert.ok(calls.some((call) => call.method === "POST"));
  assert.ok(calls.some((call) => call.method === "DELETE"));
  assert.equal(a.app.locals.sync.store(teamId).readLink().canonical_head, null);
});

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
  ok(await a.api(`/teams/${teamId}/sync/disconnect`, {}));
  ok(await a.api(`/teams/${teamId}/sync/reconnect`, {}));
  assert.equal(
    a.app.locals.sync.store(teamId).readPending().length,
    0,
    "Missing rows for existing tombstones must not produce new deletions",
  );
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
  // A team member opens and settles the conflict box as a lead does; a
  // viewer, who edits nothing, cannot open it.
  b.db.prepare("UPDATE users SET system_role='user'").run();
  b.db
    .prepare("UPDATE memberships SET role='viewer' WHERE team_id=?")
    .run(teamId);
  const refused = await b.api(`/teams/${teamId}/sync/conflicts`);
  assert.equal(refused.status, 403);
  assert.equal(
    refused.data.error,
    "충돌 보관함은 팀장·팀원만 사용할 수 있습니다.",
  );
  b.db
    .prepare("UPDATE memberships SET role='member' WHERE team_id=?")
    .run(teamId);
  const summary = ok(
    await b.api(`/teams/${teamId}/sync/conflicts`),
  ).conflicts.find((row) => !row.resolved);
  assert.ok(summary);
  // The list carries no values; one conflict is read whole.
  for (const side of ["base", "current", "desired"])
    assert.ok(!(side in summary), side);
  const conflict = ok(
    await b.api(`/teams/${teamId}/sync/conflicts/${summary.conflictId}`),
  );
  assert.deepEqual(
    { ...conflict, base: 0, current: 0, desired: 0 },
    { ...summary, base: 0, current: 0, desired: 0 },
  );
  assert.equal(
    (await b.api(`/teams/${teamId}/sync/conflicts/missing`)).status,
    404,
  );
  // The conflict box pairs the API's current record with the change it blocks.
  const [change] = conflictChanges(conflict);
  assert.equal(change.key, `${task.id}/title`);
  assert.equal(change.current.payload.value, "inside");
  assert.equal(change.desired.payload.value, "outside preserved");
  assert.deepEqual(
    diffSides(change.current, change.desired)
      .rows.filter((row) => row.type !== "same")
      .map((row) => row.text),
    ['value: "inside"', 'value: "outside preserved"'],
  );
  // b holds its own edit; a's edit, absent from b's outbox, landed first.
  assert.equal(conflict.origin.held.site, "internal");
  assert.equal(conflict.origin.held.actor, "테스트");
  assert.equal(change.writer.site, "external");
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
  // Until it is published the conflict shows its saved resolution, and a
  // second one is refused instead of racing the first.
  const saved = ok(await b.api(`/teams/${teamId}/sync/conflicts`)).conflicts[0];
  assert.equal(saved.resolved, false);
  assert.deepEqual(
    [saved.pendingResolution.opId, saved.pendingResolution.choice],
    [resolution.opId, "submitted"],
  );
  const again = await b.api(
    `/teams/${teamId}/sync/conflicts/${conflict.conflictId}/resolve`,
    { choice: "current", expectedHead: conflict.expectedHead },
  );
  assert.equal(again.status, 409);
  assert.equal(
    again.data.error,
    "이 충돌은 이미 해결 방법을 저장했습니다. 다음 동기화 때 공유됩니다.",
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
test("a peer task created and deleted before this site received it keeps its trash row for cells and documents", async (t) => {
  const { a, b, teamId } = await fixture(t);
  ok(await a.api("/tasks", { teamId, year: 2026, fields: { title: "base" } }));
  await joinPeer(a, b, teamId);
  const task = ok(
    await b.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "short-lived" },
    }),
  ).task;
  ok(
    await b.api(
      `/tasks/${task.id}/document`,
      { markdown: "body", expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    ),
  );
  ok(
    await b.api(
      `/tasks/${task.id}`,
      { updatedAt: getTask(b.db, task.id).updatedAt },
      "DELETE",
    ),
  );
  await b.app.locals.sync.get(teamId).run();
  // Before the fix this receive failed with "FOREIGN KEY constraint failed".
  await a.app.locals.sync.get(teamId).run();
  const received = getTask(a.db, task.id);
  assert.ok(received.deletedAt, "the peer's trash row is kept");
  assert.equal(received.cells.title.value, "short-lived");
  assert.equal(
    a.db
      .prepare("SELECT count(*) n FROM task_documents WHERE task_id=?")
      .get(task.id).n,
    1,
  );
  assert.equal(
    stateHash(a.app.locals.sync.store(teamId).readState()),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
});
test("T9/T16/T17 domain capture preserves sheetClone bodies, tag replacement, inactive references and local-only preferences", async (t) => {
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
  const sheetClone = ok(
    await a.api("/sheet-clones", {
      teamId,
      year: 2026,
      name: "snapshot",
      referenceDate: "2026-10-27",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  const sheetClonePath = `/sheet-clones/${sheetClone.id}/tasks/${task.id}/document`;
  const before = ok(await a.api(sheetClonePath));
  ok(
    await a.api(
      sheetClonePath,
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
  assert.equal(
    ok(await b.api(sheetClonePath)).markdown,
    "independent copy body",
  );
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
  const retained = store.readExclusions();
  ok(await a.api(`/teams/${teamId}/sync/disconnect`, {}));
  ok(await a.api(`/teams/${teamId}/sync/reconnect`, {}));
  assert.equal(
    store.readPending().length,
    0,
    "Locally retained documents are not shared deletions",
  );
  assert.deepEqual(store.readExclusions(), retained);
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

test("HTTP reconnect preserves pending IDs, offline cells and memo bodies, then merges peer edits through real Git", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", { teamId, year: 2026, fields: { title: "base" } }),
  ).task;
  const memoId = randomUUID(),
    memoPath = `/teams/${teamId}/years/2026/memos/${memoId}`;
  ok(
    await a.api(`/teams/${teamId}/years/2026/memos`, {
      id: memoId,
      title: "꼬리 메모",
    }),
  );
  await joinPeer(a, b, teamId);
  const edit = (site, key, value) =>
    site.api("/cells/batch", {
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
    });
  ok(await edit(a, "title", "pending before disconnect"));
  const store = a.app.locals.sync.store(teamId),
    pending = store.readPending();
  ok(await a.api(`/teams/${teamId}/sync/disconnect`, {}));
  const original = store.readLink();
  ok(await edit(a, "title", "saved while disconnected"));
  ok(
    await a.api(
      memoPath,
      {
        markdown: "해제 중 저장한 꼬리 메모",
        expectedRevision: 0,
        operationId: randomUUID(),
      },
      "PUT",
    ),
  );
  assert.deepEqual(store.readPending(), pending);
  ok(await edit(b, "2026-10-26", "peer changed while disconnected"));
  await b.app.locals.sync.get(teamId).run();
  const result = ok(await a.api(`/teams/${teamId}/sync/reconnect`, {}));
  assert.equal(result.mode, "active");
  assert.equal(
    store.readLink().canonical_head,
    original.canonical_head,
    "Reconnect must not reset or replace C",
  );
  assert.equal(store.readLink().writer_epoch, original.writer_epoch);
  assert.deepEqual(store.readPending().slice(0, pending.length), pending);
  assert.equal(store.readPending().length, pending.length + 1);
  assert.ok(store.readPending().at(-1).dependsOn.includes(pending[0].opId));
  const preserved = store.readPending();
  assert.equal(
    (await a.api(`/teams/${teamId}/sync/reconnect`, {})).status,
    409,
  );
  assert.deepEqual(
    store.readPending(),
    preserved,
    "Duplicate click must not recapture changes",
  );
  ok(await edit(a, "title", "saved immediately after reconnect"));
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  for (const site of [a, b]) {
    assert.equal(
      getTask(site.db, task.id).cells.title.value,
      "saved immediately after reconnect",
    );
    assert.equal(
      getTask(site.db, task.id).cells["2026-10-26"].value,
      "peer changed while disconnected",
    );
    assert.equal(
      ok(await site.api(memoPath)).markdown,
      "해제 중 저장한 꼬리 메모",
    );
    assert.equal(site.app.locals.sync.store(teamId).readPending().length, 0);
  }
  assert.equal(
    stateHash(store.readState()),
    stateHash(b.app.locals.sync.store(teamId).readState()),
  );
});

test("reconnecting same-cell offline edits preserves the peer value and the submitted conflict", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", { teamId, year: 2026, fields: { title: "base" } }),
  ).task;
  await joinPeer(a, b, teamId);
  ok(await a.api(`/teams/${teamId}/sync/disconnect`, {}));
  for (const [site, value] of [
    [a, "internal offline"],
    [b, "external online"],
  ])
    ok(
      await site.api("/cells/batch", {
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
      }),
    );
  await b.app.locals.sync.get(teamId).run();
  ok(await a.api(`/teams/${teamId}/sync/reconnect`, {}));
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  const conflicts = ok(
    await a.api(`/teams/${teamId}/sync/conflicts`),
  ).conflicts;
  assert.equal(conflicts.length, 1);
  assert.ok(
    ok(
      await a.api(`/teams/${teamId}/sync/conflicts/${conflicts[0].conflictId}`),
    ).desired.some((value) => value.value === "internal offline"),
  );
  assert.equal(getTask(a.db, task.id).cells.title.value, "external online");
  assert.equal(getTask(b.db, task.id).cells.title.value, "external online");
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
    // The real service and SQLite transaction primitives run with a fixture-only
    // canonical committer; the transport boundary inserts a deterministic pause.
    const store = {
      ...raw,
      commitCanonical(expected, next, state, acks) {
        a.app.locals.sync.capture.without(() =>
          commitCanonicalForTest(
            adapter,
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
    await assert.rejects(
      checkpoint,
      (error) =>
        error.status === 409 && error.code === "SYNC_PUBLICATION_CONFLICT",
    );
    assert.equal(published, false);
    assert.equal(await a.transport.readHead(), peerHead);
    assert.deepEqual(raw.readPending(), pending);
    assert.equal(stateHash(raw.readState()), stateHash(before));
    await a.app.locals.sync.get(teamId).run({ receiveOnly: true });
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

test(
  "the internal sync log records cycles, the failed Git step with its output, actions and level changes",
  { timeout: 30000 },
  async (t) => {
    const { a, b, teamId, dir } = await fixture(t);
    ok(await a.api("/tasks", { teamId, year: 2026, fields: { title: "log" } }));
    await joinPeer(a, b, teamId);
    const aId = a.app.locals.sync.installationId,
      bId = b.app.locals.sync.installationId;
    a.app.locals.sync.profiles[0].peerInstallationId = bId;
    b.app.locals.sync.profiles[0].peerInstallationId = aId;
    a.app.locals.sync.clear(teamId);
    b.app.locals.sync.clear(teamId);
    const today = syncLogDate(),
      route = `/teams/${teamId}/sync/log`,
      file = join(dir, "a-sync-logs", teamId, today + ".jsonl"),
      written = () =>
        existsSync(file)
          ? readFileSync(file, "utf8").split('"kind":"cycle"').length - 1
          : 0,
      // A cycle's entry is written after the run settles, on a separate
      // branch, so a run that is logged waits for its line.
      run = async ({ quiet = false } = {}) => {
        const before = written();
        let failure;
        try {
          await a.app.locals.sync.get(teamId).run();
        } catch (error) {
          failure = error;
        }
        for (let attempt = 0; !quiet && attempt < 400; attempt++) {
          if (written() > before) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (failure) throw failure;
      },
      entries = async (query = "") => ok(await a.api(route + query)).entries;
    for (let i = 0; i < 2; i++) {
      await run();
      await b.app.locals.sync.get(teamId).run();
    }
    const canonicalHead = await a.transport.readHead();
    let log = ok(await a.api(route));
    assert.equal(log.level, "cycles");
    assert.equal(log.canSetLevel, true);
    assert.equal(log.date, today);
    assert.deepEqual(log.dates, [today]);
    assert.equal(log.retentionDays, 14);
    let listed = await entries();
    const enabled = listed.find((entry) => entry.kind === "action");
    assert.equal(enabled.action, "enable");
    assert.equal(enabled.ok, true);
    assert.equal(enabled.actor.name, "테스트");
    const cycle = listed.find((entry) => entry.kind === "cycle");
    assert.equal(cycle.ok, true);
    assert.equal(cycle.action, "run");
    assert.equal(cycle.mode, "active");
    assert.equal(cycle.head, canonicalHead);
    assert.equal(cycle.peerHead, canonicalHead);
    assert.ok(Number.isInteger(cycle.ms));
    // The first publication moved the head and is counted.
    const published = listed.find((entry) => entry.published);
    assert.equal(published.head, canonicalHead);
    // Successful Git commands are not written at the default level.
    assert.ok(!listed.some((entry) => entry.kind === "git"));

    // The reported failure: the peer's status names a commit this clone has
    // not fetched. The log says which Git step failed and what Git printed.
    const publishPeerStatus = async (appliedCanonicalHead) => {
      const parent = await b.transport.readHead("sync-status/" + bId),
        old = JSON.parse(
          (await b.transport.readFile(parent, "status.json")).toString(),
        );
      assert.equal(
        await b.transport.publish(
          await b.transport.createCandidate(parent, {
            "status.json": canonical({
              ...old,
              appliedCanonicalHead,
              observedAt: new Date().toISOString(),
            }),
          }),
          parent,
          "sync-status/" + bId,
        ),
        true,
      );
    };
    const ahead = await b.transport.createCandidate(canonicalHead, {
      "events/ahead.json": "{}",
    });
    await publishPeerStatus(ahead);
    await assert.rejects(run(), /Git operation failed \(128, merge-base\)/);
    assert.equal(
      ok(await a.api(`/teams/${teamId}/sync`)).lastError,
      "Git operation failed (128, merge-base)",
    );
    listed = await entries("?problems=1");
    const failed = listed.find((entry) => entry.kind === "cycle");
    assert.equal(failed.ok, false);
    assert.equal(
      failed.error.message,
      "Git operation failed (128, merge-base)",
    );
    assert.equal(failed.error.code, 128);
    assert.equal(failed.head, canonicalHead);
    const git = listed.find((entry) => entry.kind === "git");
    assert.equal(git.command, "merge-base");
    assert.equal(git.code, 128);
    assert.match(git.stderr, /Not a valid commit name/);
    assert.ok(git.args.includes(ahead));
    assert.ok(
      listed.every((entry) => entry.ok === false || entry.kind === "state"),
    );
    // The next successful cycle is marked as the recovery.
    await publishPeerStatus(canonicalHead);
    await run();
    listed = await entries();
    assert.equal(listed[0].kind, "cycle");
    assert.equal(listed[0].ok, true);
    assert.equal(listed[0].recovered, true);

    // Every Git command is written only after the administrator asks for it.
    const level = `/admin/teams/${teamId}/sync-log-level`;
    assert.equal((await a.api(level, { level: "all" }, "PUT")).status, 400);
    assert.deepEqual(ok(await a.api(level, { level: "git" }, "PUT")), {
      level: "git",
    });
    await run();
    listed = await entries();
    assert.ok(
      listed.some(
        (entry) =>
          entry.kind === "git" && entry.ok && entry.command === "fetch",
      ),
    );
    const changed = listed.find((entry) => entry.action === "log-level");
    assert.deepEqual([changed.from, changed.to], ["cycles", "git"]);
    // "changes" keeps failures and state changes and drops quiet cycles.
    ok(await a.api(level, { level: "changes" }, "PUT"));
    const cycleCount = async () =>
        (await entries()).filter((entry) => entry.kind === "cycle").length,
      count = await cycleCount();
    await run({ quiet: true });
    // The quiet run above is absent once a later, logged run has been written.
    ok(await a.api(level, { level: "cycles" }, "PUT"));
    await run();
    assert.equal(await cycleCount(), count + 1);
    ok(await a.api(`/teams/${teamId}/sync/pause`, {}));
    listed = await entries();
    assert.ok(
      listed.some((entry) => entry.action === "pause" && entry.ok === true),
    );

    // Pages, the file download and who may see them.
    const origin = `http://127.0.0.1:${a.server.address().port}/api`,
      session = (id, role, systemRole) => {
        const token = randomUUID();
        a.db
          .prepare(
            "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!',?,?)",
          )
          .run(id, id + "@example.com", role, systemRole, "2026-01-01");
        if (role !== "outsider")
          a.db
            .prepare("INSERT INTO memberships VALUES(?,?,?)")
            .run(id, teamId, role);
        a.db
          .prepare("INSERT INTO sessions VALUES(?,?,?)")
          .run(
            createHash("sha256").update(token).digest("hex"),
            id,
            Date.now() + 86400000,
          );
        return (path, body, method = body ? "POST" : "GET") =>
          fetch(origin + path, {
            method,
            headers: {
              cookie: "weekly_session=" + token,
              "X-Requested-With": "WeeklyPlan",
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          });
      },
      lead = session(randomUUID(), "lead", "user"),
      member = session(randomUUID(), "member", "user"),
      outsider = session(randomUUID(), "outsider", "user");
    const viewed = await lead(route);
    assert.equal(viewed.status, 200);
    assert.equal(unpack(await viewed.json()).canSetLevel, false);
    const downloaded = await lead(route + "/download", { date: today });
    assert.equal(downloaded.status, 200);
    assert.match(
      downloaded.headers.get("content-disposition"),
      new RegExp(`sync-log-${today}\\.jsonl`),
    );
    assert.equal(await downloaded.text(), readFileSync(file, "utf8"));
    assert.equal(
      (await lead(route + "/download", { date: "2020-01-01" })).status,
      404,
    );
    assert.equal(
      (await lead(route + "/download", { date: "../settings" })).status,
      404,
    );
    assert.equal((await lead(level, { level: "git" }, "PUT")).status, 403);
    for (const request of [member, outsider]) {
      assert.ok([403, 404].includes((await request(route)).status));
      assert.ok(
        [403, 404].includes(
          (await request(route + "/download", { date: today })).status,
        ),
      );
    }
    // A refused request leaves no entry in the team's log.
    assert.equal((await member(`/teams/${teamId}/sync/run`, {})).status, 403);
    assert.ok(!readFileSync(file, "utf8").includes('"name":"member"'));
    // The position of an entry pages to the ones written before it.
    const all = ok(await a.api(route)).entries,
      page = ok(await a.api(`${route}?before=${all.at(-3).line}`));
    assert.deepEqual(page.entries, all.slice(-2));
    assert.equal(page.next, null);
    assert.deepEqual(ok(await a.api(route + "?before=")).entries, all);
  },
);

test(
  "an event gathers pending commands up to the batch size instead of every one of them",
  { timeout: 60000 },
  async (t) => {
    const { a, b, teamId } = await fixture(t);
    const task = ok(
      await a.api("/tasks", { teamId, year: 2026, fields: { title: "batch" } }),
    ).task;
    await joinPeer(a, b, teamId);
    const store = a.app.locals.sync.store(teamId),
      save = async (value) =>
        ok(
          await a.api("/cells/batch", {
            operationId: randomUUID(),
            createdAt: new Date().toISOString(),
            changes: [
              {
                taskId: task.id,
                key: "title",
                value,
                expectedVersion: getTask(a.db, task.id).cells.title.version,
              },
            ],
          }),
        ),
      // The operations in each event published after `head`, oldest first.
      events = async (head) => {
        const paths = async (commit) =>
            (await a.transport.readCommit(commit)).files
              .map((file) => file.path)
              .filter((file) => file.startsWith("events/")),
          known = new Set(await paths(head)),
          counts = [];
        for (const commit of (
          await a.transport.git(["rev-list", "--reverse", `${head}..sync-v1`])
        )
          .toString()
          .split("\n")
          .filter(Boolean)) {
          const [added, ...others] = (await paths(commit)).filter(
            (file) => !known.has(file),
          );
          assert.equal(others.length, 0);
          known.add(added);
          counts.push(
            JSON.parse((await a.transport.readFile(commit, added)).toString())
              .operations.length,
          );
        }
        return counts;
      },
      publish = async () => {
        for (let i = 0; i < 10 && store.readPending().length; i++)
          await a.app.locals.sync.get(teamId).run();
        assert.equal(store.readPending().length, 0);
      };
    let head = store.readLink().canonical_head;
    await a.transport.git(["update-ref", "refs/heads/sync-v1", head]);
    for (let i = 0; i < 3; i++) await save("small " + i);
    assert.equal(store.readPending().length, 3);
    await publish();
    await a.transport.readHead();
    await a.transport.git([
      "update-ref",
      "refs/heads/sync-v1",
      "refs/remotes/origin/sync-v1",
    ]);
    assert.deepEqual(await events(head), [3]);
    // Each save carries the body before and after, about half a megabyte:
    // two fit the batch size, four no longer travel as one event of 2 MB.
    head = store.readLink().canonical_head;
    let revision = 0;
    for (let i = 0; i < 4; i++)
      revision = ok(
        await a.api(
          `/tasks/${task.id}/document`,
          {
            markdown: "x".repeat(250000) + i,
            expectedRevision: revision,
            operationId: randomUUID(),
          },
          "PUT",
        ),
      ).revision;
    assert.equal(store.readPending().length, 4);
    await publish();
    await a.transport.readHead();
    await a.transport.git([
      "update-ref",
      "refs/heads/sync-v1",
      "refs/remotes/origin/sync-v1",
    ]);
    assert.deepEqual(await events(head), [2, 2]);
    for (let i = 0; i < 6; i++) await b.app.locals.sync.get(teamId).run();
    assert.equal(
      ok(await b.api(`/tasks/${task.id}/document`)).markdown,
      "x".repeat(250000) + 3,
    );
    assert.equal(
      stateHash(store.readState()),
      stateHash(b.app.locals.sync.store(teamId).readState()),
    );
  },
);

test("A3/A6 actual Node upgrade API keeps both peers paused and then synchronizes independent protocol 5 copy rows", async (t) => {
  const { a, b, teamId } = await fixture(t);
  const task = ok(
    await a.api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "original", "2026-10-26": "original detail" },
    }),
  ).task;
  const sheetClone = ok(
    await a.api("/sheet-clones", {
      teamId,
      year: 2026,
      name: "v2 copy",
      referenceDate: "2026-10-29",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  await joinPeer(a, b, teamId);
  for (const site of [a, b])
    ok(await site.api(`/teams/${teamId}/sync/pause`, {}));
  const storeA = a.app.locals.sync.store(teamId),
    storeB = b.app.locals.sync.store(teamId);
  const options = {
    expectedHead: storeA.readLink().canonical_head,
    expectedHash: stateHash(storeA.readState()),
    peersStopped: true,
  };
  assert.equal(
    (
      await a.api(`/teams/${teamId}/sync/upgrade`, {
        ...options,
        expectedHash: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(storeA.readLink().canonical_head, options.expectedHead);
  const upgraded = ok(await a.api(`/teams/${teamId}/sync/upgrade`, options));
  assert.equal(upgraded.protocol, 5);
  assert.equal(storeA.readLink().mode, "paused");
  const received = ok(await b.api(`/teams/${teamId}/sync/upgrade`, options));
  assert.equal(received.received, true);
  assert.equal(storeB.readLink().mode, "paused");
  assert.equal(
    storeA.readLink().canonical_head,
    storeB.readLink().canonical_head,
  );
  assert.equal(stateHash(storeA.readState()), stateHash(storeB.readState()));
  for (const site of [a, b])
    ok(await site.api(`/teams/${teamId}/sync/resume`, {}));
  const save = async (site, key, value) => {
    const before = ok(await site.api(`/sheet-clones/${sheetClone.id}`));
    return ok(
      await site.api(
        `/sheet-clones/${sheetClone.id}`,
        {
          operationId: randomUUID(),
          revision: before.revision,
          operations: [
            {
              kind: "cells",
              at: new Date().toISOString(),
              changes: [
                {
                  taskId: task.id,
                  key,
                  value,
                  expectedVersion: before.tasks[0].cells[key]?.version || 0,
                },
              ],
            },
          ],
        },
        "PATCH",
      ),
    );
  };
  await save(a, "title", "inside copy");
  await save(b, "2026-10-26", "outside copy");
  for (const store of [storeA, storeB]) {
    const pending = store.readPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].protocol, 5);
    // One row with its changed cell and update time; the copy is not sent.
    assert.deepEqual(
      pending[0].changes.map((change) => [
        change.entity,
        [...change.fields].sort(),
      ]),
      [["sheetCloneTask", ["cells", "data"]]],
    );
  }
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  for (const site of [a, b]) {
    const copy = ok(await site.api(`/sheet-clones/${sheetClone.id}`));
    assert.equal(copy.tasks[0].cells.title.value, "inside copy");
    assert.equal(copy.tasks[0].cells["2026-10-26"].value, "outside copy");
    assert.equal(getTask(site.db, task.id).cells.title.value, "original");
    assert.equal(
      getTask(site.db, task.id).cells["2026-10-26"].value,
      "original detail",
    );
    assert.equal(site.app.locals.sync.store(teamId).readPending().length, 0);
  }
  assert.equal(stateHash(storeA.readState()), stateHash(storeB.readState()));
  await save(a, "title", "canonical copy");
  await save(b, "title", "submitted copy");
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  const conflict = ok(
    await b.api(`/teams/${teamId}/sync/conflicts`),
  ).conflicts.find((item) => !item.resolved);
  assert.ok(conflict);
  ok(
    await b.api(
      `/teams/${teamId}/sync/conflicts/${conflict.conflictId}/resolve`,
      {
        choice: "submitted",
        expectedHead: conflict.expectedHead,
        frontier: [conflict.conflictId],
      },
    ),
  );
  assert.equal(storeB.readPending()[0].protocol, 5);
  await b.app.locals.sync.get(teamId).run();
  await a.app.locals.sync.get(teamId).run();
  assert.equal(
    ok(await a.api(`/sheet-clones/${sheetClone.id}`)).tasks[0].cells.title
      .value,
    "submitted copy",
  );
  ok(await a.api(`/teams/${teamId}/sync/disconnect`, {}));
  await save(a, "title", "offline v2 copy");
  ok(await a.api(`/teams/${teamId}/sync/reconnect`, {}));
  assert.ok(
    storeA.readPending().every((operation) => operation.protocol === 5),
  );
  await a.app.locals.sync.get(teamId).run();
  await b.app.locals.sync.get(teamId).run();
  assert.equal(
    ok(await b.api(`/sheet-clones/${sheetClone.id}`)).tasks[0].cells.title
      .value,
    "offline v2 copy",
  );
  assert.equal(stateHash(storeA.readState()), stateHash(storeB.readState()));
});
