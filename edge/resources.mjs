// Preserve the existing R2/Images ports. Only these storage/transform operations
// run in Cloudflare; permissions, validation, hashing and SQL run in Supabase.
export function resourceBindings(
  env,
  fetcher = globalThis.fetch.bind(globalThis),
) {
  const base = new URL(env.RESOURCE_ORIGIN);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("Invalid resource origin");
  const call = async (path, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("x-graeboard-resource", env.GRAEBOARD_RESOURCE_SECRET);
    const response = await fetcher(new URL(path, base), {
      ...options,
      headers,
      redirect: "error",
    });
    if (!response.ok && response.status !== 404)
      throw Object.assign(new Error("이미지 저장소 연결을 확인하세요."), {
        status: 503,
      });
    return response;
  };
  const objectPath = (key) =>
    "/_resources/object?key=" + encodeURIComponent(key);
  return {
    bucket: {
      async get(key) {
        const r = await call(objectPath(key));
        return r.status === 404
          ? null
          : { body: r.body, arrayBuffer: () => r.arrayBuffer() };
      },
      async head(key) {
        const r = await call(objectPath(key), { method: "HEAD" });
        return r.status === 404
          ? null
          : { key, size: Number(r.headers.get("content-length")) };
      },
      async put(key, bytes, metadata = {}) {
        const r = await call(objectPath(key), {
          method: "PUT",
          body: bytes,
          headers: {
            "content-type":
              metadata.httpMetadata?.contentType || "application/octet-stream",
            "x-object-metadata": JSON.stringify(metadata.customMetadata || {}),
          },
        });
        await r.body?.cancel();
      },
      async delete(key) {
        const r = await call(objectPath(key), { method: "DELETE" });
        await r.body?.cancel();
      },
      async list(options) {
        const params = new URLSearchParams({
          prefix: options.prefix,
          limit: String(options.limit || 1000),
        });
        if (options.cursor) params.set("cursor", options.cursor);
        const r = await call("/_resources/list?" + params);
        return r.json();
      },
    },
    images: {
      async info(stream) {
        const r = await call("/_resources/image-info", {
          method: "POST",
          body: new Uint8Array(await new Response(stream).arrayBuffer()),
        });
        return r.json();
      },
      input(stream) {
        return {
          transform() {
            return this;
          },
          async output() {
            const r = await call("/_resources/image-webp", {
              method: "POST",
              body: new Uint8Array(await new Response(stream).arrayBuffer()),
            });
            return { response: () => r };
          },
        };
      },
    },
  };
}
