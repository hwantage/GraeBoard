// A separate external process imports the real Git history into a fresh local
// PostgreSQL team DB using the production Worker storage/materializer.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { performance } from "node:perf_hooks";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { SyncService } from "../server/sync/service.mjs";
import { boundStore } from "../worker/sync.mjs";
import { boundedTransport } from "../worker/capacity.mjs";

const config = JSON.parse(process.env.SYNC_IMPORT_PERF_CONFIG || "{}"),
  bin = process.env.TEST_PG_BIN;
if (!bin || !existsSync(join(bin, "postgres")))
  throw new Error(
    "Set TEST_PG_BIN to measure the real external PostgreSQL initial import",
  );
const dir = mkdtempSync("/tmp/gb-import-perf-"),
  data = join(dir, "pg");
let started = false,
  pool;
const command = (name, args) => {
  const result = spawnSync(join(bin, name), args, {
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.status !== 0)
    throw new Error(
      "Temporary PostgreSQL " + name + " failed: " + result.stderr,
    );
};
try {
  command("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-F -h '' -k ${dir} -p 5432`,
    "-w",
    "start",
  ]);
  started = true;
  pool = new Pool({
    host: dir,
    user: process.env.USER,
    database: "postgres",
    max: 2,
  });
  await migratePostgres(pool, {
    scope: "team",
    teamId: config.teamId,
    initialize: true,
  });
  const db = new PostgresDatabase(pool, { teamId: config.teamId }),
    transport = new GitCliTransport({
      directory: join(dir, "git"),
      repository: config.remote,
      allowLocal: true,
    }),
    head = await transport.readHead();
  const manifest = JSON.parse(
    (await transport.readFile(head, "manifest.json")).toString(),
  );
  await db.withTeamTransaction(config.teamId, (tx) =>
    tx.sync.writeLink({
      repo_id: manifest.repoId,
      bootstrap_id: manifest.bootstrapId,
      installation_id: randomUUID(),
      writer_epoch: randomUUID(),
      profile_id: "external-perf",
      mode: "importing",
      updated_at: new Date().toISOString(),
    }),
  );
  const identity = { teamId: config.teamId, repoId: manifest.repoId };
  let capacityRejected = false;
  try {
    await new SyncService({
      transport: boundedTransport(transport),
      store: boundStore(db, config.teamId),
      identity,
    }).run({ receiveOnly: true });
  } catch (error) {
    if (error.code !== "EXTERNAL_SYNC_CAPACITY") throw error;
    capacityRejected = true;
  }
  if (
    !capacityRejected ||
    (await db.readLink(config.teamId)).canonical_head !== null
  )
    throw new Error(
      "Production external capacity guard did not preserve the empty cursor",
    );
  // Explicit Node-only stress override. Production serviceFor cannot select
  // these limits; its hard 32MiB/50k ceiling remains unchanged and tested above.
  const service = new SyncService({
      transport,
      store: boundStore(db, config.teamId, {
        limits: { maxBytes: 128 * 1024 * 1024, maxEntities: 300000 },
      }),
      identity,
    }),
    startedAt = performance.now();
  await service.run({ receiveOnly: true });
  const result = await db.withTeamTransaction(
    config.teamId,
    async (tx) => ({
      head: (await tx.sync.readLink()).canonical_head,
      tasks: Number(
        (
          await tx.query(
            "SELECT COUNT(*) n FROM site_entities WHERE team_id=$1 AND entity='task'",
            [config.teamId],
          )
        ).rows[0].n,
      ),
      documents: Number(
        (
          await tx.query(
            "SELECT COUNT(*) n FROM site_entities WHERE team_id=$1 AND entity='document'",
            [config.teamId],
          )
        ).rows[0].n,
      ),
    }),
    { readOnly: true },
  );
  if (
    result.head !== head ||
    result.tasks !== config.rows ||
    result.documents < 1001
  )
    throw new Error("External initial import head/count verification failed");
  console.log(
    JSON.stringify({
      ...result,
      importMs: performance.now() - startedAt,
      verified: true,
      engine: "actual temporary PostgreSQL; shared storage/materializer",
      runtime:
        "Node-only bulk adapter stress; not supported Cloudflare capacity",
      productionWorkerSupported: false,
      workerLimitsOverriddenForStress: true,
      productionCapacityGuard: {
        rejected: true,
        headUnchanged: true,
        code: "EXTERNAL_SYNC_CAPACITY",
      },
    }),
  );
} finally {
  await pool?.end();
  if (started) command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(dir, { recursive: true, force: true });
}
