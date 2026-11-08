import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listNodeTestFiles } from "../../scripts/testing/node-test-files.mjs";

// Subprocesses exercise the public CLI as a fresh test invocation.
const cliEnv = { ...process.env };
delete cliEnv.NODE_TEST_CONTEXT;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gb-node-suites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content = "") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const copyRunner = () => {
    mkdirSync(join(root, "scripts/testing"), { recursive: true });
    for (const name of ["node-test-files", "run-node-tests"])
      copyFileSync(
        new URL(`../../scripts/testing/${name}.mjs`, import.meta.url),
        join(root, `scripts/testing/${name}.mjs`),
      );
    copyFileSync(
      new URL("../../scripts/testing/test-postgres.mjs", import.meta.url),
      join(root, "scripts/testing/test-postgres.mjs"),
    );
  };
  return { root, put, copyRunner };
}

test("recursive collection includes each root and deep suite once in sorted POSIX order", (t) => {
  const f = fixture(t);
  const included = [
    "tests/z.test.mjs",
    "tests/calendar/deep/example.test.mjs",
    "tests/a.test.mjs",
    "tests/sync/recovery/sheet-clone-frozen-compatibility.test.mjs",
    "tests/tooling/frozen-cutover-source.test.mjs",
  ];
  for (const path of [
    ...included,
    "tests/ignored.spec.ts",
    "tests/helper.mjs",
    "tests/support/worker-sheet-clone-sync-deno.mjs",
    "tests/fixtures/fake.test.mjs",
    "tests/calendar/fixtures/nested.test.mjs",
    "tests/browser/fake.test.mjs",
    "tests/support/fake.test.mjs",
  ])
    f.put(path);
  symlinkSync(
    join(f.root, "tests/calendar"),
    join(f.root, "tests/linked"),
    "dir",
  );
  symlinkSync(
    join(f.root, "tests/z.test.mjs"),
    join(f.root, "tests/link.test.mjs"),
  );
  assert.deepEqual(listNodeTestFiles(f.root), included.sort());
  assert.deepEqual(listNodeTestFiles(f.root + "/"), included);
});

test("list never executes suites; runner keeps environment and propagates a deep child failure", (t) => {
  const f = fixture(t);
  f.copyRunner();
  f.put(
    "tests/calendar/deep/failing.test.mjs",
    'import test from "node:test"; import assert from "node:assert/strict"; test("deep marker", () => { assert.equal(process.env.GB_RUNNER_TEST, "inherited"); assert.fail("nested suite executed"); });\n',
  );
  const run = (args, env = cliEnv) =>
    spawnSync(process.execPath, args, {
      cwd: f.root,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  const listed = run(["scripts/testing/run-node-tests.mjs", "--list"]);
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, "tests/calendar/deep/failing.test.mjs\n");
  const failed = run(["scripts/testing/run-node-tests.mjs"], {
    ...cliEnv,
    GB_RUNNER_TEST: "inherited",
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /nested suite executed/);
  assert.doesNotMatch(failed.stdout, /undefined.*inherited/s);
  assert.equal(
    run(["scripts/testing/run-node-tests.mjs", "--unknown"]).status,
    1,
  );
});

test("strict command fails before testing absent/unusable PG and uses the same deep collector after preflight", (t) => {
  const f = fixture(t);
  f.copyRunner();
  f.put(
    "tests/deep/strict.test.mjs",
    'import test from "node:test"; test("strict child marker", () => { throw new Error("strict deep failure"); });\n',
  );
  const run = (bin) =>
    spawnSync(process.execPath, ["scripts/testing/test-postgres.mjs"], {
      cwd: f.root,
      env: { ...cliEnv, TEST_PG_BIN: bin },
      encoding: "utf8",
      timeout: 15000,
    });
  for (const bin of ["", join(f.root, "absent")]) {
    const result = run(bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Strict PostgreSQL validation/);
    assert.doesNotMatch(result.stdout, /strict child marker/);
  }
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    f.put(`pg/${name}`, "#!/bin/sh\nprintf 'postgres (PostgreSQL) 99\\n'\n");
    chmodSync(join(f.root, `pg/${name}`), 0o755);
  }
  const failed = run(join(f.root, "pg"));
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /strict deep failure/);
  chmodSync(join(f.root, "pg/initdb"), 0o644);
  assert.match(run(join(f.root, "pg")).stderr, /cannot execute initdb/);
});

test(
  "runner forwards termination to its child and retains the termination signal",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    f.copyRunner();
    f.put(
      "tests/long.test.mjs",
      'import test from "node:test"; test("long", async () => { console.log("runner child ready"); await new Promise(r => setTimeout(r, 30000)); });\n',
    );
    const child = spawn(
      process.execPath,
      ["scripts/testing/run-node-tests.mjs"],
      { cwd: f.root, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill("SIGKILL"));
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Runner child did not start")),
        8000,
      );
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("runner child ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
  },
);
