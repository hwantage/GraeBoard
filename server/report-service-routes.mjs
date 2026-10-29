import { REPORT_ROUTES, callBusinessRoute } from "../shared/business-routes.js";
import { registerEventRoute } from "./event-streams.mjs";
import { ReportBusinessService } from "./storage/report-service.mjs";
export function installReportServiceRoutes(
  app,
  { repository, documentEvents, refreshUser, cellEvents },
) {
  const service = (req) =>
    new ReportBusinessService(repository, req.user, {
      documentEvents,
      clientId: req.get("X-Client-ID")?.slice(0, 64),
    });
  registerEventRoute(app, "/api/reports/:id/events", (req, res) => {
    return documentEvents.watch(
      req,
      res,
      "report:" + req.params.id,
      (request) => service(request).watch(request.params.id),
    );
  });
  for (const route of REPORT_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) =>
      res
        .status(route.status)
        .json(callBusinessRoute(service(req), route, req)),
    );
}
