import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sheetCloneSyncFixture } from "../../tests/worker-sheet-clone-sync-fixture.mjs";
import { requirePostgresBinaries } from "../testing/test-postgres.mjs";
import { serviceFor } from "../../worker/sync/sync.mjs";
import { stateHash } from "../../server/sync/core/protocol.mjs";

// Local synthetic data only. Restores the very same PG rows/outbox/Git parent
// between BASE and FIX, rather than comparing independently generated teams.
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    output: {
      type: "string",
      default: "docs/validation/sheet-clone-sync-performance.json",
    },
    backlog: { type: "string", default: "3" },
    "hotpath-output": { type: "string" },
  },
});
assert.ok(
  values.baseline,
  "--baseline must point to a local source archive of the baseline commit",
);
const backlog = Number(values.backlog);
assert.ok(Number.isSafeInteger(backlog) && backlog >= 0 && backlog <= 10);
const bin = requirePostgresBinaries(),
  after = [];
const t = {
  after: (work) => after.push(work),
  skip: (message) => {
    throw new Error(message);
  },
};
try {
  const baseline = await import(
      pathToFileURL(join(resolve(values.baseline), "worker/sync.mjs"))
    ),
    f = await sheetCloneSyncFixture(t);
  for (let i = 0; i < backlog; i++) await f.remoteEdit(i);
  const parent = f.github.text(["rev-parse", "refs/heads/sync-v1"]),
    dump = join(f.dir, "before-sync.sql"),
    connection = f.pg.env.PG_TEAM.connectionString;
  execFileSync(
    join(bin, "pg_dump"),
    [
      "--dbname",
      connection,
      "--data-only",
      "--schema=graeboard",
      "--file",
      dump,
    ],
    { stdio: "pipe" },
  );
  const measure = async (factory) => {
    const cycles = [];
    for (let i = 0; i < 20; i++) {
      const result = await f.run({ serviceFactory: factory });
      cycles.push(result);
      if (!result.pending) break;
    }
    assert.equal(cycles.at(-1).pending, 0);
    const state = await f.pg.adapter.readState(f.teamId),
      link = await f.pg.adapter.readLink(f.teamId);
    assert.equal(
      link.canonical_head,
      f.github.text(["rev-parse", "refs/heads/sync-v1"]),
    );
    assert.equal(link.lease_owner, null);
    for (const op of f.pending)
      assert.equal(state.receipts[op.opId].result, "applied");
    return { cycles, hash: stateHash(state), head: link.canonical_head };
  };
  const base = await measure(baseline.serviceFor);
  // These tables belong to the fixture's fresh, private temporary PostgreSQL.
  const tables = (
    await f.pg.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='graeboard'",
    )
  ).rows;
  await f.pg.pool.query(
    "TRUNCATE " +
      tables
        .map(
          ({ tablename }) => `graeboard."${tablename.replaceAll('"', '""')}"`,
        )
        .join(",") +
      " CASCADE",
  );
  execFileSync(
    join(bin, "psql"),
    ["--dbname", connection, "-X", "--set", "ON_ERROR_STOP=1", "--file", dump],
    { stdio: "pipe" },
  );
  f.github.text(["update-ref", "refs/heads/sync-v1", parent, base.head]);
  const fixed = await measure(serviceFor);
  assert.equal(
    fixed.hash,
    base.hash,
    "same input must retain the exact canonical state and receipt hash",
  );
  await f.verify();
  const summary = (result) => ({
    cycles: result.cycles.length,
    totalCpuMs: result.cycles.reduce((sum, cycle) => sum + cycle.cpuMs, 0),
    peakCpuMs: Math.max(...result.cycles.map((cycle) => cycle.cpuMs)),
    totalWallMs: result.cycles.reduce((sum, cycle) => sum + cycle.wallMs, 0),
    cloneParses: result.cycles.reduce(
      (sum, cycle) => sum + cycle.cloneParses,
      0,
    ),
    receives: result.cycles.map(
      (cycle) =>
        cycle.phases.filter((p) => p.phase === "commitCanonical").length,
    ),
    hash: result.hash,
    head: result.head,
  });
  const report = {
    node: process.version,
    fixture: f.metrics,
    backlog,
    summary: { base: summary(base), fixed: summary(fixed) },
    base,
    fixed,
  };
  if (values["hotpath-output"])
    writeFileSync(
      resolve(values["hotpath-output"]),
      JSON.stringify({ operations: f.pending, fixture: f.metrics }) + "\n",
    );
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("Synthetic PG/Git comparison saved to " + output);
} finally {
  for (const work of after.reverse()) await work();
}
