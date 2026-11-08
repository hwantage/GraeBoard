import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkCodeOrganization } from "../../scripts/testing/check-code-organization.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gb-structure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const put = (path, content = "export const value = 1;\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const rules = {
    version: 1,
    sourceRoots: ["src", "server", "tools", "tests"],
    extensions: [".ts", ".tsx", ".mjs", ".js", ".css"],
    allowedDirectories: [
      "src",
      "src/calendar",
      "src/documents",
      "server",
      "tools/offline",
      "tests/fixtures",
    ].map((path) => ({ path, reason: "Isolated test responsibility" })),
    forbiddenStems: [
      "types",
      "utils",
      "helpers",
      "constants",
      "styles",
      "components",
      "service",
      "storage",
      "index",
    ],
    legacyRootFiles: [],
    legacyGenericFiles: [],
    legacyDuplicateGroups: [],
    fixedFiles: [],
  };
  return {
    root,
    rules,
    put,
    check: (extra = {}) => checkCodeOrganization({ root, rules, ...extra }),
  };
}
const record = (path) => ({ path, reason: "Exact existing fixture exception" });
const has = (result, rule) =>
  result.errors.some((error) => error.rule === rule);

test("specific feature names pass; generic role suffixes, new roots, unknown parents and tools do not", (t) => {
  const f = fixture(t);
  f.put("src/calendar/calendar-types.ts");
  assert.deepEqual(f.check().errors, []);
  for (const path of [
    "src/calendar/types.ts",
    "src/calendar/utils.test.mjs",
    "src/calendar/helpers.spec.ts",
    "tools/other/types.ts",
  ])
    f.put(path);
  f.put("src/NewCalendarPanel.tsx");
  f.put("src/misc/CalendarTools.ts");
  const result = f.check();
  assert.equal(
    result.errors.filter((error) => error.rule === "generic-name").length,
    4,
  );
  assert.ok(has(result, "root-file"));
  assert.ok(has(result, "directory"));
  assert.ok(result.errors.every(({ path, reason }) => path && reason));
});

test("Git tracked and nonignored untracked files are checked; deletions, ignored files and symlinks are excluded", (t) => {
  const f = fixture(t);
  f.put("src/calendar/calendar-types.ts");
  f.put("src/calendar/types.ts");
  execFileSync("git", ["add", "."], { cwd: f.root });
  rmSync(join(f.root, "src/calendar/types.ts"));
  f.put(".gitignore", "src/calendar/ignored/\n");
  f.put("src/calendar/ignored/types.ts");
  symlinkSync(
    join(f.root, "src/calendar/calendar-types.ts"),
    join(f.root, "src/calendar/utils.ts"),
  );
  assert.deepEqual(f.check().errors, []);
  f.put("src/calendar/types.ts");
  assert.ok(has(f.check(), "generic-name"));
});

test("existing generic and fixed entrypoint exceptions are exact and declaration pairs pass", (t) => {
  const f = fixture(t);
  f.put("src/types.ts");
  f.put("server/index.mjs");
  f.put("src/calendar/calendar-types.ts");
  f.put(
    "src/calendar/calendar-types.d.ts",
    "export declare const value: number;\n",
  );
  f.rules.legacyRootFiles.push(record("src/types.ts"));
  f.rules.legacyGenericFiles.push(record("src/types.ts"));
  f.rules.fixedFiles.push(record("server/index.mjs"));
  assert.deepEqual(f.check().errors, []);
  assert.deepEqual(f.check().warnings, []);
  f.put("src/calendar/types.ts");
  f.put("src/calendar/index.mjs");
  assert.equal(
    f.check().errors.filter((error) => error.rule === "generic-name").length,
    2,
  );
});

test("duplicates are case insensitive exact sets; a third path or stale group fails", (t) => {
  const f = fixture(t);
  f.put("src/calendar/CalendarTools.ts");
  f.put("src/documents/calendartools.ts");
  assert.ok(has(f.check(), "duplicate-name"));
  f.rules.legacyDuplicateGroups.push({
    paths: ["src/calendar/CalendarTools.ts", "src/documents/calendartools.ts"],
    reason: "Two existing runtimes",
  });
  assert.deepEqual(f.check().errors, []);
  f.put("tools/offline/CalendarTools.ts");
  assert.ok(has(f.check(), "duplicate-name"));
  rmSync(join(f.root, "tools/offline/CalendarTools.ts"));
  rmSync(join(f.root, "src/documents/calendartools.ts"));
  assert.ok(has(f.check(), "stale-exception"));
});

