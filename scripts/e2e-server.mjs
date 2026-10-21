import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  }),
  server = app.listen(port, "127.0.0.1", async () => {
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
