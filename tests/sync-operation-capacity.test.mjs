import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";

test("an oversized captured API command returns 400 and rolls back business rows, outbox and audit while retaining request data", async (t) => {
  const f = await performanceFixture({ rows: 450, clients: 1, users: 1 });
  t.after(() => f.close());
  f.setLink("paused");
  const rows = () =>
    f.db
      .prepare(
        "SELECT task_id,value,version FROM cells WHERE key='description' ORDER BY task_id",
      )
      .all();
  const counts = () =>
    ["sync_outbox", "audit", "operations"].map(
      (table) => f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    );
  const before = rows(),
    sizes = counts();
  const body = {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: before.map((row) => ({
      taskId: row.task_id,
      key: "description",
      expectedVersion: row.version,
      value: "x".repeat(10000),
    })),
  };
  const serialized = JSON.stringify(body);
  const response = await fetch(f.origin + "/api/cells/batch", {
    method: "POST",
    headers: {
      cookie: "weekly_session=" + f.tokens[0],
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    body: serialized,
  });
  const result = await response.json();
  assert.equal(response.status, 400, JSON.stringify(result));
  assert.match(result.error, /4MiB/);
  assert.deepEqual(rows(), before);
  assert.deepEqual(counts(), sizes);
  assert.equal(JSON.stringify(body), serialized);
});
