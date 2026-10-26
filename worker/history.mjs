import { z } from "zod";
import { assert } from "./access.mjs";
import { canonical, equal } from "../server/sync/protocol.mjs";
import { dateSchema } from "../server/validation.mjs";
import { todayKey } from "../shared/domain.js";
import { controlTransaction, databaseFor } from "./data.mjs";
import { profileFor } from "./config.mjs";
import { taskRoutes, taskView, stamp } from "./tasks.mjs";
import { reportView } from "./reports.mjs";
const decoded = (row) => ({ ...row, changes: JSON.parse(row.payload) });
const empty = () => ({ count: 0, bytes: 0 });
async function historyEntry(s, row, names) {
  const changes = Array.isArray(row.changes) ? row.changes : [],
    cellChanges = changes.filter((c) => c.entity === "cell"),
    format = changes.find((c) => c.entity === "formats"),
    report = changes.find((c) => c.entity === "report"),
    taskChanges = changes.filter((c) => c.entity === "task"),
    deleted = taskChanges.filter(
      (c) => !c.before?.deletedAt && c.after?.deletedAt,
    ),
    deletedTasks = [];
  for (const c of deleted) {
    const current = await s.get("task", c.key);
    deletedTasks.push(
      current
        ? await taskView(s, { ...current, payload: c.before })
        : { id: c.key[0], cells: {} },
    );
  }
  const cells = (side) =>
    cellChanges.map((c) => ({
      taskId: c.key[0],
      key: c.key[1],
      ...(c[side] || { value: "", style: {} }),
    }));
  let before = changes.map((c) => c.before),
    after = changes.map((c) => c.after),
    action = row.action,
    restorableTaskIds = [];
  if (action === "cells") {
    before = cells("before");
    after = cells("after");
  }
  if (action === "format") {
    before = {
      formatting: format?.before || { rules: [] },
      cells: cells("before"),
    };
    after = {
      formatting: format?.after || { rules: [] },
      cells: cells("after"),
      taskIds: [...new Set(cellChanges.map((c) => c.key[0]))],
    };
  }
  if (deleted.length) {
    for (const c of deleted) {
      const current = await s.get("task", c.key);
      if (current?.payload.deletedAt === c.after.deletedAt)
        restorableTaskIds.push(c.key[0]);
    }
    if (deleted.length === 1) {
      action = "delete";
      before = deletedTasks[0];
      after = deleted[0].after;
    } else {
      action = "tasks-delete";
      before = { deletedTasks };
      after = {};
    }
  }
  if (action === "report-edit" && report) {
    const removed = (report.before?.data.tasks || []).filter(
      (t) => !report.after.data.tasks.some((n) => n.id === t.id),
    );
    const current = await s.get("report", report.key);
    before = { deletedTasks: removed };
    after = { name: report.after.name };
    restorableTaskIds = removed
      .filter(
        (t) =>
          current &&
          !current.deleted &&
          !current.payload.data.tasks.some((n) => n.id === t.id),
      )
      .map((t) => t.id);
  }
  return {
    id: row.id,
    actor: names.get(row.actor_id) || row.actor_id,
    actorId: row.actor_id,
    action,
    target: report?.key[0] || taskChanges[0]?.key[0] || row.target,
    before,
    after,
    sheet: {
      id: report?.key[0] || "original",
      name: report?.after?.name || report?.before?.name || "원본",
    },
    restorableTaskIds,
    createdAt: row.created_at,
  };
}
async function locateAudit(ctx, id) {
  for (const team of await ctx.teams()) {
    if (team.status !== "active") continue;
    const row = await ctx.data(
      team.id,
      async (s) =>
        (
          await s.tx.query(
            "SELECT * FROM site_audit WHERE team_id=$1 AND id=$2",
            [team.id, id],
          )
        ).rows[0],
    );
    if (row) return { teamId: team.id, row: decoded(row) };
  }
  assert(false, 404, "이력을 찾을 수 없습니다.");
}
export async function auditRoutes(ctx, path, method, body, query) {
  if (path === "/audit" && method === "GET") {
    const teamId = query.get("teamId"),
      taskId = query.get("taskId"),
      sheet = query.get("sheetId"),
      names = new Map(
        (
          await controlTransaction(
            ctx.env,
            async (tx) => (await tx.query("SELECT id,name FROM users")).rows,
          )
        ).map((r) => [r.id, r.name]),
      );
    return ctx.data(teamId, async (s) => {
      const rows = (
          await s.tx.query(
            "SELECT * FROM site_audit WHERE team_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1000",
            [teamId],
          )
        ).rows.map(decoded),
        entries = [];
      for (const row of rows) {
        if (!Array.isArray(row.changes)) continue;
        const report = row.changes.find((c) => c.entity === "report");
        if (sheet && (report?.key[0] || "original") !== sheet) continue;
        if (taskId && !row.changes.some((c) => c.key.includes(taskId)))
          continue;
        entries.push(await historyEntry(s, row, names));
        if (entries.length === 100) break;
      }
      return { entries };
    });
  }
  const match = /^\/audit\/([^/]+)\/restore$/.exec(path);
  if (!match || method !== "POST") return undefined;
  const { teamId, row } = await locateAudit(ctx, match[1]);
  await ctx.team(teamId, { manage: row.action !== "report-edit", write: true });
  if (row.action === "format")
    return taskRoutes(
      ctx,
      "/cells/batch",
      "POST",
      {
        operationId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        format: {
          teamId,
          expectedRevision: body.formatRevision,
          restore: row.target,
          expectedCells: body.versions || {},
        },
      },
      query,
    );
  return ctx.data(
    teamId,
    async (s) => {
      if (row.action === "cells") {
        const result = [];
        for (const c of row.changes.filter((c) => c.entity === "cell")) {
          const current = await s.get("cell", c.key),
            task = await s.get("task", [c.key[0]]);
          assert(
            task &&
              !task.deleted &&
              !task.payload.deletedAt &&
              (current?.revision || 0) === body.versions?.[c.key.join(":")],
            409,
            "복원 대상이 변경되었습니다.",
          );
          const saved = await s.put(
            "cell",
            c.key,
            c.before || { value: "", style: {} },
          );
          await s.touch("task", [c.key[0]]);
          result.push({
            taskId: c.key[0],
            key: c.key[1],
            ...saved.payload,
            version: saved.revision,
          });
        }
        return { cells: result };
      }
      if (row.action === "report-edit") {
        const change = row.changes.find((c) => c.entity === "report"),
          report = await s.get("report", change.key);
        assert(
          report &&
            !report.deleted &&
            (await reportView(s, report)).revision === body.revision,
          409,
          "사본이 변경되었습니다.",
        );
        const removed = change.before.data.tasks.filter(
            (t) => !change.after.data.tasks.some((n) => n.id === t.id),
          ),
          restore = removed.filter(
            (t) => !report.payload.data.tasks.some((n) => n.id === t.id),
          );
        assert(restore.length, 409, "복원할 업무가 없습니다.");
        const saved = await s.put("report", report.key, {
          ...report.payload,
          data: {
            ...report.payload.data,
            tasks: [...report.payload.data.tasks, ...restore].sort(
              (a, b) => a.position - b.position,
            ),
          },
        });
        for (const c of row.changes.filter(
          (c) => c.entity === "document" && c.before,
        )) {
          const current = await s.get("document", c.key);
          if (current?.deleted) await s.put("document", c.key, c.before);
        }
        return reportView(s, saved);
      }
      const deleted = row.changes.filter(
        (c) =>
          c.entity === "task" && !c.before?.deletedAt && c.after?.deletedAt,
      );
      assert(deleted.length, 400, "복원할 삭제 이력이 없습니다.");
      const tasks = [];
      for (const c of deleted) {
        const current = await s.get("task", c.key);
        assert(
          current &&
            !current.deleted &&
            current.payload.deletedAt === c.after.deletedAt,
          409,
          "삭제 후 업무가 변경되었습니다.",
        );
        const restored = await s.put("task", c.key, {
          ...current.payload,
          deletedAt: null,
        });
        tasks.push(await taskView(s, restored));
      }
      return { tasks };
    },
    {
      write: true,
      body: { ...body, operationId: crypto.randomUUID() },
      action: "history-restore",
    },
  );
}
const summary = async (tx, table, predicate = "", args = []) => {
  const r = (
    await tx.query(
      `SELECT COUNT(*)::integer count,COALESCE(SUM(octet_length(${table === "site_operations" ? "response" : "payload"})),0)::bigint bytes,MIN(created_at) oldest,MAX(created_at) newest FROM ${table}${predicate ? " WHERE " + predicate : ""}`,
      args,
    )
  ).rows[0];
  return { ...r, count: Number(r.count), bytes: Number(r.bytes) };
};
export async function historyCleanupRoutes(ctx, path, method, body, query) {
  if (!path.startsWith("/admin/history-cleanup")) return undefined;
  ctx.admin();
  const scopeFor = async (id) =>
    id === "system"
      ? { id, name: "관리 이력", system: true }
      : { ...(await ctx.team(id)), id, name: (await ctx.team(id)).name };
  const scopeTx = async (scope, fn) =>
    scope.system
      ? controlTransaction(ctx.env, fn, { write: method === "POST" })
      : databaseFor(
          ctx.env,
          profileFor(ctx.env, scope.profile_id, scope.id),
        ).withTeamTransaction(scope.id, async (tx) => {
          if (method === "POST")
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
        });
  if (path.endsWith("/storage") && method === "GET") {
    const scopes = [];
    for (const scope of [
      { id: "system", name: "관리 이력", system: true },
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
              latest: null,
            };
          }),
        );
      } catch {
        if (scope.system) throw new Error("관리 DB 연결을 확인하세요.");
      }
    }
    return { scopes };
  }
  if (method === "GET") {
    const scope = await scopeFor(query.get("scopeId")),
      beforeDate = dateSchema.parse(query.get("beforeDate"));
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
  if (method === "POST") {
    assert(body.confirmed === true, 400, "정리 확인이 필요합니다.");
    const plan = await controlTransaction(ctx.env, async (tx) => {
      const row = (
        await tx.query(
          "SELECT payload FROM control_jobs WHERE id=$1 AND kind='history-cleanup'",
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
  return undefined;
}
