import { AdminHistoryBusinessService } from "./storage/admin-history-service.mjs";
import { SqliteAdminHistoryRepository } from "./storage/sqlite-admin-history.mjs";
import { validateCellCommandTime } from "./storage/task-service.mjs";
export const CELL_RETRY_DAYS = 7;
export const validateCellRequestTime = validateCellCommandTime;
export function installHistoryCleanupRoutes(
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
  app.get("/api/admin/history-cleanup/storage", (req, res, next) =>
    send(service(req).storage(), res, next),
  );
  app.get("/api/admin/history-cleanup", (req, res, next) =>
    send(service(req).preview(req.query), res, next),
  );
  app.post("/api/admin/history-cleanup", (req, res, next) =>
    send(service(req).cleanup(req.body), res, next),
  );
}
