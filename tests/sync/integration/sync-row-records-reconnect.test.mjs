import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTask } from "../../../server/db.mjs";
import { defaultView } from "../../../shared/domain.js";
import { entityId, stateHash } from "../../../server/sync/core/protocol.mjs";
import { sqliteTeamStore } from "../../../server/storage/sqlite.mjs";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";
import { recoverSync } from "../../../scripts/sync/sync-recover.mjs";
import {
  bridgeFixture,
  bridgePgBin,
  ok,
} from "../../support/worker-bridge-fixture.mjs";

const COPY_FORMATTING = ["sheetCloneFormat", "sheetCloneRule"];

// A team under protocol 5 whose copy changed its formatting twice. Shared
// state keeps the formats and rules the copy no longer uses while the copy
// lives (see validateIncrement), so the internal site's local data has fewer
// of them than shared state.
async function formattedCopy(t, port) {
  const f = await bridgeFixture(t, { port }),
    { inside, outside, teamId } = f;
  const task = ok(
    await inside("/tasks", { teamId, year: 2026, fields: { title: "Task" } }),
  ).task;
  const copy = ok(
    await inside("/sheet-clones", {
      teamId,
      year: 2026,
      name: "Formatted",
      referenceDate: "2026-11-15",
      taskIds: [task.id],
      view: defaultView(2026),
    }),
  );
  await f.settle();
  ok(await inside(`/teams/${teamId}/sync/pause`, {}));
  ok(await outside(`/teams/${teamId}/sync/pause`, {}));
  const upgrade = {
    expectedHead: f.internalStore().readLink().canonical_head,
    expectedHash: stateHash(f.internalStore().readState()),
    peersStopped: true,
  };
  ok(await inside(`/teams/${teamId}/sync/upgrade`, upgrade));
  ok(await outside(`/teams/${teamId}/sync/upgrade`, upgrade));
  ok(await inside(`/teams/${teamId}/sync/resume`, {}));
  ok(await outside(`/teams/${teamId}/sync/resume`, {}));
  const path = "/sheet-clones/" + copy.id,
    edit = async (site, operations) =>
      ok(
        await site(
          path + "?changes=1",
          {
            operationId: randomUUID(),
            revision: ok(await site(path)).revision,
            operations,
          },
          "PATCH",
        ),
      ),
    editCopyTitle = async (site, value) => {
      const row = ok(await site(path)).tasks[0];
      return edit(site, [
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [
            {
              taskId: row.id,
              key: "title",
              expectedVersion: row.cells.title.version,
              value,
            },
          ],
        },
      ]);
    },
    editTaskTitle = async (value) =>
      ok(
        await inside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: getTask(f.db, task.id).cells.title.version,
              value,
            },
          ],
        }),
      );
  for (const color of ["#123456", "#654321"]) {
    await edit(inside, [
      {
        kind: "format",
        id: randomUUID(),
        at: new Date().toISOString(),
        scopes: [{ rows: null, keys: null, style: { color } }],
      },
    ]);
    await f.settle();
  }
  const shared = () => f.internalStore().readState(),
    formatting = (state, live = true) =>
      Object.values(state.entities)
        .filter(
          (record) =>
            COPY_FORMATTING.includes(record.entity) &&
            record.key[0] === copy.id &&
            !record.deleted === live,
        )
        .map((record) => record.entity + record.key[1])
        .sort();
  // The copy names one format now; shared state holds the earlier ones too.
  const state = shared(),
    record = state.entities[entityId("sheetClone", [copy.id])],
    used = new Set(Object.values(record.payload.formats));
  assert.ok(
    formatting(state).filter((id) => id.startsWith("sheetCloneFormat")).length >
      used.size,
    "shared state keeps formats the copy no longer uses",
  );
  return {
    f,
    task,
    copy,
    path,
    editCopyTitle,
    editTaskTitle,
    shared,
    formatting,
  };
}
const changesOf = (operations) =>
  operations
    .flatMap((op) => op.changes.map((c) => `${c.entity} ${c.action}`))
    .sort();
const conflictsOf = (state) =>
  Object.values(state.conflicts).map((conflict) => ({
    reason: conflict.reason,
    entities: conflict.operation.changes.map((change) => change.entity),
  }));

