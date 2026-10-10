// 표 화면 반응 속도 측정: npm run build 후 node scripts/ui-performance.mjs [업무 수] [CPU 감속 배수]
// 셀 선택, 스크롤 프레임, 행 높이 조절의 지연을 브라우저에서 측정합니다.
// STATIC_DIR 환경 변수로 다른 빌드(dist)와 비교할 수 있습니다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  id,
  json,
  now,
  passwordHash,
  transaction,
} from "../server/db.mjs";
import { DEFAULT_SETTINGS, weeksForYear } from "../shared/domain.js";

const taskCount = Number(process.argv[2] || 2000),
  throttle = Number(process.argv[3] || 4);
const dir = mkdtempSync(join(tmpdir(), "weekly-ui-perf-")),
  db = openDatabase(join(dir, "perf.sqlite")),
  team = id(),
  token = randomBytes(32).toString("hex"),
  n = now();
let server, browser;
const stats = (xs) => {
  const s = xs.toSorted((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)];
  return { median: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
};
try {
  transaction(db, () => {
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      team,
      "성능 검증팀",
      json(DEFAULT_SETTINGS),
    );
    const uid = id();
    db.prepare(
      "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      uid,
      "perf",
      "검증",
      passwordHash("performance-test-only"),
      "admin",
      n,
    );
    db.prepare("INSERT INTO memberships VALUES(?,?)").run(uid, team);
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(token).digest("hex"),
      uid,
      Date.now() + 3600000,
    );
    const addTask = db.prepare(
        "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ),
      addCell = db.prepare("INSERT INTO cells VALUES(?,?,?,?,?)");
    const weeks = weeksForYear(2026).map((w) => w.key);
    for (let i = 0; i < taskCount; i++) {
      const tid = id();
      addTask.run(tid, team, "[2026]", i, uid, n, n);
      for (const [key, value] of Object.entries({
        title: `검증 업무 ${i}`,
        owner: uid,
        status: "진행 중",
        category: "UX 개선",
      }))
        addCell.run(tid, key, json(value), "{}", 1);
      weeks.forEach((week, w) => {
        if ((i * 7 + w) % 10 < 3)
          addCell.run(
            tid,
            week,
            json("진행 · 검토"),
            json({ backgroundColor: "#d1eee6" }),
            1,
          );
      });
    }
  });
  server = createApp({
    db,
    rateLimits: false,
    ...(process.env.STATIC_DIR ? { staticDir: process.env.STATIC_DIR } : {}),
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([{ name: "weekly_session", value: token, url }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(url);
  await page.locator('[data-column="title"]').first().waitFor();
  await page.waitForTimeout(500);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });

  // 다음 화면 그리기까지 기다림 (React 커밋 → 페인트)
  const frame = `() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))`;

  // 1. 셀 클릭 → 선택 테두리
  const select = await page.evaluate(async (frameSrc) => {
    const next = eval(frameSrc);
    const times = [];
    const cells = [
      ...document.querySelectorAll(".sheet-row .sheet-cell.week-cell"),
    ].filter((_, i) => i % 37 === 0);
    for (const el of cells.slice(0, 15)) {
      const t = performance.now();
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          pointerId: 1,
        }),
      );
      while (!el.isConnected || !el.classList.contains("focused")) {
        const fresh = document.querySelector(
          `[data-cell="${el.dataset.cell}"]`,
        );
        if (fresh?.classList.contains("focused")) break;
        await next();
      }
      await next();
      times.push(performance.now() - t);
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }
    return times;
  }, frame);

  // 2. 스크롤 — 한 번 스크롤할 때마다 새 행을 그리는 프레임 시간
  const scroll = await page.evaluate(async () => {
    const grid = document.querySelector(".sheet-scroll");
    const frames = [];
    grid.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 300));
    let last = performance.now();
    for (let i = 0; i < 60; i++) {
      grid.scrollTop += 260;
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      frames.push(t - last);
      last = t;
    }
    return frames;
  });

  // 3. 행 높이 조절 드래그
  const resize = await page.evaluate(async (frameSrc) => {
    const next = eval(frameSrc);
    const grid = document.querySelector(".sheet-scroll");
    grid.scrollTop = 0;
    await next();
    const row = document.querySelector(".sheet-row");
    const id = row.dataset.rowId;
    const handle = row.querySelector(".row-resizer");
    const y0 = handle.getBoundingClientRect().top;
    const start = row.getBoundingClientRect().height;
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientY: y0,
      }),
    );
    const times = [];
    for (let i = 1; i <= 25; i++) {
      const t = performance.now();
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientY: y0 + i * 3, buttons: 1 }),
      );
      for (let k = 0; k < 60; k++) {
        const h = document
          .querySelector(`[data-row-id="${id}"]`)
          ?.getBoundingClientRect().height;
        if (Math.abs(h - (start + i * 3)) < 1.5) break;
        await next();
      }
      times.push(performance.now() - t);
    }
    window.dispatchEvent(new PointerEvent("pointerup", { clientY: y0 + 75 }));
    return times;
  }, frame);

  // 4. 열 너비 조절 드래그 (업무 열)
  const columnResize = await page.evaluate(async (frameSrc) => {
    const next = eval(frameSrc);
    const header = document.querySelector('[data-header-key="title"]');
    const handle = header.querySelector(".column-resizer");
    const x0 = handle.getBoundingClientRect().left;
    const start = header.getBoundingClientRect().width;
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: x0,
      }),
    );
    const times = [];
    for (let i = 1; i <= 25; i++) {
      const t = performance.now();
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: x0 + i * 4, buttons: 1 }),
      );
      for (let k = 0; k < 60; k++) {
        const cell = document.querySelector('.sheet-row [data-column="title"]');
        const w = cell?.getBoundingClientRect().width;
        if (Math.abs(w - (start + i * 4)) < 1.5) break;
        await next();
      }
      times.push(performance.now() - t);
    }
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + 100 }));
    return times;
  }, frame);

  const result = {
    tasks: taskCount,
    cpuThrottle: `${throttle}x`,
    renderedCells: await page.locator(".sheet-cell").count(),
    selectMs: stats(select),
    scrollFrameMs: stats(scroll),
    rowResizeStepMs: stats(resize),
    columnResizeStepMs: stats(columnResize),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
