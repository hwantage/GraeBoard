import { createWorker } from "../worker/entry.mjs";
import { assertOrigin, verifyAccess } from "../worker/access.mjs";
import { secretMatches, failure, privateHeaders } from "./security.mjs";

export function createEdgeHandler({
  env,
  execution,
  verify = verifyAccess,
  app = createWorker({ verify }),
  prefix = "/graeboard",
}) {
  return async function handle(request) {
    if (
      !secretMatches(
        request.headers.get("x-graeboard-gateway"),
        env.GRAEBOARD_GATEWAY_SECRET,
      )
    )
      return failure(401, "인증되지 않은 연결입니다.");
    const incoming = new URL(request.url);
    // Hosted Supabase removes /functions/v1 before dispatching to Deno.
    const runtimePath = incoming.pathname.startsWith("/functions/v1/")
      ? incoming.pathname.slice("/functions/v1".length)
      : incoming.pathname;
    if (!runtimePath.startsWith(prefix + "/"))
      return failure(404, "요청한 기능을 찾을 수 없습니다.");
    const path = runtimePath.slice(prefix.length);
    if (request.headers.get("x-graeboard-origin") !== env.APP_ORIGIN)
      return failure(403, "이 주소에서는 서비스를 사용할 수 없습니다.");
    const original = new Request(
      env.APP_ORIGIN + path + incoming.search,
      request,
    );
    if (path === "/_gateway/access" && request.method === "GET") {
      try {
        assertOrigin(original, env);
        await verify(original, env);
        return new Response(null, { status: 204, headers: privateHeaders });
      } catch (error) {
        return failure(
          error.status || 503,
          error.status === 401 ? error.message : "인증 연결을 확인하세요.",
        );
      }
    }
    if (path === "/_gateway/scheduled" && request.method === "POST") {
      // Only the secret-authenticated gateway scheduler can invoke this route.
      await app.scheduled({}, env, execution);
      return new Response(null, { status: 202, headers: privateHeaders });
    }
    if (!path.startsWith("/api/"))
      return failure(404, "요청한 기능을 찾을 수 없습니다.");
    return app.fetch(original, env, execution);
  };
}
