import { unpack } from "../../shared/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

let teamId: string;
let tasks: Record<string, any>;
async function post(page: Page, path: string, data: any, method = "post") {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
test.beforeEach(async ({ page }) => {
  await post(page, "/auth/login", {
    username: "browser-test@example.com",
    password: "local-test-only-password",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await post(page, "/admin/teams", {
      name: `월 이동 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  tasks = {};
  for (const [name, year] of [
    ["올해 업무", 2026],
    ["이어지는 업무", 2026],
    ["내년 신규 업무", 2027],
    ["그다음 해 업무", 2028],
  ] as const) {
    tasks[name] = (
      await post(page, "/tasks", {
        teamId,
        year,
        fields: { title: name, owner: boot.user.id },
      })
    ).task;
  }
  await post(
    page,
    `/tasks/${tasks["이어지는 업무"].id}`,
    { updatedAt: tasks["이어지는 업무"].updatedAt, years: [2026, 2027] },
    "patch",
  );
  await page.addInitScript(
    ({ key, teamId }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ teamId, year: 2026 }));
    },
    { key: `weekly-board:${boot.user.id}`, teamId },
  );
  await page.goto("/");
  await expect(
    page.getByRole("gridcell", { name: "올해 업무", exact: true }),
  ).toBeVisible();
});
const next = (page: Page) =>
  page.getByRole("button", { name: "다음 달로 이동", exact: true });
const previous = (page: Page) =>
  page.getByRole("button", { name: "이전 달로 이동", exact: true });

test("연도 화살표는 겹친 기간과 저장된 월 범위를 단일 연도 전체로 바꾼다", async ({
  page,
}) => {
  const yearPrevious = page.getByRole("button", {
    name: "이전 연도",
    exact: true,
  });
  const yearNext = page.getByRole("button", { name: "다음 연도", exact: true });
  const annual = async (year: number) => {
    await expect(page.locator(".year-value")).toHaveText(String(year));
    await expect(next(page)).toBeEnabled();
    await expect(page.locator(".year-badge")).toHaveText(String(year));
    await expect(page.locator(".period-month").first()).toHaveAttribute(
      "data-month",
      "1",
    );
    await expect(page.locator(".period-month").last()).toHaveAttribute(
      "data-month",
      "12",
    );
    await expect(
      page.locator('.period-month[aria-pressed="true"]'),
    ).toHaveCount(12);
    await expect(
      page.locator(`.period-month[data-year="${year}"]`),
    ).toHaveCount(12);
  };
  await next(page).click();
  await expect(next(page)).toBeEnabled();
  await expect(page.locator(".year-value")).toHaveText("2026~2027");
  await page.locator(".period-week").last().click();
  await yearPrevious.click();
  await annual(2026);
  await expect(
    page.getByRole("gridcell", { name: "내년 신규 업무", exact: true }),
  ).toHaveCount(0);

  // Leave a shifted view saved for 2026, then return using the year arrows.
  await next(page).click();
  await expect(next(page)).toBeEnabled();
  await yearNext.click();
  await annual(2027);
  await yearPrevious.click();
  await annual(2026);
  await yearPrevious.click();
  await annual(2025);
  await yearNext.click();
  await annual(2026);

  await previous(page).click();
  await expect(page.locator(".year-value")).toHaveText("2025~2026");
  await expect(yearNext).toBeEnabled();
  await yearNext.click();
  await annual(2026);
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack);
      return data.views.find((view: any) => view.name === "__current")?.data
        .startMonth;
    })
    .toBe(1);
  await page.reload();
  await annual(2026);
});

test("업무 추가 저장 중에는 기준 연도와 달력 이동을 잠근다", async ({
  page,
}) => {
  await next(page).click();
  await expect(next(page)).toBeEnabled();
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const requested = new Promise<void>((resolve) => (arrived = resolve));
  await page.route("**/api/tasks", async (route) => {
    arrived();
    await gate;
    await route.continue();
  });
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
  );
  const add = page
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
    .getByRole("button", { name: "업무 추가", exact: true });
  let created: any;
  try {
    await add.click();
    await requested;
    await expect(next(page)).toBeDisabled({ timeout: 1000 });
    await expect(previous(page)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "다음 연도", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "이전 연도", exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel("팀 선택", { exact: true })).toBeDisabled();
    await expect(add).toBeDisabled();
  } finally {
    release();
    created = await (await response).json().then(unpack);
    await page.unroute("**/api/tasks");
  }
  expect(created.task.years).toEqual([2026]);
  const cell = page.locator(`[data-cell="${created.task.id}:title"]`);
  await expect(cell.getByRole("textbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(next(page)).toBeEnabled();
  await expect(page.locator(".year-badge")).toHaveText("2026");
  await expect(page.locator(".period-month").first()).toHaveText("2월");
  await expect(cell).toHaveCount(1);
});

test("달력 이동 후 키보드 범위는 새로 초점을 둔 월에서 시작한다", async ({
  page,
}) => {
  for (const start of [2, 3]) {
    await page.locator(".period-month").last().click();
    await next(page).click();
    await expect(next(page)).toBeEnabled();
    await page.locator(".period-month").first().focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.locator('.period-month[aria-pressed="true"]')).toHaveText(
      [`${start}월`, `${start + 1}월`],
      { timeout: 1000 },
    );
  }
});

test("달력은 12개월을 한 달씩 이동하고 두 해의 개인 보기를 복원한다", async ({
  page,
}, info) => {
  await expect(page.locator(".period-month")).toHaveCount(12);
  await expect(
    page.getByRole("gridcell", { name: "내년 신규 업무", exact: true }),
  ).toHaveCount(0);
  await next(page).click();
  await expect(next(page)).toBeEnabled();
  await expect(page.locator(".period-month")).toHaveText([
    "2월",
    "3월",
    "4월",
    "5월",
    "6월",
    "7월",
    "8월",
    "9월",
    "10월",
    "11월",
    "12월",
    "2027년 1월",
  ]);
  await expect(page.locator(".period-month").first()).toHaveAttribute(
    "data-year",
    "2026",
  );
  await expect(page.locator(".period-month").last()).toHaveAttribute(
    "data-year",
    "2027",
  );
  await expect(page.locator(".year-value")).toHaveText("2026~2027");
  await expect(page.locator(".year-value")).toHaveCSS(
    "flex-direction",
    "column",
  );
  await expect(page.locator(".year-badge")).toHaveText("2026");
  await expect(
    page.getByRole("gridcell", { name: "내년 신규 업무", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: "이어지는 업무", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("gridcell", { name: "그다음 해 업무", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-week="2026-12-28"]')).toHaveCount(1);
  const reads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/tasks")
      reads.push(request.url());
  });
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/views") &&
      response.request().method() === "PUT" &&
      response.ok(),
  );
  await next(page).click();
  await saved;
  expect(reads).toEqual([]);
  await expect(page.locator(".period-month").first()).toHaveText("3월");
  await expect(page.locator(".period-month").last()).toHaveText("2월");
  await page.reload();
  await expect(page.locator(".period-month").first()).toHaveText("3월");
  await expect(next(page)).toBeEnabled();
  await expect(page.locator(".period-month")).toHaveCount(12);
  await expect(
    page.getByRole("gridcell", { name: "내년 신규 업무", exact: true }),
  ).toBeVisible();
  const addedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks" &&
      response.request().method() === "POST",
  );
  await page
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const added = await (await addedResponse).json().then(unpack);
  expect(added.task.years).toEqual([2026]);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("rolling-calendar.png") });
});

test("연도 경계를 반복 이동해도 12개월과 최대 두 해의 업무만 표시한다", async ({
  page,
}) => {
  for (let i = 0; i < 12; i++) {
    await next(page).click();
    await expect(next(page)).toBeEnabled();
    await expect(page.locator(".period-month")).toHaveCount(12);
  }
  await expect(page.locator(".year-badge")).toHaveText("2027");
  await expect(page.locator(".year-value")).toHaveText("2027");
  await expect(page.locator(".period-month").first()).toHaveText("2027년 1월");
  await expect(page.locator(".period-month").last()).toHaveText("12월");
  await expect(
    page.getByRole("gridcell", { name: "올해 업무", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("gridcell", { name: "그다음 해 업무", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("gridcell", { name: "이어지는 업무", exact: true }),
  ).toHaveCount(1);
  await next(page).click();
  await expect(page.locator(".year-value")).toHaveText("2027~2028");
  await expect(
    page.getByRole("gridcell", { name: "그다음 해 업무", exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 13; i++) {
    await previous(page).click();
    await expect(previous(page)).toBeEnabled();
  }
  await expect(page.locator(".year-badge")).toHaveText("2026");
  await expect(page.locator(".year-value")).toHaveText("2026");
  await expect(page.locator(".period-month")).toHaveCount(12);
  await expect(
    page.getByRole("gridcell", { name: "내년 신규 업무", exact: true }),
  ).toHaveCount(0);
});

test("연말·연초 드래그와 다음 해 업무의 실시간 셀 갱신을 함께 처리한다", async ({
  page,
}) => {
  await next(page).click();
  await expect(next(page)).toBeEnabled();
  const a = (await page
    .getByRole("button", { name: "12월 전체", exact: true })
    .boundingBox())!;
  const b = (await page
    .getByRole("button", { name: "2027년 1월 전체", exact: true })
    .boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.period-month[aria-pressed="true"]')).toHaveText([
    "12월",
    "2027년 1월",
  ]);
  await expect(page.locator('[data-header-key="2026-12-28"]')).toHaveCount(1);
  await expect(page.locator('[data-header-key="2027-01-04"]')).toHaveCount(1);
  await page.route("**/api/tasks?*", (route) => route.abort());
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: tasks["내년 신규 업무"].id,
        key: "2027-01-04",
        value: "새해 실시간 일정",
        expectedVersion: 0,
      },
    ],
  });
  await expect(
    page.locator(
      `[data-task-id="${tasks["내년 신규 업무"].id}"][data-column="2027-01-04"]`,
    ),
  ).toHaveText("새해 실시간 일정");
});