test(
  "protocol 5 reconnection keeps the formats and rules a living copy no longer uses: offline edits apply without conflict, a real conflict and a copy's deletion still work",
  { skip: !existsSync(join(bridgePgBin, "initdb")), timeout: 240000 },
  async (t) => {
    const {
      f,
      task,
      copy,
      path,
      editCopyTitle,
      editTaskTitle,
      shared,
      formatting,
    } = await formattedCopy(t, 55468);
    const { inside, outside, teamId, pgStore } = f;
    const kept = formatting(shared());
    const offline = async (work) => {
      ok(await inside(`/teams/${teamId}/sync/disconnect`, {}));
      await work();
      ok(await inside(`/teams/${teamId}/sync/reconnect`, {}));
      const pending = changesOf(f.internalStore().readPending());
      await f.settle();
      return pending;
    };
    const same = async () => {
      assert.equal(
        f.internalStore().readLink().canonical_head,
        (await pgStore.readLink(teamId)).canonical_head,
      );
      assert.equal(
        stateHash(shared()),
        stateHash(await pgStore.readState(teamId)),
      );
    };

    // An offline edit of an ordinary task, and then of the copy, is the only
    // change reconnection sends.
    assert.deepEqual(
      await offline(() => editTaskTitle("Task edited offline")),
      ["cell edit"],
    );
    assert.deepEqual(
      await offline(() => editCopyTitle(inside, "Copy edited offline")),
      ["sheetCloneTask edit"],
    );
    assert.deepEqual(conflictsOf(shared()), []);
    assert.equal(
      getTask(f.db, task.id).cells.title.value,
      "Task edited offline",
    );
    for (const site of [inside, outside])
      assert.equal(
        ok(await site(path)).tasks[0].cells.title.value,
        "Copy edited offline",
      );
    assert.deepEqual(formatting(shared()), kept);
    await same();

    // Both sites editing the same cell is still a conflict, of that row only.
    const conflictsBefore = Object.keys(shared().conflicts).length;
    assert.deepEqual(
      await offline(async () => {
        await editCopyTitle(inside, "Inside while disconnected");
        await editCopyTitle(outside, "Outside meanwhile");
        await f.drain();
      }),
      ["sheetCloneTask edit"],
    );
    const conflicts = conflictsOf(shared());
    assert.equal(conflicts.length, conflictsBefore + 1);
    assert.deepEqual(conflicts.at(-1).entities, ["sheetCloneTask"]);
    assert.ok(!/sheetClone (format|rule)/.test(conflicts.at(-1).reason));
    for (const site of [inside, outside])
      assert.equal(
        ok(await site(path)).tasks[0].cells.title.value,
        "Outside meanwhile",
      );
    assert.deepEqual(formatting(shared()), kept);
    await same();

    // Deleting the copy offline removes all of its formats and rules, the
    // earlier ones included.
    const pending = await offline(async () => {
      ok(await inside("/sheet-clones", { teamId, ids: [copy.id] }, "DELETE"));
    });
    assert.deepEqual(
      pending.filter((change) => /^sheetClone(Format|Rule) /.test(change)),
      kept.map((id) =>
        id.replace(/^(sheetClone(?:Format|Rule)).*/, "$1 delete"),
      ),
    );
    assert.ok(pending.includes("sheetClone delete"));
    assert.equal(conflictsOf(shared()).length, conflicts.length);
    assert.deepEqual(formatting(shared()), []);
    assert.deepEqual(formatting(shared(), false), kept);
    for (const site of [inside, outside])
      assert.equal((await site(path)).status, 404);
    await same();
  },
);

test(
  "protocol 5 recovery keeps the formats and rules a living copy no longer uses: only the offline edits are recovered",
  { skip: !existsSync(join(bridgePgBin, "initdb")), timeout: 240000 },
  async (t) => {
    const { f, task, path, editCopyTitle, editTaskTitle, formatting, shared } =
      await formattedCopy(t, 55469);
    const { inside, teamId } = f;
    const kept = formatting(shared());
    ok(await inside(`/teams/${teamId}/sync/disconnect`, {}));
    await editTaskTitle("Task edited offline");
    await editCopyTitle(inside, "Copy edited offline");
    // Recovery runs with the application's writer stopped.
    const installationId = f.internalStore().readLink().installation_id;
    await f.app.locals.sync.close();
    const recover = (options) =>
      recoverSync({
        db: f.db,
        teamId,
        installationId,
        profiles: [f.internalProfile],
        imagesDir: join(f.dir, "recovered-images"),
        transports: {
          inside: new GitCliTransport({
            directory: join(f.dir, "recovered.git"),
            repository: f.remote,
            allowLocal: true,
          }),
        },
        ...options,
      });
    assert.equal((await recover({ dryRun: true })).uncapturedChanges, 2);
    assert.equal((await recover({ confirmDrained: true })).mode, "paused");
    const store = sqliteTeamStore(f.db, teamId);
    assert.deepEqual(changesOf(store.readPending()), [
      "cell edit",
      "sheetCloneTask edit",
    ]);
    assert.deepEqual(conflictsOf(store.readState()), []);
    assert.deepEqual(formatting(store.readState()), kept);
    assert.equal(
      getTask(f.db, task.id).cells.title.value,
      "Task edited offline",
    );
    assert.equal(
      ok(await inside(path)).tasks[0].cells.title.value,
      "Copy edited offline",
    );
  },
);
