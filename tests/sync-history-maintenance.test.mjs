import test from "node:test";
import assert from "node:assert/strict";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { localHistoryMaintenance } from "../shared/local-history-maintenance.mjs";
import { executeSync, executeAsync } from "../shared/sync-team-store.mjs";
import { canonical, digest, stateHash } from "../server/sync/protocol.mjs";
import { reduceMany } from "../server/sync/reducer.mjs";
import { PostgresTaskRepository } from "../worker/storage/postgres-tasks.mjs";

const asOf = "2026-10-29T00:00:00.000Z",
  now = Date.parse(asOf),
  old = "2026-08-01T00:00:00.000Z";
const q = (sql, values = []) => ({ sql, values });
function atomic(f, generator) {
  return f.adapter.withTeamTransaction(f.teamId, (tx) =>
    f.adapter.engine === "sqlite"
      ? executeSync(generator(tx), tx.query)
      : executeAsync(generator(tx), tx.query),
  );
}
function operation(f, opId, extra = {}) {
  return {
    protocol: 1,
    reducer: 1,
    teamId: f.teamId,
    repoId: f.link.repo_id,
    opId,
    writerEpoch: f.link.writer_epoch,
    actorRef: f.user.id,
    createdAt: old,
    dependsOn: [],
    objects: [],
    changes: [],
    ...extra,
  };
}
function* seed(f, ids) {
  for (const {
    id,
    status = "acknowledged",
    date = old,
    hash = true,
    evidence = true,
    ...extra
  } of ids) {
    const op = operation(f, id, extra),
      payload = canonical(op),
      payloadHash = digest(op);
    yield q(
      "INSERT INTO sync_outbox(team_id,op_id,payload,payload_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [f.teamId, id, payload, hash ? payloadHash : null, status, date],
    );
    if (evidence)
      yield q(
        "INSERT INTO sync_receipts(team_id,op_id,payload_hash,result,commit_oid,receipt) VALUES($1,$2,$3,'applied',$4,$5)",
        [
          f.teamId,
          id,
          payloadHash,
          "b".repeat(40),
          canonical({
            opId: id,
            payloadHash,
            result: "applied",
            conflictId: null,
            outputTokens: {},
          }),
        ],
      );
  }
}
async function rows(f, table) {
  return (
    await atomic(f, function* () {
      return yield q(
        `SELECT * FROM ${table} WHERE team_id=$1 ORDER BY ${table === "site_events" ? "cursor" : table === "sync_receipts" ? "op_id" : table === "sync_outbox" ? "local_seq" : "conflict_id"}`,
        [f.teamId],
      );
    })
  ).rows;
}
for (const engine of ["sqlite", "postgres"])
  test(`${engine}: opt-in maintenance preserves receipts, pending/held/dependencies/conflicts/latest and resets old event cursors`, async (t) => {
    const f = engine === "sqlite" ? sqliteFixture(t) : await postgresFixture(t);
    if (!f) return;
    await atomic(f, function* () {
      yield* seed(f, [
        { id: "eligible" },
        { id: "dependency" },
        { id: "base-version" },
        { id: "resolution" },
        { id: "conflict-source" },
        { id: "missing-hash", hash: false },
        { id: "missing-receipt", evidence: false },
        { id: "boundary", date: "2026-09-29T00:00:00.000Z" },
        { id: "recent", date: "2026-10-28T00:00:00.000Z" },
        {
          id: "pending",
          status: "pending",
          dependsOn: ["dependency"],
          resolves: ["resolution"],
          changes: [{ baseVersion: "base-version:0" }],
        },
        { id: "held", status: "held" },
        { id: "latest" },
      ]);
      yield q(
        "INSERT INTO sync_conflicts VALUES($1,'conflict','conflict-source',$2,NULL)",
        [f.teamId, canonical({ operation: operation(f, "conflict-source") })],
      );
      for (let i = 0; i < 1006; i++)
        yield q(
          "INSERT INTO site_events(team_id,kind,payload,created_at) VALUES($1,'cells',$2,$3)",
          [
            f.teamId,
            canonical({ cells: [], marker: i }),
            i === 0 ? "2026-10-22T00:00:00.000Z" : old,
          ],
        );
    });
    const receiptBefore = await rows(f, "sync_receipts"),
      conflictBefore = await rows(f, "sync_conflicts");
    const before = await localHistoryMaintenance(
      f.adapter,
      f.teamId,
      { asOf },
      { now },
    );
    assert.equal(before.rows, 6);
    assert.deepEqual(
      before.candidates
        .filter((x) => x.table === "sync_outbox")
        .map((x) => x.key),
      ["eligible"],
    );
    assert.equal(
      (await rows(f, "sync_outbox")).length,
      12,
      "preview never deletes",
    );
    await assert.rejects(
      async () =>
        localHistoryMaintenance(
          f.adapter,
          f.teamId,
          { asOf, apply: true, token: "stale" },
          { now },
        ),
      /후보가 변경/,
    );
    await atomic(f, function* () {
      yield q(
        "INSERT INTO site_maintenance_jobs VALUES('backup',$1,'backup','running','{}','{}',$2)",
        [f.teamId, asOf],
      );
    });
    await assert.rejects(
      async () =>
        localHistoryMaintenance(
          f.adapter,
          f.teamId,
          { asOf, apply: true, token: before.token },
          { now },
        ),
      /백업/,
    );
    await atomic(f, function* () {
      yield q("DELETE FROM site_maintenance_jobs WHERE job_id='backup'");
      yield q(
        "UPDATE team_sync_links SET lease_owner='running',lease_until=$2 WHERE team_id=$1",
        [f.teamId, now + 10000],
      );
    });
    await assert.rejects(
      async () =>
        localHistoryMaintenance(
          f.adapter,
          f.teamId,
          { asOf, apply: true, token: before.token },
          { now },
        ),
      /동기화가 진행/,
    );
    await atomic(f, function* () {
      yield q(
        "UPDATE team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=$1",
        [f.teamId],
      );
    });
    const applied = await localHistoryMaintenance(
      f.adapter,
      f.teamId,
      { asOf, apply: true, token: before.token },
      { now },
    );
    assert.equal(applied.removed, 6);
    assert.equal(
      (await rows(f, "site_events")).length,
      1001,
      "7-day boundary and latest 1000 preserved",
    );
    assert.deepEqual(await rows(f, "sync_receipts"), receiptBefore);
    assert.deepEqual(await rows(f, "sync_conflicts"), conflictBefore);
    assert.equal((await rows(f, "sync_outbox")).at(-1).op_id, "latest");
    const state = await f.adapter.readState(f.teamId),
      hash = stateHash(state);
    assert.equal(
      stateHash(
        reduceMany(state, [operation(f, "eligible")], {
          teamId: f.teamId,
          repoId: f.link.repo_id,
        }),
      ),
      hash,
      "deleted local outbox cannot reapply an immutable receipt",
    );
    const repeat = await localHistoryMaintenance(
      f.adapter,
      f.teamId,
      { asOf },
      { now },
    );
    assert.equal(repeat.rows, 0);
    assert.equal(
      (
        await localHistoryMaintenance(
          f.adapter,
          f.teamId,
          { asOf, apply: true, token: repeat.token },
          { now },
        )
      ).removed,
      0,
    );
    if (engine === "postgres") {
      const repository = new PostgresTaskRepository({
        context: f.makeContext(),
      });
      // Cursor 2 was deleted while cursor 1 survives the age boundary. A gap in
      // the returned sequence must reset even when the first event still exists.
      const events = await repository.readEvents(
        f.user,
        { teamId: f.teamId, year: 2026, startMonth: 1 },
        "pg:2",
      );
      assert.equal(events.reset, true);
      assert.equal(events.cursor, "pg:1006");
    }
  });

