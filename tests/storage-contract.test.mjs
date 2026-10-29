import { commitCanonicalForTest } from "./canonical-storage-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { migrateSqlite } from "../server/migrations/sqlite.mjs";
import {
  migratePostgres,
  postgresMigrations,
} from "../server/migrations/postgres.mjs";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { POSTGRES_CHECKSUMS } from "../shared/postgres-schema-version.js";
import { canonical, digest, entityId } from "../server/sync/protocol.mjs";

const link = (teamId) => ({
  repo_id: randomUUID(),
  bootstrap_id: randomUUID(),
  installation_id: randomUUID(),
  writer_epoch: randomUUID(),
  profile_id: teamId,
  mode: "active",
  canonical_head: null,
  updated_at: new Date().toISOString(),
});
const operation = (teamId, opId = randomUUID()) => ({
  protocol: 1,
  reducer: 1,
  teamId,
  repoId: "repository",
  opId,
  writerEpoch: "epoch",
  actorRef: "person",
  createdAt: new Date().toISOString(),
  dependsOn: [],
  objects: [],
  changes: [],
});

function atomic(adapter, team, generator) {
  if (adapter.engine === "sqlite")
    return adapter.withTeamTransaction(team, (tx) => {
      const work = generator(tx);
      let step = work.next();
      while (!step.done) step = work.next(step.value);
      return step.value;
    });
  return adapter.withTeamTransaction(team, async (tx) => {
    const work = generator(tx);
    let step = work.next();
    while (!step.done) step = work.next(await step.value);
    return step.value;
  });
}

async function contract(t, adapter, team) {
  await t.test(
    "canonical JSON/null/arrays, binary objects, immutable outbox and rollback have matching semantics",
    async () => {
      await adapter.withTeamTransaction(team, (tx) =>
        tx.sync.writeLink(link(team)),
      );
      const record = {
        entity: "task",
        key: ["task"],
        generation: "generation",
        version: "v1",
        payload: {
          title: "한글 🙂",
          optional: null,
          enabled: false,
          numbers: [0, 1.25, -2],
        },
        deleted: false,
      };
      const op = operation(team);
      await assert.rejects(
        async () =>
          atomic(adapter, team, function* (tx) {
            yield tx.sync.putEntity(record);
            yield tx.sync.enqueue(op);
            throw new Error("rollback entity and outbox");
          }),
        /rollback entity/,
      );
      assert.deepEqual((await adapter.readState(team)).entities, {});
      assert.deepEqual(await adapter.readPending(team), []);
      const seq = await adapter.withTeamTransaction(team, (tx) =>
        tx.sync.enqueue(op),
      );
      assert.equal(
        await adapter.withTeamTransaction(team, (tx) => tx.sync.enqueue(op)),
        seq,
      );
      await assert.rejects(
        async () =>
          adapter.withTeamTransaction(team, (tx) =>
            tx.sync.enqueue({ ...op, actorRef: "other" }),
          ),
        /Immutable/,
      );
      await adapter.withTeamTransaction(team, (tx) =>
        tx.sync.putEntity(record),
      );
      assert.deepEqual(
        (await adapter.readState(team)).entities[entityId("task", ["task"])],
        record,
      );
      const bytes = new Uint8Array([0, 255, 17, 128, 0]);
      const hash = digest(bytes);
      assert.equal(
        await adapter.withTeamTransaction(team, (tx) =>
          tx.sync.putObject(hash, "image", bytes),
        ),
        true,
      );
      assert.equal(
        await adapter.withTeamTransaction(team, (tx) =>
          tx.sync.putObject(hash, "image", bytes),
        ),
        false,
      );
      assert.deepEqual(
        (
          await adapter.withTeamTransaction(team, (tx) =>
            tx.sync.readObject(hash),
          )
        ).data,
        bytes,
      );
      await assert.rejects(
        async () =>
          adapter.withTeamTransaction(team, (tx) =>
            tx.sync.putObject("0".repeat(64), "image", bytes),
          ),
        /hash mismatch/,
      );
      await assert.rejects(
        async () =>
          adapter.withTeamTransaction(team, (tx) =>
            tx.sync.enqueue(operation("foreign")),
          ),
        /Foreign team/,
      );
    },
  );
  await t.test(
    "canonical apply, receipt, ACK, projection and cursor are atomic and preserve newly pending input",
    async () => {
      const before = await adapter.readState(team),
        [op] = await adapter.readPending(team);
      const later = operation(team);
      await adapter.withTeamTransaction(team, (tx) => tx.sync.enqueue(later));
      const receipt = {
        opId: op.opId,
        payloadHash: digest(op),
        result: "noop",
        conflictId: null,
        outputTokens: {},
      };
      const next = { ...before, receipts: { [op.opId]: receipt } };
      const broken =
        adapter.engine === "sqlite"
          ? () => {
              throw new Error("projection failure");
            }
          : async () => {
              throw new Error("projection failure");
            };
      await assert.rejects(
        async () =>
          commitCanonicalForTest(
            adapter,
            team,
            null,
            "head-1",
            next,
            [op.opId],
            broken,
          ),
        /projection failure/,
      );
      assert.deepEqual(await adapter.readState(team), before);
      assert.equal((await adapter.readPending(team)).length, 2);
      let pendingDuringCommit;
      await commitCanonicalForTest(
        adapter,
        team,
        null,
        "head-1",
        next,
        [op.opId],
        (tx, { pending }) => {
          pendingDuringCommit = pending;
          return tx.sync.appendEvent("canonical", { head: "head-1" });
        },
      );
      assert.deepEqual(pendingDuringCommit, [later]);
      assert.deepEqual(await adapter.readPending(team), [later]);
      assert.equal((await adapter.readLink(team)).canonical_head, "head-1");
      await assert.rejects(
        async () =>
          commitCanonicalForTest(
            adapter,
            team,
            null,
            "head-bad",
            next,
            [],
            () => {},
          ),
        /head changed/,
      );
      assert.equal((await adapter.readLink(team)).canonical_head, "head-1");
      await assert.rejects(
        async () =>
          adapter.withTeamTransaction(team, (tx) =>
            tx.sync.acknowledge([later.opId]),
          ),
        /unverified/,
      );
    },
  );
  await t.test(
    "site retention/revision/events survive snapshot without changing canonical state",
    async () => {
      const before = await adapter.readState(team);
      await adapter.withTeamTransaction(team, (tx) =>
        tx.sync.putExclusion({
          siteId: "site",
          kind: "year",
          key: [2025],
          revision: 1,
          createdAt: "2026-10-27",
        }),
      );
      assert.equal(
        await adapter.withTeamTransaction(team, (tx) =>
          tx.sync.nextRevision("task", ["task"]),
        ),
        1,
      );
      assert.equal(
        await adapter.withTeamTransaction(team, (tx) =>
          tx.sync.nextRevision("task", ["task"]),
        ),
        2,
      );
      const snapshot = await adapter.readSnapshot(team);
      assert.equal(snapshot.exclusions.length, 1);
      assert.ok(snapshot.cursor > 0);
      assert.deepEqual(
        {
          entities: snapshot.entities,
          receipts: snapshot.receipts,
          conflicts: snapshot.conflicts,
        },
        before,
      );
      assert.ok((await adapter.health()).ready);
    },
  );
}

