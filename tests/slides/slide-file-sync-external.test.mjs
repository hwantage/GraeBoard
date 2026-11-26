import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { githubEmulator } from "../support/worker-github-fixture.mjs";
import {
  settle,
  sha,
  slide,
  slideSyncContract,
  twoPeers,
} from "../support/slide-sync-fixture.mjs";
import { SLIDE_BRANCH } from "../../server/sync/core/slide-file-branch.mjs";
import { syncTeamSlides } from "../../worker/sync/sync-slides.mjs";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";
import { GitHubApiTransport } from "../../server/sync/core/github-api.mjs";
import { SqliteSlideFileRepository } from "../../server/storage/slides/sqlite-slide-files.mjs";
import { PostgresSlideFileRepository } from "../../worker/storage/slides/postgres-slide-files.mjs";

// An R2 bucket binding kept in memory.
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    put: async (key, bytes) => void objects.set(key, Uint8Array.from(bytes)),
    get: async (key) => {
      const bytes = objects.get(key);
      return (
        bytes && { arrayBuffer: async () => Uint8Array.from(bytes).buffer }
      );
    },
    head: async (key) => (objects.has(key) ? { key } : null),
    delete: async (key) => void objects.delete(key),
  };
}

// The two real sites: the internal one keeps slides in SQLite and files and
// reaches the repository with the Git CLI; the external one keeps them in
// PostgreSQL and a bucket and reaches the same repository through the GitHub
// Git Data API (served here from that repository by the emulator).
slideSyncContract(
  "사내 SQLite와 외부 PostgreSQL",
  async (t, directory, remote) => {
    const pg = await postgresBusinessFixture(t);
    if (!pg) return null;
    await migrateSlideSchema(pg.pool);
    const internal = new SqliteSlideFileRepository({
      directory: join(directory, "internal-store"),
    });
    t.after(() => internal.close());
    const github = githubEmulator(remote);
    return {
      teamId: pg.teamId,
      internal,
      external: new PostgresSlideFileRepository({
        pool: pg.pool,
        bucket: memoryBucket(),
        teamId: pg.teamId,
      }),
      transports: {
        external: new GitHubApiTransport({
          repository: "fixture/team",
          token: "fixture-secret",
          fetch: github.fetch,
        }),
      },
    };
  },
);

