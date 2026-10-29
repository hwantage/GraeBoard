// Shared HTTP contracts. Hosts keep their own authentication, streaming and I/O.
const routes = (items) =>
  items.map(([method, path, name, args = [], status = 200]) => {
    const params = [];
    const pattern = path.replace(/:([A-Za-z]+)/g, (_, name) => {
      params.push(name);
      return "([^/]+)";
    });
    return {
      method,
      path,
      name,
      args,
      status,
      params,
      pattern: new RegExp(`^${pattern}$`),
    };
  });
export const TASK_ROUTES = routes([
  ["GET", "/tasks", "query", ["query"]],
  ["POST", "/cells/batch", "saveBatch", ["body"]],
  ["POST", "/tasks", "create", ["body"], 201],
  ["PATCH", "/tasks/:id", "update", ["id", "body"]],
  ["POST", "/tasks/reorder", "reorder", ["body"]],
  ["POST", "/tasks/delete", "remove", ["body"]],
  ["POST", "/tasks/restore", "restore", ["body"]],
  ["DELETE", "/tasks/:id", "removeOne", ["id", "body"]],
  ["POST", "/tasks/:id/restore", "restoreOne", ["id", "body"]],
  ["GET", "/views", "readViews", ["query"]],
  ["PUT", "/views", "saveView", ["body"]],
]);
export const REPORT_ROUTES = routes([
  ["GET", "/reports", "list", ["query"]],
  ["POST", "/reports", "create", ["body"], 201],
  ["DELETE", "/reports", "remove", ["body"]],
  ["GET", "/reports/:id", "read", ["id"]],
  ["PATCH", "/reports/:id/name", "rename", ["id", "body"]],
  ["PATCH", "/reports/:id", "edit", ["id", "body"]],
]);
export const FILTER_ROUTES = routes([
  ["GET", "/filters", "list", ["query"]],
  ["PUT", "/filters/current", "current", ["body"]],
  ["PUT", "/filters", "save", ["body"]],
  ["PATCH", "/filters/:id", "update", ["id", "body"]],
  ["DELETE", "/filters/:id", "remove", ["id"]],
]);
export const SETTINGS_ROUTES = routes([
  ["PATCH", "/teams/:id/settings", "save", ["id", "body"]],
  ["PATCH", "/teams/:id", "general", ["id", "body"]],
]);
export const HISTORY_ROUTES = routes([
  ["GET", "/audit", "query", ["query"]],
  ["POST", "/audit/:id/restore", "restore", ["id", "body"]],
]);
export const HISTORY_CLEANUP_ROUTES = routes([
  ["GET", "/admin/history-cleanup/storage", "storage"],
  ["GET", "/admin/history-cleanup", "preview", ["query"]],
  ["POST", "/admin/history-cleanup", "cleanup", ["body"]],
]);
export const SYSTEM_AUDIT_ROUTES = routes([
  ["GET", "/admin/audit", "audit", ["query"]],
  ["GET", "/admin/audit/:id", "auditEntry", ["id"]],
]);
export const CONTROL_ROUTES = routes([
  ["GET", "/bootstrap", "bootstrap"],
  ["PATCH", "/auth/profile", "profile"],
  ["GET", "/admin/users", "listUsers"],
  ["POST", "/admin/users", "createUser", [], 201],
  ["PATCH", "/admin/users/:id", "updateUser"],
  ["GET", "/teams/:id/members", "members"],
  ["PUT", "/teams/:id/members", "replaceMembers"],
  ["POST", "/admin/teams", "createTeam", [], 201],
  ["DELETE", "/admin/teams/:id", "deleteTeam"],
]);
export const BROWSER_ROUTES = routes(
  ["sources", "tasks", "task"].map((kind) => [
    "GET",
    `/document-browser/${kind}`,
    kind,
  ]),
);
export const TRANSFER_ROUTES = routes([
  ["POST", "/export", "export", ["body"]],
  ["POST", "/import/preview", "preview", ["body"]],
  ["POST", "/import/:id/exceptions", "exceptions", ["id"]],
  ["POST", "/import/:id/apply", "apply", ["id", "body"]],
]);
export function matchBusinessRoute(routes, path, method) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match)
      return {
        route,
        params: Object.fromEntries(
          route.params.map((name, index) => [
            name,
            decodeURIComponent(match[index + 1]),
          ]),
        ),
      };
  }
  return null;
}
export function callBusinessRoute(
  service,
  route,
  { params = {}, body, query },
) {
  if (query instanceof URLSearchParams) query = Object.fromEntries(query);
  return service[route.name](
    ...route.args.map((name) =>
      name === "body" ? body : name === "query" ? query : params[name],
    ),
  );
}
export function taskRouteResult(name, result, id) {
  if (name === "removeOne")
    return { ok: true, updatedAt: result.updatedAt[id] };
  if (name === "restoreOne") return { task: result.tasks[0] };
  return result;
}
