import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { todayKey } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string;
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"] .calendar-entry-card`).first();
// The next save of the entry's time and reminder, as the server stored it.
const saved = (page: Page, id: string) =>
  page
    .waitForResponse(
      (response) =>
        response.url().endsWith(`/api/calendar/entries/${id}`) &&
        response.request().method() === "PATCH" &&
        "time" in (response.request().postDataJSON() ?? {}),
    )
    .then(async (response) => {
      expect(response.ok(), await response.text()).toBeTruthy();
    });

test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `캘린더 알림 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
});

test("일정 상세에서 시작 시각과 알림을 저장하고 카드에 표시하며 시각을 지우면 알림도 지운다", async ({
  page,
}) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "주간 회의",
    date: todayKey(),
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(card(page, entry.id)).toBeVisible();
  await expect(card(page, entry.id).locator("time")).toHaveCount(0);
  await card(page, entry.id).click();

  const time = detail(page).getByLabel("일정 시작 시각"),
    reminder = detail(page).getByLabel("일정 알림");
  await expect(time).toHaveValue("");
  // A reminder needs a time first.
  await expect(reminder).toBeDisabled();
  await time.fill("09:30");
  await expect(reminder).toBeEnabled();
  // Choosing the reminder saves the time with it.
  await Promise.all([
    saved(page, entry.id),
    reminder.selectOption({ label: "10분 전" }),
  ]);
  await expect(detail(page).getByText("시각 저장됨")).toBeVisible();
  expect(
    (({ time, remindMinutes }) => ({ time, remindMinutes }))(
      await request(page, `/calendar/entries/${entry.id}`),
    ),
  ).toEqual({ time: "09:30", remindMinutes: 10 });
  // The internal site tells where this person's reminders go.
  await expect(detail(page).getByText(/다바다 푸시/)).toBeVisible();

  // Leaving the fields saves a changed time alone.
  await time.fill("14:05");
  await Promise.all([
    saved(page, entry.id),
    detail(page).getByLabel("일정 제목").focus(),
  ]);
  expect((await request(page, `/calendar/entries/${entry.id}`)).time).toBe(
    "14:05",
  );

  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(card(page, entry.id).locator("time")).toHaveText("14:05");
  await expect(card(page, entry.id).getByLabel("알림 설정됨")).toBeVisible();
  // The card keeps both after a reload.
  await page.reload();
  await expect(card(page, entry.id).locator("time")).toHaveText("14:05");

  await card(page, entry.id).click();
  await expect(time).toHaveValue("14:05");
  await expect(reminder).toHaveValue("10");
  await Promise.all([
    saved(page, entry.id),
    detail(page).getByTitle("시작 시각 지우기").click(),
  ]);
  await expect(time).toHaveValue("");
  await expect(reminder).toBeDisabled();
  expect(
    (({ time, remindMinutes }) => ({ time, remindMinutes }))(
      await request(page, `/calendar/entries/${entry.id}`),
    ),
  ).toEqual({ time: null, remindMinutes: null });
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(card(page, entry.id).locator("time")).toHaveCount(0);
  await expect(card(page, entry.id).getByLabel("알림 설정됨")).toHaveCount(0);
});