test("외부 서버의 예약 실행은 연결이 활성일 때만, 한 번에 조각 4개까지 옮긴다", async (t) => {
  const pg = await postgresBusinessFixture(t);
  if (!pg) return;
  const directory = mkdtempSync(join(tmpdir(), "slide-sync-edge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const bucket = memoryBucket();
  pg.env.BUCKET = bucket;
  const profile = JSON.parse(pg.env.SYNC_PROFILES)[0];
  const transport = () =>
    new GitHubApiTransport({
      repository: "fixture/team",
      token: "fixture-secret",
      fetch: githubEmulator(remote).fetch,
    });
  const mode = (value) =>
    pg.pool.query("UPDATE graeboard.team_sync_links SET mode=$1", [value]);
  const repository = new PostgresSlideFileRepository({
    pool: pg.pool,
    bucket,
    teamId: pg.teamId,
  });
  const large = slide("large", MAX_SLIDE_FILE_BYTES);

  // No slide store yet: nothing to do, and nothing fails.
  await mode("active");
  assert.equal(
    await syncTeamSlides(pg.env, profile, { transport: transport() }),
    null,
  );
  await migrateSlideSchema(pg.pool);
  await repository.create({
    id: randomUUID(),
    teamId: pg.teamId,
    title: "큰 자료",
    bytes: large,
    contentHash: sha(large),
    requestId: randomUUID(),
    userId: pg.user.id,
    at: new Date().toISOString(),
  });
  await mode("paused");
  assert.equal(
    await syncTeamSlides(pg.env, profile, { transport: transport() }),
    null,
  );
  assert.throws(() =>
    execFileSync("git", ["-C", remote, "rev-parse", "--verify", SLIDE_BRANCH], {
      stdio: "pipe",
    }),
  );

  await mode("active");
  const chunks = () =>
    execFileSync("git", [
      "-C",
      remote,
      "ls-tree",
      "-r",
      "--name-only",
      SLIDE_BRANCH,
    ])
      .toString()
      .split("\n")
      .filter((path) => path.startsWith("chunks/")).length;
  const first = await syncTeamSlides(pg.env, profile, {
    transport: transport(),
  });
  assert.deepEqual([first.pending, first.published, chunks()], [1, 0, 4]);
  const second = await syncTeamSlides(pg.env, profile, {
    transport: transport(),
  });
  assert.deepEqual([second.pending, second.published, chunks()], [0, 1, 7]);
  // An idle pass costs one request (the branch head) and writes nothing.
  const github = githubEmulator(remote);
  const idle = await syncTeamSlides(pg.env, profile, {
    transport: new GitHubApiTransport({
      repository: "fixture/team",
      token: "fixture-secret",
      fetch: github.fetch,
    }),
  });
  assert.deepEqual([idle.published, idle.received, idle.pending], [0, 0, 0]);
  assert.deepEqual(
    github.calls.map((call) => call.path),
    [`/git/ref/heads/${SLIDE_BRANCH}`],
  );
  // While task synchronization waits out a GitHub rate limit, or another
  // executor holds its lease, slides make no request at all.
  const quiet = githubEmulator(remote);
  const quietTransport = () =>
    new GitHubApiTransport({
      repository: "fixture/team",
      token: "fixture-secret",
      fetch: quiet.fetch,
    });
  await pg.pool.query(
    "INSERT INTO graeboard.site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'syncRefresh','[]',$2,0,0) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload",
    [pg.teamId, JSON.stringify({ nextAt: Date.now() + 120000 })],
  );
  assert.equal(
    await syncTeamSlides(pg.env, profile, { transport: quietTransport() }),
    null,
  );
  await pg.pool.query(
    "UPDATE graeboard.site_entities SET payload='{}' WHERE entity='syncRefresh'",
  );
  await pg.pool.query(
    "UPDATE graeboard.team_sync_links SET lease_owner='other-executor',lease_until=$1",
    [Date.now() + 600000],
  );
  assert.equal(
    await syncTeamSlides(pg.env, profile, { transport: quietTransport() }),
    null,
  );
  assert.deepEqual(quiet.calls, []);
  await pg.pool.query(
    "UPDATE graeboard.team_sync_links SET lease_owner=NULL,lease_until=NULL",
  );
  // The task link was only read.
  assert.equal(
    (await pg.pool.query("SELECT mode FROM graeboard.team_sync_links")).rows[0]
      .mode,
    "active",
  );
});

// The external site pays a remote round trip for every statement, and the
// Cron runs a pass for every active team every minute: what a pass with
// nothing to do sends is counted here, at the team connection and at GitHub.
test("외부 서버의 변화 없는 예약 실행은 DB 왕복 4회와 GitHub 요청 1건으로 끝나고, 변화가 있으면 받고 게시한다", async (t) => {
  let pg, github;
  const bucket = memoryBucket();
  const peers = await twoPeers(t, async (t, directory, remote) => {
    pg = await postgresBusinessFixture(t);
    if (!pg) return null;
    await migrateSlideSchema(pg.pool);
    const internal = new SqliteSlideFileRepository({
      directory: join(directory, "internal-store"),
    });
    t.after(() => internal.close());
    github = githubEmulator(remote);
    return {
      teamId: pg.teamId,
      internal,
      external: new PostgresSlideFileRepository({
        pool: pg.pool,
        bucket,
        teamId: pg.teamId,
      }),
    };
  });
  if (!peers) return;
  const { inside, outside, teamId } = peers;
  await pg.pool.query("UPDATE graeboard.team_sync_links SET mode='active'");
  pg.env.BUCKET = bucket;
  // Every statement sent on the team connection. The hosted site's pool
  // checks a connection once, when it opens it; those checks belong to the
  // connection and not to a pass.
  const statements = [];
  pg.env.PG_TEAM.pool = {
    async connect() {
      const client = await pg.pool.connect();
      return Object.assign(Object.create(client), {
        query: (sql, params) => {
          const text = typeof sql === "string" ? sql : sql.text;
          if (!/schema_migrations/.test(text)) statements.push(text);
          return client.query(sql, params);
        },
        release: (error) => client.release(error),
      });
    },
  };
  const profile = JSON.parse(pg.env.SYNC_PROFILES)[0];
  // One scheduled pass, with what it sent.
  const pass = async () => {
    statements.length = 0;
    github.calls.length = 0;
    const result = await syncTeamSlides(pg.env, profile, {
      transport: new GitHubApiTransport({
        repository: "fixture/team",
        token: "fixture-secret",
        fetch: github.fetch,
      }),
    });
    return {
      result,
      // The transaction that opens with the two gates, then the slide store.
      database: statements.map((sql) => /^\w+/.exec(sql.trim())[0]),
      lists: statements.filter((sql) => /FULL JOIN/.test(sql)),
      github: github.calls.map((call) => `${call.method} ${call.path}`),
    };
  };
  const head = `GET /git/ref/heads/${SLIDE_BRANCH}`;
  const rows = async (table) =>
    Number(
      (
        await pg.pool.query(
          `SELECT count(*) AS n FROM graeboard_slides.${table}`,
        )
      ).rows[0].n,
    );

  // A team that has never used slides: no state is created for it.
  const unused = await pass();
  assert.deepEqual(unused.result, {
    head: null,
    received: 0,
    published: 0,
    conflicts: 0,
    pending: 0,
    raced: false,
  });
  assert.deepEqual(unused.database, ["BEGIN", "COMMIT", "SELECT"]);
  assert.deepEqual(unused.github, [head]);
  assert.equal(await rows("slide_sync_state"), 0);

  // The first file is published; the other site receives it.
  const file = await outside.create("외부 자료", slide("처음"));
  assert.equal((await pass()).result.published, 1);
  await settle(inside);
  assert.equal((await inside.read(file.id)).equals(slide("처음")), true);

  // Nothing to do: two round trips for the gates, the cursor and one list of
  // the files without their chunk lists. Nothing is written.
  const idle = await pass();
  assert.deepEqual(
    [idle.result.received, idle.result.published, idle.result.pending],
    [0, 0, 0],
  );
  assert.deepEqual(idle.database, ["BEGIN", "COMMIT", "SELECT", "SELECT"]);
  assert.equal(idle.lists.length, 1);
  assert.doesNotMatch(idle.lists[0], /shared_chunks/);
  assert.deepEqual(idle.github, [head]);

  // The same for more files, deleted ones included.
  const second = await outside.create("둘째 자료", slide("둘째"));
  await outside.create("셋째 자료", slide("셋째"));
  assert.equal((await pass()).result.published, 2);
  await outside.remove(second.id);
  assert.equal((await pass()).result.published, 1);
  assert.equal(await rows("slide_files"), 3);
  const more = await pass();
  assert.deepEqual(more.database, idle.database);
  assert.deepEqual(more.github, [head]);

  // A pass with work on both sides: a file from the other site arrives and
  // a rename made here, which publishes the chunk list it already shared,
  // goes out. The files are listed with their chunk lists before receiving
  // and again after it wrote them.
  await settle(inside);
  const arrived = await inside.create("사내 자료", slide("사내에서"));
  assert.equal((await inside.sync()).published, 1);
  await outside.rename(file.id, "외부에서 바꾼 이름");
  const busy = await pass();
  assert.deepEqual(
    [
      busy.result.received,
      busy.result.published,
      busy.result.conflicts,
      busy.result.pending,
      busy.result.raced,
    ],
    [1, 1, 0, 0, false],
  );
  assert.equal(busy.lists.length, 2);
  for (const list of busy.lists) assert.match(list, /shared_chunks/);
  await settle(inside);
  assert.deepEqual(await inside.list(), await outside.list());
  assert.equal(
    (await outside.read(arrived.id)).equals(slide("사내에서")),
    true,
  );
  assert.equal(
    (await inside.store.get(teamId, file.id)).title,
    "외부에서 바꾼 이름",
  );
  assert.equal((await inside.read(file.id)).equals(slide("처음")), true);
  assert.deepEqual((await pass()).database, idle.database);
});
