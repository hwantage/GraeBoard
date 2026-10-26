import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

// Run the production entrypoint with a private DB, so SIGTERM exercises the
// actual shutdown path and the next process retains sessions and documents.
export async function restartableServer() {
  const directory = mkdtempSync(join(tmpdir(), "weekly-plan-restart-"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const baseURL = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = "";
  const pids: number[] = [];
  async function start() {
    child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: join(directory, "test.sqlite"),
        DOCUMENT_IMAGES_DIR: join(directory, "images"),
        NODE_ENV: "test",
        APP_ORIGIN: baseURL,
        SETUP_TOKEN: "",
        COOKIE_SECURE: "0",
        TRUST_PROXY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    pids.push(child.pid!);
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null) throw new Error(output);
          return fetch(`${baseURL}/api/health`)
            .then((r) => r.status)
            .catch(() => 0);
        },
        { timeout: 10000 },
      )
      .toBe(200);
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
    child.kill("SIGTERM");
    try {
      const [code, signal] = await exited;
      expect({ code, signal }, output).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    baseURL,
    pids,
    start,
    stop,
    async dispose() {
      try {
        await stop();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
