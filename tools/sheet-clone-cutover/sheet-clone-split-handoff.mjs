import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  SQLITE_VERSION,
  sheetCloneChecksum,
} from "../../server/migrations/sqlite.mjs";
import { teamSheetCloneMigration } from "../../server/migrations/postgres.mjs";
import {
  canonical,
  digest,
  protocolVersion,
  stateHash,
  stateSum,
} from "../../server/sync/protocol.mjs";
import { snapshotCounts } from "../../server/sync/checkpoint.mjs";
import { validateSnapshot } from "../../server/sync/reducer.mjs";
import { decodeSnapshot } from "../../server/sync/snapshot.mjs";
import { BOUNDARY_KIND, CutoverError, toolDigest } from "./cutover.mjs";
import { CONVERSION } from "./names.mjs";

// The SheetClone cutover of one team whose two sites cannot reach each
// other's database: the internal host reaches SQLite and Git, the external
// operator PostgreSQL and Git. Four ordered phases, each on its own host, hand
// small JSON files over: the internal plan, the external site's readiness and
// the internal completion. They name identities, heads, hashes and digests,
// never document data, credentials or local paths. The conversion, the
// boundary commit and the standard checkpoint are those of the one-step
// cutover (cutover.mjs, convert.mjs); this module only checks and hands over.
export const SPLIT_FORMAT = "graeboard-sheet-clone-split";
export const SPLIT_VERSION = 1;
export const PAUSED_MODES = ["paused"];
const TOOL = "sheet-clone-split-cutover";
const MAX_ARTIFACT_BYTES = 64 * 1024;

export const fail = (message) => {
  throw new CutoverError(message);
};
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

// The code both hosts must run: the one-step tool's files (toolDigest) and
// the split phases, so a plan made by one release is refused by another.
const SPLIT_FILES = [
  "sheet-clone-split-handoff.mjs",
  "sheet-clone-split-internal.mjs",
  "sheet-clone-split-internal-cli.mjs",
  "sheet-clone-split-external.mjs",
  "sheet-clone-split-external-cli.mjs",
];
export function splitToolDigest() {
  const hash = createHash("sha256").update("cutover\n" + toolDigest());
  for (const name of SPLIT_FILES)
    hash
      .update("\n" + name + "\n")
      .update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest("hex");
}
// The released migrations the conversion runs in: neither host may convert
// with another SQLite v34 or PostgreSQL team v3 than the plan names.
export const splitMigrations = () => ({
  sqlite: { version: SQLITE_VERSION, checksum: sheetCloneChecksum },
  postgresTeam: {
    version: teamSheetCloneMigration.version,
    checksum: teamSheetCloneMigration.checksum,
  },
});

