import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const validPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const phaseNumber = (phase) => (/^P[0-8]$/.test(phase) ? +phase.slice(1) : -1);
const stem = (path) =>
  basename(path, extname(path)).replace(/\.(test|spec|d)$/, "");
const sameSet = (a, b) =>
  a.size === b.size && [...a].every((value) => b.has(value));

function regularFile(root, path) {
  // Git can track symlinks; neither files nor parent links may bypass rules.
  try {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const info = lstatSync(resolve(root, ...parts.slice(0, i)));
      if (info.isSymbolicLink()) return false;
      if (i === parts.length) return info.isFile();
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  return false;
}

export function checkCodeOrganization({
  root,
  rules,
  migrationPhase,
  manifest,
}) {
  const errors = [],
    warnings = [];
  const fail = (rule, path, reason) => errors.push({ rule, path, reason });
  const configError = (path, reason) => fail("config", path, reason);
  let files = [];
  try {
    if (!rules || rules.version !== 1)
      throw new Error("Unsupported rules version");
    for (const key of ["sourceRoots", "extensions", "forbiddenStems"])
      if (
        !Array.isArray(rules[key]) ||
        !rules[key].length ||
        rules[key].some((value) => typeof value !== "string") ||
        new Set(rules[key]).size !== rules[key].length
      )
        throw new Error(`Invalid or duplicate ${key}`);
    if (rules.sourceRoots.some((path) => !validPath(path)))
      throw new Error("Invalid sourceRoots path");
    if (rules.extensions.some((extension) => !/^\.[a-z]+$/.test(extension)))
      throw new Error("Invalid code extension");
    const records = (key) => {
      if (!Array.isArray(rules[key])) throw new Error(`Missing ${key}`);
      const seen = new Set();
      for (const record of rules[key]) {
        if (
          !record ||
          !validPath(record.path) ||
          typeof record.reason !== "string" ||
          !record.reason.trim()
        )
          throw new Error(`Invalid ${key} record`);
        if (seen.has(record.path))
          configError(record.path, `Duplicate ${key} record`);
        seen.add(record.path);
      }
      return seen;
    };
    const allowed = records("allowedDirectories"),
      rootFiles = records("legacyRootFiles"),
      generic = records("legacyGenericFiles"),
      fixed = records("fixedFiles");
    if (!Array.isArray(rules.legacyDuplicateGroups))
      throw new Error("Missing legacyDuplicateGroups");
    const groups = new Map();
    for (const group of rules.legacyDuplicateGroups) {
      if (
        !group ||
        typeof group.reason !== "string" ||
        !group.reason.trim() ||
        !Array.isArray(group.paths) ||
        group.paths.length < 2 ||
        group.paths.some((path) => !validPath(path)) ||
        new Set(group.paths).size !== group.paths.length
      )
        throw new Error("Invalid legacyDuplicateGroups record");
      const name = basename(group.paths[0]).toLowerCase();
      if (group.paths.some((path) => basename(path).toLowerCase() !== name))
        throw new Error("Duplicate group must contain exactly one basename");
      if (groups.has(name))
        configError(name, "Duplicate basename exception group");
      groups.set(name, new Set(group.paths));
    }
    files = [
      ...new Set(
        execFileSync(
          "git",
          [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ...rules.sourceRoots,
          ],
          { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        )
          .split("\0")
          .filter((path) => path && regularFile(root, path)),
      ),
    ].sort();
    const current = new Set(files);
    const code = files.filter((path) =>
      rules.extensions.includes(extname(path)),
    );
    const codeSet = new Set(code);
    for (const [key, paths] of [
      ["legacyRootFiles", rootFiles],
      ["legacyGenericFiles", generic],
      ["fixedFiles", fixed],
    ])
      for (const path of paths) {
        if (!current.has(path))
          fail(
            "stale-exception",
            path,
            `${key} file is absent or not a regular source file`,
          );
        if (key !== "fixedFiles" && !codeSet.has(path))
          configError(path, `${key} must reference a code file`);
        if (
          key === "legacyRootFiles" &&
          !rules.sourceRoots.includes(dirname(path))
        )
          configError(path, "Root exception must reference a source root file");
        if (
          key === "legacyGenericFiles" &&
          !rules.forbiddenStems.includes(stem(path).toLowerCase())
        )
          configError(
            path,
            "Generic exception must reference a forbidden stem",
          );
      }
    for (const record of rules.fixedFiles) {
      if (record.sha256 !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(record.sha256))
          configError(record.path, "Invalid fixed SHA-256");
        else if (
          current.has(record.path) &&
          createHash("sha256")
            .update(readFileSync(resolve(root, record.path)))
            .digest("hex") !== record.sha256
        )
          fail(
            "fixed-bytes",
            record.path,
            "SHA-256 differs from the protected baseline",
          );
      }
    }
    const names = new Map(),
      stems = new Map();
    for (const path of code) {
      const name = basename(path).toLowerCase(),
        base = stem(path).toLowerCase();
      if (
        rules.forbiddenStems.includes(base) &&
        !generic.has(path) &&
        !fixed.has(path)
      )
        fail("generic-name", path, `New generic filename: ${base}`);
      const parent = dirname(path);
      if (!allowed.has(parent))
        fail("directory", path, `Unregistered parent directory: ${parent}`);
      if (
        rules.sourceRoots.includes(parent) &&
        !rootFiles.has(path) &&
        !fixed.has(path)
      )
        fail("root-file", path, "New root files require a feature directory");
      if (!names.has(name)) names.set(name, new Set());
      names.get(name).add(path);
      if (!stems.has(base)) stems.set(base, []);
      stems.get(base).push(path);
    }
    for (const [name, paths] of names)
      if (
        paths.size > 1 &&
        (!groups.has(name) || !sameSet(paths, groups.get(name)))
      )
        fail(
          "duplicate-name",
          [...paths].join(", "),
          `Unregistered basename group: ${name}`,
        );
    for (const [name, paths] of groups)
      if (!names.has(name) || !sameSet(paths, names.get(name)))
        fail(
          "stale-exception",
          [...paths].join(", "),
          "Duplicate exception no longer matches the exact current group",
        );
    for (const paths of stems.values()) {
      if (new Set(paths.map((path) => extname(path))).size < 2) continue;
      const implementations = paths.filter((path) => !path.endsWith(".d.ts"));
      const declarations = paths.filter((path) => path.endsWith(".d.ts"));
      if (
        implementations.length === 1 &&
        declarations.length === 1 &&
        declarations[0] === implementations[0].replace(/\.[^.]+$/, ".d.ts")
      )
        continue;
      warnings.push({
        rule: "similar-name",
        path: paths.join(", "),
        reason: "Review roles of filenames differing only by extension",
      });
    }
    if (migrationPhase !== undefined) {
      const phase = phaseNumber(migrationPhase);
      if (phase < 0) throw new Error("Migration phase must be P0 through P8");
      manifest ??= JSON.parse(
        readFileSync(
          resolve(root, "docs/code-organization-moves.json"),
          "utf8",
        ),
      );
      if (
        !manifest?.baseline ||
        !Array.isArray(manifest.entries) ||
        !Array.isArray(manifest.additions)
      )
        throw new Error("Invalid migration manifest");
      const origins = new Set(),
        destinations = new Set(),
        expected = new Set();
      for (const entry of manifest.entries) {
        if (
          !entry ||
          !validPath(entry.from) ||
          !validPath(entry.to) ||
          (entry.phase !== "keep" && phaseNumber(entry.phase) < 0)
        )
          throw new Error("Invalid migration entry");
        if (basename(entry.from) !== basename(entry.to))
          fail(
            "manifest-basename",
            entry.to,
            `Basename changed from ${entry.from}`,
          );
        if (origins.has(entry.from.toLowerCase()))
          fail("manifest-origin", entry.from, "Duplicate source entry");
        if (destinations.has(entry.to.toLowerCase()))
          fail("manifest-destination", entry.to, "Duplicate destination entry");
        origins.add(entry.from.toLowerCase());
        destinations.add(entry.to.toLowerCase());
        const path =
          entry.phase === "keep" || phaseNumber(entry.phase) <= phase
            ? entry.to
            : entry.from;
        if (expected.has(path))
          fail("manifest-collision", path, "Phase has overlapping file paths");
        expected.add(path);
      }
      const additions = new Set();
      for (const entry of manifest.additions) {
        if (
          !entry ||
          !validPath(entry.path) ||
          phaseNumber(entry.phase) < 0 ||
          typeof entry.reason !== "string" ||
          !entry.reason.trim()
        )
          throw new Error("Invalid migration addition");
        const name = entry.path.toLowerCase();
        if (additions.has(name) || origins.has(name) || destinations.has(name))
          fail(
            "manifest-addition",
            entry.path,
            "Duplicate or overlapping addition",
          );
        additions.add(name);
        if (phaseNumber(entry.phase) <= phase) expected.add(entry.path);
      }
      const actual = new Set(files);
      // Additions also include the manifest and CI outside the source roots.
      for (const entry of manifest.additions)
        if (
          !rules.sourceRoots.some((path) =>
            entry.path.startsWith(path + "/"),
          ) &&
          regularFile(root, entry.path)
        )
          actual.add(entry.path);
      for (const path of expected)
        if (!actual.has(path))
          fail("manifest-missing", path, `Expected at ${migrationPhase}`);
      for (const path of actual)
        if (!expected.has(path))
          fail(
            "manifest-unregistered",
            path,
            `Unexpected at ${migrationPhase}`,
          );
    }
  } catch (error) {
    configError(".", error.message);
  }
  return { errors, warnings, files };
}

export function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--migration-phase"))
    throw new Error(
      "Usage: check-code-organization.mjs [--migration-phase Pn]",
    );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const rules = JSON.parse(
    readFileSync(
      new URL("./code-organization-rules.json", import.meta.url),
      "utf8",
    ),
  );
  const result = checkCodeOrganization({
    root,
    rules,
    migrationPhase: args[1],
  });
  for (const issue of [...result.errors, ...result.warnings])
    console[result.errors.includes(issue) ? "error" : "warn"](
      `${issue.rule} / ${issue.path} / ${issue.reason}`,
    );
  console.log(
    `Structure: ${result.files.length} files, ${result.errors.length} errors, ${result.warnings.length} review notices`,
  );
  process.exitCode = result.errors.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    main();
  } catch (error) {
    console.error(`config / . / ${error.message}`);
    process.exitCode = 1;
  }
