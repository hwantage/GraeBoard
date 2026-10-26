import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { openDatabase } from "../server/db.mjs";
import { createCellEvents } from "../server/cell-events.mjs";
import { createDocumentEvents } from "../server/document-events.mjs";
import {
  installEventStreams,
  registerEventRoute,
} from "../server/event-streams.mjs";

test(
  "actual server entry bounds SIGTERM with an unfinished HTTP body and preserves durable pending bytes",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "graeboard-shutdown-"));
    const path = join(directory, "test.sqlite"),
      teamId = randomUUID(),
      opId = randomUUID();
    const db = openDatabase(path);
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(teamId, "shutdown", "{}");
    const payload = JSON.stringify({
      opId,
      protocol: 1,
      reducer: 1,
      repoId: randomUUID(),
      teamId,
      writerEpoch: randomUUID(),
      actorRef: randomUUID(),
      createdAt: new Date().toISOString(),
      dependsOn: [],
      objects: [],
      changes: [
        {
          entity: "person",
          key: [randomUUID()],
          generation: randomUUID(),
          baseVersion: null,
          action: "create",
          base: null,
          desired: { name: "preserved across forced shutdown" },
          fields: ["name"],
        },
      ],
    });
    db.prepare(
      "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES(?,?,?,'pending',?)",
    ).run(opId, teamId, payload, new Date().toISOString());
    db.close();
    const child = spawn(process.execPath, ["server/index.mjs"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "0",
        DB_PATH: path,
        DOCUMENT_IMAGES_DIR: join(directory, "images"),
        GRAEBOARD_SYNC_PROFILES: "[]",
        GRAEBOARD_SHUTDOWN_TIMEOUT_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    });
    // Read the actual bound port through a dedicated startup IPC-free log.
    const address = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/GraeBoard: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      child.once("exit", () =>
        reject(new Error("Server exited before startup: " + errors)),
      );
    });
    const socket = connect(address, "127.0.0.1");
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
      'POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{"username":',
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${address}/api/health`)).status,
      200,
    );
    const exit = once(child, "exit"),
      started = Date.now();
    child.kill("SIGTERM");
    const [code, signal] = await exit;
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 3000);
    assert.match(errors, /종료 대기 시간을 초과/);
    const restored = openDatabase(path);
    try {
      assert.equal(
        restored
          .prepare("SELECT payload FROM sync_outbox WHERE op_id=?")
          .get(opId).payload,
        payload,
      );
    } finally {
      restored.close();
    }
  },
);

test(
  "shutdown closes multiplexed subscriptions that finish registering after the hubs drain",
  { timeout: 3000 },
  async (t) => {
    const db = openDatabase(":memory:");
    const cells = createCellEvents(db),
      documents = createDocumentEvents((req) => req.user);
    const app = express();
    app.use(express.json());
    let release,
      entered,
      readsAfterShutdown = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    registerEventRoute(app, "/api/first/events", (req, res) =>
      documents.subscribe(req, res, "first", () => ({
        revision: 1,
        markdown: "before",
      })),
    );
    registerEventRoute(app, "/api/later/events", async (req, res) => {
      entered();
      await gate;
      documents.subscribe(req, res, "later", () => {
        readsAfterShutdown++;
        return { revision: 2, markdown: "must not reopen" };
      });
    });
    registerEventRoute(app, "/api/cells/events", (req, res) =>
      cells.subscribe(req, res, {
        teamId: "team",
        year: 2026,
        token: "expired",
      }),
    );
    installEventStreams(app);
    const server = app.listen(0, "127.0.0.1");
    let stopping = false;
    server.prependListener("request", (_request, response) =>
      response.once("finish", () => {
        if (stopping) setImmediate(() => server.closeIdleConnections());
      }),
    );
    await once(server, "listening");
    const abort = new AbortController();
    t.after(() => {
      abort.abort();
      release();
      cells.close();
      documents.close();
      server.closeAllConnections();
      server.close();
      db.close();
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/events`,
      {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streams: [
            { id: 1, path: "/api/first/events" },
            { id: 2, path: "/api/later/events" },
            { id: 3, path: "/api/cells/events" },
          ],
        }),
      },
    );
    await waiting;
    stopping = true;
    const drained = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    cells.shutdown();
    documents.shutdown();
    server.closeIdleConnections();
    release();
    const text = await response.text();
    await drained;
    assert.equal(readsAfterShutdown, 0);
    assert.doesNotMatch(text, /must not reopen|access-revoked/);
    assert.deepEqual(
      [...text.matchAll(/event: closed\ndata: (.+)/g)].map(
        (match) => JSON.parse(match[1]).id,
      ),
      [1, 2, 3],
    );
  },
);
