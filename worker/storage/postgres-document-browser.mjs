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
import { reportView } from "./postgres-reports.mjs";
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
      users = (await ctx.bootstrap()).users;
    return ctx.data(teamId, async (s) => {
      const documents = await s.list("document"),
        reports = (await s.list("report")).filter(
          (r) => r.payload.year === year,
        );
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
      if (kind === "task") {
        const task = tasks.find((t) => t.id === query.taskId);
        assert(task, 404, "업무를 찾을 수 없습니다.");
        return {
          task,
          settings,
          users,
          ...(report
            ? { revision: (await reportView(s, report)).revision }
            : {}),
        };
      }
      const sourceUsers = report?.payload.data.users || users;
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
