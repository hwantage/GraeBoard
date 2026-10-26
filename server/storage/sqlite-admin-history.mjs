import { z } from "zod";
import { id, json, parse, transaction } from "../db.mjs";
import { dateSchema, requireThat } from "../validation.mjs";
import { todayKey } from "../../shared/domain.js";

const DAY = 24 * 60 * 60 * 1000;
export const CELL_RETRY_DAYS = 7;
const CLOCK_SKEW = 5 * 60 * 1000;
const PREVIEW_TTL = 15 * 60 * 1000;
const BATCH_ROWS = 500;
const BATCH_BYTES = 10 * 1024 * 1024;
const CELL_OPERATION =
  "json_extract(response,'$.kind') IN ('cell-audit','format-audit')";
const AUDIT_BYTES =
  "COALESCE(length(CAST(before_json AS BLOB)),0)+COALESCE(length(CAST(after_json AS BLOB)),0)";
const OPERATION_BYTES = "length(CAST(response AS BLOB))";
// A retry record is shared when it references more than one team. Count it
// once in the system scope; a team's cleanup must not remove shared metadata.
const OPERATION_TEAM =
  "CASE WHEN json_array_length(response,'$.refs')=1 THEN json_extract(response,'$.refs[0].teamId') ELSE NULL END";
const SCOPED_OPERATION = `${CELL_OPERATION} AND (${OPERATION_TEAM}) IS ?`;
// A multi-team cell operation uses the same target ID in every audit row.
// The primary-key lookup protects all its snapshots without scanning refs JSON.
const EXPIRED_AUDIT =
  "team_id IS ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id=audit.target AND o.created_at >= ?)";
const EXPIRED_OPERATION = `${SCOPED_OPERATION} AND created_at < ?`;

function scopeFor(db, scopeId) {
  if (scopeId === "system")
    return { id: "system", name: "시스템 공통", teamId: null };
  const team = db.prepare("SELECT id,name FROM teams WHERE id=?").get(scopeId);
  requireThat(team, 404, "팀을 찾을 수 없습니다. 보관 현황을 새로 확인하세요.");
  return { ...team, teamId: team.id };
}

function latestCleanup(db, teamId) {
  const row = db
    .prepare(
      "SELECT a.after_json,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE a.action='history-cleanup' AND a.team_id IS ? ORDER BY a.created_at DESC,a.id DESC LIMIT 1",
    )
    .get(teamId);
  return row ? { ...parse(row.after_json), actor: row.actor } : null;
}

