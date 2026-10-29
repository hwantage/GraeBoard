import {
  SETTINGS_ROUTES,
  callBusinessRoute,
} from "../shared/business-routes.js";
import { SettingsBusinessService } from "./storage/settings-service.mjs";
import { SqliteSettingsRepository } from "./storage/sqlite-settings.mjs";
export { saveSettings } from "./storage/sqlite-settings.mjs";
export function installSettingsRoutes(app, options) {
  const repository = new SqliteSettingsRepository(options);
  app.locals.settingsRepository = repository;
  for (const route of SETTINGS_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) => {
      const selected = repository;
      const value = callBusinessRoute(
        new SettingsBusinessService(selected, req.user),
        route,
        req,
      );
      const done = (result) => {
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
