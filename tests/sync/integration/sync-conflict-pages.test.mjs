import { rebuildConflictSummaries } from "../../../shared/sync/sync-conflict-summaries.mjs";
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
    // The internal site reads peer authors from its Git clone: exactly the
    // operations of the conflicts it returns, in either tab, and no others.
    const sync = f.app.locals.sync,
      readAuthors = sync.readOperationAuthors;
    let authorLookups = [];
    sync.readOperationAuthors = (teamId, opIds) => {
      authorLookups.push(opIds);
      return readAuthors(teamId, opIds);
    };
    t.after(() => {
      sync.readOperationAuthors = readAuthors;
    });
    const expectAuthorLookup = (site, conflicts) => {
      if (site === "internal") {
        assert.equal(authorLookups.length, 1);
        assert.deepEqual(
          [...authorLookups[0]].sort(),
          conflicts.length
            ? [...conflicts.map((c) => c.opId), "winner"].sort()
            : [],
          "internal authors are read for this response's conflicts only",
        );
      } else assert.deepEqual(authorLookups, []);
      authorLookups = [];
    };
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
        authorLookups = [];
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
        expectAuthorLookup(site, result.conflicts);
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
      authorLookups = [];
      const detail = ok(await api(prefix + "/" + rows[1].id));
      assert.equal(detail.resolved, true);
      expectAuthorLookup(site, [detail]);
      assert.equal(detail.desired[0].value, value);
      const { base, current, desired, ...summary } = detail;
      assert.deepEqual(defaultPage.conflicts[1], summary);
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

    // Production had 38 open conflicts of about 9 MB each. A count-only
    // page parsed about 186 MB in PostgreSQL and hit its statement timeout.
    // Keep oversized records intact, but leave later records to More.
    const largeValue = "large-copy-conflict-".repeat(170000);
    const largeRows = ["zz-large-a", "zz-large-b"].map((id) => {
      const payload = JSON.parse(rows[0].payload);
      payload.conflictId = payload.opId = payload.operation.opId = id;
      payload.operation.changes[0].base.payload.value = largeValue;
      payload.operation.changes[0].desired.value = largeValue;
      Object.values(payload.current)[0].payload.value = largeValue;
      return { id, payload: JSON.stringify(payload) };
    });
    for (const { id, payload } of largeRows)
      await pgQuery("INSERT INTO sync_conflicts VALUES($1,$2,$2,$3,NULL)", [
        f.teamId,
        id,
        payload,
      ]);
    // A malformed later payload makes accidental parsing of the next page
    // fail deterministically, independent of the test machine's speed.
    await pgQuery("INSERT INTO sync_conflicts VALUES($1,$2,$2,$3,NULL)", [
      f.teamId,
      "zz-large-c",
      "unread payload",
    ]);
    const first = ok(await f.outside(prefix + "?status=open&after=page-074"));
    assert.deepEqual(
      first.conflicts.map((c) => c.conflictId),
      [largeRows[0].id],
    );
    assert.equal(first.next, largeRows[0].id);
    const second = ok(
      await f.outside(prefix + "?status=open&after=" + first.next),
    );
    assert.deepEqual(
      second.conflicts.map((c) => c.conflictId),
      [largeRows[1].id],
    );
    assert.equal(second.next, largeRows[1].id);
    await pgQuery(
      "DELETE FROM sync_conflicts WHERE team_id=$1 AND conflict_id=$2",
      [f.teamId, "zz-large-c"],
    );
    const last = ok(
      await f.outside(prefix + "?status=open&after=" + first.next),
    );
    assert.deepEqual(
      last.conflicts.map((c) => c.conflictId),
      [largeRows[1].id],
    );
    assert.equal(last.next, null);
    const detail = ok(await f.outside(prefix + "/" + largeRows[0].id));
    assert.equal(detail.desired[0].value, largeValue);
    const { base, current, desired, ...summary } = detail;
    assert.deepEqual(first.conflicts[0], summary);

    // Several individually small records also fill the byte budget. Use
    // multibyte text so counting characters instead of bytes would miss it.
    const mediumValue = "가".repeat(350000);
    const mediumIds = ["zz-medium-a", "zz-medium-b", "zz-medium-c"];
    for (const id of mediumIds) {
      const payload = JSON.parse(rows[0].payload);
      payload.conflictId = payload.opId = payload.operation.opId = id;
      payload.operation.changes[0].base.payload.value = mediumValue;
      payload.operation.changes[0].desired.value = mediumValue;
      Object.values(payload.current)[0].payload.value = mediumValue;
      await pgQuery("INSERT INTO sync_conflicts VALUES($1,$2,$2,$3,NULL)", [
        f.teamId,
        id,
        JSON.stringify(payload),
      ]);
    }
    const mediumPage = ok(
      await f.outside(prefix + "?status=open&after=" + largeRows[1].id),
    );
    assert.deepEqual(
      mediumPage.conflicts.map((c) => c.conflictId),
      mediumIds.slice(0, 2),
    );
    assert.equal(mediumPage.next, mediumIds[1]);
    const mediumLast = ok(
      await f.outside(prefix + "?status=open&after=" + mediumPage.next),
    );
    assert.deepEqual(
      mediumLast.conflicts.map((c) => c.conflictId),
      [mediumIds[2]],
    );
    assert.equal(mediumLast.next, null);

    // Saving a resolution adds a large outbox row to the subsequent list and
    // detail paths. Preserve its saved choice, author and original values.
    const resolution = {
      opId: "winner",
      actorRef: "resolution-author",
      createdAt: "2026-11-16T00:00:00.000Z",
      resolves: [largeRows[0].id],
      changes: JSON.parse(largeRows[0].payload).operation.changes.map(
        (change) => ({ ...change, base: { value: largeValue } }),
      ),
    };
    await pgQuery(
      "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES($1,$2,$3,'pending',$4)",
      [
        resolution.opId,
        f.teamId,
        JSON.stringify(resolution),
        resolution.createdAt,
      ],
    );
    const saved = ok(await f.outside(prefix + "?status=open&after=page-074"))
      .conflicts[0];
    assert.deepEqual(saved.pendingResolution, {
      opId: resolution.opId,
      createdAt: resolution.createdAt,
      choice: "submitted",
    });
    const savedDetail = ok(await f.outside(prefix + "/" + largeRows[0].id));
    assert.deepEqual(savedDetail.pendingResolution, saved.pendingResolution);
    assert.equal(savedDetail.desired[0].value, largeValue);
    assert.equal(
      ok(await f.outside(prefix + "?status=open&after=" + largeRows[0].id))
        .conflicts[0].pendingResolution,
      null,
    );

    await f.pgStore.withTeamTransaction(f.teamId, (tx) =>
      rebuildConflictSummaries(tx, f.teamId),
    );
    const parse = JSON.parse;
    let originalsParsed = 0;
    JSON.parse = function (text, ...args) {
      if (
        typeof text === "string" &&
        (text.includes(marker) ||
          text.includes("large-copy-conflict-") ||
          text.includes(mediumValue.slice(0, 100)))
      )
        originalsParsed++;
      return parse.call(this, text, ...args);
    };
    let cachedPage;
    try {
      cachedPage = ok(await f.outside(prefix + "?status=open&after=page-074"));
      const open = ok(await f.outside(prefix + "?status=open"));
      assert.equal(open.conflicts.length, 20);
    } finally {
      JSON.parse = parse;
    }
    assert.equal(
      originalsParsed,
      0,
      "v4 lists and pending resolution labels never parse original values",
    );
    assert.deepEqual(
      cachedPage.conflicts.map((c) => c.conflictId),
      [...largeRows.map((r) => r.id), ...mediumIds],
    );
    assert.equal(
      cachedPage.next,
      null,
      "large source size no longer reduces the list to one item",
    );
    assert.deepEqual(cachedPage.conflicts[0], saved);
    assert.deepEqual(
      ok(await f.outside(prefix + "/" + largeRows[0].id)),
      savedDetail,
    );
  },
);
