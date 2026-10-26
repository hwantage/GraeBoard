import { canonical, digest, entityId, equal } from "../sync/protocol.mjs";

const parse = (text) => (text === null ? null : JSON.parse(text));
const query = (sql, values = []) => ({ sql, values });
const linkFields = new Set([
  "repo_id",
  "bootstrap_id",
  "installation_id",
  "writer_epoch",
  "profile_id",
  "mode",
  "canonical_head",
  "canonical_hash",
  "generation",
  "last_received_at",
  "last_published_at",
  "last_error",
  "remote_status",
  "bootstrap_bundle",
  "lease_owner",
  "lease_until",
  "updated_at",
]);
export const LINK_METADATA_COLUMNS = ["team_id", ...linkFields]
  .filter((column) => column !== "bootstrap_bundle")
  .join(",");
const entityFromRow = (r) => ({
  entity: r.entity,
  key: parse(r.entity_key),
  generation: r.generation,
  version: r.version,
  payload: parse(r.payload),
  deleted: !!r.deleted,
});
const integer = (n) => {
  const value = Number(n);
  if (!Number.isSafeInteger(value))
    throw new Error("Stored integer exceeds supported range");
  return value;
};

export function prepareStatePatch(previous, state) {
  const patch = { entities: [], receipts: [], conflicts: [] };
  for (const [key, record] of Object.entries(state.entities)) {
    if (key !== entityId(record.entity, record.key))
      throw new Error("Entity key mismatch");
    if (
      !previous.entities[key] ||
      !equal(previous.entities[key], record)
    )
      patch.entities.push([
        record.entity,
        canonical(record.key),
        record.generation,
        record.version,
        canonical(record.payload),
        Number(!!record.deleted),
      ]);
  }
  for (const key of Object.keys(previous.entities))
    if (!state.entities[key])
      throw new Error("Canonical entities must retain deletion tombstones");
  for (const [opId, receipt] of Object.entries(state.receipts)) {
    if (previous.receipts[opId]) {
      if (!equal(previous.receipts[opId], receipt))
        throw new Error("Immutable receipt mismatch");
    } else
      patch.receipts.push([
        opId,
        receipt.payloadHash,
        receipt.result,
        canonical(receipt),
      ]);
  }
  for (const key of Object.keys(previous.receipts))
    if (!state.receipts[key])
      throw new Error("Canonical receipts cannot be removed");
  for (const [id, conflict] of Object.entries(state.conflicts)) {
    if (
      previous.conflicts[id] &&
      equal(previous.conflicts[id], conflict)
    )
      continue;
    patch.conflicts.push([
      id,
      conflict.opId,
      canonical(conflict),
      conflict.resolution || null,
    ]);
  }
  for (const key of Object.keys(previous.conflicts))
    if (!state.conflicts[key])
      throw new Error("Canonical conflicts cannot be removed");
  return patch;
}

