import {
  taskCreationFields,
  duplicatedTaskCells,
  pastedTaskCells,
  blankInsertionFormatting,
  validatePersonalView,
  planTaskReorder,
  taskInsertionPlan,
} from "../../server/storage/task-command-rules.mjs";
import { normalizeCellStyle } from "../../shared/formatting.js";
import { styleNormalizer } from "../../shared/compact.js";
import { z } from "zod";
import {
  normalizeView,
  viewLayout,
  canEdit,
  periodYears,
} from "../../shared/domain.js";

import {
  periodScopeSchema,
  yearSchema,
  validateCellValue,
  viewSchema,
} from "../../shared/validation.js";
import { digest } from "../../server/sync/protocol.mjs";
import { assert } from "../access.mjs";
import {
  stamp,
  excludedYears,
  settingsFor,
  taskView,
  taskList,
  assignable,
  requireTask,
} from "../task-view.mjs";
export class PostgresTaskCommands {
  actor(user) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    this.context.user = user;
    return this.context;
  }
  async locate(user, taskId, { edit = false, includeDeleted = false } = {}) {
    const ctx = this.actor(user),
      { teamId } = await ctx.locate("task", taskId, { write: edit });
    return ctx.data(teamId, async (s) => {
      const row = await s.get("task", [taskId]);
      assert(
        row && !row.deleted && (!row.payload.deletedAt || includeDeleted),
        404,
        "업무를 찾을 수 없습니다.",
      );
      const task = await taskView(s, row);
      if (edit)
        assert(canEdit(user, task), 403, "이 업무를 편집할 권한이 없습니다.");
      return task;
    });
  }
  async getMany(user, ids, options = {}) {
    return Promise.all(ids.map((id) => this.locate(user, id, options)));
  }
  async create(user, body) {
    const ctx = this.actor(user);
    const teamId = body.teamId,
      year = yearSchema.parse(body.year);
    periodScopeSchema.parse(body);
    const allowed = await assignable(ctx, teamId);
    return ctx.data(
      teamId,
      async (s) => {
        assert(
          !(await excludedYears(s)).has(year),
          409,
          "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
        );
        const settings = await settingsFor(s);
        let fields = taskCreationFields(settings, user, body),
          cells = {},
          documents = [],
          defaultStyle = settings.defaultStyle,
          rowStyle = {},
          position;
        if (body.sourceId) {
          const original = requireTask(await s.get("task", [body.sourceId]));
          ({ cells, defaultStyle, rowStyle } = duplicatedTaskCells(
            await taskView(s, original),
            settings,
            body,
            fields,
          ));
          documents = (await s.list("document"))
            .filter((d) => d.key[0] === "task" && d.key[1] === body.sourceId)
            .map((d) => ({ id: d.key[2], ...d.payload }));
        }
        if (body.copiedRow) {
          ({
            cells = {},
            defaultStyle = {},
            rowStyle = {},
            documents = [],
          } = body.copiedRow);
          cells = pastedTaskCells(body.copiedRow, settings, (key, value) =>
            validateCellValue(
              null,
              teamId,
              key,
              value,
              settings,
              undefined,
              allowed,
            ),
          );
        }
        const years = periodYears(year, body.startMonth);
        const rows = (await s.list("task"))
          .filter(
            (t) =>
              !t.payload.deletedAt &&
              t.payload.years.some((year) => years.includes(year)),
          )
          .sort((a, b) => a.payload.position - b.payload.position);
        position = (rows.at(-1)?.payload.position || 0) + 100;
        if (body.insertAt) {
          const target = requireTask(
            await s.get("task", [body.insertAt.taskId]),
          );
          assert(
            target.payload.years.some((year) => years.includes(year)),
            400,
            "같은 팀과 연도의 행을 선택하세요.",
          );
          assert(
            stamp(target) === body.insertAt.updatedAt,
            409,
            "기준 행이 변경되었습니다.",
          );
          const plan = taskInsertionPlan(
            rows.map((row) => ({
              id: row.key[0],
              position: row.payload.position,
            })),
            body.insertAt.taskId,
            body.insertAt.placement,
          );
          position = plan.position;
          for (const row of plan.rebased) {
            const old = await s.get("task", [row.id]);
            await s.put("task", [row.id], {
              ...old.payload,
              position: row.position,
            });
          }
          if (!body.sourceId && !body.copiedRow) {
            ({ cells, defaultStyle, rowStyle } = blankInsertionFormatting(
              await taskView(s, target),
              settings,
              fields,
            ));
          }
        }
        const id = crypto.randomUUID(),
          now = new Date().toISOString();
        await s.put("task", [id], {
          years: [year],
          position,
          defaultStyle,
          rowStyle: rowStyle || {},
          createdBy: ctx.user.id,
          createdAt: now,
          deletedAt: null,
        });
        for (const [key, value] of Object.entries(fields))
          validateCellValue(
            null,
            teamId,
            key,
            value,
            settings,
            undefined,
            allowed,
          );
        cells = {
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              { value, style: {} },
            ]),
          ),
          ...cells,
        };
        const normalize = styleNormalizer();
        for (const [key, c] of Object.entries(cells)) {
          validateCellValue(
            null,
            teamId,
            key,
            c.value,
            settings,
            undefined,
            allowed,
          );
          let style = c.style || {};
          if (Object.keys(rowStyle || {}).length)
            style = normalizeCellStyle(
              { id, defaultStyle, rowStyle, cells: {} },
              key,
              style,
            );
          style = normalize(style, { ...defaultStyle, ...rowStyle });
          if (c.value !== "" || Object.keys(style).length)
            await s.put("cell", [id, key], {
              value: c.value,
              style,
            });
        }
        for (const [i, d] of documents.entries())
          await s.put("document", ["task", id, d.id], {
            title: d.title,
            position: i,
            markdown: d.markdown || "",
          });
        return { task: await taskView(s, await s.get("task", [id])) };
      },
      { write: true, body, action: "create" },
    );
  }
  async update(user, taskId, body) {
    const ctx = this.actor(user);
    const { teamId } = await ctx.locate("task", taskId, { write: true });
    return ctx.data(
      teamId,
      async (s) => {
        const row = requireTask(await s.get("task", [taskId]));
        assert(stamp(row) === body.updatedAt, 409, "업무가 변경되었습니다.");
        if (body.years) z.array(yearSchema).min(1).max(101).parse(body.years);
        const excluded = await excludedYears(s);
        if (body.years)
          assert(
            body.years.every(
              (year) => !excluded.has(year) || row.payload.years.includes(year),
            ),
            409,
            "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
          );
        const years = body.years
          ? [
              ...new Set([
                ...body.years,
                ...row.payload.years.filter((year) => excluded.has(year)),
              ]),
            ]
          : row.payload.years;
        if (body.position !== undefined)
          z.number().finite().parse(body.position);
        await s.put("task", row.key, {
          ...row.payload,
          years,
          position: body.position ?? row.payload.position,
        });
        return { task: await taskView(s, await s.get("task", row.key)) };
      },
      { write: true, body, action: "task" },
    );
  }
  remove(user, versions) {
    return this.changeDeleted(user, versions, false);
  }
  restore(user, versions) {
    return this.changeDeleted(user, versions, true);
  }
  async changeDeleted(user, versions, restoring) {
    const ctx = this.actor(user);
    const body = { tasks: versions };
    const { teamId } = await ctx.locate("task", versions[0].id, {
      write: true,
    });
    return ctx.data(
      teamId,
      async (s) => {
        const updatedAt = {},
          tasks = [];
        for (const v of versions) {
          const row = await s.get("task", [v.id]);
          assert(row && !row.deleted, 404, "업무를 찾을 수 없습니다.");
          assert(
            (restoring && v.updatedAt === undefined) ||
              v.updatedAt === stamp(row),
            409,
            "업무가 변경되었습니다. 최신 내용을 확인하세요.",
          );
          assert(
            restoring ? !!row.payload.deletedAt : !row.payload.deletedAt,
            409,
            "삭제 상태가 변경되었습니다.",
          );
          const saved = await s.put("task", row.key, {
            ...row.payload,
            deletedAt: restoring ? null : new Date().toISOString(),
          });
          updatedAt[v.id] = stamp(saved);
          tasks.push(await taskView(s, saved));
        }
        return restoring ? { tasks } : { ok: true, updatedAt };
      },
      { write: true, body, action: restoring ? "restore" : "delete" },
    );
  }
  async reorder(user, body) {
    const ctx = this.actor(user),
      { teamId } = await ctx.locate("task", body.targetId, { write: true });
    return ctx.data(
      teamId,
      async (s) => {
        const plan = planTaskReorder(
          await taskList(s),
          body,
          await settingsFor(s),
        );
        for (const task of [...plan.rebased, ...plan.moving]) {
          const old = await s.get("task", [task.id]);
          await s.put("task", [task.id], {
            ...old.payload,
            position: task.position,
          });
        }
        const tasks = await Promise.all(
          plan.moving.map((t) =>
            taskView(s, s.cache.get(JSON.stringify(["task", [t.id]]))),
          ),
        );
        return { task: tasks[0], tasks };
      },
      { write: true, body, action: "reorder" },
    );
  }
  async readViews(user, query) {
    const ctx = this.actor(user);
    return ctx.data(query.teamId, async (s) => {
      const row = await s.get("view", [
        ctx.user.id,
        String(yearSchema.parse(query.year)),
      ]);
      return {
        views: row
          ? [
              {
                id: digest(row.key),
                name: "__current",
                data: viewLayout(
                  normalizeView(row.payload, await settingsFor(s)),
                ),
                updatedAt: stamp(row),
              },
            ]
          : [],
      };
    });
  }
  async saveView(user, body) {
    const ctx = this.actor(user);
    return ctx.data(
      body.teamId,
      async (s) => {
        const data = viewSchema.parse(body.data),
          settings = await settingsFor(s);
        validatePersonalView(data, settings);
        await s.put(
          "view",
          [ctx.user.id, String(data.year)],
          viewLayout(normalizeView(data, await settingsFor(s))),
          { shared: false },
        );
        return { ok: true };
      },
      { body, write: true, allowViewer: true, privateWrite: true },
    );
  }
}
