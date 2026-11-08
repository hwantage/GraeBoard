import {
  historyQuerySchema,
  historyRestoreSchema,
} from "../../../server/storage/history/history-service.mjs";
import { assert } from "../../control/access.mjs";
import { unpackSheetClonePayload } from "../../../shared/sheet-clones/sheet-clone-sync-data.js";
import { taskView } from "../../sheet/task-view.mjs";
import { sheetCloneView } from "../../sheet-clones/sheet-clones.mjs";
import { TaskBusinessService } from "../../../server/storage/tasks/task-service.mjs";
import { PostgresTaskRepository } from "../tasks/postgres-tasks.mjs";
// SheetClone changes are recorded in their stored (packed) form; older rows hold
// the plain form, which unpacking leaves as it is.
const decoded = (row) => {
  const changes = JSON.parse(row.payload);
  return {
    ...row,
    changes: Array.isArray(changes)
      ? changes.map((c) =>
          c?.entity === "sheetClone"
            ? {
                ...c,
                before: unpackSheetClonePayload(c.before),
                after: unpackSheetClonePayload(c.after),
              }
            : c,
        )
      : changes,
  };
};
async function historyEntry(s, row, names) {
  const changes = Array.isArray(row.changes) ? row.changes : [],
    cellChanges = changes.filter((c) => c.entity === "cell"),
    format = changes.find((c) => c.entity === "formats"),
    sheetClone = changes.find((c) => c.entity === "sheetClone"),
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
  if (action === "sheet-clone-edit" && sheetClone) {
    const removed = (sheetClone.before?.data.tasks || []).filter(
      (t) => !sheetClone.after.data.tasks.some((n) => n.id === t.id),
    );
    const current = await s.get("sheetClone", sheetClone.key);
    before = { deletedTasks: removed };
    after = { name: sheetClone.after.name };
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
    target: sheetClone?.key[0] || taskChanges[0]?.key[0] || row.target,
    before,
    after,
    sheet: {
      id: sheetClone?.key[0] || "original",
      name: sheetClone?.after?.name || sheetClone?.before?.name || "원본",
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
    query = historyQuerySchema.parse(query);
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
        const sheetClone = row.changes.find((c) => c.entity === "sheetClone");
        if (sheet && (sheetClone?.key[0] || "original") !== sheet) continue;
        if (taskId && !row.changes.some((c) => c.key.includes(taskId)))
          continue;
        entries.push(await historyEntry(s, row, names));
        if (entries.length === query.limit) break;
      }
      return { entries };
    });
  }
  async restore(user, entryId, body) {
    body = historyRestoreSchema.parse(body);
    const ctx = this.check(user);
    const { teamId, row } = await locateAudit(ctx, entryId);
    await ctx.team(teamId, {
      manage: row.action !== "sheet-clone-edit",
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
        if (row.action === "sheet-clone-edit") {
          const change = row.changes.find((c) => c.entity === "sheetClone"),
            sheetClone = await s.get("sheetClone", change.key);
          assert(
            sheetClone &&
              !sheetClone.deleted &&
              (await sheetCloneView(s, sheetClone)).revision === body.revision,
            409,
            "사본이 변경되었습니다.",
          );
          const removed = change.before.data.tasks.filter(
              (t) => !change.after.data.tasks.some((n) => n.id === t.id),
            ),
            restore = removed.filter(
              (t) => !sheetClone.payload.data.tasks.some((n) => n.id === t.id),
            );
          assert(restore.length, 409, "복원할 업무가 없습니다.");
          const saved = await s.put("sheetClone", sheetClone.key, {
            ...sheetClone.payload,
            data: {
              ...sheetClone.payload.data,
              tasks: [...sheetClone.payload.data.tasks, ...restore].sort(
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
          return sheetCloneView(s, saved);
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
