import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  GitCliTransport,
  redactGitOutput,
} from "../../../server/sync/node/git-cli.mjs";
import {
  createSyncLog,
  syncLogDate,
  SYNC_LOG_RETENTION_DAYS,
  SYNC_LOG_SCAN,
} from "../../../server/sync/node/sync-log.mjs";
import { SyncService } from "../../../server/sync/core/service.mjs";
import { canonical } from "../../../server/sync/core/protocol.mjs";

const team = "11111111-1111-4111-8111-111111111111";
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-sync-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("sync log writes dated JSON lines and reads them newest first in pages", async (t) => {
  const dir = temporary(t),
    log = createSyncLog(join(dir, "sync-logs")),
    today = syncLogDate();
  for (let i = 0; i < 5; i++)
    log.write(team, { kind: "cycle", ok: i !== 2, n: i });
  log.write(team, { kind: "state", change: "mode", from: "active" });
  assert.deepEqual(log.dates(team), [today]);
  assert.deepEqual(readdirSync(join(dir, "sync-logs", team)), [
    today + ".jsonl",
  ]);
  const first = await log.read(team, { date: today, limit: 4 });
  assert.deepEqual(
    first.entries.map((entry) => entry.n ?? entry.kind),
    ["state", 4, 3, 2],
  );
  assert.ok(
    first.entries.every((entry) => !Number.isNaN(Date.parse(entry.at))),
  );
  const second = await log.read(team, {
    date: today,
    limit: 4,
    before: first.next,
  });
  assert.deepEqual(
    second.entries.map((entry) => entry.n),
    [1, 0],
  );
  assert.equal(second.next, null);
  // Failures and state changes only.
  assert.deepEqual(
    (await log.read(team, { date: today, problems: true })).entries.map(
      (entry) => entry.n ?? entry.kind,
    ),
    ["state", 2],
  );
  // A line cut short by a crash does not hide the others.
  writeFileSync(
    log.file(team, today),
    readFileSync(log.file(team, today), "utf8") + '{"kind":"cy',
  );
  assert.equal((await log.read(team, { date: today })).entries.length, 6);
});

test("sync log levels are per team, default to cycles and apply without a restart", async (t) => {
  const dir = temporary(t),
    directory = join(dir, "sync-logs"),
    log = createSyncLog(directory),
    other = createSyncLog(directory),
    today = syncLogDate();
  assert.equal(log.level(team), "cycles");
  log.git(team, { command: "fetch", ok: true });
  log.git(team, { command: "fetch", ok: false, code: 128, stderr: "fatal" });
  assert.deepEqual(
    (await log.read(team, { date: today })).entries.map((entry) => entry.ok),
    [false],
  );
  log.setLevel(team, "git");
  // Another thread's logger sees the change through the settings file.
  assert.equal(other.level(team), "git");
  assert.equal(other.level("22222222-2222-4222-8222-222222222222"), "cycles");
  other.git(team, { command: "fetch", ok: true });
  assert.equal((await log.read(team, { date: today })).entries.length, 2);
  assert.throws(() => log.setLevel(team, "verbose"));
  assert.throws(() => log.setLevel("../x", "git"));
  // A damaged settings file falls back to the default.
  writeFileSync(join(directory, "settings.json"), "{");
  assert.equal(log.level(team), "cycles");
});

