import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { openDatabase } from "../server/db.mjs";
import { createCellEvents } from "../server/cell-events.mjs";
import { createDocumentEvents } from "../server/document-events.mjs";
import {
  installEventStreams,
  registerEventRoute,
} from "../server/event-streams.mjs";

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
