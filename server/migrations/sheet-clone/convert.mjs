import { createHash, randomUUID } from "node:crypto";
import { canonical, digest, stateHash } from "../../sync/protocol.mjs";
import { validateSnapshot } from "../../sync/reducer.mjs";
import { encodeSnapshot } from "../../sync/snapshot.mjs";
import { executeAsync, executeSync } from "../../../shared/sync-team-store.mjs";
import { stableId } from "../../../shared/workbook.mjs";
import { calendarPreview } from "../../storage/calendar-service.mjs";
import { decodeSheetClone, encodeSheetClone } from "../../sheet-clones.mjs";
import { convertMarkdownLinks } from "./markdown-links.mjs";
import {
  CONVERSION,
  auditAction,
  documentKey,
  entityId,
  entityIdText,
  entityKey,
  entityName,
  importMode,
  isLegacyDocumentKey,
  isLegacyImportMode,
} from "./names.mjs";

// The SheetClone conversion of one database, inside the transaction of its
// migration (SQLite v34, PostgreSQL team v3). It changes the names the rows
// store, never their identities: copy, task, document, memo, user and team IDs,
// generations and versions stay. Receipts, settled conflicts and published
// outbox commands are immutable history and are kept byte for byte. A row the
// conversion cannot reproduce stops the whole migration before any write.
class ConversionError extends Error {
  constructor(problems) {
    super(
      "SheetClone conversion preflight failed; data preserved:\n" +
        problems.map((p) => "- " + p).join("\n"),
    );
    this.code = "SHEET_CLONE_PREFLIGHT";
    this.problems = problems;
  }
}
const query = (sql, values = []) => ({ sql, values });
const parse = (text) =>
  text === null || text === undefined ? null : JSON.parse(text);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const integer = (value) => (value === null ? null : Number(value));
const YEARS = Array.from({ length: 101 }, (_, i) => 2000 + i);
const MARKER = entityId("protocol", []);

