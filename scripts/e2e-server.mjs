import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, passwordHash } from "../server/db.mjs";
const dir = mkdtempSync(join(tmpdir(), "weekly-plan-browser-"));
const db = openDatabase(join(dir, "test.sqlite"));
const port = Number(process.env.E2E_PORT || 4311);
const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: { setupConfigPath: join(dir, ".env") },
  }),
  activeStreams = new Set(),
  server = createServer((req, res) => {
    // Test-server-only observation/control; never installed by createApp/start.
    const own = () =>
      [...activeStreams].filter(
        (entry) => entry.req.headers.cookie === req.headers.cookie,
      );
    if (req.headers.cookie && req.url === "/__test/streams") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          own().map(({ req: request }) => ({
            method: request.method,
            streams: request.body?.streams || [],
          })),
        ),
      );
      return;
    }
    if (
      req.headers.cookie &&
      req.url === "/__test/streams/disconnect" &&
      req.method === "POST"
    ) {
      for (const entry of own()) entry.res.destroy();
      res.end("ok");
      return;
    }
    if (
      req.headers.cookie &&
      req.url === "/__test/streams/expire-session" &&
      req.method === "POST"
    ) {
      const token = own()[0]?.req.cookies?.weekly_session;
      if (!token) {
        res.writeHead(409).end("No active session stream");
        return;
      }
      db.prepare("UPDATE sessions SET expires_at=? WHERE token=?").run(
        Date.now() - 1,
        createHash("sha256").update(token).digest("hex"),
      );
      // Keep the wire open; the real hub heartbeat must detect expiration.
      res.end("ok");
      return;
    }
    if (req.url.split("?")[0] === "/api/events") {
      const entry = { req, res };
      activeStreams.add(entry);
      res.on("close", () => activeStreams.delete(entry));
    }
    app(req, res);
  }).listen(port, "127.0.0.1", async () => {
    const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
      method: "POST",
      headers: {
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "test@somansa.com",
        password: randomUUID(),
        name: "지윤",
        teamName: "UX기획팀 · 예시",
        sample: true,
      }),
    });
    if (!setup.ok)
      throw new Error(`테스트 계정 초기화 실패: HTTP ${setup.status}`);
    const { user } = await setup.json();
    // Apply the short fixture password only to this isolated test database.
    db.prepare("UPDATE users SET password=? WHERE id=?").run(
      passwordHash("1234"),
      user.id,
    );
    console.log(`임시 브라우저 검증 서버: http://127.0.0.1:${port}`);
  });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.close(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  });
