import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";

test("an oversized captured API command returns 400 and rolls back business rows, outbox and audit while retaining request data", async (t) => {
  const f = await performanceFixture({ rows: 2000, clients: 1, users: 1 });
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
  const post = (body) =>
    fetch(f.origin + "/api/cells/batch", {
      method: "POST",
      headers: {
        cookie: "weekly_session=" + f.tokens[0],
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      body,
    });
  const batch = (current, fill) => ({
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: current.map((row) => ({
      taskId: row.task_id,
      key: "description",
      expectedVersion: row.version,
      value: fill.repeat(10000),
    })),
  });
  // A command carries the previous and the desired values. Store maximal cell
  // values first so that a request within the HTTP body limit still produces a
  // command above the synchronization transfer limit.
  const seeded = await post(JSON.stringify(batch(rows(), "x")));
  assert.equal(seeded.status, 200, await seeded.text());
  const before = rows(),
    sizes = counts();
  const body = batch(before, "y");
  const serialized = JSON.stringify(body);
  const response = await post(serialized);
  const result = await response.json();
  assert.equal(response.status, 400, JSON.stringify(result));
  assert.match(result.error, /32MiB/);
  assert.deepEqual(rows(), before);
  assert.deepEqual(counts(), sizes);
  assert.equal(JSON.stringify(body), serialized);
});