function normalizeOptions({ origins = [], now } = {}) {
  const list = [...new Set(origins)].map((origin) => {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== origin.replace(/\/$/, "")
    )
      throw new Error("--site-origin must be an http(s) origin: " + origin);
    return url.origin;
  });
  return { origins: list.sort(), now: now || new Date().toISOString() };
}
const newStats = () => ({ changed: 0, links: 0, kept: [], unverified: [] });
// Values the application stored as JSON (history, retry responses, import
// previews, site rows and events). Cell contents are user data and untouched.
function convertJson(value, options, stats = newStats(), inCells = false) {
  if (typeof value === "string") {
    if (!inCells && /^\["(report|document",\["report)/.test(value)) {
      const next = entityIdText(value);
      if (next !== value) stats.changed++;
      return next;
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => convertJson(item, options, stats, inCells));
  if (!value || typeof value !== "object") return value;
  const record =
      !inCells && typeof value.entity === "string" && Array.isArray(value.key),
    reference =
      !inCells && value.kind === "document" && Array.isArray(value.key);
  const output = {};
  for (const [name, item] of Object.entries(value)) {
    let key = name,
      next;
    if (!inCells && (name === "reportId" || name === "reportIds"))
      key = name === "reportId" ? "sheetCloneId" : "sheetCloneIds";
    if (record && name === "entity") next = entityName(item);
    else if (record && name === "key") next = entityKey(value.entity, item);
    else if (reference && name === "key") next = documentKey(item);
    else if (!inCells && name === "markdown" && typeof item === "string") {
      const converted = convertMarkdownLinks(item, options);
      next = converted.markdown;
      stats.links += converted.changes;
      stats.kept.push(...converted.kept);
      stats.unverified.push(...converted.unverified);
    } else
      next = convertJson(item, options, stats, inCells || name === "cells");
    if (key !== name || canonical(next) !== canonical(item)) stats.changed++;
    output[key] = next;
  }
  return output;
}
// Re-serializes only what changed, keeping every other stored text as it was
// and in the form it was written (canonical JSON stays canonical).
function convertText(text, options, stats, extra) {
  if (text === null || text === undefined) return text;
  const original = JSON.parse(text);
  let value = convertJson(original, options, stats);
  if (extra) value = extra(value);
  if (canonical(value) === canonical(original)) return text;
  return canonical(original) === text
    ? canonical(value)
    : JSON.stringify(value);
}
const importResult = (value) =>
  value && typeof value === "object" && isLegacyImportMode(value.mode)
    ? { ...value, mode: importMode(value.mode) }
    : value;

// C of protocol 1 (one record per sheet clone) becomes protocol 3, C of
// protocol 2 (rows and cells) protocol 4. Only names, document keys and the
// stored links of document bodies change; receipts and conflicts are history.
function convertCanonicalState(legacy, options) {
  const marker = legacy.entities[MARKER];
  if (
    marker &&
    !(marker.payload?.version === 2 && marker.payload?.reducer === 2)
  )
    throw new ConversionError([
      "canonical state has an unknown protocol marker " +
        canonical(marker.payload),
    ]);
  const from = marker ? 2 : 1,
    to = from === 2 ? 4 : 3,
    entities = {},
    stats = { renamed: 0, documents: 0, links: 0, kept: [], unverified: [] };
  for (const record of Object.values(legacy.entities)) {
    if (record.entity === "protocol") continue;
    const entity = entityName(record.entity),
      key = entityKey(record.entity, record.key);
    let payload = record.payload;
    if (record.entity === "document" && typeof payload?.markdown === "string") {
      const converted = convertMarkdownLinks(payload.markdown, options);
      stats.kept.push(...converted.kept);
      stats.unverified.push(...converted.unverified);
      if (converted.changes) {
        payload = { ...payload, markdown: converted.markdown };
        stats.documents++;
        stats.links += converted.changes;
      }
    }
    if (entity !== record.entity || key !== record.key) stats.renamed++;
    const id = entityId(entity, key);
    if (Object.hasOwn(entities, id))
      throw new ConversionError(["two canonical records convert to " + id]);
    entities[id] = { ...record, entity, key, payload };
  }
  const token = digest(["sheet-clone-protocol", to, stateHash(legacy)]);
  entities[MARKER] = {
    entity: "protocol",
    key: [],
    generation: token,
    version: token,
    payload: { version: to, reducer: to },
    deleted: false,
  };
  return {
    state: { entities, receipts: legacy.receipts, conflicts: legacy.conflicts },
    from,
    to,
    stats,
  };
}

function* readCanonical(teamId) {
  const entities = {},
    receipts = {},
    conflicts = {},
    rows = (yield query(
      "SELECT entity,entity_key,generation,version,payload,deleted FROM sync_entities WHERE team_id=$1 ORDER BY entity,entity_key",
      [teamId],
    )).rows;
  for (const row of rows) {
    const key = JSON.parse(row.entity_key);
    entities[entityId(row.entity, key)] = {
      entity: row.entity,
      key,
      generation: row.generation,
      version: row.version,
      payload: parse(row.payload),
      deleted: !!Number(row.deleted),
    };
  }
  for (const row of (yield query(
    "SELECT op_id,receipt FROM sync_receipts WHERE team_id=$1",
    [teamId],
  )).rows)
    receipts[row.op_id] = JSON.parse(row.receipt);
  for (const row of (yield query(
    "SELECT conflict_id,payload FROM sync_conflicts WHERE team_id=$1",
    [teamId],
  )).rows)
    conflicts[row.conflict_id] = JSON.parse(row.payload);
  return { rows, state: { entities, receipts, conflicts } };
}

// A connection that never applied a head and holds no shared state has
// nothing to convert.
function* unpublished(teamId, link) {
  if (link.canonical_head || link.bootstrap_bundle) return false;
  const row = (yield query(
    `SELECT (SELECT COUNT(*) FROM sync_entities WHERE team_id=$1) AS entities,
      (SELECT COUNT(*) FROM sync_outbox WHERE team_id=$1) AS outbox`,
    [teamId],
  )).rows[0];
  return !Number(row.entities) && !Number(row.outbox);
}
function* syncPreflight(teamId, link) {
  const problems = [];
  if (yield* unpublished(teamId, link)) return problems;
  if (!["paused", "disconnected", "recovery"].includes(link.mode))
    problems.push(
      `team ${teamId}: synchronization is ${link.mode}; pause both sites at the same head first`,
    );
  if (link.bootstrap_bundle)
    problems.push(`team ${teamId}: an unpublished first snapshot is pending`);
  if (!link.canonical_head)
    problems.push(`team ${teamId}: no canonical head has been applied`);
  const counts = (yield query(
    `SELECT
      (SELECT COUNT(*) FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged') AS pending,
      (SELECT COUNT(*) FROM sync_conflicts WHERE team_id=$1 AND resolution IS NULL) AS conflicts,
      (SELECT COUNT(*) FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')) AS jobs`,
    [teamId],
  )).rows[0];
  if (Number(counts.pending))
    problems.push(
      `team ${teamId}: ${counts.pending} pending or held commands; publish or resolve them first`,
    );
  if (Number(counts.conflicts))
    problems.push(
      `team ${teamId}: ${counts.conflicts} unresolved conflicts; resolve them first`,
    );
  if (Number(counts.jobs))
    problems.push(`team ${teamId}: a maintenance or backup job is unfinished`);
  return problems;
}

// The tables both engines keep per team: C, its history and the site's
// local state. P is empty (preflight); published commands stay as written.
function* convertSync(teamId, options, report, problems) {
  const link = (yield query("SELECT * FROM team_sync_links WHERE team_id=$1", [
    teamId,
  ])).rows[0];
  if (!link || (yield* unpublished(teamId, link))) return null;
  problems.push(...(yield* syncPreflight(teamId, link)));
  const { rows, state: legacy } = yield* readCanonical(teamId),
    baseHash = stateHash(legacy);
  if (link.canonical_hash && link.canonical_hash !== baseHash)
    problems.push(
      `team ${teamId}: stored canonical hash does not match its records`,
    );
  if (problems.length) return null;
  const converted = convertCanonicalState(legacy, options),
    identity = { teamId, repoId: link.repo_id };
  if (converted.stats.unverified.length)
    throw new ConversionError(
      converted.stats.unverified.map(
        (url) =>
          `team ${teamId}: canonical document link not verifiable: ${url}`,
      ),
    );
  try {
    validateSnapshot(converted.state, identity);
  } catch (error) {
    throw new ConversionError([
      `team ${teamId}: converted canonical state is invalid: ${error.message}`,
    ]);
  }
  for (const row of rows) {
    if (row.entity === "protocol") continue;
    const key = JSON.parse(row.entity_key),
      next =
        converted.state.entities[
          entityId(entityName(row.entity), entityKey(row.entity, key))
        ],
      payload = next.payload === null ? null : canonical(next.payload);
    if (
      next.entity === row.entity &&
      canonical(next.key) === row.entity_key &&
      payload === row.payload
    )
      continue;
    yield query(
      "UPDATE sync_entities SET entity=$4,entity_key=$5,payload=$6 WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [
        teamId,
        row.entity,
        row.entity_key,
        next.entity,
        canonical(next.key),
        payload,
      ],
    );
  }
  const marker = converted.state.entities[MARKER];
  yield query(
    "INSERT INTO sync_entities(team_id,entity,entity_key,generation,version,payload,deleted) VALUES($1,'protocol','[]',$2,$3,$4,0) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET generation=excluded.generation,version=excluded.version,payload=excluded.payload,deleted=0",
    [teamId, marker.generation, marker.version, canonical(marker.payload)],
  );
  const stored = (yield* readCanonical(teamId)).state,
    resultHash = stateHash(converted.state);
  if (stateHash(stored) !== resultHash)
    throw new Error("Stored canonical state differs from its conversion");
  if (link.canonical_hash)
    yield query(
      "UPDATE team_sync_links SET canonical_hash=$2 WHERE team_id=$1",
      [teamId, resultHash],
    );
  const previous = encodeSnapshot({
    atCommit: link.canonical_head,
    state: legacy,
  });
  yield query(
    "INSERT INTO sync_conversions(team_id,conversion,from_protocol,to_protocol,base_head,base_hash,result_hash,previous_snapshot,previous_snapshot_hash,options,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      teamId,
      CONVERSION,
      converted.from,
      converted.to,
      link.canonical_head,
      baseHash,
      resultHash,
      previous,
      digest(previous),
      canonical({ origins: options.origins }),
      options.now,
    ],
  );
  const history = (yield query(
    `SELECT (SELECT COUNT(*) FROM sync_receipts WHERE team_id=$1) AS receipts,
      (SELECT COUNT(*) FROM sync_conflicts WHERE team_id=$1) AS conflicts,
      (SELECT COUNT(*) FROM sync_outbox WHERE team_id=$1) AS outbox`,
    [teamId],
  )).rows[0];
  report.links.kept.push(...converted.stats.kept);
  return {
    teamId,
    mode: link.mode,
    fromProtocol: converted.from,
    toProtocol: converted.to,
    baseHead: link.canonical_head,
    baseHash,
    resultHash,
    entities: Object.keys(converted.state.entities).length,
    renamed: converted.stats.renamed,
    documents: converted.stats.documents,
    links: converted.stats.links,
    receiptsKept: Number(history.receipts),
    conflictsKept: Number(history.conflicts),
    outboxKept: Number(history.outbox),
  };
}

// Site-local state of every site of the team: exclusions (L), revision
// high-water marks, maintenance manifests and change events.
function* convertSiteLocal(teamId, options, report) {
  const stats = newStats();
  for (const row of (yield query(
    "SELECT site_id,kind,entity_key,generation FROM site_retention WHERE team_id=$1",
    [teamId],
  )).rows) {
    const key = JSON.parse(row.entity_key);
    if (row.kind !== "document" || !isLegacyDocumentKey(key)) continue;
    yield query(
      "UPDATE site_retention SET entity_key=$6 WHERE team_id=$1 AND site_id=$2 AND kind=$3 AND entity_key=$4 AND generation=$5",
      [
        teamId,
        row.site_id,
        row.kind,
        row.entity_key,
        row.generation,
        canonical(documentKey(key)),
      ],
    );
    report.site.retention++;
  }
  for (const row of (yield query(
    "SELECT entity,entity_key FROM site_entity_revisions WHERE team_id=$1",
    [teamId],
  )).rows) {
    const key = JSON.parse(row.entity_key),
      entity = entityName(row.entity),
      next = canonical(entityKey(row.entity, key));
    if (entity === row.entity && next === row.entity_key) continue;
    yield query(
      "UPDATE site_entity_revisions SET entity=$4,entity_key=$5 WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [teamId, row.entity, row.entity_key, entity, next],
    );
    report.site.revisions++;
  }
  for (const row of (yield query(
    "SELECT job_id,manifest,progress FROM site_maintenance_jobs WHERE team_id=$1",
    [teamId],
  )).rows) {
    const manifest = convertText(row.manifest, options, stats),
      progress = convertText(row.progress, options, stats);
    if (manifest === row.manifest && progress === row.progress) continue;
    yield query(
      "UPDATE site_maintenance_jobs SET manifest=$2,progress=$3 WHERE job_id=$1",
      [row.job_id, manifest, progress],
    );
    report.site.jobs++;
  }
  for (const row of (yield query(
    "SELECT cursor,payload FROM site_events WHERE team_id=$1 AND payload LIKE '%report%'",
    [teamId],
  )).rows) {
    const payload = convertText(row.payload, options, stats);
    if (payload === row.payload) continue;
    yield query("UPDATE site_events SET payload=$2 WHERE cursor=$1", [
      row.cursor,
      payload,
    ]);
    report.site.events++;
  }
  report.links.kept.push(...stats.kept);
  return stats.unverified;
}

// The import retry key: stableId(import:sheet:mode:year[:copy]). The year is
// not recorded with the import, and one sheet may have been applied to
// several years, so every year the application accepts (yearSchema) is a
// candidate: old key -> the same key under the new mode name. An existing key
// is moved only when it is one of these; nothing is guessed.
function importKeys(importId, sheet, mode, copyId) {
  const suffix = copyId ? ":" + copyId : "",
    keys = new Map();
  for (const year of YEARS)
    keys.set(
      stableId(`${importId}:${sheet}:${mode}:${year}${suffix}`),
      stableId(`${importId}:${sheet}:${importMode(mode)}:${year}${suffix}`),
    );
  return keys;
}

function* convertSqliteApplication(options, report, problems) {
  // Import retries: keyed by the mode name, which changes.
  const operations = new Map(
    (yield query("SELECT id,response FROM operations")).rows
      .map((row) => [row.id, parse(row.response)])
      .filter(([, value]) => value && !value.kind),
  );
  const legacyOperations = new Map(
    [...operations].filter(([, value]) => isLegacyImportMode(value.mode)),
  );
  // Each applied import left one audit entry with its sheet and mode.
  const candidates = new Map();
  for (const row of (yield query(
    "SELECT target,after_json FROM audit WHERE action='import'",
  )).rows) {
    const after = parse(row.after_json);
    if (!isLegacyImportMode(after?.mode)) continue;
    for (const [old, next] of importKeys(
      row.target,
      after.sheet,
      after.mode,
      after.reportId,
    ))
      candidates.set(old, next);
  }
  const keys = new Map();
  for (const id of legacyOperations.keys())
    if (candidates.has(id)) keys.set(id, candidates.get(id));
    else
      problems.push(
        `import retry ${id}: its import, sheet, mode and year cannot be reproduced`,
      );
  for (const [old, next] of keys)
    if (operations.has(next) && next !== old)
      problems.push(`import retry ${old}: new key ${next} already exists`);
  if (problems.length) return;
  for (const [old, next] of keys) {
    yield query("UPDATE operations SET id=$2,response=$3 WHERE id=$1", [
      old,
      next,
      JSON.stringify(
        convertJson(importResult(legacyOperations.get(old)), options),
      ),
    ]);
    report.retries.importKeys++;
  }
  for (const row of (yield query("SELECT id,data,result FROM imports")).rows) {
    const stats = newStats(),
      data = convertText(row.data, options, stats),
      result = convertText(row.result, options, stats, importResult);
    if (data === row.data && result === row.result) continue;
    yield query("UPDATE imports SET data=$2,result=$3 WHERE id=$1", [
      row.id,
      data,
      result,
    ]);
    report.imports++;
  }
  // History: action names, copy references and the bodies kept with deleted
  // rows, which a restore writes back.
  const stats = newStats();
  for (const row of (yield query(
    "SELECT id,action,before_json,after_json FROM audit WHERE action='report' OR action LIKE 'report-%' OR action='import' OR instr(COALESCE(before_json,''),'report')>0 OR instr(COALESCE(after_json,''),'report')>0",
  )).rows) {
    const action = auditAction(row.action),
      before = convertText(row.before_json, options, stats),
      after = convertText(
        row.after_json,
        options,
        stats,
        row.action === "import" ? importResult : undefined,
      );
    if (
      action === row.action &&
      before === row.before_json &&
      after === row.after_json
    )
      continue;
    yield query(
      "UPDATE audit SET action=$2,before_json=$3,after_json=$4 WHERE id=$1",
      [row.id, action, before, after],
    );
    report.audit++;
  }
  report.links.history += stats.links;
  report.links.kept.push(...stats.kept);
  if (stats.unverified.length)
    throw new ConversionError(
      stats.unverified.map((url) => "history link not verifiable: " + url),
    );
  yield* convertSqliteDocuments(options, report);
}

// Bodies are immutable versions shared by the original and its copies. A
// converted body becomes one new version (or the existing one with the same
// hash); every reference moves to it and the replaced version is pruned as a
// document save prunes it. Revisions advance so a stale editor cannot write
// the old body back silently.
function* convertSqliteDocuments(options, report) {
  const moved = new Map(),
    bodies = new Map();
  for (const row of (yield query(
    "SELECT * FROM document_versions WHERE instr(markdown,'/links/report-')>0 ORDER BY id",
  )).rows) {
    const converted = convertMarkdownLinks(row.markdown, options);
    report.links.kept.push(...converted.kept);
    if (converted.unverified.length)
      throw new ConversionError(
        converted.unverified.map(
          (url) => `document version ${row.id}: link not verifiable: ${url}`,
        ),
      );
    if (!converted.changes) continue;
    const hash = sha256(converted.markdown);
    let target = (yield query(
      "SELECT id FROM document_versions WHERE team_id=$1 AND document_id=$2 AND content_hash=$3",
      [row.team_id, row.document_id, hash],
    )).rows[0]?.id;
    if (!target) {
      target = randomUUID();
      yield query(
        "INSERT INTO document_versions(id,team_id,document_id,content_hash,markdown,has_content,created_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          target,
          row.team_id,
          row.document_id,
          hash,
          converted.markdown,
          row.has_content,
          options.now,
          row.created_by,
        ],
      );
      report.documents.versions++;
    }
    moved.set(row.id, target);
    bodies.set(target, converted.markdown);
    report.links.documents += converted.changes;
  }
  // Copies whose current bodies move; their stored sheets are rewritten below.
  const copies = new Set();
  for (const old of moved.keys())
    for (const row of (yield query(
      "SELECT DISTINCT sheet_clone_id FROM sheet_clone_documents WHERE version_id=$1",
      [old],
    )).rows)
      copies.add(row.sheet_clone_id);
  for (const [old, next] of moved) {
    for (const table of ["task_documents", "annual_memos", "sheet_clone_memos"])
      report.documents.references += (yield query(
        `UPDATE ${table} SET version_id=$2,revision=revision+1 WHERE version_id=$1`,
        [old, next],
      )).rowCount;
    report.documents.references += (yield query(
      "UPDATE calendar_entries SET version_id=$2,revision=revision+1,preview=$3 WHERE version_id=$1",
      [old, next, calendarPreview(bodies.get(next))],
    )).rowCount;
    report.documents.references += (yield query(
      "UPDATE sheet_clone_documents SET version_id=$2 WHERE version_id=$1",
      [old, next],
    )).rowCount;
  }
  // The stored sheet keeps tab titles and the version each tab last saved;
  // the relational rows own the current body. Both name the new version.
  for (const id of [...copies].sort()) {
    const row = (yield query("SELECT id,data FROM sheet_clones WHERE id=$1", [
        id,
      ])).rows[0],
      data = decodeSheetClone(row.data);
    report.sheetClones.decoded++;
    let changed = false;
    for (const task of data.tasks)
      for (const document of task.documents || [])
        if (moved.has(document.versionId)) {
          document.versionId = moved.get(document.versionId);
          changed = true;
        }
    if (!changed) continue;
    yield query("UPDATE sheet_clones SET data=$2 WHERE id=$1", [
      row.id,
      encodeSheetClone(data),
    ]);
    report.sheetClones.reencoded++;
  }
  for (const old of moved.keys())
    report.documents.pruned += (yield query(
      `DELETE FROM document_versions WHERE id=$1
      AND NOT EXISTS(SELECT 1 FROM task_documents WHERE version_id=document_versions.id)
      AND NOT EXISTS(SELECT 1 FROM calendar_entries WHERE version_id=document_versions.id)
      AND NOT EXISTS(SELECT 1 FROM annual_memos WHERE version_id=document_versions.id)
      AND NOT EXISTS(SELECT 1 FROM sheet_clone_memos WHERE version_id=document_versions.id)
      AND NOT EXISTS(SELECT 1 FROM sheet_clone_documents WHERE version_id=document_versions.id)`,
      [old],
    )).rowCount;
}