test("SQLite: batch limit, stale preview, and injected deletion failure roll back the entire batch", async (t) => {
  const f = sqliteFixture(t);
  await atomic(f, function* () {
    yield* seed(
      f,
      Array.from({ length: 502 }, (_, i) => ({ id: `op-${i}` })),
    );
  });
  const preview = await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf },
    { now },
  );
  assert.equal(preview.rows, 500);
  assert.equal(preview.hasMore, true);
  f.db.exec(
    "CREATE TRIGGER fail_history BEFORE DELETE ON sync_outbox WHEN OLD.op_id='op-250' BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END",
  );
  await assert.rejects(
    async () =>
      localHistoryMaintenance(
        f.adapter,
        f.teamId,
        { asOf, apply: true, token: preview.token },
        { now },
      ),
    /injected deletion failure/,
  );
  assert.equal((await rows(f, "sync_outbox")).length, 502);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM site_maintenance_jobs").get().n,
    0,
  );
  f.db.exec("DROP TRIGGER fail_history");
  await atomic(f, function* () {
    yield q(
      "UPDATE team_sync_links SET generation=generation+1 WHERE team_id=$1",
      [f.teamId],
    );
  });
  await assert.rejects(
    async () =>
      localHistoryMaintenance(
        f.adapter,
        f.teamId,
        { asOf, apply: true, token: preview.token },
        { now },
      ),
    /후보가 변경/,
  );
  const current = await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf },
    { now },
  );
  assert.equal(
    (
      await localHistoryMaintenance(
        f.adapter,
        f.teamId,
        { asOf, apply: true, token: current.token },
        { now },
      )
    ).removed,
    500,
  );
  const next = await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf },
    { now },
  );
  assert.equal(next.rows, 1);
  assert.equal(next.hasMore, false);
});

test("SQLite maintenance never reads or removes more than a 10MiB event payload batch", async (t) => {
  const f = sqliteFixture(t),
    payload = canonical({ cells: [], retained: "x".repeat(256 * 1024) });
  await atomic(f, function* () {
    for (let i = 0; i < 1042; i++)
      yield q(
        "INSERT INTO site_events(team_id,kind,payload,created_at) VALUES($1,'cells',$2,$3)",
        [f.teamId, i < 42 ? payload : '{"cells":[]}', i < 42 ? old : asOf],
      );
  });
  const first = await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf },
    { now },
  );
  assert.ok(first.rows > 0 && first.rows < 42);
  assert.ok(first.bytes <= 10 * 1024 * 1024);
  assert.equal(first.hasMore, true);
  await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf, apply: true, token: first.token },
    { now },
  );
  const second = await localHistoryMaintenance(
    f.adapter,
    f.teamId,
    { asOf },
    { now },
  );
  assert.equal(first.rows + second.rows, 42);
  assert.equal(second.hasMore, false);
  assert.ok(second.bytes <= 10 * 1024 * 1024);
});
