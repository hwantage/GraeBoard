import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get as httpsGet } from "node:https";

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    // The server's cert is self-signed for this test only.
    httpsGet(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
}

function spawnServer(directory, env) {
  return spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      DB_PATH: join(directory, "test.sqlite"),
      DOCUMENT_IMAGES_DIR: join(directory, "images"),
      GRAEBOARD_SYNC_PROFILES: "[]",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test(
  "actual server entry terminates TLS directly when TLS_CERT_FILE/TLS_KEY_FILE are set",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "graeboard-tls-"));
    const certFile = join(directory, "server.crt"),
      keyFile = join(directory, "server.key");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);
    const child = spawnServer(directory, {
      TLS_CERT_FILE: certFile,
      TLS_KEY_FILE: keyFile,
    });
    let output = "",
      errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    try {
      const address = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/GraeBoard: https:\/\/127\.0\.0\.1:(\d+)/);
          if (match) resolve(Number(match[1]));
        });
        child.once("exit", () =>
          reject(new Error("Server exited before startup: " + errors)),
        );
      });
      const status = await fetchStatus(
        `https://127.0.0.1:${address}/api/health`,
      );
      assert.equal(status, 200);
    } finally {
      // Wait for the real process exit (not just the signal) before removing
      // its SQLite file: a cleanup that races the exit, including from a
      // t.after() hook, leaves the file transiently locked on Windows.
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "actual server entry refuses to start when only one of TLS_CERT_FILE/TLS_KEY_FILE is set",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "graeboard-tls-partial-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const certFile = join(directory, "server.crt");
    writeFileSync(certFile, "not a real certificate");
    const child = spawnServer(directory, { TLS_CERT_FILE: certFile });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(errors, /TLS_CERT_FILE과 TLS_KEY_FILE은 함께 지정/);
  },
);
