import test from "node:test";
import assert from "node:assert/strict";
import { postgresFixture } from "../../support/business-storage-fixture.mjs";
import { revertTeamToV3 } from "../../support/postgres-legacy-schema.mjs";
import { migratePostgres } from "../../../server/migrations/postgres.mjs";
import { canonical } from "../../../server/sync/core/protocol.mjs";

test("team v3 summaries upgrade atomically and preserve original values, repeat safely and track resolution writes", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  await revertTeamToV3(f.pool);
  assert.equal((await f.adapter.health()).version, 3);
  const conflict = {
    conflictId: "summary-migration",
    opId: "old-op",
    resolution: null,
    reason: "Concurrent field change",
    operation: {
      opId: "old-op",
      actorRef: "author",
      createdAt: "2026-11-16T00:00:00Z",
      changes: [
        {
          entity: "cell",
          key: ["task", "title"],
          desired: { value: "保존\u0000".repeat(100000) },
        },
      ],
    },
    current: {},
  };
  const operation = {
    ...conflict.operation,
    opId: "pending",
    resolves: [conflict.conflictId],
  };
  await f.pool.query(
    "INSERT INTO graeboard.sync_conflicts VALUES($1,$2,$3,$4,NULL)",
    [f.teamId, conflict.conflictId, conflict.opId, canonical(conflict)],
  );
  await f.pool.query(
    "INSERT INTO graeboard.sync_outbox(op_id,team_id,payload,status,created_at) VALUES($1,$2,$3,'pending',$4)",
    [operation.opId, f.teamId, canonical(operation), operation.createdAt],
  );
  const snapshot = async () =>
    (
      await f.pool.query(
        "SELECT payload FROM graeboard.sync_conflicts UNION ALL SELECT payload FROM graeboard.sync_outbox ORDER BY payload",
      )
    ).rows;
  const original = await snapshot();
  const version = async () =>
    Number(
      (
        await f.pool.query(
          "SELECT max(version) v FROM graeboard.schema_migrations",
        )
      ).rows[0].v,
    );
  assert.equal(
    (
      await migratePostgres(f.pool, {
        scope: "team",
        teamId: f.teamId,
        dryRun: true,
      })
    ).to,
    4,
  );
  assert.equal(await version(), 3);
  assert.equal(
    (
      await f.pool.query(
        "SELECT to_regclass('graeboard.sync_conflict_summaries') t",
      )
    ).rows[0].t,
    null,
  );
  await assert.rejects(
    migratePostgres(f.pool, {
      scope: "team",
      teamId: f.teamId,
      afterDdl() {
        throw new Error("simulated migration failure");
      },
    }),
    /simulated migration failure/,
  );
  assert.equal(await version(), 3);
  assert.deepEqual(await snapshot(), original);
  await migratePostgres(f.pool, { scope: "team", teamId: f.teamId });
  assert.equal(await version(), 4);
  assert.deepEqual(await snapshot(), original);
  const summaries = async () =>
    (
      await f.pool.query(
        "SELECT summary FROM graeboard.sync_conflict_summaries UNION ALL SELECT summary FROM graeboard.sync_outbox_summaries ORDER BY summary",
      )
    ).rows;
  const cached = await summaries();
  assert.equal(cached.length, 2);
  assert.ok(JSON.stringify(cached).length < 2000);
  assert.equal(
    JSON.parse(cached[0].summary).operation?.changes[0].desired.length ||
      JSON.parse(cached[0].summary).changes[0].desired.length,
    64,
  );
  assert.equal(
    (await migratePostgres(f.pool, { scope: "team", teamId: f.teamId }))
      .applied,
    false,
  );
  assert.deepEqual(await summaries(), cached);
  const write = async (tx) => {
    const state = await tx.sync.readState();
    state.conflicts[conflict.conflictId].resolution = "pending";
    await tx.sync.writeState(state, "b".repeat(40));
  };
  await assert.rejects(
    f.adapter.withTeamTransaction(f.teamId, async (tx) => {
      await write(tx);
      throw new Error("rollback resolution");
    }),
    /rollback resolution/,
  );
  assert.deepEqual(await snapshot(), original);
  assert.deepEqual(await summaries(), cached);
  await f.adapter.withTeamTransaction(f.teamId, write);
  assert.equal(
    JSON.parse(
      (
        await f.pool.query(
          "SELECT summary FROM graeboard.sync_conflict_summaries",
        )
      ).rows[0].summary,
    ).resolution,
    true,
  );
  // An old writer or raw restore invalidates, rather than retaining a stale label.
  await f.pool.query(
    "UPDATE graeboard.sync_conflicts SET resolution=NULL WHERE team_id=$1",
    [f.teamId],
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*) n FROM graeboard.sync_conflict_summaries",
      )
    ).rows[0].n,
    "0",
  );
});
