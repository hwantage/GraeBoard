import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  propertiesFor,
  periodYears,
  emptyPropertyValue,
  normalizeView,
  viewLayout,
  canManageTeam,
  savedFilter,
} from "../shared/domain.js";
import {
  copyRowFormatting,
  normalizeCellStyle,
  scopeMatches,
  scopeKey,
} from "../shared/formatting.js";
import {
  batchSchema,
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
export const stamp = (row) =>
  new Date(Number(row?.revision) || 0).toISOString();
const retentionYears = new WeakMap();
export async function excludedYears(s) {
  if (!retentionYears.has(s))
    retentionYears.set(
      s,
      s.tx
        .query(
          "SELECT r.entity_key FROM site_retention r JOIN team_sync_links l ON l.team_id=r.team_id AND l.installation_id=r.site_id WHERE r.team_id=$1 AND r.kind='year'",
          [s.teamId],
        )
        .then(
          (result) =>
            new Set(
              result.rows.map((row) => Number(JSON.parse(row.entity_key)[0])),
            ),
        ),
    );
  return retentionYears.get(s);
}

export async function settingsFor(s) {
  const row = await s.get("team", []);
  return {
    ...normalizeSettings(row?.payload?.settings || DEFAULT_SETTINGS),
    revision: row?.revision || 0,
  };
}
export async function taskView(s, row, { cells, documents, format } = {}) {
  const id = row.key[0],
    excluded = await excludedYears(s);
  cells ||= await s.list("cell");
  documents ||= await s.list("document");
  format ||= await s.get("formats", []);
  const docs = documents.filter(
    (d) => d.key[0] === "task" && d.key[1] === id && !d.deleted,
  );
  return {
    id,
    teamId: s.teamId,
    ...row.payload,
    years: row.payload.years.filter((year) => !excluded.has(year)),
    updatedAt: stamp(row),
    cells: Object.fromEntries(
      cells
        .filter((c) => c.key[0] === id && !c.deleted)
        .map((c) => [c.key[1], { ...c.payload, version: c.revision }]),
    ),
    documentCount: docs.length,
    hasDocument: docs.some((d) => !!d.payload.markdown.trim()),
    ...(format
      ? {
          formatting: {
            ...format.payload,
            rules: format.payload.rules.filter(
              (rule) => !rule.rows || rule.rows.includes(id),
            ),
            revision: format.revision,
          },
        }
      : {}),
  };
}
export async function taskList(
  s,
  { year, startMonth = 1, deleted = false } = {},
) {
  const excluded = await excludedYears(s);
  if (year && excluded.has(Number(year))) return [];
  const rows = await s.list("task"),
    cells = await s.list("cell"),
    documents = await s.list("document"),
    format = await s.get("formats", []),
    years = year ? periodYears(year, startMonth) : null,
    cellGroups = new Map(),
    docGroups = new Map();
  for (const c of cells) {
    if (!cellGroups.has(c.key[0])) cellGroups.set(c.key[0], []);
    cellGroups.get(c.key[0]).push(c);
  }
  for (const d of documents)
    if (d.key[0] === "task") {
      if (!docGroups.has(d.key[1])) docGroups.set(d.key[1], []);
      docGroups.get(d.key[1]).push(d);
    }
  return Promise.all(
    rows
      .filter(
        (r) =>
          !!r.payload.deletedAt === deleted &&
          r.payload.years.some(
            (y) => !excluded.has(y) && (!years || years.includes(y)),
          ),
      )
      .sort(
        (a, b) =>
          a.payload.position - b.payload.position ||
          a.key[0].localeCompare(b.key[0]),
      )
      .map((r) =>
        taskView(s, r, {
          cells: cellGroups.get(r.key[0]) || [],
          documents: docGroups.get(r.key[0]) || [],
          format,
        }),
      ),
  );
}
async function assignable(ctx, teamId) {
  return controlTransaction(
    ctx.env,
    async (tx) =>
      new Set(
        (
          await tx.query(
            "SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND u.active=TRUE AND m.role IN ('lead','member')",
            [teamId],
          )
        ).rows.map((r) => r.id),
      ),
  );
}
function requireTask(row) {
  assert(
    row && !row.deleted && !row.payload.deletedAt,
    404,
    "업무를 찾을 수 없습니다.",
  );
  return row;
}
function requestTime(createdAt) {
  const at = Date.parse(createdAt);
  assert(
    Number.isFinite(at) && at <= Date.now() + 300000,
    400,
    "요청 생성 시각을 확인하세요.",
  );
  assert(
    Date.now() - at <= 7 * 86400000,
    410,
    "저장 재시도 기간이 지났습니다. 입력을 보관하고 최신 내용을 확인하세요.",
  );
}
export async function taskRoutes(ctx, path, method, body, query) {
  if (path === "/tasks" && method === "GET") {
    const period = periodScopeSchema.parse(Object.fromEntries(query));
    return ctx.data(query.get("teamId"), async (s) => {
      if (query.get("deleted") === "1")
        assert(
          canManageTeam(ctx.user, s.teamId),
          403,
          "팀장만 삭제한 업무를 조회할 수 있습니다.",
        );
      const cellEventId =
          "pg:" +
          Number(
            (
              await s.tx.query(
                "SELECT COALESCE(MAX(cursor),0) AS cursor FROM site_events WHERE team_id=$1",
                [s.teamId],
              )
            ).rows[0].cursor,
          ),
        etag =
          '"' +
          digest([s.teamId, period, query.get("deleted"), cellEventId]) +
          '"';
      if (ctx.request.headers.get("if-none-match") === etag)
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            "X-Cell-Event-ID": cellEventId,
            "Cache-Control": "private, no-cache",
          },
        });
      return {
        etag,
        cellEventId,
        tasks: await taskList(s, {
          ...period,
          deleted: query.get("deleted") === "1",
        }),
        formatting: {
          ...(await s.get("formats", []))?.payload,
          revision: (await s.get("formats", []))?.revision || 0,
        },
      };
    });
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
    const d = batchSchema.parse(body);
    requestTime(d.createdAt);
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
          seen = new Set();
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
            assert(
              previous.version === change.expectedVersion,
              409,
              "다른 사용자가 이 셀을 수정했습니다.",
              {
                taskId: change.taskId,
                key: change.key,
                current: previous,
                attempted: change,
              },
            );
            validateCellValue(
              null,
              teamId,
              change.key,
              change.value,
              settings,
              previous.value,
              allowed,
            );
            if (change.style !== undefined)
              assert(
                (change.expectedFormatRevision ?? 0) ===
                  (format?.revision || 0),
                409,
                "공통 서식이 변경되었습니다.",
              );
            const desired = {
              value: change.value ?? previous.value,
              style:
                change.style === undefined
                  ? previous.style
                  : change.rawStyle
                    ? change.style
                    : normalizeCellStyle(task, change.key, change.style),
            };
            if (
              equal(desired, { value: previous.value, style: previous.style })
            )
              continue;
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
