import { assert } from "../access.mjs";
import { taskList, settingsFor, excludedYears } from "../task-view.mjs";
import { z } from "zod";
import { yearSchema } from "../../shared/validation.js";
import { hasDocumentContent } from "../../shared/task-documents.js";
import { propertiesFor } from "../../shared/domain.js";
import {
  documentBrowserPage,
  documentPreview,
} from "../../server/storage/document-browser-service.mjs";
import { reportRevision } from "./postgres-reports.mjs";
import { documentKeysUnder } from "./postgres-documents.mjs";
export class PostgresDocumentBrowserRepository {
  constructor({ context }) {
    this.context = context;
  }
  sources(user, query) {
    return this.query(user, "sources", query);
  }
  tasks(user, query) {
    return this.query(user, "tasks", query);
  }
  task(user, query) {
    return this.query(user, "task", query);
  }
  async query(user, kind, query) {
    const ctx = this.context;
    assert(ctx.user.id === user.id, 403, "사용자 저장소 범위를 확인하세요.");
    const teamId = query.teamId,
      year = yearSchema.parse(query.year),
      source = query.source || "live",
      // Only the task pages show people; the source list skips the bootstrap.
      users = kind === "sources" ? null : (await ctx.bootstrap()).users;
    return ctx.data(teamId, async (s) => {
      if ((await excludedYears(s)).has(year)) {
        if (kind === "sources") return { sources: [] };
        if (kind === "tasks")
          return {
            ...documentBrowserPage([], await settingsFor(s), users, query),
            owners: {},
          };
        assert(false, 404, "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.");
      }
      if (kind === "sources") {
        const live = await taskList(s, { year }),
          reports = (await s.list("report")).filter(
            (r) => r.payload.year === year,
          ),
          // Counted from keys, once for every report: no markdown is read.
          counts = new Map();
        for (const key of await documentKeysUnder(s, ["report"])) {
          if (!counts.has(key[1]))
            counts.set(key[1], { tasks: new Set(), documents: 0 });
          const count = counts.get(key[1]);
          count.tasks.add(key[2]);
          count.documents++;
        }
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
                counts.get(r.key[0])?.tasks.has(t.id),
              ).length,
              documentCount: counts.get(r.key[0])?.documents || 0,
            })),
          ],
        };
      }
      const row = source === "live" ? null : await s.get("report", [source]),
        report = row && !row.deleted && row.payload.year === year ? row : null;
      assert(source === "live" || report, 404, "사본을 찾을 수 없습니다.");
      const tasks =
          source === "live"
            ? await taskList(s, { year })
            : report.payload.data.tasks,
        settings = report?.payload.data.settings || (await settingsFor(s));
      if (kind === "task") {
        const task = tasks.find((t) => t.id === query.taskId);
        assert(task, 404, "업무를 찾을 수 없습니다.");
        return {
          task,
          settings,
          users,
          ...(report ? { revision: reportRevision(report.payload.data) } : {}),
        };
      }
      const sourceUsers = report?.payload.data.users || users;
      // The source's documents grouped by task once, not filtered per task.
      const owner = source === "live" ? 1 : 2,
        byTask = new Map();
      for (const d of await s.listChildren(
        "document",
        source === "live" ? ["task"] : ["report", source],
      )) {
        if (!byTask.has(d.key[owner])) byTask.set(d.key[owner], []);
        byTask.get(d.key[owner]).push(d);
      }
      const withDocs = tasks
          .map((task) => ({
            ...task,
            documents: (byTask.get(task.id) || []).map((d) => ({
              id: d.key.at(-1),
              title: d.payload.title,
              hasContent: hasDocumentContent(d.payload.markdown),
              preview: documentPreview(d.payload.markdown),
            })),
          }))
          .filter((t) => t.documents.length),
        pageResult = documentBrowserPage(
          withDocs,
          settings,
          sourceUsers,
          query,
        ),
        page = pageResult.tasks,
        owners = Object.fromEntries(
          [...new Set(page.map((t) => t.ownerId).filter(Boolean))].map((id) => [
            id,
            sourceUsers.find((u) => u.id === id) || { id, name: id },
          ]),
        );
      return { ...pageResult, owners };
    });
  }
}
