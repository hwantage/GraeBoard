import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listNodeTestFiles } from "./node-test-files.mjs";

export async function runNodeTests({ root, env = process.env }) {
  const files = listNodeTestFiles(root);
  if (!files.length) throw new Error("No Node test suites found in tests/");
  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    { cwd: root, env, stdio: "inherit" },
  );
  let forwardedSignal;
  const forward = (signal) => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => forward(signal),
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  }
  if (forwardedSignal || result.signal)
    process.kill(process.pid, forwardedSignal || result.signal);
  else process.exitCode = result.code ?? 1;
}

export async function main() {
  const args = process.argv.slice(2);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (args.length === 1 && args[0] === "--list") {
    console.log(listNodeTestFiles(root).join("\n"));
    return;
  }
  if (args.length) throw new Error("Usage: run-node-tests.mjs [--list]");
  await runNodeTests({ root });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
