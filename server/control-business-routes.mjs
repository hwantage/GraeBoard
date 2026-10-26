import { ControlBusinessService } from "./storage/control-service.mjs";
import { registerEventRoute } from "./event-streams.mjs";

export function installControlBusinessRoutes(
  app,
  { repository, documentEvents, refreshUser, cellEvents },
) {
  const repo = (req) =>
    typeof repository === "function" ? repository(req.user, req) : repository;
  const service = (req) =>
    new ControlBusinessService(repo(req), req.user, { documentEvents });
  for (const [method, path, command, status = 200] of [
    ["get", "/api/bootstrap", "bootstrap"],
    ["patch", "/api/auth/profile", "profile"],
    ["get", "/api/admin/users", "listUsers"],
    ["post", "/api/admin/users", "createUser", 201],
    ["patch", "/api/admin/users/:id", "updateUser"],
    ["get", "/api/teams/:id/members", "members"],
    ["put", "/api/teams/:id/members", "replaceMembers"],
    ["post", "/api/admin/teams", "createTeam", 201],
    ["delete", "/api/admin/teams/:id", "deleteTeam"],
  ])
    app[method](path, (req, res, next) => {
      try {
        const result = service(req).execute(command, req.body, req.params.id);
        if (result && typeof result.then === "function")
          return result
            .then((value) => res.status(status).json(value))
            .catch(next);
        res.status(status).json(result);
      } catch (error) {
        next(error);
      }
    });
  registerEventRoute(app, "/api/teams/:id/events", (req, res) => {
    const selected = repo(req);
    if (selected.subscribe)
      return selected.subscribe(req.user, req.params.id, {
        request: req,
        response: res,
        refreshUser: () => refreshUser(req),
        register: (response) => cellEvents.registerExternal(response),
      });
    return documentEvents.watch(req, res, "team:" + req.params.id, (request) =>
      selected.watch(request.user, request.params.id),
    );
  });
}
