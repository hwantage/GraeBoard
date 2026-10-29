import {
  REPORT_ROUTES,
  FILTER_ROUTES,
  BROWSER_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
} from "../shared/business-routes.js";

import { assert } from "./access.mjs";

import { documentList } from "./documents.mjs";

import { ReportBusinessService } from "../server/storage/report-service.mjs";
import {
  PostgresReportRepository,
  reportView,
} from "./storage/postgres-reports.mjs";
export { reportView } from "./storage/postgres-reports.mjs";
export async function reportRoutes(ctx, path, method, body, query) {
  const service = new ReportBusinessService(
    new PostgresReportRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(REPORT_ROUTES, path, method);
  if (match)
    return callBusinessRoute(service, match.route, {
      params: match.params,
      body,
      query,
    });
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
import { PostgresFilterRepository } from "./storage/postgres-filters.mjs";
export function filterRoutes(ctx, path, method, body, query) {
  const service = new FilterBusinessService(
    new PostgresFilterRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(FILTER_ROUTES, path, method);
  if (match)
    return callBusinessRoute(service, match.route, {
      params: match.params,
      body,
      query,
    });
  return undefined;
}
import { DocumentBrowserBusinessService } from "../server/storage/document-browser-service.mjs";
import { PostgresDocumentBrowserRepository } from "./storage/postgres-document-browser.mjs";
export function browserRoutes(ctx, path, method, _body, query) {
  const match = matchBusinessRoute(BROWSER_ROUTES, path, method);
  if (!match) return undefined;
  return new DocumentBrowserBusinessService(
    new PostgresDocumentBrowserRepository({ context: ctx }),
    ctx.user,
  ).query(match.route.name, query);
}
