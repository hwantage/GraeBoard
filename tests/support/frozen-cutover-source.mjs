// Test infrastructure only: never load the frozen runtime into the application.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const { commit, packageLockSha256 } = frozenCutoverDefinition;
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
  // npm ci installs this same lockfile in both CI and the developer checkout.
  // Refuse silently sharing dependencies after the app lockfile has changed.
  if (sha(join(repository, "package-lock.json")) !== packageLockSha256)
    throw new Error(
      `Frozen cutover dependencies differ. Prepare the full ${commit} checkout and install its package-lock.json before updating this test adapter.`,
    );
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
    symlinkSync(
      join(repository, "node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    source = { root, commit, url: pathToFileURL(root + "/") };
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