// Exactly the origins given (scheme://host[:port], no path or slash), once
// each and sorted: the plan, both conversions and the boundary record the
// same list.
export function splitOrigins(origins = []) {
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail(`--site-origin must be an http(s) origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
      fail(
        `--site-origin must be an http(s) origin without path or trailing slash: ${origin}`,
      );
  }
  return [...new Set(origins)].sort();
}

const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  HEX40 = /^[a-f0-9]{40}$/,
  HEX64 = /^[a-f0-9]{64}$/;
export const isTeamId = (value) =>
  typeof value === "string" && UUID.test(value);
const types = {
  uuid: (v) => typeof v === "string" && UUID.test(v),
  oid: (v) => typeof v === "string" && HEX40.test(v),
  hash: (v) => typeof v === "string" && HEX64.test(v),
  protocol: (v) => [1, 2].includes(v),
  converted: (v) => [3, 4].includes(v),
  version: (v) => [30, 31, 32, 33].includes(v),
  origins: (v) =>
    Array.isArray(v) &&
    v.every((o) => typeof o === "string") &&
    canonical(splitOrigins(v)) === canonical(v),
  migrations: (v) => canonical(v) === canonical(splitMigrations()),
};
const header = (artifact) => ({
  format: (v) => v === SPLIT_FORMAT,
  version: (v) => v === SPLIT_VERSION,
  artifact: (v) => v === artifact,
  conversion: (v) => v === CONVERSION,
  toolDigest: types.hash,
});
// The three files handed between the hosts, field by field.
const ARTIFACTS = {
  plan: {
    ...header("plan"),
    migrations: types.migrations,
    teamId: types.uuid,
    repoId: types.uuid,
    bootstrapId: types.uuid,
    origins: types.origins,
    sqliteFrom: types.version,
    baseHead: types.oid,
    baseHash: types.hash,
    resultHash: types.hash,
    fromProtocol: types.protocol,
    toProtocol: types.converted,
  },
  "external-ready": {
    ...header("external-ready"),
    planDigest: types.hash,
    teamId: types.uuid,
    baseHead: types.oid,
    resultHash: types.hash,
  },
  "internal-complete": {
    ...header("internal-complete"),
    planDigest: types.hash,
    readyDigest: types.hash,
    teamId: types.uuid,
    baseHead: types.oid,
    boundary: types.oid,
    checkpoint: types.oid,
    resultHash: types.hash,
    toProtocol: types.converted,
  },
};
const LABELS = {
  plan: "internal plan",
  "external-ready": "external ready file",
  "internal-complete": "internal completion file",
};
function validArtifact(value, artifact) {
  const fields = ARTIFACTS[artifact];
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`The ${LABELS[artifact]} is not a JSON object`);
  if (value.format !== SPLIT_FORMAT || value.artifact !== artifact)
    fail(`The file is not a SheetClone split cutover ${LABELS[artifact]}`);
  const keys = Object.keys(value);
  const extra = keys.filter((key) => !Object.hasOwn(fields, key)),
    wrong = Object.keys(fields).filter((key) => !fields[key](value[key]));
  if (extra.length || wrong.length)
    fail(
      `The ${LABELS[artifact]} is malformed (${[...wrong, ...extra].join(", ")})`,
    );
  if (value.fromProtocol && value.toProtocol !== value.fromProtocol + 2)
    fail(`The ${LABELS[artifact]} is malformed (toProtocol)`);
  return value;
}
// What the next phase binds to: the file's content, not its formatting.
export const artifactDigest = (value) => digest(value);
export function readArtifact(path, artifact) {
  if (!existsSync(path)) fail(`The ${LABELS[artifact]} ${path} does not exist`);
  if (statSync(path).size > MAX_ARTIFACT_BYTES)
    fail(`The ${LABELS[artifact]} is too large`);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`The ${LABELS[artifact]} is not valid JSON`);
  }
  return validArtifact(value, artifact);
}
// A new file, or the same content again on a rerun; never another content.
export function writeArtifact(path, value, artifact) {
  validArtifact(value, artifact);
  if (existsSync(path)) {
    let current;
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      current = null;
    }
    if (canonical(current) !== canonical(value))
      fail(`Refusing to overwrite ${path}, which holds another content`);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

// Each host's journal is a private directory holding one file. It is bound to
// its role, its target and options and the tool code; a rerun with any other
// is refused. The journal records what was done for the operator and for
// resumption, but each phase verifies the databases and Git itself.
const journalFile = (dir, role) => join(dir, `${role}-journal.json`);
export function openJournal(dir, role, binding, { create = false } = {}) {
  const path = journalFile(dir, role);
  if (!existsSync(dir)) {
    if (!create)
      fail(`No ${role} journal at ${dir}; run the first phase of this host`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!statSync(dir).isDirectory()) fail(`--journal ${dir} is not a directory`);
  chmodSync(dir, 0o700);
  if (!existsSync(path)) {
    if (readdirSync(dir).length)
      fail(
        `The journal directory ${dir} is not empty and holds no ${role} journal`,
      );
    if (!create)
      fail(`No ${role} journal at ${dir}; run the first phase of this host`);
    return null;
  }
  chmodSync(path, 0o600);
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`The ${role} journal ${path} is not valid JSON`);
  }
  if (
    journal?.tool !== TOOL ||
    journal.role !== role ||
    journal.version !== SPLIT_VERSION ||
    !journal.plan ||
    !journal.stages ||
    typeof journal.stages !== "object" ||
    Array.isArray(journal.stages) ||
    artifactDigest(validArtifact(journal.plan, "plan")) !== journal.planDigest
  )
    fail(`The ${role} journal ${path} is not a ${role} cutover journal`);
  if (journal.toolDigest !== splitToolDigest())
    fail(`The ${role} journal was written by another version of this tool`);
  if (journal.plan.toolDigest !== journal.toolDigest)
    fail(
      `The ${role} journal's plan was written by another version of this tool`,
    );
  if (canonical(journal.binding) !== canonical(binding))
    fail(
      `The ${role} journal belongs to another team, target or options (${Object.keys(
        binding,
      )
        .filter(
          (key) =>
            canonical(binding[key]) !== canonical(journal.binding?.[key]),
        )
        .join(", ")})`,
    );
  return journal;
}
export function newJournal(role, binding, plan, extra = {}) {
  return {
    tool: TOOL,
    role,
    version: SPLIT_VERSION,
    toolDigest: splitToolDigest(),
    binding,
    plan,
    planDigest: artifactDigest(plan),
    createdAt: new Date().toISOString(),
    ...extra,
    stages: {},
  };
}
export function writeJournal(dir, journal) {
  const path = journalFile(dir, journal.role),
    temporary = path + ".tmp";
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}
export const recordStage = (dir, journal, name, value = {}) => {
  journal.stages[name] = { ...value, at: new Date().toISOString() };
  writeJournal(dir, journal);
};