// The external site's rows of the team (V), its history and retry records.
function* convertPostgresApplication(teamId, options, report, problems) {
  const rows = (yield query(
    "SELECT entity,entity_key,payload,revision,deleted FROM site_entities WHERE team_id=$1 ORDER BY entity,entity_key",
    [teamId],
  )).rows;
  const imports = rows.filter((row) => row.entity === "import");
  const operations = new Map(
    (yield query(
      "SELECT op_id,response FROM site_operations WHERE team_id=$1",
      [teamId],
    )).rows.map((row) => [row.op_id, row.response]),
  );
  const keys = new Map();
  for (const [id, text] of operations) {
    if (id.startsWith("report-create:"))
      keys.set(id, "sheet-clone-create:" + id.slice("report-create:".length));
    let response;
    try {
      response = JSON.parse(text);
    } catch {
      continue;
    }
    const body = response?.$data || response;
    if (!isLegacyImportMode(body?.mode) || typeof body.count !== "number")
      continue;
    let next;
    for (const row of imports) {
      const importId = JSON.parse(row.entity_key)[0];
      for (const sheet of parse(row.payload)?.sheets || [])
        next ??= importKeys(importId, sheet.name, body.mode, body.reportId).get(
          id,
        );
    }
    if (next) keys.set(id, next);
    else
      problems.push(
        `team ${teamId}: import retry ${id}: its import, sheet, mode and year cannot be reproduced`,
      );
  }
  for (const [old, next] of keys)
    if (operations.has(next))
      problems.push(
        `team ${teamId}: retry ${old}: new key ${next} already exists`,
      );
  if (problems.length) return;
  const stats = newStats();
  // Site rows: rename first, then advance the revision of changed bodies.
  for (const row of rows) {
    if (["syncTotals", "syncRefresh"].includes(row.entity)) continue;
    if (["reportTask", "reportCell"].includes(row.entity))
      throw new ConversionError([
        `team ${teamId}: site row ${row.entity} is not an application record`,
      ]);
    const key = JSON.parse(row.entity_key),
      entity = entityName(row.entity),
      nextKey = canonical(entityKey(row.entity, key)),
      before = stats.links,
      payload = convertText(row.payload, options, stats),
      body = payload !== row.payload && row.entity === "document";
    if (
      entity === row.entity &&
      nextKey === row.entity_key &&
      payload === row.payload
    )
      continue;
    let revision = integer(row.revision);
    if (body) {
      const high = (yield query(
        "SELECT revision FROM site_entity_revisions WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
        [teamId, entity, nextKey],
      )).rows[0];
      revision = Math.max(revision, integer(high?.revision) || 0) + 1;
      yield query(
        "INSERT INTO site_entity_revisions(team_id,entity,entity_key,revision) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET revision=excluded.revision",
        [teamId, entity, nextKey, revision],
      );
      report.links.documents += stats.links - before;
    }
    yield query(
      "UPDATE site_entities SET entity=$4,entity_key=$5,payload=$6,revision=$7 WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [teamId, row.entity, row.entity_key, entity, nextKey, payload, revision],
    );
    report.site.entities++;
    if (body) report.documents.references++;
  }
  for (const row of (yield query(
    "SELECT id,action,target,payload FROM site_audit WHERE team_id=$1",
    [teamId],
  )).rows) {
    const action = auditAction(row.action),
      target = entityIdText(row.target),
      before = stats.links,
      payload = convertText(row.payload, options, stats);
    if (
      action === row.action &&
      target === row.target &&
      payload === row.payload
    )
      continue;
    report.links.history += stats.links - before;
    yield query(
      "UPDATE site_audit SET action=$2,target=$3,payload=$4 WHERE id=$1",
      [row.id, action, target, payload],
    );
    report.audit++;
  }
  // Retry keys that name the copy domain move to the new names; the request
  // hash and response stay as recorded. The hash covers a body no record
  // keeps, so a request of a closed session cannot match it (409), while a
  // repeated import of the same sheet still finds its key and is not applied
  // twice.
  for (const [old, next] of keys) {
    yield query(
      "UPDATE site_operations SET op_id=$3 WHERE team_id=$1 AND op_id=$2",
      [teamId, old, next],
    );
    report.retries.operations++;
  }
  report.links.kept.push(...stats.kept);
  if (stats.unverified.length)
    throw new ConversionError(
      stats.unverified.map(
        (url) => `team ${teamId}: link not verifiable: ${url}`,
      ),
    );
}

