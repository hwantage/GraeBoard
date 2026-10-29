import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { canonical, emptyState, stateHash } from "../server/sync/protocol.mjs";
import { encodeSnapshot } from "../server/sync/snapshot.mjs";
import {
  decodeBoundedSnapshot,
  assertFileCapacity,
} from "../worker/capacity.mjs";
import {
  assertStateCapacity,
  assertReceiptCapacity,
  capacityLimits,
  receiptCapacity,
} from "../shared/sync-capacity.mjs";
import {
  SYNC_RECEIPT_MAX_BYTES,
  SYNC_SNAPSHOT_MAX_BYTES,
} from "../shared/sync-limits.js";
import { createReceiptCapacityGuard } from "../server/sync/receipt-capacity.mjs";
import { transaction } from "../server/db.mjs";

const receipt = (id) => ({
  opId: id,
  payloadHash: "a".repeat(64),
  result: "applied",
  conflictId: null,
  outputTokens: { '["cell",["task","description"]]': `${id}:0` },
});

test("12,000 and 50,000 immutable receipts have a separate budget and survive snapshot round trips without changing stateHash", () => {
  for (const count of [12000, 50000]) {
    const state = emptyState();
    for (let i = 0; i < count; i++) {
      const id = String(i).padStart(36, "r");
      state.receipts[id] = receipt(id);
    }
    const before = stateHash(state),
      size = assertStateCapacity(state);
    assert.ok(size.bytes < 1024);
    assert.ok(size.receiptBytes > count * 250);
    if (count === 50000) assert.equal(size.receiptCapacity.warning, true);
    const bytes = encodeSnapshot({ state, hash: before });
    assertFileCapacity("snapshots/history.json.gz", bytes);
    const restored = decodeBoundedSnapshot(bytes);
    assert.equal(stateHash(restored.state), before);
    assert.equal(stateHash(state), before);
    assert.equal(Object.keys(restored.state.receipts).length, count);
  }
});
test("old over-budget receipt state remains readable while new receipts and oversized snapshots are rejected", () => {
  const state = emptyState();
  const id = "old";
  state.receipts[id] = {
    ...receipt(id),
    outputTokens: { retained: "x".repeat(SYNC_RECEIPT_MAX_BYTES) },
  };
  const result = assertStateCapacity(state, capacityLimits(), [], {
    allowReceiptOverflow: true,
  });
  assert.equal(result.receiptCapacity.blocked, true);
  assert.throws(
    () => assertStateCapacity(state),
    (error) => error.code === "EXTERNAL_SYNC_CAPACITY",
  );
  assert.throws(
    () => assertReceiptCapacity(SYNC_RECEIPT_MAX_BYTES + 1, 400),
    (error) => error.status === 400,
  );
  assert.equal(receiptCapacity(12 * 1024 * 1024).warning, true);
  assert.throws(
    () =>
      decodeBoundedSnapshot(
        gzipSync(Buffer.alloc(SYNC_SNAPSHOT_MAX_BYTES + 1, 32)),
      ),
    /decoded byte capacity/,
  );
  assert.throws(
    () =>
      assertFileCapacity(
        "snapshots/history.json.gz",
        new Uint8Array(SYNC_SNAPSHOT_MAX_BYTES + 1),
      ),
    /file capacity/,
  );
  assert.throws(
    () =>
      assertFileCapacity(
        "events/operation.json",
        new Uint8Array(4 * 1024 * 1024 + 1),
      ),
    /file capacity/,
  );
});
test("Node receipt preflight rejects a save atomically while old over-budget records remain readable", async (t) => {
  const f = await performanceFixture({ rows: 1, clients: 1, users: 1 });
  t.after(() => f.close());
  f.setLink("paused");
  const insert = f.db.prepare(
    "INSERT INTO sync_receipts(team_id,op_id,payload_hash,receipt,commit_oid,result) VALUES(?,?,?,?,?,'applied')",
  );
  transaction(f.db, () => {
    for (let i = 0; i < 23000; i++) {
      const id = String(i).padStart(200, "r"),
        value = receipt(id);
      insert.run(
        f.teamId,
        id,
        value.payloadHash,
        canonical(value),
        "a".repeat(40),
      );
    }
  });
  const store = f.app.locals.sync.store(f.teamId),
    link = store.readLink();
  const guard = createReceiptCapacityGuard(f.db);
  assert.equal(guard.status(link).blocked, true);
  assert.equal(Object.keys(store.readState().receipts).length, 23000);
  const row = f.db
    .prepare("SELECT value,version FROM cells WHERE task_id=? AND key='title'")
    .get(f.taskIds[0]);
  const pending = store.readPending(),
    audit = f.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n;
  const body = {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: f.taskIds[0],
        key: "title",
        value: "Preserve this input",
        expectedVersion: row.version,
      },
    ],
  };
  const response = await fetch(f.origin + "/api/cells/batch", {
    method: "POST",
    headers: {
      cookie: "weekly_session=" + f.tokens[0],
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, 400, JSON.stringify(data));
  assert.match(data.error, /16MiB/);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT value,version FROM cells WHERE task_id=? AND key='title'",
      )
      .get(f.taskIds[0]),
    row,
  );
  assert.deepEqual(store.readPending(), pending);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, audit);
  assert.equal(body.changes[0].value, "Preserve this input");
});

