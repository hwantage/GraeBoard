import {
  TASK_ROUTES,
  SETTINGS_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
  taskRouteResult,
} from "../shared/business-routes.js";
import { SettingsBusinessService } from "../server/storage/settings-service.mjs";
import { PostgresSettingsRepository } from "./storage/postgres-settings.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "./storage/postgres-tasks.mjs";
export {
  stamp,
  excludedYears,
  settingsFor,
  taskView,
  taskList,
} from "./task-view.mjs";
export async function taskRoutes(ctx, path, method, body, query) {
  const settingsRoute = matchBusinessRoute(SETTINGS_ROUTES, path, method);
  if (settingsRoute)
    return callBusinessRoute(
      new SettingsBusinessService(
        new PostgresSettingsRepository({ context: ctx }),
        ctx.user,
      ),
      settingsRoute.route,
      { params: settingsRoute.params, body, query },
    );
  const match = matchBusinessRoute(TASK_ROUTES, path, method);
  if (!match) return undefined;
  const { route, params } = match;
  const service = new TaskBusinessService(
    new PostgresTaskRepository({ context: ctx }),
    ctx.user,
  );
  if (route.name === "query") {
    const result = await service.query(query, {
      ifNoneMatch: ctx.request.headers.get("if-none-match"),
    });
    if (result.notModified)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: result.etag,
          "X-Cell-Event-ID": result.cellEventId,
          "Cache-Control": "private, no-cache",
        },
      });
    return {
      ...result.data,
      etag: result.etag,
      cellEventId: result.cellEventId,
    };
  }
  return taskRouteResult(
    route.name,
    await callBusinessRoute(service, route, { params, body, query }),
    params.id,
  );
}
