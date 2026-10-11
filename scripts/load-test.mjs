import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";
import {
  openDatabase,
  transaction,
  id,
  now,
  json,
  passwordHash,
} from "../server/db.mjs";
import {
  DEFAULT_SETTINGS,
  sampleProperties,
  weeksForYear,
} from "../shared/domain.js";

const scenarios = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => {
      const [rows, fill] = s.split(":").map(Number);
      return { rows, fill };
    })
  : [
      { rows: 1000, fill: 30 },
      { rows: 10000, fill: 30 },
      { rows: 20000, fill: 100 },
    ];
const outputDirectory = new URL("../docs/validation/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
const out = new URL("load-test-results.json", outputDirectory);
const report = {
  measuredAt: now(),
  environment: {
    cpu: cpus()[0].model,
    cores: cpus().length,
    memoryGB: totalmem() / 1024 ** 3,
    node: process.version,
    network: "loopback; separate server process; unthrottled Chromium",
  },
  scenarios: [],
};
const ms = () => performance.now();
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: Math.round(s[Math.ceil(s.length * 0.5) - 1]),
    p95: Math.round(s[Math.ceil(s.length * 0.95) - 1]),
    max: Math.round(s.at(-1)),
  };
};
const serverCode = `
import {createApp} from ${JSON.stringify(new URL("../server/app.mjs", import.meta.url).href)};
const app=createApp({allowSetup:false});
const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',m=>{if(m==='memory')process.send({memory:process.memoryUsage()});});
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{app.locals.db.close();process.exit(0)});});
`;
for (const scenario of scenarios) {
  assert(
    scenario.rows >= 1000 &&
      scenario.rows <= 20000 &&
      scenario.fill >= 1 &&
      scenario.fill <= 100,
  );
  const dir = mkdtempSync(join(tmpdir(), "graeboard-stress-")),
    db = openDatabase(join(dir, "test.sqlite"));
  const team = id(),
    userIds = [],
    tokens = [],
    taskIds = [],
    timestamp = now(),
    weeks = weeksForYear(2026);
  const settings = { ...DEFAULT_SETTINGS, properties: sampleProperties() };
  const optionIds = (key) =>
    settings.properties.find((p) => p.id === key).values.map((v) => v.id);
  const statusIds = optionIds("status"),
    categoryIds = optionIds("category"),
    typeIds = optionIds("type");
  const result = {
    ...scenario,
    scheduleColumns: weeks.length,
    concurrent: 30,
    checks: {},
    timings: {},
  };
  let server,
    browser,
    serverErrors = "";
  try {
    console.log(
      `Starting ${scenario.rows} rows, ${scenario.fill}% schedule occupancy`,
    );
    let start = ms();
    transaction(db, () => {
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        team,
        "대량 검증팀",
        json(settings),
      );
      const addUser = db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
      );
      const addMember = db.prepare(
          "INSERT INTO memberships(user_id,team_id) VALUES(?,?)",
        ),
        addSession = db.prepare("INSERT INTO sessions VALUES(?,?,?)");
      const hash = passwordHash("load-test-only-password");
      for (let i = 0; i < 100; i++) {
        const uid = id(),
          token = randomBytes(32).toString("hex");
        userIds.push(uid);
        tokens.push(token);
        addUser.run(
          uid,
          `load-${i}`,
          `검증팀원${i}`,
          hash,
          i === 0 ? "admin" : "user",
          timestamp,
        );
        addMember.run(uid, team);
        addSession.run(
          createHash("sha256").update(token).digest("hex"),
          uid,
          Date.now() + 3600000,
        );
      }
      const addTask = db.prepare(
        "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      );
      const addCell = db.prepare("INSERT INTO cells VALUES(?,?,?,?,?)");
      for (let i = 0; i < scenario.rows; i++) {
        const tid = id();
        taskIds.push(tid);
        addTask.run(
          tid,
          team,
          "[2026]",
          i * 100,
          userIds[i % 100],
          timestamp,
          timestamp,
        );
        const fields = {
          title: `검증 업무 ${String(i).padStart(5, "0")}`,
          description: `기획 검토 및 구현 사항 ${i}\n두 번째 줄: 일정과 담당자 확인`,
          owner: userIds[i % 100],
          supporters: [userIds[(i + 1) % 100]],
          status: statusIds[i % statusIds.length],
          category: categoryIds[i % categoryIds.length],
          type: typeIds[i % typeIds.length],
          progress: `${i % 101}%`,
          deadline: "2026-12-31",
          score: i % 100,
          current: i % 50,
        };
        for (const [key, value] of Object.entries(fields))
          addCell.run(tid, key, json(value), "{}", 1);
        for (let w = 0; w < weeks.length; w++)
          if ((i * 37 + w * 13) % 100 < scenario.fill)
            addCell.run(
              tid,
              weeks[w].key,
              json(
                `업무 ${i} / ${w + 1}주: 화면 설계와 개발 검토 #${100000 + ((i * 53 + w) % 900000)}\n확인 후 협의 진행`,
              ),
              json({
                backgroundColor: i % 2 ? "#e7effb" : "#d1eee6",
                fontSize: 9,
                textMode: "wrap",
                verticalAlign: "top",
              }),
              1,
            );
      }
    });
    result.timings.seedMs = Math.round(ms() - start);
    result.storedCells = db.prepare("SELECT COUNT(*) n FROM cells").get().n;
    server = spawn(
      process.execPath,
      ["--input-type=module", "-e", serverCode],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_PATH: join(dir, "test.sqlite"),
          NODE_ENV: "development",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    server.stderr.on("data", (c) => (serverErrors += c));
    const ready = await Promise.race([
      once(server, "message"),
      once(server, "exit").then(() => {
        throw Error("Server exited: " + serverErrors);
      }),
    ]);
    const base = `http://127.0.0.1:${ready[0].port}`;
    const request = async (
      path,
      {
        token = tokens[0],
        data,
        method = data ? "POST" : "GET",
        headers = {},
        discard = false,
      } = {},
    ) => {
      const start = ms();
      const response = await fetch(base + path, {
        method,
        headers: {
          Cookie: `weekly_session=${token}`,
          "X-Requested-With": "WeeklyPlan",
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: data ? json(data) : undefined,
        signal: AbortSignal.timeout(120000),
      });
      let body;
      if (discard) {
        let bytes = 0;
        for await (const chunk of response.body) bytes += chunk.byteLength;
        body = { byteLength: bytes };
      } else body = await response.arrayBuffer();
      return { response, body, elapsed: ms() - start };
    };
    const path = `/api/tasks?teamId=${team}&year=2026`;
    let read = await request(path);
    assert.equal(read.response.status, 200);
    const tasks = JSON.parse(Buffer.from(read.body)).tasks;
    assert.equal(tasks.length, scenario.rows);
    assert.equal(
      tasks.reduce((n, t) => n + Object.keys(t.cells).length, 0),
      result.storedCells,
    );
    result.timings.coldReadMs = Math.round(read.elapsed);
    result.payload = {
      jsonBytes: read.body.byteLength,
      gzipBytes: Number(read.response.headers.get("content-length")),
    };
    let etag = read.response.headers.get("etag");
    const readTimes = [],
      cachedTimes = [],
      writeTimes = [];
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        tokens.slice(0, 30).map(async (token) => {
          const r = await request(path, { token, discard: true });
          assert.equal(r.response.status, 200);
          assert.equal(r.body.byteLength, read.body.byteLength);
          readTimes.push(r.elapsed);
        }),
      );
      await Promise.all(
        tokens.slice(0, 30).map(async (token) => {
          const r = await request(path, {
            token,
            headers: { "If-None-Match": etag },
          });
          assert.equal(r.response.status, 304);
          cachedTimes.push(r.elapsed);
        }),
      );
      await Promise.all(
        tokens.slice(0, 30).map(async (token, i) => {
          const r = await request("/api/cells/batch", {
            token,
            data: {
              operationId: id(),
              changes: [
                {
                  taskId: taskIds[i],
                  key: "description",
                  expectedVersion: round + 1,
                  value: `동시 수정 ${round}/${i}`,
                },
              ],
            },
          });
          assert.equal(r.response.status, 200);
          writeTimes.push(r.elapsed);
        }),
      );
      // Refresh the baseline after writes invalidate the versioned response.
      read = await request(path);
      etag = read.response.headers.get("etag");
      if (round < 2) {
        const warm = await Promise.all(
          tokens.slice(0, 30).map((token) =>
            request(path, {
              token,
              headers: { "If-None-Match": read.response.headers.get("etag") },
            }),
          ),
        );
        warm.forEach((r) => assert.equal(r.response.status, 304));
      }
    }
    result.timings.read30 = stats(readTimes);
    result.timings.write30 = stats(writeTimes);
    result.timings.unchanged30 = stats(cachedTimes);
    result.checks.concurrentWrites = 90;
    const changes = taskIds.slice(100, 2100).map((taskId) => ({
      taskId,
      key: "title",
      expectedVersion: 1,
      style: { fontSize: 6, backgroundColor: "#e7effb" },
    }));
    const batch = { operationId: id(), changes };
    const batchResult = await request("/api/cells/batch", { data: batch });
    assert.equal(batchResult.response.status, 200);
    result.timings.batchCells = changes.length;
    result.timings.batchMs = Math.round(batchResult.elapsed);
    const repeat = await request("/api/cells/batch", { data: batch });
    assert.equal(repeat.response.status, 200);
    assert.deepEqual(Buffer.from(repeat.body), Buffer.from(batchResult.body));
    const conflict = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        request("/api/cells/batch", {
          data: {
            operationId: id(),
            changes: [
              {
                taskId: taskIds.at(-1),
                key: "description",
                expectedVersion: 1,
                value: `競合${i}`,
              },
            ],
          },
        }),
      ),
    );
    assert.equal(conflict.filter((r) => r.response.status === 200).length, 1);
    assert.equal(conflict.filter((r) => r.response.status === 409).length, 29);
    result.checks.conflict = { saved: 1, rejected: 29 };
    result.checks.idempotentBatch = true;
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    await context.addCookies([
      { name: "weekly_session", value: tokens[0], url: base },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    });
    const loadTimes = [],
      filterTimes = [];
    for (let i = 0; i < 5; i++) {
      start = ms();
      await page.goto(base);
      await expect(page.locator('[data-column="title"]').first()).toBeVisible();
      await expect(page.getByRole("grid")).toHaveAttribute(
        "aria-rowcount",
        String(scenario.rows + 1),
      );
      loadTimes.push(ms() - start);
      start = ms();
      await page
        .getByLabel("전체 속성 검색")
        .fill(`검증 업무 ${String(scenario.rows - 1).padStart(5, "0")}`);
      await expect(page.locator(".search-count")).toHaveText("1 / 1");
      await expect(page.locator('[data-column="title"].focused')).toBeVisible();
      filterTimes.push(ms() - start);
      await page.getByLabel("전체 속성 검색").fill("");
      await expect(page.getByRole("grid")).toHaveAttribute(
        "aria-rowcount",
        String(scenario.rows + 1),
      );
    }
    result.timings.browserLoads = stats(loadTimes);
    result.timings.searches = stats(filterTimes);
    // 검색이 마지막 행으로 스크롤해 두므로, 첫 묶음 머리글이 보이도록 맨 위로 되돌린다.
    await page.getByRole("grid").evaluate((el) => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
    start = ms();
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true })
      .click();
    await expect(page.locator(".group-heading").first()).toBeVisible();
    result.timings.groupMs = Math.round(ms() - start);
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "묶음 해제", exact: true })
      .click();
    const grid = page.getByRole("grid");
    const scrollTimes = [];
    for (const fraction of [0.5, 1, 0, 0.8, 0]) {
      start = ms();
      await grid.evaluate((el, fraction) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
        el.scrollLeft = 0;
      }, fraction);
      if (fraction === 1)
        await expect(
          page.locator(`[data-cell="${taskIds.at(-1)}:title"]`),
        ).toBeVisible();
      else if (fraction === 0)
        await expect(
          page.locator(`[data-cell="${taskIds[0]}:title"]`),
        ).toBeVisible();
      else
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
      scrollTimes.push(ms() - start);
    }
    result.timings.scroll = stats(scrollTimes);
    result.renderedRows = await page.locator('[data-column="title"]').count();
    assert(result.renderedRows < 100);
    const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
    await first.dblclick();
    await page
      .locator(".inline-editor textarea")
      .fill("UI에서 저장한 대량 업무");
    start = ms();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      page.locator(".inline-editor textarea").press("Enter"),
    ]);
    await expect(first).toHaveText("UI에서 저장한 대량 업무");
    result.timings.uiEditMs = Math.round(ms() - start);
    await page.reload();
    await expect(first).toHaveText("UI에서 저장한 대량 업무");
    result.checks.uiEditPersisted = true;
    await page.screenshot({
      path: new URL(
        `load-test-${scenario.rows}-${scenario.fill}.png`,
        outputDirectory,
      ).pathname,
    });
    result.browserLongTasks = await page.evaluate(() => ({
      count: window.__longTasks.length,
      maxMs: Math.round(Math.max(0, ...window.__longTasks)),
    }));
    assert.deepEqual(errors, []);
    result.checks.browserErrors = errors;
    const dbVersion = db
      .prepare("SELECT version FROM cells WHERE task_id=? AND key='title'")
      .get(taskIds[100]).version;
    assert.equal(dbVersion, 2);
    result.checks.batchPersisted = true;
    const memoryPromise = once(server, "message");
    server.send("memory");
    result.serverMemory = (await memoryPromise)[0].memory;
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.stack;
    result.serverFailure = serverErrors.slice(-6000);
    result.serverExit = { code: server?.exitCode, signal: server?.signalCode };
    console.error(error);
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
    report.scenarios.push(result);
    writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  }
}
if (report.scenarios.some((s) => s.status !== "passed")) process.exitCode = 1;