test("sync log keeps fourteen days, ignores unsafe names and never throws", async (t) => {
  const dir = temporary(t),
    directory = join(dir, "sync-logs"),
    log = createSyncLog(directory),
    day = 86400000,
    kept = syncLogDate(Date.now() - (SYNC_LOG_RETENTION_DAYS - 1) * day),
    expired = syncLogDate(Date.now() - SYNC_LOG_RETENTION_DAYS * day);
  mkdirSync(join(directory, team), { recursive: true });
  for (const name of [kept, expired, "notes"])
    writeFileSync(join(directory, team, name + ".jsonl"), "{}\n");
  log.write(team, { kind: "cycle", ok: true });
  assert.deepEqual(log.dates(team), [syncLogDate(), kept]);
  assert.ok(existsSync(join(directory, team, "notes.jsonl")));
  log.write("../escape", { kind: "cycle" });
  assert.equal(log.file(team, "../../x"), null);
  assert.deepEqual(
    (await log.read("../escape", { date: syncLogDate() })).entries,
    [],
  );
  assert.ok(!existsSync(join(dir, "escape")));
  log.removeTeam(team);
  assert.deepEqual(log.dates(team), []);
  // A removed data directory is not created again by a late write.
  rmSync(dir, { recursive: true, force: true });
  log.write(team, { kind: "cycle", ok: true });
  assert.ok(!existsSync(dir));
  // A team deleted while a cycle was finishing does not get its folder back,
  // and a folder emptied by retention is removed.
  const again = temporary(t),
    live = createSyncLog(join(again, "sync-logs")),
    idle = "33333333-3333-4333-8333-333333333333";
  live.write(team, { kind: "cycle", ok: true });
  live.removeTeam(team);
  live.write(team, { kind: "cycle", ok: true });
  assert.ok(!existsSync(join(again, "sync-logs", team)));
  mkdirSync(join(again, "sync-logs", idle));
  writeFileSync(join(again, "sync-logs", idle, expired + ".jsonl"), "{}\n");
  live.prune();
  assert.ok(!existsSync(join(again, "sync-logs", idle)));
  // No directory: logging is off and reads are empty.
  const off = createSyncLog(null);
  off.write(team, { kind: "cycle" });
  off.git(team, { ok: false });
  assert.equal(off.level(team), "cycles");
  assert.deepEqual((await off.read(team, { date: syncLogDate() })).entries, []);
  assert.deepEqual(off.dates(team), []);
});

test("sync log pages a large day in chunks and its positions stay valid while the file grows", async (t) => {
  const dir = temporary(t),
    log = createSyncLog(join(dir, "sync-logs")),
    today = syncLogDate(),
    // Longer than one read chunk in total, with one line longer than a chunk.
    filler = "가".repeat(3000);
  for (let i = 0; i < 500; i++)
    log.write(team, { kind: "git", ok: i % 50 !== 0, n: i, filler });
  log.write(team, { kind: "git", ok: true, n: 500, filler: "x".repeat(1.5e6) });
  log.write(team, { kind: "cycle", ok: true, n: 501 });
  const seen = [];
  let before,
    pages = 0;
  do {
    const page = await log.read(team, { date: today, before, limit: 120 });
    seen.push(...page.entries.map((entry) => entry.n));
    // New entries arrive while an older page is being read.
    log.write(team, { kind: "cycle", ok: true, n: 1000 + pages });
    before = page.next;
    pages++;
  } while (before !== null);
  assert.deepEqual(
    seen,
    Array.from({ length: 502 }, (_, i) => 501 - i),
  );
  assert.equal(pages, 5);
  // The problems among them, read a bounded part at a time.
  const problems = [];
  before = undefined;
  do {
    const page = await log.read(team, { date: today, before, problems: true });
    problems.push(...page.entries.map((entry) => entry.n));
    before = page.next;
  } while (before !== null);
  assert.deepEqual(problems, [450, 400, 350, 300, 250, 200, 150, 100, 50, 0]);
  assert.ok(
    (await log.read(team, { date: today, limit: 3 })).entries.every(
      (entry) => entry.filler === undefined,
    ),
  );
});

test("a filtered read passes over a bounded part of a day per request and continues from next without losing or repeating an entry", async (t) => {
  const dir = temporary(t),
    log = createSyncLog(join(dir, "sync-logs")),
    today = syncLogDate(),
    file = join(dir, "sync-logs", team, today + ".jsonl"),
    line = (entry) =>
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    quiet = line({ kind: "git", command: "rev-parse", ok: true, ms: 2 }),
    // More quiet lines than one request passes over, twice, around a
    // problem and a quiet line longer than the bound.
    block = quiet.repeat(Math.ceil((SYNC_LOG_SCAN * 1.2) / quiet.length)),
    long = line({ kind: "git", ok: true, filler: "x".repeat(SYNC_LOG_SCAN) });
  mkdirSync(join(dir, "sync-logs", team), { recursive: true });
  writeFileSync(
    file,
    line({ kind: "cycle", ok: false, n: 0 }) +
      block +
      line({ kind: "state", n: 1 }) +
      long +
      block,
  );
  const size = statSync(file).size,
    first = await log.read(team, { date: today, problems: true });
  // The newest quiet lines fill the first request: nothing to show yet, and
  // the rest of the day is left to `next`.
  assert.deepEqual(first.entries, []);
  assert.ok(first.next !== null);
  assert.ok(size - first.next <= SYNC_LOG_SCAN + quiet.length);
  // An entry written meanwhile is after the cursor and not in these pages.
  log.write(team, { kind: "cycle", ok: false, n: 2 });
  const seen = [];
  let before = first.next,
    pages = 1;
  while (before !== null) {
    const page = await log.read(team, { date: today, before, problems: true });
    seen.push(...page.entries.map((entry) => entry.n));
    // Every request moves on, the one passing over the long line included.
    assert.ok(page.next === null || page.next < before);
    before = page.next;
    pages++;
  }
  assert.deepEqual(seen, [1, 0]);
  assert.ok(pages >= 4, String(pages));
  // A read without the filter is bounded by its page, not by the lines.
  assert.equal(
    (await log.read(team, { date: today, limit: 5 })).entries.length,
    5,
  );
  assert.deepEqual(
    (await log.read(team, { date: today, problems: true })).entries.map(
      (entry) => entry.n,
    ),
    [2],
  );
});