const newReport = (options, engine) => ({
  conversion: CONVERSION,
  engine,
  origins: options.origins,
  convertedAt: options.now,
  audit: 0,
  imports: 0,
  retries: { importKeys: 0, operations: 0 },
  documents: { versions: 0, references: 0, pruned: 0 },
  sheetClones: { decoded: 0, reencoded: 0 },
  site: { entities: 0, retention: 0, revisions: 0, jobs: 0, events: 0 },
  links: { documents: 0, history: 0, kept: [] },
  sync: [],
});
function finish(report) {
  const kept = [...new Set(report.links.kept)];
  return {
    ...report,
    links: {
      ...report.links,
      kept: kept.length,
      keptSamples: kept.slice(0, 20),
    },
  };
}

function* sqliteConversion(options) {
  const report = newReport(options, "sqlite"),
    problems = [];
  const teams = (yield query("SELECT id FROM teams ORDER BY id")).rows.map(
    (row) => row.id,
  );
  // Preflight every team before the first write.
  for (const teamId of teams) {
    const link = (yield query(
      "SELECT * FROM team_sync_links WHERE team_id=$1",
      [teamId],
    )).rows[0];
    if (link) problems.push(...(yield* syncPreflight(teamId, link)));
  }
  if (problems.length) throw new ConversionError(problems);
  yield* convertSqliteApplication(options, report, problems);
  if (problems.length) throw new ConversionError(problems);
  for (const teamId of teams) {
    const sync = yield* convertSync(teamId, options, report, problems);
    if (problems.length) throw new ConversionError(problems);
    if (sync) report.sync.push(sync);
    const unverified = yield* convertSiteLocal(teamId, options, report);
    if (unverified.length)
      throw new ConversionError(
        unverified.map((url) => "link not verifiable: " + url),
      );
  }
  yield* verifySqlite(options);
  const summary = finish(report);
  yield query(
    "INSERT INTO data_conversions(name,schema_version,options,summary,applied_at) VALUES($1,34,$2,$3,$4)",
    [
      CONVERSION,
      canonical({ origins: options.origins }),
      canonical(summary),
      options.now,
    ],
  );
  return summary;
}

