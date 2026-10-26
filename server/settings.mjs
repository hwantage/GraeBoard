import { SettingsBusinessService } from "./storage/settings-service.mjs";
import { SqliteSettingsRepository } from "./storage/sqlite-settings.mjs";
export { saveSettings } from "./storage/sqlite-settings.mjs";
export function installSettingsRoutes(app, options) {
  const repository =
    typeof options.repository === "object"
      ? options.repository
      : new SqliteSettingsRepository(options);
  app.locals.settingsRepository = repository;
  for (const [path, method] of [
    ["/api/teams/:id/settings", "save"],
    ["/api/teams/:id", "general"],
  ])
    app.patch(path, (req, res) => {
      const selected =
        typeof options.repository === "function"
          ? options.repository(req.user, req)
          : repository;
      const value = new SettingsBusinessService(selected, req.user)[method](
        req.params.id,
        req.body,
      );
      const done = (result) => {
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
