import test from "node:test";
import assert from "node:assert/strict";
import { postgresFixture } from "../../support/business-storage-fixture.mjs";
import {
  migratePostgres,
  postgresMigrations,
  teamMaintenanceMigration,
} from "../../../server/migrations/postgres.mjs";
import { siteKeyMigrationSql } from "../../../scripts/admin/site-key-migration-sql.mjs";
import { stateHash } from "../../../server/sync/core/protocol.mjs";
import { frozenCutoverModule } from "../../support/frozen-cutover-source.mjs";
const { postgresSheetCloneConversion } = await frozenCutoverModule(
  "tools/sheet-clone-cutover/convert.mjs",
);
import {
  revertTeamToV2,
  withoutMarker,
} from "../../support/postgres-legacy-schema.mjs";

const convert = postgresSheetCloneConversion({});

test("actual PostgreSQL team v1 and site v1/v2 upgrade atomically to team v3 without rewriting released history or data", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  // The conversion keeps every record; only the marker names protocol 3 anew.
  const records = async () =>
      stateHash(withoutMarker(await f.adapter.readState(f.teamId))),
    before = await records();
  const resetTeam = async () => {
    if ((await teamVersion()) >= 3) await revertTeamToV2(f.pool);
    await f.pool.query("DROP INDEX graeboard.sync_outbox_team_sequence");
    await f.pool.query(
      "DELETE FROM graeboard.schema_migrations WHERE version=2",
    );
  };
  const teamVersion = async () =>
    Number(
      (
        await f.pool.query(
          "SELECT MAX(version) v FROM graeboard.schema_migrations",
        )
      ).rows[0].v,
    );
  await resetTeam();
  const original = (
    await f.pool.query("SELECT * FROM graeboard.schema_migrations")
  ).rows;
  assert.equal(
    (
      await migratePostgres(f.pool, {
        scope: "team",
        teamId: f.teamId,
        dryRun: true,
        convert,
      })
    ).to,
    3,
  );
  assert.equal(await teamVersion(), 1);
  assert.equal(
    (
      await f.pool.query(
        "SELECT to_regclass('graeboard.sync_outbox_team_sequence') i",
      )
    ).rows[0].i,
    null,
  );
  await assert.rejects(
    () =>
      migratePostgres(f.pool, {
        scope: "team",
        teamId: f.teamId,
        convert,
        afterDdl() {
          throw new Error("index crash");
        },
      }),
    /index crash/,
  );
  assert.equal(await teamVersion(), 1);
  await assert.rejects(
    () => migratePostgres(f.pool, { scope: "team", teamId: f.teamId }),
    /renames stored sheet clone data; convert an existing team with the SheetClone cutover tool/,
  );
  assert.equal(await teamVersion(), 1);
  await migratePostgres(f.pool, { scope: "team", teamId: f.teamId, convert });
  assert.equal(await teamVersion(), 3);
  assert.equal(await records(), before);
  assert.deepEqual(
    (
      await f.pool.query(
        "SELECT * FROM graeboard.schema_migrations WHERE version=1",
      )
    ).rows,
    original,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT checksum FROM graeboard.schema_migrations WHERE version=2",
      )
    ).rows[0].checksum,
    teamMaintenanceMigration.checksum,
  );
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan=off");
    const plan = await client.query(
      "EXPLAIN SELECT local_seq FROM graeboard.sync_outbox WHERE team_id=$1 ORDER BY local_seq DESC LIMIT 1",
      [f.teamId],
    );
    assert.match(JSON.stringify(plan.rows), /sync_outbox_team_sequence/);
    assert.doesNotMatch(JSON.stringify(plan.rows), /Sort|Seq Scan/);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  await resetTeam();
  const created = await migratePostgres(f.pool, {
    scope: "site",
    teamId: f.teamId,
    convert,
  });
  assert.equal(created.teamTo, 3);
  assert.equal(await teamVersion(), 3);
  await f.pool.query(
    "DROP TABLE graeboard_site.access_tokens; DELETE FROM graeboard_site.schema_migrations WHERE version>=3",
  );
  for (const siteVersion of [2, 1]) {
    if (siteVersion === 1)
      await f.pool.query(
        "DROP TABLE graeboard_site.access_tokens; DELETE FROM graeboard_site.schema_migrations WHERE version>=3",
      );
    await resetTeam();
    if (siteVersion === 1) {
      await f.pool.query(
        "DROP TABLE graeboard_site.setup_link_keys,graeboard_site.setup_key_state",
      );
      await f.pool.query(
        "DELETE FROM graeboard_site.schema_migrations WHERE version=2",
      );
    }
    await assert.rejects(
      () =>
        migratePostgres(f.pool, {
          scope: "site",
          teamId: f.teamId,
          convert,
          afterDdl() {
            throw new Error("site crash");
          },
        }),
      /site crash/,
    );
    assert.equal(await teamVersion(), 1);
    assert.equal(
      Number(
        (
          await f.pool.query(
            "SELECT MAX(version) v FROM graeboard_site.schema_migrations",
          )
        ).rows[0].v,
      ),
      siteVersion,
    );
    const result = await migratePostgres(f.pool, {
      scope: "site",
      teamId: f.teamId,
      convert,
    });
    assert.equal(result.teamFrom, 1);
    assert.equal(result.teamTo, 3);
    assert.equal(result.to, 3);
    assert.equal(await records(), before);
  }
  await resetTeam();
  await f.pool.query(siteKeyMigrationSql(f.teamId));
  assert.equal(
    await teamVersion(),
    2,
    "SQL Editor deployment also migrates an existing team v1 atomically; team v3 needs the CLI",
  );
  await f.pool.query(siteKeyMigrationSql(f.teamId));
  assert.equal(await teamVersion(), 2);
  assert.equal(
    (
      await f.pool.query(
        "SELECT checksum FROM graeboard.schema_migrations WHERE version=1",
      )
    ).rows[0].checksum,
    postgresMigrations.team.checksum,
  );
});
