import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SLIDE_STORE_FILE,
  SqliteSlideFileRepository,
  migrateSlideStore,
  slideStoreChecksums,
} from "../../server/storage/slides/sqlite-slide-files.mjs";
import {
  SLIDE_BRANCH,
  syncSlideFiles,
} from "../../server/sync/core/slide-file-branch.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// The release before slides (see slide-file-external-contract.test.mjs).
const RELEASE_BEFORE_SLIDES = "37a87022774864653647192213633b7f71d166a9";
import {
  settle,
  slide,
  slideSyncContract,
  twoPeers,
} from "../support/slide-sync-fixture.mjs";

const sqliteStores = (t, directory) => {
  const stores = {
    internal: new SqliteSlideFileRepository({
      directory: join(directory, "internal-store"),
    }),
    external: new SqliteSlideFileRepository({
      directory: join(directory, "external-store"),
    }),
  };
  t.after(() => Object.values(stores).forEach((store) => store.close()));
  return stores;
};
slideSyncContract("사내 저장소끼리", sqliteStores);

test("복원한 저장소는 새 게시 세대로 시작해 이전 버전 번호를 다시 쓰지 않는다", async (t) => {
  const { inside, outside, teamId } = await twoPeers(t, sqliteStores);
  const file = await inside.create("자료", slide("처음"));
  await settle(inside, outside);
  const before = (await inside.store.syncFiles(teamId))[0].shared.version;
  await inside.save(file.id, slide("복원 전 수정"));
  await settle(inside, outside);
  const used = (await inside.store.syncFiles(teamId))[0].shared.version;
  assert.notEqual(used, before);

  // The store goes back to an earlier state, as after restoring a backup.
  inside.store.syncReset();
  assert.equal((await inside.store.syncState(teamId)).head, null);
  await inside.save(file.id, slide("복원 뒤 수정"));
  await settle(inside, outside);
  const after = (await inside.store.syncFiles(teamId))[0].shared.version;
  assert.notEqual(after.split(":")[0], used.split(":")[0], "a new epoch");
  assert.equal(
    (await outside.read(file.id)).equals(slide("복원 뒤 수정")),
    true,
  );
});

test("사내 서버는 연결이 활성인 팀만, 한 번에 한 번씩 동기화하고 실패해도 멈추지 않는다", async (t) => {
  const { inside, outside, teamId } = await twoPeers(t, sqliteStores);
  const { createSlideFileSync } =
    await import("../../server/slides/slide-file-sync.mjs");
  let mode = "paused";
  let transportReads = 0;
  const logged = [];
  const runner = createSlideFileSync({
    // Only the link lookup of the task database is used.
    db: {
      prepare: (sql) => ({
        get: () => (mode === "active" ? { 1: 1 } : undefined),
        all: () => (mode === "active" ? [{ team_id: teamId }] : []),
        sql,
      }),
    },
    sync: {
      get: () => {
        transportReads++;
        return { transport: inside.transport };
      },
    },
    repository: inside.store,
    intervalMs: 20,
    log: (...args) => logged.push(args.join(" ")),
  });
  t.after(() => runner.close());
  const file = await inside.create("자료", slide("처음"));
  // Paused, recovering or unlinked teams are left alone.
  assert.equal(await runner.run(teamId), null);
  assert.equal(transportReads, 0);

  mode = "active";
  const [first, second] = await Promise.all([
    runner.run(teamId),
    runner.run(teamId),
  ]);
  assert.equal(first, second, "one pass answers both requests");
  assert.equal(first.published, 1);
  await settle(outside);
  assert.equal((await outside.read(file.id)).equals(slide("처음")), true);

  // A change is carried by the scheduled pass without any request.
  await outside.save(file.id, slide("외부 수정"));
  await outside.sync();
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await inside.read(file.id)).equals(slide("외부 수정")), true);

  // A failing pass is logged and the next one runs normally. The timer is
  // stopped first so no scheduled pass is in flight.
  await runner.close();
  assert.equal(await runner.run(teamId), null, "closed");
  const manual = createSlideFileSync({
    db: { prepare: () => ({ get: () => ({ 1: 1 }), all: () => [] }) },
    sync: {
      get: () => {
        if (mode === "misconfigured") throw new Error("missing profile");
        return { transport: inside.transport };
      },
    },
    repository: inside.store,
    log: (...args) => logged.push(args.join(" ")),
  });
  t.after(() => manual.close());
  mode = "misconfigured";
  assert.equal(await manual.run(teamId), null);
  assert.match(logged.at(-1), /missing profile/);
  mode = "active";
  const readHead = inside.transport.readHead.bind(inside.transport);
  inside.transport.readHead = async () => {
    throw new Error("repository unreachable");
  };
  assert.equal(await manual.run(teamId), null);
  assert.match(logged.at(-1), /repository unreachable/);
  inside.transport.readHead = readHead;
  await inside.save(file.id, slide("다시 사내"));
  assert.equal((await manual.run(teamId)).published, 1);
});

