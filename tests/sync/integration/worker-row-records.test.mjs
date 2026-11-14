import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transaction, writeFormatting } from "../../../server/db.mjs";
import { defaultView } from "../../../shared/domain.js";
import {
  stateHash,
  protocolVersion,
} from "../../../server/sync/core/protocol.mjs";
import {
  bridgeFixture,
  bridgePgBin,
  ok,
} from "../../support/worker-bridge-fixture.mjs";

const plain = (sheetClone) => ({
  name: sheetClone.name,
  year: sheetClone.year,
  tasks: sheetClone.tasks.map((task) => ({
    id: task.id,
    title: task.cells.title?.value,
    note: task.cells["2026-10-19"]?.value ?? null,
    rules: (task.formatting?.rules || []).map((rule) => rule.id),
  })),
});

test(
  "protocol 5 on the external site: a copy is stored and synchronized by row, and an edit reads and writes only its row",
  { skip: !existsSync(join(bridgePgBin, "initdb")), timeout: 180000 },
  async (t) => {
    const f = await bridgeFixture(t, { port: 55447 }),
      { teamId, inside, outside, team } = f;
    const tasks = [];
    for (let i = 0; i < 6; i++)
      tasks.push(
        ok(
          await inside("/tasks", {
            teamId,
            year: 2026,
            fields: { title: "Row " + i },
          }),
        ).task,
      );
    transaction(f.db, () =>
      writeFormatting(f.db, teamId, {
        revision: 1,
        rules: [
          {
            id: "row-rule",
            rows: tasks.slice(0, 3).map((task) => task.id),
            keys: ["title"],
            excludeKeys: [],
            style: { backgroundColor: "#ffe8a3" },
            orders: { backgroundColor: 1 },
          },
        ],
      }),
    );
    await f.settle();
    const sheetClone = ok(
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
    const path = "/sheet-clones/" + sheetClone.id,
      siteRows = async () =>
        Object.fromEntries(
          (
            await team.query(
              "SELECT entity,COUNT(*)::int AS count FROM graeboard.site_entities WHERE team_id=$1 AND entity LIKE 'sheetClone%' AND deleted=0 GROUP BY entity",
              [teamId],
            )
          ).rows.map((row) => [row.entity, row.count]),
        ),
      revisions = async () =>
        new Map(
          (
            await team.query(
              "SELECT entity,entity_key,revision FROM graeboard.site_entities WHERE team_id=$1 AND entity LIKE 'sheetClone%'",
              [teamId],
            )
          ).rows.map((row) => [
            row.entity + row.entity_key,
            Number(row.revision),
          ]),
        ),
      changed = (before, after) =>
        [...after]
          .filter(([id, revision]) => before.get(id) !== revision)
          .map(([id]) => id)
          .sort(),
      edit = async (site, operations) => {
        const before = ok(await site(path));
        return ok(
          await site(
            path,
            {
              operationId: randomUUID(),
              revision: before.revision,
              operations,
            },
            "PATCH",
          ),
        );
      },
      cell = (taskId, value) => ({
        kind: "cells",
        at: new Date().toISOString(),
        changes: [{ taskId, key: "2026-10-19", expectedVersion: 0, value }],
      }),
      // The site rows one row's change writes: the row and the copy's revision.
      rowAndCopy = (taskId) => [
        `sheetCloneTask["${sheetClone.id}","${taskId}"]`,
        `sheetClone["${sheetClone.id}"]`,
      ],
      same = async () => {
        const [a, b] = [ok(await inside(path)), ok(await outside(path))];
        assert.deepEqual(plain(a), plain(b));
        assert.equal(
          stateHash(f.internalStore().readState()),
          stateHash(await f.pgStore.readState(teamId)),
        );
        return b;
      };
    // Protocol 3: the copy is one site row.
    assert.deepEqual(await siteRows(), { sheetClone: 1 });
    const before = plain(await same());
    assert.deepEqual(
      before.tasks.map((task) => task.rules),
      [["row-rule"], ["row-rule"], ["row-rule"], [], [], []],
    );

    // The explicit transition, both sites paused at the same head.
    ok(await inside(`/teams/${teamId}/sync/pause`, {}));
    ok(await outside(`/teams/${teamId}/sync/pause`, {}));
    const options = {
      expectedHead: f.internalStore().readLink().canonical_head,
      expectedHash: stateHash(f.internalStore().readState()),
      peersStopped: true,
    };
    assert.equal(
      ok(await inside(`/teams/${teamId}/sync/upgrade`, options)).protocol,
      5,
    );
    assert.equal(
      ok(await outside(`/teams/${teamId}/sync/upgrade`, options)).received,
      true,
    );
    ok(await inside(`/teams/${teamId}/sync/resume`, {}));
    ok(await outside(`/teams/${teamId}/sync/resume`, {}));
    assert.equal(protocolVersion(await f.pgStore.readState(teamId)), 5);
    // The transition rewrote the site rows as the copy's records: the parent,
    // one format for the three rows under the rule, one for the rows whose
    // formatting has no rule, and six rows.
    assert.deepEqual(await siteRows(), {
      sheetClone: 1,
      sheetCloneFormat: 2,
      sheetCloneTask: 6,
    });
    assert.deepEqual(plain(await same()), before);
    assert.equal(
      ok(await outside("/sheet-clones?teamId=" + teamId)).sheetClones[0].name,
      "Rows",
    );

    // An external edit of one cell writes that row and moves the copy's
    // revision; its command carries that row alone.
    let at = await revisions();
    const edited = await edit(outside, [cell(tasks[1].id, "outside")]);
    assert.equal(plain(edited).tasks[1].note, "outside");
    let now = await revisions();
    assert.deepEqual(changed(at, now), rowAndCopy(tasks[1].id));
    const [pending] = await f.pgStore.readPending(teamId);
    assert.deepEqual(
      pending.changes.map((change) => [
        change.entity,
        change.key[1],
        change.fields,
      ]),
      // The cell and the row's update time.
      [["sheetCloneTask", tasks[1].id, ["cells", "data"]]],
    );
    assert.equal(pending.protocol, 5);

    // An internal edit of another row arrives through the partial path: the
    // external site reads that row, its parent and the copy's format, not the
    // copy's other rows, and writes that row.
    await edit(inside, [cell(tasks[4].id, "inside")]);
    f.phases.length = 0;
    at = await revisions();
    await f.settle();
    now = await revisions();
    assert.deepEqual(changed(at, now), rowAndCopy(tasks[4].id));
    const slices = f.phases.filter((phase) => phase.phase === "readSlice");
    assert.ok(slices.length, "the partial path handled protocol 5");
    assert.ok(
      slices.every((phase) => phase.entities < 12),
      JSON.stringify(slices),
    );
    assert.equal(
      f.phases.some((phase) => phase.phase === "readState"),
      false,
      "no whole-state read",
    );
    let merged = plain(await same());
    assert.equal(merged.tasks[1].note, "outside");
    assert.equal(merged.tasks[4].note, "inside");

    // Both sites edit different cells of different rows at once: both stay.
    await edit(inside, [cell(tasks[0].id, "inside again")]);
    await edit(outside, [cell(tasks[5].id, "outside again")]);
    await f.settle();
    merged = plain(await same());
    assert.equal(merged.tasks[0].note, "inside again");
    assert.equal(merged.tasks[5].note, "outside again");
    assert.deepEqual(
      Object.keys((await f.pgStore.readState(teamId)).conflicts),
      [],
    );

    // Removing a row externally deletes that row record and the parent's
    // order entry; the history entry restores it.
    at = await revisions();
    await edit(outside, [
      { kind: "delete", at: new Date().toISOString(), taskIds: [tasks[2].id] },
    ]);
    now = await revisions();
    assert.deepEqual(changed(at, now), rowAndCopy(tasks[2].id));
    assert.deepEqual(await siteRows(), {
      sheetClone: 1,
      sheetCloneFormat: 2,
      sheetCloneTask: 5,
    });
    await f.settle();
    assert.equal(plain(await same()).tasks.length, 5);
    const entry = ok(
      await outside(`/audit?teamId=${teamId}&sheetId=${sheetClone.id}`),
    ).entries.find((item) => item.restorableTaskIds.length);
    assert.deepEqual(entry.restorableTaskIds, [tasks[2].id]);
    ok(
      await outside(`/audit/${entry.id}/restore`, {
        revision: ok(await outside(path)).revision,
      }),
    );
    await f.settle();
    merged = plain(await same());
    assert.equal(merged.tasks.length, 6);
    assert.deepEqual(
      merged.tasks.find((task) => task.id === tasks[2].id).rules,
      ["row-rule"],
    );

    // A new row made inside the copy on the internal site arrives as one row.
    const added = randomUUID();
    await edit(inside, [
      {
        kind: "create",
        taskId: added,
        at: new Date().toISOString(),
        fields: { title: "Added inside" },
      },
    ]);
    await f.settle();
    merged = plain(await same());
    assert.equal(merged.tasks.length, 7);
    assert.equal(
      merged.tasks.find((task) => task.id === added).title,
      "Added inside",
    );

    // A copy made externally under protocol 5 is written as records at once.
    const second = ok(
      await outside("/sheet-clones", {
        teamId,
        year: 2026,
        name: "Second",
        referenceDate: "2026-10-27",
        sourceId: sheetClone.id,
        taskIds: [],
        view: defaultView(2026),
      }),
    );
    await f.settle();
    assert.equal(
      ok(await inside("/sheet-clones/" + second.id)).tasks.length,
      7,
    );
    assert.deepEqual((await siteRows()).sheetCloneTask, 14);

    // Deleting a copy deletes every record of it on both sites.
    ok(
      await outside(
        "/sheet-clones",
        { teamId, ids: [sheetClone.id] },
        "DELETE",
      ),
    );
    await f.settle();
    assert.equal((await inside(path)).status, 404);
    assert.equal((await outside(path)).status, 404);
    assert.deepEqual(await siteRows(), {
      sheetClone: 1,
      sheetCloneFormat: 2,
      sheetCloneTask: 7,
    });
    assert.equal(
      stateHash(f.internalStore().readState()),
      stateHash(await f.pgStore.readState(teamId)),
    );
  },
);
