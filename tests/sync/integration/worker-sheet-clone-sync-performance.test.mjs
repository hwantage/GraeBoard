import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { sheetCloneSyncFixture } from "../../support/worker-sheet-clone-sync-fixture.mjs";
import { createPublisher } from "../../../worker/sync/sync.mjs";
import { PostgresDatabase } from "../../../worker/storage/postgres.mjs";
import {
  canonical,
  entityId,
  stateHash,
} from "../../../server/sync/core/protocol.mjs";
import { defaultView } from "../../../shared/domain.js";

test(
  "continuous small remote commits cannot starve the large external clone or its document edits",
  {
    skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
    timeout: 180000,
  },
  async (t) => {
    const f = await sheetCloneSyncFixture(t);
    for (let i = 0; i < 3; i++) await f.remoteEdit(`backlog-${i}`);
    const cycles = [];
    for (let i = 0; i < 6; i++) {
      await f.remoteEdit(`continuous-${i}`);
      const result = await f.run();
      cycles.push(result);
      assert.equal((await f.pg.adapter.readLink(f.teamId)).lease_owner, null);
      if (!result.pending) break;
    }
    console.log(
      "continuous clone sync measurement",
      JSON.stringify({ ...f.metrics, cycles }),
    );
    assert.equal(
      cycles.at(-1).pending,
      0,
      "large P must drain while a new remote commit arrives before every hosted cycle",
    );
    assert.deepEqual(
      cycles.map((r) => r.pending),
      [3, 0],
    );
    for (const result of cycles) {
      assert.ok(result.cloneParses <= 1);
      const receivePhases = result.phases.filter(
        (p) => p.phase === "receiveImages",
      );
      assert.ok(
        receivePhases.every(
          (p) => p.cloneValidated === false || p.cloneValidated === undefined,
        ),
        "unrelated receives must not replay the large pending clone",
      );
    }
    assert.equal(
      cycles[0].siteCloneParses,
      1,
      "the large site row is compared only for its own publication, never for unrelated receives",
    );
    await f.verify();
  },
);

test(
  "a save after image receive is replayed transactionally and charged before any large publication",
  {
    skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
    timeout: 180000,
  },
  async (t) => {
    const f = await sheetCloneSyncFixture(t);
    const current = (
      await f.call(`/tasks?teamId=${f.teamId}&year=2026`)
    ).tasks.find((task) => task.id === f.taskIds[0]);
    await f.remoteEdit("concurrent-input");
    const commit = PostgresDatabase.prototype.commitCanonical;
    let saved;
    PostgresDatabase.prototype.commitCanonical = async function (...args) {
      if (args[0] === f.teamId && !saved) {
        await f.call("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: current.id,
              key: "title",
              value: "Concurrent external title",
              expectedVersion: current.cells.title.version,
            },
          ],
        });
        saved = (await f.pg.adapter.readPending(f.teamId)).at(-1);
      }
      return commit.apply(this, args);
    };
    let first;
    try {
      first = await f.run();
    } finally {
      PostgresDatabase.prototype.commitCanonical = commit;
    }
    assert.ok(saved);
    assert.equal(first.pending, 5);
    assert.equal(
      first.phases.filter((p) => p.phase === "createCandidate").length,
      0,
    );
    assert.ok(
      first.phases.some(
        (p) =>
          p.phase === "pendingProjection" &&
          p.operations === 5 &&
          p.bytes > f.metrics.operationBytes[0],
      ),
    );
    for (
      let i = 0;
      i < 5 && (await f.pg.adapter.readPending(f.teamId)).length;
      i++
    )
      await f.run();
    await f.verify({ conflicts: 1 });
    const state = await f.pg.adapter.readState(f.teamId);
    assert.equal(state.receipts[saved.opId].result, "conflict");
    assert.equal(
      canonical(state.conflicts[saved.opId].operation),
      canonical(saved),
    );
  },
);

