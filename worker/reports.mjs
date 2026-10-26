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
import { ReportBusinessService } from "../server/storage/report-service.mjs";
import {
  PostgresReportRepository,
  reportView,
} from "../server/storage/postgres-reports.mjs";
export { reportView } from "../server/storage/postgres-reports.mjs";
export async function reportRoutes(ctx, path, method, body, query) {
  const service = new ReportBusinessService(
    new PostgresReportRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/reports" && method === "GET")
    return service.list(Object.fromEntries(query));
  if (path === "/reports" && method === "POST") return service.create(body);
  if (path === "/reports" && method === "DELETE") return service.remove(body);
  const item = /^\/reports\/([^/]+)(\/name)?$/.exec(path);
  if (item && method === "GET" && !item[2]) return service.read(item[1]);
  if (item && method === "PATCH")
    return item[2]
      ? service.rename(item[1], body)
      : service.edit(item[1], body);
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
import { FilterBusinessService } from "../server/storage/filter-service.mjs";
import { PostgresFilterRepository } from "../server/storage/postgres-filters.mjs";
export function filterRoutes(ctx, path, method, body, query) {
  const service = new FilterBusinessService(
    new PostgresFilterRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/filters" && method === "GET") return service.list(query);
  if (path === "/filters/current" && method === "PUT")
    return service.current(body);
  if (path === "/filters" && method === "PUT") return service.save(body);
  const match = /^\/filters\/([^/]+)$/.exec(path);
  if (match && method === "PATCH") return service.update(match[1], body);
  if (match && method === "DELETE") return service.remove(match[1]);
  return undefined;
}
import { DocumentBrowserBusinessService } from "../server/storage/document-browser-service.mjs";
import { PostgresDocumentBrowserRepository } from "../server/storage/postgres-document-browser.mjs";
export function browserRoutes(ctx, path, method, _body, query) {
  const match = /^\/document-browser\/(sources|tasks|task)$/.exec(path);
  if (!match || method !== "GET") return undefined;
  return new DocumentBrowserBusinessService(
    new PostgresDocumentBrowserRepository({ context: ctx }),
    ctx.user,
  ).query(match[1], query);
}
