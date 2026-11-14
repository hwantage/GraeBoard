import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
} from "../../../server/sync/node/sync-log.mjs";

const team = "11111111-1111-4111-8111-111111111111";
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-sync-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("sync log writes dated JSON lines and reads them newest first in pages", (t) => {
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
  const first = log.read(team, { date: today, limit: 4 });
  assert.deepEqual(
    first.entries.map((entry) => entry.n ?? entry.kind),
    ["state", 4, 3, 2],
  );
  assert.ok(
    first.entries.every((entry) => !Number.isNaN(Date.parse(entry.at))),
  );
  const second = log.read(team, { date: today, limit: 4, before: first.next });
  assert.deepEqual(
    second.entries.map((entry) => entry.n),
    [1, 0],
  );
  assert.equal(second.next, null);
  // Failures and state changes only.
  assert.deepEqual(
    log
      .read(team, { date: today, problems: true })
      .entries.map((entry) => entry.n ?? entry.kind),
    ["state", 2],
  );
  // A line cut short by a crash does not hide the others.
  writeFileSync(
    log.file(team, today),
    readFileSync(log.file(team, today), "utf8") + '{"kind":"cy',
  );
  assert.equal(log.read(team, { date: today }).entries.length, 6);
});

test("sync log levels are per team, default to cycles and apply without a restart", (t) => {
  const dir = temporary(t),
    directory = join(dir, "sync-logs"),
    log = createSyncLog(directory),
    other = createSyncLog(directory),
    today = syncLogDate();
  assert.equal(log.level(team), "cycles");
  log.git(team, { command: "fetch", ok: true });
  log.git(team, { command: "fetch", ok: false, code: 128, stderr: "fatal" });
  assert.deepEqual(
    log.read(team, { date: today }).entries.map((entry) => entry.ok),
    [false],
  );
  log.setLevel(team, "git");
  // Another thread's logger sees the change through the settings file.
  assert.equal(other.level(team), "git");
  assert.equal(other.level("22222222-2222-4222-8222-222222222222"), "cycles");
  other.git(team, { command: "fetch", ok: true });
  assert.equal(log.read(team, { date: today }).entries.length, 2);
  assert.throws(() => log.setLevel(team, "verbose"));
  assert.throws(() => log.setLevel("../x", "git"));
  // A damaged settings file falls back to the default.
  writeFileSync(join(directory, "settings.json"), "{");
  assert.equal(log.level(team), "cycles");
});

test("sync log keeps fourteen days, ignores unsafe names and never throws", (t) => {
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
  assert.deepEqual(log.read("../escape", { date: syncLogDate() }).entries, []);
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
  assert.deepEqual(off.read(team, { date: syncLogDate() }).entries, []);
  assert.deepEqual(off.dates(team), []);
});

test("sync log pages a large day in chunks and its positions stay valid while the file grows", (t) => {
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
    const page = log.read(team, { date: today, before, limit: 120 });
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
  assert.deepEqual(
    log
      .read(team, { date: today, problems: true })
      .entries.map((entry) => entry.n),
    [450, 400, 350, 300, 250, 200, 150, 100, 50, 0],
  );
  assert.ok(
    log
      .read(team, { date: today, limit: 3 })
      .entries.every((entry) => entry.filler === undefined),
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
