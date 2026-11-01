import {
  canonical,
  entityId,
  emptyState,
  sumFromLanes,
} from "../server/sync/protocol.mjs";
import { reduce, uniqueName } from "../server/sync/reducer.mjs";

const recordFromRow = (row) => ({
  entity: row.entity,
  key: JSON.parse(row.entity_key),
  generation: row.generation,
  version: row.version,
  payload: row.payload == null ? null : JSON.parse(row.payload),
  deleted: !!row.deleted,
});

// The records of C a reduction can consult: the changed keys and those of the
// operations, the parents and restored children the reducer checks, every tag,
// calendars using a touched tag, the protocol marker, and the receipts and
// conflicts the operations name. Name uniqueness comes from SQL, so the cost
// follows the change instead of the team's whole state.
export class CanonicalSlice {
  constructor(tx, teamId) {
    Object.assign(this, { tx, teamId });
    this.state = emptyState();
    this.wanted = new Map();
    this.prefixes = new Map();
    this.tags = new Set();
    this.opIds = new Set();
    this.resolves = new Set();
    this.tagsRead = new WeakSet();
    this.want("protocol", []);
  }
  want(entity, key) {
    this.wanted.set(entityId(entity, key), [entity, key]);
  }
  children(entity, key) {
    const prefix = canonical(key).slice(0, -1) + ",";
    this.prefixes.set(entity + "\u0000" + prefix, [entity, prefix]);
  }
  // A restore re-stamps the parent's cells and documents.
  restored(entity, key) {
    if (!["task", "calendar"].includes(entity)) return;
    if (entity === "task") this.children("cell", [key[0]]);
    this.children("document", [entity, key[0]]);
  }
  touch(entity, key, action) {
    this.want(entity, key);
    if (entity === "cell") this.want("task", [key[0]]);
    if (entity === "document") {
      if (["task", "calendar"].includes(key[0])) this.want(key[0], [key[1]]);
      else if (key[0].startsWith("report")) this.want("report", [key[1]]);
    }
    if (entity === "reportTask") this.want("report", [key[0]]);
    if (entity === "reportCell") {
      this.want("report", [key[0]]);
      this.want("reportTask", key.slice(0, 2));
    }
    if (entity === "report") {
      this.children("reportTask", [key[0]]);
      this.children("reportCell", [key[0]]);
    }
    if (entity === "tag") this.tags.add(key[0]);
    if (action === "restore") this.restored(entity, key);
  }
  include(operations) {
    for (const op of operations) {
      for (const change of op.changes)
        this.touch(change.entity, change.key, change.action);
      this.opIds.add(op.opId);
      for (const id of op.dependsOn) this.opIds.add(id);
      for (const id of op.resolves || []) this.resolves.add(id);
    }
    return this;
  }
  async rows(sql, values, target) {
    const added = [];
    for (const row of (await this.tx.query(sql, values)).rows) {
      const record = recordFromRow(row),
        id = entityId(record.entity, record.key);
      if (target.entities[id]) continue;
      target.entities[id] = record;
      added.push([id, record]);
    }
    return added;
  }
  async readChildren(target = this.state) {
    if (!this.prefixes.size) return [];
    const list = [...this.prefixes.values()];
    this.prefixes.clear();
    return this.rows(
      "SELECT s.* FROM sync_entities s JOIN unnest($2::text[],$3::text[]) w(entity,prefix) ON s.team_id=$1 AND s.entity=w.entity AND left(s.entity_key,length(w.prefix))=w.prefix",
      [
        this.teamId,
        list.map(([entity]) => entity),
        list.map(([, prefix]) => prefix),
      ],
      target,
    );
  }
  // Reads every wanted record the target lacks. Each call may follow further
  // include()s; records already in the target are kept as they are.
  async load(target = this.state) {
    const team = this.teamId,
      ids = [...this.wanted].filter(([id]) => !target.entities[id]);
    if (ids.length)
      await this.rows(
        "SELECT s.* FROM sync_entities s JOIN unnest($2::text[],$3::text[]) w(entity,entity_key) ON s.team_id=$1 AND s.entity=w.entity AND s.entity_key=w.entity_key",
        [
          team,
          ids.map(([, [entity]]) => entity),
          ids.map(([, [, key]]) => canonical(key)),
        ],
        target,
      );
    if (!this.tagsRead.has(target)) {
      this.tagsRead.add(target);
      await this.rows(
        "SELECT * FROM sync_entities WHERE team_id=$1 AND entity='tag'",
        [team],
        target,
      );
    }
    await this.readChildren(target);
    if (this.tags.size)
      await this.rows(
        "SELECT s.* FROM sync_entities s JOIN unnest($2::text[]) t(id) ON s.team_id=$1 AND s.entity='calendar' AND strpos(s.payload,t.id)>0",
        [team, [...this.tags].map((id) => JSON.stringify(id))],
        target,
      );
    const opIds = [...this.opIds].filter((id) => !target.receipts[id]);
    if (opIds.length)
      for (const row of (
        await this.tx.query(
          "SELECT op_id,receipt FROM sync_receipts WHERE team_id=$1 AND op_id=ANY($2)",
          [team, opIds],
        )
      ).rows)
        target.receipts[row.op_id] = JSON.parse(row.receipt);
    const resolves = [...this.resolves].filter((id) => !target.conflicts[id]);
    if (resolves.length)
      for (const row of (
        await this.tx.query(
          "SELECT conflict_id,payload FROM sync_conflicts WHERE team_id=$1 AND conflict_id=ANY($2)",
          [team, resolves],
        )
      ).rows)
        target.conflicts[row.conflict_id] = JSON.parse(row.payload);
    return target;
  }
  // The same index reduceMany builds, from SQL instead of every record.
  async context(target = this.state) {
    const names = new Map(),
      tagUsers = new Map();
    for (const row of (
      await this.tx.query(
        "SELECT entity,entity_key,deleted,payload::json->>'name' AS name,payload::json->>'userId' AS user_id FROM sync_entities WHERE team_id=$1 AND entity IN ('tag','filter','report')",
        [this.teamId],
      )
    ).rows) {
      const id = entityId(row.entity, JSON.parse(row.entity_key)),
        loaded = target.entities[id];
      if (!loaded && row.name == null) continue;
      const name = uniqueName(
        loaded || {
          entity: row.entity,
          deleted: !!row.deleted,
          payload: { name: row.name, userId: row.user_id || undefined },
        },
      );
      if (name) names.set(name, id);
    }
    for (const [id, record] of Object.entries(target.entities))
      if (record.entity === "calendar" && !record.deleted)
        for (const tag of record.payload.tags || []) {
          if (!tagUsers.has(tag.id)) tagUsers.set(tag.id, new Set());
          tagUsers.get(tag.id).add(id);
        }
    return { names, tagUsers };
  }
}

