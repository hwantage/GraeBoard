// Optional Deno compatibility/CPU hot-path probe. The PG/Git benchmark produces
// this entirely synthetic input. It supplements, never replaces, the actual
// external capture/receive/materialize/publish integration tests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, input] = Deno.args;
assert.ok(
  root && input,
  "deno run --allow-read --node-modules-dir=manual --no-config --no-lock tests/worker-sheet-clone-sync-deno.mjs <source-root> <synthetic-input.json>",
);
// A supplied source root may be a historical BASE archive or the current app.
const currentModules = {
  "server/sync/protocol.mjs": "server/sync/core/protocol.mjs",
  "server/sync/reducer.mjs": "server/sync/core/reducer.mjs",
  "server/sync/sync-operation-cache.mjs":
    "server/sync/core/sync-operation-cache.mjs",
  "shared/sync-team-store.mjs": "shared/sync/sync-team-store.mjs",
  "shared/sync-capacity.mjs": "shared/sync/sync-capacity.mjs",
};
const sourcePath = (file) => {
  const current = join(resolve(root), currentModules[file] || file);
  return existsSync(current) ? current : join(resolve(root), file);
};
const moduleAt = (file) => pathToFileURL(sourcePath(file));
const protocol = await import(moduleAt("server/sync/protocol.mjs")),
  { project, reduceMany } = await import(moduleAt("server/sync/reducer.mjs")),
  { prepareStatePatch } = await import(moduleAt("shared/sync-team-store.mjs")),
  { assertStateCapacity, assertStateCapacityFrom } = await import(
    moduleAt("shared/sync-capacity.mjs")
  );
const cachePath = sourcePath("server/sync/sync-operation-cache.mjs");
const cache = existsSync(cachePath)
  ? await import(pathToFileURL(cachePath))
  : null;
const fixture = JSON.parse(await Deno.readTextFile(input)),
  texts = fixture.operations.map(protocol.canonical),
  initial = protocol.emptyState();
initial.entities[protocol.entityId("protocol", [])] = protocol.protocolMarker(
  3,
  "synthetic-marker",
);
const initialSize = assertStateCapacity(initial),
  initialSum = protocol.stateSum(initial);
const work = () => {
  const read = () => texts.map(cache?.parseSyncOperation || JSON.parse);
  for (let i = 0; i < 3; i++) {
    // Image candidate projection and site materialization each replay P.
    project(initial, read());
    project(initial, read());
  }
  const operations = read(),
    final = reduceMany(initial, operations);
  for (const op of operations)
    assert.equal(final.receipts[op.opId].result, "applied");
  protocol.stateSumFrom(initialSum, initial, final);
  assertStateCapacityFrom(initial, initialSize, final);
  const event = protocol.canonical({ protocol: 3, operations });
  prepareStatePatch(initial, final);
  return {
    eventBytes: new TextEncoder().encode(event).length,
    hash: protocol.stateHash(final),
  };
};
const samples = [];
let result;
for (let i = 0; i < 4; i++) {
  const start = performance.now();
  result = cache ? cache.withSyncOperationCache(work) : work();
  samples.push(performance.now() - start);
}
console.log(
  JSON.stringify({
    deno: Deno.version,
    cached: !!cache,
    fixture: fixture.fixture,
    coldMs: samples[0],
    warmMs: samples.slice(1),
    ...result,
  }),
);
