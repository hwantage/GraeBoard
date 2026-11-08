import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { migratePostgres } from "../../server/migrations/postgres.mjs";
import { sqliteTeamStore } from "../../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../../worker/storage/postgres.mjs";
import { checkpointFiles } from "../../server/sync/checkpoint.mjs";
import { canonical, stateHash, stateSum } from "../../server/sync/protocol.mjs";
import { CONVERSION } from "./names.mjs";
import {
  postgresSheetCloneConversion,
  sqliteSheetCloneConversion,
} from "./convert.mjs";

// The one-time SheetClone cutover of one team, run while every site is
// stopped. Each database converts in its own transaction and the Git history
// gains two commits on the recorded head: a boundary that records the
// converted state's hash, and a standard checkpoint of that state, which new
// and recovering sites load (server/sync/checkpoint.mjs). Both databases then
// move their canonical cursor to the checkpoint. SQLite, PostgreSQL and Git
// are not one transaction: the journal records each finished stage, and the
// same command resumes from the first unfinished one. Nothing pending,
// held or in conflict is ever converted or removed; such a state is refused.
export const BOUNDARY_KIND = "sheet-clone-cutover";
const JOURNAL = "journal.json";
const MODES = ["paused", "disconnected", "recovery"];

export class CutoverError extends Error {
  constructor(message) {
    super(message);
    this.code = "SHEET_CLONE_CUTOVER";
  }
}
const fail = (message) => {
  throw new CutoverError(message);
};
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

// The tool files the journal was written by, so a resume runs the same code.
export function toolDigest() {
  const hash = createHash("sha256");
  for (const name of [
    "convert.mjs",
    "cutover.mjs",
    "markdown-links.mjs",
    "names.mjs",
  ])
    hash.update(name).update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest("hex");
}

