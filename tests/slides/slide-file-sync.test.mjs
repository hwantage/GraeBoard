import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCliTransport } from "../../server/sync/node/git-cli.mjs";
import { SqliteSlideFileRepository } from "../../server/storage/slides/sqlite-slide-files.mjs";
import {
  SLIDE_BRANCH,
  SLIDE_CHUNK_BYTES,
  slideChunks,
  slideConflictCopyId,
  syncSlideFiles,
} from "../../server/sync/core/slide-file-branch.mjs";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slide = (text, size = 0) => {
  const body = JSON.stringify({ version: 1, name: text, pad: "" });
  if (!size) return Buffer.from(body);
  // Not compressible, so chunks differ from each other.
  const pad = Buffer.alloc(size - body.length);
  for (let i = 0; i < pad.length; i++) pad[i] = 97 + ((i * 31 + (i >> 7)) % 26);
  return Buffer.from(body.replace('"pad":""', `"pad":"${pad.toString()}"`));
};

// Two sites with their own stores and Git clones of one bare repository.
export function twoPeers(t, makeStores) {
  const directory = mkdtempSync(join(tmpdir(), "slide-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const teamId = randomUUID();
  const peer = (site, store) => {
    const transport = new GitCliTransport({
      directory: join(directory, `${site}-clone`),
      repository: remote,
      allowLocal: true,
    });
    const put = (bytes, extra) => ({
      teamId,
      bytes,
      contentHash: sha(bytes),
      requestId: randomUUID(),
      userId: `${site}-user`,
      at: new Date().toISOString(),
      ...extra,
    });
    return {
      site,
      store,
      transport,
      sync: (limits) =>
        syncSlideFiles({ transport, store, teamId, site, limits }),
      create: (title, bytes) =>
        store.create(put(bytes, { id: randomUUID(), title })),
      save: async (fileId, bytes) => {
        const file = await store.get(teamId, fileId);
        return store.replace(
          put(bytes, { fileId, baseRevision: file.revision }),
        );
      },
      rename: (fileId, title) =>
        store.rename({
          teamId,
          fileId,
          title,
          userId: `${site}-user`,
          at: new Date().toISOString(),
        }),
      remove: (fileId) =>
        store.remove({ teamId, fileId, at: new Date().toISOString() }),
      list: async () =>
        (await store.list(teamId))
          .map((file) => `${file.title}=${file.contentHash.slice(0, 8)}`)
          .sort(),
      read: async (fileId) => {
        const stored = await store.read(teamId, fileId);
        return stored && Buffer.from(stored.bytes);
      },
    };
  };
  const stores = makeStores(t, directory, teamId);
  return {
    directory,
    remote,
    teamId,
    inside: peer("internal", stores.internal),
    outside: peer("external", stores.external),
  };
}
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
// Passes until both sites have nothing more to exchange.
export async function settle(...peers) {
  for (let round = 0; round < 12; round++) {
    let moved = 0;
    for (const peer of peers) {
      const result = await peer.sync();
      moved +=
        result.received +
        result.published +
        result.pending +
        (result.raced ? 1 : 0);
    }
    if (!moved) return;
  }
  assert.fail("the two sites did not settle");
}

export function slideSyncContract(name, makeStores) {
  test(`${name}: 만들기·저장·이름 변경·삭제가 양쪽에 같은 바이트로 전달된다`, async (t) => {
    const { inside, outside, teamId } = twoPeers(t, makeStores);
    const first = slide("사내에서 만든 자료");
    const file = await inside.create("주간회의", first);
    assert.deepEqual(await inside.sync(), {
      head: (await inside.store.syncState(teamId)).head,
      received: 0,
      published: 1,
      conflicts: 0,
      pending: 0,
      raced: false,
    });
    await settle(outside, inside);
    assert.deepEqual(await outside.list(), await inside.list());
    assert.equal((await outside.read(file.id)).equals(first), true);
    assert.equal((await outside.store.get(teamId, file.id)).revision, 1);

    // The other direction, and a file made there.
    const second = slide("외부에서 고친 내용");
    await outside.save(file.id, second);
    const other = await outside.create(
      "외부 자료",
      slide("외부에서 만든 자료"),
    );
    await settle(outside, inside);
    assert.equal((await inside.read(file.id)).equals(second), true);
    // The local revision moved, so an editor that opened revision 1 is refused.
    assert.equal((await inside.store.get(teamId, file.id)).revision, 2);
    assert.equal(
      (await inside.read(other.id)).equals(slide("외부에서 만든 자료")),
      true,
    );

    await inside.rename(file.id, "주간회의 (11월)");
    await outside.remove(other.id);
    await settle(inside, outside);
    assert.deepEqual(await outside.list(), await inside.list());
    assert.deepEqual(await inside.list(), [
      `주간회의 (11월)=${sha(second).slice(0, 8)}`,
    ]);
    // A rename does not create a revision on either side.
    assert.equal((await outside.store.get(teamId, file.id)).revision, 2);

    // Nothing left to do: repeated passes change nothing.
    const head = (await inside.store.syncState(teamId)).head;
    for (const peer of [inside, outside]) {
      const idle = await peer.sync();
      assert.deepEqual(
        [idle.received, idle.published, idle.pending, idle.head],
        [0, 0, 0, head],
      );
    }
  });

  test(`${name}: 25MiB 자료는 4MiB 조각으로 나뉘어 중단 뒤 이어서 전달되고, 다 받기 전에는 보이지 않는다`, async (t) => {
    const { inside, outside, teamId, remote } = twoPeers(t, makeStores);
    const large = slide("large", MAX_SLIDE_FILE_BYTES);
    assert.equal(slideChunks(large).length, 7);
    assert.equal(SLIDE_CHUNK_BYTES, 4 * 1024 * 1024);
    const file = await inside.create("큰 자료", large);
    const small = await inside.create("작은 자료", slide("작은 자료"));

    // Three chunks per pass: the upload takes several passes, and the
    // metadata that makes the file visible is committed last.
    const paths = () =>
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
        .filter(Boolean);
    const firstPass = await inside.sync({ chunks: 3, files: 50 });
    assert.equal(firstPass.pending, 1);
    assert.equal(
      paths().filter((path) => path.startsWith("chunks/")).length,
      3,
    );
    assert.equal(paths().includes(`files/${file.id}.json`), false);
    // The small file is not held back by the large one.
    assert.equal(paths().includes(`files/${small.id}.json`), true);
    await outside.sync({ chunks: 3, files: 50 });
    assert.deepEqual(await outside.list(), [
      `작은 자료=${sha(slide("작은 자료")).slice(0, 8)}`,
    ]);

    await inside.sync({ chunks: 3, files: 50 });
    assert.equal((await inside.sync({ chunks: 3, files: 50 })).published, 1);
    assert.equal(
      paths().filter((path) => path.startsWith("chunks/")).length,
      8,
    );

    // The download is interrupted twice; the head does not move and the file
    // is not listed until every chunk is verified and the bytes are stored.
    const before = (await outside.store.syncState(teamId)).head;
    for (let pass = 0; pass < 2; pass++) {
      const partial = await outside.sync({ chunks: 3, files: 50 });
      assert.equal(partial.pending, 1);
      assert.equal((await outside.store.syncState(teamId)).head, before);
      assert.equal((await outside.list()).length, 1);
    }
    const done = await outside.sync({ chunks: 3, files: 50 });
    assert.deepEqual([done.received, done.pending], [1, 0]);
    assert.equal(sha(await outside.read(file.id)), sha(large));
    assert.equal((await outside.read(file.id)).byteLength, 25 * 1024 * 1024);

    // And back: an edit of the large file made on the other site.
    const edited = Buffer.from(large);
    edited[edited.length - 3] = 66;
    await outside.save(file.id, edited);
    await settle(outside, inside);
    assert.equal(sha(await inside.read(file.id)), sha(edited));
    // Six of the seven chunks are the same content and were not sent again.
    assert.equal(
      paths().filter((path) => path.startsWith("chunks/")).length,
      9,
    );
  });

  test(`${name}: 양쪽이 같은 자료를 고치면 먼저 게시된 쪽이 원본으로 남고 늦은 쪽은 사본으로 보존된다`, async (t) => {
    const { inside, outside, teamId } = twoPeers(t, makeStores);
    const file = await inside.create("회의 자료", slide("처음"));
    await settle(inside, outside);

    const fromInside = slide("사내에서 고침");
    const fromOutside = slide("외부에서 고침");
    await inside.save(file.id, fromInside);
    await outside.save(file.id, fromOutside);
    // The internal site publishes first.
    assert.equal((await inside.sync()).published, 1);
    const late = await outside.sync();
    assert.equal(late.conflicts, 1);
    const copyId = slideConflictCopyId(file.id, sha(fromOutside), "external");
    assert.equal((await outside.read(file.id)).equals(fromInside), true);
    assert.equal((await outside.read(copyId)).equals(fromOutside), true);
    assert.equal(
      (await outside.store.get(teamId, copyId)).title,
      "회의 자료 (충돌 · 외부)",
    );

    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.equal((await inside.list()).length, 2);
    assert.equal((await inside.read(copyId)).equals(fromOutside), true);
    // Seeing the same branch again creates no further copy on either side.
    await outside.store.syncSetHead(teamId, null);
    await inside.store.syncSetHead(teamId, null);
    await settle(outside, inside);
    assert.equal((await inside.list()).length, 2);
    assert.equal((await outside.list()).length, 2);
  });

  test(`${name}: 삭제와 수정이 겹치면 수정이 남고, 겹치지 않는 이름·내용 변경은 둘 다 반영된다`, async (t) => {
    const { inside, outside, teamId } = twoPeers(t, makeStores);
    const kept = await inside.create("지워질 뻔한 자료", slide("처음"));
    const renamed = await inside.create("이름과 내용", slide("처음 내용"));
    const both = await inside.create("둘 다 삭제", slide("둘 다"));
    await settle(inside, outside);

    // Deleted inside, edited outside: the edit is published first.
    await inside.remove(kept.id);
    await outside.save(kept.id, slide("외부의 수정"));
    // Renamed inside, content changed outside.
    await inside.rename(renamed.id, "새 이름");
    await outside.save(renamed.id, slide("새 내용"));
    await inside.remove(both.id);
    await outside.remove(both.id);
    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.deepEqual(
      await inside.list(),
      [
        `새 이름=${sha(slide("새 내용")).slice(0, 8)}`,
        `지워질 뻔한 자료=${sha(slide("외부의 수정")).slice(0, 8)}`,
      ].sort(),
    );

    // Edited inside, deleted outside, and this time the delete is published first.
    await inside.save(kept.id, slide("사내의 수정"));
    await outside.remove(kept.id);
    assert.equal((await outside.sync()).published, 1);
    await settle(inside, outside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.equal(
      (await outside.read(kept.id)).equals(slide("사내의 수정")),
      true,
    );
    assert.equal((await inside.store.syncFiles(teamId)).length, 3);
  });

  test(`${name}: 게시 응답을 잃거나 경합에서 지면 같은 버전으로 다시 시도하고 중복을 만들지 않는다`, async (t) => {
    const { inside, outside, teamId, remote } = twoPeers(t, makeStores);
    const file = await inside.create("자료", slide("처음"));
    // The push reaches the repository, but its answer is lost.
    const publish = inside.transport.publish.bind(inside.transport);
    inside.transport.publish = async (...args) => {
      await publish(...args);
      throw new Error("connection reset");
    };
    await assert.rejects(inside.sync(), /connection reset/);
    inside.transport.publish = publish;
    const commits = () =>
      Number(
        execFileSync("git", [
          "-C",
          remote,
          "rev-list",
          "--count",
          SLIDE_BRANCH,
        ]).toString(),
      );
    assert.equal(commits(), 1);
    const again = await inside.sync();
    // The published version is recognised as this site's own: nothing new.
    assert.deepEqual([again.published, again.received, commits()], [0, 1, 1]);
    assert.equal(
      (await inside.store.syncFiles(teamId))[0].shared.hash,
      sha(slide("처음")),
    );

    // Both sites publish different files from the same head.
    await settle(outside);
    await inside.create("사내 자료", slide("a"));
    await outside.create("외부 자료", slide("b"));
    const stale = (await outside.store.syncState(teamId)).head;
    assert.equal((await inside.sync()).published, 1);
    // The external site still believes the old head when it pushes.
    const readHead = outside.transport.readHead.bind(outside.transport);
    let first = true;
    outside.transport.readHead = async (branch) => {
      if (first && branch === SLIDE_BRANCH) {
        first = false;
        return stale;
      }
      return readHead(branch);
    };
    assert.equal((await outside.sync()).raced, true);
    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.equal((await inside.list()).length, 3);
    assert.equal(
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
        .filter((path) => path.startsWith("files/")).length,
      3,
    );
    assert.equal((await inside.read(file.id)).equals(slide("처음")), true);
  });

  test(`${name}: 손상된 조각은 받지 않고 다음 시도까지 기존 자료를 유지한다`, async (t) => {
    const { inside, outside, teamId } = twoPeers(t, makeStores);
    const file = await inside.create("자료", slide("처음"));
    await settle(inside, outside);
    await inside.save(file.id, slide("새 내용"));
    await inside.sync();
    const readFile = outside.transport.readFile.bind(outside.transport);
    outside.transport.readFile = async (oid, path) =>
      path.startsWith("chunks/") ? Buffer.from("damaged") : readFile(oid, path);
    const warnings = [];
    const before = (await outside.store.syncState(teamId)).head;
    const failed = await syncSlideFiles({
      transport: outside.transport,
      store: outside.store,
      teamId,
      site: "external",
      warn: (...args) => warnings.push(args.join(" ")),
    });
    assert.equal(failed.pending, 1);
    assert.match(warnings[0], /SHA-256/);
    assert.equal((await outside.store.syncState(teamId)).head, before);
    assert.equal((await outside.read(file.id)).equals(slide("처음")), true);
    outside.transport.readFile = readFile;
    await settle(outside);
    assert.equal((await outside.read(file.id)).equals(slide("새 내용")), true);
  });
}

slideSyncContract("사내 저장소끼리", sqliteStores);

test("복원한 저장소는 새 게시 세대로 시작해 이전 버전 번호를 다시 쓰지 않는다", async (t) => {
  const { inside, outside, teamId } = twoPeers(t, sqliteStores);
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
