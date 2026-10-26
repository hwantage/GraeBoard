import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const POSTGRES_VERSION = 1;
export const POSTGRES_SCHEMA = "graeboard";
export const postgresMigrations = Object.fromEntries(
  ["control", "team"].map((scope) => {
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

export async function inspectPostgres(client, scope) {
  if (!postgresMigrations[scope])
    throw new Error("PostgreSQL scope must be control or team");
  const exists = (
    await client.query(
      "SELECT to_regclass('graeboard.schema_migrations') AS name",
    )
  ).rows[0].name;
  if (!exists) {
    const objects = await client.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='graeboard' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1",
    );
    if (objects.rowCount)
      throw new Error(
        "Unversioned graeboard schema contains data; refusing initialization",
      );
    return 0;
  }
  const rows = (
    await client.query(
      "SELECT scope,version,checksum FROM graeboard.schema_migrations ORDER BY version",
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0].scope !== scope ||
    rows[0].version !== POSTGRES_VERSION
  )
    throw new Error(
      "Unsupported PostgreSQL scope/version or incomplete migration history",
    );
  if (rows[0].checksum !== postgresMigrations[scope].checksum)
    throw new Error("PostgreSQL migration checksum mismatch");
  return rows[0].version;
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
    await afterDdl?.(client);
    await client.query(
      "INSERT INTO schema_migrations(scope,version,checksum,applied_at) VALUES($1,$2,$3,$4)",
      [scope, migration.version, migration.checksum, new Date().toISOString()],
    );
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    begun = false;
    return {
      engine: "postgres",
      scope,
      from: 0,
      to: migration.version,
      applied: !dryRun,
      dryRun,
      checksum: migration.checksum,
    };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
