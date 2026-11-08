import { spawnSync } from "node:child_process";
import { frozenCutoverSource } from "../../tests/support/frozen-cutover-source.mjs";

if (!process.env.TEST_PG_BIN)
  throw new Error(
    "Frozen cutover validation requires TEST_PG_BIN=/absolute/PostgreSQL/bin",
  );
const source = frozenCutoverSource();
console.log(`Frozen cutover commit ${source.commit}; Node ${process.version}`);
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "tests/sheet-clone-conversion.test.mjs",
    "tests/sheet-clone-cutover.test.mjs",
  ],
  { cwd: source.root, env, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
