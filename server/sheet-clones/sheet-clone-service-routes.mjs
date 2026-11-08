import {
  SHEET_CLONE_ROUTES,
  callBusinessRoute,
} from "../../shared/http/business-routes.js";
import { registerEventRoute } from "../events/event-streams.mjs";
import { SheetCloneBusinessService } from "../storage/sheet-clones/sheet-clone-service.mjs";
export function installSheetCloneServiceRoutes(
  app,
  { repository, documentEvents, refreshUser, cellEvents },
) {
  const service = (req) =>
    new SheetCloneBusinessService(repository, req.user, {
      documentEvents,
      clientId: req.get("X-Client-ID")?.slice(0, 64),
    });
  registerEventRoute(app, "/api/sheet-clones/:id/events", (req, res) => {
    return documentEvents.watch(
      req,
      res,
      "sheet-clone:" + req.params.id,
      (request) => service(request).watch(request.params.id),
    );
  });
  for (const route of SHEET_CLONE_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) =>
      res
        .status(route.status)
        .json(callBusinessRoute(service(req), route, req)),
    );
}