test("SQLite storage contract and synchronous transaction boundary", async (t) => {
  const db = new DatabaseSync(":memory:"),
    team = randomUUID();
  try {
    db.exec("PRAGMA foreign_keys=ON");
    migrateSqlite(db, { initialize: true });
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(team, "계약", "{}");
    const adapter = new SqliteDatabase(db);
    await contract(t, adapter, team);
    assert.throws(
      () => adapter.withTeamTransaction(team, async () => {}),
      /must be synchronous/,
    );
    let escaped;
    adapter.withTeamTransaction(team, (tx) => {
      escaped = tx;
    });
    assert.throws(() => escaped.sync.readState(), /closed/);
    assert.throws(
      () => adapter.withTeamTransaction("foreign", () => {}),
      /Unknown team/,
    );
  } finally {
    db.close();
  }
});

function binary(name) {
  for (const prefix of [
    process.env.TEST_PG_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/lib/postgresql/18/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/bin",
  ].filter(Boolean)) {
    const path = join(prefix, name);
    if (
      existsSync(path) &&
      existsSync(join(dirname(realpathSync(path)), "postgres"))
    )
      return path;
  }
  return null;
}

test("PostgreSQL actual temporary server: migration, same-client transactions and matching storage contract", async (t) => {
  const initdb = binary("initdb"),
    pgctl = binary("pg_ctl");
  if (!initdb || !pgctl) {
    t.skip(
      "Local PostgreSQL binaries unavailable; set TEST_PG_BIN to run the integration contract",
    );
    return;
  }
  const dir = mkdtempSync(
    join(tmpdir().length < 60 ? tmpdir() : "/tmp", "gb-pg-"),
  );
  const data = join(dir, "data"),
    log = join(dir, "postgres.log");
  let pool,
    started = false;
  const command = (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 60000 });
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || String(result.error),
    );
  };
  try {
    command(initdb, ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
    command(pgctl, [
      "-D",
      data,
      "-l",
      log,
      "-o",
      `-F -h '' -k ${dir} -p 5432`,
      "-w",
      "start",
    ]);
    started = true;
    pool = new Pool({
      host: dir,
      port: 5432,
      database: "postgres",
      user: process.env.USER,
      max: 4,
    });
    const team = randomUUID();
    await t.test(
      "DDL rollback/dry-run/init/retry/scope/checksum validation",
      async () => {
        for (const scope of ["control", "team"])
          assert.equal(
            POSTGRES_CHECKSUMS[scope],
            postgresMigrations[scope].checksum,
          );
        const dry = await migratePostgres(pool, {
          scope: "team",
          teamId: team,
          initialize: true,
          dryRun: true,
        });
        assert.equal(dry.applied, false);
        assert.equal(
          (
            await pool.query(
              "SELECT to_regclass('graeboard.schema_migrations') AS name",
            )
          ).rows[0].name,
          null,
        );
        await assert.rejects(
          () =>
            migratePostgres(pool, {
              scope: "team",
              teamId: team,
              initialize: true,
              afterDdl: async (client) => {
                await client.query(
                  "INSERT INTO teams VALUES('sentinel','rollback','{}')",
                );
                throw new Error("injected migration failure");
              },
            }),
          /injected/,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT to_regclass('graeboard.schema_migrations') AS name",
            )
          ).rows[0].name,
          null,
        );
        assert.equal(
          (
            await migratePostgres(pool, {
              scope: "team",
              teamId: team,
              initialize: true,
            })
          ).applied,
          true,
        );
        assert.equal(
          (await migratePostgres(pool, { scope: "team", teamId: team }))
            .applied,
          false,
        );
        await assert.rejects(
          () => migratePostgres(pool, { scope: "control" }),
          /scope\/version/,
        );
        await assert.rejects(
          () => migratePostgres(pool, { scope: "team", teamId: randomUUID() }),
          /identity mismatch/,
        );
        await pool.query(
          "UPDATE graeboard.schema_migrations SET checksum='tampered' WHERE version=1",
        );
        await assert.rejects(
          () => migratePostgres(pool, { scope: "team" }),
          /checksum mismatch/,
        );
        await pool.query(
          "UPDATE graeboard.schema_migrations SET checksum=$1 WHERE version=1",
          [POSTGRES_CHECKSUMS.team],
        );
      },
    );
    const adapter = new PostgresDatabase(pool, { teamId: team });
    await contract(t, adapter, team);
    await t.test(
      "transactions hold one backend across awaits, serialize competing team writes and rollback deferred errors",
      async () => {
        await adapter.withTeamTransaction(team, async (tx) => {
          const first = (await tx.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          await new Promise((resolve) => setTimeout(resolve, 5));
          assert.equal(
            (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            first,
          );
        });
        const revisions = await Promise.all(
          Array.from({ length: 12 }, () =>
            adapter.withTeamTransaction(team, (tx) =>
              tx.sync.nextRevision("concurrent", ["task"]),
            ),
          ),
        );
        assert.deepEqual(
          revisions.toSorted((a, b) => a - b),
          Array.from({ length: 12 }, (_, i) => i + 1),
        );
        const op = operation(team);
        await assert.rejects(
          () =>
            adapter.withTeamTransaction(team, async (tx) => {
              await tx.sync.enqueue(op);
              await Promise.resolve();
              throw new Error("async failure");
            }),
          /async failure/,
        );
        assert.equal(
          (await adapter.readPending(team)).some(
            (item) => item.opId === op.opId,
          ),
          false,
        );
        await assert.rejects(
          () => adapter.withTeamTransaction(randomUUID(), () => {}),
          /identity mismatch/,
        );
        let escaped;
        await adapter.withTeamTransaction(team, (tx) => {
          escaped = tx;
        });
        assert.throws(() => escaped.query("SELECT 1"), /closed/);
      },
    );
    await t.test(
      "repeatable-read snapshot is isolated from concurrent commits",
      async () => {
        let observed, release;
        const hasRead = new Promise((r) => {
          observed = r;
        });
        const gate = new Promise((r) => {
          release = r;
        });
        const reader = adapter.withTeamTransaction(
          team,
          async (tx) => {
            const before = await tx.sync.readPending();
            observed();
            await gate;
            const after = await tx.sync.readPending();
            assert.deepEqual(after, before);
          },
          { readOnly: true },
        );
        await hasRead;
        await adapter.withTeamTransaction(team, (tx) =>
          tx.sync.enqueue(operation(team)),
        );
        release();
        await reader;
      },
    );
    await t.test(
      "control DB is separately initialized and cannot serve team transactions",
      async () => {
        // This is a private disposable cluster; a second database mirrors N+1 projects.
        await pool.query("CREATE DATABASE graeboard_control");
        const controlPool = new Pool({
          host: dir,
          port: 5432,
          database: "graeboard_control",
          user: process.env.USER,
        });
        try {
          await migratePostgres(controlPool, {
            scope: "control",
            initialize: true,
          });
          const control = new PostgresDatabase(controlPool, {
            scope: "control",
          });
          assert.ok((await control.health()).ready);
          await control.withControlTransaction(async (tx) => {
            await tx.query(
              "INSERT INTO users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,'Admin','admin','2026-10-27')",
              ["admin", "admin@example.test"],
            );
            await tx.query(
              "INSERT INTO access_identities VALUES('issuer','subject','admin')",
            );
          });
          assert.throws(
            () => control.withTeamTransaction(team, () => {}),
            /cannot store team/,
          );
          assert.throws(
            () => adapter.withControlTransaction(() => {}),
            /cannot store control/,
          );
        } finally {
          await controlPool.end();
        }
      },
    );
  } finally {
    if (pool) await pool.end();
    if (started) {
      const stopped = spawnSync(
        pgctl,
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(
        stopped.status,
        0,
        stopped.stderr || readFileSync(log, "utf8"),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