test("extension-only similarities request review while exact duplicate/config and deleted exceptions fail", (t) => {
  const f = fixture(t);
  f.put("src/calendar/calendar-types.ts");
  f.put("src/documents/calendar-types.js");
  assert.equal(f.check().warnings.length, 1);
  f.rules.legacyRootFiles.push(
    record("src/Removed.ts"),
    record("src/Removed.ts"),
  );
  assert.ok(has(f.check(), "stale-exception"));
  assert.ok(has(f.check(), "config"));
  f.rules.legacyDuplicateGroups.push({
    paths: ["src/calendar/calendar-types.ts", "src/calendar/calendar-types.ts"],
    reason: "Invalid duplicate registration",
  });
  assert.ok(has(f.check(), "config"));
});

test("protected code and non-code fixture bytes and exact paths cannot change", (t) => {
  const f = fixture(t);
  const originals = {
    "tools/offline/convert.mjs": 'import "./names.mjs";\n',
    "tests/fixtures/input.json": '{"protocol":1}\n',
  };
  for (const [path, content] of Object.entries(originals)) {
    f.put(path, content);
    f.rules.fixedFiles.push({
      ...record(path),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  assert.deepEqual(f.check().errors, []);
  f.put("tools/offline/convert.mjs", 'import "./new-names.mjs";\n');
  f.put("tests/fixtures/input.json", '{"protocol":2}\n');
  assert.equal(
    f.check().errors.filter((error) => error.rule === "fixed-bytes").length,
    2,
  );
  renameSync(
    join(f.root, "tools/offline/convert.mjs"),
    join(f.root, "tools/offline/converter.mjs"),
  );
  assert.ok(has(f.check(), "stale-exception"));
});

test("migration phases enforce full lists, preserved basenames, unique destinations and additions", (t) => {
  const f = fixture(t);
  f.put("src/calendar-types.ts");
  f.rules.legacyRootFiles.push(record("src/calendar-types.ts"));
  const manifest = {
    baseline: "test-baseline",
    entries: [
      {
        from: "src/calendar-types.ts",
        to: "src/calendar/calendar-types.ts",
        phase: "P2",
      },
    ],
    additions: [],
  };
  assert.deepEqual(f.check({ manifest, migrationPhase: "P0" }).errors, []);
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P2" }), "manifest-missing"),
  );
  mkdirSync(join(f.root, "src/calendar"));
  renameSync(
    join(f.root, "src/calendar-types.ts"),
    join(f.root, "src/calendar/calendar-types.ts"),
  );
  f.rules.legacyRootFiles = [];
  assert.deepEqual(f.check({ manifest, migrationPhase: "P2" }).errors, []);
  f.put("src/calendar/CalendarTools.ts");
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P2" }), "manifest-unregistered"),
  );
  manifest.additions.push({
    path: "src/calendar/CalendarTools.ts",
    phase: "P2",
    reason: "New fixture source",
  });
  assert.deepEqual(f.check({ manifest, migrationPhase: "P2" }).errors, []);
  manifest.entries.push({
    from: "src/DocumentPanel.tsx",
    to: "src/documents/DocumentPanel.tsx",
    phase: "P2",
  });
  f.put("src/documents/DocumentPanel.tsx");
  assert.deepEqual(f.check({ manifest, migrationPhase: "P2" }).errors, []);
  renameSync(
    join(f.root, "src/documents/DocumentPanel.tsx"),
    join(f.root, "src/documents/Panel.tsx"),
  );
  const renamed = f.check({ manifest, migrationPhase: "P2" });
  assert.ok(has(renamed, "manifest-missing"));
  assert.ok(has(renamed, "manifest-unregistered"));
  renameSync(
    join(f.root, "src/documents/Panel.tsx"),
    join(f.root, "src/documents/DocumentPanel.tsx"),
  );
  manifest.entries[0].to = "src/documents/Panel.tsx";
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P2" }), "manifest-basename"),
  );
  manifest.entries.push({ ...manifest.entries[0] });
  const result = f.check({ manifest, migrationPhase: "P2" });
  assert.ok(has(result, "manifest-origin"));
  assert.ok(has(result, "manifest-destination"));
  assert.ok(has(f.check({ manifest, migrationPhase: "P9" }), "config"));
});

