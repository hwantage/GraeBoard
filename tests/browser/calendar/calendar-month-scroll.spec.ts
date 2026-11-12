import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

// The monthly views open on today and list the following months below as the
// grid scrolls. The clock is fixed so the months do not depend on the run date.
const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, memberId: string;
let pageErrors: string[];
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
const seedEntry = (
  page: Page,
  title: string,
  date: string,
  endDate = date,
  owner: string | null = userId,
) =>
  request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId: owner,
    date,
    endDate,
    title,
  });
const calendar = (page: Page) =>
  page.getByRole("region", { name: "캘린더", exact: true });
const scroller = (page: Page) =>
  calendar(page).getByLabel("달력 가로·세로 스크롤");
const row = (page: Page, week: string) =>
  calendar(page).locator(`.calendar-week-row[data-week="${week}"]`);
async function open(page: Page, now: string) {
  await page.clock.setFixedTime(new Date(now));
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page).locator(".calendar-grid")).toBeVisible();
}
async function shownMonth(page: Page, year: string, month: string) {
  await expect(calendar(page).getByLabel("캘린더 연도")).toHaveValue(year);
  await expect(
    calendar(page).getByLabel("표시 월", { exact: true }),
  ).toHaveValue(month);
}
// The row's distance below the sticky weekday header.
const rowOffset = (page: Page, target: Locator) =>
  target.evaluate((element) => {
    const root = element.closest<HTMLElement>(".calendar-scroll")!;
    const header = root.querySelector(".calendar-grid-header")!;
    return Math.round(
      element.getBoundingClientRect().top -
        header.getBoundingClientRect().bottom,
    );
  });
