import {
  SHEET_CLONE_ROUTES,
  FILTER_ROUTES,
  BROWSER_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
} from "../../shared/http/business-routes.js";

import { assert } from "../control/access.mjs";

import { documentListsUnder } from "../documents/documents.mjs";

import { SheetCloneBusinessService } from "../../server/storage/sheet-clones/sheet-clone-service.mjs";
import {
  PostgresSheetCloneRepository,
  sheetCloneView,
} from "../storage/sheet-clones/postgres-sheet-clones.mjs";
export { sheetCloneView } from "../storage/sheet-clones/postgres-sheet-clones.mjs";
export async function sheetCloneRoutes(ctx, path, method, body, query) {
  const service = new SheetCloneBusinessService(
    new PostgresSheetCloneRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(SHEET_CLONE_ROUTES, path, method);
  if (match)
    return callBusinessRoute(service, match.route, {
      params: match.params,
      body,
      query,
    });
  const batch = /^\/sheet-clones\/([^/]+)\/documents\/batch$/.exec(path);
  if (batch && method === "POST") {
    const teamId = await ctx.locateTeam("sheetClone", batch[1]);
    assert(
      Array.isArray(body.taskIds) &&
        body.taskIds.length > 0 &&
        body.taskIds.length <= 100,
      400,
      "사본 업무 목록을 확인하세요.",
    );
    return ctx.data(teamId, async (s) => {
      // The requested rows and their documents, not the copy or its others.
      const rows = await s.copyRowsAmong(batch[1], body.taskIds),
        documents = await documentListsUnder(
          s,
          ["sheetClone", batch[1]],
          "sheetClone",
          { owners: new Set(body.taskIds) },
        ),
        tasks = [];
      for (const id of body.taskIds) {
        assert(rows.has(id), 404, "사본 업무를 찾을 수 없습니다.");
        tasks.push({
          id,
          documents: await documents.list(id, { content: "stored" }),
        });
      }
      return { tasks };
    });
  }
  return undefined;
}
import { FilterBusinessService } from "../../server/storage/settings/filter-service.mjs";
import { PostgresFilterRepository } from "../storage/settings/postgres-filters.mjs";
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
import { DocumentBrowserBusinessService } from "../../server/storage/documents/document-browser-service.mjs";
import { PostgresDocumentBrowserRepository } from "../storage/documents/postgres-document-browser.mjs";
export function browserRoutes(ctx, path, method, _body, query) {
  const match = matchBusinessRoute(BROWSER_ROUTES, path, method);
  if (!match) return undefined;
  return new DocumentBrowserBusinessService(
    new PostgresDocumentBrowserRepository({ context: ctx }),
    ctx.user,
  ).query(match.route.name, query);
}
