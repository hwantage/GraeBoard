import { accessTokenRoutes } from "./access-tokens.mjs";
import {
  isSyncRequest,
  syncErrorMessage,
} from "../shared/sync-error-message.js";
import { syncSetupKeyStatus } from "./setup-keys.mjs";
import { deploymentSite } from "../shared/site-mode.js";
import { pack, unpack } from "../shared/compact.js";
import { assertOrigin, verifyAccess, assert } from "./access.mjs";
import {
  authenticate,
  setupStatus,
  setup,
  RequestContext,
  controlRoutes,
} from "./control.mjs";
import { adminRoutes } from "./admin.mjs";
import { taskRoutes } from "./tasks.mjs";
import { documentRoutes } from "./documents.mjs";
import { reportRoutes, filterRoutes, browserRoutes } from "./reports.mjs";
import { calendarRoutes } from "./calendar.mjs";
import { transferRoutes } from "./transfer.mjs";
import { recoveryRoutes } from "./recovery.mjs";
import { profileSwitchRoutes } from "./profile-switch.mjs";
import { auditRoutes, historyCleanupRoutes } from "./history.mjs";
import { maintenanceRoutes } from "./maintenance.mjs";
import { eventResponse } from "./events.mjs";
import { schedulePublish, refreshTeam, scheduled } from "./sync.mjs";
import { profileFor, siteTeamId } from "../shared/sync-profiles.js";
import { siteAuthRoute, accessRequestRoutes } from "./site-auth.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { PostgresDocumentRepository } from "./storage/postgres-documents.mjs";
const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};
export const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(pack(value)), {
    status,
    headers: {
      ...security,
      "Content-Type": "application/json; charset=utf-8",
      "X-Server-Time": new Date().toISOString(),
      ...headers,
    },
  });
async function boundedRequest(request) {
  if (!request.body) return request;
  const limit =
    (request.headers.get("content-type")?.includes("application/json")
      ? 4
      : new URL(request.url).pathname.endsWith("/images")
        ? 11
        : 27) *
    1024 *
    1024;
  assert(
    Number(request.headers.get("content-length") || 0) <= limit,
    413,
    "요청 용량이 너무 큽니다.",
  );
  const chunks = [],
    reader = request.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      assert(false, 413, "요청 용량이 너무 큽니다.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
    signal: request.signal,
    duplex: "half",
  });
}
async function pullFirst(ctx, teamId, { wait = true } = {}) {
  if (!teamId) return;
  const team = await ctx.team(teamId, { allowUnready: true });
  if (team.status !== "active" || !team.profile_id) return;
  const profile = profileFor(ctx.env, team.profile_id, teamId);
  const promise = refreshTeam(ctx.env, profile).catch(() => {});
  ctx.execution?.waitUntil(promise);
  if (!wait) return;
  await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}
