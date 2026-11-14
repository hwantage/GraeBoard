import {
  composeSheetClone,
  isSheetCloneChild,
  isSheetCloneRowParent as isRowParent,
  sheetCloneFormattings,
  sheetCloneRowOrder,
  splitSheetCloneRecord,
  splitSheetCloneRows,
} from "../../server/sync/core/versions.mjs";
import { pack, unpack } from "../../shared/formatting/compact.js";
import {
  protocolVersion,
  PROTOCOL,
  ROW_PROTOCOL,
  SPLIT_PROTOCOL,
} from "../../server/sync/core/protocol.mjs";
import pg from "pg";
import { capacityLimits, CapacityError, capacityTotals } from "./capacity.mjs";
import {
  assertReceiptCapacity,
  recordBytes,
} from "../../shared/sync/sync-capacity.mjs";
import {
  postgresHistoryVersion,
  postgresLayout,
} from "../../shared/storage/postgres-schema-version.js";
import { siteTeamId } from "../../shared/sync/sync-profiles.js";
import { PostgresDatabase } from "./postgres.mjs";
import {
  canonical,
  canonicalWith,
  digest,
  entityId,
  emptyState,
  equal,
  ENTITIES,
} from "../../server/sync/core/protocol.mjs";
import { reduceMany, reduce } from "../../server/sync/core/reducer.mjs";
import { CanonicalSlice, reduceSlice } from "../sync/sync-partial.mjs";
import { assert } from "../control/access.mjs";
import {
  packSheetClonePayload,
  unpackSheetClonePayload,
} from "../../shared/sheet-clones/sheet-clone-sync-data.js";

