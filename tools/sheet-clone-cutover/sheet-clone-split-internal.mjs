import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertSqliteBaseline,
  assertSqliteHistory,
  assertSqliteIntegrity,
  migrateSqlite,
  sqliteVersion,
} from "../../server/migrations/sqlite.mjs";
import { sqliteTeamStore } from "../../server/storage/sqlite.mjs";
import { checkpointFiles } from "../../server/sync/checkpoint.mjs";
import { digest, stateHash, stateSum } from "../../server/sync/protocol.mjs";
import { sqliteSheetCloneConversion } from "./convert.mjs";
import { CONVERSION } from "./names.mjs";
import {
  SPLIT_FORMAT,
  SPLIT_VERSION,
  artifactDigest,
  assertBase,
  boundaryFiles,
  checkConverted,
  checkCursor,
  checkDrained,
  checkLink,
  checkProof,
  expecting,
  fail,
  newJournal,
  openJournal,
  publishCutover,
  readArtifact,
  recordStage,
  remoteStage,
  splitMigrations,
  splitToolDigest,
  syncOf,
  tableProof,
  writeArtifact,
  writeJournal,
} from "./sheet-clone-split-handoff.mjs";

// The internal host's two phases of the split cutover (handoff module):
// prepare plans the SQLite conversion on a copy and checks it against Git;
// apply, once the external site reports its database converted to the same
// plan, converts SQLite, publishes the boundary and the standard checkpoint
// and moves the internal cursor. Neither phase reaches PostgreSQL.
const SITE = "internal";

