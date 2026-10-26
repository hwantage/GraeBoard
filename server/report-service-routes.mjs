import { registerEventRoute } from "./event-streams.mjs";
import { ReportBusinessService } from "./storage/report-service.mjs";
export function installReportServiceRoutes(
  app,
  { repository, documentEvents, refreshUser, cellEvents },
) {
  const service = (req) =>
    new ReportBusinessService(
      typeof repository === "function" ? repository(req.user, req) : repository,
      req.user,
      { documentEvents },
    );
  const reply = (result, res, next, status = 200) =>
    result && typeof result.then === "function"
      ? result.then((data) => res.status(status).json(data), next)
      : res.status(status).json(result);
  registerEventRoute(app, "/api/reports/:id/events", (req, res) => {
    const source = service(req);
    if (source.repository.subscribe)
      return source.repository.subscribe(req.user, req.params.id, {
        request: req,
        response: res,
        refreshUser: () => refreshUser(req),
        register: (response) => cellEvents.registerExternal(response),
      });
    return documentEvents.watch(
      req,
      res,
      "report:" + req.params.id,
      (request) => service(request).watch(request.params.id),
    );
  });
  app.get("/api/reports", (req, res, next) =>
    reply(service(req).list(req.query), res, next),
  );
  app.post("/api/reports", (req, res, next) =>
    reply(service(req).create(req.body), res, next, 201),
  );
  app.delete("/api/reports", (req, res, next) =>
    reply(service(req).remove(req.body), res, next),
  );
  app.get("/api/reports/:id", (req, res, next) =>
    reply(service(req).read(req.params.id), res, next),
  );
  app.patch("/api/reports/:id/name", (req, res, next) =>
    reply(service(req).rename(req.params.id, req.body), res, next),
  );
  app.patch("/api/reports/:id", (req, res, next) =>
    reply(service(req).edit(req.params.id, req.body), res, next),
  );
}