function poolFor(binding, scope = "control", { site = false } = {}) {
  assert(binding?.connectionString, 503, "PostgreSQL binding을 확인하세요.");
  const { schema, migrationScope } = postgresLayout(scope, site);
  return {
    site,
    async connect() {
      const client = binding.pool
        ? await binding.pool.connect()
        : new pg.Client({
            connectionString: binding.connectionString,
            connectionTimeoutMillis: 10000,
            statement_timeout: 15000,
          });
      if (!binding.pool) await client.connect();
      const release = binding.pool
        ? client.release.bind(client)
        : () => client.end();
      try {
        // A pooled connection was checked when it was opened.
        if (client.schemaVersion === undefined) {
          const rows = (
            await client.query(
              `SELECT scope,version,checksum FROM ${schema}.schema_migrations ORDER BY version`,
            )
          ).rows;
          client.schemaVersion = postgresHistoryVersion(rows, migrationScope, {
            allowPreviousSite: true,
          });
        }
      } catch (error) {
        await release(error);
        if (error.status) throw error;
        throw Object.assign(new Error("DB 스키마 연결을 확인하세요."), {
          status: 503,
        });
      }
      client.release = release;
      return client;
    },
  };
}
// The synchronization engine runs off the request path (Cron, background
// publication) and reads or hashes the whole team's canonical text, which a
// small database cannot always do within the pool's 15-second statement limit.
export const SYNC_STATEMENT_TIMEOUT_MS = 120000;
export function databaseFor(env, profile, { statementTimeout = null } = {}) {
  const team = siteTeamId(env);
  if (team)
    assert(
      profile.teamId === team && profile.databaseBinding === "PG_SITE",
      403,
      "이 사이트의 팀만 사용할 수 있습니다.",
    );
  return new PostgresDatabase(poolFor(env[profile.databaseBinding], "team"), {
    teamId: profile.teamId,
    statementTimeout,
  });
}
export function controlPool(env) {
  return poolFor(env.PG_SITE || env.PG_CONTROL, "control", {
    site: !!siteTeamId(env),
  });
}
export async function controlTransaction(env, work, { write = false } = {}) {
  const team = siteTeamId(env);
  const client = await controlPool(env).connect();
  try {
    // One round trip opens the transaction (see PostgresDatabase.transaction).
    const opened = [].concat(
      await client.query(
        [
          "BEGIN",
          `SET LOCAL search_path TO ${team ? "graeboard_site" : "graeboard"}, pg_catalog`,
          ...(write
            ? ["SELECT revision FROM control_meta WHERE singleton=1 FOR UPDATE"]
            : []),
          ...(team ? ["SELECT team_id FROM site_meta WHERE singleton=1"] : []),
        ].join(";"),
      ),
    );
    if (team)
      assert(
        opened.at(-1).rows[0]?.team_id === team,
        503,
        "외부 사이트 DB의 팀 UUID가 일치하지 않습니다.",
      );
    const result = await work(client);
    if (write)
      await client.query(
        "UPDATE control_meta SET revision=revision+1 WHERE singleton=1",
      );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}
// site_entities는 동기화 기준본과 같은 저장 형태(사본 data의 공유 사전)를 보관한다.
// 앱 코드는 SQLite와 마찬가지로 푼 객체를 읽는다.
const storedPayload = (entity, payload) =>
  entity === "sheetClone" ? packSheetClonePayload(payload) : payload;
// The stored form a sheetClone was read or written in, and that form's text, so
// recording the same payload again (an audit's before and after) neither packs
// nor serializes it again.
const packedForms = new WeakMap(),
  storedTexts = new WeakMap();
const readPayload = (entity, text) => {
  const stored = JSON.parse(text);
  if (entity !== "sheetClone") return stored;
  const payload = unpackSheetClonePayload(stored);
  if (payload !== stored) packedForms.set(payload, stored);
  storedTexts.set(stored, text);
  return payload;
};
const rowEntity = (row) => ({
  ...row,
  key: JSON.parse(row.entity_key),
  payload: row.payload == null ? null : readPayload(row.entity, row.payload),
  revision: Number(row.revision),
  deleted: !!row.deleted,
});
// Under protocol 5 a copy's site rows are its parent, format and row records
// (see siteEntities).
const COPY_RECORDS = ["sheetCloneTask", "sheetCloneFormat", "sheetCloneRule"];
// Where a session keeps each kind of a copy's stored records.
const COPY_STORE = {
  sheetCloneTask: "rows",
  sheetCloneFormat: "formats",
  sheetCloneRule: "rules",
};
const childPrefix = (key) => JSON.stringify(key).slice(0, -1) + ",";
export class DataSession {
  constructor(tx, teamId, { limits = capacityLimits() } = {}) {
    this.limits = limits;
    this.tx = tx;
    this.teamId = teamId;
    this.cache = new Map();
    this.lists = new Map();
    // Position of each listed record, so a put does not rescan a long list.
    this.listIndex = new Map();
    this.changes = new Map();
    this.eventKinds = new Set();
    // Stored form of each payload put in this session: a sheetClone packs once,
    // not again when the capture writes the same payload into its operation.
    this.storedForms = new WeakMap();
    // The stored records of each copy read in row form, by copy ID, and the
    // records this session changed in them. `changes` keeps one entry for the
    // whole copy (audit, events); the capture sends `records`.
    this.copies = new Map();
    this.records = new Map();
  }
  // Whether this team's copies are stored as row records: C is at protocol 5.
  async rowRecords() {
    if (this.rowMode === undefined) {
      const row = (
        await this.tx.query(
          "SELECT payload FROM sync_entities WHERE team_id=$1 AND entity='protocol' AND entity_key='[]'",
          [this.teamId],
        )
      ).rows[0];
      this.rowMode =
        protocolVersion({
          entities: row?.payload
            ? {
                [entityId("protocol", [])]: {
                  payload: JSON.parse(row.payload),
                },
              }
            : {},
        }) === ROW_PROTOCOL;
    }
    return this.rowMode;
  }
  // A copy stored as row records, as the one record the application reads:
  // its live rows in sheet order (every row of a deleted copy).
  async composed(parent) {
    const known = { rows: new Map(), formats: new Map(), rules: new Map() };
    for (const row of (
      await this.tx.query(
        "SELECT entity,entity_key,payload,deleted FROM site_entities WHERE team_id=$1 AND entity=ANY($2::text[]) AND left(entity_key,length($3))=$3",
        [this.teamId, COPY_RECORDS, childPrefix(parent.key)],
      )
    ).rows)
      known[COPY_STORE[row.entity]].set(JSON.parse(row.entity_key)[1], {
        payload: JSON.parse(row.payload),
        deleted: !!row.deleted,
      });
    const view = this.copyView(parent, known);
    this.copies.set(parent.key[0], {
      parent: { payload: parent.payload, deleted: parent.deleted },
      ...known,
      view,
    });
    return view;
  }
  copyView(parent, { rows, formats, rules }) {
    return {
      ...parent,
      payload: composeSheetClone(
        parent.payload,
        sheetCloneRowOrder(
          [...rows]
            .filter(([, row]) => parent.deleted || !row.deleted)
            .map(([id, row]) => [id, row.payload]),
        ),
        sheetCloneFormattings(
          (format) => formats.get(format)?.payload,
          (rule) => rules.get(rule)?.payload,
        ),
      ),
    };
  }
  // A live copy stored as row records with only the named rows, so an edit
  // of some rows does not read the others. The result is the copy as get()
  // gives it, with those rows alone; putCopyRows() saves it. Null when the
  // copy is not stored as row records.
  async getCopyRows(key, rowIds) {
    const stored = (
      await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity='sheetClone' AND entity_key=$2",
        [this.teamId, JSON.stringify(key)],
      )
    ).rows[0];
    if (!stored) return null;
    const parent = rowEntity(stored);
    if (!isRowParent(parent.payload)) return null;
    // get() and list() must not answer the copy read before this edit.
    this.cache.delete(entityId("sheetClone", key));
    this.lists.delete("sheetClone");
    this.listIndex.delete("sheetClone");
    const ids = [...new Set(rowIds)],
      wanted = new Set(
        ids.map((id) => parent.payload.formats[id]).filter(Boolean),
      ),
      known = { rows: new Map(), formats: new Map(), rules: new Map() },
      read = (rows) => {
        for (const row of rows)
          known[COPY_STORE[row.entity]].set(JSON.parse(row.entity_key)[1], {
            payload: row.payload == null ? null : JSON.parse(row.payload),
            deleted: !!row.deleted,
          });
      };
    read(
      (
        await this.tx.query(
          // A format's payload is read only when one of these rows uses it;
          // the others are known by ID, which is their content's hash.
          "SELECT entity,entity_key,deleted,CASE WHEN entity='sheetCloneTask' OR entity_key=ANY($4::text[]) THEN payload END AS payload FROM site_entities WHERE team_id=$1 AND ((entity='sheetCloneTask' AND entity_key=ANY($2::text[])) OR (entity='sheetCloneFormat' AND left(entity_key,length($3))=$3))",
          [
            this.teamId,
            ids.map((id) => JSON.stringify([key[0], id])),
            childPrefix(key),
            [...wanted].map((id) => JSON.stringify([key[0], id])),
          ],
        )
      ).rows,
    );
    // Likewise the rules: those of the formats read, the others by ID.
    const named = new Set(
      [...wanted].flatMap((id) => known.formats.get(id)?.payload?.rules || []),
    );
    read(
      (
        await this.tx.query(
          "SELECT entity,entity_key,deleted,CASE WHEN entity_key=ANY($3::text[]) THEN payload END AS payload FROM site_entities WHERE team_id=$1 AND entity='sheetCloneRule' AND left(entity_key,length($2))=$2",
          [
            this.teamId,
            childPrefix(key),
            [...named].map((id) => JSON.stringify([key[0], id])),
          ],
        )
      ).rows,
    );
    const view = this.copyView(parent, known);
    this.copies.set(key[0], {
      parent: { payload: parent.payload, deleted: parent.deleted },
      ...known,
      view,
      partial: true,
    });
    return view;
  }
  // The live rows of a copy stored as row records without their content:
  // each row's ID and site revision, and with `positions` what orders it.
  // A payload jsonb cannot read (see sheetCloneSummaries) is parsed here.
  async copyRowIndex(key, { positions = false } = {}) {
    return (
      await this.tx.query(
        positions
          ? "SELECT entity_key,revision,CASE WHEN payload ~ $3 THEN payload END AS whole,CASE WHEN payload ~ $3 THEN NULL ELSE payload::jsonb #>> '{data,position}' END AS position,CASE WHEN payload ~ $3 THEN NULL ELSE payload::jsonb #>> '{data,createdAt}' END AS created FROM site_entities WHERE team_id=$1 AND entity='sheetCloneTask' AND deleted=0 AND left(entity_key,length($2))=$2 ORDER BY entity_key"
          : "SELECT entity_key,revision FROM site_entities WHERE team_id=$1 AND entity='sheetCloneTask' AND deleted=0 AND left(entity_key,length($2))=$2 ORDER BY entity_key",
        [
          this.teamId,
          childPrefix(key),
          ...(positions ? ["\\\\u(0000|[dD][89a-fA-F])"] : []),
        ],
      )
    ).rows.map((row) => {
      const data = row.whole ? JSON.parse(row.whole).data : null;
      return {
        id: JSON.parse(row.entity_key)[1],
        revision: String(row.revision),
        ...(positions
          ? {
              position: Number(data ? data.position : row.position),
              createdAt: data ? data.createdAt : row.created,
            }
          : {}),
      };
    });
  }
  // What an editor of a row-record copy holds to detect another change: the
  // parent's sheet settings and format assignment, and each live row's site
  // revision. The copy must have been read in this session.
  async copyRevision(key) {
    const { parent } = this.copies.get(key[0]);
    return digest([
      "sheet-clone-rows",
      parent.payload.data,
      parent.payload.formats,
      (await this.copyRowIndex(key)).map((row) => [row.id, row.revision]),
    ]);
  }
  async read(row) {
    const record = rowEntity(row);
    return record.entity === "sheetClone" && isRowParent(record.payload)
      ? this.composed(record)
      : record;
  }
  storedText(entity, payload) {
    const stored = this.stored(entity, payload);
    if (entity !== "sheetClone" || !stored || typeof stored !== "object")
      return canonical(stored);
    if (!storedTexts.has(stored)) storedTexts.set(stored, canonical(stored));
    return storedTexts.get(stored);
  }
  stored(entity, payload) {
    if (entity !== "sheetClone" || !payload || typeof payload !== "object")
      return storedPayload(entity, payload);
    if (packedForms.has(payload)) return packedForms.get(payload);
    if (!this.storedForms.has(payload))
      this.storedForms.set(payload, storedPayload(entity, payload));
    return this.storedForms.get(payload);
  }
  async get(entity, key) {
    const id = entityId(entity, key);
    if (!this.cache.has(id)) {
      const q = await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
        [this.teamId, entity, JSON.stringify(key)],
      );
      this.cache.set(id, q.rows[0] ? await this.read(q.rows[0]) : null);
    }
    return this.cache.get(id);
  }
  // Whether a live record exists, without reading its payload. A copy's row is
  // megabytes of JSON that a parent or team lookup never looks at.
  async alive(entity, key) {
    const id = entityId(entity, key);
    if (this.cache.has(id)) {
      const row = this.cache.get(id);
      return !!row && !row.deleted;
    }
    const q = await this.tx.query(
      "SELECT deleted FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [this.teamId, entity, JSON.stringify(key)],
    );
    return !!q.rows[0] && !Number(q.rows[0].deleted);
  }
  // A live record's site revision, without reading its payload; null when
  // there is no live record.
  async revisionOf(entity, key) {
    const row = (
      await this.tx.query(
        "SELECT revision FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3 AND deleted=0",
        [this.teamId, entity, JSON.stringify(key)],
      )
    ).rows[0];
    return row ? Number(row.revision) : null;
  }
  // Which of the given rows a live copy has. A copy stored as row records
  // answers from the rows' keys, without reading the copy.
  async copyRowsAmong(copyId, rowIds) {
    if (!(await this.rowRecords())) {
      const copy = await this.get("sheetClone", [copyId]),
        wanted = new Set(rowIds);
      return new Set(
        copy && !copy.deleted
          ? copy.payload.data.tasks
              .map((task) => task.id)
              .filter((id) => wanted.has(id))
          : [],
      );
    }
    return new Set(
      (
        await this.tx.query(
          "SELECT entity_key FROM site_entities WHERE team_id=$1 AND entity='sheetCloneTask' AND deleted=0 AND entity_key=ANY($2::text[]) AND EXISTS(SELECT 1 FROM site_entities parent WHERE parent.team_id=$1 AND parent.entity='sheetClone' AND parent.entity_key=$3 AND parent.deleted=0)",
          [
            this.teamId,
            [...rowIds].map((id) => JSON.stringify([copyId, id])),
            JSON.stringify([copyId]),
          ],
        )
      ).rows.map((row) => JSON.parse(row.entity_key)[1]),
    );
  }
  // Several records of one entity in one query. They land in the cache get()
  // reads, so a per-item get() afterwards costs no round trip.
  async getMany(entity, keys) {
    if (entity === "sheetClone") {
      const found = [];
      for (const key of keys) found.push(await this.get(entity, key));
      return found;
    }
    const missing = new Map();
    for (const key of keys) {
      const id = entityId(entity, key);
      if (!this.cache.has(id)) missing.set(id, JSON.stringify(key));
    }
    if (missing.size) {
      const found = new Map(
        (
          await this.tx.query(
            "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=ANY($3::text[])",
            [this.teamId, entity, [...missing.values()]],
          )
        ).rows.map((row) => {
          const record = rowEntity(row);
          return [entityId(entity, record.key), record];
        }),
      );
      for (const id of missing.keys())
        this.cache.set(id, found.get(id) || null);
    }
    return keys.map((key) => this.cache.get(entityId(entity, key)));
  }
  async list(entity, { deleted = false } = {}) {
    if (this.lists.has(entity))
      return this.lists.get(entity).filter((row) => deleted || !row.deleted);
    const q = await this.tx.query(
      "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2" +
        " ORDER BY entity_key",
      [this.teamId, entity],
    );
    const rows = [];
    for (const row of q.rows) rows.push(await this.read(row));
    this.lists.set(entity, rows);
    this.listIndex.set(
      entity,
      new Map(rows.map((row, index) => [entityId(entity, row.key), index])),
    );
    for (const row of rows) this.cache.set(entityId(entity, row.key), row);
    return rows.filter((row) => deleted || !row.deleted);
  }
  // Live rows under one parent key (a task's cells or documents), in list order,
  // without reading the whole entity for the team.
  async listChildren(entity, parent) {
    if (this.lists.has(entity)) {
      const prefix = JSON.stringify(parent).slice(0, -1) + ",";
      return this.lists
        .get(entity)
        .filter(
          (row) => !row.deleted && JSON.stringify(row.key).startsWith(prefix),
        );
    }
    const found = (
      await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2 AND deleted=0 AND left(entity_key,length($3))=$3 ORDER BY entity_key",
        [this.teamId, entity, JSON.stringify(parent).slice(0, -1) + ","],
      )
    ).rows.map(rowEntity);
    for (const row of found) {
      const id = entityId(entity, row.key);
      if (!this.cache.has(id)) this.cache.set(id, row);
    }
    return found.map((row) => this.cache.get(entityId(entity, row.key)));
  }
  // listChildren() for several parents in one query.
  async listChildrenOf(entity, parents) {
    if (!parents.length) return [];
    const prefixes = parents.map(childPrefix);
    if (this.lists.has(entity))
      return this.lists.get(entity).filter((row) => {
        const key = JSON.stringify(row.key);
        return (
          !row.deleted && prefixes.some((prefix) => key.startsWith(prefix))
        );
      });
    const found = (
      await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2 AND deleted=0 AND EXISTS(SELECT 1 FROM unnest($3::text[]) AS parent(prefix) WHERE left(entity_key,length(parent.prefix))=parent.prefix) ORDER BY entity_key",
        [this.teamId, entity, prefixes],
      )
    ).rows.map(rowEntity);
    for (const row of found) {
      const id = entityId(entity, row.key);
      if (!this.cache.has(id)) this.cache.set(id, row);
    }
    return found.map((row) => this.cache.get(entityId(entity, row.key)));
  }
  // Live cells whose own style sets any of the given properties, in list order.
  // Null columns or rows mean every column or row of the team.
  async cellsStyling(properties, { columns = null, rows = null } = {}) {
    if (!properties.length) return [];
    const found = (
      await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity='cell' AND deleted=0 AND (payload::jsonb->'style') ?| $2::text[] AND ($3::text[] IS NULL OR entity_key::jsonb->>1=ANY($3)) AND ($4::text[] IS NULL OR entity_key::jsonb->>0=ANY($4)) ORDER BY entity_key",
        [this.teamId, properties, columns, rows],
      )
    ).rows.map(rowEntity);
    for (const row of found) {
      const id = entityId("cell", row.key);
      if (!this.cache.has(id)) this.cache.set(id, row);
    }
    return found.map((row) => this.cache.get(entityId("cell", row.key)));
  }
  async put(
    entity,
    key,
    payload,
    {
      deleted = false,
      shared = ENTITIES.has(entity),
      locallyHidden = false,
    } = {},
  ) {
    if (entity === "sheetClone" && (await this.rowRecords()))
      return this.putCopy(key, payload, { deleted, locallyHidden });
    const id = entityId(entity, key),
      before = await this.get(entity, key);
    const storedDeleted = deleted || locallyHidden;
    if (
      before &&
      equal(before.payload, payload) &&
      before.deleted === storedDeleted
    )
      return before;
    if (shared && !this.changes.has(id))
      this.changes.set(id, { entity, key, before });
    const result = await this.tx.query(
      `INSERT INTO site_entity_revisions(team_id,entity,entity_key,revision) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET revision=GREATEST(site_entity_revisions.revision+1,EXCLUDED.revision) RETURNING revision`,
      [this.teamId, entity, JSON.stringify(key), Date.now()],
    );
    const revision = Number(result.rows[0].revision);
    await this.tx.query(
      `INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision,deleted=EXCLUDED.deleted`,
      [
        this.teamId,
        entity,
        JSON.stringify(key),
        this.storedText(entity, payload),
        revision,
        storedDeleted ? 1 : 0,
      ],
    );
    const after = { entity, key, payload, revision, deleted: storedDeleted };
    if (this.lists.has(entity)) {
      const rows = this.lists.get(entity),
        positions = this.listIndex.get(entity),
        index = positions.get(id);
      if (index === undefined) positions.set(id, rows.push(after) - 1);
      else rows[index] = after;
    }
    this.cache.set(id, after);
    // Settings conversion edits the canonical value without removing its local
    // retention overlay. Reads/cache keep hidden rows hidden; capture sees C/P.
    if (shared)
      this.changes.get(id).after = locallyHidden
        ? { ...after, deleted }
        : after;
    return after;
  }
  // put("sheetClone") for a team whose copies are row records: the copy is
  // split as C splits it and only the records that differ from the stored
  // ones are written, so an edit to one row writes that row. A row the copy
  // no longer has becomes a deleted row; deleting the copy deletes every
  // record. Format records are never removed while the copy lives.
  async putCopy(key, payload, { deleted, locallyHidden, part = false }) {
    const id = entityId("sheetClone", key),
      before = part
        ? this.copies.get(key[0]).view
        : await this.get("sheetClone", key),
      known = this.copies.get(key[0]) || {
        parent: null,
        rows: new Map(),
        formats: new Map(),
        rules: new Map(),
      },
      storedDeleted = deleted || locallyHidden;
    assert(Array.isArray(payload?.data?.tasks), 400, "사본 내용을 확인하세요.");
    // A copy read whole since getCopyRows() would lose the rows left out here.
    if (part && !known.partial)
      throw new Error("A copy read whole cannot be saved by its rows");
    const [parent, ...children] = splitSheetCloneRows({
        entity: "sheetClone",
        key,
        payload,
      }),
      writes = [],
      consider = (entity, recordKey, value, previous) => {
        if (
          !previous ||
          previous.deleted !== storedDeleted ||
          // A format's or rule's ID is its content's hash: a stored one is
          // the same.
          (!["sheetCloneFormat", "sheetCloneRule"].includes(entity) &&
            !equal(previous.payload, value))
        )
          writes.push({ entity, key: recordKey, payload: value, previous });
      },
      kept = new Set();
    // Only some rows were read: the rows not read keep their assignment.
    if (part) {
      const formats = { ...known.parent.payload.formats };
      for (const rowId of known.rows.keys()) delete formats[rowId];
      parent.payload = {
        ...parent.payload,
        formats: { ...formats, ...parent.payload.formats },
      };
    }
    consider("sheetClone", key, parent.payload, known.parent);
    for (const child of children) {
      kept.add(child.entity + child.key[1]);
      consider(
        child.entity,
        child.key,
        child.payload,
        known[COPY_STORE[child.entity]].get(child.key[1]),
      );
    }
    const removed = [];
    for (const [entity, stored] of [
      ["sheetCloneTask", known.rows],
      ["sheetCloneFormat", known.formats],
      ["sheetCloneRule", known.rules],
    ])
      for (const [childId, previous] of stored)
        if (
          !kept.has(entity + childId) &&
          !previous.deleted &&
          (storedDeleted || entity === "sheetCloneTask")
        )
          removed.push({
            entity,
            key: [key[0], childId],
            payload: previous.payload,
            previous,
          });
    if (!writes.length && !removed.length) return before;
    // The copy's revision moves with any of its records: viewers watch it.
    const batch = [
        ...writes.map((write) => ({ ...write, deleted: storedDeleted })),
        ...removed.map((write) => ({ ...write, deleted: true })),
      ],
      revised = [
        ...batch,
        ...(writes[0]?.entity === "sheetClone"
          ? []
          : [{ entity: "sheetClone", key }]),
      ].map((row) => ({
        entity: row.entity,
        entity_key: JSON.stringify(row.key),
      })),
      revisions = new Map(
        (
          await this.tx.query(
            `INSERT INTO site_entity_revisions(team_id,entity,entity_key,revision) SELECT $1,r.entity,r.entity_key,$3 FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET revision=GREATEST(site_entity_revisions.revision+1,EXCLUDED.revision) RETURNING entity,entity_key,revision`,
            [this.teamId, JSON.stringify(revised), Date.now()],
          )
        ).rows.map((row) => [
          row.entity + ":" + row.entity_key,
          Number(row.revision),
        ]),
      ),
      revision = revisions.get("sheetClone:" + JSON.stringify(key));
    await this.tx.query(
      `INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) SELECT $1,r.entity,r.entity_key,r.payload,r.revision,r.deleted FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text,payload text,revision bigint,deleted integer) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision,deleted=EXCLUDED.deleted`,
      [
        this.teamId,
        JSON.stringify(
          batch.map((row) => ({
            entity: row.entity,
            entity_key: JSON.stringify(row.key),
            payload: canonical(row.payload),
            revision: revisions.get(row.entity + ":" + JSON.stringify(row.key)),
            deleted: row.deleted ? 1 : 0,
          })),
        ),
      ],
    );
    if (writes[0]?.entity !== "sheetClone")
      await this.tx.query(
        "UPDATE site_entities SET revision=$3 WHERE team_id=$1 AND entity='sheetClone' AND entity_key=$2",
        [this.teamId, JSON.stringify(key), revision],
      );
    if (!this.changes.has(id))
      this.changes.set(id, {
        entity: "sheetClone",
        key,
        before,
        rowIds: new Set(),
      });
    const change = this.changes.get(id),
      formatsBefore = known.parent?.payload.formats || {};
    for (const rowId of new Set([
      ...Object.keys(formatsBefore),
      ...Object.keys(parent.payload.formats),
    ]))
      if (formatsBefore[rowId] !== parent.payload.formats[rowId])
        change.rowIds.add(rowId);
    for (const row of batch) {
      const recordId = entityId(row.entity, row.key),
        stored = { payload: row.payload, deleted: row.deleted };
      if (row.entity === "sheetCloneTask") change.rowIds.add(row.key[1]);
      if (!this.records.has(recordId))
        this.records.set(recordId, {
          entity: row.entity,
          key: row.key,
          before: row.previous || null,
        });
      // A locally hidden record stays live in C (see put).
      this.records.get(recordId).after = {
        payload: row.payload,
        deleted: row.deleted && !(locallyHidden && !deleted),
      };
      if (row.entity === "sheetClone") known.parent = stored;
      else known[COPY_STORE[row.entity]].set(row.key[1], stored);
    }
    const after = {
      entity: "sheetClone",
      key,
      payload,
      revision,
      deleted: storedDeleted,
    };
    known.view = after;
    this.copies.set(key[0], known);
    change.after = locallyHidden ? { ...after, deleted } : after;
    // A copy held with some of its rows is not what get() and list() answer.
    if (part) return after;
    if (this.lists.has("sheetClone")) {
      const rows = this.lists.get("sheetClone"),
        positions = this.listIndex.get("sheetClone"),
        index = positions.get(id);
      if (index === undefined) positions.set(id, rows.push(after) - 1);
      else rows[index] = after;
    }
    this.cache.set(id, after);
    return after;
  }
  // Saves a copy read with getCopyRows(): `payload` holds the rows that were
  // read and stay, changed or not, and the rows the edit adds. A row that was
  // read and is absent is removed; the rows not read are untouched.
  putCopyRows(key, payload) {
    return this.putCopy(key, payload, {
      deleted: false,
      locallyHidden: false,
      part: true,
    });
  }
  // What the capture sends: each changed record, a copy as its row records.
  captured() {
    if (!this.records.size) return new Map(this.changes);
    const captured = new Map();
    for (const [id, change] of this.changes)
      if (change.entity !== "sheetClone" || !change.rowIds)
        captured.set(id, change);
    for (const [id, record] of this.records) captured.set(id, record);
    return captured;
  }
  async touch(entity, key) {
    const old = await this.get(entity, key);
    if (!old) return;
    const q = await this.tx.query(
      "UPDATE site_entity_revisions SET revision=GREATEST(revision+1,$4) WHERE team_id=$1 AND entity=$2 AND entity_key=$3 RETURNING revision",
      [this.teamId, entity, JSON.stringify(key), Date.now()],
    );
    const revision = Number(q.rows[0]?.revision || Date.now());
    await this.tx.query(
      "UPDATE site_entities SET revision=$4 WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
      [this.teamId, entity, JSON.stringify(key), revision],
    );
    old.revision = revision;
  }
  async projected() {
    const state = emptyState();
    for (const row of (
      await this.tx.query("SELECT * FROM sync_entities WHERE team_id=$1", [
        this.teamId,
      ])
    ).rows) {
      const e = {
        entity: row.entity,
        key: JSON.parse(row.entity_key),
        generation: row.generation,
        version: row.version,
        payload: row.payload == null ? null : JSON.parse(row.payload),
        deleted: !!row.deleted,
      };
      state.entities[entityId(e.entity, e.key)] = e;
    }
    for (const row of (
      await this.tx.query("SELECT * FROM sync_receipts WHERE team_id=$1", [
        this.teamId,
      ])
    ).rows)
      state.receipts[row.op_id] = JSON.parse(row.receipt);
    for (const row of (
      await this.tx.query("SELECT * FROM sync_conflicts WHERE team_id=$1", [
        this.teamId,
      ])
    ).rows)
      state.conflicts[row.conflict_id] = JSON.parse(row.payload);
    const pending = (
      await this.tx.query(
        "SELECT payload FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged' ORDER BY local_seq",
        [this.teamId],
      )
    ).rows.map((row) => JSON.parse(row.payload));
    const projectedState = reduceMany(state, pending);
    return {
      state,
      projectedState,
      pending,
      entities: projectedState.entities,
    };
  }
  // The records a capture can consult (see CanonicalSlice): the changed keys
  // and those of pending operations, so the cost follows the change instead
  // of the team's whole state.
  //
  // replaceable(link) names the last pending operation this capture replaces
  // (see replaceableOperation); the projection then leaves it out, so the new
  // operation runs from that operation's base to this capture's result.
  async projectedFor(replaceable = () => null, changes = this.changes) {
    let rows = (
        await this.tx.query(
          "SELECT op_id,status,payload,payload_hash FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged' ORDER BY local_seq",
          [this.teamId],
        )
      ).rows,
      pending = rows.map((row) => JSON.parse(row.payload));
    const replaced = rows.length
      ? replaceable(rows.at(-1), pending.at(-1))
      : null;
    if (replaced) {
      rows = rows.slice(0, -1);
      pending = pending.slice(0, -1);
    }
    const slice = new CanonicalSlice(this.tx, this.teamId);
    // A copy's row records name every row they change; the copy's other rows
    // are not read (see CanonicalSlice.touch).
    for (const change of changes.values())
      slice.touch(
        change.entity,
        change.key,
        this.records.size && change.entity === "sheetClone"
          ? "edit"
          : undefined,
      );
    const state = await slice.include(pending).load();
    const { state: projectedState, context } = reduceSlice(
      state,
      pending,
      null,
      await slice.context(state),
      // Each row's text and hash as stored, instead of serializing it again.
      rows.map((row) => ({
        serialized: row.payload,
        hash: row.payload_hash ?? undefined,
      })),
    );
    // This capture restores what the projection still holds deleted.
    for (const change of changes.values())
      if (projectedState.entities[entityId(change.entity, change.key)]?.deleted)
        slice.restored(change.entity, change.key);
    for (const [id, record] of await slice.readChildren(state))
      projectedState.entities[id] ??= record;
    return {
      state,
      projectedState,
      pending,
      entities: projectedState.entities,
      context,
      replaced,
    };
  }
  // A copy edit carries the whole copy, and a document autosave its whole body,
  // and edits arrive a second apart while someone types. When the last unsent
  // operation only edits the same copy or document, this capture replaces it
  // with one operation from that operation's base to the new result, so
  // replaying and publishing cost one body, not one per save. Only while no
  // sync run holds the lease: taking the lease and this capture share the team
  // lock, so a publish never reads a row replaced here. An expired lease left
  // by a stopped run keeps rows too: that run may have published the last row
  // before it stopped, and the next run receives it before releasing.
  replaceableOperation(link) {
    const [change, ...others] = this.changes.values();
    if (
      link.lease_owner ||
      others.length ||
      !["sheetClone", "document"].includes(change.entity) ||
      // Row records already send only the rows an edit changed.
      change.rowIds ||
      !change.before ||
      change.before.deleted ||
      change.after.deleted
    )
      return () => null;
    return (row, operation) => {
      const [previous, ...rest] = operation.changes;
      return row.status === "pending" &&
        [PROTOCOL, ROW_PROTOCOL].includes(operation.protocol) &&
        operation.writerEpoch === link.writer_epoch &&
        !operation.objects.length &&
        !rest.length &&
        previous.entity === change.entity &&
        previous.action === "edit" &&
        equal(previous.key, change.key)
        ? row.op_id
        : null;
    };
  }
  // C's size in SQL plus what this capture changes, matching the whole-state
  // measurement it replaces without loading C. Only receipts have a budget
  // unless the operator caps the state, so sizing the changed records (a copy
  // is megabytes) is skipped otherwise.
  async assertCaptureCapacity(state, result, pending, operationBytes) {
    const limited =
        Number.isFinite(this.limits.maxEntities) ||
        Number.isFinite(this.limits.maxBytes),
      totals = await capacityTotals(this.tx, this.teamId),
      delta = (before, after) => {
        let bytes = 0,
          count = 0;
        for (const id of new Set([
          ...Object.keys(before),
          ...Object.keys(after),
        ]))
          if (before[id] !== after[id]) {
            if (after[id]) bytes += recordBytes(id, after[id]);
            if (before[id]) bytes -= recordBytes(id, before[id]);
            count += !!after[id] - !!before[id];
          }
        return { bytes, count };
      };
    const none = { bytes: 0, count: 0 },
      entities = limited ? delta(state.entities, result.entities) : none,
      conflicts = limited ? delta(state.conflicts, result.conflicts) : none,
      receipts = delta(state.receipts, result.receipts);
    if (totals.entities + entities.count > this.limits.maxEntities)
      throw new CapacityError(
        "External synchronization entity capacity exceeded; canonical cursor is unchanged",
        400,
      );
    const bytes =
      totals.entityBytes +
      totals.conflictBytes +
      entities.bytes +
      conflicts.bytes;
    if (bytes > this.limits.maxBytes)
      throw new CapacityError(
        "External synchronization state byte capacity exceeded; canonical cursor is unchanged",
        400,
      );
    assertReceiptCapacity(totals.receiptBytes + receipts.bytes, 400);
    if (
      Number.isFinite(this.limits.maxBytes) &&
      bytes +
        pending.reduce((n, op) => n + Buffer.byteLength(canonical(op)), 0) +
        operationBytes >
        this.limits.maxBytes
    )
      throw new CapacityError(
        "External state and pending capacity exceeded; previous data is unchanged",
      );
  }
  async capture(actorId) {
    if (!this.changes.size) return;
    const link = (
      await this.tx.query("SELECT * FROM team_sync_links WHERE team_id=$1", [
        this.teamId,
      ])
    ).rows[0];
    if (!link || link.mode === "disconnected") return;
    assert(
      !["initializing", "importing"].includes(link.mode),
      409,
      "팀 데이터를 준비하고 있습니다. 잠시 후 다시 저장하세요.",
    );
    const captured = this.captured(),
      { state, projectedState, pending, entities, context, replaced } =
        await this.projectedFor(this.replaceableOperation(link), captured);
    const opId = crypto.randomUUID(),
      dependsOn = new Set(),
      pendingIds = new Set(pending.map((op) => op.opId));
    const changes = [],
      version = protocolVersion(projectedState);
    // Protocol 4 splits the copy here; under protocol 5 the changes already
    // are its row records.
    const split = version === SPLIT_PROTOCOL ? splitSheetCloneRecord : null,
      records = split || version === ROW_PROTOCOL;
    if (split)
      for (const [id, change] of this.changes) {
        if (change.entity !== "sheetClone") continue;
        captured.delete(id);
        const after = new Map(
          split(change.after).map((record) => [
            entityId(record.entity, record.key),
            record,
          ]),
        );
        for (const record of Object.values(entities))
          if (
            isSheetCloneChild(record.entity) &&
            record.key[0] === change.key[0] &&
            !after.has(entityId(record.entity, record.key))
          )
            after.set(entityId(record.entity, record.key), {
              ...record,
              deleted: true,
            });
        for (const [key, record] of after)
          captured.set(key, {
            entity: record.entity,
            key: record.key,
            after: record,
          });
      }
    for (const change of captured.values()) {
      const { entity, key, after } = change,
        current = entities[entityId(entity, key)];
      // A record made and removed before it ever reached C leaves nothing.
      if (records && !current && after.deleted) continue;
      // 동기화 명령은 저장 형태(사본 data의 공유 사전)를 그대로 싣는다.
      const desired = this.stored(entity, after.payload);
      if (
        records &&
        current &&
        equal(current.payload, desired) &&
        !!current.deleted === !!after.deleted
      )
        continue;
      if (records && isSheetCloneChild(entity)) {
        for (const parent of [
          ["sheetClone", [key[0]]],
          ...(entity === "sheetCloneCell"
            ? [["sheetCloneTask", key.slice(0, 2)]]
            : []),
        ]) {
          const token = entities[entityId(...parent)]?.version?.split(":")[0];
          if (pendingIds.has(token)) dependsOn.add(token);
        }
      }
      if (current?.version) {
        const predecessor = current.version.split(":")[0];
        if (pendingIds.has(predecessor)) dependsOn.add(predecessor);
      }
      if (entity === "cell" || entity === "document") {
        const parent =
          entity === "cell"
            ? "task"
            : key[0] === "task"
              ? "task"
              : key[0] === "calendar"
                ? "calendar"
                : key[0].startsWith("sheetClone")
                  ? "sheetClone"
                  : null;
        const target =
          parent &&
          entities[entityId(parent, [entity === "cell" ? key[0] : key[1]])];
        const predecessor = target?.version?.split(":")[0];
        if (pendingIds.has(predecessor)) dependsOn.add(predecessor);
      }
      const action =
        after.deleted ||
        (["task", "calendar"].includes(entity) && after.payload.deletedAt)
          ? "delete"
          : !current
            ? "create"
            : current.deleted
              ? "restore"
              : "edit";
      const base = current?.payload ?? null,
        fields = [
          ...new Set([
            ...Object.keys(base || {}),
            ...Object.keys(desired || {}),
          ]),
        ].filter((k) => !equal(base?.[k], desired?.[k]));
      // Edits that end where the replaced operation began leave nothing.
      if (replaced && action === "edit" && !fields.length) continue;
      changes.push({
        entity,
        key,
        generation:
          !current || action === "restore"
            ? crypto.randomUUID()
            : current.generation,
        baseVersion: current?.version ?? null,
        action,
        base,
        desired,
        fields,
      });
    }
    // The replaced operation goes even when the copy is back to its base.
    if (replaced)
      assert(
        (
          await this.tx.query(
            "DELETE FROM sync_outbox WHERE team_id=$1 AND op_id=$2 AND status='pending'",
            [this.teamId, replaced],
          )
        ).rowCount === 1,
        409,
        "동기화 기준이 변경되었습니다. 최신 내용을 확인하세요.",
      );
    if (!changes.length) return;
    const operation = {
      protocol: version,
      reducer: version,
      repoId: link.repo_id,
      teamId: this.teamId,
      opId,
      writerEpoch: link.writer_epoch,
      actorRef: actorId,
      createdAt: new Date().toISOString(),
      dependsOn: [...dependsOn],
      changes,
      objects: [],
    };
    // One serialization of the operation serves its receipt hash, the size
    // check and the outbox row.
    const serialized = canonical(operation),
      hash = digest(serialized);
    const result = reduce(
      projectedState,
      operation,
      { teamId: operation.teamId, repoId: operation.repoId },
      context,
      { serialized, hash },
    );
    await this.assertCaptureCapacity(
      state,
      result.state,
      pending,
      Buffer.byteLength(serialized),
    );
    assert(
      ["applied", "noop"].includes(result.receipt.result),
      409,
      "동기화 기준이 변경되었습니다. 최신 내용을 확인하세요.",
      { conflict: result.state.conflicts[opId] },
    );
    await this.tx.query(
      "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,created_at) VALUES($1,$2,$3,$4,$5)",
      [opId, this.teamId, serialized, hash, operation.createdAt],
    );
  }
  async event(kind, payload) {
    this.eventKinds.add(kind);
    await this.tx.query(
      "INSERT INTO site_events(team_id,kind,payload,created_at) VALUES($1,$2,$3,$4)",
      [this.teamId, kind, canonical(payload), new Date().toISOString()],
    );
  }
}
// A new copy is recorded by its name and task count, as the internal site
// does. Its sheet and copied documents are the copy itself, not edits to
// restore, and writing them out again would cost as much as the copy. Other
// sheetClone changes keep their stored (packed) form: unpacked, each task repeats
// the team's formatting rules and the text runs to tens of megabytes. History
// unpacks them when it reads them.
const auditChanges = (action, changes, stored) =>
  action === "sheet-clone"
    ? changes
        .filter((c) => c.entity === "sheetClone")
        .map((c) => ({
          entity: c.entity,
          key: c.key,
          before: null,
          after: {
            name: c.after.payload.name,
            count: c.after.payload.data?.tasks?.length ?? 0,
          },
        }))
    : changes.map((c) => ({
        entity: c.entity,
        key: c.key,
        before: stored(c.entity, changedRows(c, c.before)),
        after: stored(c.entity, changedRows(c, c.after)),
      }));