test("슬라이드 도입 전 릴리스의 동기화 코드는 슬라이드 브랜치를 읽지 않고 업무 브랜치를 그대로 쓴다", async (t) => {
  const { inside, outside, remote, directory } = await twoPeers(
    t,
    sqliteStores,
  );
  await inside.create("자료", slide("처음"));
  await settle(inside, outside);

  // The actual transport of the earlier release, read from Git.
  const old = join(directory, "before-slides");
  mkdirSync(old);
  let archive;
  try {
    archive = execFileSync(
      "git",
      ["archive", RELEASE_BEFORE_SLIDES, "server", "shared", "package.json"],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    assert.fail(
      `Git commit ${RELEASE_BEFORE_SLIDES} is required: git fetch origin ${RELEASE_BEFORE_SLIDES}`,
    );
  }
  execFileSync("tar", ["-x", "-C", old], { input: archive });
  symlinkSync(join(root, "node_modules"), join(old, "node_modules"));
  const { GitCliTransport: OldTransport } = await import(
    pathToFileURL(join(old, "server/sync/node/git-cli.mjs")).href
  );
  const earlier = new OldTransport({
    directory: join(directory, "old-clone"),
    repository: remote,
    allowLocal: true,
  });
  // It addresses branches by exact name and does not know this one.
  await assert.rejects(earlier.readHead(SLIDE_BRANCH), /Invalid sync branch/);
  assert.equal(await earlier.readHead("sync-v1"), null);
  // It publishes and reads task history next to the slide branch.
  const commit = await earlier.createCandidate(
    null,
    { "manifest.json": "{}" },
    "task history",
  );
  assert.equal(await earlier.publish(commit, null, "sync-v1"), true);
  assert.equal(await inside.transport.readHead("sync-v1"), commit);
  assert.equal(
    (await earlier.readFile(commit, "manifest.json")).toString(),
    "{}",
  );
  // Slide synchronization goes on and leaves the task branch where it is.
  await outside.create("외부 자료", slide("외부"));
  await settle(outside, inside);
  assert.equal((await inside.list()).length, 2);
  assert.equal(await earlier.readHead("sync-v1"), commit);
});

test("v1 슬라이드 저장소는 명시적 변환으로만 v2가 되고 자료를 그대로 유지한다", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slide-store-v1-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, SLIDE_STORE_FILE);
  // A store exactly as the first step created it, with one file.
  const first = readFileSync(
    new URL(
      "../../server/migrations/slides/001-slide-files.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const raw = new DatabaseSync(path);
  raw.exec(first);
  raw
    .prepare("INSERT INTO schema_migrations VALUES(1,?,?)")
    .run(slideStoreChecksums[0], new Date().toISOString());
  const teamId = randomUUID();
  const id = randomUUID();
  raw
    .prepare(
      "INSERT INTO slide_files VALUES(?,?,?,1,?,?,'u','t','u','t',NULL,'request-1')",
    )
    .run(id, teamId, "v1 자료", 10, "a".repeat(64));
  raw.exec("PRAGMA user_version=1");
  raw.close();

  // The server does not convert it on start.
  assert.throws(
    () => new SqliteSlideFileRepository({ directory }),
    /npm run migrate -- --engine sqlite-slides/,
  );
  assert.deepEqual(migrateSlideStore(path, { dryRun: true }), {
    from: 1,
    to: 2,
    applied: false,
    dryRun: true,
  });
  assert.deepEqual(migrateSlideStore(path), { from: 1, to: 2, applied: true });
  assert.deepEqual(migrateSlideStore(path), { from: 2, to: 2, applied: false });
  const repository = new SqliteSlideFileRepository({ directory });
  t.after(() => repository.close());
  assert.deepEqual(
    repository.list(teamId).map((file) => [file.id, file.title, file.revision]),
    [[id, "v1 자료", 1]],
  );
  assert.equal(repository.syncFiles(teamId)[0].shared, null);
  repository.close();

  // A history this code does not know is refused, data kept.
  const changed = new DatabaseSync(path);
  changed.exec(
    "UPDATE schema_migrations SET checksum='changed' WHERE version=1",
  );
  changed.close();
  assert.throws(() => migrateSlideStore(path), /변환 이력/);
  assert.throws(
    () => migrateSlideStore(join(directory, "none.sqlite")),
    /없습니다/,
  );
});

test("슬라이드를 쓰지 않는 팀은 동기화가 돌아도 저장소를 만들지 않는다", async (t) => {
  const { inside, directory, teamId } = await twoPeers(t, sqliteStores);
  const unused = join(directory, "unused-store");
  const store = new SqliteSlideFileRepository({ directory: unused });
  t.after(() => store.close());
  const result = await syncSlideFiles({
    transport: inside.transport,
    store,
    teamId,
    site: "internal",
  });
  assert.deepEqual(
    [result.head, result.received, result.published],
    [null, 0, 0],
  );
  assert.equal(existsSync(unused), false);
  // Once the other site has published, the state is created to receive it.
  await inside.create("자료", slide("처음"));
  await inside.sync();
  assert.equal(
    (
      await syncSlideFiles({
        transport: inside.transport,
        store,
        teamId,
        site: "external",
      })
    ).received,
    1,
  );
  assert.equal(existsSync(join(unused, SLIDE_STORE_FILE)), true);
});
