import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SLIDE_EDITOR_PATH = "/tools/canvaslide";

export function slideEditorDirectory() {
  return resolve(process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide");
}

// The assembled editor build this server offers, or null when none is
// installed. Read on each request so a new build is served without a restart.
export function currentSlideEditor(directory) {
  try {
    const current = JSON.parse(
      readFileSync(join(directory, "current.json"), "utf8"),
    );
    if (
      typeof current.buildId !== "string" ||
      !/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(current.buildId) ||
      !existsSync(join(directory, current.buildId, "index.html"))
    )
      return null;
    return {
      buildId: current.buildId,
      path: `${SLIDE_EDITOR_PATH}/${current.buildId}/`,
      upstream: current.upstream,
    };
  } catch {
    return null;
  }
}

// The editor's own policy (workers, wasm, embedded media) with one change: the
// document may be framed by GraeBoard pages of the same origin only.
const EDITOR_POLICY = [
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

// Serves `/tools/canvaslide/<build id>/`. Build directories are immutable, so
// hashed assets are cached; a missing asset is a 404, never the app shell.
export function installSlideEditorStatic(
  app,
  { directory = slideEditorDirectory() } = {},
) {
  app.locals.slideEditorDirectory = directory;
  app.get("/api/slides/editor", (req, res) => {
    if (!req.user)
      return res.status(401).json({ error: "로그인이 필요합니다." });
    res.json({ editor: currentSlideEditor(directory) });
  });
  const files = express.static(directory, {
    index: "index.html",
    redirect: true,
    fallthrough: true,
    setHeaders(res, path) {
      res.set("Content-Security-Policy", EDITOR_POLICY);
      res.set("X-Frame-Options", "SAMEORIGIN");
      res.set("Referrer-Policy", "no-referrer");
      res.set(
        "Cache-Control",
        /[\\/]assets[\\/]/.test(path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  });
  app.use(SLIDE_EDITOR_PATH, (req, res, next) => {
    if (!/^\/[0-9a-f]{12}-[0-9a-f]{12}(\/|$)/.test(req.path))
      return res.status(404).type("text").send("Not found");
    files(req, res, () => res.status(404).type("text").send("Not found"));
  });
}
