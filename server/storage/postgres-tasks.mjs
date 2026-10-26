import { canManageTeam } from "../../shared/domain.js";
import { scopeKey, scopeMatches } from "../../shared/formatting.js";
import { styleNormalizer } from "../../shared/compact.js";
import { validateCellValue } from "../validation.mjs";
import { equal, digest } from "../sync/protocol.mjs";
import { assert } from "../../worker/access.mjs";
import {
  stamp,
  taskList,
  taskView,
  settingsFor,
  assignable,
  requireTask,
} from "../../worker/task-view.mjs";
import { prepareCellChange } from "./task-service.mjs";

export class PostgresTaskRepository {
  constructor({ context }) {
    this.context = context;
  }
  query(user, { teamId, year, startMonth, deleted, ifNoneMatch }) {
    const ctx = this.context;
    assert(
      user.id === ctx.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    return ctx.data(teamId, async (s) => {
      if (deleted)
        assert(
          canManageTeam(user, teamId),
          403,
          "팀장만 삭제한 업무를 조회할 수 있습니다.",
        );
      const cellEventId =
          "pg:" +
          Number(
            (
              await s.tx.query(
                "SELECT COALESCE(MAX(cursor),0) AS cursor FROM site_events WHERE team_id=$1",
                [teamId],
              )
            ).rows[0].cursor,
          ),
        etag =
          '"' +
          digest([teamId, { year, startMonth }, deleted, cellEventId]) +
          '"';
      if (ifNoneMatch === etag) return { etag, cellEventId, notModified: true };
      return {
        etag,
        cellEventId,
        data: {
          tasks: await taskList(s, { year, startMonth, deleted }),
          formatting: {
            ...(await s.get("formats", []))?.payload,
            revision: (await s.get("formats", []))?.revision || 0,
          },
        },
      };
    });
  }
  async saveBatch(user, d) {
    const ctx = this.context;
    assert(
      user.id === ctx.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    const first = d.format
        ? { teamId: d.format.teamId }
        : await ctx.locate("task", d.changes[0]?.taskId, { write: true }),
      teamId = first.teamId,
      allowed = await assignable(ctx, teamId);
    return ctx.data(
      teamId,
      async (s) => {
        const settings = await settingsFor(s),
          before = [],
          cells = [],
          updatedAt = {},
          seen = new Set(),
          normalize = styleNormalizer();
        let format = await s.get("formats", []);
        const previousFormatting = structuredClone(
            format?.payload || { rules: [] },
          ),
          previousFormatRevision = format?.revision || 0;
        if (d.format) {
          assert(
            (format?.revision || 0) === d.format.expectedRevision,
            409,
            "공통 서식이 변경되었습니다.",
          );
          if (d.format.restore) {
            const undo = await s.get("formatUndo", [d.format.restore]);
            assert(
              undo && !undo.deleted,
              404,
              "서식 복원 기록을 찾을 수 없습니다.",
            );
            for (const c of undo.payload.cells) {
              const old = await s.get("cell", [c.taskId, c.key]);
              assert(
                (old?.revision || 0) ===
                  d.format.expectedCells?.[c.taskId + ":" + c.key],
                409,
                "복원할 셀이 변경되었습니다.",
              );
              before.push({
                taskId: c.taskId,
                key: c.key,
                ...old?.payload,
                version: old?.revision || 0,
              });
              const saved = await s.put("cell", [c.taskId, c.key], {
                value: c.value,
                style: c.style,
              });
              cells.push({ ...c, version: saved.revision });
            }
            format = await s.put("formats", [], undo.payload.formatting);
          } else {
            const rows = await s.list("task");
            for (const scope of d.format.scopes)
              for (const id of scope.rows || rows.map((r) => r.key[0])) {
                const row = requireTask(rows.find((r) => r.key[0] === id));
                assert(
                  d.format.expectedTasks?.[id] === stamp(row),
                  409,
                  "업무가 변경되었습니다.",
                );
              }
            const rules = structuredClone(format?.payload.rules || []);
            let order =
              Math.max(
                0,
                ...rules.flatMap((r) => Object.values(r.orders || {})),
              ) + 1;
            for (const scope of d.format.scopes) {
              const index = rules.findIndex(
                  (r) => scopeKey(r) === scopeKey(scope),
                ),
                rule =
                  index >= 0
                    ? rules[index]
                    : {
                        id: crypto.randomUUID(),
                        rows: scope.rows,
                        keys: scope.keys,
                        excludeKeys: scope.excludeKeys || [],
                        style: {},
                        orders: {},
                      };
              for (const key of Object.keys(scope.style || {})) {
                if (scope.reset) {
                  if (key in rule.style) {
                    delete rule.style[key];
                    delete rule.orders[key];
                  }
                } else if (!equal(rule.style[key], scope.style[key])) {
                  rule.style[key] = scope.style[key];
                  rule.orders[key] = order++;
                }
              }
              if (index < 0 && Object.keys(rule.style).length) rules.push(rule);
              else if (index >= 0 && !Object.keys(rule.style).length)
                rules.splice(index, 1);
            }
            format = await s.put("formats", [], { rules });
            for (const c of await s.list("cell")) {
              const style = { ...c.payload.style };
              for (const scope of d.format.scopes)
                if (scopeMatches(scope, c.key[0], c.key[1]))
                  for (const key of Object.keys(scope.style || {}))
                    delete style[key];
              if (!equal(style, c.payload.style)) {
                before.push({
                  taskId: c.key[0],
                  key: c.key[1],
                  ...c.payload,
                  version: c.revision,
                });
                const n = await s.put("cell", c.key, { ...c.payload, style });
                cells.push({
                  taskId: c.key[0],
                  key: c.key[1],
                  ...n.payload,
                  version: n.revision,
                });
              }
            }
          }
          await s.put(
            "formatUndo",
            [d.operationId],
            { formatting: previousFormatting, cells: before },
            { shared: false },
          );
        } else
          for (const change of d.changes) {
            const key = JSON.stringify([change.taskId, change.key]);
            assert(!seen.has(key), 400, "같은 셀을 중복 수정할 수 없습니다.");
            seen.add(key);
            const row = requireTask(await s.get("task", [change.taskId])),
              task = change.style !== undefined ? await taskView(s, row) : null,
              old = await s.get("cell", [change.taskId, change.key]),
              previous = old
                ? { ...old.payload, version: old.revision }
                : { value: "", style: {}, version: 0 };
            const desired = prepareCellChange({
              change,
              task,
              previous,
              formatRevision: format?.revision || 0,
              normalize,
              validateValue: () =>
                validateCellValue(
                  null,
                  teamId,
                  change.key,
                  change.value,
                  settings,
                  previous.value,
                  allowed,
                ),
            });
            if (!desired) continue;
            before.push({
              taskId: change.taskId,
              key: change.key,
              ...previous,
            });
            const saved = await s.put(
              "cell",
              [change.taskId, change.key],
              desired,
            );
            cells.push({
              taskId: change.taskId,
              key: change.key,
              ...desired,
              version: saved.revision,
            });
          }
        for (const id of new Set(cells.map((c) => c.taskId))) {
          await s.touch("task", [id]);
          updatedAt[id] = stamp(await s.get("task", [id]));
        }
        const result = {
          cells,
          before,
          operationId: d.operationId,
          savedAt: new Date().toISOString(),
          updatedAt,
          formatRevision: format?.revision || 0,
          ...(d.format
            ? {
                ...((format?.revision || 0) !== previousFormatRevision ||
                cells.length
                  ? { formatOperation: d.operationId }
                  : {}),
                previousFormatRevision,
                formatTeamId: teamId,
                formatting: { ...format.payload, revision: format.revision },
              }
            : {}),
        };
        if (cells.length) await s.event("cells", result);
        return result;
      },
      { write: true, body: d, action: d.format ? "format" : "cells" },
    );
  }
}
