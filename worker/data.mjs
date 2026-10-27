import pg from "pg";
import {
  assertStateCapacity,
  capacityLimits,
  CapacityError,
} from "./capacity.mjs";
import {
  POSTGRES_CHECKSUMS,
  postgresLayout,
} from "../server/storage/schema-version.mjs";
import { siteTeamId } from "./config.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import {
  canonical,
  digest,
  entityId,
  emptyState,
  equal,
  ENTITIES,
} from "../server/sync/protocol.mjs";
import { reduceMany, reduce } from "../server/sync/reducer.mjs";
import { assert } from "./access.mjs";

export function poolFor(binding, scope = "control", { site = false } = {}) {
  assert(binding?.connectionString, 503, "PostgreSQL binding을 확인하세요.");
  const { schema, migrationScope } = postgresLayout(scope, site);
  return {
    site,
    async connect() {
      const client = new pg.Client({
        connectionString: binding.connectionString,
        connectionTimeoutMillis: 10000,
        statement_timeout: 15000,
      });
      await client.connect();
      try {
        const rows = (
          await client.query(
            `SELECT scope,version,checksum FROM ${schema}.schema_migrations ORDER BY version`,
          )
        ).rows;
        assert(
          rows.length === 1 &&
            rows[0].scope === migrationScope &&
            Number(rows[0].version) === 1 &&
            rows[0].checksum === POSTGRES_CHECKSUMS[migrationScope],
          503,
          "DB 마이그레이션 버전 또는 무결성을 확인하세요.",
        );
      } catch (error) {
        await client.end();
        if (error.status) throw error;
        throw Object.assign(new Error("DB 스키마 연결을 확인하세요."), {
          status: 503,
        });
      }
      client.release = () => client.end();
      return client;
    },
  };
}
export function databaseFor(env, profile) {
  const team = siteTeamId(env);
  if (team)
    assert(
      profile.teamId === team && profile.databaseBinding === "PG_SITE",
      403,
      "이 사이트의 팀만 사용할 수 있습니다.",
    );
  return new PostgresDatabase(poolFor(env[profile.databaseBinding], "team"), {
    teamId: profile.teamId,
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
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL search_path TO ${team ? "graeboard_site" : "graeboard"}, pg_catalog`,
    );
    if (team) {
      const row = (
        await client.query("SELECT team_id FROM site_meta WHERE singleton=1")
      ).rows[0];
      assert(
        row?.team_id === team,
        503,
        "외부 사이트 DB의 팀 UUID가 일치하지 않습니다.",
      );
    }
    if (write)
      await client.query(
        "SELECT revision FROM control_meta WHERE singleton=1 FOR UPDATE",
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
const rowEntity = (row) => ({
  ...row,
  key: JSON.parse(row.entity_key),
  payload: row.payload == null ? null : JSON.parse(row.payload),
  revision: Number(row.revision),
  deleted: !!row.deleted,
});
export class DataSession {
  constructor(tx, teamId, { limits = capacityLimits() } = {}) {
    this.limits = limits;
    this.tx = tx;
    this.teamId = teamId;
    this.cache = new Map();
    this.lists = new Map();
    this.changes = new Map();
    this.eventKinds = new Set();
  }
  async get(entity, key) {
    const id = entityId(entity, key);
    if (!this.cache.has(id)) {
      const q = await this.tx.query(
        "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2 AND entity_key=$3",
        [this.teamId, entity, JSON.stringify(key)],
      );
      this.cache.set(id, q.rows[0] ? rowEntity(q.rows[0]) : null);
    }
    return this.cache.get(id);
  }
  async list(entity, { deleted = false } = {}) {
    if (this.lists.has(entity))
      return this.lists.get(entity).filter((row) => deleted || !row.deleted);
    const q = await this.tx.query(
      "SELECT * FROM site_entities WHERE team_id=$1 AND entity=$2" +
        " ORDER BY entity_key",
      [this.teamId, entity],
    );
    const rows = q.rows.map(rowEntity);
    this.lists.set(entity, rows);
    for (const row of rows) this.cache.set(entityId(entity, row.key), row);
    return rows.filter((row) => deleted || !row.deleted);
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
        canonical(payload),
        revision,
        storedDeleted ? 1 : 0,
      ],
    );
    const after = { entity, key, payload, revision, deleted: storedDeleted };
    if (this.lists.has(entity)) {
      const rows = this.lists.get(entity),
        index = rows.findIndex((r) => entityId(r.entity, r.key) === id);
      if (index < 0) rows.push(after);
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
    const { projectedState, pending, entities } = await this.projected();
    const opId = crypto.randomUUID(),
      dependsOn = new Set(),
      pendingIds = new Set(pending.map((op) => op.opId));
    const changes = [];
    for (const change of this.changes.values()) {
      const { entity, key, after } = change,
        current = entities[entityId(entity, key)];
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
                : key[0].startsWith("report")
                  ? "report"
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
        desired = after.payload;
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
        fields: [
          ...new Set([
            ...Object.keys(base || {}),
            ...Object.keys(desired || {}),
          ]),
        ].filter((k) => !equal(base?.[k], desired?.[k])),
      });
    }
    const operation = {
      protocol: 1,
      reducer: 1,
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
    const result = reduce(projectedState, operation);
    const size = assertStateCapacity(result.state, this.limits);
    if (
      size.bytes +
        pending.reduce((n, op) => n + Buffer.byteLength(canonical(op)), 0) +
        Buffer.byteLength(canonical(operation)) >
      this.limits.maxBytes
    )
      throw new CapacityError(
        "External state and pending capacity exceeded; previous data is unchanged",
      );
    assert(
      ["applied", "noop"].includes(result.receipt.result),
      409,
      "동기화 기준이 변경되었습니다. 최신 내용을 확인하세요.",
      { conflict: result.state.conflicts[opId] },
    );
    await this.tx.query(
      "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,created_at) VALUES($1,$2,$3,$4,$5)",
      [
        opId,
        this.teamId,
        canonical(operation),
        digest(operation),
        operation.createdAt,
      ],
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
      {
        const job = await tx.query(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND kind<>'backup' AND phase NOT IN ('complete','cancelled') LIMIT 1",
          [teamId],
        );
        assert(
          !job.rows.length,
          409,
          "팀 자료 정리 중입니다. 입력을 보존한 뒤 다시 저장하세요.",
        );
      }
      if (write && body?.year !== undefined)
        assert(
          !(
            await tx.query(
              "SELECT 1 FROM site_retention r JOIN team_sync_links l ON l.team_id=r.team_id AND l.installation_id=r.site_id WHERE r.team_id=$1 AND r.kind='year' AND r.entity_key=$2",
              [teamId, canonical([String(body.year)])],
            )
          ).rows.length,
          409,
          "이 사이트에서 제외된 연도입니다. 먼저 복원하세요.",
        );
      const operationId = body?.operationId;
      if (write && operationId) {
        const previous = (
          await tx.query(
            "SELECT * FROM site_operations WHERE team_id=$1 AND op_id=$2",
            [teamId, operationId],
          )
        ).rows[0];
        if (previous) {
          assert(
            previous.actor_id === actorId &&
              previous.request_hash === digest(body),
            409,
            "같은 요청 ID에 다른 내용을 저장할 수 없습니다.",
          );
          return JSON.parse(previous.response);
        }
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
              canonical(
                [...session.changes.values()].map((c) => ({
                  entity: c.entity,
                  key: c.key,
                  before: c.before?.payload ?? null,
                  after: c.after?.payload ?? null,
                })),
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
              canonical(result),
              new Date().toISOString(),
            ],
          );
      }
      return result;
    },
    { readOnly: !write },
  );
}
