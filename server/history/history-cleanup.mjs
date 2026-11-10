import {
  HISTORY_CLEANUP_ROUTES,
  callBusinessRoute,
} from "../../shared/http/business-routes.js";
import { AdminHistoryBusinessService } from "../storage/history/admin-history-service.mjs";
import { SqliteAdminHistoryRepository } from "../storage/history/sqlite-admin-history.mjs";
import { validateCellCommandTime } from "../storage/tasks/task-service.mjs";
export const CELL_RETRY_DAYS = 7;
export const validateCellRequestTime = validateCellCommandTime;
export function installHistoryCleanupRoutes(app, { db }) {
  const repository = new SqliteAdminHistoryRepository({ db });
  const service = (req) =>
      new AdminHistoryBusinessService(repository, req.user),
    send = (value, res, next) => res.json(value);
  for (const route of HISTORY_CLEANUP_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) =>
      res
        .status(route.status)
        .json(callBusinessRoute(service(req), route, req)),
    );
}
