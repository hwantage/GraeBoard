import express from "express";
import { resolve } from "node:path";
import {
  SLIDE_EDITOR_PATH,
  slideEditorHeaders,
  slideEditorRequest,
} from "../../shared/slides/slide-editor-policy.js";

export function slideEditorDirectory() {
  return resolve(process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide");
}

// Serves `/tools/canvaslide/current.json` and `/tools/canvaslide/<build id>/`
// from the assembled editor builds. Files are read on each request, so a new
// build is offered without a restart. A missing file is a 404, never the
// application page.
export function installSlideEditorStatic(
  app,
  { directory = slideEditorDirectory() } = {},
) {
  const files = express.static(directory, {
    index: "index.html",
    redirect: false,
    fallthrough: true,
  });
  app.use(SLIDE_EDITOR_PATH, (req, res) => {
    const request = slideEditorRequest(SLIDE_EDITOR_PATH + req.path);
    const missing = () => res.status(404).type("text").send("Not found");
    if (!request || request.invalid || !["GET", "HEAD"].includes(req.method))
      return missing();
    res.set(slideEditorHeaders(request));
    files(req, res, missing);
  });
}
