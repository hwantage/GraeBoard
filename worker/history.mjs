import {
  HISTORY_ROUTES,
  HISTORY_CLEANUP_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
} from "../shared/business-routes.js";
import { AdminHistoryBusinessService } from "../server/storage/admin-history-service.mjs";
import { PostgresAdminHistoryRepository } from "./storage/postgres-admin-history.mjs";
import { HistoryBusinessService } from "../server/storage/history-service.mjs";
import { PostgresHistoryRepository } from "./storage/postgres-history.mjs";
export function auditRoutes(ctx, path, method, body, query) {
  const service = new HistoryBusinessService(
    new PostgresHistoryRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(HISTORY_ROUTES, path, method);
  if (match)
    return callBusinessRoute(service, match.route, {
      params: match.params,
      body,
      query,
    });
  return undefined;
}
export async function historyCleanupRoutes(ctx, path, method, body, query) {
  const service = new AdminHistoryBusinessService(
    new PostgresAdminHistoryRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(HISTORY_CLEANUP_ROUTES, path, method);
  if (match)
    return callBusinessRoute(service, match.route, {
      params: match.params,
      body,
      query,
    });
  return undefined;
}
