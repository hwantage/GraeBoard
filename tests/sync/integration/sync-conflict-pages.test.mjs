import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bridgeFixture,
  bridgePgBin,
  ok,
} from "../../support/worker-bridge-fixture.mjs";

test(
  "conflict pages on SQLite and PostgreSQL filter and limit before reading large payloads",
  {
    skip: !existsSync(join(bridgePgBin, "initdb")),
    timeout: 120000,
  },
  async (t) => {
    const f = await bridgeFixture(t, { port: 55449 });
    const pgQuery = (sql, args) =>
      f.pgStore.withTeamTransaction(f.teamId, (tx) => tx.query(sql, args));
    const marker = "conflict-page-large-value-";
    const value = marker.repeat(3000);
    const rows = Array.from({ length: 76 }, (_, i) => {
      const id = `page-${String(i).padStart(3, "0")}`;
      const key = [id, "title"];
      const resolution = i % 2 ? "resolution-" + id : null;
      const payload = JSON.stringify({
        conflictId: id,
        opId: id,
        reason: "Concurrent field change",
        resolution,
        operation: {
          opId: id,
          createdAt: "2026-11-15T00:00:00.000Z",
          changes: [
            {
              entity: "cell",
              key,
              base: { payload: { value } },
              desired: { value },
            },
          ],
        },
        current: {
          [JSON.stringify(["cell", key])]: {
            entity: "cell",
            key,
            version: "winner:0",
            generation: "g",
            deleted: false,
            payload: { value },
          },
        },
      });
      return { id, payload, resolution };
    });
    for (const row of rows) {
      f.db
        .prepare(
          "INSERT INTO sync_conflicts(team_id,conflict_id,op_id,payload,resolution) VALUES(?,?,?,?,?)",
        )
        .run(f.teamId, row.id, row.id, row.payload, row.resolution);
      await pgQuery(
        "INSERT INTO sync_conflicts(team_id,conflict_id,op_id,payload,resolution) VALUES($1,$2,$2,$3,$4)",
        [f.teamId, row.id, row.payload, row.resolution],
      );
    }
    const prefix = `/teams/${f.teamId}/sync/conflicts`;
    for (const [site, api] of [
      ["internal", f.inside],
      ["external", f.outside],
    ]) {
      // Observe the application boundary: list reads must not parse any large
      // before/after image in JS, even for records on the requested page.
      const list = async (query) => {
        const parse = JSON.parse;
        let fullImages = 0;
        JSON.parse = function (text, ...args) {
          if (typeof text === "string" && text.includes(marker)) fullImages++;
          return parse.call(this, text, ...args);
        };
        let result;
        try {
          result = ok(await api(prefix + query));
        } finally {
          JSON.parse = parse;
        }
        assert.equal(
          fullImages,
          0,
          site + " list never parses full images in JS",
        );
        assert.ok(JSON.stringify(result).length < 20000);
        return result;
      };
      for (const status of ["open", "resolved", "all"]) {
        let after = "",
          seen = [];
        do {
          const result = await list(
            `?status=${status}&after=${encodeURIComponent(after)}`,
          );
          assert.ok(result.conflicts.length <= 20);
          assert.ok(
            result.conflicts.every(
              (c) => !("base" in c) && !("current" in c) && !("desired" in c),
            ),
          );
          seen.push(...result.conflicts.map((c) => c.conflictId));
          after = result.next;
        } while (after);
        assert.deepEqual(
          seen,
          rows
            .filter(
              (r) =>
                status === "all" || !!r.resolution === (status === "resolved"),
            )
            .map((r) => r.id),
          site + " " + status,
        );
        assert.equal(new Set(seen).size, seen.length);
      }
      const defaultPage = await list("");
      assert.equal(defaultPage.conflicts.length, 20);
      assert.equal(defaultPage.next, rows[19].id);
      assert.equal((await api(prefix + "?status=invalid")).status, 400);
      assert.equal(
        (await api(prefix + "?after=" + "x".repeat(257))).status,
        400,
      );
      const detail = ok(await api(prefix + "/" + rows[1].id));
      assert.equal(detail.resolved, true);
      assert.equal(detail.desired[0].value, value);
      // An unread page and the other tab deliberately contain invalid JSON.
      // If the query parses them before applying its filters/limit it fails.
      const insert = async (id, resolution) => {
        if (site === "internal")
          f.db
            .prepare("INSERT INTO sync_conflicts VALUES(?,?,?,?,?)")
            .run(f.teamId, id, id, "unread payload", resolution);
        else
          await pgQuery("INSERT INTO sync_conflicts VALUES($1,$2,$2,$3,$4)", [
            f.teamId,
            id,
            "unread payload",
            resolution,
          ]);
      };
      const remove = async (id) => {
        if (site === "internal")
          f.db
            .prepare(
              "DELETE FROM sync_conflicts WHERE team_id=? AND conflict_id=?",
            )
            .run(f.teamId, id);
        else
          await pgQuery(
            "DELETE FROM sync_conflicts WHERE team_id=$1 AND conflict_id=$2",
            [f.teamId, id],
          );
      };
      await insert("zz-unread-page", null);
      await list("?status=open");
      await insert("00-other-tab", null);
      await list("?status=resolved");
      await remove("00-other-tab");
      await remove("zz-unread-page");
    }
  },
);
