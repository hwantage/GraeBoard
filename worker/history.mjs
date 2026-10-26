import { AdminHistoryBusinessService } from "../server/storage/admin-history-service.mjs";
import { PostgresAdminHistoryRepository } from "../server/storage/postgres-admin-history.mjs";
import { HistoryBusinessService } from "../server/storage/history-service.mjs";
import { PostgresHistoryRepository } from "../server/storage/postgres-history.mjs";
export function auditRoutes(ctx, path, method, body, query) {
  const service = new HistoryBusinessService(
    new PostgresHistoryRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/audit" && method === "GET") return service.query(query);
  const match = /^\/audit\/([^/]+)\/restore$/.exec(path);
  if (match && method === "POST") return service.restore(match[1], body);
  return undefined;
}
export async function historyCleanupRoutes(ctx, path, method, body, query) {
  const service = new AdminHistoryBusinessService(
    new PostgresAdminHistoryRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/admin/history-cleanup/storage" && method === "GET")
    return service.storage();
  if (path === "/admin/history-cleanup" && method === "GET")
    return service.preview(query);
  if (path === "/admin/history-cleanup" && method === "POST")
    return service.cleanup(body);
  return undefined;
}
