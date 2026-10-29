import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const portableSync = new Set([
  "protocol",
  "versions",
  "reducer",
  "service",
  "retention",
  "github-api",
  "errors",
  "checkpoint",
  "snapshot",
  "file-entries",
  "operations",
  "projection",
  "directory",
  "setup-keys",
  "branch-publication",
  "maintenance",
]);
function files(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = directory + "/" + entry.name;
      return entry.isDirectory()
        ? files(path)
        : /\.(?:mjs|js)$/.test(path)
          ? [path]
          : [];
    },
  );
}
const { metafile } = await build({
  absWorkingDir: root,
  entryPoints: [...files("server"), ...files("worker"), ...files("shared")],
  bundle: true,
  write: false,
  treeShaking: false,
  format: "esm",
  outdir: "/tmp/graeboard-import-boundary-unused",
  metafile: true,
  logLevel: "silent",
  plugins: [
    {
      name: "imports-only",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.kind === "entry-point"
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
});
const graph = new Map(
  Object.entries(metafile.inputs).map(([path, input]) => [
    path,
    input.imports.map(({ path: value }) =>
      value.startsWith(".")
        ? relative(root, resolve(root, dirname(path), value))
        : value,
    ),
  ]),
);
const isPortableSync = (path) =>
  path.startsWith("server/sync/") && portableSync.has(path.slice(12, -4));
const isService = (path) =>
  /^server\/storage\/[^/]+-(?:service|command-rules)\.mjs$/.test(path);

test("SQLite hosts and shared modules never import the external host; PostgreSQL repositories live only under worker/storage", () => {
  const violations = [];
  for (const [path, targets] of graph) {
    if (!/^(?:server|shared)\//.test(path)) continue;
    for (const target of targets)
      if (target.startsWith("worker/")) violations.push(`${path} -> ${target}`);
  }
  assert.deepEqual(violations, []);
  assert.equal(
    files("server/storage").some((path) => /\/postgres[^/]*\.mjs$/.test(path)),
    false,
  );
});

test("external imports cross only into portable synchronization, common business services/rules and shared modules", () => {
  const violations = [];
  for (const [path, targets] of graph) {
    if (!path.startsWith("worker/")) continue;
    for (const target of targets)
      if (
        target.startsWith("server/") &&
        !isPortableSync(target) &&
        !isService(target)
      )
        violations.push(`${path} -> ${target}`);
  }
  // Check the entire local dependency closure too: an allowed service cannot
  // conceal a native SQLite or Node process import behind another helper.
  const visited = new Set();
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    for (const target of graph.get(path) || []) {
      if (
        /^(?:node:)?(?:sqlite|fs(?:\/promises)?|child_process|worker_threads)$/.test(
          target,
        )
      )
        violations.push(`${path} -> ${target}`);
      if (graph.has(target)) visit(target);
    }
  }
  for (const path of graph.keys()) if (path.startsWith("worker/")) visit(path);
  assert.deepEqual(violations, []);
});