const openSqlite = (path) => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
};
function sqliteProof(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name",
    )
    .all();
  return digest(
    tables.map(({ name }) =>
      tableProof(
        name,
        db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).iterate(),
      ),
    ),
  );
}
// The source as the migration accepts it (as cutover.mjs reads it): the
// released v29 schema or the v30-v33 history with its checksums, or a v34
// one already converted under its full history and integrity checks.
function sqliteSource(db) {
  const version = sqliteVersion(db);
  if (version === 29) assertSqliteBaseline(db);
  else if ([30, 31, 32, 33, 34].includes(version))
    assertSqliteHistory(db, { version });
  else fail(`internal: unsupported SQLite version ${version}; data preserved`);
  if (version === 34) assertSqliteIntegrity(db);
  return version;
}
// The conversion of a consistent copy (as cutover.mjs previews it): the
// source file is only read.
function previewSqlite(path, options) {
  const scratch = mkdtempSync(join(tmpdir(), "graeboard-cutover-"));
  let source = null,
    db = null;
  try {
    source = new DatabaseSync(path, { readOnly: true });
    source.exec(
      `VACUUM INTO '${join(scratch, "copy.sqlite").replaceAll("'", "''")}'`,
    );
    source.close();
    source = null;
    db = openSqlite(join(scratch, "copy.sqlite"));
    let sourceProof;
    const convert = sqliteSheetCloneConversion(options);
    const result = migrateSqlite(db, {
      convert: (target) => {
        sourceProof = sqliteProof(target);
        return convert(target);
      },
    });
    return { ...result, sourceProof };
  } finally {
    source?.close();
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
// The team's synchronization rows as one read.
function readTeam(db, teamId) {
  const store = sqliteTeamStore(db, teamId),
    count = (sql) => Number(db.prepare(sql).get(teamId).n);
  return {
    store,
    link: store.readLink(),
    state: store.readState(),
    pending: count(
      "SELECT COUNT(*) n FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
    ),
    conflicts: count(
      "SELECT COUNT(*) n FROM sync_conflicts WHERE team_id=? AND resolution IS NULL",
    ),
    jobs: count(
      "SELECT COUNT(*) n FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
    ),
    bootstrap: store.readBootstrap(),
    // Each team with shared history needs its own boundary; one is cut over.
    others: db
      .prepare(
        "SELECT team_id FROM team_sync_links WHERE team_id<>? AND (canonical_head IS NOT NULL OR bootstrap_bundle IS NOT NULL)",
      )
      .all(teamId)
      .map((row) => row.team_id),
  };
}
function checkOneTeam(team) {
  if (team.others.length)
    fail(
      `internal: other teams have shared history (${team.others.join(", ")}); this cutover converts one team`,
    );
  if (!team.link?.canonical_head)
    fail("internal: the team has no canonical head to cut over");
}
// The unconverted source still is what the plan was made from.
function checkUnconverted(team, plan) {
  checkOneTeam(team);
  checkLink(team.link, plan, SITE);
  if (team.link.canonical_head !== plan.baseHead)
    fail("internal: the canonical head moved since the plan");
  if (stateHash(team.state) !== plan.baseHash)
    fail("internal: the canonical state changed since the plan");
}
function readyTeam(db, teamId, plan, proof, checkpoint) {
  const team = readTeam(db, teamId);
  checkOneTeam(team);
  checkLink(team.link, plan, SITE);
  checkDrained(team, SITE);
  checkCursor(team.link, plan, checkpoint, SITE);
  checkConverted(team.state, plan, SITE);
  checkProof(sqliteProof(db), proof, SITE);
  return team;
}
function recheckConverted(sqlitePath, teamId, plan, proof, checkpoint) {
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    source.exec("BEGIN");
    sqliteSource(source);
    return readyTeam(source, teamId, plan, proof, checkpoint).state;
  } finally {
    source.close();
  }
}

export async function prepareInternal({
  sqlitePath,
  teamId,
  origins,
  journalDir,
  planPath,
  transport,
  binding,
}) {
  const journal = openJournal(journalDir, SITE, binding, { create: true });
  if (journal && (journal.readyDigest || Object.keys(journal.stages).length))
    fail(
      "internal: this journal has started the internal apply; rerun apply, not prepare",
    );
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  let version, team;
  try {
    version = sqliteSource(db);
    if (version === 34)
      fail("internal: the database is already converted; nothing to prepare");
    // Synchronization arrived in v30: a v29 team never shared history.
    if (version === 29)
      fail(
        "internal: a v29 database has no synchronization history; convert it with npm run cutover:sheet-clone -- --database alone",
      );
    team = readTeam(db, teamId);
  } finally {
    db.close();
  }
  checkOneTeam(team);
  checkDrained(team, SITE);
  // The conversion's preflight refuses an unpaused site, pending or held
  // commands, unresolved conflicts and unfinished maintenance.
  const preview = previewSqlite(sqlitePath, { origins }),
    sync = syncOf(preview, teamId, SITE);
  if (stateHash(team.state) !== sync.baseHash)
    fail("internal: stored canonical state does not match its hash");
  const plan = {
    format: SPLIT_FORMAT,
    version: SPLIT_VERSION,
    artifact: "plan",
    conversion: CONVERSION,
    toolDigest: splitToolDigest(),
    migrations: splitMigrations(),
    teamId,
    repoId: team.link.repo_id,
    bootstrapId: team.link.bootstrap_id,
    origins,
    sqliteFrom: version,
    baseHead: sync.baseHead,
    baseHash: sync.baseHash,
    resultHash: sync.resultHash,
    fromProtocol: sync.fromProtocol,
    toProtocol: sync.toProtocol,
  };
  await assertBase(transport, plan, () => stateSum(team.state), SITE);
  if (
    journal &&
    (artifactDigest(plan) !== journal.planDigest ||
      preview.sourceProof !== journal.sourceProof)
  )
    fail(
      "internal: the database or Git differs from this journal's plan; nothing was changed",
    );
  if (!journal)
    writeJournal(
      journalDir,
      newJournal(SITE, binding, plan, {
        sourceProof: preview.sourceProof,
      }),
    );
  writeArtifact(planPath, plan, "plan");
  return {
    phase: "internal-prepare",
    planDigest: artifactDigest(plan),
    teamId,
    baseHead: plan.baseHead,
    baseHash: plan.baseHash,
    resultHash: plan.resultHash,
    fromProtocol: plan.fromProtocol,
    toProtocol: plan.toProtocol,
    sqlite: { from: version, to: preview.to },
    origins,
    internal: preview.conversion,
    plan: planPath,
    next: "Hand the plan file to the external operator for the external apply.",
  };
}

export async function applyInternal({
  sqlitePath,
  teamId,
  journalDir,
  readyPath,
  completionPath,
  transport,
  binding,
  hooks,
}) {
  const journal = openJournal(journalDir, SITE, binding),
    plan = journal.plan,
    ready = readArtifact(readyPath, "external-ready");
  if (ready.planDigest !== journal.planDigest)
    fail("internal: the external ready file belongs to another plan");
  if (ready.toolDigest !== splitToolDigest())
    fail("internal: the external site ran another version of this tool");
  if (
    ready.teamId !== plan.teamId ||
    ready.baseHead !== plan.baseHead ||
    ready.resultHash !== plan.resultHash
  )
    fail("internal: the external ready file differs from the plan");
  const readyDigest = artifactDigest(ready);
  if (journal.readyDigest && journal.readyDigest !== readyDigest)
    fail("internal: this journal recorded another external ready file");
  if (!journal.readyDigest) {
    journal.readyDigest = readyDigest;
    writeJournal(journalDir, journal);
  }
  let remote = await remoteStage(transport, plan);

  // SQLite v34, in one transaction that commits only the planned state.
  const db = openSqlite(sqlitePath);
  try {
    const version = sqliteSource(db);
    if (version !== 34) {
      if (remote.stage !== "base")
        fail(
          "internal: Git has this cutover's boundary but the database is not converted; data preserved",
        );
      if (version !== plan.sqliteFrom)
        fail(
          `internal: the database is v${version}, the plan v${plan.sqliteFrom}`,
        );
      checkUnconverted(readTeam(db, teamId), plan);
      checkDrained(readTeam(db, teamId), SITE);
      await hooks?.before?.("convert");
      await assertBase(
        transport,
        plan,
        () => stateSum(readTeam(db, teamId).state),
        SITE,
      );
      const convert = expecting(
        sqliteSheetCloneConversion({ origins: plan.origins }),
        plan,
        SITE,
      );
      migrateSqlite(db, {
        convert: (target) => {
          // Recheck inside the migration's writer transaction. A changed
          // connection or application row must roll back the DDL as well.
          const team = readTeam(target, teamId);
          checkUnconverted(team, plan);
          checkDrained(team, SITE);
          checkProof(sqliteProof(target), journal.sourceProof, SITE);
          const result = convert(target);
          // Persist the expected post-commit contents before COMMIT. If the
          // process dies before it, SQLite rolls back; after it, the proof
          // lets a retry distinguish the commit from intervening writes.
          journal.convertedProof = sqliteProof(target);
          writeJournal(journalDir, journal);
          return result;
        },
      });
      await hooks?.after?.("convert");
    }
    // Nothing saved since: Git is not touched for a site that has written.
    readyTeam(db, teamId, plan, journal.convertedProof, remote.checkpoint);
  } finally {
    db.close();
  }
  if (!journal.stages.converted) recordStage(journalDir, journal, "converted");

  // The boundary on the recorded head, then the standard checkpoint of the
  // converted state on it; each published by compare-and-swap.
  let { boundary, checkpoint } = remote;
  if (remote.stage === "base") {
    await hooks?.before?.("boundary");
    recheckConverted(sqlitePath, teamId, plan, journal.convertedProof);
    const oid = await transport.createCandidate(
      plan.baseHead,
      boundaryFiles(plan),
    );
    if (!(await publishCutover(transport, oid, plan.baseHead)))
      fail(
        "Git: the remote head changed while publishing the boundary; nothing was published",
      );
    boundary = oid;
    await hooks?.after?.("boundary");
  }
  if (journal.stages.boundary?.oid !== boundary)
    recordStage(journalDir, journal, "boundary", { oid: boundary });
  if (!checkpoint) {
    await hooks?.before?.("checkpoint");
    const state = recheckConverted(
      sqlitePath,
      teamId,
      plan,
      journal.convertedProof,
    );
    const { files } = checkpointFiles({
      head: boundary,
      bootstrapId: plan.bootstrapId,
      identity: { teamId, repoId: plan.repoId },
      state,
    });
    const oid = await transport.createCandidate(boundary, files);
    if (!(await publishCutover(transport, oid, boundary)))
      fail(
        "Git: the remote head changed while publishing the checkpoint; nothing was published",
      );
    checkpoint = oid;
    await hooks?.after?.("checkpoint");
  }
  if (journal.stages.checkpoint?.oid !== checkpoint)
    recordStage(journalDir, journal, "checkpoint", { oid: checkpoint });

  // The internal cursor, while the site is still stopped and drained.
  remote = await remoteStage(transport, plan);
  if (remote.checkpoint !== checkpoint)
    fail("Git: the remote head does not carry this cutover's checkpoint");
  await hooks?.before?.("cursor");
  const target = openSqlite(sqlitePath);
  try {
    target.exec("BEGIN IMMEDIATE");
    try {
      const team = readyTeam(
        target,
        teamId,
        plan,
        journal.convertedProof,
        checkpoint,
      );
      if (team.link.canonical_head !== checkpoint) {
        if (team.link.canonical_head !== plan.baseHead)
          fail("internal: the canonical head moved since the plan");
        team.store.advanceHead(plan.baseHead, checkpoint, plan.resultHash);
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
  }
  await hooks?.after?.("cursor");
  if (!journal.stages.cursor) recordStage(journalDir, journal, "cursor");

  const completion = {
    format: SPLIT_FORMAT,
    version: SPLIT_VERSION,
    artifact: "internal-complete",
    conversion: CONVERSION,
    toolDigest: splitToolDigest(),
    planDigest: journal.planDigest,
    readyDigest,
    teamId,
    baseHead: plan.baseHead,
    boundary,
    checkpoint,
    resultHash: plan.resultHash,
    toProtocol: plan.toProtocol,
  };
  writeArtifact(completionPath, completion, "internal-complete");
  await hooks?.after?.("completion");
  if (journal.completionDigest !== artifactDigest(completion)) {
    journal.completionDigest = artifactDigest(completion);
    writeJournal(journalDir, journal);
  }
  return {
    phase: "internal-apply",
    teamId,
    baseHead: plan.baseHead,
    boundary,
    checkpoint,
    resultHash: plan.resultHash,
    fromProtocol: plan.fromProtocol,
    toProtocol: plan.toProtocol,
    completion: completionPath,
    next: "Hand the completion file to the external operator for the external finalize.",
  };
}
