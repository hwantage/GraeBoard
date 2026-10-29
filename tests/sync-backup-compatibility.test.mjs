import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { openTransferDatabase } from "../scripts/transfer.mjs";
import {
  backupExternal,
  readExternalBackup,
  restoreExternal,
  stateFrom,
} from "../server/storage/external-backup.mjs";
import {
  canonical,
  entityId,
  protocolVersion,
  stateHash,
} from "../server/sync/protocol.mjs";
import { upgradeState } from "../server/sync/versions.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { reduceMany } from "../server/sync/reducer.mjs";
import { materialize } from "../worker/materialize.mjs";
const images = {
  list: async () => [],
  read: async () => null,
  install: async () => {
    throw new Error("Unexpected image");
  },
};

test("released team v1/site v1 backup sources remain supported while normal health and restore targets require current migrations", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  await migratePostgres(f.pool, { scope: "site", teamId: f.teamId });
  await f.pool.query(
    "DROP INDEX graeboard.sync_outbox_team_sequence; DELETE FROM graeboard.schema_migrations WHERE version=2",
  );
  await f.pool.query(
    "DROP TABLE graeboard_site.setup_link_keys,graeboard_site.setup_key_state; DELETE FROM graeboard_site.schema_migrations WHERE version=2",
  );
  const control = new PostgresDatabase(f.pool, {
    scope: "control",
    site: true,
  });
  await assert.rejects(() => f.adapter.health(), /version\/checksum/);
  await assert.rejects(() => control.health(), /version\/checksum/);
  assert.equal(
    (await f.adapter.health({ allowPreviousTeam: true })).version,
    1,
  );
  assert.equal((await control.health({ allowPreviousSite: true })).version, 1);
  const name = "SYNC_REVIEW_BACKUP_SOURCE_URL";
  process.env[name] = f.env.PG_TEAM.connectionString;
  try {
    await assert.rejects(
      () => openTransferDatabase({ engine: "postgres", urlEnv: name }),
      /version\/checksum/,
    );
    for (const scope of ["team", "control"]) {
      const opened = await openTransferDatabase({
        engine: "postgres",
        urlEnv: name,
        scope,
        site: scope === "control",
        backupSource: true,
      });
      await opened.close();
    }
  } finally {
    delete process.env[name];
  }
  const destination = join(f.dir, "old-schema-backup");
  await backupExternal({
    control,
    teams: [{ adapter: f.adapter, teamId: f.teamId, images }],
    destination,
  });
  const backup = await readExternalBackup(destination);
  assert.equal(backup.manifest.version, 2);
  assert.equal(backup.control.tables.setup_link_keys, undefined);
  assert.equal(
    stateHash(stateFrom(backup.teams[0].bundle).state),
    stateHash(f.state),
  );
  assert.equal(
    Number(
      (
        await f.pool.query(
          "SELECT MAX(version) v FROM graeboard.schema_migrations",
        )
      ).rows[0].v,
    ),
    1,
    "backup never migrates its source",
  );
  assert.equal(
    Number(
      (
        await f.pool.query(
          "SELECT MAX(version) v FROM graeboard_site.schema_migrations",
        )
      ).rows[0].v,
    ),
    1,
  );
  await f.pool.query(
    "UPDATE graeboard.schema_migrations SET checksum='tampered'",
  );
  await assert.rejects(
    () => f.adapter.health({ allowPreviousTeam: true }),
    /version\/checksum/,
  );
});

test("backup v3 round trip preserves v2 report cells, pending operations, immutable receipts and conflicts while rotating only local recovery identity", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  await migratePostgres(f.pool, { scope: "site", teamId: f.teamId });
  const initial = upgradeState(f.state),
    identity = { teamId: f.teamId, repoId: f.link.repo_id },
    link = { ...f.link, protocol: 2 };
  const cell = Object.values(initial.entities).find(
    (x) => x.entity === "reportCell" && x.key[2] === "title",
  );
  assert.ok(cell);
  const id = entityId(cell.entity, cell.key),
    operation = (value, opId) =>
      makeOperation({
        link,
        actorRef: f.user.id,
        opId,
        before: { [id]: cell },
        after: {
          [id]: { ...cell, payload: { data: { ...cell.payload.data, value } } },
        },
      });
  const applied = operation("canonical value", "v2-applied"),
    conflict = operation("conflicting scalar value", "v2-conflict");
  const state = reduceMany(initial, [applied, conflict], identity);
  assert.equal(Object.keys(state.conflicts).length, 1);
  const mainId = entityId("cell", [f.taskId, "title"]),
    main = state.entities[mainId];
  const pending = makeOperation({
    link,
    actorRef: f.user.id,
    opId: "v2-pending",
    before: { [mainId]: main },
    after: {
      [mainId]: {
        ...main,
        payload: { ...main.payload, value: "saved local pending input" },
      },
    },
  });
  await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
    await tx.sync.writeState(state, "b".repeat(40));
    await tx.sync.writeLink({
      canonical_head: "b".repeat(40),
      canonical_hash: stateHash(state),
    });
    await tx.sync.enqueue(pending);
    await materialize(tx, f.teamId, {
      state,
      pending: [pending],
      exclusions: [],
    });
  });
  const control = new PostgresDatabase(f.pool, {
      scope: "control",
      site: true,
    }),
    destination = join(f.dir, "v2-protocol-backup");
  await backupExternal({
    control,
    teams: [{ adapter: f.adapter, teamId: f.teamId, images }],
    destination,
  });
  const backup = await readExternalBackup(destination),
    original = stateFrom(backup.teams[0].bundle);
  assert.equal(backup.manifest.version, 3);
  assert.equal(protocolVersion(original.state), 2);
  assert.equal(stateHash(original.state), stateHash(state));
  assert.deepEqual(original.pending, [pending]);
  await f.pool.query("CREATE DATABASE v2_restore");
  const url = new URL(f.env.PG_TEAM.connectionString);
  url.pathname = "/v2_restore";
  const pool = new Pool({ connectionString: url.href });
  try {
    await migratePostgres(pool, {
      scope: "site",
      teamId: f.teamId,
      initialize: true,
    });
    const adapter = new PostgresDatabase(pool, { teamId: f.teamId }),
      restoredControl = new PostgresDatabase(pool, {
        scope: "control",
        site: true,
      });
    const options = {
      source: destination,
      control: restoredControl,
      teams: [
        {
          adapter,
          teamId: f.teamId,
          images,
          profileId: f.link.profile_id,
          installationId: f.link.installation_id,
        },
      ],
    };
    assert.equal(
      (await restoreExternal({ ...options, dryRun: true })).verified,
      true,
    );
    await restoreExternal(options);
    const restored = await adapter.readState(f.teamId),
      restoredLink = await adapter.withTeamTransaction(f.teamId, (tx) =>
        tx.sync.readLink(),
      );
    assert.equal(protocolVersion(restored), 2);
    assert.equal(stateHash(restored), stateHash(state));
    assert.deepEqual(restored.receipts, state.receipts);
    assert.deepEqual(restored.conflicts, state.conflicts);
    assert.deepEqual(await adapter.readPending(f.teamId), [pending]);
    assert.notEqual(restoredLink.writer_epoch, f.link.writer_epoch);
    assert.equal(restoredLink.mode, "recovery");
    assert.equal(
      canonical(restored.entities[id]),
      canonical(state.entities[id]),
    );
    await restoreExternal(options);
    assert.equal(
      stateHash(await adapter.readState(f.teamId)),
      stateHash(state),
    );
  } finally {
    await pool.end();
  }
});
