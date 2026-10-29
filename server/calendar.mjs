import {
  CalendarBusinessService,
  CALENDAR_ROUTES,
} from "./storage/calendar-service.mjs";
import { SqliteCalendarRepository } from "./storage/sqlite-calendar.mjs";
export function installCalendarRoutes(app, options) {
  const repository = new SqliteCalendarRepository(options);
  app.locals.calendarRepository = repository;
  for (const route of CALENDAR_ROUTES)
    app[route.method.toLowerCase()]("/api" + route.path, (req, res) => {
      const selected = repository;
      const value = new CalendarBusinessService(selected, req.user).execute(
        route.name,
        { params: req.params, body: req.body, query: req.query },
      );
      const send = (result) => {
        if (route.method !== "GET" && selected.resourceChanges)
          for (const key of selected.resourceChanges())
            options.documentEvents?.invalidate(
              key,
              req.get("X-Client-ID")?.slice(0, 64),
            );
        return res.status(route.status).json(result);
      };
      return send(value);
    });
  return {
    calendarImageAccess: repository.calendarImageAccess,
    calendarDocumentAccess: repository.calendarDocumentAccess,
  };
}
