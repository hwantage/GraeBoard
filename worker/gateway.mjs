import { secretMatches, failure, privateHeaders } from "../edge/security.mjs";
import { assertOrigin, verifyAccess } from "./access.mjs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

async function resource(request, env) {
  if (
    !secretMatches(
      request.headers.get("x-graeboard-resource"),
      env.GRAEBOARD_RESOURCE_SECRET,
    )
  )
    return failure(401, "인증되지 않은 연결입니다.");
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  const prefix = `images/${env.SITE_TEAM_ID}/`;
  if (path === "/_resources/list" && method === "GET") {
    if (url.searchParams.get("prefix") !== prefix)
      return failure(403, "다른 팀의 이미지입니다.");
    const page = await env.R2_TEAM.list({
      prefix,
      limit: 1000,
      ...(url.searchParams.get("cursor")
        ? { cursor: url.searchParams.get("cursor") }
        : {}),
    });
    return Response.json(page, { headers: privateHeaders });
  }
  if (
    ["/_resources/image-info", "/_resources/image-webp"].includes(path) &&
    method === "POST"
  ) {
    const length = Number(request.headers.get("content-length"));
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > MAX_IMAGE_BYTES
    )
      return failure(413, "이미지는 파일당 10MiB까지 붙여넣을 수 있습니다.");
    if (path.endsWith("image-info"))
      return Response.json(await env.IMAGES.info(request.body), {
        headers: privateHeaders,
      });
    const output = await env.IMAGES.input(request.body)
      .transform({ width: 4096, height: 4096, fit: "scale-down" })
      .output({ format: "image/webp", quality: 90, anim: false });
    const response = output.response();
    return new Response(response.body, {
      headers: { ...privateHeaders, "Content-Type": "image/webp" },
    });
  }
  if (path !== "/_resources/object")
    return failure(404, "요청한 기능을 찾을 수 없습니다.");
  const key = url.searchParams.get("key") || "";
  const validImage =
    key.startsWith(prefix) &&
    /^[a-f0-9]{64}\.webp$/.test(key.slice(prefix.length));
  const probePrefix = `probes/${env.SITE_TEAM_ID}/`;
  const validProbe =
    key.startsWith(probePrefix) &&
    /^[a-f0-9-]{36}$/.test(key.slice(probePrefix.length));
  if (!validImage && !validProbe)
    return failure(403, "다른 팀의 이미지입니다.");
  if (method === "GET" || method === "HEAD") {
    const object = await env.R2_TEAM[method === "HEAD" ? "head" : "get"](key);
    if (!object)
      return new Response(null, { status: 404, headers: privateHeaders });
    return new Response(method === "HEAD" ? null : object.body, {
      headers: {
        ...privateHeaders,
        "Content-Type":
          object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Length": String(object.size),
      },
    });
  }
  if (method === "PUT") {
    const length = Number(request.headers.get("content-length"));
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > MAX_IMAGE_BYTES
    )
      return failure(413, "이미지 용량을 확인하세요.");
    const rawMetadata = request.headers.get("x-object-metadata") || "{}";
    if (rawMetadata.length > 1024)
      return failure(400, "이미지 정보를 확인하세요.");
    let metadata;
    try {
      metadata = JSON.parse(rawMetadata);
    } catch {
      return failure(400, "이미지 정보를 확인하세요.");
    }
    await env.R2_TEAM.put(key, request.body, {
      httpMetadata: {
        contentType: validImage ? "image/webp" : "application/octet-stream",
      },
      customMetadata: {
        teamId: env.SITE_TEAM_ID,
        ...(typeof metadata.createdAt === "string"
          ? { createdAt: metadata.createdAt.slice(0, 40) }
          : {}),
      },
    });
    return new Response(null, { status: 204, headers: privateHeaders });
  }
  if (method === "DELETE") {
    await env.R2_TEAM.delete(key);
    return new Response(null, { status: 204, headers: privateHeaders });
  }
  return new Response(null, { status: 405, headers: privateHeaders });
}

export function createGateway({
  fetcher = globalThis.fetch.bind(globalThis),
  verify = verifyAccess,
} = {}) {
  const forward = async (request, env, path) => {
    const endpoint = new URL(env.GRAEBOARD_EDGE_URL);
    if (
      endpoint.protocol !== "https:" ||
      !/^[a-z0-9]+\.supabase\.co$/.test(endpoint.hostname) ||
      endpoint.pathname !== "/functions/v1/graeboard" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error("Invalid Edge Function endpoint");
    if (
      typeof env.GRAEBOARD_GATEWAY_SECRET !== "string" ||
      env.GRAEBOARD_GATEWAY_SECRET.length < 32
    )
      throw new Error("Missing gateway secret");
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("authorization");
    headers.delete("x-graeboard-resource");
    headers.set("x-graeboard-gateway", env.GRAEBOARD_GATEWAY_SECRET);
    headers.set("x-graeboard-origin", env.APP_ORIGIN);
    const response = await fetcher(
      new Request(endpoint.href + path, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: request.signal,
        duplex: "half",
      }),
    );
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.status !== 304
    ) {
      await response.body?.cancel();
      throw new Error("Edge redirects are not allowed");
    }
    return response;
  };
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/_resources/"))
          return await resource(request, env);
        if (url.origin !== env.APP_ORIGIN)
          return failure(403, "이 주소에서는 서비스를 사용할 수 없습니다.");
        if (url.pathname.startsWith("/api/")) {
          const response = await forward(
            request,
            env,
            url.pathname + url.search,
          );
          // Supabase rewrites HTML to text/plain. Restore only this known,
          // escaped static guide after the API has verified administrator access.
          if (
            url.pathname === "/api/admin/service-connections/guide" &&
            request.method === "GET" &&
            response.status === 200
          ) {
            const headers = new Headers(response.headers);
            headers.set("Content-Type", "text/html; charset=utf-8");
            headers.set("Content-Security-Policy", csp);
            headers.set("Cache-Control", "no-store");
            return new Response(response.body, { headers });
          }
          return response;
        }
        if (!["GET", "HEAD"].includes(request.method))
          return new Response(null, { status: 405 });
        if (
          env.ACCESS_ISSUER ||
          env.ACCESS_AUDIENCE ||
          env.ACCESS_TEAM_DOMAIN ||
          env.ACCESS_AUD
        ) {
          // Reuse the Edge's JWT verification (including expiry and audience).
          // jose caches public keys; fonts/scripts need no Edge invocation.
          try {
            assertOrigin(request, env);
            await verify(request, env);
          } catch (error) {
            return failure(
              error.status || 503,
              error.status === 401 ? error.message : "인증 연결을 확인하세요.",
            );
          }
        } else {
          // Older gateway configurations can be upgraded without an auth gap.
          const auth = await forward(
            new Request(env.APP_ORIGIN + "/", {
              headers: request.headers,
              signal: request.signal,
            }),
            env,
            "/_gateway/access",
          );
          if (auth.status !== 204) return auth;
        }
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Content-Security-Policy", csp);
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch (error) {
        console.error("GraeBoard gateway failed", { name: error.name });
        return failure(503, "외부 서버에 연결할 수 없습니다.");
      }
    },
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(
        forward(
          new Request(env.APP_ORIGIN + "/", { method: "POST" }),
          env,
          "/_gateway/scheduled",
        ).then(async (response) => {
          await response.body?.cancel();
          if (response.status !== 202)
            throw new Error("Edge scheduler rejected");
        }),
      );
    },
  };
}
export default createGateway();
