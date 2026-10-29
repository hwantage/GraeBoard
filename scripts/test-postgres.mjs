import { accessSync, constants, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export function requirePostgresBinaries(value = process.env.TEST_PG_BIN) {
  if (!value)
    throw new Error(
      "Strict PostgreSQL validation requires TEST_PG_BIN=/absolute/PostgreSQL/bin; optional PostgreSQL suites must not be skipped.",
    );
  const bin = resolve(value);
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    try {
      const path = realpathSync(join(bin, name));
      accessSync(path, constants.X_OK);
      accessSync(join(dirname(path), "postgres"), constants.X_OK);
      const result = spawnSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (result.status !== 0 || !/PostgreSQL/.test(result.stdout))
        throw new Error("unusable executable");
    } catch {
      throw new Error(
        `Strict PostgreSQL validation cannot execute ${name} in TEST_PG_BIN; install a complete PostgreSQL server distribution.`,
      );
    }
  }
  return bin;
}

export async function main() {
  const bin = requirePostgresBinaries(),
    root = fileURLToPath(new URL("../", import.meta.url));
  const files = readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => "tests/" + name);
  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    {
      cwd: root,
      env: { ...process.env, TEST_PG_BIN: bin },
      stdio: "inherit",
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal)
        reject(new Error("Strict PostgreSQL validation terminated: " + signal));
      else {
        process.exitCode = code;
        resolve();
      }
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
