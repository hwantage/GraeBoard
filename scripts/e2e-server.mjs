import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
const port = Number(process.env.E2E_PORT || 4311);
const dir = mkdtempSync(join(tmpdir(), "weekly-plan-browser-"));
const db = openDatabase(join(dir, "test.sqlite"));
const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
  }),
  server = app.listen(port, "127.0.0.1", async () => {
    await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
      method: "POST",
      headers: {
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "browser-test@example.com",
        password: "local-test-only-password",
        name: "지윤",
        teamName: "UX기획팀 · 예시",
        sample: true,
      }),
    });
    console.log(`임시 브라우저 검증 서버: http://127.0.0.1:${port}`);
  });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    app.locals.cellEvents.close();
    server.close(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  });