// reduceMany over a slice: the same per-command rollback, receipts and
// conflicts, with name and tag indexes from context() instead of every record.
export function reduceSlice(base, operations, identity, { names, tagUsers }) {
  let state = {
    entities: { ...base.entities },
    receipts: { ...base.receipts },
    conflicts: { ...base.conflicts },
  };
  const context = {
    entities: state.entities,
    names: new Map(names),
    tagUsers: new Map(
      [...tagUsers].map(([tag, users]) => [tag, new Set(users)]),
    ),
  };
  for (const op of operations)
    state = reduce(
      state,
      op,
      identity || { teamId: op.teamId, repoId: op.repoId },
      context,
    ).state;
  return { state, context };
}

// The records a reduced slice changed, as the exact text canonical() writes for
// them. C never drops a record: deletions are tombstones and receipts and
// conflicts are permanent.
export function sliceChanges(base, state) {
  const changes = {};
  for (const section of ["entities", "receipts", "conflicts"]) {
    for (const id of Object.keys(base[section]))
      if (!state[section][id])
        throw new Error("A reduced slice cannot remove canonical records");
    const ids = [],
      bodies = [];
    for (const [id, value] of Object.entries(state[section]))
      if (value !== base[section][id]) {
        ids.push(id);
        bodies.push(canonical(value));
      }
    changes[section] = { ids, bodies };
  }
  return changes;
}

// canonical(state) orders keys by UTF-16 code unit; PostgreSQL's "C" collation
// orders UTF-8 bytes, which agrees except for characters outside the BMP.
const astral = /[\uD800-\uDFFF]/;
const SECTION = (table, id, body) =>
  `SELECT ${id} AS id, ${body} AS body FROM ${table} WHERE team_id=$1`;
const ENTITY_ROWS = SECTION(
  "sync_entities",
  `'['||to_json(entity)::text||','||entity_key||']'`,
  `'{"deleted":'||CASE WHEN deleted=1 THEN 'true' ELSE 'false' END||',"entity":'||to_json(entity)::text||',"generation":'||to_json(generation)::text||',"key":'||entity_key||',"payload":'||COALESCE(payload,'null')||',"version":'||to_json(version)::text||'}'`,
);
const object = (rows) =>
  `'{'||COALESCE((SELECT string_agg(to_json(id)::text||':'||body,',' ORDER BY id COLLATE "C") FROM ${rows}),'')||'}'`;
const stateText = (conflicts, entities, receipts) =>
  `encode(sha256(convert_to('{"conflicts":'||${object(conflicts)}||',"entities":'||${object(entities)}||',"receipts":'||${object(receipts)}||'}','UTF8')),'hex')`;
const overlaid = (rows, changes) =>
  `(SELECT id,body FROM ${rows} r WHERE NOT EXISTS (SELECT 1 FROM ${changes} c WHERE c.id=r.id) UNION ALL SELECT id,body FROM ${changes})`;
