// Builds the pinned CanvaSlide web editor together with GraeBoard's frame
// adapter. The upstream source is read at the pinned commit into a temporary
// workspace; nothing is written to the upstream repository and no upstream
// source is copied into GraeBoard.
//
//   node scripts/canvaslide/build-canvaslide.mjs [--source <git url or path>]
//
// Output: dist-canvaslide/<build id>/ and dist-canvaslide/current.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const graeboardRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const adapterDir = join(graeboardRoot, "scripts/canvaslide");
const pin = JSON.parse(
  readFileSync(join(adapterDir, "canvaslide-upstream.json"), "utf8"),
);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const source =
  option("--source") || process.env.CANVASLIDE_SOURCE || pin.repository;
const commit = option("--commit") || pin.commit;
if (!/^[0-9a-f]{40}$/.test(commit))
  throw new Error("CanvaSlide commit must be a full 40-character SHA");
const work =
  process.env.CANVASLIDE_WORK_DIR ||
  join(tmpdir(), "graeboard-canvaslide", commit);
const outRoot = resolve(
  graeboardRoot,
  option("--out") || process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide",
);

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, {
    cwd: work,
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
const read = (command, commandArgs) =>
  execFileSync(command, commandArgs, { cwd: work, encoding: "utf8" }).trim();

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(directory, entry.name))
        : [join(directory, entry.name)],
    )
    .sort();
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The adapter is part of the build's identity: changing only GraeBoard's side
// must produce a new build ID and a new static path.
function adapterDigest() {
  const hash = createHash("sha256");
  const files = [
    ...listFiles(adapterDir),
    join(graeboardRoot, "shared/slides/slide-frame-protocol.js"),
  ];
  for (const file of files) {
    hash.update(relative(graeboardRoot, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function checkout() {
  mkdirSync(work, { recursive: true });
  if (!existsSync(join(work, ".git"))) run("git", ["init", "-q", "."]);
  let head = "";
  try {
    head = read("git", ["rev-parse", "HEAD"]);
  } catch {
    // An empty repository has no HEAD yet.
  }
  if (head !== commit) {
    run("git", ["fetch", "-q", "--depth", "1", source, commit]);
    run("git", ["checkout", "-q", "--force", "FETCH_HEAD"]);
  }
  if (read("git", ["rev-parse", "HEAD"]) !== commit)
    throw new Error("CanvaSlide checkout does not match the pinned commit");
  // Tracked upstream files must be exactly the pinned commit's.
  const changed = read("git", [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changed)
    throw new Error(`CanvaSlide workspace has modified files:\n${changed}`);
}

function generatedConfig(buildId) {
  const plugin = join(adapterDir, "canvaslide-adapter-plugin.mjs");
  writeFileSync(
    join(work, "config/graeboard.vite.config.ts"),
    `import { mergeConfig } from 'vite'
import upstream from './vite.config.ts'
import { graeboardCanvaslideAdapter } from ${JSON.stringify(plugin)}

export default mergeConfig(upstream, {
  base: ${JSON.stringify(`/tools/canvaslide/${buildId}/`)},
  plugins: [
    graeboardCanvaslideAdapter({
      graeboardRoot: ${JSON.stringify(graeboardRoot)},
      upstreamRoot: ${JSON.stringify(work)}
    })
  ],
  build: { outDir: ${JSON.stringify(join(outRoot, buildId))}, emptyOutDir: true }
})
`,
  );
  const web = JSON.parse(
    readFileSync(join(work, "config/tsconfig.web.json"), "utf8"),
  );
  writeFileSync(
    join(work, "config/graeboard.tsconfig.json"),
    JSON.stringify(
      {
        extends: "./tsconfig.web.json",
        include: [...web.include, join(adapterDir, "frame/**/*")],
        compilerOptions: {
          composite: false,
          tsBuildInfoFile: null,
          rootDir: "/",
        },
      },
      null,
      2,
    ),
  );
}

checkout();
const pnpm = read("pnpm", ["--version"]);
if (pnpm !== pin.pnpm && !process.env.CANVASLIDE_ALLOW_PNPM)
  throw new Error(
    `CanvaSlide ${commit.slice(0, 7)} builds with pnpm ${pin.pnpm}; found ${pnpm}`,
  );
const digest = adapterDigest();
const buildId = `${commit.slice(0, 12)}-${digest.slice(0, 12)}`;
const out = join(outRoot, buildId);
console.log(`CanvaSlide ${commit} + adapter ${digest.slice(0, 12)} -> ${out}`);

run("pnpm", ["install", "--frozen-lockfile"]);
run("pnpm", ["run", "build:player"]);
run("pnpm", ["run", "build:pdfjs"]);
generatedConfig(buildId);
run("pnpm", [
  "exec",
  "tsc",
  "--noEmit",
  "-p",
  "config/graeboard.tsconfig.json",
]);
run("pnpm", [
  "exec",
  "vite",
  "build",
  "--config",
  "config/graeboard.vite.config.ts",
]);

// Cloudflare Pages files of the upstream site; GraeBoard sets its own headers.
for (const name of ["_headers", "_routes.json"])
  rmSync(join(out, name), { force: true });
if (!existsSync(join(out, "index.html")))
  throw new Error("CanvaSlide build produced no index.html");
const files = Object.fromEntries(
  listFiles(out).map((file) => [
    relative(out, file).split("\\").join("/"),
    { bytes: statSync(file).size, sha256: sha256(readFileSync(file)) },
  ]),
);
const manifest = {
  buildId,
  upstream: { repository: pin.repository, commit, version: pin.version },
  adapter: { digest },
  base: `/tools/canvaslide/${buildId}/`,
  files,
};
writeFileSync(
  join(out, "graeboard-build.json"),
  JSON.stringify(manifest, null, 2),
);
writeFileSync(
  join(outRoot, "current.json"),
  JSON.stringify(
    {
      buildId,
      upstream: manifest.upstream,
      adapter: manifest.adapter,
      manifestSha256: sha256(readFileSync(join(out, "graeboard-build.json"))),
    },
    null,
    2,
  ),
);
console.log(`CanvaSlide build ${buildId}: ${Object.keys(files).length} files`);
