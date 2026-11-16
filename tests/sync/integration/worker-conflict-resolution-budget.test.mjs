import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  sqliteFixture,
  postgresFixture,
} from "../../support/business-storage-fixture.mjs";
import { adminRoutes } from "../../../worker/control/admin.mjs";
import { PostgresDatabase } from "../../../worker/storage/postgres.mjs";
import {
  canonical,
  entityId,
  equal,
} from "../../../server/sync/core/protocol.mjs";
import { makeOperation } from "../../../server/sync/core/operations.mjs";
import { reduceMany } from "../../../server/sync/core/reducer.mjs";
import { unpackSheetCloneData } from "../../../shared/sheet-clones/sheet-clone-sync-data.js";
import { materialize } from "../../../worker/sync/materialize.mjs";

const enabled = existsSync(join(process.env.TEST_PG_BIN || "", "postgres"));
test(
  "large conflict choices stay bounded, preserve pending edits and roll back failed saves",
  { skip: !enabled, timeout: 180000 },
  async (t) => {
    const f = sqliteFixture(t),
      key = entityId("sheetClone", [f.sheetCloneId]);
    const initial = f.state.entities[key],
      plain = unpackSheetCloneData(initial.payload.data),
      task = plain.tasks[0];
    const data = {
      ...plain,
      tasks: Array.from({ length: 480 }, (_, i) => ({
        ...task,
        id: `synthetic-${i}`,
        cells: Object.fromEntries(
          Array.from({ length: 34 }, (_, j) => [
            `w${j}`,
            {
              value: "synthetic schedule " + "x".repeat(130),
              style: { bold: true, backgroundColor: "#d1eee6" },
              version: 1,
            },
          ]),
        ),
      })),
    };
    const base = { ...initial, payload: { ...initial.payload, data } };
    const desired = (n) => ({
      ...base.payload,
      data: {
        ...data,
        tasks: [
          { ...data.tasks[0], title: `choice-${n}` },
          ...data.tasks.slice(1),
        ],
      },
    });
    f.state.entities[key] = {
      ...base,
      payload: desired("canonical"),
      version: "canonical",
    };
    const operations = Array.from({ length: 17 }, (_, n) =>
      makeOperation({
        link: f.link,
        actorRef: f.user.id,
        before: { [key]: base },
        after: { [key]: { ...base, payload: desired(n) } },
      }),
    );
    f.state = reduceMany(f.state, operations);
    for (const op of operations)
      assert.equal(f.state.receipts[op.opId].result, "conflict");
    const bytes = Buffer.byteLength(
      canonical(f.state.conflicts[operations[0].opId]),
    );
    assert.ok(bytes > 9 * 1024 * 1024, `realistic conflict size: ${bytes}`);
    const pg = await postgresFixture(t, f),
      before = await pg.adapter.readState(f.teamId);
    const transaction = PostgresDatabase.prototype.withTeamTransaction;
    let trace,
      failWrite = false;
    PostgresDatabase.prototype.withTeamTransaction = function (
      team,
      work,
      options,
    ) {
      return transaction.call(
        this,
        team,
        async (tx) => {
          if (!trace) return work(tx);
          const query = tx.query,
            pending = tx.sync.readPendingRows;
          tx.sync.readPendingRows = async (...args) => {
            trace.pendingReads++;
            return pending.apply(tx.sync, args);
          };
          tx.query = async (sql, args) => {
            if (/INSERT INTO site_entities/.test(sql) && failWrite)
              throw new Error("simulated materialization failure");
            const result = await query(sql, args);
            if (/FROM sync_conflicts/.test(sql))
              trace.conflictBytes += Buffer.byteLength(
                JSON.stringify(result.rows),
              );
            if (/SELECT s\.\* FROM site_entities/.test(sql)) trace.siteReads++;
            return result;
          };
          return work(tx);
        },
        options,
      );
    };
    t.after(() => {
      PostgresDatabase.prototype.withTeamTransaction = transaction;
    });
    const resolve = (index, choice, extra = {}) => {
      trace = { pendingReads: 0, conflictBytes: 0, siteReads: 0 };
      return adminRoutes(
        pg.makeContext(),
        `/teams/${f.teamId}/sync/conflicts/${operations[index].opId}/resolve`,
        "POST",
        {
          expectedHead: f.link.canonical_head,
          choice,
          frontier: [operations[index].opId],
          ...extra,
        },
        new URLSearchParams(),
      );
    };
    await assert.rejects(
      resolve(0, "submitted", { expectedHead: "stale" }),
      (e) => e.status === 409,
    );
    assert.equal(trace.pendingReads, 0);
    failWrite = true;
    await assert.rejects(
      resolve(0, "submitted"),
      /simulated materialization failure/,
    );
    failWrite = false;
    trace = null;
    assert.equal((await pg.adapter.readPending(f.teamId)).length, 0);
    assert.ok(equal(await pg.adapter.readState(f.teamId), before));
    const first = await resolve(0, "submitted");
    assert.ok(first.ok);
    assert.ok(
      trace.conflictBytes < bytes / 2,
      "only the selected desired value and conflict identities cross into the worker",
    );
    assert.equal(
      trace.siteReads,
      1,
      "materialize the already checked projection once",
    );
    await assert.rejects(
      resolve(0, "submitted"),
      (e) => e.status === 409 && /이미 해결/.test(e.message),
    );
    assert.equal(
      trace.pendingReads,
      0,
      "retrying a saved choice never loads pending originals",
    );
    await assert.rejects(
      resolve(1, "submitted"),
      (e) => e.status === 409 && e.details.code === "resolution-rejected",
    );
    assert.equal(
      trace.siteReads,
      0,
      "a true conflict is rejected before any site write",
    );
    for (let i = 1; i < 17; i++) {
      assert.ok((await resolve(i, "current")).ok);
      assert.equal(
        trace.pendingReads,
        0,
        "keeping a value cannot be blocked by replaying earlier large edits",
      );
      assert.equal(trace.siteReads, 0);
      assert.ok(trace.conflictBytes < 2048);
    }
    trace = null;
    const pending = await pg.adapter.readPending(f.teamId);
    assert.equal(pending.length, 17);
    assert.ok(
      equal(await pg.adapter.readState(f.teamId), before),
      "saving choices leaves all canonical originals intact",
    );
    // The shared reducer must accept precisely the commands the API saved;
    // receiving them clears pending rows and preserves the selected clone.
    const published = reduceMany(before, pending);
    for (const op of pending)
      assert.ok(
        ["applied", "noop"].includes(published.receipts[op.opId].result),
      );
    await pg.adapter.commitCanonical(
      f.teamId,
      f.link.canonical_head,
      "b".repeat(40),
      published,
      pending.map((op) => op.opId),
      (tx, input) => materialize(tx, f.teamId, input),
    );
    assert.equal((await pg.adapter.readPending(f.teamId)).length, 0);
    const listed = await adminRoutes(
      pg.makeContext(),
      `/teams/${f.teamId}/sync/conflicts`,
      "GET",
      {},
      new URLSearchParams({ status: "open" }),
    );
    assert.equal(listed.conflicts.length, 0);
    assert.ok(equal(published.entities[key].payload, desired(0)));
    for (const op of operations)
      assert.ok(published.conflicts[op.opId].resolution);
  },
);
