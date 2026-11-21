// What identifies an assembled editor build and how one is verified. Used by
// the assembly, by `npm run build` and by the tests, so every path checks the
// same things.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLIDE_FRAME_CHANNEL } from "../../shared/slides/slide-frame-protocol.js";

export const graeboardRoot = resolve(
  fileURLToPath(import.meta.url),
  "../../..",
);
const adapterDir = join(graeboardRoot, "scripts/canvaslide");
const PIN = join(adapterDir, "canvaslide-upstream.json");
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(directory, entry.name))
        : [join(directory, entry.name)],
    )
    .sort();
}
export const readPin = (path = PIN) => JSON.parse(readFileSync(path, "utf8"));

// The sources bundled into the editor are part of the build's identity:
// changing only GraeBoard's side must produce a new build ID and static path.
// The pin's record of the published bundle is not an input of the build.
export function adapterDigest(root = graeboardRoot) {
  const hash = createHash("sha256");
  const files = [
    join(root, "scripts/canvaslide/canvaslide-adapter-plugin.mjs"),
    ...listFiles(join(root, "scripts/canvaslide/frame")),
    join(root, "shared/slides/slide-frame-protocol.js"),
  ];
  for (const file of files) {
    hash.update(relative(root, file).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
export const buildIdFor = (commit, digest) =>
  `${commit.slice(0, 12)}-${digest.slice(0, 12)}`;
// The build this checkout must serve.
export function expectedBuild(root = graeboardRoot, pin = readPin()) {
  const digest = adapterDigest(root);
  return {
    commit: pin.commit,
    digest,
    buildId: buildIdFor(pin.commit, digest),
  };
}

// Every file of a build directory against its manifest, plus the two things a
// browser needs first: the page, and an editor script that carries GraeBoard's
// frame channel (an editor without it cannot save to a team).
export function verifyBuildDirectory(directory, expected) {
  const manifestPath = join(directory, "graeboard-build.json");
  if (!existsSync(manifestPath))
    throw new Error(`편집기 배포본에 명세가 없습니다: ${directory}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.buildId !== expected.buildId ||
    manifest.upstream?.commit !== expected.commit ||
    manifest.adapter?.digest !== expected.digest
  )
    throw new Error(
      `편집기 배포본 ${manifest.buildId}은 이 소스의 빌드(${expected.buildId})가 아닙니다.`,
    );
  const present = listFiles(directory)
    .map((file) => relative(directory, file).split("\\").join("/"))
    .filter((file) => file !== "graeboard-build.json");
  const recorded = Object.keys(manifest.files).sort();
  if (present.join("\n") !== recorded.join("\n"))
    throw new Error("편집기 배포본의 파일 목록이 명세와 다릅니다.");
  for (const [file, { bytes, sha256: hash }] of Object.entries(
    manifest.files,
  )) {
    const path = join(directory, file);
    if (statSync(path).size !== bytes || sha256(readFileSync(path)) !== hash)
      throw new Error(`편집기 배포본 파일이 명세와 다릅니다: ${file}`);
  }
  const page = readFileSync(join(directory, "index.html"), "utf8");
  const base = `/tools/canvaslide/${expected.buildId}/`;
  const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (!scripts.length || scripts.some((src) => !src.startsWith(base)))
    throw new Error("편집기 화면이 이 빌드의 경로를 가리키지 않습니다.");
  const carriesChannel = scripts.some((src) =>
    readFileSync(join(directory, src.slice(base.length)), "utf8").includes(
      SLIDE_FRAME_CHANNEL,
    ),
  );
  if (!carriesChannel)
    throw new Error("편집기 스크립트에 그래보드 연결 모듈이 없습니다.");
  return manifest;
}
// A build directory's manifest: file list with sizes and hashes.
export function describeBuildDirectory(directory) {
  return Object.fromEntries(
    listFiles(directory)
      .map((file) => [relative(directory, file).split("\\").join("/"), file])
      .filter(([name]) => name !== "graeboard-build.json")
      .map(([name, file]) => [
        name,
        { bytes: statSync(file).size, sha256: sha256(readFileSync(file)) },
      ]),
  );
}
