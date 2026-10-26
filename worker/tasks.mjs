import { z } from "zod";
import {
  propertiesFor,
  emptyPropertyValue,
  normalizeView,
  viewLayout,
  savedFilter,
} from "../shared/domain.js";
import { copyRowFormatting } from "../shared/formatting.js";
import {
  periodScopeSchema,
  yearSchema,
  validateCellValue,
  viewSchema,
  propertiesSchema,
  styleSchema,
} from "../server/validation.mjs";
import { equal, digest } from "../server/sync/protocol.mjs";
import { controlTransaction } from "./data.mjs";
import { assert } from "./access.mjs";
import { saveWorkerSettings } from "./settings.mjs";
import {
  stamp,
  excludedYears,
  settingsFor,
  taskView,
  taskList,
  assignable,
  requireTask,
} from "./task-view.mjs";
export {
  stamp,
  excludedYears,
  settingsFor,
  taskView,
  taskList,
} from "./task-view.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../server/storage/postgres-tasks.mjs";
export async function taskRoutes(ctx, path, method, body, query) {
  if (path === "/tasks" && method === "GET") {
    const result = await new TaskBusinessService(
      new PostgresTaskRepository({ context: ctx }),
      ctx.user,
    ).query(query, { ifNoneMatch: ctx.request.headers.get("if-none-match") });
    if (result.notModified)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: result.etag,
          "X-Cell-Event-ID": result.cellEventId,
          "Cache-Control": "private, no-cache",
        },
      });
    return {
      ...result.data,
      etag: result.etag,
      cellEventId: result.cellEventId,
    };
  }
  if (path === "/tasks" && method === "POST") {
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
        let fields = { title: "새 업무", ...body.fields },
          cells = {},
          documents = [],
          defaultStyle = settings.defaultStyle,
          rowStyle = {},
          position;
        if (body.sourceId) {
          const original = requireTask(await s.get("task", [body.sourceId]));
          const copied = copyRowFormatting(await taskView(s, original));
          ({ cells, defaultStyle, rowStyle } = copied);
          fields = {
            owner: allowed.has(ctx.user.id) ? ctx.user.id : "",
            supporters: [],
            ...body.fields,
          };
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
          fields = { ...body.fields };
        }
        const rows = (await s.list("task"))
          .filter((t) => !t.payload.deletedAt)
          .sort((a, b) => a.payload.position - b.payload.position);
        position = (rows.at(-1)?.payload.position || 0) + 100;
        if (body.insertAt) {
          const target = rows.find((t) => t.key[0] === body.insertAt.taskId);
          assert(
            target && stamp(target) === body.insertAt.updatedAt,
            409,
            "기준 행이 변경되었습니다.",
          );
          const i =
              rows.indexOf(target) +
              (body.insertAt.placement === "after" ? 1 : 0),
            before = rows[i - 1]?.payload.position,
            after = rows[i]?.payload.position;
          position =
            before === undefined
              ? after - 100
              : after === undefined
                ? before + 100
                : (before + after) / 2;
          if (!body.sourceId && !body.copiedRow) {
            const copied = copyRowFormatting(await taskView(s, target));
            defaultStyle = copied.defaultStyle;
            rowStyle = copied.rowStyle;
            for (const [key, c] of Object.entries(copied.cells))
              if (Object.keys(c.style).length)
                cells[key] = {
                  value:
                    fields[key] ??
                    emptyPropertyValue(
                      propertiesFor(settings).find((p) => p.id === key),
                    ),
                  style: c.style,
                };
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
          cells[key] = { value, style: cells[key]?.style || {} };
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
          if (c.value !== "" || Object.keys(c.style || {}).length)
            await s.put("cell", [id, key], {
              value: c.value,
              style: c.style || {},
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
  if (path === "/cells/batch" && method === "POST") {
    return new TaskBusinessService(
      new PostgresTaskRepository({ context: ctx }),
      ctx.user,
    ).saveBatch(body);
  }
  const task = /^\/tasks\/([^/]+)$/.exec(path);
  if (task && method === "PATCH") {
    const { teamId } = await ctx.locate("task", task[1], { write: true });
    return ctx.data(
      teamId,
      async (s) => {
        const row = requireTask(await s.get("task", [task[1]]));
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
  const restore = /^\/tasks\/([^/]+)\/restore$/.exec(path);
  if (
    (task && method === "DELETE") ||
    restore ||
    path === "/tasks/delete" ||
    path === "/tasks/restore"
  ) {
    const restoring = !!restore || path === "/tasks/restore",
      versions = body.tasks || [
        { id: (restore || task)[1], updatedAt: body.updatedAt },
      ],
      { teamId } = await ctx.locate("task", versions[0].id, { write: true });
    return ctx.data(
      teamId,
      async (s) => {
        const updatedAt = {},
          tasks = [];
        for (const v of versions) {
          const row = await s.get("task", [v.id]);
          assert(row && !row.deleted, 404, "업무를 찾을 수 없습니다.");
          assert(
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
        return restoring
          ? restore
            ? { task: tasks[0] }
            : { tasks }
          : { ok: true, updatedAt: task ? updatedAt[task[1]] : updatedAt };
      },
      { write: true, body, action: restoring ? "restore" : "delete" },
    );
  }
  if (path === "/tasks/reorder" && method === "POST") {
    const { teamId } = await ctx.locate("task", body.targetId, { write: true });
    return ctx.data(
      teamId,
      async (s) => {
        const requested = body.tasks || [
            { id: body.taskId, updatedAt: body.updatedAt },
          ],
          rows = (await s.list("task"))
            .filter((r) => !r.payload.deletedAt)
            .sort((a, b) => a.payload.position - b.payload.position),
          ids = new Set(requested.map((r) => r.id));
        assert(
          ids.size === requested.length && !ids.has(body.targetId),
          400,
          "이동할 행을 확인하세요.",
        );
        for (const r of requested)
          assert(
            stamp(rows.find((t) => t.key[0] === r.id)) === r.updatedAt,
            409,
            "업무가 변경되었습니다.",
          );
        const target = rows.find((t) => t.key[0] === body.targetId);
        assert(
          target && stamp(target) === body.targetUpdatedAt,
          409,
          "기준 행이 변경되었습니다.",
        );
        const moving = rows.filter((r) => ids.has(r.key[0])),
          other = rows.filter((r) => !ids.has(r.key[0])),
          i = other.indexOf(target) + (body.placement === "after" ? 1 : 0);
        other.splice(i, 0, ...moving);
        for (const [i, row] of other.entries())
          await s.put("task", row.key, {
            ...row.payload,
            position: (i + 1) * 1000,
          });
        const tasks = await Promise.all(
          moving.map((r) =>
            taskView(s, s.cache.get(JSON.stringify(["task", r.key]))),
          ),
        );
        return { task: tasks[0], tasks };
      },
      { write: true, body, action: "reorder" },
    );
  }
  const teamSettings = /^\/teams\/([^/]+)(\/settings)?$/.exec(path);
  if (teamSettings && method === "PATCH") {
    const id = teamSettings[1];
    await ctx.team(id, { manage: true });
    const people = await controlTransaction(
      ctx.env,
      async (tx) =>
        (
          await tx.query(
            "SELECT u.id,u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1",
            [id],
          )
        ).rows,
    );
    return ctx.data(
      id,
      async (s) => {
        const row = await s.get("team", []);
        assert(row, 409, "팀 공유 설정이 없습니다.");
        if (teamSettings[2]) {
          return { settings: await saveWorkerSettings(s, body, people) };
        }
        assert(
          typeof body.name === "string" &&
            body.name.trim() &&
            body.name.length <= 100,
          400,
          "팀 이름을 확인하세요.",
        );
        if (
          body.theme !== undefined &&
          body.theme !== row.payload.settings?.theme
        ) {
          await saveWorkerSettings(
            s,
            {
              theme: body.theme,
              expectedRevision: body.settingsRevision ?? row.revision,
            },
            people,
          );
        }
        const current = await s.get("team", []);
        const saved = await s.put("team", [], {
          ...current.payload,
          name: body.name.trim(),
        });
        return { team: { id, ...saved.payload } };
      },
      { write: true, body, action: "settings" },
    );
  }
  if (path === "/views" && method === "GET")
    return ctx.data(query.get("teamId"), async (s) => {
      const row = await s.get("view", [
        ctx.user.id,
        String(yearSchema.parse(query.get("year"))),
      ]);
      return {
        views: row
          ? [
              {
                id: digest(row.key),
                name: "__current",
                data: row.payload,
                updatedAt: stamp(row),
              },
            ]
          : [],
      };
    });
  if (path === "/views" && method === "PUT")
    return ctx.data(
      body.teamId,
      async (s) => {
        const data = viewSchema.parse(body.data);
        await s.put(
          "view",
          [ctx.user.id, String(data.year)],
          viewLayout(normalizeView(data, await settingsFor(s))),
          { shared: false },
        );
        return { ok: true };
      },
      { body, write: false },
    );
  return undefined;
}
