import { assert } from "../../worker/access.mjs";
import { taskView } from "../../worker/task-view.mjs";
import { reportView } from "../../worker/reports.mjs";
import { TaskBusinessService } from "./task-service.mjs";
import { PostgresTaskRepository } from "./postgres-tasks.mjs";
const decoded = (row) => ({ ...row, changes: JSON.parse(row.payload) });
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
export class PostgresHistoryRepository {
  constructor({ context }) {
    this.context = context;
  }
  check(user) {
    assert(
      this.context.user.id === user.id,
      403,
      "사용자 저장소 범위를 확인하세요.",
    );
    return this.context;
  }
  async query(user, query) {
    const ctx = this.check(user);
    const teamId = query.teamId,
      taskId = query.taskId,
      sheet = query.sheetId,
      names = new Map(
        (await ctx.controlStore.users()).map((r) => [r.id, r.name]),
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
        if (entries.length === query.limit) break;
      }
      return { entries };
    });
  }
  async restore(user, entryId, body) {
    const ctx = this.check(user);
    const { teamId, row } = await locateAudit(ctx, entryId);
    await ctx.team(teamId, {
      manage: row.action !== "report-edit",
      write: true,
    });
    if (row.action === "format")
      return new TaskBusinessService(
        new PostgresTaskRepository({ context: ctx }),
        user,
      ).saveBatch({
        operationId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        format: {
          teamId,
          expectedRevision: body.formatRevision,
          restore: row.target,
          expectedCells: body.versions || {},
        },
      });
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
}
