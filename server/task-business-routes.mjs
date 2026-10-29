import { registerEventRoute } from "./event-streams.mjs";
import {
  TASK_ROUTES,
  callBusinessRoute,
  taskRouteResult,
} from "../shared/business-routes.js";
// SQLite command execution remains synchronous inside the HTTP boundary.
export function installTaskBusinessRoutes(
  app,
  { service, cellEvents, refreshUser, sessionHash },
) {
  app.get(
    "/api" + TASK_ROUTES.find((route) => route.name === "query").path,
    (req, res, next) => {
      const send = (result) => {
        res.set("ETag", result.etag);
        res.set("X-Cell-Event-ID", result.cellEventId);
        res.vary("Accept-Encoding");
        if (result.notModified) return res.status(304).end();
        if (result.data) return res.json(result.data);
        const cached = result.encoded;
        res.type("application/json");
        if (req.acceptsEncodings("gzip")) {
          res.set("Content-Encoding", "gzip");
          return res.send(cached.gzip);
        }
        return res.send(cached.body);
      };
      const result = service(req).query(req.query, {
        ifNoneMatch: req.get("If-None-Match"),
      });
      send(result);
    },
  );
  registerEventRoute(app, "/api/cells/events", (req, res) => {
    return service(req).subscribe(req.query, {
      request: req,
      response: res,
      token: sessionHash(req.cookies.weekly_session),
      refreshUser: () => refreshUser(req),
      register: cellEvents.registerExternal,
    });
  });

  app.post(
    "/api" + TASK_ROUTES.find((route) => route.name === "saveBatch").path,
    (req, res, next) => {
      const result = service(req).saveBatch(req.body);
      res.json(result);
    },
  );

  for (const route of TASK_ROUTES) {
    if (["query", "saveBatch"].includes(route.name)) continue;
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) => {
      const result = callBusinessRoute(service(req), route, req);
      return res
        .status(route.status)
        .json(taskRouteResult(route.name, result, req.params.id));
    });
  }
}
