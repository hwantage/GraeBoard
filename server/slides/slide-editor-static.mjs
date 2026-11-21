import express from "express";
import { join, resolve } from "node:path";
import {
  SLIDE_EDITOR_PATH,
  slideEditorHeaders,
  slideEditorRequest,
} from "../../shared/slides/slide-editor-policy.js";

// Serves `/tools/canvaslide/current.json` and `/tools/canvaslide/<build id>/`
// from where `npm run build` installed the verified editor build
// (dist/tools/canvaslide), with the editor's own response policy. A missing
// file is a 404, never the application page.
export function installSlideEditorStatic(
  app,
  { staticDir = resolve("dist"), directory } = {},
) {
  directory ??= join(staticDir, "tools/canvaslide");
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