function storageByTeam(db) {
  const scopes = new Map(
    db
      .prepare("SELECT id,name FROM teams ORDER BY name,id")
      .all()
      .map((team) => [team.id, team]),
  );
  scopes.set("system", { id: "system", name: "시스템 공통" });
  for (const scope of scopes.values())
    Object.assign(scope, {
      currentBytes: 0,
      reportBytes: 0,
      importBytes: 0,
      audit: { count: 0, bytes: 0 },
      operations: { count: 0, bytes: 0 },
    });
  // Aggregate stored payload sizes without loading their contents into JS.
  const length = (column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`;
  for (const [field, query] of [
    [
      "currentBytes",
      `SELECT id AS team_id,${length("settings")} AS bytes FROM teams`,
    ],
    [
      "currentBytes",
      `SELECT team_id,sum(${length("years")}) AS bytes FROM tasks GROUP BY team_id`,
    ],
    [
      "currentBytes",
      `SELECT t.team_id,sum(${length("c.value")}) AS bytes FROM cells c JOIN tasks t ON t.id=c.task_id GROUP BY t.team_id`,
    ],
    [
      "currentBytes",
      `SELECT NULL AS team_id,sum(${length("data")}) AS bytes FROM styles`,
    ],
    [
      "currentBytes",
      `SELECT team_id,sum(${length("rows_json")}+${length("keys_json")}+${length("exclusions_json")}+${length("orders_json")}) AS bytes FROM format_rules GROUP BY team_id`,
    ],
    [
      "currentBytes",
      `SELECT team_id,sum(${length("markdown")}) AS bytes FROM document_versions GROUP BY team_id`,
    ],
    ...["views", "saved_filters", "filter_states"].map((table) => [
      "currentBytes",
      `SELECT team_id,sum(${length("data")}) AS bytes FROM ${table} GROUP BY team_id`,
    ]),
    [
      "reportBytes",
      "SELECT team_id,sum(length(data)) AS bytes FROM reports GROUP BY team_id",
    ],
    [
      "importBytes",
      `SELECT team_id,sum(${length("data")}+${length("result")}) AS bytes FROM imports GROUP BY team_id`,
    ],
    [
      "audit",
      `SELECT team_id,count(*) AS count,sum(${AUDIT_BYTES}) AS bytes FROM audit GROUP BY team_id`,
    ],
    [
      "operations",
      `SELECT ${OPERATION_TEAM} AS team_id,count(*) AS count,sum(${OPERATION_BYTES}) AS bytes FROM operations WHERE ${CELL_OPERATION} GROUP BY ${OPERATION_TEAM}`,
    ],
  ]) {
    for (const row of db.prepare(query).all()) {
      const scope = scopes.get(row.team_id ?? "system");
      if (field === "audit" || field === "operations")
        scope[field] = { count: row.count, bytes: row.bytes };
      else scope[field] += row.bytes;
    }
  }
  return [...scopes.values()].map((scope) => ({
    ...scope,
    totalBytes:
      scope.currentBytes +
      scope.reportBytes +
      scope.importBytes +
      scope.audit.bytes +
      scope.operations.bytes,
    latest: latestCleanup(db, scope.id === "system" ? null : scope.id),
  }));
}

function summary(db, table, bytes, where = "1", params = []) {
  return db
    .prepare(
      `SELECT count(*) AS count,COALESCE(sum(${bytes}),0) AS bytes,min(created_at) AS oldest,max(created_at) AS newest FROM ${table} WHERE ${where}`,
    )
    .get(...params);
}
const emptyCounts = () => ({
  audit: { count: 0, bytes: 0 },
  operations: { count: 0, bytes: 0 },
});

function cleanupBatch(db, plan) {
  return transaction(db, () => {
    const deleted = emptyCounts();
    let count = 0,
      bytes = 0;
    for (const [key, table, size, where, params] of [
      [
        "operations",
        "operations",
        OPERATION_BYTES,
        EXPIRED_OPERATION,
        [plan.scope.teamId, plan.operationCutoff],
      ],
      [
        "audit",
        "audit",
        AUDIT_BYTES,
        EXPIRED_AUDIT,
        [plan.scope.teamId, plan.cutoff, plan.retryCutoff],
      ],
    ]) {
      if (count >= BATCH_ROWS || bytes >= BATCH_BYTES) break;
      const candidates = db
        .prepare(
          `SELECT id,${size} AS bytes FROM ${table} WHERE ${where} ORDER BY created_at,id LIMIT ?`,
        )
        .iterate(...params, BATCH_ROWS - count);
      const selected = [];
      for (const row of candidates) {
        // A single large record may exceed the byte limit; process it alone.
        if (count && bytes + row.bytes > BATCH_BYTES) break;
        selected.push(row.id);
        deleted[key].count++;
        deleted[key].bytes += row.bytes;
        count++;
        bytes += row.bytes;
      }
      // Stop reading once the byte budget is reached, and close the iterator
      // before changing its table. Large histories are never loaded as JSON.
      const remove = db.prepare(`DELETE FROM ${table} WHERE id=?`);
      for (const id of selected) remove.run(id);
    }
    const hasMore = !!(
      db
        .prepare(`SELECT 1 FROM operations WHERE ${EXPIRED_OPERATION} LIMIT 1`)
        .get(plan.scope.teamId, plan.operationCutoff) ||
      db
        .prepare(`SELECT 1 FROM audit WHERE ${EXPIRED_AUDIT} LIMIT 1`)
        .get(plan.scope.teamId, plan.cutoff, plan.retryCutoff)
    );
    const total = emptyCounts();
    for (const key of ["audit", "operations"]) {
      total[key].count = plan.deleted[key].count + deleted[key].count;
      total[key].bytes = plan.deleted[key].bytes + deleted[key].bytes;
    }
    const result = {
      scope: plan.scope,
      beforeDate: plan.beforeDate,
      cutoff: plan.cutoff,
      operationCutoff: plan.operationCutoff,
      deleted: total,
      startedAt: plan.createdAt,
      completed: !hasMore,
      updatedAt: new Date().toISOString(),
    };
    // One small log per run, updated in the same transaction as each batch.
    // An interrupted run therefore retains an accurate partial result.
    if (total.audit.count || total.operations.count)
      db.prepare(
        "INSERT INTO audit(id,team_id,actor_id,action,target,before_json,after_json,created_at) VALUES(?,?,?,'history-cleanup',?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json,created_at=excluded.created_at",
      ).run(
        plan.token,
        plan.scope.teamId,
        plan.actorId,
        plan.token,
        json(result),
        result.updatedAt,
      );
    return { ...result, batch: deleted, hasMore };
  });
}

const PAGE_SIZE = 50;
export class SqliteAdminHistoryRepository {
  constructor({ db }) {
    this.db = db;
    this.previews = new Map();
  }
  audit(user, query) {
    const db = this.db;
    const where = ["a.team_id IS NULL"];
    const params = [];
    if (query.from) {
      where.push("a.created_at >= ?");
      params.push(new Date(`${query.from}T00:00:00+09:00`).toISOString());
    }
    if (query.to) {
      where.push("a.created_at < ?");
      params.push(
        new Date(
          Date.parse(`${query.to}T00:00:00+09:00`) + 86400000,
        ).toISOString(),
      );
    }
    for (const [field, value] of [
      ["actor_id", query.actorId],
      ["action", query.action],
    ]) {
      if (value) {
        where.push(`a.${field} = ?`);
        params.push(value);
      }
    }
    if (query.cursorAt) {
      where.push("(a.created_at,a.id) < (?,?)");
      params.push(query.cursorAt, query.cursorId);
    }
    // Read only metadata here. Large before/after values are fetched on demand.
    const entries = db
      .prepare(
        `SELECT a.id,a.actor_id AS actorId,a.action,a.target,a.created_at AS createdAt,
          u.name AS actor,u.username AS actorUsername,
          target_user.name AS targetName,target_user.username AS targetUsername
        FROM audit a JOIN users u ON u.id=a.actor_id
        LEFT JOIN users target_user ON target_user.id=a.target
          AND a.action IN ('login','logout','profile','password','user-create','user-update')
        WHERE ${where.join(" AND ")}
        ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      )
      .all(...params, PAGE_SIZE + 1);
    const hasMore = entries.length > PAGE_SIZE;
    if (hasMore) entries.pop();
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: hasMore ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
  auditEntry(user, id) {
    const db = this.db;
    const entry = db
      .prepare(
        "SELECT before_json,after_json FROM audit WHERE id=? AND team_id IS NULL",
      )
      .get(id);
    requireThat(entry, 404, "로그가 없거나 이력 정리로 삭제되었습니다.");
    return {
      before: parse(entry.before_json),
      after: parse(entry.after_json),
    };
  }
  storage() {
    return { scopes: storageByTeam(this.db) };
  }
  recordCleanup(user, scopeId, token, result) {
    this.db
      .prepare(
        "INSERT INTO audit(id,team_id,actor_id,action,target,before_json,after_json,created_at) VALUES(?,NULL,?,'history-cleanup',?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json,created_at=excluded.created_at",
      )
      .run(token, user.id, scopeId, json(result), result.updatedAt);
  }
  latestCleanupFor(scopeId) {
    const row = this.db
      .prepare(
        "SELECT a.after_json,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE a.action='history-cleanup' AND a.team_id IS NULL AND a.target=? ORDER BY a.created_at DESC,a.id DESC LIMIT 1",
      )
      .get(scopeId);
    return row ? { ...parse(row.after_json), actor: row.actor } : null;
  }
  preview(user, { scopeId, beforeDate }) {
    const { db, previews } = this;
    const time = Date.now();
    const cutoff = new Date(`${beforeDate}T00:00:00+09:00`).toISOString();
    const retryCutoff = new Date(
      time - CELL_RETRY_DAYS * DAY - CLOCK_SKEW,
    ).toISOString();
    for (const [actorId, plan] of previews)
      if (plan.expiresAt <= time) previews.delete(actorId);
    const plan = {
      token: id(),
      actorId: user.id,
      scope: scopeFor(db, scopeId),
      beforeDate,
      createdAt: new Date(time).toISOString(),
      cutoff,
      // Requests may be at most five minutes ahead of the server clock.
      // Keep their deduplication records until that entire window expires.
      retryCutoff,
      operationCutoff: cutoff < retryCutoff ? cutoff : retryCutoff,
      expiresAt: time + PREVIEW_TTL,
      deleted: emptyCounts(),
    };
    const preview = {
      token: plan.token,
      scope: plan.scope,
      beforeDate,
      retryDays: CELL_RETRY_DAYS,
      cutoff: plan.cutoff,
      operationCutoff: plan.operationCutoff,
      createdAt: plan.createdAt,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      audit: {
        stored: summary(db, "audit", AUDIT_BYTES, "team_id IS ?", [
          plan.scope.teamId,
        ]),
        before: summary(
          db,
          "audit",
          AUDIT_BYTES,
          "team_id IS ? AND created_at < ?",
          [plan.scope.teamId, cutoff],
        ),
        eligible: summary(db, "audit", AUDIT_BYTES, EXPIRED_AUDIT, [
          plan.scope.teamId,
          plan.cutoff,
          plan.retryCutoff,
        ]),
      },
      operations: {
        stored: summary(db, "operations", OPERATION_BYTES, SCOPED_OPERATION, [
          plan.scope.teamId,
        ]),
        before: summary(
          db,
          "operations",
          OPERATION_BYTES,
          `${SCOPED_OPERATION} AND created_at < ?`,
          [plan.scope.teamId, cutoff],
        ),
        eligible: summary(
          db,
          "operations",
          OPERATION_BYTES,
          EXPIRED_OPERATION,
          [plan.scope.teamId, plan.operationCutoff],
        ),
      },
    };
    previews.set(user.id, plan);

    return preview;
  }
  cleanup(user, { token }) {
    const { db, previews } = this;
    const plan = previews.get(user.id);
    requireThat(
      plan && plan.token === token && plan.expiresAt > Date.now(),
      410,
      "정리 미리보기가 만료되었습니다. 대상을 다시 확인하세요.",
    );
    scopeFor(db, plan.scope.id);
    const result = cleanupBatch(db, plan);
    plan.deleted = result.deleted;
    plan.expiresAt = Date.now() + PREVIEW_TTL;
    if (!result.hasMore) previews.delete(user.id);

    return result;
  }
}