// Command-line paths: absolute and below a directory, so an unset shell
// variable ("$UNSET/journal" is "/journal") or an empty value is refused
// instead of writing at the filesystem root or the working directory.
export function absolutePath(value, flag) {
  if (typeof value !== "string" || !value.trim())
    fail(`${flag} is required and must not be empty; see --help`);
  if (!isAbsolute(value)) fail(`${flag} must be an absolute path: ${value}`);
  const path = resolve(value);
  if (dirname(path) === parse(path).root)
    fail(
      `${flag} ${path} lies directly in the filesystem root; check that the path variable is set`,
    );
  return path;
}
// A handed-over file lives outside the journal directory, in an existing one.
export function transferPath(value, flag, journalDir) {
  const path = absolutePath(value, flag);
  const inside = relative(journalDir, path);
  if (!inside.startsWith("..") && !isAbsolute(inside))
    fail(`${flag} must lie outside the journal directory`);
  if (!existsSync(dirname(path)))
    fail(`The directory of ${flag} does not exist: ${dirname(path)}`);
  return path;
}
export function requireValue(value, flag) {
  if (typeof value !== "string" || !value.trim())
    fail(`${flag} is required and must not be empty; see --help`);
  return value;
}
export function requireTeamId(value) {
  requireValue(value, "--team-id");
  if (!isTeamId(value) || value !== value.toLowerCase())
    fail("--team-id must be the team's UUID in lowercase");
  return value;
}

// The plan's checks against one host's own options and code.
export function checkPlan(plan, { teamId, origins }, site) {
  if (plan.toolDigest !== splitToolDigest())
    fail(`${site}: the plan was made by another version of this tool`);
  if (canonical(plan.migrations) !== canonical(splitMigrations()))
    fail(
      `${site}: the plan names other SQLite v34 / PostgreSQL team v3 migrations`,
    );
  if (plan.teamId !== teamId)
    fail(`${site}: the plan is for team ${plan.teamId}, not ${teamId}`);
  if (canonical(plan.origins) !== canonical(origins))
    fail(
      `${site}: the plan converts the links of ${canonical(plan.origins)}, not ${canonical(origins)}; pass the same --site-origin list`,
    );
}
// What one database's conversion did to the team's shared state.
export function syncOf(result, teamId, site) {
  const sync = result.conversion?.sync?.find((s) => s.teamId === teamId);
  if (!sync)
    fail(`${site}: the team has no published synchronization state to convert`);
  return sync;
}
const PLANNED = [
  "baseHead",
  "baseHash",
  "resultHash",
  "fromProtocol",
  "toProtocol",
];
export function matchPlan(sync, plan, site) {
  for (const field of PLANNED)
    if (sync[field] !== plan[field])
      fail(
        `${site}: ${field} is ${sync[field]}, the plan has ${plan[field]}; both sites must be paused at the same head`,
      );
}
// The conversion step of a migration, refused before it commits unless it
// produced the planned state.
export const expecting = (convert, plan, site) => (db) => {
  const check = (summary) => {
    matchPlan(syncOf({ conversion: summary }, plan.teamId, site), plan, site);
    return summary;
  };
  const result = convert(db);
  return result && typeof result.then === "function"
    ? result.then(check)
    : check(result);
};
export function checkLink(link, plan, site) {
  if (!link) fail(`${site}: the team has no synchronization connection`);
  if (link.repo_id !== plan.repoId || link.bootstrap_id !== plan.bootstrapId)
    fail(
      `${site}: the synchronization connection is not the plan's repository`,
    );
}
// A site that may be converted or moved: stopped, nothing unsent or held,
// no unresolved conflict.
export function checkDrained(
  { link, pending, conflicts, jobs, bootstrap },
  site,
) {
  if (!link) fail(`${site}: the team has no synchronization connection`);
  if (!PAUSED_MODES.includes(link.mode))
    fail(
      `${site}: synchronization is ${link.mode}; pause and stop the site first`,
    );
  if (pending)
    fail(
      `${site}: ${pending} commands are pending or held; they are kept and nothing is moved`,
    );
  if (conflicts)
    fail(
      `${site}: ${conflicts} unresolved conflicts; they are kept and nothing is moved`,
    );
  if (bootstrap)
    fail(`${site}: an unpublished first snapshot is pending; data preserved`);
  if (jobs)
    fail(`${site}: a maintenance or backup job is unfinished; data preserved`);
}
export function checkConverted(state, plan, site) {
  if (stateHash(state) !== plan.resultHash)
    fail(`${site}: the converted state differs from the plan`);
}

