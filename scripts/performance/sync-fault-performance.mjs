// Real Worker API/Cron failures run in their own supported-size fixture. The
// caller measures an independent internal app; this is not a coupled 10k peer.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = mkdtempSync("/tmp/gb-worker-fault-perf-"),
  report = join(dir, "verified.json");
try {
  const child = spawn(
    process.execPath,
    ["--test", "tests/worker-sync-integration.test.mjs"],
    {
      cwd: process.cwd(),
      env: { ...process.env, WORKER_FAULT_REPORT: report },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(
      "Actual Worker fault integration failed: " + output.slice(-12000),
    );
  const result = JSON.parse(readFileSync(report, "utf8"));
  if (
    !result.verified ||
    result.internalPerformanceCoupled !== false ||
    !Object.values(result.checks || {}).length ||
    !Object.values(result.checks).every((value) => value === true)
  )
    throw new Error("Actual Worker fault assertions were not verified");
  console.log(
    JSON.stringify({
      ...result,
      pgUnavailable: true,
      r2Unavailable: true,
      fixture:
        "actual supported-size Worker PG/R2 faults in parallel with independent 10k internal availability; different application/data fixtures",
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