async function mutationTeam(ctx, path, body) {
  if (
    path.startsWith("/admin/") ||
    path.startsWith("/auth/") ||
    path.includes("/sync/") ||
    path === "/events"
  )
    return null;
  if (body.teamId) return body.teamId;
  if (body.format?.teamId) return body.format.teamId;
  let m;
  if (
    (m = /^\/teams\/([^/]+)/.exec(path)) ||
    (m = /^\/calendar\/teams\/([^/]+)/.exec(path))
  )
    return m[1];
  if (
    (m = /^\/tasks\/([^/]+)/.exec(path)) &&
    !["delete", "restore", "reorder"].includes(m[1])
  )
    return (await ctx.locate("task", m[1])).teamId;
  if ((m = /^\/reports\/([^/]+)/.exec(path)))
    return (await ctx.locate("report", m[1])).teamId;
  if ((m = /^\/calendar\/(entries|tags)\/([^/]+)/.exec(path)))
    return (await ctx.locate(m[1] === "entries" ? "calendar" : "tag", m[2]))
      .teamId;
  const taskId =
    body.changes?.[0]?.taskId ||
    body.tasks?.[0]?.id ||
    body.taskId ||
    body.targetId;
  if (taskId) return (await ctx.locate("task", taskId)).teamId;
  return null;
}
export function createWorker({
  verify = verifyAccess,
  onError = (error) => {
    if ((error.status || 500) >= 500)
      console.error("GraeBoard Worker request failed", {
        name: error.name,
        code: error.code,
        message: error.message,
      });
  },
  publish = schedulePublish,
} = {}) {
  return {
    async fetch(original, env, execution = { waitUntil() {} }) {
      try {
        deploymentSite(env, "external");
        assertOrigin(original, env);
        const identity = await verify(original, env);
        const url = new URL(original.url),
          path = url.pathname.slice(4),
          method = original.method;
        if (!url.pathname.startsWith("/api/")) {
          assert(env.ASSETS, 503, "정적 화면을 빌드하세요.");
          const response = await env.ASSETS.fetch(original);
          const headers = new Headers(response.headers);
          headers.set("X-Content-Type-Options", "nosniff");
          headers.set("X-Frame-Options", "DENY");
          headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          );
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        }
        const request = await boundedRequest(original);
        let body = {};
        if (
          request.body &&
          request.headers.get("content-type")?.includes("application/json")
        ) {
          try {
            body = unpack(await request.clone().json(), { maxStyles: 50001 });
          } catch {
            assert(false, 400, "JSON 요청을 확인하세요.");
          }
        }
        const siteAuth = await siteAuthRoute(
          env,
          identity,
          request,
          path,
          method,
          body,
        );
        if (siteAuth) {
          if (
            siteTeamId(env) &&
            ["/setup", "/auth/setup", "/auth/accounts"].includes(path)
          )
            execution.waitUntil(
              syncSetupKeyStatus(env, { force: path === "/auth/setup" }).catch(
                onError,
              ),
            );
          return json(siteAuth.body, siteAuth.status || 200, siteAuth.headers);
        }
        if (path === "/setup" && method === "GET")
          return json(await setupStatus(env, identity));
        if (path === "/auth/setup" && method === "POST")
          return json(await setup(env, identity, body), 201);
        const user = await authenticate(env, identity, request),
          ctx = new RequestContext(env, user, identity, request, execution);
        if (path === "/health") return json({ ok: true, site: "external" });
        if (path === "/admin/service-connections/guide") {
          ctx.admin();
          return env.ASSETS.fetch(
            new Request(env.APP_ORIGIN + "/CLOUD_SETUP.html", {
              headers: request.headers,
            }),
          );
        }
        const image = /^\/document-images\/([^/]+)\/([a-f0-9]{64}\.webp)$/.exec(
          path,
        );
        if (image && method === "GET") {
          const stream = await new DocumentBusinessService(
            new PostgresDocumentRepository({ context: ctx }),
            ctx.user,
          ).readImage("/api" + path, { stream: true });
          return new Response(stream, {
            headers: { ...security, "Content-Type": "image/webp" },
          });
        }
        if (path === "/events" && method === "POST")
          return await eventResponse(ctx, body.streams);
        if (path.endsWith("/events") && method === "GET")
          return await eventResponse(
            ctx,
            [
              {
                id: 0,
                path: url.pathname + url.search,
                lastEventId: request.headers.get("last-event-id") || undefined,
              },
            ],
            { multiplex: false },
          );
        if (path === "/tasks" && method === "GET")
          await pullFirst(ctx, url.searchParams.get("teamId"), { wait: false });
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method))
          await pullFirst(ctx, await mutationTeam(ctx, path, body));
        if (siteTeamId(env))
          ctx.user = await authenticate(env, identity, request);
        const routes = [
          controlRoutes,
          accessTokenRoutes,
          adminRoutes,
          recoveryRoutes,
          auditRoutes,
          historyCleanupRoutes,
          accessRequestRoutes,
          profileSwitchRoutes,
          maintenanceRoutes,
          taskRoutes,
          documentRoutes,
          reportRoutes,
          filterRoutes,
          browserRoutes,
          calendarRoutes,
          transferRoutes,
        ];
        for (const route of routes) {
          const result = await route(ctx, path, method, body, url.searchParams);
          if (result !== undefined) {
            if (path === "/bootstrap" && siteTeamId(env))
              execution.waitUntil(
                syncSetupKeyStatus(env, {
                  force: path === "/auth/setup",
                }).catch(onError),
              );
            if (result instanceof Response) return result;
            let headers = {};
            if (path === "/tasks" && method === "GET") {
              headers = {
                "X-Cell-Event-ID": result.cellEventId,
                ETag: result.etag,
              };
              delete result.etag;
            }
            if (["POST", "PUT", "PATCH", "DELETE"].includes(method))
              for (const team of ctx.teamCache.values())
                if (
                  ctx.changedTeams.has(team.id) &&
                  team.status === "active" &&
                  team.profile_id
                )
                  execution.waitUntil(
                    publish(
                      env,
                      profileFor(env, team.profile_id, team.id),
                    ).catch(() => {}),
                  );
            return json(result, 200, headers);
          }
        }
        return json({ error: "요청한 기능을 찾을 수 없습니다." }, 404);
      } catch (error) {
        onError(error);
        const status = error.status || (error.name === "ZodError" ? 400 : 500);
        const syncMessage =
          isSyncRequest(new URL(original.url).pathname) &&
          syncErrorMessage(error);
        return json(
          {
            error:
              syncMessage ||
              (status >= 500
                ? "서비스 연결을 확인한 뒤 다시 시도하세요."
                : error.message),
            ...(error.code === "EXTERNAL_SYNC_CAPACITY"
              ? { code: error.code }
              : {}),
            ...(error.details ? { details: error.details } : {}),
          },
          status,
        );
      }
    },
    async scheduled(_controller, env, ctx) {
      deploymentSite(env, "external");
      ctx.waitUntil(scheduled(env));
      if (siteTeamId(env))
        ctx.waitUntil(syncSetupKeyStatus(env).catch(onError));
    },
  };
}
export default createWorker();
