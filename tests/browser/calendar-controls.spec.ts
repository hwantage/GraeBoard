import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey, weeksForYear } from "../../shared/domain.js";

const dateKey = "prop_test_date";
const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, taskId: string;

async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}

function dateCell(page: Page) {
  return page.locator(`[data-cell="${taskId}:${dateKey}"]`);
}

async function save(page: Page, action: () => Promise<unknown>, value: string) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    action(),
  ]);
  await expect(
    page.getByRole("dialog", { name: "마감일 편집 달력" }),
  ).toHaveCount(0);
  await expect(dateCell(page)).toHaveText(value);
  const data = await (
    await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
  )
    .json()
    .then(unpack);
  expect(
    data.tasks.find((task: any) => task.id === taskId).cells[dateKey]?.value ||
      "",
  ).toBe(value);
}

async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  preview?: () => Promise<void>,
) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await preview?.();
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await post(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await post(page, "/admin/teams", {
      name: `달력 검증 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  const admin = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
  const settings = admin.teams.find((team: any) => team.id === teamId).settings;
  settings.properties.push({
    id: dateKey,
    name: "마감일",
    kind: "date",
    display: "text",
    visible: true,
    width: 140,
    values: [],
  });
  const response = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers,
    data: settings,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  taskId = (
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: "날짜 편집 검증",
        owner: boot.user.id,
        [dateKey]: "2026-10-13",
      },
    })
  ).task.id;
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(dateCell(page)).toHaveText("2026-10-13");
});

test("날짜를 더블클릭하면 달력과 숫자 입력이 바로 열리고 선택한 날짜를 저장한다", async ({
  page,
}, info) => {
  let saves = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/cells/batch")) saves++;
  });
  await dateCell(page).dblclick();
  const calendar = page.getByRole("dialog", { name: "마감일 편집 달력" });
  const input = page.getByRole("textbox", { name: "마감일 편집", exact: true });
  await expect(calendar).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("2026-10-13");
  await expect(
    calendar.getByRole("button", { name: "2026년 10월 13일", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dateCell(page).getByRole("button")).toHaveCount(0);
  await calendar.getByRole("button", { name: "다음 달", exact: true }).click();
  await expect(
    calendar.getByText("2026년 11월", { exact: true }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  expect(saves).toBe(0);
  await page.screenshot({ path: info.outputPath("date-calendar-open.png") });
  await save(
    page,
    () =>
      calendar
        .getByRole("button", { name: "2026년 11월 20일", exact: true })
        .click(),
    "2026-11-20",
  );
  expect(saves).toBe(1);
  await page.reload();
  await expect(dateCell(page)).toHaveText("2026-11-20");
});

test("날짜 숫자 직접 입력은 첫 글자를 보존하고 Enter·Tab·외부 클릭으로 저장한다", async ({
  page,
}) => {
  const input = page.getByRole("textbox", { name: "마감일 편집", exact: true });
  await dateCell(page).dblclick();
  await page.keyboard.type("20280229");
  await expect(input).toHaveValue("20280229");
  await save(page, () => input.press("Enter"), "2028-02-29");
  await dateCell(page).click();
  await page.keyboard.type("20271231");
  await expect(input).toHaveValue("20271231");
  await save(page, () => input.press("Tab"), "2027-12-31");
  await dateCell(page).dblclick();
  await input.fill("2026-01-05");
  await save(
    page,
    () => page.locator(`[data-cell="${taskId}:title"]`).click(),
    "2026-01-05",
  );
  await page.reload();
  await expect(dateCell(page)).toHaveText("2026-01-05");
});

test("잘못된 날짜는 저장하지 않고 Esc 취소와 달력 선택으로 수정할 수 있다", async ({
  page,
}) => {
  let saves = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/cells/batch")) saves++;
  });
  await dateCell(page).dblclick();
  const input = page.getByRole("textbox", { name: "마감일 편집", exact: true });
  const calendar = page.getByRole("dialog", { name: "마감일 편집 달력" });
  for (const value of ["20260229", "20261301", "202610", "00000101"]) {
    await input.fill(value);
    await input.press("Enter");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(value);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toContainText("유효한 날짜");
    await expect(calendar).toBeVisible();
  }
  expect(saves).toBe(0);
  await input.press("Escape");
  await expect(calendar).toHaveCount(0);
  await expect(dateCell(page)).toHaveText("2026-10-13");
  await dateCell(page).dblclick();
  await input.fill("20260230");
  await input.press("Enter");
  await save(
    page,
    () =>
      calendar
        .getByRole("button", { name: "2026년 10월 15일", exact: true })
        .click(),
    "2026-10-15",
  );
  expect(saves).toBe(1);
});

test("날짜 달력은 키보드로 월 경계를 이동하고 비우기와 빈 날짜 편집을 지원한다", async ({
  page,
}) => {
  const input = page.getByRole("textbox", { name: "마감일 편집", exact: true });
  const calendar = page.getByRole("dialog", { name: "마감일 편집 달력" });
  await dateCell(page).dblclick();
  await input.fill("2026-12-31");
  await input.press("ArrowDown");
  await expect(
    calendar.getByRole("button", { name: "2026년 12월 31일", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    calendar.getByRole("button", { name: "2027년 1월 1일", exact: true }),
  ).toBeFocused();
  await save(page, () => page.keyboard.press("Enter"), "2027-01-01");
  await dateCell(page).dblclick();
  await save(
    page,
    () =>
      calendar
        .getByRole("button", { name: "날짜 지우기", exact: true })
        .click(),
    "",
  );
  await dateCell(page).dblclick();
  await expect(calendar).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await save(
    page,
    () => calendar.getByRole("button", { name: "오늘", exact: true }).click(),
    todayKey(),
  );
});

test("날짜 달력은 작은 화면에서도 셀 옆에 보이고 숫자 입력을 유지한다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 720, height: 420 });
  await dateCell(page).scrollIntoViewIfNeeded();
  await dateCell(page).dblclick();
  const calendar = page.getByRole("dialog", { name: "마감일 편집 달력" });
  const box = (await calendar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(712);
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.y + box.height).toBeLessThanOrEqual(412);
  const input = page.getByRole("textbox", { name: "마감일 편집", exact: true });
  await expect(input).toBeFocused();
  const inputBox = (await input.boundingBox())!;
  expect(
    box.y + box.height <= inputBox.y || box.y >= inputBox.y + inputBox.height,
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("date-calendar-small-screen.png"),
  });
  await input.press("Escape");
  await expect(dateCell(page)).toHaveText("2026-10-13");
});

test("주차와 월을 드래그하는 동안과 확정 후 선택된 모든 주차에 테두리가 남는다", async ({
  page,
}, info) => {
  const picker = page.getByRole("group", { name: "월·주차 기간 선택" });
  const outlinedWeeks = () =>
    picker
      .locator(".period-week")
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => getComputedStyle(button).boxShadow !== "none")
          .map((button) => button.getAttribute("data-week")),
      );
  const weeks = weeksForYear(2026);
  const expectedWeeks = weeks
    .filter((week) => week.key >= "2026-10-05" && week.key <= "2026-11-02")
    .map((week) => week.key);
  await drag(
    page,
    picker.locator('[data-week="2026-10-05"]'),
    picker.locator('[data-week="2026-11-02"]'),
    async () => {
      await expect.poll(outlinedWeeks).toEqual(expectedWeeks);
    },
  );
  await page.getByLabel("전체 속성 검색").focus();
  await expect.poll(outlinedWeeks).toEqual(expectedWeeks);
  const expectedMonths = weeks
    .filter((week) => week.month >= 9 && week.month <= 11)
    .map((week) => week.key);
  await drag(
    page,
    picker.locator('[data-month="11"]'),
    picker.locator('[data-month="9"]'),
    async () => {
      await expect.poll(outlinedWeeks).toEqual(expectedMonths);
    },
  );
  await page.getByLabel("전체 속성 검색").focus();
  await expect.poll(outlinedWeeks).toEqual(expectedMonths);
  await expect
    .poll(() =>
      page
        .locator(".week-heading")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-header-key")),
        ),
    )
    .toEqual(expectedMonths);
  await page.screenshot({
    path: info.outputPath("period-selected-week-borders.png"),
  });
  await page.reload();
  await expect.poll(outlinedWeeks).toEqual(expectedMonths);
});

test("달력 필터의 이번 주 윗선은 선택 범위와 무관하고 한국 시간의 주 경계에 맞는다", async ({
  page,
}, info) => {
  await page.clock.setFixedTime(new Date("2026-10-18T14:59:59Z"));
  await page.reload();
  const picker = page.getByRole("group", { name: "월·주차 기간 선택" });
  const current = picker.locator('[aria-current="date"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-week", "2026-10-12");
  await expect(page.locator(".week-heading.this-week")).toHaveAttribute(
    "data-header-key",
    "2026-10-12",
  );
  const marker = await current.evaluate((button) => {
    const style = getComputedStyle(button, "::before");
    return {
      height: style.height,
      color: style.backgroundColor,
      content: style.content,
    };
  });
  expect(marker.height).toBe("3px");
  expect(marker.content).toBe('""');
  expect(marker.color).toBe(
    await page
      .locator(".week-heading.this-week")
      .evaluate((header) => getComputedStyle(header).borderTopColor),
  );
  await picker.locator('[data-month="3"]').click();
  await expect(current).toHaveAttribute("aria-pressed", "false");
  expect(
    await current.evaluate(
      (button) => getComputedStyle(button, "::before").height,
    ),
  ).toBe("3px");
  await page.screenshot({ path: info.outputPath("period-current-week.png") });
  await page.clock.setFixedTime(new Date("2026-10-18T15:00:00Z"));
  await page.reload();
  await expect(current).toHaveAttribute("data-week", "2026-10-19");
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(current).toHaveCount(0);
});
