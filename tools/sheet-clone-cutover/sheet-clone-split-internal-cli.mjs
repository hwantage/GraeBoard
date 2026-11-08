import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { GitCliTransport } from "../../server/sync/git-cli.mjs";
import { profileToken } from "../../server/sync/credentials.mjs";
import {
  absolutePath,
  errorMessage,
  fail,
  requireTeamId,
  splitOrigins,
  transferPath,
} from "./sheet-clone-split-handoff.mjs";
import {
  applyInternal,
  prepareInternal,
} from "./sheet-clone-split-internal.mjs";

const help = `Usage (internal server host, release directory, server stopped):
  npm run cutover:sheet-clone:internal -- prepare --database /abs/internal.sqlite --team-id <uuid>
        [--site-origin https://origin ...] --journal /abs/internal-journal --out /abs/handoff/plan.json
  npm run cutover:sheet-clone:internal -- apply --database /abs/internal.sqlite --team-id <uuid>
        [--site-origin https://origin ...] --journal /abs/internal-journal
        --ready /abs/handoff/external-ready.json --out /abs/handoff/internal-complete.json

The internal half of the SheetClone cutover of one team whose sites cannot
reach each other's database (docs/OPERATIONS.md, separate-site cutover). The
external half is npm run cutover:sheet-clone:external. The phases run in
this order, each once it has the previous phase's file:
  1. internal prepare   -> plan.json
  2. external apply     -> external-ready.json   (external host)
  3. internal apply     -> internal-complete.json
  4. external finalize                           (external host)

prepare   Checks that the team is the only one with shared history, paused,
          with nothing pending or held and no unresolved conflict, converts a
          copy of the SQLite file (the source is only read), and checks the
          Git head, repository identity and recorded result against the
          canonical state. Writes the journal and the plan. Changes nothing.
apply     Takes the external ready file of that plan, checks the database
          and Git again, converts SQLite (v30-v33 to v34) in one transaction
          that commits only the planned state, publishes the boundary and the
          standard checkpoint on the recorded head (compare-and-swap), moves
          the internal cursor to the checkpoint and writes the completion.

Options
  --database     the internal SQLite file (absolute path)
  --team-id      the team's UUID
  --site-origin  repeatable; an origin of a deployment (internal and external)
                 whose absolute /links/ addresses are converted. Every phase
                 of both hosts takes the same list.
  --journal      a new or this cutover's private directory (0700) holding
                 internal-journal.json. Keep it until the cutover is complete.
  --out          the file this phase writes for the other host; outside the
                 journal, never overwritten with another content
  --ready        apply: the external ready file

Environment (the internal server's .env is read when present)
  GRAEBOARD_SYNC_PROFILES  the profile of the team's connection
  GRAEBOARD_SYNC_DIR       its Git cache directory (default data/sync)
  GRAEBOARD_SYNC_KEY       decrypts a credential stored in the database, or the
                           profile's token variable (tokenEnv, GRAEBOARD_GIT_TOKEN)
No PostgreSQL address is used. Rerun the same command after an interruption:
each phase checks the database and Git and continues where it stopped; a
finished phase repeats nothing while the site stays paused. Nothing is backed
up, deleted or reset, and no site is started.`;

const secrets = [];
// The Git repository and token of the team's connection, as the internal
// server reaches them.
function gitTransport(sqlitePath, teamId) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    let link;
    try {
      link = db
        .prepare("SELECT profile_id FROM team_sync_links WHERE team_id=?")
        .get(teamId);
    } catch {
      fail(
        "internal: the database has no synchronization connection to cut over",
      );
    }
    let profiles;
    try {
      profiles = JSON.parse(process.env.GRAEBOARD_SYNC_PROFILES || "[]");
    } catch {
      fail("GRAEBOARD_SYNC_PROFILES is not valid JSON");
    }
    const profile = (Array.isArray(profiles) ? profiles : []).find(
      (p) => p.profileId === link?.profile_id && p.teamId === teamId,
    );
    if (!profile)
      fail(
        "The internal site's sync profile for this team is not configured (GRAEBOARD_SYNC_PROFILES)",
      );
    const transport = new GitCliTransport({
      directory: resolve(
        process.env.GRAEBOARD_SYNC_DIR || "data/sync",
        profile.profileId,
      ),
      repository: profile.repository,
      token: profileToken(db, profile),
    });
    secrets.push(transport.token);
    return {
      transport,
      binding: {
        profileId: profile.profileId,
        repository: transport.repository,
      },
    };
  } finally {
    db.close();
  }
}

async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      database: { type: "string" },
      "team-id": { type: "string" },
      "site-origin": { type: "string", multiple: true, default: [] },
      journal: { type: "string" },
      out: { type: "string" },
      ready: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) return console.log(help);
  const [phase, ...rest] = positionals;
  if (!["prepare", "apply"].includes(phase) || rest.length)
    fail("Name one phase: prepare or apply; see --help");
  if (phase === "prepare" && values.ready !== undefined)
    fail("--ready belongs to apply");
  const sqlitePath = absolutePath(values.database, "--database"),
    teamId = requireTeamId(values["team-id"]),
    origins = splitOrigins(values["site-origin"]),
    journalDir = absolutePath(values.journal, "--journal"),
    out = transferPath(values.out, "--out", journalDir),
    readyPath =
      phase === "apply" && transferPath(values.ready, "--ready", journalDir);
  if (!existsSync(sqlitePath))
    fail(`The database ${sqlitePath} does not exist`);
  const { transport, binding } = gitTransport(sqlitePath, teamId),
    common = {
      sqlitePath,
      teamId,
      journalDir,
      transport,
      binding: { database: sqlitePath, teamId, origins, ...binding },
    };
  const result =
    phase === "prepare"
      ? await prepareInternal({ ...common, origins, planPath: out })
      : await applyInternal({ ...common, readyPath, completionPath: out });
  console.log(JSON.stringify(result, null, 2));
}
main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error, secrets));
  process.exitCode = 1;
});
