import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFormatting } from "../../../server/db.mjs";
import { entityId } from "../../../server/sync/core/protocol.mjs";
import {
  bridgeFixture,
  bridgePgBin,
  ok,
} from "../../support/worker-bridge-fixture.mjs";

const FORMATS = entityId("formats", []);
// Rules as their content: the order a site keeps them in is not compared.
const byId = (rules) =>
  Object.fromEntries(
    rules.map(({ id, rows, keys, excludeKeys, style, orders }) => [
      id,
      { rows, keys, excludeKeys: excludeKeys || [], style, orders },
    ]),
  );

test(
  "original formats: rules kept in another order do not block one user's successive edits; a concurrent change stays a conflict and its submitted rule replaces the same-scope rule",
  { skip: !existsSync(join(bridgePgBin, "initdb")), timeout: 240000 },
  async (t) => {
    const f = await bridgeFixture(t, { port: 55448 }),
      { teamId, db, inside, outside } = f;
    const tasks = [];
    for (let i = 0; i < 10; i++)
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
    // One formatting command of a site, as its sheet sends it.
    const format = async (site, taskId, style) => {
      const list = ok(await site(`/tasks?teamId=${teamId}&year=2026`)),
        task = list.tasks.find((item) => item.id === taskId);
      return ok(
        await site("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [],
          format: {
            teamId,
            expectedRevision: task.formatting?.revision ?? 0,
            scopes: [{ rows: [taskId], keys: ["title"], style }],
            expectedTasks: { [taskId]: task.updatedAt },
          },
        }),
      );
    };
    const shared = () => f.internalStore().readState(),
      sharedRules = () => shared().entities[FORMATS]?.payload.rules || [],
      localRules = () => readFormatting(db, teamId).rules,
      externalRules = async () =>
        JSON.parse(
          (
            await f.team.query(
              "SELECT payload FROM graeboard.site_entities WHERE team_id=$1 AND entity='formats' AND deleted=0",
              [teamId],
            )
          ).rows[0].payload,
        ).rules,
      conflicts = async (site) =>
        ok(await site(`/teams/${teamId}/sync/conflicts`)).conflicts,
      assertSitesAgree = async () => {
        assert.deepEqual(byId(await externalRules()), byId(localRules()));
        assert.deepEqual(byId(sharedRules()), byId(localRules()));
      };

    // The external site appends each new rule, so the shared list soon has
    // an order that is not the internal site's ID order.
    let next = 0;
    while (
      next < 6 &&
      (next < 2 ||
        sharedRules()
          .map((rule) => rule.id)
          .join() ===
          localRules()
            .map((rule) => rule.id)
            .join())
    ) {
      await format(outside, tasks[next++].id, { backgroundColor: "#ffe8a3" });
      await f.settle();
    }
    assert.notEqual(
      sharedRules()
        .map((rule) => rule.id)
        .join(),
      localRules()
        .map((rule) => rule.id)
        .join(),
      "the internal site holds the shared rules in another order",
    );
    await assertSitesAgree();

    // One internal user formats twice before the site publishes: the second
    // edit's base is the first edit, still pending.
    await format(inside, tasks[next++].id, { bold: true });
    await format(inside, tasks[0].id, { backgroundColor: "#c9f0d8" });
    const pending = f.internalStore().readPending();
    assert.equal(pending.length, 2);
    await f.settle();
    for (const operation of pending)
      assert.equal(
        shared().receipts[operation.opId]?.result,
        "applied",
        JSON.stringify(shared().receipts[operation.opId]),
      );
    assert.deepEqual(await conflicts(inside), []);
    assert.deepEqual(await conflicts(outside), []);
    await assertSitesAgree();
    assert.equal(
      localRules().find((rule) => rule.rows[0] === tasks[0].id).style
        .backgroundColor,
      "#c9f0d8",
    );

    // After receiving another external rule, the next internal edit applies.
    await format(outside, tasks[next++].id, { italic: true });
    await f.settle();
    const received = await format(inside, tasks[next++].id, {
      underline: true,
    });
    assert.ok(received.formatOperation);
    const [afterReceive] = f.internalStore().readPending();
    await f.settle();
    assert.equal(shared().receipts[afterReceive.opId]?.result, "applied");
    assert.deepEqual(await conflicts(inside), []);
    await assertSitesAgree();

    // A real concurrent change to the same scope: each site adds its own rule
    // (another ID, another value). It stays a conflict, and the received rule
    // replaces the internal one on the internal site.
    const contested = tasks[next++].id;
    await format(inside, contested, { color: "#2255aa" });
    const [submitted] = f.internalStore().readPending();
    const internalRule = localRules().find(
      (rule) => rule.rows[0] === contested,
    );
    await format(outside, contested, { color: "#aa3322" });
    await f.drain();
    await f.settle();
    const [conflict] = await conflicts(inside);
    assert.ok(conflict, "the concurrent formats change is a conflict");
    assert.equal(conflict.opId, submitted.opId);
    assert.equal(conflict.result, "Concurrent field change");
    assert.equal(conflict.resolved, false);
    assert.equal((await conflicts(outside)).length, 1);
    const externalRule = localRules().find(
      (rule) => rule.rows[0] === contested,
    );
    assert.notEqual(externalRule.id, internalRule.id);
    assert.equal(externalRule.style.color, "#aa3322");
    assert.equal(
      localRules().filter((rule) => rule.id === internalRule.id).length,
      0,
    );
    await assertSitesAgree();

    // A failed write rolls the whole resolution back; it can be retried.
    const resolve = () =>
      inside(`/teams/${teamId}/sync/conflicts/${conflict.conflictId}/resolve`, {
        expectedHead: conflict.expectedHead,
        choice: "submitted",
      });
    const before = {
      rules: localRules(),
      revision: readFormatting(db, teamId).revision,
    };
    db.exec(
      `CREATE TEMP TRIGGER fail_format_resolution BEFORE INSERT ON format_rules WHEN NEW.id='${internalRule.id}' BEGIN SELECT RAISE(ABORT,'injected format write failure'); END`,
    );
    const failed = await resolve();
    db.exec("DROP TRIGGER temp.fail_format_resolution");
    assert.equal(failed.status, 500, JSON.stringify(failed));
    assert.deepEqual(localRules(), before.rules);
    assert.equal(readFormatting(db, teamId).revision, before.revision);
    assert.deepEqual(f.internalStore().readPending(), []);
    assert.equal((await conflicts(inside))[0].resolved, false);

    const resolved = ok(await resolve());
    const [resolution] = f.internalStore().readPending();
    assert.equal(resolution.opId, resolved.opId);
    assert.deepEqual(resolution.resolves, [conflict.opId]);
    // The submitted list, with its rule and priority, replaces the received one.
    const desired = submitted.changes.find(
      (change) => change.entity === "formats",
    ).desired.rules;
    assert.deepEqual(byId(localRules()), byId(desired));
    const replaced = localRules().find((rule) => rule.rows[0] === contested);
    assert.equal(replaced.id, internalRule.id);
    assert.deepEqual(replaced.orders, internalRule.orders);
    assert.equal(replaced.style.color, "#2255aa");
    await f.settle();
    assert.equal(shared().receipts[resolved.opId]?.result, "applied");
    assert.ok(shared().conflicts[conflict.conflictId].resolution);
    for (const site of [inside, outside]) {
      const [entry, ...rest] = await conflicts(site);
      assert.equal(entry.resolved, true);
      assert.deepEqual(rest, []);
    }
    await assertSitesAgree();
    assert.equal(
      (await externalRules()).find((rule) => rule.rows[0] === contested).id,
      internalRule.id,
    );
  },
);
