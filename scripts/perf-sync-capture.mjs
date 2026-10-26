// Targeted capture-only regression measurement; no Git publication or cloud I/O.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performanceFixture, percentile } from "./sync-performance.mjs";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { emptyState } from "../server/sync/protocol.mjs";
import { validateSnapshot } from "../server/sync/reducer.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = fileURLToPath(new URL("../", import.meta.url));
const rows = Number(flag("--rows", "10000"));
const clients = Number(flag("--clients", "30"));
const users = Number(flag("--users", "100"));
const rounds = Number(flag("--rounds", "30"));
const output = resolve(
  flag("--output", "docs/validation/perf-sync-capture.json"),
);
assert.equal(
  existsSync(output),
  false,
  "Refusing to overwrite previous evidence",
);
mkdirSync(dirname(output), { recursive: true });
const hash = (file) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, file)))
    .digest("hex");
const aggregate = (runs) => {
  const saves = runs.flatMap((run) => run.timings.saves);
  const sse = runs.flatMap((run) => run.timings.sse);
  return {
    samples: saves.length,
    saveP50Ms: percentile(saves, 0.5),
    saveP95Ms: percentile(saves),
    saveMaxMs: Math.max(...saves),
    commitToAllSseP95Ms: percentile(sse),
    commitToAllSseMaxMs: Math.max(...sse),
    eventLoopWorstRunP95Ms: Math.max(...runs.map((run) => run.eventLoopP95Ms)),
    eventLoopMaxMs: Math.max(...runs.map((run) => run.eventLoopMaxMs)),
  };
};
const report = {
  schemaVersion: 1,
  status: "running",
  startedAt: new Date().toISOString(),
  node: process.version,
  declaredSourceCommit: flag("--source-commit", null),
  observedGitHead: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeStatus: execFileSync(
    "git",
    ["-C", root, "status", "--porcelain"],
    { encoding: "utf8" },
  ),
  sourceHashes: Object.fromEntries(
    [
      "scripts/perf-sync-capture.mjs",
      "scripts/sync-performance.mjs",
      "server/db.mjs",
      "server/app.mjs",
      "server/sync/capture.mjs",
      "server/sync/protocol.mjs",
      "server/sync/entities.mjs",
      "server/sync/reducer.mjs",
      "server/storage/sqlite.mjs",
      "server/storage/sqlite-tasks.mjs",
      "server/storage/task-service.mjs",
      "server/cell-events.mjs",
      "package-lock.json",
    ].map((file) => [file, hash(file)]),
  ),
  dataset: {
    tasks: rows,
    users,
    clients,
    scheduleColumns: 60,
    fillPercent: 30,
    initialDocuments: 1,
    rounds,
    warmupRoundsPerSegment: 3,
    pairs: 3,
    order: [
      "unlinked then linked",
      "linked then unlinked",
      "unlinked then linked",
    ],
  },
  limitations: [
    "Uses unchanged performanceFixture and measure from scripts/sync-performance.mjs; schedule:false, loopback HTTP and dedicated SSE, current runtime paired with itself.",
    "Valid canonical C and a synthetic offline head are seeded outside measurement. No Git publication, initialization, scheduled cycle, large import, backup, remote failure or browser performance is measured here.",
    "The fresh fixture begins with no P backlog; previous full-workflow paired measurement began near93,850 pending operations. This targeted result does not replace that historical whole-workflow evidence.",
    "Per default mode:2700 requests in90 sequential bursts of30, not2700 independent repetitions. Every measured save must reach all30 SSE clients.",
    "Segment metadata and raw serialization happen after timed save/SSE/lag measurement. WAL file length is not uncheckpointed-content size.",
  ],
};
let fixture;
try {
  const setupStarted = performance.now();
  fixture = await performanceFixture({ rows, clients, users });
  assert.equal(fixture.runtimeOptions.schedule, false);
  fixture.setLink("paused");
  const store = fixture.app.locals.sync.store(fixture.teamId);
  function seedCanonical() {
    const link = store.readLink();
    const state = { ...emptyState(), entities: allEntities(fixture.db, link) };
    validateSnapshot(state, { teamId: fixture.teamId, repoId: link.repo_id });
    const head = "a".repeat(40);
    new SqliteDatabase(fixture.db).withTeamTransaction(fixture.teamId, (tx) => {
      tx.sync.writeState(state, head);
      tx.sync.writeLink({ canonical_head: head });
    });
    return Object.keys(state.entities).length;
  }
  report.dataset.canonicalEntities = seedCanonical();
  report.dataset.storedCells = fixture.db
    .prepare("SELECT COUNT(*) count FROM cells")
    .get().count;
  report.setupMs = performance.now() - setupStarted;
  const metadata = () => ({
    pendingCount: fixture.db
      .prepare(
        "SELECT COUNT(*) count FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
      )
      .get(fixture.teamId).count,
    databaseBytes: statSync(fixture.databasePath).size,
    walBytes:
      statSync(fixture.databasePath + "-wal", { throwIfNoEntry: false })
        ?.size || 0,
  });
  report.initialMetadata = metadata();
  assert.equal(report.initialMetadata.pendingCount, 0);
  const pairs = [],
    unlinkedRuns = [],
    linkedRuns = [];
  for (let pair = 0; pair < 3; pair++) {
    const result = { order: report.dataset.order[pair] };
    for (const linked of pair % 2 ? [true, false] : [false, true]) {
      fixture.setLink(linked ? "active" : "disconnected");
      await fixture.measure(3);
      const measured = await fixture.measure(rounds);
      measured.afterSegment = metadata();
      result[linked ? "linked" : "unlinked"] = measured;
      (linked ? linkedRuns : unlinkedRuns).push(measured);
    }
    pairs.push(result);
    console.log(JSON.stringify({ pair: pair + 1, ...result }));
  }
  report.steadyPairs = pairs;
  report.rawPairedTimings = pairs.map((pair) => ({
    order: pair.order,
    burstSize: clients,
    sampleOrder:
      "HTTP completion order inside sequential Promise.all bursts; save/SSE indices align",
    burstRanges: Array.from({ length: rounds }, (_, index) => ({
      burst: index + 1,
      startInclusive: index * clients,
      endExclusive: (index + 1) * clients,
    })),
    unlinked: {
      saveMs: pair.unlinked.timings.saves,
      commitToAllSseMs: pair.unlinked.timings.sse,
    },
    linked: {
      saveMs: pair.linked.timings.saves,
      commitToAllSseMs: pair.linked.timings.sse,
    },
  }));
  report.unlinked = aggregate(unlinkedRuns);
  report.linked = aggregate(linkedRuns);
  report.degradationPercent =
    (report.linked.saveP95Ms / report.unlinked.saveP95Ms - 1) * 100;
  report.acceptance = {
    saveP95DegradationWithin10Percent: report.degradationPercent <= 10,
    allCommitToSseP95Under1000Ms: [...unlinkedRuns, ...linkedRuns].every(
      (run) => run.commitToAllSseP95Ms < 1000,
    ),
  };
  assert.equal(report.unlinked.samples, 3 * rounds * clients);
  assert.equal(report.linked.samples, 3 * rounds * clients);
  report.status = Object.values(report.acceptance).every(Boolean)
    ? "passed"
    : "measured-target-missed";
  console.log(
    JSON.stringify(
      {
        unlinked: report.unlinked,
        linked: report.linked,
        degradationPercent: report.degradationPercent,
        acceptance: report.acceptance,
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await fixture?.close();
  report.completedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({ output, status: report.status, error: report.error }),
  );
}
