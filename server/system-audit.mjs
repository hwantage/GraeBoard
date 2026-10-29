import {
  SYSTEM_AUDIT_ROUTES,
  callBusinessRoute,
} from "../shared/business-routes.js";
import { AdminHistoryBusinessService } from "./storage/admin-history-service.mjs";
import { SqliteAdminHistoryRepository } from "./storage/sqlite-admin-history.mjs";
export function installSystemAuditRoutes(app, { db }) {
  const repository = new SqliteAdminHistoryRepository({ db });
  const service = (req) =>
      new AdminHistoryBusinessService(repository, req.user),
    send = (value, res, next) => res.json(value);
  for (const route of SYSTEM_AUDIT_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) =>
      res
        .status(route.status)
        .json(callBusinessRoute(service(req), route, req)),
    );
}
