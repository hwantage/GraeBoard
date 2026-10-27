import { existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { migrateSqlite } from "../server/migrations/sqlite.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";

const help = `Usage: npm run migrate -- --engine sqlite --database /absolute/path.sqlite [--dry-run] [--initialize]
       npm run migrate -- --engine postgres --scope control --url-env PG_CONTROL_URL --initialize [--dry-run]
       npm run migrate -- --engine postgres --scope team --url-env PG_TEAM_URL --team-id <existing-uuid> --initialize [--dry-run]
       npm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id <existing-uuid> --initialize [--dry-run]

SQLite supports released v29 → v30 → v31, or a new empty database with --initialize.
PostgreSQL initializes the dedicated graeboard schema at control/team version 1.
The site scope upgrades site v1 to v2, or atomically initializes graeboard_site and graeboard in one database for one external team.
For an existing team v1 database, omit --initialize to add only graeboard_site and preserve business data.
--dry-run never commits; SQLite missing-file initialization is validated in memory.
The PostgreSQL URL is read from the named environment variable, never a command argument.
Stop application writers and make a verified backup before an approved operational migration.
This command neither creates a backup nor changes deployment state.`;

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: "string" },
      database: { type: "string" },
      db: { type: "string" },
      scope: { type: "string" },
      "url-env": { type: "string" },
      "team-id": { type: "string" },
      "team-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      initialize: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.engine === "sqlite") {
    const supplied = values.database || values.db;
    if (!supplied || values.scope || values["url-env"])
      throw new Error(
        "SQLite requires explicit --database; PostgreSQL options are not accepted",
      );
    const path = resolve(supplied);
    const exists = existsSync(path);
    if (!exists && !values.initialize)
      throw new Error(
        "Database does not exist; --initialize is required for a new database",
      );
    // A dry-run must not create the requested file or change its journal mode.
    const db = new DatabaseSync(
      values["dry-run"] && !exists ? ":memory:" : path,
      { readOnly: values["dry-run"] && exists },
    );
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const result = migrateSqlite(db, {
        initialize: values.initialize,
        dryRun: values["dry-run"],
      });
      if (!exists && !values["dry-run"]) chmodSync(path, 0o600);
      console.log(
        JSON.stringify(
          { engine: "sqlite", database: path, ...result },
          null,
          2,
        ),
      );
    } finally {
      db.close();
    }
  } else if (values.engine === "postgres") {
    const name = values["url-env"];
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name) || !process.env[name])
      throw new Error(
        "PostgreSQL requires --url-env naming a populated environment variable",
      );
    if (values.database || values.db)
      throw new Error("Use --url-env for PostgreSQL");
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: process.env[name],
      max: 1,
      connectionTimeoutMillis: 10000,
    });
    try {
      const result = await migratePostgres(pool, {
        scope: values.scope,
        initialize: values.initialize,
        dryRun: values["dry-run"],
        teamId: values["team-id"],
        teamName: values["team-name"],
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await pool.end();
    }
  } else
    throw new Error(
      "Specify --engine sqlite or --engine postgres; use --help for examples",
    );
}
main().catch((error) => {
  // Driver errors can contain SQL/connection detail. Only known local validation
  // messages are printed verbatim; PostgreSQL diagnostics use safe error codes.
  console.error(
    error.code
      ? `Migration failed (${String(error.code).replace(/[^A-Z0-9_]/g, "")}); transaction rolled back. Check database access and schema with the deployment administrator.`
      : error.message,
  );
  process.exitCode = 1;
});
