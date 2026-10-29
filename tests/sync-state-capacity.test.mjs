import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { transaction, upsertCellStatement, getTask } from "../server/db.mjs";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import { encodeReport } from "../server/reports.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { allEntities } from "../server/sync/entities.mjs";
import { canonical, emptyState, stateHash } from "../server/sync/protocol.mjs";
import { decodeSnapshot } from "../server/sync/snapshot.mjs";
import {
  capacityLimits,
  assertStateCapacity,
  assertFileCapacity,
  databaseCapacity,
} from "../worker/capacity.mjs";
import { serviceFor } from "../worker/sync.mjs";
import { GitHubApiTransport } from "../worker/git.mjs";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";

const MiB = 1024 * 1024;

test("state and entity budgets grow independently of event files, with bounded configuration and pending accounting", () => {
  const limits = capacityLimits();
  assert.equal(limits.maxBytes, 32 * MiB);
  assert.equal(limits.maxEntities, 50000);
  assert.equal(limits.maxSnapshotBytes, 64 * MiB);
  assert.equal(limits.maxReceiptBytes, 16 * MiB);
  for (const env of [
    { SYNC_MAX_STATE_BYTES: 32 * MiB + 1 },
    { SYNC_MAX_ENTITIES: 50001 },
    { SYNC_MAX_STATE_BYTES: "NaN" },
  ])
    assert.throws(() => capacityLimits(env), /configuration is invalid/);
  const lower = capacityLimits({
    SYNC_MAX_STATE_BYTES: String(4 * MiB),
    SYNC_MAX_ENTITIES: "12000",
  });
  assert.equal(lower.maxBytes, 4 * MiB);
  assert.equal(lower.maxEntities, 12000);
  assertFileCapacity("events/a.json", new Uint8Array(4 * MiB));
  assert.throws(
    () => assertFileCapacity("events/a.json", new Uint8Array(4 * MiB + 1)),
    /file capacity/,
  );
  const state = emptyState();
  state.entities.one = { payload: "x".repeat(32 * MiB - 256) };
  assertStateCapacity(state);
  assert.throws(
    () => assertStateCapacity(state, limits, [{ payload: "x".repeat(512) }]),
    /state and pending capacity/,
  );
  state.entities.one.payload += "x".repeat(512);
  assert.throws(() => assertStateCapacity(state), /state byte capacity/);
  state.entities = Object.fromEntries(
    Array.from({ length: 50000 }, (_, i) => [String(i), {}]),
  );
  assert.equal(assertStateCapacity(state).entities, 50000);
  state.entities.extra = {};
  assert.throws(() => assertStateCapacity(state), /entity capacity/);
});

