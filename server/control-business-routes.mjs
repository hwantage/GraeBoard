import { CONTROL_ROUTES } from "../shared/business-routes.js";
import { ControlBusinessService } from "./storage/control-service.mjs";
import { registerEventRoute } from "./event-streams.mjs";

export function installControlBusinessRoutes(
  app,
  { repository, documentEvents, refreshUser, cellEvents, site = "internal" },
) {
  const service = (req) =>
    new ControlBusinessService(repository, req.user, {
      documentEvents,
      clientId: req.get("X-Client-ID")?.slice(0, 64),
    });
  for (const { method, path, name: command, status } of CONTROL_ROUTES)
    app[method.toLowerCase()]("/api" + path, (req, res, next) => {
      try {
        const respond = (value) =>
          res
            .status(status)
            .json(command === "bootstrap" ? { ...value, site } : value);
        const result = service(req).execute(command, req.body, req.params.id);
        respond(result);
      } catch (error) {
        next(error);
      }
    });
  registerEventRoute(app, "/api/teams/:id/events", (req, res) => {
    return documentEvents.watch(req, res, "team:" + req.params.id, (request) =>
      repository.watch(request.user, request.params.id),
    );
  });
}