// The SQL repository is shared without pretending a synchronous SQLite callback
// can await. A generator describes database effects; each engine drives it using
// its own connection and transaction lifetime.
const methods = {
  *readLink() {
    return (
      (yield query(
        `SELECT ${LINK_METADATA_COLUMNS} FROM team_sync_links WHERE team_id=$1`,
        [this.teamId],
      )).rows[0] || null
    );
  },
  *readBootstrap() {
    return (
      (yield query(
        "SELECT bootstrap_bundle FROM team_sync_links WHERE team_id=$1",
        [this.teamId],
      )).rows[0]?.bootstrap_bundle || null
    );
  },
  *writeLink(changes) {
    const keys = Object.keys(changes);
    if (!keys.length || keys.some((key) => !linkFields.has(key)))
      throw new Error("Invalid sync connection fields");
    if (yield* methods.readLink.call(this))
      return (yield query(
        `UPDATE team_sync_links SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(",")} WHERE team_id=$1`,
        [this.teamId, ...keys.map((key) => changes[key])],
      )).rowCount;
    const columns = ["team_id", ...keys];
    return (yield query(
      `INSERT INTO team_sync_links(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT(team_id) DO UPDATE SET ${keys.map((key) => `${key}=excluded.${key}`).join(",")}`,
      [this.teamId, ...keys.map((key) => changes[key])],
    )).rowCount;
  },
  *readState() {
    const entities = {},
      receipts = {},
      conflicts = {};
    for (const row of (yield query(
      "SELECT * FROM sync_entities WHERE team_id=$1 ORDER BY entity,entity_key",
      [this.teamId],
    )).rows) {
      const record = entityFromRow(row);
      entities[entityId(record.entity, record.key)] = record;
    }
    for (const row of (yield query(
      "SELECT op_id,receipt FROM sync_receipts WHERE team_id=$1 ORDER BY op_id",
      [this.teamId],
    )).rows)
      receipts[row.op_id] = parse(row.receipt);
    for (const row of (yield query(
      "SELECT conflict_id,payload FROM sync_conflicts WHERE team_id=$1 ORDER BY conflict_id",
      [this.teamId],
    )).rows)
      conflicts[row.conflict_id] = parse(row.payload);
    return { entities, receipts, conflicts };
  },
  *readEntity(entity, key) {
    const row = (yield query(
      "SELECT * FROM sync_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [this.teamId, entity, canonical(key)],
    )).rows[0];
    return row ? entityFromRow(row) : null;
  },
  *putEntity(record) {
    return (yield query(
      "INSERT INTO sync_entities(team_id,entity,entity_key,generation,version,payload,deleted) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET generation=excluded.generation,version=excluded.version,payload=excluded.payload,deleted=excluded.deleted",
      [
        this.teamId,
        record.entity,
        canonical(record.key),
        record.generation,
        record.version,
        canonical(record.payload),
        Number(!!record.deleted),
      ],
    )).rowCount;
  },
  *readPendingRows() {
    return (yield query(
      "SELECT * FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged' ORDER BY local_seq",
      [this.teamId],
    )).rows.map((row) => ({
      ...row,
      local_seq: integer(row.local_seq),
      operation: parse(row.payload),
    }));
  },
  *readPending() {
    return (yield* methods.readPendingRows.call(this)).map(
      (row) => row.operation,
    );
  },
  *enqueue(operation) {
    if (operation.teamId !== this.teamId)
      throw new Error("Foreign team outbox operation");
    const payload = canonical(operation),
      hash = digest(payload);
    const old = (yield query(
      "SELECT team_id,payload,local_seq FROM sync_outbox WHERE op_id=$1",
      [operation.opId],
    )).rows[0];
    if (old) {
      if (old.team_id !== this.teamId || old.payload !== payload)
        throw new Error("Immutable opId payload mismatch");
      return integer(old.local_seq);
    }
    const row = (yield query(
      "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES($1,$2,$3,$4,'pending',$5) RETURNING local_seq",
      [operation.opId, this.teamId, payload, hash, operation.createdAt],
    )).rows[0];
    return integer(row.local_seq);
  },
  *acknowledge(ids) {
    for (const opId of ids) {
      const receipt = (yield query(
        "SELECT payload_hash FROM sync_receipts WHERE team_id=$1 AND op_id=$2",
        [this.teamId, opId],
      )).rows[0];
      const row = (yield query(
        "SELECT payload,payload_hash FROM sync_outbox WHERE team_id=$1 AND op_id=$2",
        [this.teamId, opId],
      )).rows[0];
      if (
        row &&
        (!receipt ||
          receipt.payload_hash !==
            (row.payload_hash || digest(parse(row.payload))))
      )
        throw new Error("Cannot acknowledge an unverified operation");
      yield query(
        "UPDATE sync_outbox SET status='acknowledged' WHERE team_id=$1 AND op_id=$2",
        [this.teamId, opId],
      );
    }
  },
  *writeState(state, commitOid, previousState, preparedPatch) {
    const patch =
      preparedPatch ||
      prepareStatePatch(
        previousState || (yield* methods.readState.call(this)),
        state,
      );
    const batchSize = this.batchSize || 1,
      teamId = this.teamId;
    const write = function* (table, columns, rows, transform, conflict = "") {
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize).map(transform),
          values = [];
        const placeholders = batch
          .map(
            (row) =>
              "(" +
              row
                .map((value) => {
                  values.push(value);
                  return "$" + values.length;
                })
                .join(",") +
              ")",
          )
          .join(",");
        yield query(
          `INSERT INTO ${table}(${columns}) VALUES${placeholders}${conflict}`,
          values,
        );
      }
    };
    yield* write(
      "sync_entities",
      "team_id,entity,entity_key,generation,version,payload,deleted",
      patch.entities,
      (row) => [teamId, ...row],
      " ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET generation=excluded.generation,version=excluded.version,payload=excluded.payload,deleted=excluded.deleted",
    );
    yield* write(
      "sync_receipts",
      "team_id,op_id,payload_hash,result,commit_oid,receipt",
      patch.receipts,
      ([opId, hash, result, receipt]) => [
        teamId,
        opId,
        hash,
        result,
        commitOid,
        receipt,
      ],
    );
    yield* write(
      "sync_conflicts",
      "team_id,conflict_id,op_id,payload,resolution",
      patch.conflicts,
      (row) => [teamId, ...row],
      " ON CONFLICT(team_id,conflict_id) DO UPDATE SET payload=excluded.payload,resolution=excluded.resolution",
    );
  },
  *advanceHead(expectedHead, newHead, hash) {
    const changed = yield query(
      "UPDATE team_sync_links SET canonical_head=$3,canonical_hash=$4,bootstrap_bundle=NULL,generation=generation+1,last_received_at=$5,updated_at=$5 WHERE team_id=$1 AND (canonical_head=$2 OR (canonical_head IS NULL AND $2 IS NULL))",
      [this.teamId, expectedHead, newHead, hash, new Date().toISOString()],
    );
    if (changed.rowCount !== 1)
      throw new Error("Canonical head changed; recompute before retry");
  },
  *readExclusions(siteId) {
    const result = yield query(
      `SELECT * FROM site_retention WHERE team_id=$1${siteId ? " AND site_id=$2" : ""} ORDER BY site_id,kind,entity_key,generation`,
      siteId ? [this.teamId, siteId] : [this.teamId],
    );
    return result.rows.map((r) => ({ ...r, revision: integer(r.revision) }));
  },
  *putExclusion({ siteId, kind, key, generation = "", revision, createdAt }) {
    integer(revision);
    yield query(
      "INSERT INTO site_retention(team_id,site_id,kind,entity_key,generation,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(team_id,site_id,kind,entity_key,generation) DO UPDATE SET revision=excluded.revision,created_at=excluded.created_at",
      [
        this.teamId,
        siteId,
        kind,
        canonical(key),
        generation,
        revision,
        createdAt,
      ],
    );
  },
  *nextRevision(entity, key) {
    const row = (yield query(
      "INSERT INTO site_entity_revisions(team_id,entity,entity_key,revision) VALUES($1,$2,$3,1) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET revision=site_entity_revisions.revision+1 RETURNING revision",
      [this.teamId, entity, canonical(key)],
    )).rows[0];
    return integer(row.revision);
  },
  *putObject(hash, kind, bytes) {
    if (!(bytes instanceof Uint8Array) || digest(bytes) !== hash)
      throw new Error("Object content hash mismatch");
    const existing = (yield query(
      "SELECT kind,data,size FROM sync_objects WHERE team_id=$1 AND hash=$2",
      [this.teamId, hash],
    )).rows[0];
    if (existing) {
      if (existing.kind !== kind || digest(existing.data) !== hash)
        throw new Error("Stored object mismatch");
      return false;
    }
    yield query(
      "INSERT INTO sync_objects(team_id,hash,kind,data,size) VALUES($1,$2,$3,$4,$5)",
      [this.teamId, hash, kind, bytes, bytes.byteLength],
    );
    return true;
  },
  *readObject(hash) {
    const row = (yield query(
      "SELECT kind,data,size FROM sync_objects WHERE team_id=$1 AND hash=$2",
      [this.teamId, hash],
    )).rows[0];
    if (!row) return null;
    if (digest(row.data) !== hash || integer(row.size) !== row.data.byteLength)
      throw new Error("Stored object integrity failure");
    return {
      kind: row.kind,
      data: new Uint8Array(row.data),
      size: integer(row.size),
    };
  },
  *appendEvent(kind, payload) {
    const row = (yield query(
      "INSERT INTO site_events(team_id,kind,payload,created_at) VALUES($1,$2,$3,$4) RETURNING cursor",
      [this.teamId, kind, canonical(payload), new Date().toISOString()],
    )).rows[0];
    return integer(row.cursor);
  },
  *readEvents(after = 0, limit = 256) {
    integer(after);
    integer(limit);
    if (after < 0 || limit < 1 || limit > 1000)
      throw new Error("Invalid event cursor or limit");
    return (yield query(
      "SELECT * FROM site_events WHERE team_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3",
      [this.teamId, after, limit],
    )).rows.map((r) => ({
      ...r,
      cursor: integer(r.cursor),
      payload: parse(r.payload),
    }));
  },
  *readSnapshot() {
    const state = yield* methods.readState.call(this);
    return {
      ...state,
      pending: yield* methods.readPending.call(this),
      exclusions: yield* methods.readExclusions.call(this),
      connection: yield* methods.readLink.call(this),
      cursor: integer(
        (yield query(
          "SELECT COALESCE(MAX(cursor),0) AS cursor FROM site_events WHERE team_id=$1",
          [this.teamId],
        )).rows[0].cursor,
      ),
    };
  },
};

export function createTeamStore(teamId, execute, { batchSize = 1 } = {}) {
  if (typeof teamId !== "string" || !teamId)
    throw new Error("A team identity is required");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
    throw new Error("Invalid storage batch size");
  const store = { teamId, batchSize };
  for (const [name, method] of Object.entries(methods))
    store[name] = (...args) => execute(method.apply(store, args));
  return store;
}
export function executeSync(generator, run) {
  let step = generator.next();
  while (!step.done)
    step = generator.next(run(step.value.sql, step.value.values));
  return step.value;
}
export async function executeAsync(generator, run) {
  let step = generator.next();
  while (!step.done)
    step = generator.next(await run(step.value.sql, step.value.values));
  return step.value;
}
