// Packs the build this checkout expects into the bundle GraeBoard keeps, and
// records it in canvaslide-upstream.json:
//
//   npm run build:canvaslide && npm run build:canvaslide:pack
//
// Output: dist-canvaslide/bundles/<build id>.tar.gz. Publish that file at the
// recorded URL; `npm run build` then verifies it by size and SHA-256.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedBuild,
  graeboardRoot,
  readPin,
  sha256,
  verifyBuildDirectory,
} from "./canvaslide-build-identity.mjs";
import { packBundle } from "./canvaslide-bundle.mjs";

export const BUNDLE_BRANCH = "canvaslide-editor";
export const bundleUrl = (repository, buildId) =>
  `https://raw.githubusercontent.com/${repository}/${BUNDLE_BRANCH}/bundles/${buildId}.tar.gz`;

export function packCanvaslideBundle({
  root = graeboardRoot,
  builds = resolve(root, process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide"),
  repository = "hwantage/GraeBoard",
  writePin = true,
} = {}) {
  const pinPath = join(root, "scripts/canvaslide/canvaslide-upstream.json");
  const pin = readPin(pinPath);
  const expected = expectedBuild(root, pin);
  verifyBuildDirectory(join(builds, expected.buildId), expected);
  const bytes = packBundle(join(builds, expected.buildId));
  mkdirSync(join(builds, "bundles"), { recursive: true });
  const file = join(builds, "bundles", `${expected.buildId}.tar.gz`);
  writeFileSync(file, bytes);
  const bundle = {
    buildId: expected.buildId,
    url: bundleUrl(repository, expected.buildId),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
  if (writePin)
    writeFileSync(pinPath, JSON.stringify({ ...pin, bundle }, null, 2) + "\n");
  return { file, bundle };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { file, bundle } = packCanvaslideBundle();
  console.log(`${file}\n${JSON.stringify(bundle, null, 2)}`);
}
