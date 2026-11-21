// The last step of `npm run build`: puts the pinned, verified editor build
// under dist/tools/canvaslide/ so the app and its editor are always deployed
// together. It never builds the upstream editor. It uses, in this order:
//   1. a build already in dist-canvaslide/ (made by `npm run build:canvaslide`)
//   2. the bundle GraeBoard keeps for this build, checked against the SHA-256
//      recorded in canvaslide-upstream.json
// A missing, different or damaged build fails the whole build: an app without
// its editor is never produced.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedBuild,
  graeboardRoot,
  readPin,
  sha256,
  verifyBuildDirectory,
} from "./canvaslide-build-identity.mjs";
import { unpackBundle } from "./canvaslide-bundle.mjs";

async function readBundle(bundle, { fetcher, file }) {
  if (file) return readFileSync(file);
  const url = process.env.CANVASLIDE_BUNDLE_URL || bundle.url;
  let response;
  try {
    response = await fetcher(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(
      `편집기 배포본을 받지 못했습니다(${url}): ${error.message}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `편집기 배포본을 받지 못했습니다(${url}): HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
}

export async function prepareCanvaslideDist({
  root = graeboardRoot,
  pin = readPin(join(root, "scripts/canvaslide/canvaslide-upstream.json")),
  builds = resolve(root, process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide"),
  target = resolve(root, "dist/tools/canvaslide"),
  fetcher = globalThis.fetch,
  bundleFile = process.env.CANVASLIDE_BUNDLE_FILE,
  log = console.log,
} = {}) {
  const expected = expectedBuild(root, pin);
  const directory = join(builds, expected.buildId);
  let source = "dist-canvaslide";
  if (!existsSync(directory)) {
    // The adapter or the pinned commit changed after the kept bundle was made.
    if (pin.bundle?.buildId !== expected.buildId)
      throw new Error(
        `이 소스의 편집기 빌드 ${expected.buildId}에 해당하는 보관 배포본이 없습니다(명세: ${pin.bundle?.buildId || "없음"}). npm run build:canvaslide 로 조립하고 배포본을 보관한 뒤 명세를 갱신하세요.`,
      );
    const bytes = await readBundle(pin.bundle, { fetcher, file: bundleFile });
    if (
      bytes.length !== pin.bundle.bytes ||
      sha256(bytes) !== pin.bundle.sha256
    )
      throw new Error(
        "받은 편집기 배포본이 명세의 크기·SHA-256과 다릅니다. 배포를 중단합니다.",
      );
    // Unpacked next to its final place and moved only after it verifies.
    const partial = `${directory}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      unpackBundle(bytes, partial);
      verifyBuildDirectory(partial, expected);
      renameSync(partial, directory);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
    source = "bundle";
  }
  const manifest = verifyBuildDirectory(directory, expected);
  if (!existsSync(resolve(target, "../..")))
    throw new Error("앱을 먼저 빌드하세요: dist/ 가 없습니다.");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(directory, join(target, expected.buildId), { recursive: true });
  const current = {
    buildId: expected.buildId,
    upstream: manifest.upstream,
    adapter: manifest.adapter,
    manifestSha256: sha256(
      readFileSync(join(directory, "graeboard-build.json")),
    ),
  };
  writeFileSync(join(target, "current.json"), JSON.stringify(current, null, 2));
  writeFileSync(join(builds, "current.json"), JSON.stringify(current, null, 2));
  // What will actually be served is checked once more where it was installed.
  verifyBuildDirectory(join(target, expected.buildId), expected);
  log(
    `CanvaSlide 편집기 ${expected.buildId} (${source}) → dist/tools/canvaslide/`,
  );
  return { ...expected, source };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  prepareCanvaslideDist().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
