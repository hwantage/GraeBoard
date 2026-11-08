import {
  inspectPostgres,
  migratePostgres,
} from "../../server/migrations/postgres.mjs";
import pg from "pg";
import { digest, stateSum } from "../../server/sync/protocol.mjs";
import { PostgresDatabase } from "../../worker/storage/postgres.mjs";
import { postgresSheetCloneConversion } from "./convert.mjs";
import { CONVERSION } from "./names.mjs";
import {
  SPLIT_FORMAT,
  SPLIT_VERSION,
  artifactDigest,
  assertBase,
  checkConverted,
  checkCursor,
  checkDrained,
  checkLink,
  checkPlan,
  checkProof,
  checkpointProblem,
  expecting,
  fail,
  isPlanBoundary,
  matchPlan,
  newJournal,
  openJournal,
  recordStage,
  remoteStage,
  splitToolDigest,
  syncOf,
  tableProof,
  writeArtifact,
  writeJournal,
} from "./sheet-clone-split-handoff.mjs";

// The external operator's two phases of the split cutover (handoff module):
// apply converts PostgreSQL to the internal plan before anything reaches Git
// and leaves the cursor at the recorded head; finalize, once the internal
// site has published the boundary and the checkpoint, checks them in Git and
// moves the external cursor to the checkpoint. Neither phase reads SQLite.
const SITE = "external";

// Which PostgreSQL the journal was written against: the database and, where
// the role may read it, the cluster's system identifier. Never the URL.
export async function postgresTarget(pool) {
  const database = (await pool.query("SELECT current_database() AS name"))
    .rows[0].name;
  let system = null;
  try {
    system = (
      await pool.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()",
      )
    ).rows[0].id;
  } catch {}
  // Managed PostgreSQL often denies pg_control_system(). The effective
  // endpoint still distinguishes equal database names on different hosts;
  // store only its digest, never the URL, user or host in the journal.
  const parameters = new pg.Client(pool.options).connectionParameters;
  return {
    database,
    system,
    endpoint: digest({
      host: parameters.host,
      port: parameters.port,
      database: parameters.database,
      user: parameters.user,
    }),
  };
}
async function teamVersion(pool, scope, teamId) {
  const client = await pool.connect();
  try {
    if (scope === "site") {
      const version = await inspectPostgres(client, "site");
      if (!version)
        fail(
          "external: --pg-scope site requires an existing site schema; use --pg-scope team for a separate team database",
        );
      if (
        version &&
        (
          await client.query(
            "SELECT team_id FROM graeboard_site.site_meta WHERE singleton=1",
          )
        ).rows[0]?.team_id !== teamId
      )
        fail("external: PostgreSQL site/team identity mismatch");
    }
    return await inspectPostgres(client, "team");
  } finally {
    client.release();
  }
}
async function postgresProof(client, { lock = false, scope = "team" } = {}) {
  const tables = (
    await client.query(
      "SELECT schemaname schema,tablename name FROM pg_tables WHERE schemaname=ANY($1::text[]) AND tablename<>'schema_migrations' ORDER BY schemaname,tablename",
      [scope === "site" ? ["graeboard", "graeboard_site"] : ["graeboard"]],
    )
  ).rows;
  const quote = ({ schema, name }) =>
    `"${schema}"."${name.replaceAll('"', '""')}"`;
  if (lock && tables.length)
    await client.query(
      `LOCK TABLE ${tables.map(quote).join(",")} IN SHARE ROW EXCLUSIVE MODE`,
    );
  const proofs = [];
  for (const table of tables) {
    const [, hashes] = tableProof(
      table.name,
      (await client.query(`SELECT * FROM ${quote(table)}`)).rows,
    );
    proofs.push([`${table.schema}.${table.name}`, hashes]);
  }
  return digest(proofs);
}
// The team's synchronization rows in one transaction of the given database.
async function readTeam(tx, teamId) {
  const count = async (sql) =>
    Number((await tx.query(sql, [teamId])).rows[0].n);
  return {
    link: await tx.sync.readLink(),
    state: await tx.sync.readState(),
    pending: await count(
      "SELECT COUNT(*) n FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged'",
    ),
    conflicts: await count(
      "SELECT COUNT(*) n FROM sync_conflicts WHERE team_id=$1 AND resolution IS NULL",
    ),
    jobs: await count(
      "SELECT COUNT(*) n FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
    ),
    bootstrap: await tx.sync.readBootstrap(),
  };
}
function checkJournalTarget(journal, plan, target) {
  if (!journal) return;
  if (journal.planDigest !== artifactDigest(plan))
    fail("external: this journal belongs to another plan");
  if (JSON.stringify(journal.target) !== JSON.stringify(target))
    fail(
      "external: the PostgreSQL database differs from the one this journal converted",
    );
}