function* postgresConversion(options) {
  const report = newReport(options, "postgres"),
    problems = [];
  const teamId = (yield query(
    "SELECT team_id FROM team_meta WHERE singleton=1",
  )).rows[0]?.team_id;
  if (!teamId) throw new ConversionError(["team identity is missing"]);
  const link = (yield query("SELECT * FROM team_sync_links WHERE team_id=$1", [
    teamId,
  ])).rows[0];
  if (link) problems.push(...(yield* syncPreflight(teamId, link)));
  if (problems.length) throw new ConversionError(problems);
  // Revision high-water marks are renamed before changed bodies advance them.
  const unverified = yield* convertSiteLocal(teamId, options, report);
  if (unverified.length)
    throw new ConversionError(
      unverified.map((url) => "link not verifiable: " + url),
    );
  yield* convertPostgresApplication(teamId, options, report, problems);
  if (problems.length) throw new ConversionError(problems);
  const sync = yield* convertSync(teamId, options, report, problems);
  if (problems.length) throw new ConversionError(problems);
  if (sync) report.sync.push(sync);
  // C's kept totals no longer match its records; the next reader measures it.
  yield query(
    "DELETE FROM site_entities WHERE team_id=$1 AND entity='syncTotals'",
    [teamId],
  );
  yield* verifyPostgres(teamId, options);
  const summary = finish(report);
  yield query(
    "INSERT INTO data_conversions(name,schema_version,options,summary,applied_at) VALUES($1,3,$2,$3,$4)",
    [
      CONVERSION,
      canonical({ origins: options.origins }),
      canonical(summary),
      options.now,
    ],
  );
  return summary;
}