// Local proofs of the complete database contents, not just C: a user write
// can change an application row without moving the canonical cursor. Only
// the cursor columns written by advanceHead and verified separately below
// are omitted. The journal stores hashes, never row contents. Migration
// history is checked by the released migration inspector, not fingerprinted
// (preview and real migration record different application timestamps).
const CURSOR_COLUMNS = new Set([
  "canonical_head",
  "canonical_hash",
  "generation",
  "last_received_at",
  "updated_at",
]);
export function tableProof(name, rows) {
  const hashes = [];
  for (const row of rows) {
    const values = {};
    for (const [column, value] of Object.entries(row)) {
      if (name === "team_sync_links" && CURSOR_COLUMNS.has(column)) continue;
      values[column] =
        value instanceof Uint8Array
          ? { bytes: digest(value) }
          : typeof value === "bigint"
            ? String(value)
            : value;
    }
    hashes.push(digest(values));
  }
  return [name, hashes.sort()];
}
export function checkProof(actual, expected, site) {
  if (!types.hash(expected) || actual !== expected)
    fail(
      `${site}: database contents changed since this journal's conversion or preview; data preserved`,
    );
}
export function checkCursor(link, plan, checkpoint, site) {
  if (link.canonical_head === checkpoint) {
    if (link.canonical_hash !== plan.resultHash)
      fail(`${site}: the checkpoint cursor has another canonical hash`);
  } else {
    if (link.canonical_head !== plan.baseHead)
      fail(`${site}: the canonical head moved since the plan`);
    if (![null, plan.resultHash].includes(link.canonical_hash))
      fail(`${site}: the stored canonical hash is not the plan's result`);
  }
}

// --- Git: the shared history both hosts read through their own clone. ---