function readJournal(dir) {
  const path = join(dir, JOURNAL);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function writeJournal(dir, journal) {
  const path = join(dir, JOURNAL);
  writeFileSync(path + ".tmp", JSON.stringify(journal, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(path + ".tmp", path);
}

const openSqlite = (path) => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
};
// The source database as the migration accepts it, checked before anything
// is read from it: the released v29 schema or the v30-v33 history with its
// checksums (the migration checks integrity itself), or a v34 one already
// converted, reported only under its full history and integrity checks.
// Anything else is refused.
function sqliteSource(db) {
  const version = sqliteVersion(db);
  if (version === 29) assertSqliteBaseline(db);
  else if ([30, 31, 32, 33, 34].includes(version))
    assertSqliteHistory(db, { version });
  else throw new Error(`Unsupported SQLite version ${version}; data preserved`);
  if (version === 34) assertSqliteIntegrity(db);
  return version;
}

// The conversion of a consistent copy: the source file is only read.
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
    return migrateSqlite(db, { convert: sqliteSheetCloneConversion(options) });
  } finally {
    source?.close();
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
const previewPostgres = (pool, scope, teamId, options) =>
  migratePostgres(pool, {
    scope,
    teamId,
    dryRun: true,
    convert: postgresSheetCloneConversion(options),
  });

// What one database's conversion did to the team's shared state.
function syncOf(result, teamId, site) {
  const sync = result.conversion?.sync?.find((s) => s.teamId === teamId);
  if (!sync)
    fail(`${site}: the team has no published synchronization state to convert`);
  return sync;
}

async function plan({ sqlitePath, pool, pgScope, teamId, transport }, options) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  let version, others, oldState, link;
  try {
    version = sqliteSource(db);
    if (version === 34)
      fail("internal: the database is already converted; nothing to plan");
    // Synchronization arrived in v30: a v29 team never shared history.
    if (version === 29)
      fail(
        "internal: a v29 database has no synchronization history; convert it with --database alone",
      );
    // Every team with shared history needs its own boundary; this tool cuts
    // over one team, so no other team may have one.
    others = db
      .prepare(
        "SELECT team_id FROM team_sync_links WHERE team_id<>? AND (canonical_head IS NOT NULL OR bootstrap_bundle IS NOT NULL)",
      )
      .all(teamId)
      .map((row) => row.team_id);
    const store = sqliteTeamStore(db, teamId);
    link = store.readLink();
    oldState = store.readState();
  } finally {
    db.close();
  }
  if (others.length)
    fail(
      `internal: other teams have shared history (${others.join(", ")}); cut over or reset them first`,
    );
  if (!link?.canonical_head)
    fail("internal: the team has no canonical head to cut over");
  const internal = previewSqlite(sqlitePath, options),
    external = await previewPostgres(pool, pgScope, teamId, options),
    inside = syncOf(internal, teamId, "internal"),
    outside = syncOf(external, teamId, "external");
  for (const field of [
    "baseHead",
    "baseHash",
    "resultHash",
    "fromProtocol",
    "toProtocol",
  ])
    if (inside[field] !== outside[field])
      fail(
        `the two sites differ in ${field} (${inside[field]} / ${outside[field]}); synchronize both to the same head first`,
      );
  if (stateHash(oldState) !== inside.baseHash)
    fail("internal: stored canonical state does not match its hash");
  // The recorded head is the remote head, and its event recorded this state.
  const head = await transport.readHead();
  if (head !== inside.baseHead)
    fail(
      `Git: the remote head ${head} is not the head both sites recorded (${inside.baseHead})`,
    );
  const commit = await transport.readCommit(head),
    manifest = json(await transport.readFile(head, "manifest.json"));
  if (
    manifest.teamId !== teamId ||
    manifest.repoId !== link.repo_id ||
    manifest.bootstrapId !== link.bootstrap_id
  )
    fail("Git: repository identity differs from the internal connection");
  const recorded = await recordedResult(transport, commit, manifest);
  if (
    recorded.hash
      ? recorded.hash !== inside.baseHash
      : recorded.sum !== stateSum(oldState)
  )
    fail("Git: the head's recorded result is not the sites' canonical state");
  return {
    baseHead: inside.baseHead,
    baseHash: inside.baseHash,
    fromProtocol: inside.fromProtocol,
    toProtocol: inside.toProtocol,
    resultHash: inside.resultHash,
    repoId: link.repo_id,
    bootstrapId: link.bootstrap_id,
    internal: { from: internal.from, to: internal.to, ...internal.conversion },
    external: {
      from: external.from,
      to: external.to,
      teamFrom: external.teamFrom,
      teamTo: external.teamTo,
      ...external.conversion,
    },
  };
}
// The result a commit's event recorded (a genesis records its bundle hash).
async function recordedResult(transport, commit, manifest) {
  if (!commit.parents.length) {
    const genesis = await transport.readFile(commit.oid, manifest.genesis);
    const { decodeSnapshot } = await import("../../server/sync/snapshot.mjs");
    return { hash: decodeSnapshot(genesis).hash };
  }
  const parent = await transport.readCommit(commit.parents[0]),
    known = new Set(parent.files.map((f) => f.path)),
    events = commit.files.filter(
      (f) => f.path.startsWith("events/") && !known.has(f.path),
    );
  if (events.length !== 1) fail("Git: the head has no single event");
  const envelope = json(await transport.readFile(commit.oid, events[0].path));
  return { hash: envelope.resultHash, sum: envelope.resultSum, envelope };
}
// The head commit's event when it is a single new event of one commit.
async function headEvent(transport, oid) {
  const commit = await transport.readCommit(oid);
  if (commit.parents.length !== 1) return null;
  const parent = await transport.readCommit(commit.parents[0]),
    known = new Set(parent.files.map((f) => f.path)),
    events = commit.files.filter(
      (f) => f.path.startsWith("events/") && !known.has(f.path),
    );
  return events.length === 1
    ? {
        parent: commit.parents[0],
        envelope: json(await transport.readFile(oid, events[0].path)),
      }
    : null;
}

function boundaryEnvelope(journal) {
  const p = journal.plan;
  return {
    kind: BOUNDARY_KIND,
    conversion: CONVERSION,
    protocol: p.toProtocol,
    reducer: p.toProtocol,
    fromProtocol: p.fromProtocol,
    teamId: journal.teamId,
    repoId: p.repoId,
    bootstrapId: p.bootstrapId,
    parent: p.baseHead,
    previousHash: p.baseHash,
    resultHash: p.resultHash,
    origins: journal.origins,
  };
}
const isBoundary = (event, journal) =>
  event &&
  event.parent === journal.plan.baseHead &&
  event.envelope.kind === BOUNDARY_KIND &&
  event.envelope.conversion === CONVERSION &&
  event.envelope.teamId === journal.teamId &&
  event.envelope.resultHash === journal.plan.resultHash;
const isCheckpoint = (event, journal) =>
  event &&
  event.parent === journal.stages.boundary?.oid &&
  event.envelope.kind === "checkpoint" &&
  event.envelope.checkpointVersion === 1 &&
  event.envelope.resultHash === journal.plan.resultHash;

// One database's conversion, refused before it commits unless it produced the
// planned state.
const expecting = (convert, journal, site) => (db) => {
  const check = (summary) => {
    const sync = summary?.sync?.find((s) => s.teamId === journal.teamId);
    if (
      sync?.baseHead !== journal.plan.baseHead ||
      sync.resultHash !== journal.plan.resultHash
    )
      fail(`${site}: the conversion did not produce the planned state`);
    return summary;
  };
  const result = convert(db);
  return result && typeof result.then === "function"
    ? result.then(check)
    : check(result);
};
function convertedState(state, journal, site) {
  if (stateHash(state) !== journal.plan.resultHash)
    fail(`${site}: the converted state differs from the plan`);
  return state;
}

async function stage(journal, dir, name, hooks, work) {
  if (journal.stages[name]) return;
  await hooks?.before?.(name);
  journal.stages[name] = { ...(await work()), at: new Date().toISOString() };
  writeJournal(dir, journal);
  await hooks?.after?.(name);
}

// An installation whose teams never shared history (no external site) has
// no Git boundary to write: only its SQLite database converts, in one
// transaction. A team with shared history needs the whole cutover.
export function convertInternalOnly({
  sqlitePath,
  origins = [],
  dryRun = false,
}) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  let version,
    shared = [];
  try {
    version = sqliteSource(db);
    // Synchronization arrived in v30: a v29 team never shared history.
    if (version >= 30)
      shared = db
        .prepare(
          "SELECT team_id FROM team_sync_links WHERE canonical_head IS NOT NULL OR bootstrap_bundle IS NOT NULL",
        )
        .all()
        .map((row) => row.team_id);
  } finally {
    db.close();
  }
  if (version === 34) return { from: 34, to: 34, applied: false };
  if (shared.length)
    fail(
      `internal: teams with shared history (${shared.join(", ")}) need the whole cutover; pass --team-id, --pg-url-env and --journal`,
    );
  if (dryRun)
    return {
      ...previewSqlite(sqlitePath, { origins }),
      applied: false,
      dryRun: true,
    };
  const target = openSqlite(sqlitePath);
  try {
    return migrateSqlite(target, {
      convert: sqliteSheetCloneConversion({ origins }),
    });
  } finally {
    target.close();
  }
}

