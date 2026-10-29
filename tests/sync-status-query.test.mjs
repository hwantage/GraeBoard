import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, transaction } from "../server/db.mjs";
import { sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { createSyncStatusReader } from "../server/sync/node-status.mjs";
import { createReceiptCapacityGuard } from "../server/sync/receipt-capacity.mjs";
import { reservedReceiptBytes } from "../shared/sync-capacity.mjs";

test("status and receipt reservations use only pending/held rows beside 50,000 acknowledged operations", (t) => {
  const db = openDatabase(":memory:"),
    teamId = randomUUID(),
    siteId = randomUUID(),
    queries = new Map();
  t.after(() => db.close());
  db.prepare("INSERT INTO teams VALUES(?,?,'{}')").run(teamId, "Query plan");
  const store = sqliteTeamStore(db, teamId);
  store.writeLink({
    repo_id: "repo",
    bootstrap_id: "bootstrap",
    installation_id: siteId,
    writer_epoch: "writer",
    profile_id: "profile",
    mode: "active",
    canonical_head: "a".repeat(40),
    updated_at: "2026-10-29T00:00:00Z",
  });
  // Capture the statements executed by the production readers, rather than
  // checking a separately maintained copy of their SQL.
  const observedDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return Object.fromEntries(
        ["all", "get"].map((method) => [
          method,
          (...args) => {
            queries.set(sql, args);
            return statement[method](...args);
          },
        ]),
      );
    },
  };
  const status = createSyncStatusReader({
      db: observedDb,
      sync: { store: () => store, installationId: siteId },
    }),
    capacity = createReceiptCapacityGuard(observedDb),
    operation = () => ({
      opId: randomUUID(),
      changes: [{ entity: "cell", key: ["task", "title"], baseVersion: "v1" }],
    }),
    pending = operation(),
    held = operation(),
    candidate = operation(),
    insert = db.prepare(
      "INSERT INTO sync_outbox(team_id,op_id,payload,status,created_at) VALUES(?,?,?,?,?)",
    ),
    insertOperation = (value, state = "pending") =>
      insert.run(
        teamId,
        value.opId,
        JSON.stringify(value),
        state,
        "2026-10-29T00:00:00Z",
      );
  insertOperation(pending);
  insertOperation(held, "held");
  const link = store.readLink(),
    reserved = 2 + reservedReceiptBytes(pending) + reservedReceiptBytes(held),
    before = status(teamId);
  assert.equal(
    capacity.check(link, candidate).bytes,
    reserved + reservedReceiptBytes(candidate),
  );
  const stamp = "2026-10-29T01:00:00Z",
    payload = JSON.stringify({ diagnostic: "x".repeat(2048) });
  transaction(db, () => {
    for (let i = 0; i < 50000; i++)
      insert.run(teamId, "ack-" + i, payload, "acknowledged", stamp);
  });
  const after = status(teamId);
  assert.equal(after.pending, 2);
  assert.equal(after.lastLocalSavedAt, stamp);
  assert.deepEqual(after.receiptCapacity, before.receiptCapacity);
  assert.equal(
    capacity.check(link, candidate).bytes,
    reserved + reservedReceiptBytes(candidate),
  );
  insertOperation(candidate);
  const next = operation();
  const expected =
    reserved + reservedReceiptBytes(candidate) + reservedReceiptBytes(next);
  assert.equal(capacity.check(link, next).bytes, expected);
  assert.equal(
    capacity.check(link, next).bytes,
    expected,
    "cached reservations must not be counted twice",
  );
  assert.equal(status(teamId).pending, 3);
  const outboxQueries = [...queries].filter(([sql]) =>
    sql.includes("FROM sync_outbox"),
  );
  assert.equal(outboxQueries.length, 3);
  for (const [sql, args] of outboxQueries) {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .all(...args)
      .map((row) => row.detail)
      .join("\n");
    assert.match(
      plan,
      sql.includes("status<>'acknowledged'")
        ? /USING INDEX sync_outbox_pending_idx/
        : /USING INDEX sync_outbox_team_sequence/,
      sql,
    );
    assert.doesNotMatch(plan, /SCAN sync_outbox|TEMP B-TREE/, sql);
  }
});