test("Git output kept in the log masks URL credentials and the access token", () => {
  const token = "ghp_fixtureTokenValue1234567890";
  assert.equal(
    redactGitOutput(
      "fatal: Invalid proxy URL 'http://user:p@ss#word@proxy.corp:8080': only SOCKS proxies support paths",
      token,
    ),
    "fatal: Invalid proxy URL 'http://***@proxy.corp:8080': only SOCKS proxies support paths",
  );
  assert.equal(
    redactGitOutput(
      `fatal: unable to access 'https://x-access-token:${token}@github.com/a/b/': The requested URL returned error: 403`,
      token,
    ),
    "fatal: unable to access 'https://***@github.com/a/b/': The requested URL returned error: 403",
  );
  assert.equal(
    redactGitOutput(`remote: bad credentials ${token} for user`, token),
    "remote: bad credentials *** for user",
  );
  // Ordinary output, including an address without credentials, is unchanged.
  const plain =
    "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com";
  assert.equal(redactGitOutput(plain, token), plain);
  assert.equal(redactGitOutput(plain, ""), plain);
});

test("Git transport reports each command with what Git printed and names the failed step", async (t) => {
  const dir = temporary(t),
    remote = join(dir, "remote.git"),
    seen = [];
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
    token: "ghp_fixtureTokenValue1234567890",
    log: (entry) => seen.push(entry),
  });
  const first = await transport.createCandidate(null, { "a.txt": "a" }),
    second = await transport.createCandidate(first, { "b.txt": "b" }),
    apart = await transport.createCandidate(null, { "c.txt": "c" });
  assert.ok(seen.length && seen.every((entry) => entry.ok));
  assert.ok(seen.some((entry) => entry.command === "hash-object"));
  assert.equal(
    seen.find((entry) => entry.command === "hash-object").inputBytes,
    1,
  );
  seen.length = 0;
  // "Not an ancestor" is an answer, not a failure.
  assert.equal(await transport.verifyReachable(first, second), true);
  assert.equal(await transport.verifyReachable(first, apart), false);
  assert.deepEqual(
    seen.map((entry) => [entry.command, entry.ok, entry.code]),
    [
      ["merge-base", true, undefined],
      ["merge-base", true, 1],
    ],
  );
  seen.length = 0;
  const missing = "1".repeat(40);
  await assert.rejects(
    transport.verifyReachable(first, missing),
    (error) =>
      error.code === 128 &&
      error.message === "Git operation failed (128, merge-base)",
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].code, 128);
  assert.match(seen[0].stderr, /Not a valid commit name/);
  assert.match(seen[0].args, new RegExp(missing));
  assert.ok(Number.isInteger(seen[0].ms));
  assert.ok(!JSON.stringify(seen).includes("ghp_fixtureTokenValue"));
  // A command the log runs for itself is not reported.
  seen.length = 0;
  await transport.git(["rev-list", "--count", `${first}..${second}`], {
    silent: true,
  });
  assert.equal(seen.length, 0);
  // A logger that throws changes nothing.
  transport.log = () => {
    throw new Error("log failed");
  };
  assert.equal(await transport.verifyReachable(first, second), true);
  await assert.rejects(
    transport.readFile(first, "manifest.json"),
    /Git operation failed \(128, show\)/,
  );
});

