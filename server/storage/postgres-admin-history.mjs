import { assert } from "../../worker/access.mjs";
import { dateSchema } from "../validation.mjs";
import { canonical } from "../sync/protocol.mjs";
import { todayKey } from "../../shared/domain.js";
import { controlTransaction, databaseFor } from "../../worker/data.mjs";
const empty = () => ({ count: 0, bytes: 0 });
const summary = async (tx, table, predicate = "", args = []) => {
  const r = (
    await tx.query(
      `SELECT COUNT(*)::integer count,COALESCE(SUM(octet_length(${table === "site_operations" ? "response" : "payload"})),0)::bigint bytes,MIN(created_at) oldest,MAX(created_at) newest FROM ${table}${predicate ? " WHERE " + predicate : ""}`,
      args,
    )
  ).rows[0];
  return { ...r, count: Number(r.count), bytes: Number(r.bytes) };
};

export class PostgresAdminHistoryRepository {
  constructor({ context, systemRepository, previewStore }) {
    this.context = context;
    this.systemRepository = systemRepository;
    this.previewStore = previewStore;
    if (systemRepository && !previewStore)
      throw new TypeError("Hybrid history requires a shared preview store");
  }
  actor(user) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    this.context.user = user;
    return this.context;
  }
  async scopeFor(user, id) {
    const ctx = this.actor(user);
    return id === "system"
      ? { id, name: "관리 이력", system: true }
      : { ...(await ctx.team(id)), id, name: (await ctx.team(id)).name };
  }
  async scopeTransaction(user, scope, fn, { write = false } = {}) {
    const ctx = this.actor(user);
    return scope.system
      ? controlTransaction(ctx.env, fn, { write })
      : databaseFor(ctx.env, await ctx.profile(scope.id)).withTeamTransaction(
          scope.id,
          async (tx) => {
            if (write)
              assert(
                !(
                  await tx.query(
                    "SELECT 1 FROM site_maintenance_jobs WHERE phase NOT IN ('complete','cancelled')",
                  )
                ).rows.length,
                409,
                "팀 이관 또는 정리 완료 후 다시 시도하세요.",
              );
            return fn(tx);
          },
          { readOnly: !write },
        );
  }
  async storage(user) {
    const ctx = this.actor(user),
      scopeFor = (id) => this.scopeFor(user, id),
      scopeTx = (scope, fn) =>
        this.scopeTransaction(user, scope, fn, { write: false });
    const scopes = this.systemRepository
      ? (await this.systemRepository.storage(user)).scopes.filter(
          (scope) => scope.id === "system",
        )
      : [];
    for (const scope of [
      ...(!this.systemRepository
        ? [{ id: "system", name: "관리 이력", system: true }]
        : []),
      ...(await ctx.teams()).filter((t) => t.status === "active"),
    ]) {
      try {
        scopes.push(
          await scopeTx(scope, async (tx) => {
            const audit = await summary(
                tx,
                scope.system ? "control_audit" : "site_audit",
              ),
              operations = scope.system
                ? empty()
                : await summary(tx, "site_operations"),
              sizes = scope.system
                ? {}
                : (
                    await tx.query(
                      "SELECT COALESCE(SUM(octet_length(payload)) FILTER(WHERE entity<>'report' AND entity<>'import'),0) current,COALESCE(SUM(octet_length(payload)) FILTER(WHERE entity='report'),0) report,COALESCE(SUM(octet_length(payload)) FILTER(WHERE entity='import'),0) import FROM site_entities",
                    )
                  ).rows[0];
            return {
              id: scope.id,
              name: scope.name,
              currentBytes: Number(sizes.current || 0),
              reportBytes: Number(sizes.report || 0),
              importBytes: Number(sizes.import || 0),
              totalBytes:
                Number(sizes.current || 0) +
                Number(sizes.report || 0) +
                Number(sizes.import || 0) +
                audit.bytes +
                operations.bytes,
              audit,
              operations,
              latest: this.systemRepository?.latestCleanupFor(scope.id) || null,
            };
          }),
        );
      } catch {
        if (scope.system) throw new Error("관리 DB 연결을 확인하세요.");
      }
    }
    return { scopes };
  }
  async preview(user, query) {
    if (this.systemRepository && query.scopeId === "system") {
      this.actor(user);
      const result = await this.systemRepository.preview(user, query);
      for (const [id, value] of this.previewStore)
        if (value.expiresAt <= Date.now() || value.actorId === user.id)
          this.previewStore.delete(id);
      this.previewStore.set(result.token, {
        system: true,
        actorId: user.id,
        expiresAt: Date.parse(result.expiresAt),
      });
      return result;
    }
    const ctx = this.actor(user),
      scopeFor = (id) => this.scopeFor(user, id),
      scopeTx = (scope, fn) =>
        this.scopeTransaction(user, scope, fn, { write: false });
    const scope = await scopeFor(query.scopeId),
      beforeDate = dateSchema.parse(query.beforeDate);
    assert(
      beforeDate >= "2000-01-01" && beforeDate <= todayKey(),
      400,
      "기준 날짜를 확인하세요.",
    );
    const cutoff = new Date(beforeDate + "T00:00:00+09:00").toISOString(),
      retryCutoff = new Date(Date.now() - 7 * 86400000 - 300000).toISOString(),
      operationCutoff = cutoff < retryCutoff ? cutoff : retryCutoff,
      token = crypto.randomUUID(),
      plan = {
        scopeId: scope.id,
        beforeDate,
        cutoff,
        operationCutoff,
        actorId: ctx.user.id,
        expiresAt: Date.now() + 600000,
        deleted: { audit: empty(), operations: empty() },
      };
    const result = await scopeTx(scope, async (tx) => {
      const auditTable = scope.system ? "control_audit" : "site_audit";
      return {
        audit: {
          stored: await summary(tx, auditTable),
          before: await summary(tx, auditTable, "created_at<$1", [cutoff]),
          eligible: await summary(tx, auditTable, "created_at<$1", [
            operationCutoff,
          ]),
        },
        operations: scope.system
          ? { stored: empty(), before: empty(), eligible: empty() }
          : {
              stored: await summary(tx, "site_operations"),
              before: await summary(tx, "site_operations", "created_at<$1", [
                cutoff,
              ]),
              eligible: await summary(tx, "site_operations", "created_at<$1", [
                operationCutoff,
              ]),
            },
      };
    });
    if (this.previewStore) {
      for (const [id, value] of this.previewStore)
        if (value.expiresAt <= Date.now() || value.actorId === user.id)
          this.previewStore.delete(id);
      this.previewStore.set(token, plan);
    } else
      await controlTransaction(
        ctx.env,
        (tx) =>
          tx.query(
            "INSERT INTO control_jobs(id,team_id,kind,phase,payload,created_at) VALUES($1,NULL,'history-cleanup','cancelled',$2,$3)",
            [token, canonical(plan), new Date().toISOString()],
          ),
        { write: true },
      );
    return {
      token,
      scope: { id: scope.id, name: scope.name },
      beforeDate,
      ...result,
    };
  }
  async cleanup(user, body) {
    const ctx = this.actor(user),
      scopeFor = (id) => this.scopeFor(user, id),
      scopeTx = (scope, fn) =>
        this.scopeTransaction(user, scope, fn, { write: true });
    assert(body.confirmed === true, 400, "정리 확인이 필요합니다.");
    const plan = this.previewStore
      ? this.previewStore.get(body.token)
      : await controlTransaction(ctx.env, async (tx) => {
          const row = (
            await tx.query(
              "SELECT payload FROM control_jobs WHERE id=$1 AND kind='history-cleanup' AND phase='cancelled'",
              [body.token],
            )
          ).rows[0];
          return row && JSON.parse(row.payload);
        });
    assert(
      plan && plan.actorId === ctx.user.id && plan.expiresAt > Date.now(),
      410,
      "정리 미리보기가 만료되었습니다.",
    );
    if (plan.system && this.systemRepository) {
      const result = await this.systemRepository.cleanup(user, body);
      plan.expiresAt = Date.now() + 600000;
      if (!result.hasMore) this.previewStore.delete(body.token);
      return result;
    }
    const scope = await scopeFor(plan.scopeId),
      result = await scopeTx(scope, async (tx) => {
        const removed = { audit: empty(), operations: empty() };
        for (const [kind, table, key, payload] of [
          [
            "audit",
            scope.system ? "control_audit" : "site_audit",
            "id",
            "payload",
          ],
          ...(scope.system
            ? []
            : [["operations", "site_operations", "op_id", "response"]]),
        ]) {
          const rows = (
            await tx.query(
              `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE created_at<$1 ORDER BY created_at,${key} LIMIT 250) RETURNING ${payload}`,
              [plan.operationCutoff],
            )
          ).rows;
          removed[kind] = {
            count: rows.length,
            bytes: rows.reduce(
              (n, r) => n + Buffer.byteLength(r[payload] || ""),
              0,
            ),
          };
        }
        const more =
          (
            await summary(
              tx,
              scope.system ? "control_audit" : "site_audit",
              "created_at<$1",
              [plan.operationCutoff],
            )
          ).count +
          (!scope.system
            ? (
                await summary(tx, "site_operations", "created_at<$1", [
                  plan.operationCutoff,
                ])
              ).count
            : 0);
        return { removed, hasMore: more > 0 };
      });
    for (const kind of ["audit", "operations"])
      for (const key of ["count", "bytes"])
        plan.deleted[kind][key] += result.removed[kind][key];
    plan.expiresAt = Date.now() + 600000;
    const response = {
      deleted: plan.deleted,
      hasMore: result.hasMore,
      completed: !result.hasMore,
      updatedAt: new Date().toISOString(),
      beforeDate: plan.beforeDate,
    };
    if (this.previewStore) {
      this.systemRepository.recordCleanup(user, scope.id, body.token, response);
      if (!result.hasMore) this.previewStore.delete(body.token);
    } else
      await controlTransaction(
        ctx.env,
        async (tx) => {
          await tx.query(
            "UPDATE control_jobs SET payload=$2,phase=$3 WHERE id=$1",
            [
              body.token,
              canonical(plan),
              result.hasMore ? "cancelled" : "complete",
            ],
          );
          await tx.query(
            "INSERT INTO control_audit(id,actor_id,action,target,payload,created_at) VALUES($1,$2,'history-cleanup',$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,created_at=EXCLUDED.created_at",
            [
              body.token,
              ctx.user.id,
              scope.id,
              canonical(response),
              response.updatedAt,
            ],
          );
        },
        { write: true },
      );
    return response;
  }
  async audit(user, query) {
    if (this.systemRepository) {
      this.actor(user);
      return this.systemRepository.audit(user, query);
    }
    const ctx = this.actor(user),
      where = [],
      params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace("?", "$" + params.length));
    };
    if (query.from)
      add(
        "a.created_at>=?",
        new Date(query.from + "T00:00:00+09:00").toISOString(),
      );
    if (query.to)
      add(
        "a.created_at<?",
        new Date(
          Date.parse(query.to + "T00:00:00+09:00") + 86400000,
        ).toISOString(),
      );
    if (query.actorId) add("a.actor_id=?", query.actorId);
    if (query.action) add("a.action=?", query.action);
    if (query.cursorAt) {
      params.push(query.cursorAt, query.cursorId);
      where.push(
        `(a.created_at,a.id)<($${params.length - 1},$${params.length})`,
      );
    }
    return controlTransaction(ctx.env, async (tx) => {
      const entries = (
        await tx.query(
          `SELECT a.id,a.actor_id AS "actorId",a.action,a.target,a.created_at AS "createdAt",u.name AS actor,u.username AS "actorUsername",target_user.name AS "targetName",target_user.username AS "targetUsername" FROM control_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users target_user ON target_user.id=a.target AND a.action IN ('login','logout','profile','password','user-create','user-update') ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.created_at DESC,a.id DESC LIMIT 51`,
          params,
        )
      ).rows;
      const hasMore = entries.length > 50;
      if (hasMore) entries.pop();
      const last = entries.at(-1);
      return {
        entries,
        nextCursor: hasMore ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }
  async auditEntry(user, id) {
    if (this.systemRepository) {
      this.actor(user);
      return this.systemRepository.auditEntry(user, id);
    }
    const ctx = this.actor(user);
    return controlTransaction(ctx.env, async (tx) => {
      const row = (
        await tx.query("SELECT payload FROM control_audit WHERE id=$1", [id])
      ).rows[0];
      assert(row, 404, "로그가 없거나 이력 정리로 삭제되었습니다.");
      const value = JSON.parse(row.payload);
      return value &&
        typeof value === "object" &&
        (Object.hasOwn(value, "before") || Object.hasOwn(value, "after"))
        ? { before: value.before ?? null, after: value.after ?? null }
        : { before: null, after: value };
    });
  }
}