test("actual PostgreSQL receipt preflight rejects an external API save atomically and preserves reads", async (t) => {
  const { postgresFixture } = await import("./business-storage-fixture.mjs");
  const { createExternalRouteApp } =
    await import("./external-route-fixture.mjs");
  const { databaseCapacity } = await import("../worker/capacity.mjs");
  const f = await postgresFixture(t);
  if (!f) return;
  await f.pool.query(
    `INSERT INTO graeboard.sync_receipts(team_id,op_id,payload_hash,result,commit_oid,receipt)
    SELECT $1,id,repeat('a',64),'applied',repeat('b',40),
    '{"conflictId":null,"opId":"'||id||'","outputTokens":{"retained":"'||id||':0"},"payloadHash":"'||repeat('a',64)||'","result":"applied"}'
    FROM (SELECT lpad(i::text,200,'r') id FROM generate_series(1,23000) i) entries`,
    [f.teamId],
  );
  const capacity = await databaseCapacity(f.adapter, f.teamId);
  assert.equal(capacity.receiptCapacity.blocked, true);
  const state = await f.adapter.readState(f.teamId);
  assert.equal(Object.keys(state.receipts).length, 23000);
  assert.equal(
    assertStateCapacity(state, capacityLimits(), [], {
      allowReceiptOverflow: true,
    }).receiptBytes,
    capacity.receiptBytes,
  );
  const app = createExternalRouteApp({ env: f.env, defaultUserId: f.user.id });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const summary = async () =>
    (
      await f.pool.query(
        "SELECT (SELECT COUNT(*) FROM graeboard.sync_outbox) pending,(SELECT COUNT(*) FROM graeboard.site_audit) audit,(SELECT COUNT(*) FROM graeboard.site_events) events,(SELECT COUNT(*) FROM graeboard.site_operations) operations",
      )
    ).rows;
  try {
    const before = await summary();
    const query = await fetch(
      origin + `/api/tasks?teamId=${f.teamId}&year=2026`,
    );
    assert.equal(query.status, 200);
    const cell = state.entities[JSON.stringify(["cell", [f.taskId, "title"]])];
    const response = await fetch(origin + "/api/cells/batch", {
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
            taskId: f.taskId,
            key: "title",
            value: "preserved external input",
            expectedVersion: 1,
          },
        ],
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 400, JSON.stringify(result));
    assert.match(result.error, /16MiB/);
    assert.deepEqual(await summary(), before);
    assert.deepEqual(
      (await f.adapter.readState(f.teamId)).entities[
        JSON.stringify(["cell", [f.taskId, "title"]])
      ],
      cell,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
});
