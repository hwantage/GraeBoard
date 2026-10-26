import { FilterBusinessService } from "./storage/filter-service.mjs";
import { SqliteFilterRepository } from "./storage/sqlite-filters.mjs";
export { filtersFor, currentFiltersFor } from "./storage/sqlite-filters.mjs";
export function installFilterRoutes(app, options) {
  const repository =
    typeof options.repository === "object"
      ? options.repository
      : new SqliteFilterRepository(options);
  app.locals.filterRepository = repository;
  for (const [verb, path, command] of [
    ["get", "/api/filters", "list"],
    ["put", "/api/filters/current", "current"],
    ["put", "/api/filters", "save"],
    ["patch", "/api/filters/:id", "update"],
    ["delete", "/api/filters/:id", "remove"],
  ])
    app[verb](path, (req, res) => {
      const selected =
          typeof options.repository === "function"
            ? options.repository(req.user, req)
            : repository,
        service = new FilterBusinessService(selected, req.user),
        args =
          command === "list"
            ? [req.query]
            : command === "remove"
              ? [req.params.id]
              : command === "update"
                ? [req.params.id, req.body]
                : [req.body],
        value = service[command](...args);
      const done = (result) => {
        if (verb !== "get")
          for (const key of selected.resourceChanges?.() || [])
            options.documentEvents?.invalidate(
              key,
              req.get("X-Client-ID")?.slice(0, 64),
            );
        return res.json(result);
      };
      return value?.then ? value.then(done) : done(value);
    });
}
