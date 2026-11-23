import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { todayKey } from "../../../shared/domain.js";
import { addDays } from "../../../shared/calendar/calendar.js";

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
const bell = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"] .calendar-entry-bell`);
const schedule = async (page: Page, id: string) =>
  (({ time, reminders }) => ({ time, reminders }))(
    await request(page, `/calendar/entries/${id}`),
  );
const fields = (scope: Locator) => ({
  toggle: scope.getByRole("switch", { name: "시작 알림", exact: true }),
  time: scope.getByLabel("일정 시작 시각"),
  option: (name: string) =>
    scope
      .getByRole("group", { name: "알림 시점", exact: true })
      .getByRole("checkbox", { name, exact: true }),
});
// The next save of the entry's time and reminders, as the server stored it.
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
async function calendar(page: Page) {
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".calendar-grid")).toBeVisible();
}

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

test("일정 상세의 시작 알림을 켜면 시각과 여러 알림을 저장하고 끄면 모두 지운다", async ({
  page,
}) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "주간 회의",
    // Tomorrow: every reminder is still to come.
    date: addDays(todayKey(), 1),
  });
  await calendar(page);
  await expect(card(page, entry.id)).toBeVisible();
  await expect(bell(page, entry.id)).toHaveCount(0);
  await card(page, entry.id).click();

  const { toggle, time, option } = fields(detail(page));
  await expect(toggle).not.toBeChecked();
  await expect(time).toHaveCount(0);
  // The switch sits right of the end date, on the same row.
  const [endDate, switchBox] = await Promise.all([
    detail(page).getByLabel("일정 종료일").boundingBox(),
    detail(page).locator(".calendar-schedule .switch-track").boundingBox(),
  ]);
  expect(switchBox!.x).toBeGreaterThan(endDate!.x + endDate!.width);
  expect(switchBox!.y).toBeGreaterThan(endDate!.y - 4);
  expect(switchBox!.y + switchBox!.height).toBeLessThan(
    endDate!.y + endDate!.height + 4,
  );
  // Turned on and off again, nothing is left to tell.
  await Promise.all([saved(page, entry.id), toggle.check({ force: true })]);
  await Promise.all([saved(page, entry.id), toggle.uncheck({ force: true })]);
  await expect(detail(page).getByText("알림 저장됨")).toHaveCount(0);
  await expect(detail(page).locator(".calendar-reminder-note")).toHaveCount(0);
  // Turning it on starts with a time and a reminder five minutes before.
  await Promise.all([saved(page, entry.id), toggle.check({ force: true })]);
  await expect(time).toHaveValue(/^\d{2}:\d{2}$/);
  await expect(option("5분 전")).toBeChecked();
  await expect(option("정시")).not.toBeChecked();
  // The time and the check boxes are on one line.
  const [timeBox, lastBox] = await Promise.all([
    time.boundingBox(),
    option("1시간 전").boundingBox(),
  ]);
  expect(lastBox!.x).toBeGreaterThan(timeBox!.x + timeBox!.width);
  expect(lastBox!.y).toBeGreaterThan(timeBox!.y);
  expect(lastBox!.y + lastBox!.height).toBeLessThan(
    timeBox!.y + timeBox!.height,
  );
  await expect(option("2시간 전")).toHaveCount(0);
  await expect(option("하루 전")).toHaveCount(0);
  expect((await schedule(page, entry.id)).reminders).toEqual([5]);

  // Several reminders at once; each choice is saved.
  await Promise.all([saved(page, entry.id), option("정시").check()]);
  await Promise.all([saved(page, entry.id), option("1시간 전").check()]);
  // Where the reminders go and what was saved share one line.
  const note = detail(page).locator(".calendar-reminder-note");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("다바다 푸시");
  await expect(note).toContainText("알림 저장됨");
  if (process.env.SHOT_DIR)
    await detail(page).screenshot({
      path: process.env.SHOT_DIR + "/detail2.png",
    });
  // A typed time is saved on leaving the fields.
  await time.fill("09:30");
  await Promise.all([
    saved(page, entry.id),
    detail(page).getByLabel("일정 제목").focus(),
  ]);
  expect(await schedule(page, entry.id)).toEqual({
    time: "09:30",
    reminders: [0, 5, 60],
  });
  // The internal site tells where this person's reminders go, and offers no
  // way to point them elsewhere.
  await expect(detail(page).getByText(/다바다 푸시/)).toBeVisible();
  await expect(
    detail(page).getByRole("button", { name: "주소 변경" }),
  ).toHaveCount(0);

  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(card(page, entry.id).locator("time")).toHaveText("09:30");
  // The bell is in the card's top right corner and waits.
  await expect(bell(page, entry.id)).toHaveAttribute("data-status", "pending");
  await expect(bell(page, entry.id)).toHaveAccessibleName("알림 대기");
  const [cardBox, bellBox] = await Promise.all([
    card(page, entry.id).boundingBox(),
    bell(page, entry.id).boundingBox(),
  ]);
  expect(bellBox!.x).toBeGreaterThan(cardBox!.x + cardBox!.width / 2);
  expect(bellBox!.y - cardBox!.y).toBeLessThan(10);
  await page.reload();
  await expect(card(page, entry.id).locator("time")).toHaveText("09:30");

  // A reminder turned off stays off; the time alone needs none.
  await card(page, entry.id).click();
  for (const name of ["정시", "5분 전", "1시간 전"])
    await Promise.all([saved(page, entry.id), option(name).uncheck()]);
  expect(await schedule(page, entry.id)).toEqual({
    time: "09:30",
    reminders: [],
  });
  await Promise.all([saved(page, entry.id), toggle.uncheck({ force: true })]);
  await expect(time).toHaveCount(0);
  expect(await schedule(page, entry.id)).toEqual({ time: null, reminders: [] });
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(card(page, entry.id).locator("time")).toHaveCount(0);
  await expect(bell(page, entry.id)).toHaveCount(0);
});

