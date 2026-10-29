import { postgresHistoryVersion } from "../../shared/postgres-schema-version.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const POSTGRES_VERSION = 1;
export const POSTGRES_SCHEMA = "graeboard";
export const postgresMigrations = Object.fromEntries(
  ["control", "team", "site"].map((scope) => {
    const sql = readFileSync(
      new URL(`./postgres/001-${scope}.sql`, import.meta.url),
      "utf8",
    );
    return [
      scope,
      {
        version: POSTGRES_VERSION,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      },
    ];
  }),
);

export const siteKeyMigration = (() => {
  const sql = readFileSync(
    new URL("./postgres/002-site-setup-keys.sql", import.meta.url),
    "utf8",
  );
  return {
    version: 2,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
})();
export const teamMaintenanceMigration = (() => {
  const sql = readFileSync(
    new URL("./postgres/002-team-maintenance.sql", import.meta.url),
    "utf8",
  );
  return {
    version: 2,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
})();
export const accessTokenMigrations = Object.fromEntries(
  [
    ["control", 2],
    ["site", 3],
  ].map(([scope, version]) => {
    const sql = readFileSync(
      new URL(
        `./postgres/00${version}-${scope}-access-tokens.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    return [
      scope,
      {
        version,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      },
    ];
  }),
);
async function applyAccessTokens(client, scope) {
  const migration = accessTokenMigrations[scope];
  const schema = scope === "site" ? "graeboard_site" : "graeboard";
  await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
  await client.query(migration.sql);
  await client.query("INSERT INTO schema_migrations VALUES($1,$2,$3,$4)", [
    scope,
    migration.version,
    migration.checksum,
    new Date().toISOString(),
  ]);
}

async function applyTeamMaintenance(client, from) {
  if (from >= 2) return;
  await client.query("SET LOCAL search_path TO graeboard, pg_catalog");
  await client.query(teamMaintenanceMigration.sql);
  await client.query("INSERT INTO schema_migrations VALUES('team',2,$1,$2)", [
    teamMaintenanceMigration.checksum,
    new Date().toISOString(),
  ]);
}

export async function inspectPostgres(client, scope) {
  if (!postgresMigrations[scope])
    throw new Error("PostgreSQL scope must be control, team or site");
  const schema = scope === "site" ? "graeboard_site" : "graeboard";
  const exists = (
    await client.query(
      `SELECT to_regclass('${schema}.schema_migrations') AS name`,
    )
  ).rows[0].name;
  if (!exists) {
    const objects = await client.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1",
      [schema],
    );
    if (objects.rowCount)
      throw new Error(
        `Unversioned ${schema} schema contains data; refusing initialization`,
      );
    return 0;
  }
  const rows = (
    await client.query(
      `SELECT scope,version,checksum FROM ${schema}.schema_migrations ORDER BY version`,
    )
  ).rows;
  return postgresHistoryVersion(rows, scope, {
    allowPreviousSite: true,
    allowPreviousTeam: true,
    allowPreviousControl: true,
  });
}

export async function migratePostgres(
  pool,
  {
    scope,
    initialize = false,
    dryRun = false,
    teamId,
    teamName = "GraeBoard",
    afterDdl,
  } = {},
) {
  if (scope === "site")
    return migrateSite(pool, {
      initialize,
      dryRun,
      teamId,
      teamName,
      afterDdl,
    });
  if (!postgresMigrations[scope])
    throw new Error("PostgreSQL scope must be control or team");
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    // Serialize deployment commands, including their initial absence check.
    await client.query("SELECT pg_advisory_xact_lock(214701, 1)");
    const from = await inspectPostgres(client, scope);
    if (from) {
      if (scope === "team" && teamId) {
        const identity = (
          await client.query(
            "SELECT team_id FROM graeboard.team_meta WHERE singleton=1",
          )
        ).rows[0];
        if (identity?.team_id !== teamId)
          throw new Error("PostgreSQL team identity mismatch");
      }
      if (from < 2) {
        if (scope === "team") await applyTeamMaintenance(client, from);
        else await applyAccessTokens(client, "control");
        await afterDdl?.(client);
        await client.query(dryRun ? "ROLLBACK" : "COMMIT");
        begun = false;
        return {
          engine: "postgres",
          scope,
          from,
          to: 2,
          applied: !dryRun,
          dryRun,
          checksum: (scope === "team"
            ? teamMaintenanceMigration
            : accessTokenMigrations.control
          ).checksum,
        };
      }
      await client.query("ROLLBACK");
      begun = false;
      return {
        engine: "postgres",
        scope,
        from,
        to: from,
        applied: false,
        dryRun,
      };
    }
    if (!initialize)
      throw new Error("Empty PostgreSQL schema requires --initialize");
    if (scope === "team" && !teamId)
      throw new Error(
        "Team initialization requires --team-id with the existing internal UUID",
      );
    if (
      teamId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        teamId,
      )
    )
      throw new Error("Invalid team UUID");
    await client.query("CREATE SCHEMA IF NOT EXISTS graeboard");
    await client.query("SET LOCAL search_path TO graeboard, pg_catalog");
    await client.query(
      "CREATE TABLE schema_migrations(scope TEXT NOT NULL,version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
    );
    const migration = postgresMigrations[scope];
    await client.query(migration.sql);
    if (scope === "team") {
      await client.query(
        "INSERT INTO teams(id,name,settings) VALUES($1,$2,'{}')",
        [teamId, teamName],
      );
      await client.query(
        "INSERT INTO team_meta(singleton,team_id) VALUES(1,$1)",
        [teamId],
      );
    }
    await client.query(
      "INSERT INTO schema_migrations(scope,version,checksum,applied_at) VALUES($1,$2,$3,$4)",
      [scope, migration.version, migration.checksum, new Date().toISOString()],
    );
    if (scope === "team") await applyTeamMaintenance(client, 1);
    else await applyAccessTokens(client, "control");
    await afterDdl?.(client);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    begun = false;
    return {
      engine: "postgres",
      scope,
      from: 0,
      to: 2,
      applied: !dryRun,
      dryRun,
      checksum:
        scope === "team"
          ? teamMaintenanceMigration.checksum
          : accessTokenMigrations.control.checksum,
    };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// A new external installation owns one team and one PostgreSQL database. Keep
// the released control/team migrations unchanged for existing installations.
async function migrateSite(
  pool,
  { initialize, dryRun, teamId, teamName, afterDdl },
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      teamId || "",
    )
  )
    throw new Error(
      "Site initialization requires --team-id with the existing internal UUID",
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(214701, 1)");
    const from = await inspectPostgres(client, "site");
    const teamVersion = await inspectPostgres(client, "team");
    if (from) {
      const site = (
        await client.query(
          "SELECT team_id FROM graeboard_site.site_meta WHERE singleton=1",
        )
      ).rows[0];
      const team =
        teamVersion &&
        (
          await client.query(
            "SELECT team_id FROM graeboard.team_meta WHERE singleton=1",
          )
        ).rows[0];
      if (site?.team_id !== teamId || team?.team_id !== teamId)
        throw new Error("PostgreSQL site/team identity mismatch");
      if (from < 2) {
        await client.query(
          "SET LOCAL search_path TO graeboard_site, pg_catalog",
        );
        await client.query(siteKeyMigration.sql);
        await afterDdl?.(client);
        await client.query(
          "INSERT INTO schema_migrations VALUES('site',2,$1,$2)",
          [siteKeyMigration.checksum, new Date().toISOString()],
        );
      }
      if (from < 3) {
        await applyAccessTokens(client, "site");
        await afterDdl?.(client);
      }
      if (teamVersion < 2) {
        await applyTeamMaintenance(client, teamVersion);
        await afterDdl?.(client);
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return {
        engine: "postgres",
        scope: "site",
        from,
        to: 3,
        applied: (from < 3 || teamVersion < 2) && !dryRun,
        dryRun,
        teamFrom: teamVersion,
        teamTo: 2,
      };
    }
    if (teamVersion) {
      const team = (
        await client.query(
          "SELECT team_id FROM graeboard.team_meta WHERE singleton=1",
        )
      ).rows[0];
      if (team?.team_id !== teamId)
        throw new Error("PostgreSQL team identity mismatch");
      if (initialize)
        throw new Error(
          "Existing team database: omit --initialize to add the site schema; data preserved",
        );
    } else if (!initialize)
      throw new Error("Empty PostgreSQL site requires --initialize");
    for (const scope of teamVersion ? ["site"] : ["site", "team"]) {
      const schema = scope === "site" ? "graeboard_site" : "graeboard";
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      await client.query(
        "CREATE TABLE schema_migrations(scope TEXT NOT NULL,version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
      );
      await client.query(postgresMigrations[scope].sql);
      await client.query("INSERT INTO schema_migrations VALUES($1,1,$2,$3)", [
        scope,
        postgresMigrations[scope].checksum,
        new Date().toISOString(),
      ]);
    }
    if (!teamVersion) {
      await client.query(
        "INSERT INTO graeboard.teams(id,name,settings) VALUES($1,$2,'{}')",
        [teamId, teamName],
      );
      await client.query("INSERT INTO graeboard.team_meta VALUES(1,$1)", [
        teamId,
      ]);
    }
    await client.query(
      "INSERT INTO graeboard_site.site_meta(singleton,team_id) VALUES(1,$1)",
      [teamId],
    );
    await client.query("SET LOCAL search_path TO graeboard_site, pg_catalog");
    await client.query(siteKeyMigration.sql);
    await client.query("INSERT INTO schema_migrations VALUES('site',2,$1,$2)", [
      siteKeyMigration.checksum,
      new Date().toISOString(),
    ]);
    await applyAccessTokens(client, "site");
    await applyTeamMaintenance(client, teamVersion || 1);
    await afterDdl?.(client);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return {
      engine: "postgres",
      scope: "site",
      from: 0,
      to: 3,
      applied: !dryRun,
      dryRun,
      teamFrom: teamVersion,
      teamTo: 2,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
