import {
  existsSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { migrateSqlite } from "../server/migrations/sqlite.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import {
  sqliteSheetCloneConversion,
  postgresSheetCloneConversion,
  convertExport,
} from "../server/migrations/sheet-clone/convert.mjs";

const help = `Usage: npm run migrate -- --engine sqlite --database /absolute/path.sqlite [--site-origin https://origin ...] [--dry-run] [--initialize]
       npm run migrate -- --engine postgres --scope control --url-env PG_CONTROL_URL [--initialize] [--dry-run]
       npm run migrate -- --engine postgres --scope team --url-env PG_TEAM_URL --team-id <existing-uuid> [--site-origin https://origin ...] [--initialize] [--dry-run]
       npm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id <existing-uuid> [--site-origin https://origin ...] [--initialize] [--dry-run]
       npm run migrate -- --engine export --input /path/export-v6.json --output /path/export-v7.json [--site-origin https://origin ...] [--dry-run]

SQLite upgrades v29/v30/v31/v32/v33 to v34, or initializes a new empty database with --initialize.
PostgreSQL upgrades control v1 to v2 and team v1/v2 to v3, or initializes the dedicated graeboard schema with --initialize.
The site scope upgrades site v1/v2 to v3 and team v1/v2 to v3, or atomically initializes graeboard_site and graeboard in one database for one external team.
SQLite v34 and team v3 convert the stored sheet clone names, links and synchronization state (SheetClone).
--site-origin (repeatable) names an origin of this deployment whose absolute /links/ addresses are converted too;
use the same list for both sites of a team. Relative addresses are always converted.
A SQLite --dry-run converts a temporary copy and prints the result; the source file is only read.
The export engine converts a JSON export of schemaVersion 6 into a new v7 file and never overwrites one; with --dry-run it only prints the result.
For an existing team database without graeboard_site, omit --initialize to add the site schema, apply required team migrations, and preserve business data.
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
      "site-origin": { type: "string", multiple: true, default: [] },
      input: { type: "string" },
      output: { type: "string" },
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
    const convert = sqliteSheetCloneConversion({
      origins: values["site-origin"],
    });
    // A dry-run must not create the requested file or change its journal mode.
    // An existing database is copied consistently and the copy converted.
    let scratch = null,
      target = values["dry-run"] && !exists ? ":memory:" : path;
    if (values["dry-run"] && exists) {
      scratch = mkdtempSync(join(tmpdir(), "graeboard-migrate-dry-run-"));
      const source = new DatabaseSync(path, { readOnly: true });
      try {
        source.exec(
          `VACUUM INTO '${join(scratch, "copy.sqlite").replaceAll("'", "''")}'`,
        );
      } finally {
        source.close();
      }
      target = join(scratch, "copy.sqlite");
    }
    const db = new DatabaseSync(target);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const result = migrateSqlite(db, {
        initialize: values.initialize,
        dryRun: values["dry-run"] && !exists,
        convert,
      });
      if (!exists && !values["dry-run"]) chmodSync(path, 0o600);
      console.log(
        JSON.stringify(
          {
            engine: "sqlite",
            database: path,
            ...result,
            ...(scratch ? { applied: false, dryRun: true } : {}),
          },
          null,
          2,
        ),
      );
    } finally {
      db.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
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
        convert: postgresSheetCloneConversion({
          origins: values["site-origin"],
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await pool.end();
    }
  } else if (values.engine === "export") {
    if (!values.input || !values.output)
      throw new Error("The export engine requires --input and --output");
    const output = resolve(values.output);
    if (existsSync(output)) throw new Error("Refusing to overwrite " + output);
    const converted = convertExport(
      JSON.parse(readFileSync(resolve(values.input), "utf8")),
      { origins: values["site-origin"] },
    );
    if (!values["dry-run"])
      writeFileSync(output, JSON.stringify(converted.export), {
        flag: "wx",
        mode: 0o600,
      });
    console.log(
      JSON.stringify(
        {
          engine: "export",
          output,
          from: 6,
          to: 7,
          links: converted.links,
          kept: converted.kept,
          ...(values["dry-run"] ? { applied: false, dryRun: true } : {}),
        },
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Specify --engine sqlite, postgres or export; use --help for examples",
    );
}
main().catch((error) => {
  // Driver errors can contain SQL/connection detail. Only known local validation
  // messages are printed verbatim; PostgreSQL diagnostics use safe error codes.
  console.error(
    error.code === "SHEET_CLONE_PREFLIGHT"
      ? error.message
      : error.code
        ? `Migration failed (${String(error.code).replace(/[^A-Z0-9_]/g, "")}); transaction rolled back. Check database access and schema with the deployment administrator.`
        : error.message,
  );
  process.exitCode = 1;
});