// The peer can publish a commit and announce it in its status after this
// clone received, so the announced head is not in this clone yet. The status
// step must not fail a cycle whose exchange already finished.
test("a peer head announced after this clone received is fetched or left unverified without failing", async (t) => {
  const dir = temporary(t),
    remote = join(dir, "remote.git"),
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
  const identity = { teamId: "team", repoId: "repo" };
  const announce = async (head) => {
    const branch = "sync-status/peer",
      parent = await peer.readHead(branch),
      oid = await peer.createCandidate(parent, {
        "status.json": canonical({
          ...identity,
          installationId: "peer",
          writerEpoch: "epoch",
          mode: "active",
          appliedCanonicalHead: head,
          observedAt: new Date().toISOString(),
        }),
      });
    assert.equal(await peer.publish(oid, parent, branch), true);
  };
  const first = await peer.createCandidate(null, { "manifest.json": "1" });
  assert.equal(await peer.publish(first, null), true);
  assert.equal(await local.readHead(), first);
  // The peer moves on after this clone received `first`.
  const second = await peer.createCandidate(first, { "manifest.json": "2" });
  assert.equal(await peer.publish(second, first), true);
  await announce(second);
  assert.equal(await local.hasCommit(second), false);
  let saved = null;
  const service = new SyncService({
    transport: local,
    store: { saveRemoteStatus: async (value) => (saved = value) },
    identity: { ...identity, peerInstallationId: "peer" },
  });
  const link = {
    canonical_head: first,
    installation_id: "local",
    writer_epoch: "epoch",
    mode: "active",
  };
  seen.length = 0;
  await service.status(link);
  assert.equal(saved.verified, true);
  assert.equal(saved.appliedCanonicalHead, second);
  assert.equal(saved.verifiedAgainstHead, first);
  assert.equal(await local.hasCommit(second), true);
  assert.deepEqual(
    seen.filter((entry) => !entry.ok),
    [],
    "a missing commit is an answer, not a failed Git command",
  );
  // A commit that never reached the remote stays unverified.
  const unpublished = await peer.createCandidate(second, {
    "manifest.json": "3",
  });
  await announce(unpublished);
  await service.status(link);
  assert.equal(saved.verified, false);
  assert.equal(saved.appliedCanonicalHead, unpublished);
  // A failed fetch leaves the peer unverified; an interruption still stops.
  const third = await peer.createCandidate(second, { "manifest.json": "4" });
  assert.equal(await peer.publish(third, second), true);
  await announce(third);
  const readHead = local.readHead.bind(local);
  local.readHead = async (branch) => {
    if (branch === undefined)
      throw new Error("Git operation failed (128, fetch)");
    return readHead(branch);
  };
  await service.status(link);
  assert.equal(saved.verified, false);
  local.readHead = async (branch) => {
    if (branch === undefined)
      throw Object.assign(new Error("stopped"), { code: "SYNC_INTERRUPTED" });
    return readHead(branch);
  };
  await assert.rejects(
    service.status(link),
    (error) => error.code === "SYNC_INTERRUPTED",
  );
  local.readHead = readHead;
  await service.status(link);
  assert.equal(saved.verified, true);
  // A status that expires while the fetch runs is stored unverified.
  const fourth = await peer.createCandidate(third, { "manifest.json": "5" });
  assert.equal(await peer.publish(fourth, third), true);
  await announce(fourth);
  const now = Date.now;
  local.readHead = async (branch) => {
    const head = await readHead(branch);
    if (branch === undefined) Date.now = () => now() + 181000;
    return head;
  };
  try {
    await service.status(link);
  } finally {
    Date.now = now;
    local.readHead = readHead;
  }
  assert.equal(await local.hasCommit(fourth), true);
  assert.equal(saved.verified, false);
  await service.status(link);
  assert.equal(saved.verified, true);
  // A head this clone holds on unrelated history is still unreachable.
  const apart = await local.createCandidate(null, { "manifest.json": "x" });
  await announce(apart);
  await service.status(link);
  assert.equal(saved.verified, false);
});

test("Git CLI commit lookup only accepts full object IDs", async (t) => {
  const dir = temporary(t),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  for (const value of [":/pattern", "--all", "HEAD", "a".repeat(39), 3])
    await assert.rejects(
      transport.hasCommit(value),
      (error) => error.code === "SYNC_FORMAT",
    );
  const commit = await transport.createCandidate(null, { "a.txt": "a" });
  assert.equal(await transport.hasCommit(commit), true);
  assert.equal(await transport.hasCommit("1".repeat(40)), false);
  const blob = execFileSync(
    "git",
    ["-C", join(dir, "cache.git"), "hash-object", "-w", "--stdin"],
    { input: "blob" },
  )
    .toString()
    .trim();
  assert.equal(await transport.hasCommit(blob), false);
});
