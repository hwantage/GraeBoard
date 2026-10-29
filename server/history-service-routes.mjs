import {
  HISTORY_ROUTES,
  callBusinessRoute,
} from "../shared/business-routes.js";
import { HistoryBusinessService } from "./storage/history-service.mjs";
export function installHistoryServiceRoutes(app, { repository }) {
  const service = (req) =>
    new HistoryBusinessService(repository, req.user, {
      clientId: req.get("X-Client-ID")?.slice(0, 64),
    });
  const send = (value, res, next) => res.json(value);
  for (const route of HISTORY_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) =>
      res
        .status(route.status)
        .json(callBusinessRoute(service(req), route, req)),
    );
}
