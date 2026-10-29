import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqliteFixture } from "./business-storage-fixture.mjs";
import {
  retentionView,
  withRetentionViews,
} from "../server/sync/visibility.mjs";
import { parseCompact } from "../shared/compact.js";
import { getTasks } from "../server/db.mjs";

function exclusion(f, year, revision = 1) {
  f.db
    .prepare("INSERT INTO site_retention VALUES(?,?, 'year',?,'',?,?)")
    .run(
      f.teamId,
      f.link.installation_id,
      JSON.stringify([String(year)]),
      revision,
      new Date().toISOString(),
    );
}
function recordQueries(db) {
  const prepare = db.prepare,
    queries = [];
  db.prepare = function (sql) {
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) queries.push(sql);
    return prepare.call(this, sql);
  };
  return {
    queries,
    close() {
      db.prepare = prepare;
    },
  };
}

test("C6 active retention uses a fixed set of metadata reads for hundreds of tasks and caches filtered compressed payloads", (t) => {
  const f = sqliteFixture(t),
    stamp = new Date().toISOString();
  const insert = f.db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?, '[2026]',?,?,?,?)",
  );
  for (let index = 0; index < 300; index++)
    insert.run(randomUUID(), f.teamId, index + 2, f.user.id, stamp, stamp);
  exclusion(f, 2025);
  const tasks = getTasks(f.db, f.teamId, [2026]);
  const trace = recordQueries(f.db);
  try {
    const view = retentionView(f.db, f.teamId);
    assert.equal(view.tasks(tasks).length, 301);
    assert.ok(trace.queries.length <= 4, trace.queries.join("\n"));
    assert.equal(
      trace.queries.filter((sql) => /FROM task_documents/.test(sql)).length,
      1,
    );
    const query = {
      teamId: f.teamId,
      year: 2026,
      startMonth: 1,
      deleted: false,
    };
    const first = f.app.locals.taskRepository.query(f.user, query);
    assert.equal(parseCompact(first.encoded.body).tasks.length, 301);
    trace.queries.length = 0;
    const second = f.app.locals.taskRepository.query(f.user, query);
    assert.strictEqual(
      second.encoded,
      first.encoded,
      "filtered body and gzip are reused",
    );
    assert.ok(
      !trace.queries.some((sql) =>
        /FROM (?:tasks|task_documents|cells)\b/.test(sql),
      ),
      trace.queries.join("\n"),
    );
    exclusion(f, 2026); // Same numeric max revision, different exclusion set.
    const hidden = f.app.locals.taskRepository.query(f.user, {
      ...query,
      ifNoneMatch: first.etag,
    });
    assert.notEqual(hidden.etag, first.etag);
    assert.equal(parseCompact(hidden.encoded.body).tasks.length, 0);
    f.db
      .prepare("DELETE FROM site_retention WHERE team_id=? AND entity_key=?")
      .run(f.teamId, '["2026"]');
    const restored = f.app.locals.taskRepository.query(f.user, {
      ...query,
      ifNoneMatch: hidden.etag,
    });
    assert.equal(parseCompact(restored.encoded.body).tasks.length, 301);
  } finally {
    trace.close();
  }
});

test("B9/D5 repositories share one request overlay and invalidate it after a same-request write", (t) => {
  const f = sqliteFixture(t);
  exclusion(f, 2025);
  const trace = recordQueries(f.db);
  try {
    withRetentionViews(() => {
      const initial = retentionView(f.db, f.teamId);
      for (let index = 0; index < 20; index++)
        assert.strictEqual(retentionView(f.db, f.teamId), initial);
      assert.equal(
        trace.queries.filter((sql) => /SELECT \* FROM site_retention/.test(sql))
          .length,
        1,
      );
      exclusion(f, 2026);
      const changed = retentionView(f.db, f.teamId);
      assert.notStrictEqual(changed, initial);
      assert.equal(changed.hidden("task", [f.taskId]), true);
    });
    assert.equal(
      retentionView(f.db, f.teamId).hidden("task", [f.taskId]),
      true,
    );
  } finally {
    trace.close();
  }
});
