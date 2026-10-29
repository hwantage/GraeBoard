import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { requirePostgresBinaries } from "../scripts/test-postgres.mjs";

test("L13 strict PostgreSQL validation fails instead of silently skipping absent server binaries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gb-pg-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => requirePostgresBinaries(""), /requires TEST_PG_BIN/);
  assert.throws(() => requirePostgresBinaries(dir), /cannot execute postgres/);
  const result = spawnSync(process.execPath, ["scripts/test-postgres.mjs"], {
    encoding: "utf8",
    env: { ...process.env, TEST_PG_BIN: dir },
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Strict PostgreSQL validation cannot execute/);
  assert.doesNotMatch(result.stdout, /TAP version/);
});
