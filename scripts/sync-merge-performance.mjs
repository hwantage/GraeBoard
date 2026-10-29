import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mergeMarkdown } from "../server/sync/reducer.mjs";

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};

// Run after all browser/tests workloads stop. CPU covers this Node process,
// while elapsed time also exposes scheduling noise. This does not claim to
// measure a deployed Edge runtime; the caller records that separately.
export function runMergePerformance({ rounds = 10 } = {}) {
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 100);
  const base = "a".repeat(131072) + "b".repeat(131072);
  const scenarios = [1000, 1001].map((count) => {
    const current = "x".repeat(count) + base.slice(count);
    const desired = base.slice(0, -count) + "y".repeat(count);
    const expected =
      count === 1000
        ? "x".repeat(count) + base.slice(count, -count) + "y".repeat(count)
        : null;
    for (let i = 0; i < 3; i++)
      assert.equal(mergeMarkdown(base, current, desired, 2), expected);
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const cpu = process.cpuUsage(),
        started = performance.now();
      const result = mergeMarkdown(base, current, desired, 2);
      const elapsedMs = performance.now() - started,
        used = process.cpuUsage(cpu);
      assert.equal(result, expected);
      samples.push({
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        userCpuMs: used.user / 1000,
        systemCpuMs: used.system / 1000,
      });
    }
    return {
      replacementCharactersPerSide: count,
      editStepsPerDiff: count * 2,
      expected: expected === null ? "conflict" : "merged",
      warmups: 3,
      rounds,
      elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
      cpuMs: summarize(samples.map((sample) => sample.cpuMs)),
      samples,
    };
  });
  return {
    protocol: 2,
    reducer: 2,
    maxEditLength: 2000,
    documentBytes: Buffer.byteLength(base),
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    targetEdgeRuntimeMeasured: false,
    scenarios,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(runMergePerformance(), null, 2));
