import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceImportGraph } from "../../scripts/testing/source-import-graph.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const portableSync = new Set(
  [
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
  ].map((name) => `server/sync/core/${name}.mjs`),
);
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
const graph = await sourceImportGraph(root, [
  "server",
  "worker",
  "shared",
  "edge",
]);
const isPortableSync = (path) => portableSync.has(path);
const businessServices = new Set([
  "server/storage/control/access-token-service.mjs",
  "server/storage/control/control-service.mjs",
  "server/storage/calendar/calendar-service.mjs",
  "server/storage/documents/document-browser-service.mjs",
  "server/storage/documents/document-service.mjs",
  "server/storage/history/admin-history-service.mjs",
  "server/storage/history/history-service.mjs",
  "server/storage/settings/filter-service.mjs",
  "server/storage/settings/settings-service.mjs",
  "server/storage/tasks/task-command-rules.mjs",
  "server/storage/tasks/task-service.mjs",
  "server/storage/sheet-clones/sheet-clone-command-rules.mjs",
  "server/storage/sheet-clones/sheet-clone-service.mjs",
  "server/storage/transfer/transfer-service.mjs",
]);
const isService = (path) => businessServices.has(path);

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
    if (!/^(?:worker|edge)\//.test(path)) continue;
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
  for (const path of graph.keys())
    if (/^(?:worker|edge)\//.test(path)) visit(path);
  assert.deepEqual(violations, []);
});