async function expectAtTop(page: Page, target: Locator) {
  await expect.poll(() => rowOffset(page, target)).toBeGreaterThanOrEqual(-2);
  await expect.poll(() => rowOffset(page, target)).toBeLessThanOrEqual(2);
}
// Scrolls the grid to its end until the target is listed.
async function scrollUntil(page: Page, target: Locator) {
  await expect
    .poll(async () => {
      await scroller(page).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return target.count();
    })
    .toBeGreaterThan(0);
}
async function scrollToTop(page: Page, target: Locator) {
  await target.evaluate((element) => {
    const root = element.closest<HTMLElement>(".calendar-scroll")!;
    const header = root.querySelector(".calendar-grid-header")!;
    root.scrollTop +=
      element.getBoundingClientRect().top -
      header.getBoundingClientRect().bottom;
  });
}
const calendarReads = (page: Page) => {
  const reads: URLSearchParams[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/calendar" && r.method() === "GET")
      reads.push(url.searchParams);
  });
  return reads;
};

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `월간 스크롤 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  memberId = (
    await request(page, "/admin/users", "POST", {
      username: `month-scroll-${randomUUID()}@example.com`,
      password: "local-test-only-password",
      name: "서연",
      memberships: [{ teamId, role: "member" }],
    })
  ).user.id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test("개인·팀 월간 보기는 처음 열거나 다른 보기에서 돌아오면 오늘 주를 위에 보여 준다", async ({
  page,
}, info) => {
  await seedEntry(page, "오늘 개인 일정", "2026-11-26");
  await seedEntry(page, "오늘 팀 일정", "2026-11-26", "2026-11-26", null);
  await open(page, "2026-11-26T03:00:00+09:00");
  const todayRow = row(page, "2026-11-22");
  await expect(
    calendar(page).locator('[data-date="2026-11-26"] time'),
  ).toHaveAttribute("aria-current", "date");
  await expectAtTop(page, todayRow);
  await shownMonth(page, "2026", "11");
  await expect(
    calendar(page).getByRole("button", { name: "오늘 개인 일정", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("month-opens-on-today.png") });
  // A member's week elsewhere in the team week is no longer carried over.
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  const mine = calendar(page).locator(
    `.calendar-team-section[data-member-id="${userId}"]`,
  );
  for (let i = 0; i < 7; i++)
    await mine.getByRole("button", { name: / 다음 주$/ }).click();
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    "2027-01-10",
  );
  for (const view of ["팀 월간 보기", "개인 월간 보기"]) {
    await scroller(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await calendar(page)
      .getByRole("button", { name: view, exact: true })
      .click();
    await expectAtTop(page, todayRow);
    await shownMonth(page, "2026", "11");
    await expect(
      calendar(page).getByRole("button", {
        name: view === "팀 월간 보기" ? "오늘 팀 일정" : "오늘 개인 일정",
        exact: true,
      }),
    ).toBeInViewport();
  }
  // Going back to the team week keeps each member's own week.
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    "2027-01-10",
  );
  // Leaving the calendar and opening it again also starts on today.
  await calendar(page)
    .getByRole("button", { name: "개인 월간 보기", exact: true })
    .click();
  await calendar(page).getByLabel("캘린더 연도").selectOption("2025");
  await shownMonth(page, "2025", "11");
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).click();
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expectAtTop(page, todayRow);
  await shownMonth(page, "2026", "11");
});

test("월간 보기는 아래로 스크롤하면 다음 달을 이어 붙이고 위로는 이전 달을 붙이지 않는다", async ({
  page,
}, info) => {
  await seedEntry(page, "월 경계 일정", "2026-11-28", "2026-12-03");
  await seedEntry(page, "12월 일정", "2026-12-16");
  await seedEntry(page, "1월 일정", "2027-01-20");
  const reads = calendarReads(page);
  await open(page, "2026-11-12T03:00:00+09:00");
  await shownMonth(page, "2026", "11");
  // November starts on Sunday: only its edge week of October is dimmed.
  await expect(calendar(page).locator('[data-date="2026-10-31"]')).toHaveClass(
    /is-outside/,
  );
  await expect(
    calendar(page).locator('[data-date="2026-11-01"] .calendar-month-label'),
  ).toHaveText("11월");
  await scrollUntil(page, calendar(page).locator('[data-date="2027-01-20"]'));
  await expect(calendar(page).locator(".calendar-month-loading")).toHaveCount(
    0,
  );
  for (const week of ["2026-11-29", "2026-12-27", "2027-01-31"])
    await expect(row(page, week)).toHaveCount(1);
  for (const date of ["2026-12-01", "2027-01-01", "2026-12-31"])
    await expect(
      calendar(page).locator(`[data-date="${date}"]`),
    ).not.toHaveClass(/is-outside/);
  await expect(
    calendar(page).locator('[data-date="2026-12-01"] .calendar-month-label'),
  ).toHaveText("12월");
  await expect(
    calendar(page).locator('[data-date="2027-01-01"] .calendar-month-label'),
  ).toHaveText("2027년 1월");
  // The boundary steps above December's first week and left of its first day.
  await expect(calendar(page).locator('[data-date="2026-12-01"]')).toHaveClass(
    /is-month-left/,
  );
  await expect(calendar(page).locator('[data-date="2026-12-06"]')).toHaveClass(
    /is-month-top/,
  );
  await expect(
    calendar(page).locator('[data-date="2026-12-08"]'),
  ).not.toHaveClass(/is-month-top/);
  // A card crossing the month boundary shows once in each of its weeks.
  await expect(
    calendar(page).locator(
      `.calendar-week-row[data-week="2026-11-29"] .calendar-entry-card`,
      { hasText: "월 경계 일정" },
    ),
  ).toHaveCount(1);
  // Each added month read only its own weeks; nothing before November.
  const ranges = [
    ...new Set(
      reads.map((params) => `${params.get("from")}~${params.get("to")}`),
    ),
  ].sort();
  expect(ranges.slice(0, 3)).toEqual([
    "2026-10-25~2026-12-05",
    "2026-12-06~2027-01-02",
    "2027-01-03~2027-02-06",
  ]);
  ranges
    .slice(1)
    .forEach((range, i) =>
      expect(range.slice(0, 10) > ranges[i].slice(11)).toBe(true),
    );
  // The period selects follow the month at the top.
  await scrollToTop(page, row(page, "2026-12-27"));
  await shownMonth(page, "2027", "1");
  await scrollToTop(page, row(page, "2026-12-13"));
  await shownMonth(page, "2026", "12");
  await page.screenshot({
    path: info.outputPath("month-scroll-december.png"),
  });
  // An entry of an added month opens like any other.
  await calendar(page)
    .getByRole("button", { name: "1월 일정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  await expect(dialog.getByRole("textbox", { name: "일정 제목" })).toHaveValue(
    "1월 일정",
  );
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Scrolling back up stops at the first listed month.
  const before = reads.length;
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await shownMonth(page, "2026", "11");
  await expect(
    calendar(page).locator(".calendar-week-row").first(),
  ).toHaveAttribute("data-week", "2026-10-25");
  await expect(calendar(page).locator('[data-date="2026-10-24"]')).toHaveCount(
    0,
  );
  expect(
    reads.slice(before).every((params) => params.get("from")! >= "2026-10-25"),
  ).toBe(true);
  // 이전 달 lists months again from October, at the top.
  await calendar(page)
    .getByRole("button", { name: "이전 달", exact: true })
    .click();
  await shownMonth(page, "2026", "10");
  await expect(
    calendar(page).locator(".calendar-week-row").first(),
  ).toHaveAttribute("data-week", "2026-09-27");
  await expect(calendar(page).locator('[data-date="2026-09-30"]')).toHaveClass(
    /is-outside/,
  );
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0);
  // 다음 달 brings the week of the next month's first day to the top.
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await shownMonth(page, "2026", "11");
  await expectAtTop(page, row(page, "2026-11-01"));
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await shownMonth(page, "2026", "12");
  await expectAtTop(page, row(page, "2026-11-29"));
  await calendar(page)
    .getByRole("button", { name: "오늘", exact: true })
    .click();
  await shownMonth(page, "2026", "11");
  await expectAtTop(page, row(page, "2026-11-08"));
});

test("이어 붙일 달의 실패는 그 달만 다시 읽고 늦은 응답은 다른 팀원의 달력에 섞이지 않는다", async ({
  page,
}, info) => {
  await seedEntry(page, "12월 일정", "2026-12-16");
  await seedEntry(page, "늦은 1월 일정", "2027-01-20");
  let fail = true;
  let holding = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/calendar?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (fail && params.get("from") === "2026-12-06")
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "12월 일정을 읽지 못했습니다." }),
      });
    else if (
      holding &&
      params.get("from") === "2027-01-03" &&
      params.get("userId") === userId
    ) {
      holding = false;
      const response = await route.fetch();
      started();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* aborted obsolete request */
      }
    } else await route.continue();
  });
  await open(page, "2026-11-12T03:00:00+09:00");
  const waiting = calendar(page).locator(".calendar-month-loading");
  await expect(waiting).toContainText("12월 일정을 읽지 못했습니다.");
  await waiting.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("month-scroll-failed.png") });
  await expect(calendar(page).locator('[data-date="2026-12-16"]')).toHaveCount(
    0,
  );
  // November stays usable and the failure is not the whole calendar's.
  await expect(
    calendar(page).getByRole("button", { name: "캘린더 다시 불러오기" }),
  ).toHaveCount(0);
  await expect(
    calendar(page).locator('[data-date="2026-11-12"] time'),
  ).toHaveAttribute("aria-current", "date");
  fail = false;
  await waiting
    .getByRole("button", { name: "12월 일정 다시 불러오기", exact: true })
    .click();
  await expect(
    calendar(page).getByRole("button", { name: "12월 일정", exact: true }),
  ).toBeVisible();
  // January follows and is held. Choosing another member drops it; that
  // member's months are read again.
  await held;
  await expect(waiting).toContainText("2027년 1월 일정을 불러오는 중");
  await calendar(page)
    .getByRole("group", { name: "캘린더 팀원" })
    .locator(`[data-member-id="${memberId}"]`)
    .click();
  release();
  await scrollUntil(page, calendar(page).locator('[data-date="2027-01-20"]'));
  await expect(
    calendar(page)
      .locator(`.calendar-day[data-owner-id="${memberId}"]`)
      .first(),
  ).toBeAttached();
  await expect(
    calendar(page).locator(`.calendar-day[data-owner-id="${userId}"]`),
  ).toHaveCount(0);
  await expect(
    calendar(page).getByRole("button", { name: "늦은 1월 일정", exact: true }),
  ).toHaveCount(0);
  await calendar(page)
    .getByRole("group", { name: "캘린더 팀원" })
    .locator(`[data-member-id="${userId}"]`)
    .click();
  await scrollUntil(page, calendar(page).locator('[data-date="2027-01-20"]'));
  await expect(
    calendar(page).getByRole("button", { name: "늦은 1월 일정", exact: true }),
  ).toBeVisible();
});

test("12개월까지 이어 붙이면 안내를 보이고 그 뒤의 다음 달은 그 달부터 다시 그린다", async ({
  page,
}) => {
  const reads = calendarReads(page);
  await open(page, "2026-11-12T03:00:00+09:00");
  const limit = calendar(page).locator(".calendar-month-limit");
  await scrollUntil(page, limit);
  await expect(limit).toHaveText(
    "한 번에 12개월까지 이어서 표시합니다. 다음 달 버튼으로 계속 볼 수 있습니다.",
  );
  // November 2026 to October 2027; nothing after October is read.
  await expect(calendar(page).locator('[data-date="2027-10-31"]')).toHaveCount(
    1,
  );
  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await shownMonth(page, "2027", "10");
  await expect(calendar(page).locator(".calendar-month-loading")).toHaveCount(
    0,
  );
  expect(reads.filter((params) => params.get("from")! > "2027-10-31")).toEqual(
    [],
  );
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await shownMonth(page, "2027", "11");
  await expect(
    calendar(page).locator(".calendar-week-row").first(),
  ).toHaveAttribute("data-week", "2027-10-31");
  await expect(calendar(page).locator('[data-date="2026-11-12"]')).toHaveCount(
    0,
  );
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0);
  await expect(limit).toHaveCount(0);
});

test("응답이 늦어도 휠로 내리면 붙는 달마다 한 번씩만 읽는다", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.route("**/api/calendar?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await route.continue();
    } catch {
      /* aborted while waiting */
    }
  });
  const reads: string[] = [];
  const aborted: string[] = [];
  let contextReads = 0;
  let pending = 0;
  const isRead = (url: string) => new URL(url).pathname === "/api/calendar";
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/api/calendar/teams/${teamId}`)
      contextReads++;
    if (!isRead(r.url())) return;
    pending++;
    reads.push(new URL(r.url()).searchParams.get("from")!);
  });
  page.on("requestfinished", (r) => {
    if (isRead(r.url())) pending--;
  });
  page.on("requestfailed", (r) => {
    if (!isRead(r.url())) return;
    pending--;
    aborted.push(new URL(r.url()).searchParams.get("from")!);
  });
  await open(page, "2026-11-12T03:00:00+09:00");
  // The calendar reads again once on the team's first event; count after it.
  await expect.poll(() => contextReads >= 2 && pending === 0).toBe(true);
  reads.length = 0;
  aborted.length = 0;
  await scroller(page).hover();
  const april = calendar(page).locator('[data-date="2027-04-20"]');
  for (let i = 0; i < 80 && !(await april.count()); i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(100);
  }
  await expect(april).toHaveCount(1);
  await expect.poll(() => pending).toBe(0);
  expect(aborted).toEqual([]);
  expect(reads.length).toBeGreaterThanOrEqual(3);
  expect(reads).toEqual([...new Set(reads)]);
  expect(reads).toContain("2027-03-07");
});