test("일정 추가 창에서도 시작 알림을 켜 시각과 알림을 함께 만든다", async ({
  page,
}) => {
  await calendar(page);
  const date = addDays(todayKey(), 1);
  await page
    .locator(`[data-date="${date}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await dialog.getByLabel("새 일정 제목").fill("알림 있는 일정");
  const { toggle, time, option } = fields(dialog);
  await expect(time).toHaveCount(0);
  await toggle.check({ force: true });
  await time.fill("15:45");
  await expect(option("5분 전")).toBeChecked();
  // The window is wide enough for the time and every check box on one line.
  const [createTime, createLast] = await Promise.all([
    time.boundingBox(),
    option("1시간 전").boundingBox(),
  ]);
  expect(createLast!.x).toBeGreaterThan(createTime!.x + createTime!.width);
  expect(createLast!.y).toBeGreaterThan(createTime!.y);
  expect(createLast!.y + createLast!.height).toBeLessThan(
    createTime!.y + createTime!.height,
  );
  await expect(dialog.getByText("시작 시각", { exact: true })).toHaveCount(0);
  if (process.env.SHOT_DIR)
    await dialog.screenshot({ path: process.env.SHOT_DIR + "/create.png" });
  await option("30분 전").check();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/calendar/entries") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "일정 만들기" }).click();
  const entry = unpack(await (await created).json());
  expect(entry).toMatchObject({
    title: "알림 있는 일정",
    time: "15:45",
    reminders: [5, 30],
  });
  await expect(dialog).toHaveCount(0);
  await expect(card(page, entry.id).locator("time")).toHaveText("15:45");
  await expect(bell(page, entry.id)).toHaveAttribute("data-status", "pending");

  // A secret entry stays in this browser and has no reminders.
  await page
    .locator(`[data-date="${date}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .first()
    .click();
  await expect(fields(dialog).toggle).toBeVisible();
  await dialog
    .getByRole("switch", { name: "시크릿 일정", exact: true })
    .check({ force: true });
  await expect(fields(dialog).toggle).toHaveCount(0);
});

test("지나간 알림을 보내지 못한 일정의 종은 오류로 표시한다", async ({
  page,
}) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "지난 회의",
    date: addDays(todayKey(), -1),
    time: "09:00",
    reminders: [0],
  });
  expect(entry.reminderStatus).toBe("failed");
  await calendar(page);
  await expect(bell(page, entry.id)).toHaveAttribute("data-status", "failed");
  await expect(bell(page, entry.id)).toHaveAccessibleName("알림 오류");
});

test("카드 메뉴의 일정 복제 (본문 포함)은 시각·알림과 본문을 함께 복사하고 일정 복제는 본문을 비운다", async ({
  page,
}) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "주간 회의",
    date: todayKey(),
    time: "10:00",
    reminders: [0, 30],
  });
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: "안건 정리",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await calendar(page);
  await expect(card(page, entry.id)).toBeVisible();
  const copies = async () =>
    (
      await request(
        page,
        `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
      )
    ).entries.filter((item: { id: string }) => item.id !== entry.id);

  await card(page, entry.id).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "일정 복제 (본문 포함)", exact: true })
    .click();
  await expect(page.locator(".calendar-entry-card")).toHaveCount(2);
  const [withBody] = await copies();
  expect(withBody).toMatchObject({
    title: "주간 회의 (1)",
    time: "10:00",
    reminders: [0, 30],
    hasDocument: true,
  });
  expect(
    (await request(page, `/calendar/entries/${withBody.id}/document`)).markdown,
  ).toBe("안건 정리");

  await card(page, entry.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(page.locator(".calendar-entry-card")).toHaveCount(3);
  const plain = (await copies()).find(
    (item: { id: string }) => item.id !== withBody.id,
  );
  expect(plain).toMatchObject({
    title: "주간 회의 (2)",
    time: "10:00",
    reminders: [0, 30],
    hasDocument: false,
  });
});
