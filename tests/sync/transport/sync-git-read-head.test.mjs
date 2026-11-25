import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";

// The internal site reads the head of several branches every minute. Each
// read asks the remote once; the second connection, the fetch, is for a
// branch that moved.
test("Git CLI readHead fetches a branch only when its remote head is not the one this clone holds", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-read-head-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git"),
    seen = [];
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const peer = new GitCliTransport({
    directory: join(dir, "peer.git"),
    repository: remote,
    allowLocal: true,
  });
  const local = new GitCliTransport({
    directory: join(dir, "local.git"),
    repository: remote,
    allowLocal: true,
    log: (entry) => seen.push(entry),
  });
  await local.init();
  // The head a read returned and the connections Git opened for it.
  const read = async (branch) => {
    seen.length = 0;
    const head = await local.readHead(branch);
    assert.ok(seen.every((entry) => entry.ok));
    return [
      head,
      ...seen
        .map((entry) => entry.command)
        .filter((command) => ["ls-remote", "fetch", "push"].includes(command)),
    ];
  };
  const tracked = async (branch) =>
    (await local.git(["rev-parse", `refs/remotes/origin/${branch}`]))
      .toString()
      .trim();

  // A branch that does not exist is answered by the remote alone.
  assert.deepEqual(await read("sync-v1"), [null, "ls-remote"]);

  const first = await peer.createCandidate(null, { "manifest.json": "1" });
  assert.equal(await peer.publish(first, null), true);
  assert.deepEqual(await read("sync-v1"), [first, "ls-remote", "fetch"]);
  assert.equal(await tracked("sync-v1"), first);
  // Unchanged: no fetch, however often it is read. What the clone holds is
  // asked of the clone itself.
  for (let pass = 0; pass < 3; pass++)
    assert.deepEqual(await read("sync-v1"), [first, "ls-remote"]);
  assert.deepEqual(
    seen.map((entry) => entry.command),
    ["ls-remote", "rev-parse"],
  );
  assert.equal(
    (await local.readFile(first, "manifest.json")).toString(),
    "1",
    "the commit is read from the clone",
  );

  // Moved by the other site: fetched, and readable here afterwards.
  const second = await peer.createCandidate(first, { "manifest.json": "2" });
  assert.equal(await peer.publish(second, first), true);
  assert.equal(await local.hasCommit(second), false);
  assert.deepEqual(await read("sync-v1"), [second, "ls-remote", "fetch"]);
  assert.deepEqual((await local.readCommit(second)).parents, [first]);
  assert.deepEqual(await read("sync-v1"), [second, "ls-remote"]);

  // Moved by this site: the push leaves this clone's copy of the branch where
  // it was, so the next read still fetches and the clone keeps a reference to
  // the commit it published.
  const third = await local.createCandidate(second, { "manifest.json": "3" });
  assert.equal(await local.publish(third, second), true);
  assert.equal(await tracked("sync-v1"), second);
  assert.deepEqual(await read("sync-v1"), [third, "ls-remote", "fetch"]);
  assert.equal(await tracked("sync-v1"), third);

  // Each branch is compared with its own copy.
  const slides = await peer.createCandidate(null, { "slides.json": "{}" });
  assert.equal(await peer.publish(slides, null, "sync-slides-v1"), true);
  assert.deepEqual(await read("sync-slides-v1"), [
    slides,
    "ls-remote",
    "fetch",
  ]);
  assert.deepEqual(await read("sync-slides-v1"), [slides, "ls-remote"]);
  assert.deepEqual(await read("sync-v1"), [third, "ls-remote"]);

  // A copy that names a commit this clone does not hold is fetched.
  assert.equal(await peer.readHead(), third);
  const fourth = await peer.createCandidate(third, { "manifest.json": "4" });
  assert.equal(await peer.publish(fourth, third), true);
  writeFileSync(
    join(local.directory, "refs/remotes/origin/sync-v1"),
    fourth + "\n",
  );
  assert.equal(await local.hasCommit(fourth), false);
  assert.deepEqual(await read("sync-v1"), [fourth, "ls-remote", "fetch"]);
  assert.equal(await local.hasCommit(fourth), true);

  // A branch removed from the remote is missing again, whatever the clone has.
  execFileSync("git", [
    "-C",
    remote,
    "update-ref",
    "-d",
    "refs/heads/sync-slides-v1",
  ]);
  assert.deepEqual(await read("sync-slides-v1"), [null, "ls-remote"]);

  // An unreachable remote fails the read even when the clone is current.
  renameSync(remote, remote + ".away");
  await assert.rejects(
    local.readHead("sync-v1"),
    /Git operation failed \(128, ls-remote\)/,
  );
});
