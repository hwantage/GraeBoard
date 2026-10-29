import { FILTER_ROUTES, callBusinessRoute } from "../shared/business-routes.js";
import { FilterBusinessService } from "./storage/filter-service.mjs";
import { SqliteFilterRepository } from "./storage/sqlite-filters.mjs";
export { filtersFor, currentFiltersFor } from "./storage/sqlite-filters.mjs";
export function installFilterRoutes(app, options) {
  const repository = new SqliteFilterRepository(options);
  app.locals.filterRepository = repository;
  for (const route of FILTER_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) => {
      const selected = repository,
        service = new FilterBusinessService(selected, req.user),
        value = callBusinessRoute(service, route, req);
      const done = (result) => {
        if (route.method !== "GET")
          for (const key of selected.resourceChanges?.() || [])
            options.documentEvents?.invalidate(
              key,
              req.get("X-Client-ID")?.slice(0, 64),
            );
        return res.json(result);
      };
      return done(value);
    });
}