// A normal non-forced push rejects competing children but can still succeed
// if another operator moved the ref back to an ancestor. The cutover needs
// the exact observed ref: use Git's explicit lease, after proving the new
// commit is a direct child of it. Therefore an accepted push always extends
// that history and cannot reset or replace it. Both CLI sites use the
// existing GitCliTransport for authentication, subprocesses and fetching.
export async function publishCutover(transport, oid, parent) {
  const commit = await transport.readCommit(oid);
  if (commit.parents.length !== 1 || commit.parents[0] !== parent)
    fail("Git: refusing to publish a cutover commit without its exact parent");
  try {
    await transport.git([
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/sync-v1:${parent}`,
      "origin",
      `${oid}:refs/heads/sync-v1`,
    ]);
    return true;
  } catch (error) {
    const current = await transport.readHead();
    if (current && current !== parent) return false;
    throw error;
  }
}

// The commit's change against its single parent; null for a commit the
// fetched history does not hold.
async function changeOf(transport, oid) {
  const commit = await transport.readCommit(oid).catch(() => null);
  if (!commit || commit.parents.length !== 1) return null;
  const parent = await transport.readCommit(commit.parents[0]),
    signature = (f) => `${f.mode}:${f.type}:${f.oid}`,
    before = new Map(parent.files.map((f) => [f.path, signature(f)])),
    after = new Map(commit.files.map((f) => [f.path, signature(f)]));
  return {
    parent: commit.parents[0],
    added: commit.files.filter((f) => !before.has(f.path)).map((f) => f.path),
    regular: commit.files
      .filter((f) => !before.has(f.path))
      .every((f) => f.mode === "100644" && f.type === "blob"),
    changed: [...before].some(([path, blob]) => after.get(path) !== blob),
  };
}
async function assertManifest(transport, oid, plan) {
  const manifest = json(await transport.readFile(oid, "manifest.json"));
  if (
    manifest.teamId !== plan.teamId ||
    manifest.repoId !== plan.repoId ||
    manifest.bootstrapId !== plan.bootstrapId
  )
    fail("Git: the repository identity differs from the plan");
  if (manifest.protocol !== 1 || manifest.reducer !== 1)
    fail("Git: the repository manifest has an unsupported protocol");
  return manifest;
}
// The boundary the one-step cutover writes (cutover.mjs boundaryEnvelope).
export const boundaryEnvelope = (plan) => ({
  kind: BOUNDARY_KIND,
  conversion: CONVERSION,
  protocol: plan.toProtocol,
  reducer: plan.toProtocol,
  fromProtocol: plan.fromProtocol,
  teamId: plan.teamId,
  repoId: plan.repoId,
  bootstrapId: plan.bootstrapId,
  parent: plan.baseHead,
  previousHash: plan.baseHash,
  resultHash: plan.resultHash,
  origins: plan.origins,
});
export const boundaryFiles = (plan) => ({
  [`events/${CONVERSION}-${plan.baseHead}.json`]: canonical(
    boundaryEnvelope(plan),
  ),
});
// This plan's boundary: one commit on the recorded head that adds exactly
// the boundary event, byte for byte.
export async function isPlanBoundary(transport, oid, plan) {
  const change = await changeOf(transport, oid),
    [path, bytes] = Object.entries(boundaryFiles(plan))[0];
  return (
    !!change &&
    change.parent === plan.baseHead &&
    change.regular &&
    !change.changed &&
    change.added.length === 1 &&
    change.added[0] === path &&
    new TextDecoder().decode(await transport.readFile(oid, path)) === bytes
  );
}
// Why oid is not a standard checkpoint of the plan's converted state on its
// boundary, or null. The snapshot itself is read and its state hashed.
export async function checkpointProblem(transport, oid, plan, boundary) {
  const change = await changeOf(transport, oid);
  if (!change || change.parent !== boundary)
    return "it is not a commit on the boundary";
  const events = change.added.filter((p) => p.startsWith("events/")),
    snapshots = change.added.filter((p) => p.startsWith("snapshots/"));
  if (
    change.changed ||
    !change.regular ||
    change.added.length !== 2 ||
    events.length !== 1 ||
    snapshots.length !== 1
  )
    return "it does not add exactly one checkpoint event and snapshot";
  if (
    !/^events\/[a-zA-Z0-9-]+\.json$/.test(events[0]) ||
    !/^snapshots\/[a-zA-Z0-9-]+\.json\.gz$/.test(snapshots[0])
  )
    return "its paths are not standard checkpoint paths";
  const envelope = json(await transport.readFile(oid, events[0]));
  const expected = {
    kind: "checkpoint",
    checkpointVersion: 1,
    protocol: plan.toProtocol,
    reducer: plan.toProtocol,
    teamId: plan.teamId,
    repoId: plan.repoId,
    bootstrapId: plan.bootstrapId,
    parent: boundary,
    atCommit: boundary,
    path: snapshots[0],
    resultHash: plan.resultHash,
  };
  for (const [key, value] of Object.entries(expected))
    if (envelope[key] !== value) return `its event has another ${key}`;
  const bytes = await transport.readFile(oid, snapshots[0]);
  if (digest(bytes) !== envelope.snapshotHash)
    return "its snapshot does not match the event's hash";
  const snapshot = decodeSnapshot(bytes);
  if (
    snapshot.atCommit !== boundary ||
    stateHash(snapshot.state) !== plan.resultHash
  )
    return "its snapshot is not the converted state";
  validateSnapshot(snapshot.state, {
    teamId: plan.teamId,
    repoId: plan.repoId,
  });
  if (
    protocolVersion(snapshot.state) !== plan.toProtocol ||
    canonical(envelope.counts) !== canonical(snapshotCounts(snapshot.state)) ||
    envelope.resultSum !== stateSum(snapshot.state)
  )
    return "its counts, protocol or result sum differs from the snapshot";
  return null;
}
// Where the shared history stands for this plan: still at the recorded head
// (base), at this plan's boundary, or at a checkpoint directly on it. Even
// a descendant of the checkpoint means another writer ran while stopped.
// Any other head is refused as it is.
export async function remoteStage(transport, plan) {
  const head = await transport.readHead();
  if (!head) fail("Git: the synchronization branch does not exist");
  await assertManifest(transport, head, plan);
  if (head === plan.baseHead) return { head, stage: "base" };
  if (await isPlanBoundary(transport, head, plan))
    return { head, stage: "boundary", boundary: head };
  const commit = await transport.readCommit(head);
  if (
    commit.parents.length === 1 &&
    (await isPlanBoundary(transport, commit.parents[0], plan)) &&
    !(await checkpointProblem(transport, head, plan, commit.parents[0]))
  )
    return {
      head,
      stage: "checkpoint",
      boundary: commit.parents[0],
      checkpoint: head,
    };
  fail(
    `Git: the remote head moved to ${head}, which this cutover did not publish; nothing was changed`,
  );
}
// Before a site converts: the remote head is the recorded head, of this
// repository, and its event recorded the sites' canonical state (a genesis
// records its bundle hash). sum() is the site's own C before conversion.
export async function assertBase(transport, plan, sum, site) {
  const head = await transport.readHead();
  if (head !== plan.baseHead)
    fail(
      `Git: the remote head ${head} is not the head the ${site} site recorded (${plan.baseHead}); nothing was changed`,
    );
  await assertManifest(transport, head, plan);
  const commit = await transport.readCommit(plan.baseHead);
  let recorded;
  if (!commit.parents.length) {
    const manifest = await assertManifest(transport, plan.baseHead, plan);
    const bytes = await transport.readFile(plan.baseHead, manifest.genesis);
    if (digest(bytes) !== manifest.genesisHash)
      fail("Git: the genesis snapshot does not match the manifest");
    recorded = {
      hash: decodeSnapshot(bytes).hash,
    };
  } else {
    const change = await changeOf(transport, plan.baseHead),
      events = change?.added.filter((p) => p.startsWith("events/")) || [];
    if (events.length !== 1) fail("Git: the recorded head has no single event");
    const envelope = json(await transport.readFile(plan.baseHead, events[0]));
    recorded = { hash: envelope.resultHash, sum: envelope.resultSum };
  }
  if (recorded.hash ? recorded.hash !== plan.baseHash : recorded.sum !== sum())
    fail("Git: the recorded head's result is not the sites' canonical state");
}

// Messages may carry what an environment variable or the Git token holds;
// those values never reach the terminal.
export function redact(message, secrets = []) {
  let text = String(message);
  for (const secret of secrets.filter(
    (s) => typeof s === "string" && s.length > 0,
  )) {
    text = text.split(secret).join("[redacted]");
    try {
      const url = new URL(secret);
      if (url.password) text = text.split(url.password).join("[redacted]");
      if (url.password)
        text = text.split(decodeURIComponent(url.password)).join("[redacted]");
    } catch {}
  }
  return text
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s'"]+/gi, "$1[redacted]")
    .replace(/\b(https?:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "$1[redacted]");
}
// The message a command prints for an error: this tool's and the
// conversion's own checks verbatim, anything else (a driver or system error,
// which can carry connection detail) by its code only.
export function errorMessage(error, secrets) {
  const own =
    ["SHEET_CLONE_CUTOVER", "SHEET_CLONE_PREFLIGHT"].includes(error?.code) ||
    String(error?.code).startsWith("ERR_PARSE_ARGS_") ||
    !error?.code;
  return redact(
    own
      ? error?.message || String(error)
      : `Cutover stopped (${String(error.code).replace(/[^A-Za-z0-9_]/g, "")}); rerun the same command after checking database and Git access.`,
    secrets,
  );
}