test("migration lists retain registered suites and reject copies even when ordinary rules permit them", (t) => {
  const f = fixture(t);
  for (const path of [
    "tests/registered-conversion.test.mjs",
    "tests/registered-compatibility.test.mjs",
  ]) {
    f.put(path);
    f.rules.fixedFiles.push(record(path));
  }
  f.rules.allowedDirectories.push(record("tests"));
  const manifest = {
    baseline: "test",
    entries: f.rules.fixedFiles.map(({ path }) => ({
      from: path,
      to: path,
      phase: "keep",
    })),
    additions: [],
  };
  assert.deepEqual(f.check({ manifest, migrationPhase: "P0" }).errors, []);
  rmSync(join(f.root, "tests/registered-compatibility.test.mjs"));
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P0" }), "manifest-missing"),
  );
});

test("existing import boundary suite catches direct and concealed SQLite/native Node dependencies", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "shared"));
  mkdirSync(join(f.root, "worker"));
  f.put("server/storage/task-service.mjs");
  f.put("server/db.mjs", 'import "node:sqlite";\n');
  f.put("server/sync/node/git-cli.mjs", 'import "node:child_process";\n');
  f.put("worker/entry.mjs", 'import "../server/storage/task-service.mjs";\n');
  const suite = "tests/storage-import-boundaries.test.mjs";
  mkdirSync(join(f.root, "tests"));
  copyFileSync(
    new URL("../storage-import-boundaries.test.mjs", import.meta.url),
    join(f.root, suite),
  );
  symlinkSync(
    new URL("../../node_modules", import.meta.url),
    join(f.root, "node_modules"),
    "dir",
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () =>
    spawnSync(process.execPath, ["--test", suite], {
      cwd: f.root,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  assert.equal(run().status, 0);
  f.put("server/storage/unregistered-service.mjs");
  f.put(
    "worker/entry.mjs",
    'import "../server/storage/unregistered-service.mjs";\n',
  );
  assert.equal(
    run().status,
    1,
    "a new service is not automatically an external import exception",
  );
  f.put("server/sync/sync-operation-cache.mjs");
  for (const target of [
    "db",
    "sync/node/git-cli",
    "sync/sync-operation-cache",
  ]) {
    f.put("worker/entry.mjs", `import "../server/${target}.mjs";\n`);
    assert.equal(run().status, 1, target);
  }
  f.put("worker/entry.mjs", 'import "../server/storage/task-service.mjs";\n');
  f.put("server/storage/task-service.mjs", 'import "../db.mjs";\n');
  assert.equal(run().status, 1);
  f.put("server/sync/service.mjs", 'import "./sync-operation-cache.mjs";\n');
  f.put("worker/entry.mjs", 'import "../server/sync/service.mjs";\n');
  assert.equal(
    run().status,
    0,
    "the existing portable service may depend indirectly on the cache",
  );
  f.put("server/sync/service.mjs", 'import "./node/git-cli.mjs";\n');
  f.put("worker/entry.mjs", 'import "../server/sync/service.mjs";\n');
  assert.equal(
    run().status,
    1,
    "portable sync cannot conceal a native Node dependency",
  );
});

// Removed artifacts are tracked by their immutable source commit, not exceptions.
test("migration removals reject restored files and overlapping registrations", (t) => {
  const f = fixture(t);
  f.rules.allowedDirectories.push(record("tools/frozen"));
  const path = "tools/frozen/cutover.mjs";
  const manifest = {
    baseline: "test",
    entries: [],
    additions: [],
    removals: [
      {
        path,
        phase: "P3",
        sourceCommit: "7fec065d1adc241da29d54474af06b390d12d72b",
        reason: "full frozen source",
      },
    ],
  };
  assert.deepEqual(f.check({ manifest, migrationPhase: "P3" }).errors, []);
  f.put(path);
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P3" }), "manifest-removal"),
  );
  manifest.entries.push({ from: path, to: path, phase: "keep" });
  assert.ok(
    has(f.check({ manifest, migrationPhase: "P3" }), "manifest-removal"),
  );
});
