import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { openDatabase, id, now, json } from "../server/db.mjs";
import { createTaskCache } from "../server/task-cache.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";

function fixture() {
  const db = openDatabase(":memory:"),
    team = id(),
    user = id(),
    task = id();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    team,
    "캐시 검증",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
  ).run(user, "cache-test", "검증 계정", "unused", "admin", now());
  db.prepare("INSERT INTO memberships(user_id,team_id) VALUES(?,?)").run(
    user,
    team,
  );
  db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).run(task, team, "[2026]", 1, user, now(), now());
  db.prepare("INSERT INTO cells VALUES(?,?,?,?,?)").run(
    task,
    "title",
    json("한글 일정 검증 ".repeat(800)),
    "{}",
    1,
  );
  return { db, team, user, task };
}

test("캐시 한도를 넘는 원문은 압축본으로 재사용하고 비압축 응답도 보존한다", () => {
  const { db, team, task } = fixture();
  try {
    const cache = createTaskCache(db, { limit: 2048 });
    const first = cache(team, 2026, false);
    assert(first.body.length > 2048);
    assert(first.size <= 2048, "보관하는 캐시 크기는 한도 이하여야 한다");
    assert.deepEqual(first.body, gunzipSync(first.gzip));
    const second = cache(team, 2026, false);
    assert.strictEqual(
      first,
      second,
      "같은 버전은 재조회·재압축하지 않아야 한다",
    );
    db.prepare(
      "UPDATE cells SET value=?,version=version+1 WHERE task_id=? AND key='title'",
    ).run(json("수정 후"), task);
    const updated = cache(team, 2026, false);
    assert.notEqual(updated.etag, first.etag);
    assert.equal(
      JSON.parse(updated.body).tasks[0].cells.title.value,
      "수정 후",
    );
    cache.clearTeam(team);
    assert.notStrictEqual(cache(team, 2026, false), updated);
  } finally {
    db.close();
  }
});

test("압축 캐시를 포함해 여러 항목의 합계 한도를 적용한다", () => {
  const { db, team } = fixture();
  try {
    // Each empty-year response fits; their combined size exceeds this budget.
    const probe = createTaskCache(db);
    const entrySize = probe(team, 2025, false).size;
    const cache = createTaskCache(db, { limit: entrySize + 8 });
    const first = cache(team, 2025, false);
    assert.strictEqual(cache(team, 2025, false), first);
    cache(team, 2024, false);
    assert.notStrictEqual(cache(team, 2025, false), first);
  } finally {
    db.close();
  }
});

test("캐시가 비어 있어도 같은 ETag 조회는 업무 전체를 읽지 않고 304를 반환한다", async () => {
  const { db, team, user } = fixture();
  const token = "local-cache-test-session";
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    user,
    Date.now() + 60000,
  );
  const version = db
    .prepare("SELECT version FROM team_revisions WHERE team_id=?")
    .get(team).version;
  let fullReads = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("SELECT * FROM tasks WHERE team_id=")) fullReads++;
    return prepare(sql);
  };
  const server = createApp({ db }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/tasks?teamId=${team}&year=2026`,
      {
        headers: {
          Cookie: `weekly_session=${token}`,
          "If-None-Match": `"${team}:2026:0:${version}"`,
        },
      },
    );
    assert.equal(response.status, 304);
    assert.equal(fullReads, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
  }
});