// What the application reads after the conversion carries no earlier name.
function* verifySqlite(options) {
  const left = (yield query(
    `SELECT
      (SELECT COUNT(*) FROM audit WHERE action='report' OR action LIKE 'report-%') AS audit,
      (SELECT COUNT(*) FROM sync_entities WHERE entity IN ('report','reportTask','reportCell') OR (entity='document' AND entity_key LIKE '["report%')) AS entities,
      (SELECT COUNT(*) FROM site_retention WHERE entity_key LIKE '["report%') AS retention,
      (SELECT COUNT(*) FROM site_entity_revisions WHERE entity IN ('report','reportTask','reportCell') OR entity_key LIKE '["report%') AS revisions,
      (SELECT COUNT(*) FROM operations WHERE json_extract(response,'$.mode') IN ('report','copy')) AS operations`,
  )).rows[0];
  const problems = Object.entries(left)
    .filter(([, count]) => Number(count))
    .map(
      ([name, count]) => `${count} ${name} rows still carry an earlier name`,
    );
  for (const row of (yield query(
    "SELECT id,markdown FROM document_versions WHERE instr(markdown,'/links/report-')>0",
  )).rows)
    if (convertMarkdownLinks(row.markdown, options).changes)
      problems.push(
        `document version ${row.id} still links to an earlier address`,
      );
  if (problems.length) throw new ConversionError(problems);
}
function* verifyPostgres(teamId, options) {
  const left = (yield query(
    `SELECT
      (SELECT COUNT(*) FROM site_audit WHERE team_id=$1 AND (action='report' OR action LIKE 'report-%')) AS audit,
      (SELECT COUNT(*) FROM site_entities WHERE team_id=$1 AND (entity IN ('report','reportTask','reportCell') OR (entity='document' AND entity_key LIKE '["report%'))) AS rows,
      (SELECT COUNT(*) FROM sync_entities WHERE team_id=$1 AND (entity IN ('report','reportTask','reportCell') OR (entity='document' AND entity_key LIKE '["report%'))) AS entities,
      (SELECT COUNT(*) FROM site_retention WHERE team_id=$1 AND entity_key LIKE '["report%') AS retention,
      (SELECT COUNT(*) FROM site_entity_revisions WHERE team_id=$1 AND (entity IN ('report','reportTask','reportCell') OR entity_key LIKE '["report%')) AS revisions,
      (SELECT COUNT(*) FROM site_operations WHERE team_id=$1 AND op_id LIKE 'report-create:%') AS operations`,
    [teamId],
  )).rows[0];
  const problems = Object.entries(left)
    .filter(([, count]) => Number(count))
    .map(
      ([name, count]) => `${count} ${name} rows still carry an earlier name`,
    );
  for (const row of (yield query(
    "SELECT entity_key,payload FROM site_entities WHERE team_id=$1 AND entity='document' AND payload LIKE '%/links/report-%'",
    [teamId],
  )).rows)
    if (convertMarkdownLinks(parse(row.payload)?.markdown, options).changes)
      problems.push(
        `site document ${row.entity_key} still links to an earlier address`,
      );
  if (problems.length) throw new ConversionError(problems);
}