// A copy stored as row records is recorded with only the rows the change
// touched: the rows it removed or changed before, and changed or added after.
const changedRows = (change, side) =>
  !side?.payload || !change.rowIds
    ? (side?.payload ?? null)
    : {
        ...side.payload,
        data: {
          ...side.payload.data,
          tasks: side.payload.data.tasks.filter((task) =>
            change.rowIds.has(task.id),
          ),
        },
      };
export async function withData(
  database,
  teamId,
  work,
  {
    actorId,
    body,
    action = "edit",
    write = false,
    validateImages,
    limits = capacityLimits(),
  } = {},
) {
  return database.withTeamTransaction(
    teamId,
    async (tx) => {
      // Every guard of this transaction in one round trip; each is asserted
      // in the same order as before.
      const operationId = write ? body?.operationId || null : null,
        year =
          write && body?.year !== undefined
            ? canonical([String(body.year)])
            : null,
        guards = (
          await tx.query(
            `SELECT
              EXISTS(SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND kind<>'backup' AND phase NOT IN ('complete','cancelled')) AS maintenance,
              $2::boolean AND EXISTS(SELECT 1 FROM team_sync_links WHERE team_id=$1 AND lease_owner LIKE 'upgrade:%' AND lease_until>$3) AS upgrading,
              $4::text IS NOT NULL AND EXISTS(SELECT 1 FROM site_retention r JOIN team_sync_links l ON l.team_id=r.team_id AND l.installation_id=r.site_id WHERE r.team_id=$1 AND r.kind='year' AND r.entity_key=$4) AS retained,
              (SELECT row_to_json(o) FROM site_operations o WHERE o.team_id=$1 AND o.op_id=$5) AS previous`,
            [teamId, write, Date.now(), year, operationId],
          )
        ).rows[0];
      assert(
        !guards.maintenance,
        409,
        "팀 자료 정리 중입니다. 입력을 보존한 뒤 다시 저장하세요.",
      );
      assert(
        !guards.upgrading,
        409,
        "동기화 형식 전환 중입니다. 입력을 보존하고 잠시 후 저장하세요.",
      );
      assert(
        !guards.retained,
        409,
        "이 사이트에서 제외된 연도입니다. 먼저 복원하세요.",
      );
      if (guards.previous) {
        const previous = guards.previous;
        assert(
          previous.actor_id === actorId &&
            previous.request_hash === digest(body),
          409,
          "같은 요청 ID에 다른 내용을 저장할 수 없습니다.",
        );
        return unpack(JSON.parse(previous.response));
      }
      const session = new DataSession(tx, teamId, { limits }),
        result = await work(session);
      if (write) {
        if (validateImages)
          await validateImages(
            [...session.changes.values()]
              .filter((c) => !c.after.deleted)
              .map((c) => c.after.payload),
          );
        await session.capture(actorId);
        if (session.changes.size) {
          await tx.query(
            "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              crypto.randomUUID(),
              teamId,
              actorId,
              action,
              action === "format"
                ? body.operationId
                : [...session.changes.keys()][0],
              canonicalWith(
                auditChanges(action, [...session.changes.values()], (e, p) =>
                  session.stored(e, p),
                ),
                (value) => storedTexts.get(value),
              ),
              new Date().toISOString(),
            ],
          );
          // A complete cell delta already carries revisions and task timestamps.
          // Adding a structural event here would reset every cell subscriber.
          if (!(
            session.eventKinds.has("cells") &&
            [...session.changes.values()].every((c) => c.entity === "cell")
          ))
            await session.event("changed", {
              teamId,
              entities: [...session.changes.values()].map((c) => ({
                entity: c.entity,
                key: c.key,
              })),
              actorId,
            });
        }
        if (operationId)
          await tx.query(
            "INSERT INTO site_operations(team_id,op_id,actor_id,request_hash,response,created_at) VALUES($1,$2,$3,$4,$5,$6)",
            [
              teamId,
              operationId,
              actorId,
              digest(body),
              // A copy's edit answers with the whole copy: packed, it is the
              // size of the stored copy instead of tens of megabytes with
              // the formatting rules repeated on every task.
              JSON.stringify(pack(result)),
              new Date().toISOString(),
            ],
          );
      }
      return result;
    },
    { readOnly: !write },
  );
}