export async function applyExternal({
  plan,
  teamId,
  origins,
  pool,
  pgScope,
  transport,
  journalDir,
  readyPath,
  binding,
  dryRun = false,
  hooks,
}) {
  checkPlan(plan, { teamId, origins }, SITE);
  const target = await postgresTarget(pool),
    store = new PostgresDatabase(pool, { teamId }),
    options = { origins: plan.origins },
    from = await teamVersion(pool, pgScope, teamId);
  // A dry run writes nothing, not even a journal.
  let journal = dryRun
    ? null
    : openJournal(journalDir, SITE, binding, { create: true });
  checkJournalTarget(journal, plan, target);
  let preview = null,
    sourceProof;
  if (from < 3) {
    // Every check, and the conversion rolled back, before the first change.
    preview = await migratePostgres(pool, {
      scope: pgScope,
      teamId,
      dryRun: true,
      convert: async (client) => {
        const link = (
          await client.query(
            "SELECT * FROM graeboard.team_sync_links WHERE team_id=$1",
            [teamId],
          )
        ).rows[0];
        checkLink(link, plan, SITE);
        checkDrained({ link, bootstrap: link.bootstrap_bundle }, SITE);
        sourceProof = await postgresProof(client, {
          lock: true,
          scope: pgScope,
        });
        return postgresSheetCloneConversion(options)(client);
      },
    });
    matchPlan(syncOf(preview, teamId, SITE), plan, SITE);
    const team = await store.withTeamTransaction(
      teamId,
      (tx) => readTeam(tx, teamId),
      { readOnly: true },
    );
    checkLink(team.link, plan, SITE);
    await assertBase(transport, plan, () => stateSum(team.state), SITE);
    if (dryRun)
      return {
        phase: "external-apply",
        dryRun: true,
        teamId,
        baseHead: plan.baseHead,
        resultHash: plan.resultHash,
        fromProtocol: plan.fromProtocol,
        toProtocol: plan.toProtocol,
        postgres: { teamFrom: from, teamTo: 3 },
        external: preview.conversion,
        next: "Nothing was written; run the same command without --dry-run to convert.",
      };
    if (!journal) {
      journal = newJournal(SITE, binding, plan, {
        target,
        teamFrom: from,
        sourceProof,
      });
      writeJournal(journalDir, journal);
    }
    checkProof(sourceProof, journal.sourceProof, SITE);
    await hooks?.before?.("convert");
    await assertBase(transport, plan, () => stateSum(team.state), SITE);
    await migratePostgres(pool, {
      scope: pgScope,
      teamId,
      convert: async (client) => {
        const link = (
          await client.query(
            "SELECT * FROM graeboard.team_sync_links WHERE team_id=$1",
            [teamId],
          )
        ).rows[0];
        checkLink(link, plan, SITE);
        checkDrained({ link, bootstrap: link.bootstrap_bundle }, SITE);
        checkProof(
          await postgresProof(client, { lock: true, scope: pgScope }),
          journal.sourceProof,
          SITE,
        );
        const result = await expecting(
          postgresSheetCloneConversion(options),
          plan,
          SITE,
        )(client);
        journal.convertedProof = await postgresProof(client, {
          scope: pgScope,
        });
        writeJournal(journalDir, journal);
        return result;
      },
    });
    await hooks?.after?.("convert");
  } else if (from !== 3)
    fail(
      `external: unsupported PostgreSQL team version ${from}; data preserved`,
    );
  else if (dryRun)
    fail(
      "external: the database is already converted; a dry run has nothing to check",
    );
  if (!journal)
    fail(
      "external: an already converted database requires its original journal; data preserved",
    );
  // Converted by this run or an earlier run of this exact journal.
  const known = {
      boundary: journal?.stages.final?.boundary,
      checkpoint: journal?.stages.final?.checkpoint,
    },
    team = await store.withTeamTransaction(
      teamId,
      async (tx) => ({
        ...(await readTeam(tx, teamId)),
        proof: await postgresProof(tx, { scope: pgScope }),
      }),
      { readOnly: true },
    );
  checkLink(team.link, plan, SITE);
  checkCursor(team.link, plan, known.checkpoint, SITE);
  checkConverted(team.state, plan, SITE);
  checkDrained(team, SITE);
  checkProof(team.proof, journal.convertedProof, SITE);
  await remoteStage(transport, plan);
  const ready = {
    format: SPLIT_FORMAT,
    version: SPLIT_VERSION,
    artifact: "external-ready",
    conversion: CONVERSION,
    toolDigest: splitToolDigest(),
    planDigest: journal.planDigest,
    teamId,
    baseHead: plan.baseHead,
    resultHash: plan.resultHash,
  };
  writeArtifact(readyPath, ready, "external-ready");
  if (journal.readyDigest !== artifactDigest(ready)) {
    journal.readyDigest = artifactDigest(ready);
    journal.stages.converted ||= { at: new Date().toISOString() };
    writeJournal(journalDir, journal);
  }
  return {
    phase: "external-apply",
    dryRun: false,
    teamId,
    baseHead: plan.baseHead,
    resultHash: plan.resultHash,
    fromProtocol: plan.fromProtocol,
    toProtocol: plan.toProtocol,
    postgres: { teamFrom: journal.teamFrom, teamTo: 3 },
    canonicalHead: team.link.canonical_head,
    ...(preview ? { external: preview.conversion } : {}),
    ready: readyPath,
    next: "Hand the ready file to the internal host for the internal apply; the external site stays stopped and paused.",
  };
}