function sqliteExecute(db, sql, params) {
  const bindings = [];
  const translated = sql.replace(/\$(\d+)/g, (_, n) => {
    bindings.push(params[Number(n) - 1]);
    return "?";
  });
  const statement = db.prepare(translated);
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    const rows = statement.all(...bindings).map((row) => ({ ...row }));
    return { rows, rowCount: rows.length };
  }
  const result = statement.run(...bindings);
  return { rows: [], rowCount: Number(result.changes) };
}
// The conversion step of migrateSqlite: synchronous, inside its transaction.
export const sqliteSheetCloneConversion = (options) => (db) =>
  executeSync(sqliteConversion(normalizeOptions(options)), (sql, params) =>
    sqliteExecute(db, sql, params),
  );
// The conversion step of the PostgreSQL team v3 migration, in its transaction.
export const postgresSheetCloneConversion = (options) => async (client) => {
  await client.query("SET LOCAL search_path TO graeboard, pg_catalog");
  return executeAsync(
    postgresConversion(normalizeOptions(options)),
    (sql, values) => client.query(sql, values),
  );
};

// A JSON export of format v6 (`reports`) as the v7 file the current release
// writes (`sheetClones`), with the same link conversion. The application
// itself never reads exports; earlier files are converted only on request.
export function convertExport(value, options) {
  options = normalizeOptions(options);
  const packed =
      value && typeof value === "object" && value.$data !== undefined,
    body = packed ? value.$data : value;
  if (body?.format !== "weekly-plan" || body.schemaVersion !== 6)
    throw new Error("A weekly-plan JSON export of schemaVersion 6 is required");
  const stats = newStats(),
    { reports = [], ...rest } = body,
    converted = convertJson({ ...rest, sheetClones: reports }, options, stats);
  if (stats.unverified.length)
    throw new ConversionError(
      stats.unverified.map((url) => "export link not verifiable: " + url),
    );
  converted.schemaVersion = 7;
  return {
    export: packed ? { ...value, $data: converted } : converted,
    links: stats.links,
    kept: [...new Set(stats.kept)].length,
  };
}
