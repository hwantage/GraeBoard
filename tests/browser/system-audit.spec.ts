import { unpack } from "../../shared/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.mjs";
import { openDatabase, json } from "../../server/db.mjs";
import { todayKey } from "../../shared/domain.js";

let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string, leadId: string, historyDay: string;
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`${base}/api${path}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
const settings = (page: Page) =>
  page.getByRole("dialog", { name: "설정", exact: true });
async function openAllLogs(page: Page) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await settings(page)
    .getByRole("button", { name: "감사 로그", exact: true })
    .click();
  const panel = settings(page).getByRole("region", {
    name: "감사 로그",
    exact: true,
  });
  await expect(panel.getByLabel("시작 날짜")).toHaveValue(todayKey());
  await expect(panel.getByLabel("종료 날짜")).toHaveValue(todayKey());
  await expect(panel.locator("details")).toHaveCount(1);
  await panel.getByLabel("시작 날짜").fill("");
  await panel.getByLabel("종료 날짜").fill("");
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(50);
  return panel;
}
test.beforeEach(async ({ page }) => {
  db = openDatabase(":memory:");
  app = createApp({ db, rateLimits: false });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { user } = await post(page, "/auth/setup", {
    username: "audit-admin@example.com",
    password: "local-test-only-password",
    name: "감사 관리자",
    teamName: "감사 검증팀",
  });
  const created = await post(page, "/admin/users", {
    username: "audit-lead@example.com",
    password: "local-test-only-password",
    name: "감사 팀장",
    memberships: [{ teamId: user.teamIds[0], role: "lead" }],
  });
  leadId = created.user.id;
  historyDay = new Date(Date.parse(`${todayKey()}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  for (let i = 0; i < 60; i++)
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
      randomUUID(),
      null,
      i % 2 ? user.id : leadId,
      "profile",
      leadId,
      json({ name: `이전 이름 ${i}`, hasAvatarImage: false }),
      json({ name: `변경 이름 ${i}`, hasAvatarImage: true }),
      new Date(
        Date.parse(`${historyDay}T09:00:00+09:00`) + i * 60000,
      ).toISOString(),
    );
  await page.goto(base);
  await expect(page.locator(".workspace")).toBeVisible();
});
test.afterEach(async () => {
  app.locals.cellEvents.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

test("공통 감사 로그를 페이지·기간·수행자·종류로 조회하고 펼친 항목의 전후 값만 가져온다", async ({
  page,
}, info) => {
  const detailRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/admin\/audit\/[0-9a-f-]+$/.test(request.url()))
      detailRequests.push(request.url());
  });
  const panel = await openAllLogs(page);
  expect(detailRequests).toHaveLength(0);
  await panel.getByRole("button", { name: "다음", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(11);
  await expect(panel.locator(".system-audit-count")).toContainText("2페이지");
  await panel.getByRole("button", { name: "이전", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(50);
  await panel.getByLabel("시작 날짜").fill(historyDay);
  await panel.getByLabel("종료 날짜").fill(historyDay);
  await panel.getByLabel("수행자").selectOption(leadId);
  await panel.getByLabel("작업 종류").selectOption("profile");
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(30);
  await expect(panel.locator(".system-audit-count")).toContainText("1페이지");
  await expect(
    panel.getByRole("button", { name: "다음", exact: true }),
  ).toBeDisabled();
  const entry = panel.locator("details").first();
  await expect(entry.locator("summary")).toContainText("수행자: 감사 팀장");
  await entry.locator("summary").click();
  const table = entry.getByRole("table", { name: "변경 전·후 상세" });
  await expect(table).toContainText("이전 이름 58");
  await expect(table).toContainText("변경 이름 58");
  expect(detailRequests).toHaveLength(1);
  await entry.locator("summary").click();
  await entry.locator("summary").click();
  await expect(table).toBeVisible();
  expect(detailRequests).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("system-audit-detail.png") });
  await panel.getByLabel("시작 날짜").fill("2020-01-01");
  await panel.getByLabel("종료 날짜").fill("2020-01-01");
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await expect(panel).toContainText("조건에 맞는 감사 로그가 없습니다.");
  await panel.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(1);
  await expect(panel.getByLabel("시작 날짜")).toHaveValue(todayKey());
  await expect(panel.getByLabel("종료 날짜")).toHaveValue(todayKey());
  await expect(panel.getByLabel("수행자")).toHaveValue("");
  await expect(panel.getByLabel("작업 종류")).toHaveValue("");
});

test("늦은 검색 응답은 새 조건의 결과를 덮지 않고 상세 조회 오류는 재시도할 수 있다", async ({
  page,
}) => {
  const panel = await openAllLogs(page);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(`${base}/api/admin/audit?*`, async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("action") !== "password"
    )
      return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await panel.getByLabel("작업 종류").selectOption("password");
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await pending;
  await panel.getByLabel("작업 종류").selectOption("profile");
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(50);
  release();
  let calls = 0;
  await page.route(`${base}/api/admin/audit/*`, async (route) => {
    if (++calls === 1)
      return route.fulfill({
        status: 503,
        json: { error: "일시적인 조회 실패" },
      });
    await route.continue();
  });
  const entry = panel.locator("details").first();
  await entry.locator("summary").click();
  await expect(entry.getByRole("alert")).toContainText("일시적인 조회 실패");
  await entry.getByRole("button", { name: "상세 다시 조회" }).click();
  await expect(
    entry.getByRole("table", { name: "변경 전·후 상세" }),
  ).toBeVisible();
  expect(calls).toBe(2);
  await expect(panel.locator("details")).toHaveCount(50);
});

test("로그인 화면으로 접속하면 오늘 감사 로그에서 로그인·로그아웃을 조회할 수 있다", async ({
  page,
}, info) => {
  await post(page, "/auth/logout", {});
  await page.reload();
  await page
    .getByLabel("아이디(이메일)", { exact: true })
    .fill("audit-admin@example.com");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("local-test-only-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await settings(page)
    .getByRole("button", { name: "감사 로그", exact: true })
    .click();
  const panel = settings(page).getByRole("region", {
    name: "감사 로그",
    exact: true,
  });
  await expect(panel.getByLabel("시작 날짜")).toHaveValue(todayKey());
  await expect(panel.getByLabel("종료 날짜")).toHaveValue(todayKey());
  await expect(panel.locator("details")).toHaveCount(3);
  for (const [action, label] of [
    ["login", "로그인"],
    ["logout", "로그아웃"],
  ]) {
    await panel.getByLabel("작업 종류").selectOption({ label });
    await panel.getByRole("button", { name: "조회", exact: true }).click();
    await expect(panel.locator("details")).toHaveCount(1);
    const entry = panel.locator("details");
    await expect(entry.locator("summary strong")).toHaveText(label);
    await expect(entry.locator(".system-audit-summary > span")).toHaveText(
      "감사 관리자",
    );
    await expect(entry.locator("summary")).toContainText("수행자: 감사 관리자");
    await expect(entry.locator("summary")).toContainText(
      "audit-admin@example.com",
    );
    await entry.locator("summary").click();
    await expect(
      entry.getByRole("table", { name: "변경 전·후 상세" }),
    ).toContainText("audit-admin@example.com");
    await expect(entry).not.toContainText("local-test-only-password");
    await page.screenshot({
      path: info.outputPath(`system-audit-${action}.png`),
    });
  }
});

test("팀장 설정에는 시스템 감사 로그 메뉴가 없다", async ({ page }) => {
  await post(page, "/auth/logout", {});
  await post(page, "/auth/login", {
    username: "audit-lead@example.com",
    password: "local-test-only-password",
  });
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    settings(page).getByRole("button", { name: "감사 로그", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get(`${base}/api/admin/audit`)).status()).toBe(
    403,
  );
});