const HASHES_SQL = `WITH
  e AS MATERIALIZED (${ENTITY_ROWS}),
  r AS MATERIALIZED (${SECTION("sync_receipts", "op_id", "receipt")}),
  c AS MATERIALIZED (${SECTION("sync_conflicts", "conflict_id", "payload")}),
  ec AS (SELECT * FROM unnest($2::text[],$3::text[]) AS x(id,body)),
  rc AS (SELECT * FROM unnest($4::text[],$5::text[]) AS x(id,body)),
  cc AS (SELECT * FROM unnest($6::text[],$7::text[]) AS x(id,body)),
  en AS ${overlaid("e", "ec")},
  rn AS ${overlaid("r", "rc")},
  cn AS ${overlaid("c", "cc")}
SELECT CASE WHEN $8 THEN ${stateText("c", "e", "r")} END AS current, ${stateText("cn", "en", "rn")} AS next`;

// stateHash() of C and of C with these changes, computed by PostgreSQL from
// the stored canonical text so the caller never loads or serializes C. Returns
// null when the key order could differ from canonical(); the caller compares
// current with the stored canonical hash before trusting next. A caller that
// already verified current in this run passes { current: false } and gets
// only next, half the work.
export async function canonicalHashes(
  tx,
  teamId,
  changes,
  { current = true } = {},
) {
  const sections = ["entities", "receipts", "conflicts"];
  if (
    sections.some((section) =>
      changes[section].ids.some((id) => astral.test(id)),
    )
  )
    return null;
  // Each hash sorts and joins the whole team's canonical text (about 19MB for
  // 31,000 records). A small database exceeds the pool's 15-second statement
  // limit when the sort spills to disk, so this transaction alone may take
  // longer and sort in memory.
  await tx.query(
    "SET LOCAL statement_timeout = '120s'; SET LOCAL work_mem = '64MB'",
  );
  const row = (
    await tx.query(HASHES_SQL, [
      teamId,
      ...sections.flatMap((section) => [
        changes[section].ids,
        changes[section].bodies,
      ]),
      current,
    ])
  ).rows[0];
  return { current: row.current, next: row.next };
}

// C's state sum (see stateSum) and the capacity totals of capacityTotals,
// from one order-free aggregate: no sort and no whole-team string.
const lane = (i) =>
  `COALESCE(sum(('x'||encode(substring(h from ${8 * i + 1} for 8),'hex'))::bit(64)::bigint::numeric),0)::text`;
const TOTALS_SQL = `WITH
  rows AS (
    ${SECTION("sync_entities", `'['||to_json(entity)::text||','||entity_key||']'`, `'{"deleted":'||CASE WHEN deleted=1 THEN 'true' ELSE 'false' END||',"entity":'||to_json(entity)::text||',"generation":'||to_json(generation)::text||',"key":'||entity_key||',"payload":'||COALESCE(payload,'null')||',"version":'||to_json(version)::text||'}'`).replace("SELECT ", "SELECT 'e' AS s, ")}
    UNION ALL ${SECTION("sync_receipts", "op_id", "receipt").replace("SELECT ", "SELECT 'r' AS s, ")}
    UNION ALL ${SECTION("sync_conflicts", "conflict_id", "payload").replace("SELECT ", "SELECT 'c' AS s, ")}
  ),
  d AS (SELECT s, id, body, sha256(convert_to(s||E'\\n'||id||E'\\n'||body,'UTF8')) AS h FROM rows)
SELECT ${[0, 1, 2, 3].map((i) => `${lane(i)} AS l${i}`).join(", ")},
  count(*) FILTER (WHERE s='e') AS entities,
  64 + COALESCE(sum(octet_length(to_json(id)::text)+octet_length(body)+2) FILTER (WHERE s<>'r'),0) AS state_bytes,
  2 + COALESCE(sum(octet_length(to_json(id)::text)+octet_length(body)+2) FILTER (WHERE s='r'),0) AS receipt_bytes
FROM d`;
export async function computeTotals(tx, teamId) {
  const row = (await tx.query(TOTALS_SQL, [teamId])).rows[0];
  return {
    sum: sumFromLanes([row.l0, row.l1, row.l2, row.l3]),
    entities: Number(row.entities),
    stateBytes: Number(row.state_bytes),
    receiptBytes: Number(row.receipt_bytes),
  };
}
// The totals of C at a canonical head, kept beside the site rows like the
// sync scheduling state. commitCanonical replaces or clears them with every
// change to C, and they count only while their head is the current one.
const TOTALS_KEY = ["syncTotals", "[]"];
export async function readTotals(tx, teamId, head) {
  if (!head) return null;
  const row = (
    await tx.query(
      "SELECT payload FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [teamId, ...TOTALS_KEY],
    )
  ).rows[0];
  const totals = row && JSON.parse(row.payload);
  return totals?.head === head ? totals : null;
}
export async function writeTotals(tx, teamId, head, totals) {
  await tx.query(
    "INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,$2,$3,$4,0,0) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload",
    [teamId, ...TOTALS_KEY, canonical({ ...totals, head })],
  );
}
export async function clearTotals(tx, teamId) {
  await tx.query(
    "DELETE FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
    [teamId, ...TOTALS_KEY],
  );
}
