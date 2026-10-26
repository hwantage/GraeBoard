import { HistoryBusinessService } from "./storage/history-service.mjs";
export function installHistoryServiceRoutes(app, { repository }) {
  const service = (req) =>
    new HistoryBusinessService(
      typeof repository === "function" ? repository(req.user, req) : repository,
      req.user,
    );
  const send = (value, res, next) =>
    value?.then
      ? value.then((result) => res.json(result), next)
      : res.json(value);
  app.get("/api/audit", (req, res, next) =>
    send(service(req).query(req.query), res, next),
  );
  app.post("/api/audit/:id/restore", (req, res, next) =>
    send(service(req).restore(req.params.id, req.body), res, next),
  );
}
