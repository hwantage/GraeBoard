import { z } from "zod";
import { applyReportOperation } from "../shared/report-editing.js";
import {
  propertiesFor,
  normalizeView,
  savedFilter,
  canManageTeam,
  filteredTasks,
  defaultView,
  groupValue,
  displayValue,
} from "../shared/domain.js";
import {
  reportNameSchema,
  dateSchema,
  yearSchema,
  viewSchema,
  validateCellValue,
  savedFilterSchema,
} from "../server/validation.mjs";
import { digest, equal } from "../server/sync/protocol.mjs";
import { assert } from "./access.mjs";
import { settingsFor, taskList, taskView, stamp } from "./tasks.mjs";
import { documentList } from "./documents.mjs";
import { controlTransaction } from "./data.mjs";
import { userRecord } from "./control.mjs";
const revision = (data) =>
  digest({
    ...data,
    tasks: data.tasks.map(
      ({ documents, hasDocument, documentCount, ...task }) => task,
    ),
  });
export async function reportView(s, row) {
  const p = row.payload,
    data = p.data;
  const tasks = [];
  for (const task of data.tasks) {
    const documents = await documentList(s, {
      prefix: ["report", row.key[0], task.id],
      kind: "report",
    });
    tasks.push({
      ...task,
      documentCount: documents.length,
      hasDocument: documents.some((d) => d.hasContent),
    });
  }
  return {
    id: row.key[0],
    name: p.name,
    year: p.year,
    referenceDate: p.referenceDate,
    createdAt: p.createdAt,
    ...data,
    tasks,
    revision: revision(data),
  };
}
export async function reportRoutes(ctx, path, method, body, query) {
  if (path === "/reports" && method === "GET")
    return ctx.data(query.get("teamId"), async (s) => ({
      reports: (await s.list("report"))
        .sort((a, b) => b.payload.createdAt.localeCompare(a.payload.createdAt))
        .map((r) => ({
          id: r.key[0],
          name: r.payload.name,
          year: r.payload.year,
          referenceDate: r.payload.referenceDate,
          createdAt: r.payload.createdAt,
          author: r.payload.createdBy,
        })),
    }));
  if (path === "/reports" && method === "POST") {
    const teamId = body.teamId,
      id = body.id || crypto.randomUUID(),
      name = reportNameSchema.parse(body.name),
      year = yearSchema.parse(body.year),
      people = (await ctx.bootstrap()).users
        .filter((u) => u.teamIds?.includes(teamId) || u.id === ctx.user.id)
        .map(({ id, name }) => ({ id, name }));
    dateSchema.parse(body.referenceDate);
    viewSchema.parse(body.view);
    return ctx.data(
      teamId,
      async (s) => {
        const exists = await s.get("report", [id]);
        if (exists) {
          assert(
            exists.payload.name === name &&
              exists.payload.createdBy === ctx.user.id,
            409,
            "사본 생성 요청이 변경되었습니다.",
          );
          return { id };
        }
        assert(
          !(await s.list("report")).some((r) => r.payload.name === name),
          409,
          "같은 이름의 사본이 있습니다.",
        );
        const source = body.sourceId
          ? await s.get("report", [body.sourceId])
          : null;
        assert(
          !body.sourceId || (source && !source.deleted),
          404,
          "사본을 찾을 수 없습니다.",
        );
        let data;
        if (source) data = structuredClone(source.payload.data);
        else {
          const selected = new Set(body.taskIds || []),
            tasks = (
              await taskList(s, { year, startMonth: body.view.startMonth })
            ).filter((t) => selected.has(t.id));
          assert(
            tasks.length === selected.size,
            409,
            "일부 업무가 변경되었습니다.",
          );
          data = {
            tasks,
            users: [
              ...new Map(
                [
                  ...(await s.list("person")).map((r) => ({
                    id: r.key[0],
                    name: r.payload.name,
                  })),
                  ...people,
                ].map((u) => [u.id, u]),
              ).values(),
            ],
            view: body.view,
            settings: await settingsFor(s),
          };
        }
        const docs = await s.list("document");
        for (const task of data.tasks) {
          const prefix = source
              ? ["report", body.sourceId, task.id]
              : ["task", task.id],
            sourceDocs = docs.filter((d) =>
              prefix.every((v, i) => d.key[i] === v),
            );
          task.documents = sourceDocs.map((d) => ({
            id: d.key.at(-1),
            title: d.payload.title,
          }));
          for (const doc of sourceDocs)
            await s.put(
              "document",
              ["report", id, task.id, doc.key.at(-1)],
              doc.payload,
            );
        }
        for (const memo of docs.filter((d) =>
          source
            ? d.key[0] === "reportMemo" && d.key[1] === body.sourceId
            : d.key[0] === "annual" && d.key[1] === String(year),
        ))
          await s.put(
            "document",
            ["reportMemo", id, memo.key.at(-1)],
            memo.payload,
          );
        await s.put("report", [id], {
          year: source?.payload.year || year,
          name,
          referenceDate: body.referenceDate,
          createdBy: ctx.user.id,
          createdAt: new Date().toISOString(),
          data,
        });
        return { id };
      },
      { write: true, body, action: "report" },
    );
  }
  if (path === "/reports" && method === "DELETE")
    return ctx.data(
      body.teamId,
      async (s) => {
        assert(
          Array.isArray(body.ids) &&
            body.ids.length > 0 &&
            body.ids.length <= 20000,
          400,
          "사본 목록을 확인하세요.",
        );
        for (const id of body.ids) {
          const row = await s.get("report", [id]);
          assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
          for (const doc of await s.list("document"))
            if (
              ["report", "reportMemo"].includes(doc.key[0]) &&
              doc.key[1] === id
            )
              await s.put("document", doc.key, doc.payload, { deleted: true });
          await s.put("report", row.key, row.payload, { deleted: true });
        }
        return { ok: true };
      },
      { write: true, body, action: "report-delete" },
    );
  const match = /^\/reports\/([^/]+)(\/name)?$/.exec(path);
  if (match) {
    const { teamId } = await ctx.locate("report", match[1], {
      write: method !== "GET",
    });
    return ctx.data(
      teamId,
      async (s) => {
        const row = await s.get("report", [match[1]]);
        assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
        if (method === "GET") return reportView(s, row);
        if (match[2]) {
          const name = reportNameSchema.parse(body.name);
          assert(
            row.payload.name === body.expectedName || row.payload.name === name,
            409,
            "사본 이름이 변경되었습니다.",
          );
          assert(
            !(await s.list("report")).some(
              (r) => r.key[0] !== match[1] && r.payload.name === name,
            ),
            409,
            "같은 이름의 사본이 있습니다.",
          );
          await s.put("report", row.key, { ...row.payload, name });
          return { id: row.key[0], name };
        }
        assert(
          body.revision === revision(row.payload.data),
          409,
          "다른 사용자가 사본을 수정했습니다. 입력은 유지됩니다.",
        );
        assert(
          Array.isArray(body.operations) && body.operations.length <= 1000,
          400,
          "사본 변경 요청을 확인하세요.",
        );
        const data = structuredClone(row.payload.data),
          allowed = new Set((data.users || []).map((u) => u.id));
        let tasks = data.tasks;
        for (const op of body.operations) {
          assert(
            [
              "cells",
              "format",
              "create",
              "delete",
              "reorder",
              "restore",
            ].includes(op.kind),
            400,
            "지원하지 않는 사본 변경입니다.",
          );
          assert(
            Number.isFinite(Date.parse(op.at)),
            400,
            "변경 시각을 확인하세요.",
          );
          if (op.kind === "cells")
            for (const c of op.changes) {
              const task = tasks.find((t) => t.id === c.taskId);
              assert(task, 400, "사본 업무를 찾을 수 없습니다.");
              validateCellValue(
                null,
                teamId,
                c.key,
                c.value,
                data.settings,
                task.cells[c.key]?.value,
                allowed,
              );
            }
          if (op.kind === "create")
            for (const [key, value] of Object.entries(op.fields || {}))
              validateCellValue(
                null,
                teamId,
                key,
                value,
                data.settings,
                undefined,
                allowed,
              );
          try {
            tasks = applyReportOperation(tasks, op, {
              teamId,
              year: body.view?.year || row.payload.year,
              actorId: ctx.user.id,
              settings: data.settings,
            });
          } catch (error) {
            throw Object.assign(error, { status: 400 });
          }
        }
        for (const task of tasks)
          for (const doc of task.documents || [])
            if (typeof doc.markdown === "string")
              await s.put("document", ["report", row.key[0], task.id, doc.id], {
                title: doc.title,
                position: (task.documents || []).indexOf(doc),
                markdown: doc.markdown,
              });
        data.tasks = tasks.map((t) => ({
          ...t,
          documents: (t.documents || []).map((d) => ({
            id: d.id,
            title: d.title,
          })),
        }));
        if (body.view) data.view = viewSchema.parse(body.view);
        const saved = await s.put("report", row.key, { ...row.payload, data });
        return reportView(s, saved);
      },
      { write: method !== "GET", body, action: "report-edit" },
    );
  }
  const batch = /^\/reports\/([^/]+)\/documents\/batch$/.exec(path);
  if (batch && method === "POST") {
    const { teamId } = await ctx.locate("report", batch[1]);
    assert(
      Array.isArray(body.taskIds) &&
        body.taskIds.length > 0 &&
        body.taskIds.length <= 100,
      400,
      "사본 업무 목록을 확인하세요.",
    );
    return ctx.data(teamId, async (s) => {
      const report = await s.get("report", [batch[1]]),
        tasks = [];
      for (const id of body.taskIds) {
        assert(
          report.payload.data.tasks.some((t) => t.id === id),
          404,
          "사본 업무를 찾을 수 없습니다.",
        );
        tasks.push({
          id,
          documents: await documentList(
            s,
            { prefix: ["report", batch[1], id], kind: "report" },
            { content: true },
          ),
        });
      }
      return { tasks };
    });
  }
  return undefined;
}
async function filterRows(s, user, settings) {
  const shared = (await s.list("filter")).map((r) => ({ ...r, scope: "team" })),
    own = (await s.list("personalFilter"))
      .filter((r) => r.key[1] === user.id)
      .map((r) => ({ ...r, scope: "personal" }));
  return [...shared, ...own].map((r) => ({
    id: r.key[0],
    name: r.payload.name,
    scope: r.scope,
    canEdit: r.scope === "personal" || canManageTeam(user, s.teamId),
    data: savedFilter(r.payload.data, settings),
    updatedAt: stamp(r),
  }));
}
export async function filterRoutes(ctx, path, method, body, query) {
  if (path === "/filters" && method === "GET")
    return ctx.data(query.get("teamId"), async (s) => {
      const settings = await settingsFor(s),
        filters = await filterRows(s, ctx.user, settings),
        row = await s.get("filterState", [ctx.user.id]),
        selected = filters.find((f) => f.id === row?.payload.selectedId);
      return {
        filters,
        current: {
          selectedId: selected?.id || "",
          data:
            selected?.data || savedFilter(row?.payload.data || {}, settings),
        },
      };
    });
  if (path === "/filters/current" && method === "PUT")
    return ctx.data(body.teamId, async (s) => {
      const settings = await settingsFor(s),
        filters = await filterRows(s, ctx.user, settings);
      assert(
        !body.selectedId || filters.some((f) => f.id === body.selectedId),
        404,
        "필터를 찾을 수 없습니다.",
      );
      await s.put(
        "filterState",
        [ctx.user.id],
        {
          selectedId: body.selectedId || "",
          data: savedFilter(savedFilterSchema.parse(body.data), settings),
        },
        { shared: false },
      );
      return { ok: true };
    });
  if (path === "/filters" && method === "PUT") {
    await ctx.team(body.teamId);
    assert(
      ["team", "personal"].includes(body.scope),
      400,
      "필터 공개 범위를 확인하세요.",
    );
    if (body.scope === "team")
      assert(
        canManageTeam(ctx.user, body.teamId),
        403,
        "팀장만 공용 필터를 저장할 수 있습니다.",
      );
    return ctx.data(
      body.teamId,
      async (s) => {
        const settings = await settingsFor(s),
          name = z.string().trim().min(1).max(60).parse(body.name),
          filters = await filterRows(s, ctx.user, settings),
          old = filters.find((f) => f.scope === body.scope && f.name === name),
          id = old?.id || crypto.randomUUID();
        await s.put(
          body.scope === "team" ? "filter" : "personalFilter",
          body.scope === "team" ? [id] : [id, ctx.user.id],
          {
            name,
            data: savedFilter(savedFilterSchema.parse(body.data), settings),
          },
        );
        return { ok: true };
      },
      { write: body.scope === "team", body, action: "filter" },
    );
  }
  const m = /^\/filters\/([^/]+)$/.exec(path);
  if (m) {
    let found;
    for (const team of await ctx.teams()) {
      if (team.status !== "active") continue;
      const row = await ctx.data(
        team.id,
        async (s) =>
          (await s.get("filter", [m[1]])) ||
          (await s.get("personalFilter", [m[1], ctx.user.id])),
      );
      if (row && !row.deleted) {
        found = { teamId: team.id, row };
        break;
      }
    }
    assert(found, 404, "필터를 찾을 수 없습니다.");
    const shared = found.row.entity === "filter";
    assert(
      !shared || canManageTeam(ctx.user, found.teamId),
      403,
      "팀장만 공용 필터를 바꿀 수 있습니다.",
    );
    return ctx.data(
      found.teamId,
      async (s) => {
        const row = await s.get(found.row.entity, found.row.key);
        if (method === "DELETE")
          await s.put(row.entity, row.key, row.payload, { deleted: true });
        else {
          const name =
              body.name === undefined
                ? row.payload.name
                : z.string().trim().min(1).max(60).parse(body.name),
            settings = await settingsFor(s);
          assert(
            !(await filterRows(s, ctx.user, settings)).some(
              (f) =>
                f.id !== m[1] &&
                f.scope === (shared ? "team" : "personal") &&
                f.name === name,
            ),
            409,
            "같은 이름의 필터가 있습니다.",
          );
          await s.put(row.entity, row.key, {
            name,
            data:
              body.data === undefined
                ? row.payload.data
                : savedFilter(savedFilterSchema.parse(body.data), settings),
          });
        }
        return { ok: true };
      },
      { write: shared, body, action: "filter" },
    );
  }
  return undefined;
}
export async function browserRoutes(ctx, path, method, _body, query) {
  if (!path.startsWith("/document-browser/") || method !== "GET")
    return undefined;
  const teamId = query.get("teamId"),
    year = yearSchema.parse(query.get("year")),
    source = query.get("source") || "live",
    users = (await ctx.bootstrap()).users;
  return ctx.data(teamId, async (s) => {
    const documents = await s.list("document"),
      reports = (await s.list("report")).filter((r) => r.payload.year === year);
    if (path.endsWith("/sources")) {
      const live = await taskList(s, { year });
      return {
        sources: [
          {
            id: "live",
            name: "원본",
            taskCount: live.filter((t) => t.documentCount).length,
            documentCount: live.reduce((sum, t) => sum + t.documentCount, 0),
          },
          ...reports.map((r) => ({
            id: r.key[0],
            name: r.payload.name,
            taskCount: r.payload.data.tasks.filter((t) =>
              documents.some(
                (d) =>
                  d.key[0] === "report" &&
                  d.key[1] === r.key[0] &&
                  d.key[2] === t.id,
              ),
            ).length,
            documentCount: documents.filter(
              (d) => d.key[0] === "report" && d.key[1] === r.key[0],
            ).length,
          })),
        ],
      };
    }
    const report =
      source === "live" ? null : reports.find((r) => r.key[0] === source);
    assert(source === "live" || report, 404, "사본을 찾을 수 없습니다.");
    const tasks =
        source === "live"
          ? await taskList(s, { year })
          : report.payload.data.tasks,
      settings = report?.payload.data.settings || (await settingsFor(s));
    if (path.endsWith("/task")) {
      const task = tasks.find((t) => t.id === query.get("taskId"));
      assert(task, 404, "업무를 찾을 수 없습니다.");
      return {
        task,
        settings,
        users,
        ...(report ? { revision: revision(report.payload.data) } : {}),
      };
    }
    const q = (query.get("q") || "").trim().toLowerCase(),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(query.get("offset") || 0),
      limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(query.get("limit") || 40),
      groupBy = propertiesFor(settings).some(
        (p) => p.id === query.get("groupBy"),
      )
        ? query.get("groupBy")
        : "",
      sourceUsers = report?.payload.data.users || users;
    const withDocs = tasks
        .map((task) => ({
          ...task,
          documents: documents
            .filter((d) =>
              source === "live"
                ? d.key[0] === "task" && d.key[1] === task.id
                : d.key[0] === "report" &&
                  d.key[1] === source &&
                  d.key[2] === task.id,
            )
            .map((d) => ({
              id: d.key.at(-1),
              title: d.payload.title,
              hasContent: !!d.payload.markdown,
              preview: d.payload.markdown.replace(/\s+/g, " ").slice(0, 240),
            })),
        }))
        .filter((t) => t.documents.length),
      ordered = filteredTasks(
        withDocs,
        { ...defaultView(year), groupBy },
        settings,
        sourceUsers,
      ),
      groups = new Map(),
      matched = [];
    let documentCount = 0,
      matchedDocumentCount = 0;
    for (const task of ordered) {
      const key = groupBy ? groupValue(task, groupBy) : "",
        label = groupBy
          ? displayValue(task, groupBy, sourceUsers, settings) || "미입력"
          : "전체";
      if (!groups.has(key))
        groups.set(key, {
          key,
          label,
          taskCount: 0,
          documentCount: 0,
          matchedTaskCount: 0,
          matchedDocumentCount: 0,
        });
      const group = groups.get(key),
        title = String(task.cells.title?.value || "제목 없는 업무");
      group.taskCount++;
      group.documentCount += task.documents.length;
      documentCount += task.documents.length;
      if (!title.toLowerCase().includes(q)) continue;
      group.matchedTaskCount++;
      group.matchedDocumentCount += task.documents.length;
      matchedDocumentCount += task.documents.length;
      matched.push({
        id: task.id,
        title,
        ownerId: String(task.cells.owner?.value || ""),
        groupKey: key,
        documentCount: task.documents.length,
        documents: task.documents,
      });
    }
    const page = matched.slice(offset, offset + limit),
      owners = Object.fromEntries(
        [...new Set(page.map((t) => t.ownerId).filter(Boolean))].map((id) => [
          id,
          sourceUsers.find((u) => u.id === id) || { id, name: id },
        ]),
      );
    return {
      tasks: page,
      owners,
      groups: [...groups.values()],
      taskCount: ordered.length,
      documentCount,
      matchedTaskCount: matched.length,
      matchedDocumentCount,
      nextOffset: offset + limit < matched.length ? offset + limit : null,
      properties: propertiesFor(settings).map(({ id, name }) => ({ id, name })),
    };
  });
}
