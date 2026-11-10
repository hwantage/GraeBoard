import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runNodeTests } from "./run-node-tests.mjs";

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
    root = fileURLToPath(new URL("../../", import.meta.url));
  await runNodeTests({
    root,
    env: { ...process.env, TEST_PG_BIN: bin },
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
