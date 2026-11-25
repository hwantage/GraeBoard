import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCliTransport } from "../../server/sync/node/git-cli.mjs";
import {
  SLIDE_BRANCH,
  SLIDE_CHUNK_BYTES,
  slideChunks,
  slideConflictCopyId,
  syncSlideFiles,
} from "../../server/sync/core/slide-file-branch.mjs";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const slide = (text, size = 0) => {
  const body = JSON.stringify({ version: 1, name: text, pad: "" });
  if (!size) return Buffer.from(body);
  // Not compressible, so chunks differ from each other.
  const pad = Buffer.alloc(size - body.length);
  for (let i = 0; i < pad.length; i++) pad[i] = 97 + ((i * 31 + (i >> 7)) % 26);
  return Buffer.from(body.replace('"pad":""', `"pad":"${pad.toString()}"`));
};

// Two sites with their own stores and Git clones of one bare repository.
export async function twoPeers(t, makeStores) {
  const directory = mkdtempSync(join(tmpdir(), "slide-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const stores = await makeStores(t, directory, remote);
  if (!stores) return null;
  const teamId = stores.teamId || randomUUID();
  const peer = (site, store) => {
    // Each site reaches the repository its own way; by default both use the
    // Git CLI with a clone of their own.
    const transport =
      stores.transports?.[site] ||
      new GitCliTransport({
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
  return {
    directory,
    remote,
    teamId,
    inside: peer("internal", stores.internal),
    outside: peer("external", stores.external),
  };
}
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
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
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
    assert.equal((await outside.store.list(teamId))[0].creationFromSync, true);
    assert.equal(
      (await inside.store.list(teamId))[0].creationFromSync,
      undefined,
    );

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

  test(`${name}: 동기화 상태는 한 번만 만들고, 조각 목록 없이 읽은 자료는 그 밖의 값이 전체 목록과 같다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
    for (const { store } of [inside, outside]) {
      const created = await store.syncState(teamId);
      assert.equal(created.head, null);
      assert.match(created.epoch, /^[0-9a-f-]{36}$/);
      assert.deepEqual(await store.syncState(teamId), created);
    }

    // Every kind of row: shared, shared and deleted, known only from the
    // branch (deleted there before it arrived here) and not shared yet.
    await inside.create("남는 자료", slide("남는 자료"));
    const removed = await inside.create("지울 자료", slide("지울 자료"));
    await settle(inside, outside);
    await outside.remove(removed.id);
    const early = await inside.create("받기 전에 지울 자료", slide("일찍"));
    await inside.sync();
    await inside.remove(early.id);
    await settle(inside, outside);
    await outside.create("게시 전 자료", slide("게시 전"));
    const byId = (files) => files.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const { store } of [inside, outside]) {
      const whole = byId(await store.syncFiles(teamId));
      assert.deepEqual(
        byId(await store.syncFiles(teamId, { chunks: false })),
        whole.map((file) => {
          if (!file.shared) return file;
          const { chunks, ...shared } = file.shared;
          assert.equal(chunks.length, 1);
          return { ...file, shared };
        }),
      );
    }
    const kinds = (await outside.store.syncFiles(teamId, { chunks: false }))
      .map((file) =>
        file.missing
          ? "missing"
          : !file.shared
            ? "unshared"
            : file.deletedAt
              ? "deleted"
              : "shared",
      )
      .sort();
    assert.deepEqual(kinds, ["deleted", "missing", "shared", "unshared"]);
  });

  test(`${name}: 25MiB 자료는 4MiB 조각으로 나뉘어 중단 뒤 이어서 전달되고, 다 받기 전에는 보이지 않는다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId, remote } = peers;
    const large = slide("large", MAX_SLIDE_FILE_BYTES);
    assert.equal((await slideChunks(large)).length, 7);
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

  test(`${name}: 조각 한도를 다 쓴 회차는 기다리는 자료의 내용을 읽지 않고, 이름 변경·삭제는 그 회차에도 게시한다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
    // Publication goes smallest first, so the sizes fix the order below.
    const sizes = [200, 300, 400];
    const edited = [];
    for (const size of sizes)
      edited.push(
        await outside.create(`자료 ${size}`, slide(`before ${size}`, size)),
      );
    const renamed = await outside.create("이름 바꿀 자료", slide("r", 1000));
    const removed = await outside.create("지울 자료", slide("d", 1100));
    await settle(outside, inside);

    const contents = sizes.map((size) => slide(`after ${size}`, size));
    for (const [index, file] of edited.entries())
      await outside.save(file.id, contents[index]);
    await outside.rename(renamed.id, "바꾼 이름");
    await outside.remove(removed.id);
    // Two chunks each.
    const larger = [1000, 2000].map((extra) =>
      slide(`large ${extra}`, SLIDE_CHUNK_BYTES + extra),
    );
    const large = [];
    for (const [index, bytes] of larger.entries())
      large.push(await outside.create(`큰 자료 ${index + 1}`, bytes));

    // What one pass read to publish, by content hash, with its outcome.
    const readContent = outside.store.syncReadContent.bind(outside.store);
    let reads = [];
    outside.store.syncReadContent = (team, hash) => {
      reads.push(hash);
      return readContent(team, hash);
    };
    const pass = async () => {
      reads = [];
      const result = await outside.sync({ chunks: 2, files: 50 });
      return [reads, result.published, result.pending];
    };
    const [a, b, c] = contents.map(sha);
    const [x, y] = larger.map(sha);

    // Two small files use the budget. The third and both large files wait
    // unread; the rename and the delete need no content and are published.
    assert.deepEqual(await pass(), [[a, b], 4, 3]);
    await inside.sync();
    const listed = (title, bytes) => `${title}=${sha(bytes).slice(0, 8)}`;
    assert.deepEqual(
      await inside.list(),
      [
        listed("자료 200", contents[0]),
        listed("자료 300", contents[1]),
        listed("자료 400", slide("before 400", 400)),
        listed("바꾼 이름", slide("r", 1000)),
      ].sort(),
    );
    // The budget ends inside the first large file: the second is not read.
    assert.deepEqual(await pass(), [[c, x], 1, 2]);
    assert.deepEqual(await pass(), [[x, y], 1, 1]);
    assert.deepEqual(await pass(), [[y], 1, 0]);
    assert.deepEqual(await pass(), [[], 0, 0]);

    await settle(inside, outside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.equal((await inside.list()).length, 6);
    for (const [index, file] of edited.entries())
      assert.equal((await inside.read(file.id)).equals(contents[index]), true);
    for (const [index, file] of large.entries())
      assert.equal(sha(await inside.read(file.id)), sha(larger[index]));
    assert.equal(await inside.store.get(teamId, removed.id), null);
  });

  test(`${name}: 양쪽이 같은 자료를 고치면 먼저 게시된 쪽이 원본으로 남고 늦은 쪽은 사본으로 보존된다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
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
    const copyId = slideConflictCopyId(
      file.id,
      sha(fromOutside),
      "external",
      (await inside.store.syncFiles(teamId))[0].shared.version,
    );
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
    for (const peer of [outside, inside])
      await peer.store.syncSetHead(
        teamId,
        null,
        (await peer.store.syncState(teamId)).head,
      );
    await settle(outside, inside);
    assert.equal((await inside.list()).length, 2);
    assert.equal((await outside.list()).length, 2);
  });

  test(`${name}: 삭제와 수정이 겹치면 수정이 남고, 겹치지 않는 이름·내용 변경은 둘 다 반영된다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
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

    // Renamed differently on both sides: the name published first is kept.
    await inside.rename(renamed.id, "사내가 붙인 이름");
    await outside.rename(renamed.id, "외부가 붙인 이름");
    assert.equal((await inside.sync()).published, 1);
    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.equal(
      (await outside.store.get(teamId, renamed.id)).title,
      "사내가 붙인 이름",
    );
    assert.equal(
      (await inside.list()).length,
      2,
      "a rename never makes a copy",
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

  test(`${name}: 받는 동안 이쪽에서 저장·이름 변경·삭제하면 덮어쓰지 않고 다음 회차에 다시 판단한다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
    const edited = await inside.create("저장하는 자료", slide("처음 1"));
    const renamed = await inside.create("이름 바꾸는 자료", slide("처음 2"));
    const removed = await inside.create("지우는 자료", slide("처음 3"));
    await settle(inside, outside);
    for (const [file, text] of [
      [edited, "사내의 새 내용 1"],
      [renamed, "사내의 새 내용 2"],
      [removed, "사내의 새 내용 3"],
    ])
      await inside.save(file.id, slide(text));
    assert.equal((await inside.sync()).published, 3);

    // While the external site fetches the chunks, its users keep working.
    const readFile = outside.transport.readFile.bind(outside.transport);
    let interrupted = false;
    outside.transport.readFile = async (oid, path) => {
      if (path.startsWith("chunks/") && !interrupted) {
        interrupted = true;
        await outside.save(edited.id, slide("외부에서 그 사이 저장"));
        await outside.rename(renamed.id, "외부에서 그 사이 바꾼 이름");
        await outside.remove(removed.id);
      }
      return readFile(oid, path);
    };
    const before = (await outside.store.syncState(teamId)).head;
    const pass = await outside.sync();
    outside.transport.readFile = readFile;
    // Nothing of the three was applied over the newer local state.
    assert.deepEqual([pass.received, pass.pending, pass.conflicts], [0, 1, 0]);
    assert.equal((await outside.store.syncState(teamId)).head, before);
    assert.equal(
      (await outside.read(edited.id)).equals(slide("외부에서 그 사이 저장")),
      true,
    );
    assert.equal(
      (await outside.store.get(teamId, renamed.id)).title,
      "외부에서 그 사이 바꾼 이름",
    );
    assert.equal(await outside.store.get(teamId, removed.id), null);

    // The next pass sees them as local changes and keeps both sides' work.
    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    const titles = (await inside.list()).map((item) => item.split("=")[0]);
    assert.deepEqual(
      titles.sort(),
      [
        // Both edited the content: the published one stays, the other is kept.
        "저장하는 자료",
        "저장하는 자료 (충돌 · 외부)",
        // Renamed here, content changed there: both are in one file.
        "외부에서 그 사이 바꾼 이름",
        // Deleted here, changed there: the change wins.
        "지우는 자료",
      ].sort(),
    );
    assert.equal(
      (await outside.read(edited.id)).equals(slide("사내의 새 내용 1")),
      true,
    );
    assert.equal(
      (await inside.read(renamed.id)).equals(slide("사내의 새 내용 2")),
      true,
    );
    assert.equal(
      (await outside.read(removed.id)).equals(slide("사내의 새 내용 3")),
      true,
    );
  });

  test(`${name}: 같은 내용이 다른 버전에 다시 지면 새 사본으로 보존하고, 같은 충돌의 재시도는 늘리지 않는다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
    const file = await inside.create("자료", slide("처음"));
    await settle(inside, outside);
    const mine = slide("외부가 고집하는 내용");
    const sharedVersion = async () =>
      (await outside.store.syncFiles(teamId)).find(
        (item) => item.id === file.id,
      ).shared.version;

    await inside.save(file.id, slide("사내 1"));
    await outside.save(file.id, mine);
    await inside.sync();
    assert.equal((await outside.sync()).conflicts, 1);
    const firstCopy = slideConflictCopyId(
      file.id,
      sha(mine),
      "external",
      await sharedVersion(),
    );
    assert.equal((await outside.read(firstCopy)).equals(mine), true);
    await settle(outside, inside);

    // The first copy is dealt with (deleted), then the same content loses again.
    await outside.remove(firstCopy);
    await settle(outside, inside);
    await inside.save(file.id, slide("사내 2"));
    await outside.save(file.id, mine);
    await inside.sync();
    assert.equal((await outside.sync()).conflicts, 1);
    const secondCopy = slideConflictCopyId(
      file.id,
      sha(mine),
      "external",
      await sharedVersion(),
    );
    assert.notEqual(secondCopy, firstCopy);
    assert.equal(
      (await outside.read(secondCopy)).equals(mine),
      true,
      "the late content is kept again",
    );
    await settle(outside, inside);
    assert.deepEqual(await inside.list(), await outside.list());
    assert.deepEqual(
      (await inside.list()).map((item) => item.split("=")[0]).sort(),
      ["자료", "자료 (충돌 · 외부)"],
    );

    // Reading the whole branch again repeats no conflict.
    for (const peer of [outside, inside])
      await peer.store.syncSetHead(
        teamId,
        null,
        (await peer.store.syncState(teamId)).head,
      );
    await settle(outside, inside);
    assert.equal((await outside.list()).length, 2);
    assert.equal((await inside.list()).length, 2);
  });

  test(`${name}: 브랜치가 사라지거나 다른 이력으로 바뀌면 슬라이드 동기화만 멈추고 마지막 상태를 보존한다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId, remote } = peers;
    const file = await inside.create("자료", slide("처음"));
    await settle(inside, outside);
    const head = (await outside.store.syncState(teamId)).head;
    const identity = {
      ...process.env,
      GIT_AUTHOR_NAME: "x",
      GIT_AUTHOR_EMAIL: "x@x",
      GIT_COMMITTER_NAME: "x",
      GIT_COMMITTER_EMAIL: "x@x",
    };
    const git = (...args) =>
      execFileSync("git", ["-C", remote, ...args], {
        stdio: "pipe",
        env: identity,
      })
        .toString()
        .trim();

    // Replaced by unrelated history.
    const tree = git("hash-object", "-w", "-t", "tree", "/dev/null");
    const unrelated = git("commit-tree", tree, "-m", "unrelated");
    git("update-ref", `refs/heads/${SLIDE_BRANCH}`, unrelated);
    await outside.save(file.id, slide("외부의 미게시 수정"));
    for (const peer of [inside, outside]) {
      await assert.rejects(peer.sync(), { code: "SLIDE_BRANCH_DIVERGED" });
      assert.equal((await peer.store.syncState(teamId)).head, head);
    }
    assert.equal(
      git("rev-parse", SLIDE_BRANCH),
      unrelated,
      "nothing was pushed",
    );
    assert.equal((await inside.read(file.id)).equals(slide("처음")), true);
    assert.equal(
      (await outside.read(file.id)).equals(slide("외부의 미게시 수정")),
      true,
    );

    // Removed altogether.
    git("update-ref", "-d", `refs/heads/${SLIDE_BRANCH}`);
    await assert.rejects(outside.sync(), { code: "SLIDE_BRANCH_DIVERGED" });
    assert.throws(() => git("rev-parse", "--verify", SLIDE_BRANCH));

    // Put back: both continue from where they were, with nothing lost.
    git("update-ref", `refs/heads/${SLIDE_BRANCH}`, head);
    await settle(outside, inside);
    assert.equal(
      (await inside.read(file.id)).equals(slide("외부의 미게시 수정")),
      true,
    );

    // A slower pass of the same site cannot move the cursor back.
    const current = (await inside.store.syncState(teamId)).head;
    assert.notEqual(current, head);
    assert.equal(await inside.store.syncSetHead(teamId, head, head), false);
    assert.equal((await inside.store.syncState(teamId)).head, current);
    assert.equal(
      await inside.store.syncSetHead(teamId, current, current),
      true,
    );
  });

  test(`${name}: 게시 응답을 잃거나 경합에서 지면 같은 버전으로 다시 시도하고 중복을 만들지 않는다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId, remote } = peers;
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

  test(`${name}: 이전 버전의 확인이 중복 도착해도 다음 버전의 게시 확인을 보존한다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { outside, teamId } = peers;
    const file = await outside.create("자료", slide("첫 버전"));
    await settle(outside);
    const record = async () =>
      (await outside.store.syncFiles(teamId)).find(
        (entry) => entry.id === file.id,
      );
    const previous = (await record()).shared;
    await outside.save(file.id, slide("다음 버전"));

    // The previous response arrives again after the new ref advances, but
    // before this pass confirms the new version locally.
    const publish = outside.transport.publish.bind(outside.transport);
    outside.transport.publish = async (...args) => {
      const result = await publish(...args);
      const pending = (await record()).pendingVersion;
      assert.ok(pending);
      await outside.store.syncMarkShared(teamId, file.id, previous);
      assert.equal((await record()).pendingVersion, pending);
      return result;
    };
    await outside.sync();
    outside.transport.publish = publish;
    assert.equal((await record()).shared.hash, sha(slide("다음 버전")));
    assert.equal((await outside.sync()).published, 0);
  });

  test(`${name}: 게시한 파일의 버전을 확인하지 못한 회차는 수신 커서를 전진시키지 않는다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { outside, teamId } = peers;
    const file = await outside.create("자료", slide("이전"));
    await settle(outside);
    const previous = (await outside.store.syncState(teamId)).head;
    await outside.save(file.id, slide("변경"));
    const confirm = outside.store.syncMarkShared.bind(outside.store);
    // A concurrent pass has replaced the version being confirmed.
    outside.store.syncMarkShared = () => false;
    const attempt = await outside.sync();
    assert.equal(attempt.published, 1);
    assert.equal((await outside.store.syncState(teamId)).head, previous);
    await outside.sync();
    assert.equal((await outside.store.syncState(teamId)).head, previous);
    outside.store.syncMarkShared = confirm;
    const again = await outside.sync();
    assert.equal(again.published, 0);
    assert.equal((await outside.store.syncState(teamId)).head, attempt.head);
  });

  test(`${name}: 늦게 돌아온 게시 응답이 그 사이 확정된 더 새 버전을 되돌리지 않는다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
    const file = await outside.create("자료", slide("버전 1"));
    await settle(outside, inside);
    await outside.save(file.id, slide("버전 2"));

    // The push of version 2 succeeds, but its call returns late. Meanwhile
    // the same site saves again and the next scheduled pass
    // receives version 2 and publishes version 3.
    const publish = outside.transport.publish.bind(outside.transport);
    let delayed = false;
    let between;
    outside.transport.publish = async (...args) => {
      const result = await publish(...args);
      if (!delayed) {
        delayed = true;
        await outside.save(file.id, slide("버전 3"));
        between = await outside.sync();
      }
      return result;
    };
    await outside.sync();
    outside.transport.publish = publish;
    assert.equal(
      between.published,
      1,
      "the overlapping pass published version 3",
    );
    const record = async () =>
      (await outside.store.syncFiles(teamId)).find(
        (item) => item.id === file.id,
      );
    const cursor = (await outside.store.syncState(teamId)).head;
    assert.equal(cursor, between.head, "the cursor stays at the newer commit");
    assert.equal((await record()).shared.hash, sha(slide("버전 3")));
    assert.equal((await record()).shared.version.endsWith(":3"), true);
    assert.equal((await record()).pendingVersion, null);
    // Nothing is left to publish: no repeated publication of the same file.
    const next = await outside.sync();
    assert.deepEqual([next.published, next.received, next.pending], [0, 0, 0]);
    assert.equal((await outside.store.syncState(teamId)).head, cursor);
    await settle(inside);
    assert.equal((await inside.read(file.id)).equals(slide("버전 3")), true);
  });

  test(`${name}: 손상된 조각은 받지 않고 다음 시도까지 기존 자료를 유지한다`, async (t) => {
    const peers = await twoPeers(t, makeStores);
    if (!peers) return;
    const { inside, outside, teamId } = peers;
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