export async function finalizeExternal({
  completion,
  teamId,
  origins,
  pool,
  transport,
  journalDir,
  binding,
  hooks,
}) {
  const journal = openJournal(journalDir, SITE, binding),
    plan = journal.plan;
  checkPlan(plan, { teamId, origins }, SITE);
  checkJournalTarget(journal, plan, await postgresTarget(pool));
  if (!journal.readyDigest)
    fail("external: this journal has not finished the external apply");
  if (completion.toolDigest !== splitToolDigest())
    fail("external: the internal site ran another version of this tool");
  if (
    completion.planDigest !== journal.planDigest ||
    completion.readyDigest !== journal.readyDigest
  )
    fail("external: the completion file belongs to another plan or ready file");
  if (
    completion.teamId !== plan.teamId ||
    completion.baseHead !== plan.baseHead ||
    completion.resultHash !== plan.resultHash ||
    completion.toProtocol !== plan.toProtocol
  )
    fail("external: the completion file differs from the plan");
  // Git, not the file, decides: the boundary on the recorded head, the
  // standard checkpoint of the planned state on it, carried by the head.
  const { boundary, checkpoint } = completion;
  await transport.readHead();
  if (!(await isPlanBoundary(transport, boundary, plan)))
    fail(
      `Git: ${boundary} is not this cutover's boundary on the recorded head`,
    );
  const problem = await checkpointProblem(
    transport,
    checkpoint,
    plan,
    boundary,
  );
  if (problem)
    fail(`Git: ${checkpoint} is not this cutover's checkpoint: ${problem}`);
  const remote = await remoteStage(transport, plan);
  if (remote.checkpoint !== checkpoint)
    fail(
      `Git: the remote head ${remote.head} does not carry the completion's checkpoint`,
    );
  if ((await teamVersion(pool, binding.pgScope, teamId)) !== 3)
    fail("external: the database is not converted to team v3");
  await hooks?.before?.("cursor");
  await new PostgresDatabase(pool, { teamId }).withTeamTransaction(
    teamId,
    async (tx) => {
      const proof = await postgresProof(tx, {
        lock: true,
        scope: binding.pgScope,
      });
      const team = await readTeam(tx, teamId);
      checkLink(team.link, plan, SITE);
      checkDrained(team, SITE);
      checkConverted(team.state, plan, SITE);
      checkCursor(team.link, plan, checkpoint, SITE);
      checkProof(proof, journal.convertedProof, SITE);
      if (team.link.canonical_head === checkpoint) return;
      if (team.link.canonical_head !== plan.baseHead)
        fail("external: the canonical head moved since the plan");
      await tx.sync.advanceHead(plan.baseHead, checkpoint, plan.resultHash);
    },
  );
  await hooks?.after?.("cursor");
  if (journal.stages.final?.checkpoint !== checkpoint)
    recordStage(journalDir, journal, "final", { boundary, checkpoint });
  return {
    phase: "external-finalize",
    teamId,
    baseHead: plan.baseHead,
    boundary,
    checkpoint,
    resultHash: plan.resultHash,
    fromProtocol: plan.fromProtocol,
    toProtocol: plan.toProtocol,
    next: "Both cursors are at the checkpoint; deploy and start the sites as the runbook orders.",
  };
}
