// Places the current assembled editor build under dist/tools/canvaslide/ for a
// static host (the external site's Cloudflare Pages output). The internal Node
// server reads dist-canvaslide/ directly and does not need this step.
//
//   npm run build && npm run build:canvaslide && node scripts/canvaslide/install-canvaslide-dist.mjs
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLIDE_EDITOR_BUILD_ID } from "../../shared/slides/slide-editor-policy.js";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export function installCanvaslideDist({
  source = resolve(root, process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide"),
  target = resolve(root, "dist/tools/canvaslide"),
} = {}) {
  const current = JSON.parse(
    readFileSync(join(source, "current.json"), "utf8"),
  );
  if (!SLIDE_EDITOR_BUILD_ID.test(current.buildId))
    throw new Error("current.json does not name an editor build");
  const build = join(source, current.buildId);
  const manifestPath = join(build, "graeboard-build.json");
  if (sha256(manifestPath) !== current.manifestSha256)
    throw new Error("Editor build manifest does not match current.json");
  // Only a build whose every file matches its recorded hash is published.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [file, { bytes, sha256: expected }] of Object.entries(
    manifest.files,
  )) {
    const path = join(build, file);
    if (
      !existsSync(path) ||
      statSync(path).size !== bytes ||
      sha256(path) !== expected
    )
      throw new Error(`Editor build file changed after assembly: ${file}`);
  }
  if (!existsSync(resolve(target, "../..")))
    throw new Error("Build the app first: dist/ does not exist");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(build, join(target, current.buildId), { recursive: true });
  cpSync(join(source, "current.json"), join(target, "current.json"));
  return {
    buildId: current.buildId,
    files: Object.keys(manifest.files).length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { buildId, files } = installCanvaslideDist();
  console.log(
    `CanvaSlide build ${buildId}: ${files} files -> dist/tools/canvaslide/`,
  );
}
