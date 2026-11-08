import {
  CalendarBusinessService,
  matchCalendarRoute,
} from "../../server/storage/calendar/calendar-service.mjs";
import { PostgresCalendarRepository } from "../storage/calendar/postgres-calendar.mjs";
export { entryView } from "../storage/calendar/postgres-calendar.mjs";
export function calendarRoutes(ctx, path, method, body, query) {
  const route = matchCalendarRoute(path, method);
  if (!route) return undefined;
  return new CalendarBusinessService(
    new PostgresCalendarRepository({ context: ctx }),
    ctx.user,
  ).execute(route.name, { params: route.params, body, query });
}
