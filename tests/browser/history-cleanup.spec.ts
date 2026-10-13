import { unpack } from "../../shared/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.mjs";
import { openDatabase, json } from "../../server/db.mjs";

let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string,
  teamId: string,
  taskId: string,
  otherTeamId: string,
  otherOperationId: string;
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
async function openCleanup(page: Page) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await settings(page)
    .getByRole("button", { name: "변경 이력 정리", exact: true })
    .click();
  await expect(
    settings(page).getByRole("table", { name: "팀별 저장 용량" }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  db = openDatabase(":memory:");
  app = createApp({ db, rateLimits: false });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { user } = await post(page, "/auth/setup", {
    username: "cleanup@example.com",
    password: "local-test-only-password",
    name: "정리 관리자",
    teamName: "이력 검증팀",
  });
  teamId = user.teamIds[0];
  taskId = (
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "보존할 업무" },
    })
  ).task.id;
  const stamp = new Date(Date.now() - 400 * 86400000).toISOString();
  for (let i = 0; i < 510; i++)
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
      randomUUID(),
      teamId,
      user.id,
      "cells",
      randomUUID(),
      "[]",
      "[]",
      stamp,
    );
  for (let i = 0; i < 10; i++)
    db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
      randomUUID(),
      user.id,
      json({ kind: "cell-audit", refs: [{ teamId, id: randomUUID() }] }),
      stamp,
    );
  otherTeamId = (await post(page, "/admin/teams", { name: "다른 팀" })).id;
  for (let i = 0; i < 2; i++)
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
      randomUUID(),
      otherTeamId,
      user.id,
      "cells",
      randomUUID(),
      "[]",
      "[]",
      stamp,
    );
  otherOperationId = randomUUID();
  db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
    otherOperationId,
    user.id,
    json({
      kind: "cell-audit",
      refs: [{ teamId: otherTeamId, id: randomUUID() }],
    }),
    stamp,
  );
  await page.goto(base);
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});
test.afterEach(async () => {
  app.locals.cellEvents.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

test("팀별 용량을 확인한 뒤 선택한 날짜 이전의 팀 이력만 삭제하고 중단·재개한다", async ({
  page,
}, info) => {
  await openCleanup(page);
  const panel = settings(page);
  const storage = panel.getByRole("table", { name: "팀별 저장 용량" });
  const preview = panel.getByRole("region", { name: "삭제 대상 미리보기" });
  const check = panel.getByRole("button", {
    name: "데이터 용량 확인",
    exact: true,
  });
  const remove = panel.getByRole("button", {
    name: "이전 데이터 삭제",
    exact: true,
  });
  await expect(
    panel.getByRole("radio", { name: "이력 검증팀 선택", exact: true }),
  ).toBeChecked();
  await expect(
    storage.getByRole("row").filter({
      has: page.getByRole("radio", {
        name: "이력 검증팀 선택",
        exact: true,
      }),
    }),
  ).toContainText("512건");
  await expect(remove).toHaveCount(0);
  await check.click();
  await expect(preview.getByRole("row", { name: /^변경 이력 / })).toContainText(
    "510건",
  );
  await expect(
    preview.getByRole("row", { name: /^저장 재시도 기록 / }),
  ).toContainText("10건");
  await expect(remove).toBeInViewport();
  await page.screenshot({ path: info.outputPath("team-history-preview.png") });
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE team_id=? AND action='cells'",
      )
      .get(teamId)!.n,
  ).toBe(510);
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stored!: () => void;
  const firstBatch = new Promise<void>((resolve) => {
    stored = resolve;
  });
  await page.route(`${base}/api/admin/history-cleanup`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    stored();
    await pause;
    await route.fulfill({ response });
  });
  const cutoffDate = await panel
    .getByLabel("기준 날짜", { exact: true })
    .inputValue();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("이력 검증팀");
    expect(dialog.message()).toContain(cutoffDate);
    await dialog.accept();
  });
  await remove.click();
  await firstBatch;
  await expect(panel.getByLabel("기준 날짜", { exact: true })).toBeDisabled();
  await expect(
    panel.getByRole("radio", { name: "다른 팀 선택", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "중단", exact: true }).click();
  release();
  await expect(panel.locator(".toast")).toContainText(
    "500건을 삭제하고 중단했습니다",
  );
  await expect(preview).toHaveCount(0);
  await expect(panel.locator(".history-cleanup-latest")).toContainText(
    "500건 처리 (일부 정리)",
  );
  await page.unroute(`${base}/api/admin/history-cleanup`);
  await check.click();
  await expect(preview.getByRole("row", { name: /^변경 이력 / })).toContainText(
    "20건",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(panel.locator(".toast")).toContainText(
    "변경 이력 20건과 저장 재시도 기록 0건을 삭제했습니다",
  );
  await check.click();
  await expect(remove).toBeDisabled();
  await expect(preview).toContainText("삭제할 수 있는 데이터가 없습니다");
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE team_id=? AND action='cells'",
      )
      .get(otherTeamId)!.n,
  ).toBe(2);
  expect(
    db.prepare("SELECT id FROM operations WHERE id=?").get(otherOperationId),
  ).toBeTruthy();
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toHaveText(
    "보존할 업무",
  );
});

