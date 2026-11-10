import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  frozenCutoverSource,
  frozenCutoverDefinition,
  verifyFrozenDependencies,
} from "../support/frozen-cutover-source.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "gb-frozen-dependencies-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("frozen modules use an independent npm ci tree when the current app lockfile and packages differ", (t) => {
  const prepared = frozenCutoverSource();
  const root = join(temporary(t), "application");
  execFileSync("git", [
    "clone",
    "--shared",
    "--no-checkout",
    "--quiet",
    repository,
    root,
  ]);
  execFileSync("git", ["checkout", "--detach", "--quiet", "HEAD"], {
    cwd: root,
  });
  // Exercise the current adapter even before the refactoring is committed.
  for (const name of [
    "frozen-cutover-source.mjs",
    "frozen-cutover-source.json",
  ])
    copyFileSync(
      new URL(`../support/${name}`, import.meta.url),
      join(root, "tests/support", name),
    );
  writeFileSync(
    join(root, "package-lock.json"),
    readFileSync(join(root, "package-lock.json"), "utf8") + "\n",
  );
  mkdirSync(join(root, "node_modules/pg"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/pg/package.json"),
    JSON.stringify({ name: "pg", type: "module", main: "index.js" }),
  );
  writeFileSync(
    join(root, "node_modules/pg/index.js"),
    'throw new Error("Current application dependencies must not be used by the frozen conversion");',
  );
  const env = {
    ...process.env,
    GRAEBOARD_FROZEN_DEPENDENCIES: prepared.dependenciesRoot,
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createRequire} from "node:module";
    import {realpathSync} from "node:fs";
    import {frozenCutoverSource,frozenCutoverModule} from "./tests/support/frozen-cutover-source.mjs";
    const source=frozenCutoverSource();
    const conversion=await frozenCutoverModule("tools/sheet-clone-cutover/convert.mjs");
    console.log(JSON.stringify({commit:source.commit,pg:createRequire(source.url).resolve("pg"),modules:realpathSync(source.root+"/node_modules"),converter:typeof conversion.sqliteSheetCloneConversion}));
  `,
    ],
    { cwd: root, env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim());
  assert.equal(actual.commit, frozenCutoverDefinition.commit);
  assert.equal(actual.converter, "function");
  assert.equal(
    actual.modules,
    realpathSync(join(prepared.dependenciesRoot, "node_modules")),
  );
  assert.ok(actual.pg.startsWith(actual.modules + "/"));
  assert.notEqual(
    actual.modules,
    realpathSync(join(repository, "node_modules")),
  );
});

test("a prepared dependency environment rejects changed locks, borrowed modules and another runtime identity", (t) => {
  const prepared = frozenCutoverSource();
  assert.equal(
    verifyFrozenDependencies(prepared.dependenciesRoot),
    realpathSync(prepared.dependenciesRoot),
  );
  const root = temporary(t);
  copyFileSync(
    join(prepared.root, "package-lock.json"),
    join(root, "package-lock.json"),
  );
  symlinkSync(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  assert.throws(
    () => verifyFrozenDependencies(root),
    /dependency tree or lockfile mismatch/,
  );
  rmSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules"));
  const marker = JSON.parse(
    readFileSync(
      join(
        prepared.dependenciesRoot,
        "node_modules/.graeboard-frozen-dependencies.json",
      ),
      "utf8",
    ),
  );
  writeFileSync(
    join(root, "node_modules/.graeboard-frozen-dependencies.json"),
    JSON.stringify({ ...marker, node: "v0.0.0" }),
  );
  assert.throws(
    () => verifyFrozenDependencies(root),
    /installation identity mismatch/,
  );
  writeFileSync(join(root, "package-lock.json"), "changed lock");
  assert.throws(
    () => verifyFrozenDependencies(root),
    /dependency tree or lockfile mismatch/,
  );
});