test(
  "over 25 MiB and 30,000 entities publish from SQLite and import through external serviceFor into actual PostgreSQL",
  {
    skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
    timeout: 120000,
  },
  async (t) => {
    const f = await performanceFixture({
      rows: 467,
      clients: 1,
      users: 10,
      documents: 2315,
      scheduleColumns: 0,
    });
    t.after(() => f.close());
    const user = f.db.prepare("SELECT * FROM users LIMIT 1").get(),
      reportId = randomUUID(),
      stamp = new Date().toISOString();
    transaction(f.db, () => {
      const cell = upsertCellStatement(f.db),
        count = f.db.prepare("SELECT count(*) n FROM cells").get().n;
      for (let i = count; i < 25612; i++)
        cell.run(
          f.taskIds[i % f.taskIds.length],
          "capacity-" + i,
          '한글 " quote\nline\t\\ ' + "x".repeat(90),
          {},
          1,
        );
      const docs = f.db.prepare("SELECT task_id,id FROM task_documents").all(),
        update = f.db.prepare(
          "UPDATE task_documents SET version_id=? WHERE task_id=? AND id=?",
        );
      for (const doc of docs)
        update.run(
          storeDocumentVersion(f.db, {
            teamId: f.teamId,
            documentId: JSON.stringify(["task", doc.task_id, doc.id]),
            markdown: "문서 " + doc.id + "\n" + "d".repeat(2300),
            actorId: user.id,
          }),
          doc.task_id,
          doc.id,
        );
      const calendar = f.db.prepare(
        "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,title,updated_at,actor_id) VALUES(?,?,?,'2026-10-29','2026-10-29',?,?,?)",
      );
      for (let i = 0; i < 2307; i++)
        calendar.run(
          randomUUID(),
          f.teamId,
          user.id,
          "일정 " + i,
          stamp,
          user.id,
        );
      const reportTask = getTask(f.db, f.taskIds[0]);
      reportTask.cells.description.value = "r".repeat(9 * MiB);
      f.db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
        reportId,
        f.teamId,
        2026,
        "Large retained report",
        "2026-10-29",
        user.id,
        stamp,
        encodeReport({
          settings: DEFAULT_SETTINGS,
          view: defaultView(2026),
          users: [{ id: user.id, name: user.name }],
          tasks: [reportTask],
        }),
      );
    });
    f.setLink("initializing");
    // Real queued saves must be acknowledged by the snapshot, never cleared to
    // make the initial publication fit. They match the failed deployment state.
    for (let i = 0; i < 2; i++)
      await f.api("/cells/batch", {
        operationId: randomUUID(),
        createdAt: stamp,
        changes: [
          {
            taskId: f.taskIds[i],
            key: "title",
            value: "queued " + i,
            expectedVersion: 1,
          },
        ],
      });
    const store = f.app.locals.sync.store(f.teamId),
      beforeLink = store.readLink(),
      pending = store.readPending(),
      state = { ...emptyState(), entities: allEntities(f.db, beforeLink) },
      size = assertStateCapacity(state);
    assert.equal(pending.length, 2);
    assert.ok(size.bytes > 25.36 * MiB && size.bytes < 32 * MiB);
    assert.ok(size.entities > 30000);
    await f.app.locals.sync.get(f.teamId).run({ initialize: true });
    const published = store.readLink(),
      publishedState = store.readState();
    assert.ok(published.canonical_head);
    assert.equal(store.readPending().length, 0);
    assert.deepEqual(publishedState.entities, state.entities);
    for (const op of pending)
      assert.equal(publishedState.receipts[op.opId].result, "applied");
    const frozen = decodeSnapshot(
      await f.transport.readFile(
        published.canonical_head,
        "snapshots/genesis.json.gz",
      ),
    );
    assert.equal(stateHash(frozen.state), published.canonical_hash);

    const externalLink = {
      ...beforeLink,
      profile_id: "contract",
      installation_id: randomUUID(),
      writer_epoch: randomUUID(),
      mode: "importing",
      canonical_head: null,
    };
    const pg = await postgresFixture(t, {
      ...f,
      user,
      link: externalLink,
      state: emptyState(),
    });
    const profile = JSON.parse(pg.env.SYNC_PROFILES)[0],
      github = githubEmulator(f.remote),
      transport = new GitHubApiTransport({
        repository: "fixture/team",
        token: "fixture-secret",
        fetch: github.fetch,
      });
    pg.env.BUCKET = bucket();
    const external = serviceFor(pg.env, profile, externalLink, { transport });
    // An explicitly retained old setting must still reject without partial rows
    // or a cursor advance, then the same connection can retry with new defaults.
    const limited = serviceFor(
      { ...pg.env, SYNC_MAX_STATE_BYTES: 4 * MiB },
      profile,
      externalLink,
      { transport },
    );
    await assert.rejects(limited.run({ receiveOnly: true }), {
      code: "EXTERNAL_SYNC_CAPACITY",
    });
    assert.equal((await pg.adapter.readLink(f.teamId)).canonical_head, null);
    assert.equal((await databaseCapacity(pg.adapter, f.teamId)).entities, 0);
    // A capacity rejection quarantines the link; resume the same import after
    // changing the limit, preserving identity and the empty canonical cursor.
    await pg.adapter.withTeamTransaction(f.teamId, (tx) =>
      tx.sync.writeLink({ mode: "importing" }),
    );
    const start = performance.now();
    await external.run({ receiveOnly: true });
    const imported = await pg.adapter.readState(f.teamId);
    assert.equal(stateHash(imported), published.canonical_hash);
    assert.equal(
      (await pg.adapter.readLink(f.teamId)).canonical_head,
      published.canonical_head,
    );
    assert.deepEqual(imported, publishedState);
    assert.deepEqual(
      await databaseCapacity(pg.adapter, f.teamId),
      assertStateCapacity(imported),
    );
    const rows = (
      await pg.pool.query(
        "SELECT entity,COUNT(*)::integer n FROM graeboard.site_entities WHERE deleted=0 GROUP BY entity",
      )
    ).rows;
    const counts = Object.fromEntries(rows.map((r) => [r.entity, r.n]));
    assert.equal(counts.cell, 25612);
    assert.equal(counts.task, 467);
    // Every calendar also owns a document entity, including empty Markdown.
    assert.equal(counts.document, 2315 + 2307);
    assert.equal(counts.calendar, 2307);
    assert.equal(counts.report, 1);
    const report = (
      await pg.pool.query(
        "SELECT payload FROM graeboard.site_entities WHERE entity='report' AND entity_key=$1",
        [canonical([reportId])],
      )
    ).rows[0];
    assert.equal(
      JSON.parse(report.payload).data.tasks[0].cells.description.value.length,
      9 * MiB,
    );
    const importMs = Math.round(performance.now() - start);
    await pg.adapter.withTeamTransaction(f.teamId, (tx) =>
      tx.sync.writeLink({ mode: "paused" }),
    );
    const app = createExternalRouteApp({ env: pg.env, defaultUserId: user.id }),
      server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const row = (
        await pg.pool.query(
          "SELECT revision FROM graeboard.site_entities WHERE entity='cell' AND entity_key=$1",
          [canonical([f.taskIds[0], "title"])],
        )
      ).rows[0];
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/cells/batch`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "WeeklyPlan",
          },
          body: JSON.stringify({
            operationId: randomUUID(),
            createdAt: new Date().toISOString(),
            changes: [
              {
                taskId: f.taskIds[0],
                key: "title",
                value: "edited outside after large import",
                expectedVersion: Number(row.revision),
              },
            ],
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await app.close();
    }
    assert.equal((await pg.adapter.readPending(f.teamId)).length, 1);
    await pg.adapter.withTeamTransaction(f.teamId, (tx) =>
      tx.sync.writeLink({ mode: "active" }),
    );
    await external.run();
    await f.app.locals.sync.get(f.teamId).run({ receiveOnly: true });
    assert.equal(
      getTask(f.db, f.taskIds[0]).cells.title.value,
      "edited outside after large import",
    );
    assert.equal((await pg.adapter.readPending(f.teamId)).length, 0);
    assert.equal(
      (await pg.adapter.readLink(f.teamId)).canonical_hash,
      store.readLink().canonical_hash,
    );
    t.diagnostic(
      JSON.stringify({
        stateMiB: Number((size.bytes / MiB).toFixed(2)),
        entities: size.entities,
        importMs,
        runtime:
          "Node + temporary PostgreSQL + local Git/GitHub API emulator; not hosted Supabase",
      }),
    );
  },
);