export async function runCutover({
  teamId,
  sqlitePath,
  pool,
  pgScope = "site",
  transport,
  origins = [],
  journalDir,
  dryRun = false,
  hooks,
}) {
  const options = { origins },
    sources = { sqlitePath, pool, pgScope, teamId, transport };
  if (dryRun) return { dryRun: true, plan: await plan(sources, options) };
  if (!journalDir) fail("--journal is required unless --dry-run");
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  let journal = readJournal(journalDir);
  const digest = toolDigest();
  if (journal) {
    if (
      journal.tool !== "sheet-clone-cutover" ||
      journal.teamId !== teamId ||
      journal.pgScope !== pgScope ||
      canonical(journal.origins) !== canonical([...new Set(origins)].sort())
    )
      fail("the journal belongs to another team or other options");
    if (journal.toolDigest !== digest)
      fail("the journal was written by another version of this tool");
  } else {
    if (readdirSync(journalDir).length)
      fail("the journal directory is not empty and has no journal");
    // Every check and both conversions on copies before the first change.
    const planned = await plan(sources, options);
    journal = {
      tool: "sheet-clone-cutover",
      conversion: CONVERSION,
      toolDigest: digest,
      teamId,
      pgScope,
      origins: [...new Set(origins)].sort(),
      createdAt: new Date().toISOString(),
      plan: planned,
      stages: {},
    };
    writeJournal(journalDir, journal);
  }
  const p = journal.plan,
    run = (name, work) => stage(journal, journalDir, name, hooks, work);

  await run("internal", async () => {
    const db = openSqlite(sqlitePath);
    try {
      if (sqliteVersion(db) !== 34)
        migrateSqlite(db, {
          convert: expecting(
            sqliteSheetCloneConversion(options),
            journal,
            "internal",
          ),
        });
      const store = sqliteTeamStore(db, teamId),
        link = store.readLink();
      if (link.canonical_head !== p.baseHead)
        fail("internal: the canonical head moved since the plan");
      convertedState(store.readState(), journal, "internal");
    } finally {
      db.close();
    }
    return {};
  });
  const external = new PostgresDatabase(pool, { teamId });
  await run("external", async () => {
    const link = await external.readLink(teamId),
      version = (
        await pool.query(
          "SELECT MAX(version) AS v FROM graeboard.schema_migrations WHERE scope='team'",
        )
      ).rows[0].v;
    if (Number(version) < 3)
      await migratePostgres(pool, {
        scope: pgScope,
        teamId,
        convert: expecting(
          postgresSheetCloneConversion(options),
          journal,
          "external",
        ),
      });
    if ((await external.readLink(teamId)).canonical_head !== p.baseHead)
      fail("external: the canonical head moved since the plan");
    convertedState(await external.readState(teamId), journal, "external");
    return { linkMode: link.mode };
  });

  await run("boundary", async () => {
    const head = await transport.readHead();
    if (head !== p.baseHead) {
      // Published by an earlier run of this journal, or by someone else.
      const event = await headEvent(transport, head);
      if (isBoundary(event, journal)) return { oid: head };
      const below = event && (await headEvent(transport, event.parent));
      if (
        below &&
        isBoundary(below, journal) &&
        event.envelope.kind === "checkpoint"
      )
        return { oid: event.parent };
      fail(
        `Git: the remote head moved to ${head}, which this cutover did not publish`,
      );
    }
    const oid = await transport.createCandidate(p.baseHead, {
      [`events/${CONVERSION}-${p.baseHead}.json`]: canonical(
        boundaryEnvelope(journal),
      ),
    });
    if (!(await transport.publish(oid, p.baseHead)))
      fail("Git: the remote head changed while publishing the boundary");
    return { oid };
  });

  await run("checkpoint", async () => {
    const boundary = journal.stages.boundary.oid,
      head = await transport.readHead();
    if (head !== boundary) {
      const event = await headEvent(transport, head);
      if (isCheckpoint(event, journal)) return { oid: head };
      fail(
        `Git: the remote head moved to ${head}, which this cutover did not publish`,
      );
    }
    const db = openSqlite(sqlitePath);
    let state;
    try {
      state = convertedState(
        sqliteTeamStore(db, teamId).readState(),
        journal,
        "internal",
      );
    } finally {
      db.close();
    }
    const { files } = checkpointFiles({
      head: boundary,
      bootstrapId: p.bootstrapId,
      identity: { teamId, repoId: p.repoId },
      state,
    });
    const oid = await transport.createCandidate(boundary, files);
    if (!(await transport.publish(oid, boundary)))
      fail("Git: the remote head changed while publishing the checkpoint");
    return { oid };
  });

  const checkpoint = journal.stages.checkpoint.oid;
  // A site must not have written or started since its conversion.
  const ready = (link, pending, site) => {
    if (!MODES.includes(link.mode))
      fail(`${site}: synchronization is ${link.mode}; stop the site first`);
    if (pending.length)
      fail(`${site}: ${pending.length} commands were saved after conversion`);
  };
  await run("internalCursor", async () => {
    const db = openSqlite(sqlitePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const store = sqliteTeamStore(db, teamId),
          link = store.readLink();
        if (link.canonical_head !== checkpoint) {
          if (link.canonical_head !== p.baseHead)
            fail("internal: the canonical head moved since the plan");
          ready(link, store.readPending(), "internal");
          store.advanceHead(p.baseHead, checkpoint, p.resultHash);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    return {};
  });
  await run("externalCursor", async () => {
    await external.withTeamTransaction(teamId, async (tx) => {
      const link = await tx.sync.readLink();
      if (link.canonical_head === checkpoint) return;
      if (link.canonical_head !== p.baseHead)
        fail("external: the canonical head moved since the plan");
      ready(link, await tx.sync.readPending(), "external");
      await tx.sync.advanceHead(p.baseHead, checkpoint, p.resultHash);
    });
    return {};
  });
  return {
    dryRun: false,
    teamId,
    baseHead: p.baseHead,
    boundary: journal.stages.boundary.oid,
    checkpoint,
    resultHash: p.resultHash,
    fromProtocol: p.fromProtocol,
    toProtocol: p.toProtocol,
    journal: join(journalDir, JOURNAL),
  };
}
