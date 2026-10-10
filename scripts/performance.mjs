import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
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
import { DEFAULT_SETTINGS, weeksForYear, dateKey } from "../shared/domain.js";

const dir = mkdtempSync(join(tmpdir(), "weekly-perf-")),
  db = openDatabase(join(dir, "perf.sqlite")),
  team = id(),
  tasks = [],
  tokens = [],
  n = now(),
  hash = passwordHash("performance-test-only");
let server, browser;
const measure = async (fn) => {
  const start = performance.now();
  await fn();
  return Math.round(performance.now() - start);
};
const p95 = (times) =>
  times.toSorted((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
try {
  console.log("10,000행 · 일정 60열 중 30% 입력 · 100명 계정을 생성합니다.");
  transaction(db, () => {
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      team,
      "성능 검증팀",
      json(DEFAULT_SETTINGS),
    );
    const userIds = [];
    const addUser = db.prepare(
        "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
      ),
      membership = db.prepare(
        "INSERT INTO memberships(user_id,team_id) VALUES(?,?)",
      ),
      session = db.prepare("INSERT INTO sessions VALUES(?,?,?)");
    for (let i = 0; i < 100; i++) {
      const uid = id(),
        token = randomBytes(32).toString("hex");
      userIds.push(uid);
      addUser.run(
        uid,
        `perf-${i}`,
        `검증${i}`,
        hash,
        i === 0 ? "admin" : "user",
        n,
      );
      membership.run(uid, team);
      session.run(
        createHash("sha256").update(token).digest("hex"),
        uid,
        Date.now() + 3600000,
      );
      tokens.push(token);
    }
    const addTask = db.prepare(
        "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ),
      addCell = db.prepare("INSERT INTO cells VALUES(?,?,?,?,?)");
    const weeks = Array.from({ length: 60 }, (_, i) =>
      dateKey(
        new Date(Date.parse(weeksForYear(2026)[0].key) + i * 7 * 86400000),
      ),
    );
    for (let i = 0; i < 10000; i++) {
      const tid = id();
      tasks.push(tid);
      addTask.run(tid, team, "[2026]", i, userIds[i % 100], n, n);
      for (const [key, value] of Object.entries({
        title: `검증 업무 ${i}`,
        description: "한글 일정과 서식 저장을 검증하는 업무입니다.",
        owner: userIds[i % 100],
        supporters: [],
        status: "진행 중",
        category: "UX 개선",
      }))
        addCell.run(tid, key, json(value), "{}", 1);
      for (let w = 0; w < 60; w++)
        if ((i * 7 + w) % 10 < 3)
          addCell.run(
            tid,
            weeks[w],
            json("진행 · 검토"),
            json({ backgroundColor: "#d1eee6" }),
            1,
          );
    }
  });
  server = createApp({ db, rateLimits: false }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const reads = await Promise.all(
    tokens.slice(0, 30).map((token) =>
      measure(async () => {
        const r = await fetch(`${url}/api/tasks?teamId=${team}&year=2026`, {
          headers: { Cookie: `weekly_session=${token}` },
        });
        if (!r.ok) throw new Error("조회 실패");
        await r.arrayBuffer();
      }),
    ),
  );
  console.log("동시 30명 조회 p95:", p95(reads), "ms");
  const writes = await Promise.all(
    tokens.slice(0, 30).map((token, i) =>
      measure(async () => {
        const r = await fetch(`${url}/api/cells/batch`, {
          method: "POST",
          headers: {
            Cookie: `weekly_session=${token}`,
            "X-Requested-With": "WeeklyPlan",
            "Content-Type": "application/json",
          },
          body: json({
            operationId: id(),
            changes: [
              {
                taskId: tasks[i],
                key: "title",
                expectedVersion: 1,
                value: `변경 업무 ${i}`,
              },
            ],
          }),
        });
        if (!r.ok) throw new Error("저장 실패 " + (await r.text()));
        await r.arrayBuffer();
      }),
    ),
  );
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  await context.addCookies([{ name: "weekly_session", value: tokens[0], url }]);
  const page = await context.newPage();
  const loads = [],
    filters = [];
  for (let i = 0; i < 10; i++) {
    loads.push(
      await measure(async () => {
        await page.goto(url);
        await page
          .locator('[data-column="title"]')
          .first()
          .waitFor({ state: "visible" });
      }),
    );
    filters.push(
      await measure(async () => {
        await page.getByLabel("전체 속성 검색").fill("검증 업무 9999");
        await page.waitForFunction(
          () =>
            document.querySelector(".search-count")?.textContent === "1 / 1" &&
            !!document.querySelector('[data-column="title"].focused'),
        );
      }),
    );
    await page.getByLabel("전체 속성 검색").fill("");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-column="title"]').length > 1,
    );
  }
  const report = {
    measuredAt: now(),
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0].model,
      cores: cpus().length,
      memoryGB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      network: "same-machine loopback; no throttling",
      browser: await browser.version(),
    },
    dataset: {
      users: 100,
      concurrent: 30,
      tasks: 10000,
      scheduleColumnsStored: 60,
      yearColumnsDisplayed: weeksForYear(2026).length,
      fillPercent: 30,
    },
    results: {
      concurrentReadsP95Ms: p95(reads),
      concurrentWritesP95Ms: p95(writes),
      editablePageP95Ms: p95(loads),
      filterP95Ms: p95(filters),
      renderedTaskRows: await page.locator('[data-column="title"]').count(),
    },
    samples: { reads, writes, loads, filters },
    limits:
      "Local development benchmark. Production acceptance requires agreed hardware, 30 independent browser sessions and network conditions.",
  };
  mkdirSync("docs/validation", { recursive: true });
  writeFileSync(
    "docs/validation/performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report.results, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
