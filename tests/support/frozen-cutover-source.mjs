// Test infrastructure only: never load the frozen runtime into the application.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const frozenCutoverDefinition = JSON.parse(
  readFileSync(
    new URL("./frozen-cutover-source.json", import.meta.url),
    "utf8",
  ),
);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
let source;
const dependencyMarker = ".graeboard-frozen-dependencies.json";
const dependencyIdentity = () => ({
  commit: frozenCutoverDefinition.commit,
  packageLockSha256: frozenCutoverDefinition.packageLockSha256,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
});

// A test run can share one independently installed frozen dependency tree.
// Never borrow the application's node_modules, even when its lockfile matches.
export function verifyFrozenDependencies(root) {
  const modules = join(root, "node_modules");
  if (
    sha(join(root, "package-lock.json")) !==
      frozenCutoverDefinition.packageLockSha256 ||
    !lstatSync(modules).isDirectory() ||
    lstatSync(modules).isSymbolicLink()
  )
    throw new Error("Frozen cutover dependency tree or lockfile mismatch");
  const marker = JSON.parse(
    readFileSync(join(modules, dependencyMarker), "utf8"),
  );
  if (
    Object.entries(dependencyIdentity()).some(
      ([key, value]) => marker[key] !== value,
    )
  )
    throw new Error("Frozen cutover dependency installation identity mismatch");
  return realpathSync(root);
}

function installFrozenDependencies(root) {
  console.log(
    `Installing isolated dependencies for frozen cutover ${frozenCutoverDefinition.commit}`,
  );
  execFileSync("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    env: {
      ...process.env,
      // npm's child processes use the Node version running this test adapter.
      PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ""),
    },
  });
  verifyFrozenCutoverSource(root);
  writeFileSync(
    join(root, "node_modules", dependencyMarker),
    JSON.stringify(dependencyIdentity()),
  );
  return verifyFrozenDependencies(root);
}

export function verifyFrozenCutoverSource(root) {
  const definition = frozenCutoverDefinition;
  for (const [path, expected] of Object.entries({
    "package-lock.json": definition.packageLockSha256,
    ...definition.protectedFiles,
  })) {
    if (sha(join(root, path)) !== expected)
      throw new Error(
        `Frozen cutover source hash mismatch: ${path} (${definition.commit})`,
      );
  }
}

export function frozenCutoverSource() {
  if (source) return source;
  const { commit } = frozenCutoverDefinition;
  let actual;
  try {
    actual = execFileSync(
      "git",
      ["rev-parse", "--verify", `${commit}^{commit}`],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error(
      `Missing frozen cutover commit ${commit}. Run git fetch origin ${commit}; CI checkout must use fetch-depth: 0. No conversion test was skipped.`,
    );
  }
  if (actual !== commit)
    throw new Error(`Frozen cutover commit mismatch: ${actual}`);
  const root = mkdtempSync(join(tmpdir(), "gb-frozen-cutover-source-"));
  try {
    // The original boundary suite calls git ls-files; a full detached checkout
    // preserves its tracked-file view and exact HEAD as well as the source bytes.
    execFileSync("git", [
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      repository,
      root,
    ]);
    execFileSync("git", ["checkout", "--detach", "--quiet", commit], {
      cwd: root,
    });
    if (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim() !== commit
    )
      throw new Error("Frozen cutover checkout HEAD mismatch");
    if (
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }).trim()
    )
      throw new Error("Frozen cutover checkout is not clean");
    verifyFrozenCutoverSource(root);
    appendFileSync(join(root, ".git/info/exclude"), "\n/node_modules\n");
    const prepared = process.env.GRAEBOARD_FROZEN_DEPENDENCIES;
    const dependenciesRoot = prepared
      ? verifyFrozenDependencies(prepared)
      : installFrozenDependencies(root);
    if (prepared)
      symlinkSync(
        join(dependenciesRoot, "node_modules"),
        join(root, "node_modules"),
        "dir",
      );
    // npm ci may not modify tracked files, including the immutable lockfile.
    if (
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }).trim()
    )
      throw new Error(
        "Frozen cutover checkout changed while installing dependencies",
      );
    source = { root, commit, dependenciesRoot, url: pathToFileURL(root + "/") };
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    return source;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function frozenCutoverModule(path) {
  if (!/^tools\/sheet-clone-cutover\/(convert|cutover)\.mjs$/.test(path))
    throw new Error(`Unsupported frozen conversion module: ${path}`);
  return import(new URL(path, frozenCutoverSource().url).href);
}
