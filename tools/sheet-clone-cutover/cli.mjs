import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { GitCliTransport } from "../../server/sync/git-cli.mjs";
import { profileToken } from "../../server/sync/credentials.mjs";
import { convertExport } from "./convert.mjs";
import { convertInternalOnly, runCutover } from "./cutover.mjs";

const help = `Usage: npm run cutover:sheet-clone -- --database /absolute/internal.sqlite --pg-url-env PG_SITE_URL --team-id <uuid>
         [--pg-scope site|team] [--site-origin https://origin ...] (--dry-run | --journal /absolute/run-directory)
       npm run cutover:sheet-clone -- --database /absolute/internal.sqlite [--site-origin https://origin ...] [--dry-run]
       npm run cutover:sheet-clone -- export --input /path/export-v6.json --output /path/export-v7.json [--site-origin https://origin ...] [--dry-run]

One-time SheetClone cutover of one team while every site is stopped (docs/OPERATIONS.md).
It converts the internal SQLite database (v29-v33 to v34) and the external PostgreSQL team (v1/v2 to v3),
then publishes a boundary commit and a standard checkpoint on the head both sites recorded, and moves both
canonical cursors to that checkpoint. Each database converts in its own transaction; the journal records
every finished stage and the same command resumes from the first unfinished one.
--dry-run converts a copy of the SQLite file and rolls the PostgreSQL conversion back; nothing is written.
With only --database, an installation whose teams never shared history converts its SQLite database alone.
--site-origin (repeatable) names an origin of this deployment whose absolute /links/ addresses are converted too.
The Git repository and token are the internal site's (GRAEBOARD_SYNC_PROFILES, its stored credential).
The PostgreSQL URL is read from the named environment variable, never a command argument.
The export command converts a JSON export of schemaVersion 6 into a new v7 file and never overwrites one.
This tool belongs to the SheetClone cutover release only; it neither backs up nor starts any site.`;

function gitTransport(sqlitePath, teamId) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const link = db
      .prepare("SELECT profile_id FROM team_sync_links WHERE team_id=?")
      .get(teamId);
    const profile = JSON.parse(
      process.env.GRAEBOARD_SYNC_PROFILES || "[]",
    ).find((p) => p.profileId === link?.profile_id && p.teamId === teamId);
    if (!profile)
      throw new Error(
        "The internal site's sync profile for this team is not configured",
      );
    return new GitCliTransport({
      directory: resolve(
        process.env.GRAEBOARD_SYNC_DIR || "data/sync",
        profile.profileId,
      ),
      repository: profile.repository,
      token: profileToken(db, profile),
    });
  } finally {
    db.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const exporting = args[0] === "export";
  const { values } = parseArgs({
    args: exporting ? args.slice(1) : args,
    options: {
      database: { type: "string" },
      "pg-url-env": { type: "string" },
      "pg-scope": { type: "string", default: "site" },
      "team-id": { type: "string" },
      journal: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      "site-origin": { type: "string", multiple: true, default: [] },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return console.log(help);
  if (exporting) {
    if (!values.input || !values.output)
      throw new Error("export requires --input and --output");
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
    return console.log(
      JSON.stringify(
        {
          export: output,
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
  }
  const name = values["pg-url-env"];
  if (!values.database) throw new Error("--database is required; see --help");
  if (!values["team-id"] && !name) {
    const sqlitePath = resolve(values.database);
    if (!existsSync(sqlitePath)) throw new Error("Database does not exist");
    return console.log(
      JSON.stringify(
        {
          database: sqlitePath,
          ...convertInternalOnly({
            sqlitePath,
            origins: values["site-origin"],
            dryRun: values["dry-run"],
          }),
        },
        null,
        2,
      ),
    );
  }
  if (!values["team-id"])
    throw new Error("--team-id is required with --pg-url-env; see --help");
  if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name) || !process.env[name])
    throw new Error("--pg-url-env must name a populated environment variable");
  if (!values["dry-run"] && !values.journal)
    throw new Error("--journal is required unless --dry-run");
  const sqlitePath = resolve(values.database),
    teamId = values["team-id"];
  if (!existsSync(sqlitePath)) throw new Error("Database does not exist");
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: process.env[name],
    max: 2,
    connectionTimeoutMillis: 10000,
  });
  try {
    const result = await runCutover({
      teamId,
      sqlitePath,
      pool,
      pgScope: values["pg-scope"],
      transport: gitTransport(sqlitePath, teamId),
      origins: values["site-origin"],
      journalDir: values.journal && resolve(values.journal),
      dryRun: values["dry-run"],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  // Driver errors can carry connection detail; only this tool's own and the
  // conversion's validation messages are printed verbatim.
  console.error(
    ["SHEET_CLONE_CUTOVER", "SHEET_CLONE_PREFLIGHT"].includes(error.code) ||
      !error.code
      ? error.message
      : `Cutover stopped (${String(error.code).replace(/[^A-Z0-9_]/g, "")}); rerun the same command after checking database and Git access.`,
  );
  process.exitCode = 1;
});
