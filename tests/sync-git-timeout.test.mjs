import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

test("M8 real slow Git upload-pack uses a separate bounded network timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-slow-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git"),
    helper = join(dir, "slow-upload-pack");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const upload = execFileSync("which", ["git-upload-pack"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    helper,
    `#!/bin/sh\nsleep 0.15\nexec '${upload.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o700 },
  );
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
    localTimeoutMs: 50,
    networkTimeoutMs: 1500,
  });
  await transport.init();
  await transport.git(["config", "remote.origin.uploadpack", helper]);
  const start = Date.now();
  assert.equal(await transport.readHead(), null);
  assert.ok(Date.now() - start >= 150, "actual remote process was delayed");
  transport.networkTimeoutMs = 40;
  await assert.rejects(transport.readHead(), /Git operation failed/);
  // A timeout does not poison the reusable transport or rewrite the branch.
  transport.networkTimeoutMs = 1500;
  assert.equal(await transport.readHead(), null);
  const controller = new AbortController();
  const reason = Object.assign(new Error("fixture sync interruption"), {
    code: "SYNC_INTERRUPTED",
  });
  transport.signal = controller.signal;
  const aborted = transport.readHead();
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(aborted, (error) => error === reason);
  } finally {
    clearTimeout(timer);
  }
  transport.signal = new AbortController().signal;
  assert.equal(
    await transport.readHead(),
    null,
    "a cancelled command does not poison a fresh request signal",
  );
});
