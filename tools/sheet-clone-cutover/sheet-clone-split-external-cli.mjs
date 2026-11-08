import { parseArgs } from "node:util";
import { GitCliTransport } from "../../server/sync/git-cli.mjs";
import {
  absolutePath,
  errorMessage,
  fail,
  readArtifact,
  requireTeamId,
  requireValue,
  splitOrigins,
  transferPath,
} from "./sheet-clone-split-handoff.mjs";
import {
  applyExternal,
  finalizeExternal,
} from "./sheet-clone-split-external.mjs";

const help = `Usage (external operator host, release directory, external API stopped):
  npm run cutover:sheet-clone:external -- apply --plan /abs/handoff/plan.json --team-id <uuid>
        [--site-origin https://origin ...] --pg-url-env PG_SITE_URL [--pg-scope site|team]
        --repository owner/repository --git-token-env GIT_TOKEN_VARIABLE --git-dir /abs/git-cache
        (--dry-run | --journal /abs/external-journal --out /abs/handoff/external-ready.json)
  npm run cutover:sheet-clone:external -- finalize --completion /abs/handoff/internal-complete.json
        --team-id <uuid> [--site-origin https://origin ...] --pg-url-env PG_SITE_URL [--pg-scope site|team]
        --repository owner/repository --git-token-env GIT_TOKEN_VARIABLE --git-dir /abs/git-cache
        --journal /abs/external-journal

The external half of the SheetClone cutover of one team whose sites cannot
reach each other's database (docs/OPERATIONS.md, separate-site cutover). The
internal half is npm run cutover:sheet-clone:internal. The phases run in
this order, each once it has the previous phase's file:
  1. internal prepare   -> plan.json                (internal host)
  2. external apply     -> external-ready.json
  3. internal apply     -> internal-complete.json   (internal host)
  4. external finalize

apply     Takes the internal plan, converts the PostgreSQL team in a rolled
          back transaction and checks the result, the team, the connection's
          repository, the paused and drained state and the Git head against
          the plan before the first change; then converts it (team v1/v2 to
          v3) in one transaction that commits only the planned state. The
          cursor stays at the recorded head. Writes the journal and the ready
          file. --dry-run does the checks and writes nothing.
finalize  Takes the internal completion and checks in Git that its boundary
          is this plan's on the recorded head and its checkpoint the standard
          checkpoint of the planned state, carried by the remote head; then
          moves the external cursor to the checkpoint in one transaction while
          the site is paused with nothing pending and no conflict.

Options
  --plan / --completion  the file the internal host wrote
  --team-id      the team's UUID (the PostgreSQL team must be this one)
  --site-origin  repeatable; the same list the internal host used
  --pg-url-env   the name of the environment variable holding the PostgreSQL
                 address (with its TLS options); the address is never an
                 argument and never printed
  --pg-scope     site (one database with the site and team schemas, default)
                 or team (a separate team database)
  --repository   the team's synchronization repository, owner/repository
  --git-token-env  the name of the environment variable holding a token that
                 may read the repository (the external host writes nothing to Git)
  --git-dir      a private Git cache directory of this host (created 0700)
  --journal      a new or this cutover's private directory (0700) holding
                 external-journal.json. Keep it until the cutover is complete.
  --out          apply: the ready file for the internal host; outside the
                 journal, never overwritten with another content

The release's .env is read when present; nothing of the internal site
(database, sync key) is needed. Rerun the same command after an
interruption: each phase checks PostgreSQL and Git and continues where it
stopped; a finished phase repeats nothing while the site stays paused.
Nothing is backed up, deleted or reset, and no site is started.`;

const secrets = [];
function environment(name, flag) {
  requireValue(name, flag);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    fail(`${flag} must name an environment variable (A-Z, 0-9, _)`);
  if (!process.env[name]?.trim())
    fail(`${flag}: the environment variable ${name} is empty or not set`);
  secrets.push(process.env[name]);
  return process.env[name];
}

async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      plan: { type: "string" },
      completion: { type: "string" },
      "team-id": { type: "string" },
      "site-origin": { type: "string", multiple: true, default: [] },
      "pg-url-env": { type: "string" },
      "pg-scope": { type: "string", default: "site" },
      repository: { type: "string" },
      "git-token-env": { type: "string" },
      "git-dir": { type: "string" },
      journal: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) return console.log(help);
  const [phase, ...rest] = positionals;
  if (!["apply", "finalize"].includes(phase) || rest.length)
    fail("Name one phase: apply or finalize; see --help");
  const applying = phase === "apply",
    dryRun = values["dry-run"];
  if (
    !applying &&
    (dryRun || values.plan !== undefined || values.out !== undefined)
  )
    fail("--plan, --out and --dry-run belong to apply");
  if (applying && values.completion !== undefined)
    fail("--completion belongs to finalize");
  if (dryRun && (values.journal !== undefined || values.out !== undefined))
    fail("--dry-run writes nothing; omit --journal and --out");
  if (!["site", "team"].includes(values["pg-scope"]))
    fail("--pg-scope must be site or team");
  const teamId = requireTeamId(values["team-id"]),
    origins = splitOrigins(values["site-origin"]),
    pgUrlEnv = values["pg-url-env"],
    connectionString = environment(pgUrlEnv, "--pg-url-env"),
    token = environment(values["git-token-env"], "--git-token-env"),
    gitDir = absolutePath(values["git-dir"], "--git-dir"),
    journalDir = dryRun ? null : absolutePath(values.journal, "--journal");
  // The file handed over is read before anything is reached.
  const input = applying
    ? readArtifact(
        dryRun
          ? absolutePath(values.plan, "--plan")
          : transferPath(values.plan, "--plan", journalDir),
        "plan",
      )
    : readArtifact(
        transferPath(values.completion, "--completion", journalDir),
        "internal-complete",
      );
  const readyPath =
    applying && !dryRun ? transferPath(values.out, "--out", journalDir) : null;
  const transport = new GitCliTransport({
    directory: gitDir,
    repository: requireValue(values.repository, "--repository"),
    token,
  });
  const binding = {
    teamId,
    origins,
    pgUrlEnv,
    pgScope: values["pg-scope"],
    repository: transport.repository,
    gitDir,
  };
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10000,
  });
  // A connection error raised while idle carries no request to fail.
  pool.on("error", () => {});
  try {
    const common = { teamId, origins, pool, transport, journalDir, binding },
      result = applying
        ? await applyExternal({
            ...common,
            plan: input,
            pgScope: values["pg-scope"],
            readyPath,
            dryRun,
          })
        : await finalizeExternal({ ...common, completion: input });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error, secrets));
  process.exitCode = 1;
});
