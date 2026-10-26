import { SettingsBusinessService } from "../server/storage/settings-service.mjs";
import { PostgresSettingsRepository } from "../server/storage/postgres-settings.mjs";
import { TaskBusinessService } from "../server/storage/task-service.mjs";
import { PostgresTaskRepository } from "../server/storage/postgres-tasks.mjs";
export {
  stamp,
  excludedYears,
  settingsFor,
  taskView,
  taskList,
} from "./task-view.mjs";
export async function taskRoutes(ctx, path, method, body, query) {
  if (path === "/tasks" && method === "GET") {
    const result = await new TaskBusinessService(
      new PostgresTaskRepository({ context: ctx }),
      ctx.user,
    ).query(query, { ifNoneMatch: ctx.request.headers.get("if-none-match") });
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
  const service = new TaskBusinessService(
    new PostgresTaskRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/tasks" && method === "POST") return service.create(body);
  if (path === "/cells/batch" && method === "POST")
    return service.saveBatch(body);
  if (path === "/tasks/reorder" && method === "POST")
    return service.reorder(body);
  if (path === "/tasks/delete" && method === "POST")
    return service.remove(body);
  if (path === "/tasks/restore" && method === "POST")
    return service.restore(body);
  const task = /^\/tasks\/([^/]+)$/.exec(path),
    restore = /^\/tasks\/([^/]+)\/restore$/.exec(path);
  if (task && method === "PATCH") return service.update(task[1], body);
  if (task && method === "DELETE") {
    const result = await service.removeOne(task[1], body);
    return { ok: true, updatedAt: result.updatedAt[task[1]] };
  }
  if (restore && method === "POST") {
    const result = await service.restoreOne(restore[1], body);
    return { task: result.tasks[0] };
  }
  const teamSettings = /^\/teams\/([^/]+)(\/settings)?$/.exec(path);
  if (teamSettings && method === "PATCH") {
    const settings = new SettingsBusinessService(
      new PostgresSettingsRepository({ context: ctx }),
      ctx.user,
    );
    return teamSettings[2]
      ? settings.save(teamSettings[1], body)
      : settings.general(teamSettings[1], body);
  }
  if (path === "/views" && method === "GET")
    return service.readViews(Object.fromEntries(query));
  if (path === "/views" && method === "PUT") return service.saveView(body);
  return undefined;
}