test("휴대폰에서도 아래로 넘기면 다음 달이 이어지고 2100년 12월에서 멈춘다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedEntry(page, "모바일 12월 일정", "2026-12-16");
  await open(page, "2026-11-12T03:00:00+09:00");
  await scrollUntil(page, calendar(page).locator('[data-date="2027-02-20"]'));
  await expect(
    calendar(page).locator('[data-date="2026-12-01"] .calendar-month-label'),
  ).toBeVisible();
  expect(
    await scroller(page).evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await scrollToTop(page, row(page, "2026-11-29"));
  await shownMonth(page, "2026", "12");
  await page.screenshot({ path: info.outputPath("month-scroll-mobile.png") });
  await calendar(page)
    .getByRole("button", { name: "모바일 12월 일정", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "캘린더 일정", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 900 });
  await calendar(page).getByLabel("캘린더 연도").selectOption("2100");
  await calendar(page)
    .getByLabel("표시 월", { exact: true })
    .selectOption("11");
  await scrollUntil(page, calendar(page).locator('[data-date="2100-12-31"]'));
  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await shownMonth(page, "2100", "12");
  await expect(
    calendar(page).getByRole("button", { name: "다음 달", exact: true }),
  ).toBeDisabled();
  await expect(calendar(page).locator(".calendar-month-loading")).toHaveCount(
    0,
  );
  await expect(calendar(page).locator('[data-date="2101-01-08"]')).toHaveCount(
    0,
  );
});
