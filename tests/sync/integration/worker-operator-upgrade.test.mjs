import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultView } from "../../../shared/domain.js";
import {
  stateHash,
  protocolVersion,
} from "../../../server/sync/core/protocol.mjs";
import { upgradeTeam } from "../../../scripts/sync/sync-external-import.mjs";
import {
  bridgeFixture,
  bridgePgBin,
  ok,
} from "../../support/worker-bridge-fixture.mjs";

test(
  "the operator machine runs the external site's protocol transition, and the internal site receives it",
  { skip: !existsSync(join(bridgePgBin, "initdb")), timeout: 180000 },
  async (t) => {
    const f = await bridgeFixture(t, { port: 55448 }),
      { teamId, inside, outside, team, env, profile } = f,
      quiet = { log: () => {} },
      tasks = [];
    for (let i = 0; i < 3; i++)
      tasks.push(
        ok(
          await inside("/tasks", {
            teamId,
            year: 2026,
            fields: { title: "Row " + i },
          }),
        ).task,
      );
    await f.settle();
    const copy = ok(
      await outside("/sheet-clones", {
        teamId,
        year: 2026,
        name: "Rows",
        referenceDate: "2026-10-27",
        taskIds: tasks.map((task) => task.id),
        view: defaultView(2026),
      }),
    );
    await f.settle();
    const head = () => f.internalStore().readLink().canonical_head,
      hash = () => stateHash(f.internalStore().readState());
    // A running team is reported and left alone.
    const running = await upgradeTeam(env, profile, quiet);
    assert.deepEqual(
      [running.mode, running.protocol, running.pending, running.execute],
      ["active", 3, 0, false],
    );
    await assert.rejects(
      upgradeTeam(env, profile, {
        ...quiet,
        execute: true,
        expectedHead: head(),
        expectedHash: hash(),
      }),
      /일시정지/,
    );
    ok(await inside(`/teams/${teamId}/sync/pause`, {}));
    ok(await outside(`/teams/${teamId}/sync/pause`, {}));
    // The status gives the state hash both sites must share.
    const status = await upgradeTeam(env, profile, quiet);
    assert.deepEqual(
      [status.mode, status.expectedHead, status.expectedHash],
      ["paused", head(), hash()],
    );
    await assert.rejects(
      upgradeTeam(env, profile, { ...quiet, execute: true }),
      /expected-head/,
    );
    await assert.rejects(
      upgradeTeam({ ...env, INSTALLATION_ID: randomUUID() }, profile, {
        ...quiet,
        execute: true,
        expectedHead: status.expectedHead,
        expectedHash: status.expectedHash,
      }),
      /INSTALLATION_ID/,
    );
    assert.equal(protocolVersion(await f.pgStore.readState(teamId)), 3);
    // External first, from the operator machine; the internal site then
    // receives the transition commit it published.
    const options = {
      expectedHead: status.expectedHead,
      expectedHash: status.expectedHash,
    };
    const upgraded = await upgradeTeam(env, profile, {
      ...quiet,
      ...options,
      execute: true,
    });
    assert.deepEqual([upgraded.protocol, upgraded.upgraded], [5, true]);
    assert.equal(
      ok(
        await inside(`/teams/${teamId}/sync/upgrade`, {
          ...options,
          peersStopped: true,
        }),
      ).received,
      true,
    );
    assert.equal(hash(), stateHash(await f.pgStore.readState(teamId)));
    assert.equal(hash(), upgraded.stateHash);
    assert.equal((await upgradeTeam(env, profile, quiet)).protocol, 5);
    ok(await inside(`/teams/${teamId}/sync/resume`, {}));
    ok(await outside(`/teams/${teamId}/sync/resume`, {}));
    // The copy is stored by row and both sites keep synchronizing.
    assert.equal(
      (
        await team.query(
          "SELECT COUNT(*)::int AS rows FROM graeboard.site_entities WHERE team_id=$1 AND entity='sheetCloneTask' AND deleted=0",
          [teamId],
        )
      ).rows[0].rows,
      3,
    );
    const path = "/sheet-clones/" + copy.id;
    ok(
      await outside(
        path,
        {
          operationId: randomUUID(),
          revision: ok(await outside(path)).revision,
          operations: [
            {
              kind: "cells",
              at: new Date().toISOString(),
              changes: [
                {
                  taskId: tasks[0].id,
                  key: "2026-10-19",
                  expectedVersion: 0,
                  value: "after",
                },
              ],
            },
          ],
        },
        "PATCH",
      ),
    );
    await f.settle();
    assert.equal(
      ok(await inside(path)).tasks.find((task) => task.id === tasks[0].id)
        .cells["2026-10-19"].value,
      "after",
    );
    assert.equal(hash(), stateHash(await f.pgStore.readState(teamId)));
  },
);