for (const backlog of [0, 3])
  test(
    `external packed clone and three document edits drain through PG/Git with ${backlog} remote commits`,
    {
      skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
      timeout: 180000,
    },
    async (t) => {
      const f = await sheetCloneSyncFixture(t);
      for (let i = 0; i < backlog; i++) await f.remoteEdit(i);
      const cycles = [];
      for (let i = 0; i < 10; i++) {
        const result = await f.run();
        cycles.push(result);
        if (!result.pending) break;
      }
      const verified = await f.verify();
      console.log(
        "clone sync measurement",
        JSON.stringify({ ...f.metrics, backlog, cycles, ...verified }),
      );
      for (const result of cycles) {
        assert.ok(
          result.cloneParses <= 1,
          "the same immutable large outbox JSON must parse once per run",
        );
        assert.ok(
          result.phases
            .filter((p) => p.phase === "receiveImages")
            .every((p) => !p.cloneValidated),
          "unrelated receives leave the large projection in its site rows",
        );
      }
      assert.equal(cycles.length, 2);
    },
  );

test(
  "a large external clone leaves the editing invocation to Cron, and CAS movement retries without losing its documents",
  {
    skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
    timeout: 180000,
  },
  async (t) => {
    const f = await sheetCloneSyncFixture(t);
    const publisher = createPublisher({
      wait: () =>
        assert.fail("large copies must not start a waitUntil sync timer"),
    });
    assert.deepEqual(await publisher(f.pg.env, f.profile), { deferred: true });
    assert.equal((await f.pg.adapter.readPending(f.teamId)).length, 4);
    assert.equal((await f.pg.adapter.readLink(f.teamId)).lease_owner, null);
    const publish = f.transport.publish.bind(f.transport);
    let raced = false;
    f.transport.publish = async (...args) => {
      if (!raced) {
        raced = true;
        await f.remoteEdit("CAS");
      }
      return publish(...args);
    };
    const first = await f.run();
    assert.equal(first.pending, 4);
    assert.equal(
      first.phases.filter((p) => p.phase === "createCandidate").length,
      1,
    );
    assert.equal(
      first.phases.filter((p) => p.phase === "commitCanonical").length,
      0,
    );
    assert.equal((await f.pg.adapter.readLink(f.teamId)).lease_owner, null);
    const cycles = [first];
    for (let i = 0; i < 5 && cycles.at(-1).pending; i++)
      cycles.push(await f.run());
    const verified = await f.verify();
    console.log(
      "clone sync measurement",
      JSON.stringify({ ...f.metrics, race: true, cycles, ...verified }),
    );
  },
);

test(
  "remote copy name collision preserves the atomic large command and dependent document edits as conflicts",
  {
    skip: !existsSync(join(process.env.TEST_PG_BIN || "", "postgres")),
    timeout: 180000,
  },
  async (t) => {
    const f = await sheetCloneSyncFixture(t);
    const remote = await f.api("/sheet-clones", {
      teamId: f.teamId,
      year: 2026,
      name: "External large clone",
      referenceDate: "2026-11-08",
      taskIds: [f.taskIds[0]],
      view: defaultView(2026),
    });
    await f.app.locals.sync.get(f.teamId).run();
    const received = await f.run();
    assert.equal(received.pending, 4);
    assert.equal(
      received.phases.filter((p) => p.phase === "commitCanonical").length,
      1,
    );
    assert.deepEqual(await f.pg.adapter.readPending(f.teamId), f.pending);
    assert.equal(
      (await f.call(`/sheet-clones/${f.clone.id}`)).tasks.length,
      480,
      "held local input stays accessible before its receipt",
    );
    for (
      let i = 0;
      i < 5 && (await f.pg.adapter.readPending(f.teamId)).length;
      i++
    )
      await f.run();
    assert.equal((await f.pg.adapter.readPending(f.teamId)).length, 0);
    await f.app.locals.sync.get(f.teamId).run();
    const external = await f.pg.adapter.readState(f.teamId),
      internal = f.app.locals.sync.store(f.teamId).readState();
    assert.equal(stateHash(external), stateHash(internal));
    assert.ok(external.entities[entityId("sheetClone", [remote.id])]);
    assert.equal(
      external.entities[entityId("sheetClone", [f.clone.id])],
      undefined,
    );
    assert.equal(external.receipts[f.pending[0].opId].result, "conflict");
    for (const op of f.pending) {
      assert.equal(
        canonical(external.conflicts[op.opId].operation),
        canonical(op),
        "all original copy content and edits remain recoverable in canonical conflicts",
      );
      if (op !== f.pending[0])
        assert.equal(external.receipts[op.opId].result, "dependency-blocked");
    }
  },
);
