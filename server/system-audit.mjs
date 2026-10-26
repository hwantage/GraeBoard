import { AdminHistoryBusinessService } from "./storage/admin-history-service.mjs";
import { SqliteAdminHistoryRepository } from "./storage/sqlite-admin-history.mjs";
export function installSystemAuditRoutes(
  app,
  { db, repository = new SqliteAdminHistoryRepository({ db }) },
) {
  const service = (req) =>
      new AdminHistoryBusinessService(
        typeof repository === "function"
          ? repository(req.user, req)
          : repository,
        req.user,
      ),
    send = (value, res, next) =>
      value?.then
        ? value.then((result) => res.json(result), next)
        : res.json(value);
  app.get("/api/admin/audit", (req, res, next) =>
    send(service(req).audit(req.query), res, next),
  );
  app.get("/api/admin/audit/:id", (req, res, next) =>
    send(service(req).auditEntry(req.params.id), res, next),
  );
}
