// How the assembled CanvaSlide editor is served, shared by the internal Node
// host and the external gateway so both sites answer the same way.
export const SLIDE_EDITOR_PATH = "/tools/canvaslide";
// The file that names the build this site offers.
export const SLIDE_EDITOR_CURRENT = `${SLIDE_EDITOR_PATH}/current.json`;
export const SLIDE_EDITOR_BUILD_ID = /^[0-9a-f]{12}-[0-9a-f]{12}$/;

// GraeBoard pages may frame same-origin documents. Firefox and WebKit treat a
// file the editor downloads from a blob URL as a navigation of that frame.
export const APP_FRAME_SOURCES = ["'self'", "blob:"];

// The editor's own policy (workers, wasm, embedded media) with one change: the
// document may be framed by pages of the same origin only.
export const SLIDE_EDITOR_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com https://player.vimeo.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https://i.ytimg.com",
  "connect-src 'self' data: blob: https://www.youtube.com https://vimeo.com",
  "frame-src https://www.youtube.com https://player.vimeo.com",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

// What a path under the editor prefix names, or null outside it.
// `document` is the editor page itself; anything else is an asset that must
// exist as a file and is never answered with an application page.
export function slideEditorRequest(pathname) {
  if (
    pathname !== SLIDE_EDITOR_PATH &&
    !pathname.startsWith(`${SLIDE_EDITOR_PATH}/`)
  )
    return null;
  if (pathname === SLIDE_EDITOR_CURRENT)
    return { current: true, document: false, immutable: false };
  const [buildId = "", ...rest] = pathname
    .slice(SLIDE_EDITOR_PATH.length + 1)
    .split("/");
  if (!SLIDE_EDITOR_BUILD_ID.test(buildId) || rest.length === 0)
    return { invalid: true };
  const file = rest.join("/");
  return {
    buildId,
    document: file === "" || file === "index.html",
    immutable: file.startsWith("assets/"),
  };
}
export function slideEditorHeaders(request) {
  return {
    "Content-Security-Policy": SLIDE_EDITOR_POLICY,
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": request.immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
}

// Application pages of both sites: GraeBoard's policy with the frame sources
// the slides screen needs.
export const APP_POLICY = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${APP_FRAME_SOURCES.join(" ")}; frame-ancestors 'none'`;

// For a static host that answers unknown paths with the application page
// (Cloudflare Pages): the editor response for `pathname`, a 404 when the file
// does not exist, or null when the path is not under the editor prefix.
export function slideEditorAssetResponse(
  pathname,
  response,
  { shared = true } = {},
) {
  const request = slideEditorRequest(pathname);
  if (!request) return null;
  const headers = new Headers(response.headers);
  if (
    request.invalid ||
    response.status !== 200 ||
    (!request.document && headers.get("Content-Type")?.startsWith("text/html"))
  ) {
    void response.body?.cancel();
    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }
  for (const [name, value] of Object.entries(slideEditorHeaders(request)))
    headers.set(
      name,
      name === "Cache-Control" && !shared
        ? value.replace("public", "private")
        : value,
    );
  return new Response(response.body, { status: 200, headers });
}
