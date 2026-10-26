import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

test("M9 HTTPS credential helper uses the running Node executable when service PATH has no node", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gb-askpass-")),
    bin = join(dir, "bin");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(bin);
  const git = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  symlinkSync(git, join(bin, "git"));
  const token = "synthetic-askpass-secret",
    transport = new GitCliTransport({
      directory: join(dir, "cache"),
      repository: "example/private-team",
      token,
    });
  await transport.init();
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    const output = (
      await transport.git(["credential", "fill"], {
        input: "protocol=https\nhost=example.invalid\n\n",
      })
    ).toString();
    assert.ok(output.includes("username=x-access-token\n"));
    assert.ok(output.includes("password=" + token + "\n"));
    const url = (
      await transport.git(["config", "remote.origin.url"])
    ).toString();
    assert.equal(url.trim(), "https://github.com/example/private-team");
    assert.equal(url.includes(token), false);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