test("팀장에게 시스템 이력 정리 메뉴가 보이지 않고 직접 API 호출도 거절된다", async ({
  page,
}) => {
  await post(page, "/admin/users", {
    username: "cleanup-lead@example.com",
    password: "local-test-only-password",
    name: "팀장",
    memberships: [{ teamId, role: "lead" }],
  });
  await post(page, "/auth/logout", {});
  await post(page, "/auth/login", {
    username: "cleanup-lead@example.com",
    password: "local-test-only-password",
  });
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    settings(page).getByRole("button", { name: "변경 이력 정리", exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`${base}/api/admin/history-cleanup`)).status(),
  ).toBe(403);
  expect(
    (
      await page.request.get(`${base}/api/admin/history-cleanup/storage`)
    ).status(),
  ).toBe(403);
});

test("팀·날짜 변경은 미리보기를 폐기하고 늦게 도착한 다른 팀의 결과를 표시하지 않는다", async ({
  page,
}) => {
  await openCleanup(page);
  const panel = settings(page);
  const presets = panel.getByRole("group", { name: "기준 날짜 선택" });
  await expect(presets.getByRole("button", { pressed: true })).toHaveText(
    "365일 전",
  );
  const preview = panel.getByRole("region", { name: "삭제 대상 미리보기" });
  const check = panel.getByRole("button", {
    name: "데이터 용량 확인",
    exact: true,
  });
  const remove = panel.getByRole("button", {
    name: "이전 데이터 삭제",
    exact: true,
  });
  await check.click();
  await expect(preview).toContainText("이력 검증팀");
  await panel.getByRole("radio", { name: "다른 팀 선택", exact: true }).check();
  await expect(remove).toHaveCount(0);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(`${base}/api/admin/history-cleanup?*`, async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("scopeId") !== otherTeamId
    )
      return route.continue();
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await check.click();
  await pending;
  await panel
    .getByRole("radio", { name: "이력 검증팀 선택", exact: true })
    .check();
  await expect(preview).toHaveCount(0);
  await check.click();
  await expect(preview).toContainText("이력 검증팀");
  release();
  await expect(preview).not.toContainText("다른 팀");
  const input = panel.getByLabel("기준 날짜", { exact: true });
  await input.fill("2020-01-01");
  await expect(presets.getByRole("button", { pressed: true })).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  await check.click();
  await expect(preview).toContainText("2020-01-01 이전");
  await expect(remove).toBeDisabled();
  await panel.getByRole("button", { name: "90일 전", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(presets.getByRole("button", { pressed: true })).toHaveText(
    "90일 전",
  );
  await input.fill("2020-01-01");
  await expect(presets.getByRole("button", { pressed: true })).toHaveCount(0);
});

test("통신 실패 재시도는 기기 시각이 바뀌어도 최초 요청 ID와 생성시각을 유지한다", async ({
  page,
}) => {
  const payloads: unknown[] = [];
  await page.route(`${base}/api/cells/batch`, async (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return route.abort();
    await route.continue();
  });
  const title = page.locator(`[data-cell="${taskId}:title"]`);
  await title.dblclick();
  await page.locator(".inline-editor textarea").fill("재시도 후 업무");
  await page.locator(".inline-editor textarea").press("Enter");
  await page.getByRole("button", { name: "입력 확인", exact: true }).click();
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 86400000));
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(title).toHaveText("재시도 후 업무");
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  expect((payloads[0] as { createdAt: string }).createdAt).toBeTruthy();
});
