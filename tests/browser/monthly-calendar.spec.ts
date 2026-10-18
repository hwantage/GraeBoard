import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { calendarWeek, addDays } from "../../shared/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
const password = "local-test-only-password";
let teamId: string,
  userId: string,
  memberId: string,
  memberLogin: string,
  taskId: string;
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
  return response.json().then(unpack);
}
const calendar = (page: Page) =>
  page.getByRole("region", { name: "캘린더", exact: true });
const entryDialog = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const source = (page: Page) =>
  entryDialog(page).getByRole("textbox", { name: "일정 문서 Markdown 원문" });
async function enter(page: Page) {
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page).locator(".calendar-grid")).toBeVisible();
}
async function teamWeek(page: Page, start: string) {
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  for (const section of await calendar(page)
    .locator(".calendar-team-section")
    .all()) {
    const row = section.locator(".calendar-week-row");
    await expect(row).toBeVisible();
    let week = (await row.getAttribute("data-week"))!;
    while (week !== start) {
      const forward = week < start;
      await section
        .getByRole("button", { name: forward ? / 다음 주$/ : / 이전 주$/ })
        .click();
      week = addDays(week, forward ? 7 : -7);
      await expect(row).toHaveAttribute("data-week", week);
    }
  }
}
async function create(page: Page, title: string, date = todayKey()) {
  await calendar(page)
    .locator(`[data-date="${date}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  await page.getByRole("textbox", { name: "새 일정 제목" }).fill(title);
  await page.getByRole("button", { name: "일정 만들기", exact: true }).click();
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
}
async function raw(page: Page) {
  await entryDialog(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(source(page)).toBeVisible();
}
async function close(page: Page) {
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
}
async function seedEntry(
  page: Page,
  title: string,
  owner = userId,
  date = todayKey(),
) {
  return request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId: owner,
    date,
    title,
  });
}
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await request(page, "/bootstrap");
  userId = boot.user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `캘린더 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  memberLogin = `calendar-${randomUUID()}@example.com`;
  memberId = (
    await request(page, "/admin/users", "POST", {
      username: memberLogin,
      password,
      name: "서연",
      memberships: [{ teamId, role: "member" }],
    })
  ).user.id;
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: {
        title: "이번 주 함께 진행하는 긴 이름의 연간 업무",
        owner: userId,
        status: "status-progress",
      },
    })
  ).task.id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test("캘린더·문서 브라우저·연간 업무를 오가도 선택 화면과 이동 잠금이 유지된다", async ({
  page,
}) => {
  const navigation = page.getByRole("navigation", { name: "주 메뉴" });
  expect(
    await navigation
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
  ).toEqual(["연간 업무", "문서 브라우저", "캘린더"]);
  const teamSelect = (await page
    .getByLabel("팀 선택", { exact: true })
    .boundingBox())!;
  const navigationBox = (await navigation.boundingBox())!;
  expect(navigationBox.x).toBeGreaterThanOrEqual(
    teamSelect.x + teamSelect.width,
  );
  expect(navigationBox.x - teamSelect.x - teamSelect.width).toBeLessThanOrEqual(
    16,
  );
  const launch = navigation.getByRole("button", {
    name: "캘린더",
    exact: true,
  });
  const launchBox = (await launch.boundingBox())!;
  expect(launchBox.width).toBe(launchBox.height);
  await expect(launch).toHaveCSS("border-radius", "50%");
  await enter(page);
  await expect(page.getByRole("navigation", { name: "주 메뉴" })).toHaveCount(
    0,
  );
  await expect(page.locator(".top-account")).toHaveCount(0);
  const closeCalendar = page.getByRole("button", {
    name: "캘린더 닫기",
    exact: true,
  });
  await expect(closeCalendar).toBeEnabled();
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const box = (await closeCalendar.boundingBox())!;
    expect(box.width).toBe(box.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await expect(closeCalendar).toHaveCSS("border-radius", "50%");
  }
  await closeCalendar.focus();
  await page.keyboard.press("Enter");
  await expect(calendar(page)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(page.locator(".document-browser")).toBeVisible();
  await expect(calendar(page)).toHaveCount(0);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page).locator(".calendar-grid")).toBeVisible();
  await expect(page.locator(".document-browser")).toHaveCount(0);
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
  await expect(calendar(page)).toHaveCount(0);
});

test("주간 업무를 과거·미래에 선택해 넣고 원본 제목과 중복 여부를 함께 유지한다", async ({
  page,
}, info) => {
  const title = "이번 주 함께 진행하는 긴 이름의 연간 업무";
  const planned = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)) + 1,
      fields: {
        title: "다음 연도 예정 업무",
        owner: memberId,
        status: "status-planned",
      },
    })
  ).task;
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "이전 달", exact: true })
    .click();
  const past = calendar(page).locator(".calendar-week-row").first();
  const pastWeek = await past.getAttribute("data-week");
  await past.getByRole("button", { name: "업무 추가", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "주간 업무 추가",
    exact: true,
  });
  await expect(
    picker.getByRole("searchbox", { name: "업무 제목 검색" }),
  ).toBeFocused();
  await picker.getByRole("checkbox", { name: title, exact: true }).check();
  await page.screenshot({ path: info.outputPath("weekly-task-picker.png") });
  const reads: string[] = [];
  let trackReads = true;
  page.on("request", (r) => {
    if (
      trackReads &&
      new URL(r.url()).pathname === "/api/calendar" &&
      r.method() === "GET"
    )
      reads.push(r.url());
  });
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (1)", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(
    past.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  expect(reads).toHaveLength(0);
  await past.getByRole("button", { name: "업무 추가", exact: true }).click();
  await expect(
    picker.getByRole("checkbox", { name: title, exact: true }),
  ).toBeChecked();
  await expect(
    picker.getByRole("checkbox", { name: title, exact: true }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "취소", exact: true }).click();
  trackReads = false;
  await calendar(page)
    .getByRole("button", { name: "오늘", exact: true })
    .click();
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  const future = calendar(page).locator(".calendar-week-row").last();
  const futureWeek = await future.getAttribute("data-week");
  await future.getByRole("button", { name: "업무 추가", exact: true }).click();
  await picker.getByRole("checkbox", { name: title, exact: true }).check();
  await picker
    .getByRole("checkbox", { name: "다음 연도 예정 업무", exact: true })
    .check();
  trackReads = true;
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (2)", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(future.locator(".calendar-week-tasks li")).toHaveCount(2);
  expect(reads).toHaveLength(0);
  trackReads = false;
  await future.getByRole("button", { name: title, exact: true }).click();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await detail
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("모든 주에서 연결된 새 제목");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(
    future.getByRole("button", {
      name: "모든 주에서 연결된 새 제목",
      exact: true,
    }),
  ).toBeVisible();
  await calendar(page)
    .getByRole("button", { name: "이전 달", exact: true })
    .click();
  await calendar(page)
    .getByRole("button", { name: "이전 달", exact: true })
    .click();
  await expect(past).toHaveAttribute("data-week", pastWeek!);
  await expect(
    past.getByRole("button", {
      name: "모든 주에서 연결된 새 제목",
      exact: true,
    }),
  ).toBeVisible();
  const saved = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${userId}&from=${futureWeek}&to=${addDays(futureWeek!, 6)}`,
  );
  expect(saved.weekly.map((item: any) => item.taskId).sort()).toEqual(
    [taskId, planned.id].sort(),
  );
  expect(saved.entries).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath("past-week-linked-task.png"),
    fullPage: true,
  });
});

test("주간 업무 선택은 검색 실패와 저장 응답 유실에도 선택을 보존하고 중복 없이 재시도한다", async ({
  page,
}) => {
  await enter(page);
  let failSearch = true;
  await page.route("**/api/calendar/tasks?*", async (route) => {
    if (failSearch)
      await route.fulfill({
        status: 503,
        json: { error: "검증용 업무 검색 실패" },
      });
    else await route.continue();
  });
  await calendar(page)
    .locator(`.calendar-week-row[data-week="${calendarWeek(todayKey())}"]`)
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "주간 업무 추가",
    exact: true,
  });
  const search = picker.getByRole("searchbox", { name: "업무 제목 검색" });
  await expect(picker.getByRole("alert")).toContainText(
    "검증용 업무 검색 실패",
  );
  failSearch = false;
  await picker
    .getByRole("button", { name: "업무 목록 다시 불러오기", exact: true })
    .click();
  await picker
    .getByRole("checkbox", {
      name: "이번 주 함께 진행하는 긴 이름의 연간 업무",
      exact: true,
    })
    .check();
  await search.fill("없는 업무");
  await expect(
    picker.getByText("검색된 업무가 없습니다.", { exact: true }),
  ).toBeVisible();
  await search.fill("함께 진행");
  await expect(picker.getByRole("checkbox")).toBeChecked();
  let writes = 0;
  await page.route("**/api/calendar/weekly", async (route) => {
    if (++writes === 1) {
      const saved = await route.fetch();
      expect(saved.ok()).toBeTruthy();
      await route.fulfill({ status: 503, json: { error: "검증용 응답 유실" } });
    } else await route.continue();
  });
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (1)", exact: true })
    .click();
  await expect(picker.getByRole("alert")).toContainText("검증용 응답 유실");
  await expect(picker.getByRole("checkbox")).toBeChecked();
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (1)", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(calendar(page).locator(".calendar-week-tasks li")).toHaveCount(
    1,
  );
  expect(writes).toBe(2);
  const saved = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
  );
  expect(saved.weekly).toHaveLength(1);
});

test("주간 업무 검색은 페이지와 좁은 화면에서도 선택을 유지한다", async ({
  page,
}, info) => {
  for (let i = 0; i < 51; i++)
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: {
        title: `페이지 업무 ${String(i).padStart(2, "0")}`,
        owner: userId,
      },
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await calendar(page)
    .locator(`.calendar-week-row[data-week="${calendarWeek(todayKey())}"]`)
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "주간 업무 추가",
    exact: true,
  });
  await picker
    .getByRole("searchbox", { name: "업무 제목 검색" })
    .fill("페이지 업무");
  await expect(picker.getByRole("checkbox")).toHaveCount(50);
  await picker
    .getByRole("checkbox", { name: "페이지 업무 00", exact: true })
    .check();
  await picker.getByRole("button", { name: "다음", exact: true }).click();
  await expect(picker.getByRole("checkbox")).toHaveCount(1);
  await picker
    .getByRole("checkbox", { name: "페이지 업무 50", exact: true })
    .check();
  await picker.getByRole("button", { name: "이전", exact: true }).click();
  await expect(
    picker.getByRole("checkbox", { name: "페이지 업무 00", exact: true }),
  ).toBeChecked();
  const box = (await picker.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("weekly-task-picker-mobile.png"),
  });
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (2)", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(calendar(page).locator(".calendar-week-tasks li")).toHaveCount(
    2,
  );
});

test("팀원 제목과 아바타 아래에서 주차를 독립적으로 이동하고 좁은 화면에서도 탐색한다", async ({
  page,
}, info) => {
  const start = calendarWeek(todayKey());
  await seedEntry(page, "지윤 이번 주 일정", userId, addDays(start, 1));
  await seedEntry(page, "지윤 다음 주 일정", userId, addDays(start, 8));
  await seedEntry(page, "지윤 먼 주 일정", userId, addDays(start, 71));
  await seedEntry(page, "서연 이번 주 일정", memberId, addDays(start, 2));
  await seedEntry(page, "서연 지난 주 일정", memberId, addDays(start, -5));
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  const mine = calendar(page).getByRole("region", {
    name: "지윤 주간 일정",
    exact: true,
  });
  const other = calendar(page).getByRole("region", {
    name: "서연 주간 일정",
    exact: true,
  });
  await expect(
    mine.getByRole("button", { name: "지윤 이번 주 일정", exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "서연 이번 주 일정", exact: true }),
  ).toBeVisible();
  for (const section of [mine, other]) {
    await expect(section.locator(".calendar-member .avatar")).toBeVisible();
    await expect(
      section.locator(".calendar-week-tasks .calendar-member"),
    ).toHaveCount(0);
    await expect(section.locator(".calendar-grid-header > div")).toHaveCount(8);
    const heading = (await section
      .getByRole("heading", { level: 2 })
      .boundingBox())!;
    const grid = (await section.locator(".calendar-grid").boundingBox())!;
    expect(heading.y + heading.height).toBeLessThan(grid.y);
  }
  await expect(
    calendar(page).getByLabel("캘린더 팀원", { exact: true }),
  ).toHaveCount(0);
  const reads: URL[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/calendar") reads.push(url);
  });
  await mine.getByRole("button", { name: "지윤 다음 주", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, 7),
  );
  await expect(
    mine.getByRole("button", { name: "지윤 다음 주 일정", exact: true }),
  ).toBeVisible();
  await expect(other.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    start,
  );
  expect(reads.map((url) => url.searchParams.get("userId"))).toEqual([userId]);
  await other
    .getByRole("button", { name: "서연 이전 주", exact: true })
    .click();
  await expect(
    other.getByRole("button", { name: "서연 지난 주 일정", exact: true }),
  ).toBeVisible();
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, 7),
  );
  expect(reads.map((url) => url.searchParams.get("userId"))).toEqual([
    userId,
    memberId,
  ]);
  await page.screenshot({
    path: info.outputPath("independent-member-weeks.png"),
    fullPage: true,
  });
  // The server caps each read at 62 days. Independent weeks must remain valid
  // even when members are looking at dates more than two months apart.
  for (let offset = 14; offset <= 70; offset += 7) {
    await mine
      .getByRole("button", { name: "지윤 다음 주", exact: true })
      .click();
    await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
      "data-week",
      addDays(start, offset),
    );
  }
  await expect(
    mine.getByRole("button", { name: "지윤 먼 주 일정", exact: true }),
  ).toBeVisible();
  await expect(other.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, -7),
  );
  await calendar(page).getByRole("button", { name: "개인 월간 보기" }).click();
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, 70),
  );
  await expect(other.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, -7),
  );
  await mine.getByRole("button", { name: "지윤 이번 주", exact: true }).click();
  await expect(
    mine.getByRole("button", { name: "지윤 이번 주 일정", exact: true }),
  ).toBeVisible();
  await expect(other.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, -7),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await calendar(page)
    .getByLabel("달력 가로·세로 스크롤")
    .evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
  for (const section of [mine, other]) {
    const heading = (await section
      .locator(".calendar-team-heading")
      .boundingBox())!;
    const navigation = (await section
      .getByRole("group", { name: /주간 탐색/ })
      .boundingBox())!;
    expect(heading.x).toBeGreaterThanOrEqual(0);
    expect(navigation.x).toBeGreaterThanOrEqual(heading.x);
    expect(navigation.x + navigation.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    path: info.outputPath("independent-member-weeks-mobile.png"),
    fullPage: true,
  });
});

test("팀원별 조회 실패가 다른 달력을 가리지 않고 해당 주의 가져오기와 편집을 유지한다", async ({
  page,
}) => {
  const start = calendarWeek(todayKey());
  const next = addDays(start, 7);
  await request(page, `/calendar/teams/${teamId}/rule`, "PUT", {
    propertyId: "status",
    values: ["status-progress"],
    mode: "include",
    expectedRevision: 0,
  });
  const memberTask = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: {
        title: "서연의 연간 업무",
        owner: memberId,
        status: "status-progress",
      },
    })
  ).task;
  await seedEntry(page, "지윤 유지할 일정", userId, addDays(start, 1));
  const entry = await seedEntry(
    page,
    "서연 다음 주 편집",
    memberId,
    addDays(next, 1),
  );
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  const mine = calendar(page).getByRole("region", {
    name: "지윤 주간 일정",
    exact: true,
  });
  const other = calendar(page).getByRole("region", {
    name: "서연 주간 일정",
    exact: true,
  });
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(2);
  let fail = true;
  await page.route("**/api/calendar?*", async (route) => {
    const url = new URL(route.request().url());
    if (
      fail &&
      url.searchParams.get("userId") === memberId &&
      url.searchParams.get("from") === next
    )
      await route.fulfill({
        status: 503,
        json: { error: "팀원 일정 조회 실패" },
      });
    else await route.continue();
  });
  await other
    .getByRole("button", { name: "서연 다음 주", exact: true })
    .click();
  await expect(other.getByRole("alert")).toContainText("팀원 일정 조회 실패");
  await expect(
    mine.getByRole("button", { name: "지윤 유지할 일정", exact: true }),
  ).toBeVisible();
  fail = false;
  await other.getByRole("button", { name: "서연 일정 다시 불러오기" }).click();
  await expect(
    other.getByRole("button", { name: "서연 다음 주 편집", exact: true }),
  ).toBeVisible();
  await other.getByRole("button", { name: "업무 추가", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "주간 업무 추가",
    exact: true,
  });
  await picker
    .getByRole("checkbox", { name: "서연의 연간 업무", exact: true })
    .check();
  await picker
    .getByRole("button", { name: "선택한 업무 추가 (1)", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(
    other.getByRole("button", { name: "서연의 연간 업무", exact: true }),
  ).toBeVisible();
  await expect(mine.locator(".calendar-week-tasks li")).toHaveCount(0);
  const imported = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${memberId}&from=${next}&to=${addDays(next, 6)}`,
  );
  expect(
    imported.weekly.map((item: any) => [
      item.userId,
      item.weekStart,
      item.taskId,
    ]),
  ).toEqual([[memberId, next, memberTask.id]]);
  await other
    .getByRole("button", { name: "서연 다음 주 편집", exact: true })
    .click();
  await entryDialog(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("서연 수정된 일정");
  await close(page);
  await expect(
    other.getByRole("button", { name: "서연 수정된 일정", exact: true }),
  ).toBeVisible();
  await other
    .getByRole("button", { name: "서연 수정된 일정", exact: true })
    .press("Alt+ArrowRight");
  await expectRange(page, entry.id, addDays(next, 2), addDays(next, 2));
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    start,
  );
  await expect(
    mine.getByRole("button", { name: "지윤 유지할 일정", exact: true }),
  ).toBeVisible();
});

test("팀원 주차를 연속 이동해도 늦은 응답이 최신 주차와 다른 팀원의 일정을 덮지 않는다", async ({
  page,
}) => {
  const start = calendarWeek(todayKey());
  await seedEntry(page, "지윤 그대로 볼 일정", userId, addDays(start, 1));
  await seedEntry(page, "서연 늦은 응답 일정", memberId, addDays(start, 8));
  await seedEntry(page, "서연 최종 주차 일정", memberId, addDays(start, 15));
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(2);
  const mine = calendar(page).getByRole("region", {
    name: "지윤 주간 일정",
    exact: true,
  });
  const other = calendar(page).getByRole("region", {
    name: "서연 주간 일정",
    exact: true,
  });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/calendar?*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("userId") === memberId &&
      url.searchParams.get("from") === addDays(start, 7)
    ) {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await other
      .getByRole("button", { name: "서연 다음 주", exact: true })
      .click();
    await reading;
    await expect(
      mine.getByRole("button", { name: "지윤 그대로 볼 일정", exact: true }),
    ).toBeVisible();
    await other
      .getByRole("button", { name: "서연 다음 주", exact: true })
      .click();
    await expect(
      other.getByRole("button", { name: "서연 최종 주차 일정", exact: true }),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(other.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    addDays(start, 14),
  );
  await expect(
    other.getByRole("button", { name: "서연 늦은 응답 일정", exact: true }),
  ).toHaveCount(0);
  await expect(mine.locator(".calendar-week-row")).toHaveAttribute(
    "data-week",
    start,
  );
});

test("주 메뉴, 월 이동과 날짜 강조, 공통 Markdown 저장·수정·삭제가 실제 API에 연결된다", async ({
  page,
}, info) => {
  await enter(page);
  await expect(
    page.getByRole("button", { name: "캘린더 닫기", exact: true }),
  ).toBeEnabled();
  await expect(
    calendar(page).locator(".calendar-grid-header > div"),
  ).toHaveCount(8);
  await expect(
    calendar(page).locator(`[data-date="${todayKey()}"] time`),
  ).toHaveAttribute("aria-current", "date");
  await create(page, "캘린더에서 쓴 기록");
  await raw(page);
  const markdown =
    "# 오늘의 기록\n\n- [ ] 한국어 일정\n- 회의 준비\n\n| 항목 | 결과 |\n| --- | --- |\n| 검토 | 완료 |";
  await source(page).fill(markdown);
  await close(page);
  const list = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
  );
  expect(list.entries).toHaveLength(1);
  const id = list.entries[0].id;
  expect(
    (await request(page, `/calendar/entries/${id}/document`)).markdown,
  ).toBe(markdown);
  expect(
    (
      await request(
        page,
        `/tasks?teamId=${teamId}&year=${todayKey().slice(0, 4)}`,
      )
    ).tasks,
  ).toHaveLength(1);
  await calendar(page)
    .getByRole("button", { name: /캘린더에서 쓴 기록/ })
    .click();
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toContainText("오늘의 기록");
  await expect(
    entryDialog(page).locator(".document-prose table"),
  ).toBeVisible();
  await entryDialog(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("수정된 제목");
  await raw(page);
  await source(page).fill(markdown + "\n\n수정 완료");
  await close(page);
  await expect(
    calendar(page).getByRole("button", { name: /수정된 제목/ }),
  ).toBeVisible();
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await calendar(page)
    .getByRole("button", { name: "오늘", exact: true })
    .click();
  await expect(
    calendar(page).getByRole("button", { name: /수정된 제목/ }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("monthly-calendar.png"),
    fullPage: true,
  });
  await calendar(page)
    .getByRole("button", { name: /수정된 제목/ })
    .click();
  await entryDialog(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
  await expect(
    calendar(page).getByRole("button", { name: /수정된 제목/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "연간 업무", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});

test("개인 요일 설정은 재로그인 후 유지되고 숨긴 날짜 보존·팀 주간 비교·다른 사용자의 기본값을 지킨다", async ({
  page,
}, info) => {
  const sunday = calendarWeek(todayKey());
  await seedEntry(page, "일요일 보존 일정", userId, sunday);
  await seedEntry(page, "서연의 일정", memberId, addDays(sunday, 1));
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "내 표시 요일 설정" })
    .click();
  const settings = page.getByRole("dialog", { name: "내 캘린더 표시 요일" });
  await settings.getByRole("button", { name: "월~목", exact: true }).click();
  await settings.getByRole("button", { name: "요일 설정 저장" }).click();
  await expect(
    calendar(page).locator(".calendar-grid-header > div"),
  ).toHaveCount(5);
  await expect(
    calendar(page).getByRole("button", { name: "숨긴 요일에 일정 1개" }),
  ).toBeVisible();
  await page.reload();
  await enter(page);
  await expect(
    calendar(page).locator(".calendar-grid-header > div"),
  ).toHaveCount(5);
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(2);
  await expect(
    calendar(page).getByRole("button", { name: "서연의 일정", exact: true }),
  ).toBeVisible();
  await expect(calendar(page).locator(".calendar-member")).toContainText([
    "서연",
    "지윤",
  ]);
  await page.screenshot({
    path: info.outputPath("team-weekly-calendar.png"),
    fullPage: true,
  });
  await request(page, "/auth/logout", "POST", {});
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  expect((await request(page, "/calendar/preferences")).weekdays).toEqual([
    1, 2, 3, 4,
  ]);
  expect(
    (
      await request(
        page,
        `/calendar/entries/${(await request(page, `/calendar?teamId=${teamId}&userId=${userId}&from=${sunday}&to=${sunday}`)).entries[0].id}`,
      )
    ).date,
  ).toBe(sunday);
  await request(page, "/auth/logout", "POST", {});
  await request(page, "/auth/login", "POST", {
    username: memberLogin,
    password,
  });
  await page.reload();
  await enter(page);
  await expect(
    calendar(page).locator(".calendar-grid-header > div"),
  ).toHaveCount(8);
  await expect(
    calendar(page).getByRole("button", {
      name: "주간 할 일 기준",
      exact: true,
    }),
  ).toHaveCount(0);
  await calendar(page).getByLabel("캘린더 팀원").selectOption(userId);
  await expect(
    calendar(page).getByRole("button", { name: /일정 추가/ }),
  ).toHaveCount(0);
});

test("주간 기준은 작업·팀원을 제외한 속성에서 기존 필터의 검색·복수 선택·미지정·일치·제외를 제공한다", async ({
  page,
}, info) => {
  const context = await request(page, `/calendar/teams/${teamId}`);
  const properties = [
    ...context.settings.properties,
    ...[
      ["rule_text", "검토 메모", "text"],
      ["rule_date", "예정일", "date"],
      ["rule_number", "점수", "number"],
      ["rule_reviewers", "검토자", "member"],
    ].map(([id, name, kind]) => ({
      id,
      name,
      kind,
      display: "text",
      values: [],
      visible: false,
      ...(kind === "member" ? { multiple: true } : {}),
    })),
    {
      id: "rule_archived",
      name: "보관 속성",
      kind: "text",
      display: "text",
      values: [],
      archived: true,
    },
  ];
  await request(page, `/teams/${teamId}/settings`, "PATCH", { properties });
  for (const [title, memo, score, date] of [
    ["대기 중인 검토 업무", "검토 대기", 0, todayKey()],
    ["완료한 검토 업무", "검토 완료", 2, addDays(todayKey(), 1)],
  ]) {
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: {
        title,
        owner: userId,
        rule_text: memo,
        rule_number: score,
        rule_date: date,
        rule_reviewers: [userId, memberId],
      },
    });
  }
  await enter(page);
  let reads = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/tasks" && r.method() === "GET")
      reads++;
  });
  const open = async () => {
    await calendar(page)
      .getByRole("button", { name: "주간 할 일 기준", exact: true })
      .click();
    return page.getByRole("dialog", { name: "주간 할 일 기준", exact: true });
  };
  const rule = await open();
  const select = rule.getByLabel("기준 속성");
  await expect(select.locator("option")).toHaveText([
    "속성을 선택하세요",
    ...properties.filter((p) => !p.archived).map((p) => p.name),
  ]);
  await expect(select.locator('option[value="title"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(select.locator('option[value="owner"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await select.selectOption("status");
  const status = rule.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await status.getByRole("searchbox").fill("진행");
  await expect(
    status.getByRole("checkbox", { name: "완료", exact: true }),
  ).toHaveCount(0);
  await status.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await status.getByRole("radio", { name: "제외", exact: true }).check();
  await select.selectOption("rule_reviewers");
  const reviewers = rule.getByRole("group", {
    name: "검토자 필터 선택",
    exact: true,
  });
  await expect(
    reviewers.getByRole("radio", { name: "일치", exact: true }),
  ).toBeChecked();
  await reviewers.getByRole("checkbox", { name: "지윤", exact: true }).check();
  await reviewers.getByRole("checkbox", { name: "서연", exact: true }).check();
  await expect(reviewers).toContainText("2개 일치");
  expect(reads).toBe(0);
  for (const [id, name, labels] of [
    ["rule_date", "예정일", [todayKey(), addDays(todayKey(), 1)]],
    ["rule_number", "점수", ["0", "2"]],
    ["rule_text", "검토 메모", ["검토 대기", "검토 완료"]],
  ] as const) {
    await select.selectOption(id);
    const filter = rule.getByRole("group", {
      name: `${name} 필터 선택`,
      exact: true,
    });
    for (const label of labels)
      await filter.getByRole("checkbox", { name: label, exact: true }).check();
    await filter.getByRole("checkbox", { name: "미지정", exact: true }).check();
    await expect(filter).toContainText("3개 일치");
    await filter.getByRole("button", { name: `${name} 필터 해제` }).click();
    await expect(filter.getByRole("checkbox", { checked: true })).toHaveCount(
      0,
    );
    await expect(filter).toContainText("전체 표시");
  }
  const filter = rule.getByRole("group", {
    name: "검토 메모 필터 선택",
    exact: true,
  });
  await filter.getByRole("searchbox").fill("대기");
  await filter
    .getByRole("checkbox", { name: "검토 대기", exact: true })
    .check();
  await filter.getByRole("radio", { name: "일치", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    filter.getByRole("radio", { name: "제외", exact: true }),
  ).toBeChecked();
  await expect(
    filter.getByRole("checkbox", { name: "검토 완료", exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(1);
  await page.screenshot({
    path: info.outputPath("weekly-rule-exclude-filter.png"),
  });
  await rule.getByRole("button", { name: "기준 저장", exact: true }).click();
  await expect(rule).toHaveCount(0);
  const saved = (await request(page, `/calendar/teams/${teamId}`)).rule;
  expect(saved).toMatchObject({
    propertyId: "rule_text",
    values: ["검토 대기"],
    mode: "exclude",
  });
  await page.reload();
  await enter(page);
  await open();
  await expect(
    rule.getByRole("checkbox", { name: "검토 대기", exact: true }),
  ).toBeChecked();
  await expect(
    rule.getByRole("radio", { name: "제외", exact: true }),
  ).toBeChecked();
  await rule.getByRole("button", { name: "취소", exact: true }).click();
  await calendar(page)
    .getByRole("button", { name: "이번주 할일 확인", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("2개 가져옴");
  await expect(
    calendar(page).getByRole("button", {
      name: "대기 중인 검토 업무",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    calendar(page).getByRole("button", {
      name: "완료한 검토 업무",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    calendar(page).getByRole("button", {
      name: "이번 주 함께 진행하는 긴 이름의 연간 업무",
      exact: true,
    }),
  ).toBeVisible();
});

test("주간 기준의 값 조회 실패는 재시도하고 속성 전환 시 늦은 응답을 무시한다", async ({
  page,
}) => {
  const context = await request(page, `/calendar/teams/${teamId}`);
  await request(page, `/teams/${teamId}/settings`, "PATCH", {
    properties: [
      ...context.settings.properties,
      {
        id: "description",
        name: "설명",
        kind: "text",
        display: "text",
        values: [],
        visible: false,
      },
    ],
  });
  await request(page, "/tasks", "POST", {
    teamId,
    year: Number(todayKey().slice(0, 4)),
    fields: { title: "검토 업무", owner: userId, description: "검토할 내용" },
  });
  await enter(page);
  let attempts = 0;
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?*", async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "검증용 값 조회 실패" },
      });
    } else if (attempts === 2) {
      const requestHeaders = { ...route.request().headers() };
      delete requestHeaders["if-none-match"];
      const response = await route.fetch({ headers: requestHeaders });
      await delayed;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await calendar(page)
    .getByRole("button", { name: "주간 할 일 기준", exact: true })
    .click();
  const rule = page.getByRole("dialog", {
    name: "주간 할 일 기준",
    exact: true,
  });
  const select = rule.getByLabel("기준 속성");
  await select.selectOption("description");
  await expect(rule).toContainText("검증용 값 조회 실패");
  await expect(
    rule.getByRole("button", { name: "기준 저장", exact: true }),
  ).toBeDisabled();
  await select.selectOption("status");
  await expect(
    rule.getByRole("group", { name: "상태 필터 선택", exact: true }),
  ).toBeVisible();
  await expect(
    rule.getByRole("button", { name: "기준 저장", exact: true }),
  ).toBeEnabled();
  await select.selectOption("description");
  await rule
    .getByRole("button", { name: "필터 값 다시 불러오기", exact: true })
    .click();
  await expect(rule.getByRole("status")).toHaveText(
    "필터 값을 불러오고 있습니다…",
  );
  await expect.poll(() => attempts).toBe(2);
  await select.selectOption("status");
  await rule.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  release();
  await expect(
    rule.getByRole("group", { name: "설명 필터 선택", exact: true }),
  ).toHaveCount(0);
  await select.selectOption("description");
  await rule
    .getByRole("checkbox", {
      name: "검토할 내용",
      exact: true,
    })
    .check();
  await expect(
    rule.getByRole("button", { name: "기준 저장", exact: true }),
  ).toBeEnabled();
  await rule.getByRole("button", { name: "기준 저장", exact: true }).click();
  await expect(rule).toHaveCount(0);
  expect((await request(page, `/calendar/teams/${teamId}`)).rule).toMatchObject(
    {
      propertyId: "description",
      values: ["검토할 내용"],
      mode: "include",
    },
  );
});

test("기준 설정과 화면 이동은 가져오지 않으며 명시적 확인만 중복 없이 실제 작업 상세를 연다", async ({
  page,
}) => {
  const imports: string[] = [];
  let checking = false;
  const calendarReads: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/calendar/import")) imports.push(r.url());
    if (
      checking &&
      new URL(r.url()).pathname === "/api/calendar" &&
      r.method() === "GET"
    )
      calendarReads.push(r.url());
  });
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "주간 할 일 기준", exact: true })
    .click();
  const rule = page.getByRole("dialog", {
    name: "주간 할 일 기준",
    exact: true,
  });
  await rule.getByLabel("기준 속성").selectOption("status");
  await rule.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await rule.getByRole("button", { name: "기준 저장", exact: true }).click();
  await expect(rule).toHaveCount(0);
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await calendar(page)
    .getByRole("button", { name: "오늘", exact: true })
    .click();
  expect(imports).toHaveLength(0);
  await expect(
    calendar(page).getByRole("button", {
      name: "이번주 할일 확인",
      exact: true,
    }),
  ).toBeEnabled();
  checking = true;
  await calendar(page)
    .getByRole("button", { name: "이번주 할일 확인", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("1개 가져옴");
  await calendar(page)
    .getByRole("button", { name: "이번주 할일 확인", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("기존 1개 유지");
  await expect(page.locator(".calendar-notice")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 5500 });
  expect(calendarReads).toHaveLength(0);
  checking = false;
  const taskButton = calendar(page).getByRole("button", {
    name: "이번 주 함께 진행하는 긴 이름의 연간 업무",
    exact: true,
  });
  await expect(taskButton).toHaveCount(1);
  await taskButton.click();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await detail
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("캘린더에서 연 실제 업무 수정");
  await detail.getByRole("button", { name: "문서 작성", exact: true }).click();
  await detail
    .getByRole("textbox", { name: "업무 문서 리치 편집" })
    .fill("연간 업무의 문서");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(
    calendar(page).getByRole("button", {
      name: "캘린더에서 연 실제 업무 수정",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await request(page, `/tasks/${taskId}/documents/main`)).markdown,
  ).toContain("연간 업무의 문서");
  const anotherWeek = calendar(page)
    .locator(
      `.calendar-week-row:not([data-week="${calendarWeek(todayKey())}"])`,
    )
    .first();
  await anotherWeek
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "주간 업무 추가",
    exact: true,
  });
  await expect(picker.locator(".calendar-hint").first()).toContainText(
    (await anotherWeek.getAttribute("data-week"))!,
  );
  await picker.getByRole("button", { name: "취소", exact: true }).click();
  await expect(
    anotherWeek.getByRole("button", {
      name: "이번주 할일 확인",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(imports).toHaveLength(2);
});

test("저장 실패 중 닫기와 전환은 입력을 버리지 않고 재시도로 저장한다", async ({
  page,
}) => {
  await enter(page);
  await create(page, "저장 실패 검증");
  await raw(page);
  let fail = true;
  await page.route("**/api/calendar/entries/*/document", async (route) => {
    if (fail && route.request().method() === "PUT")
      await route.fulfill({ status: 503, json: { error: "검증용 저장 실패" } });
    else await route.continue();
  });
  await source(page).fill("실패해도 남아야 하는 한국어 입력");
  await expect(entryDialog(page).getByRole("alert")).toContainText(
    "검증용 저장 실패",
  );
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(source(page)).toHaveValue("실패해도 남아야 하는 한국어 입력");
  await expect(
    page.getByRole("button", { name: "캘린더 닫기", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("팀 선택", { exact: true })).toBeDisabled();
  fail = false;
  await entryDialog(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await expect(entryDialog(page).getByRole("status")).toHaveText("저장됨");
  await close(page);
  await calendar(page)
    .getByRole("button", { name: /저장 실패 검증/ })
    .click();
  await raw(page);
  await expect(source(page)).toHaveValue("실패해도 남아야 하는 한국어 입력");
});

test("본문 충돌은 서버와 내 입력을 함께 보여 주며 명시적 교체 후 저장한다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "충돌 검증");
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "충돌 검증", exact: true })
    .click();
  await raw(page);
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: "다른 창에서 저장",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await source(page).fill("현재 창의 미저장 입력");
  await expect(entryDialog(page).getByRole("alert")).toContainText(
    "다른 사용자가 일정을 수정",
  );
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(source(page)).toHaveValue("현재 창의 미저장 입력");
  await entryDialog(page)
    .getByText("최신 서버 문서 확인 (내 입력은 아래에 유지)")
    .click();
  await expect(entryDialog(page).locator(".document-conflict pre")).toHaveText(
    "다른 창에서 저장",
  );
  await entryDialog(page)
    .getByRole("button", { name: "내 입력으로 최신 문서 교체", exact: true })
    .click();
  await expect(entryDialog(page).getByRole("status")).toHaveText("저장됨");
  await close(page);
  expect(
    (await request(page, `/calendar/entries/${entry.id}/document`)).markdown,
  ).toBe("현재 창의 미저장 입력");
});

test("늦은 팀원/기간 응답은 현재 범위에 섞이지 않으며 좁은 화면에서 주간 열을 유지한다", async ({
  page,
  browserName,
}, info) => {
  await seedEntry(page, "지윤의 현재 일정");
  await seedEntry(page, "서연의 현재 일정", memberId);
  await enter(page);
  let release: () => void = () => {};
  let intercepted: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route("**/api/calendar?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("userId") === memberId
    ) {
      const response = await route.fetch();
      intercepted();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* aborted obsolete request */
      }
    } else await route.continue();
  });
  await calendar(page).getByLabel("캘린더 팀원").selectOption(memberId);
  await started;
  await calendar(page).getByLabel("캘린더 팀원").selectOption(userId);
  release();
  await expect(
    calendar(page).getByRole("button", {
      name: "지윤의 현재 일정",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    calendar(page).getByRole("button", {
      name: "서연의 현재 일정",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(calendar(page).getByLabel("캘린더 팀원")).toBeVisible();
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const sticky = await calendar(page)
    .locator(".calendar-week-tasks")
    .first()
    .boundingBox();
  expect(sticky!.x).toBeGreaterThanOrEqual(0);
  expect(sticky!.width).toBeGreaterThanOrEqual(170);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("mobile-calendar.png"),
    fullPage: true,
  });
  // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .press(
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab",
    );
  await expect(
    calendar(page).getByRole("button", { name: "개인 태그 관리", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: info.outputPath("calendar-toolbar-focus.png"),
  });
  await calendar(page)
    .getByRole("button", { name: "개인 태그 관리", exact: true })
    .press(
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab",
    );
  await expect(
    calendar(page).getByRole("button", { name: "내 표시 요일 설정" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "내 캘린더 표시 요일" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    calendar(page).getByRole("button", { name: "내 표시 요일 설정" }),
  ).toBeFocused();
});

test("월 경계·윤일·4~6주·임의 요일은 실제 화면의 날짜와 조회 범위를 유지한다", async ({
  page,
}) => {
  await seedEntry(page, "윤일 일정", userId, "2024-02-29");
  await enter(page);
  await calendar(page).getByLabel("캘린더 연도").selectOption("2024");
  await calendar(page).getByLabel("표시 월", { exact: true }).selectOption("2");
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(5);
  await expect(
    calendar(page).getByRole("button", { name: "윤일 일정", exact: true }),
  ).toBeVisible();
  await expect(
    calendar(page).locator('[data-date="2024-02-29"]'),
  ).toBeVisible();
  await calendar(page).getByLabel("캘린더 연도").selectOption("2026");
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(6);
  await calendar(page).getByLabel("표시 월", { exact: true }).selectOption("8");
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(6);
  await calendar(page)
    .getByLabel("표시 월", { exact: true })
    .selectOption("12");
  await calendar(page)
    .getByRole("button", { name: "다음 달", exact: true })
    .click();
  await expect(calendar(page).getByLabel("캘린더 연도")).toHaveValue("2027");
  await expect(
    calendar(page).getByLabel("표시 월", { exact: true }),
  ).toHaveValue("1");
  await calendar(page)
    .getByRole("button", { name: "내 표시 요일 설정" })
    .click();
  const settings = page.getByRole("dialog", { name: "내 캘린더 표시 요일" });
  for (const name of [
    "월요일",
    "화요일",
    "수요일",
    "목요일",
    "금요일",
    "토요일",
  ])
    await settings.getByRole("checkbox", { name, exact: true }).uncheck();
  await expect(
    settings.getByRole("checkbox", { name: "일요일", exact: true }),
  ).toBeDisabled();
  await settings.getByRole("button", { name: "요일 설정 저장" }).click();
  await expect(
    calendar(page).locator(".calendar-grid-header > div"),
  ).toHaveCount(2);
  await expect(
    calendar(page).locator(".calendar-week-row").first(),
  ).toContainText("12/27 ~ 01/02");
  await expect(
    calendar(page).locator('[data-date="2026-12-27"]'),
  ).toBeVisible();
});

test("제목 충돌과 닫아 둔 본문 초안은 다시 열 때 복원되며 다른 팀원 일정에 섞이지 않는다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "제목 충돌 원본");
  await seedEntry(page, "서연의 별도 일정", memberId);
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "제목 충돌 원본", exact: true })
    .click();
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
    title: "다른 창의 제목",
    expectedTitle: "제목 충돌 원본",
  });
  await entryDialog(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("내가 쓴 제목");
  await expect(entryDialog(page).getByRole("alert")).toContainText(
    "다른 사용자가 제목을 수정",
  );
  await entryDialog(page)
    .getByRole("button", { name: "내 제목으로 최신 제목 교체", exact: true })
    .click();
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${entry.id}`)).title,
    )
    .toBe("내가 쓴 제목");
  await raw(page);
  let fail = true;
  await page.route("**/api/calendar/entries/*/document", async (route) =>
    fail && route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "오프라인 저장 검증" } })
      : route.continue(),
  );
  await source(page).fill("닫아도 보관할 초안");
  await expect(entryDialog(page).getByRole("alert")).toContainText(
    "오프라인 저장 검증",
  );
  await entryDialog(page)
    .getByRole("button", { name: "초안 보관하고 닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
  await calendar(page).getByLabel("캘린더 팀원").selectOption(memberId);
  await calendar(page)
    .getByRole("button", { name: "서연의 별도 일정", exact: true })
    .click();
  await raw(page);
  await expect(source(page)).toHaveValue("");
  await close(page);
  await calendar(page).getByLabel("캘린더 팀원").selectOption(userId);
  fail = false;
  await calendar(page)
    .getByRole("button", { name: "내가 쓴 제목", exact: true })
    .click();
  await raw(page);
  await expect(source(page)).toHaveValue("닫아도 보관할 초안");
  await close(page);
  expect(
    (await request(page, `/calendar/entries/${entry.id}/document`)).markdown,
  ).toBe("닫아도 보관할 초안");
});

test("일정 제목의 한 번 누른 공백과 커서가 자동 저장·한글 조합 뒤에도 유지된다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "공백 입력 검증");
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "공백 입력 검증", exact: true })
    .click();
  const title = entryDialog(page).getByRole("textbox", {
    name: "일정 제목",
    exact: true,
  });
  await expect(title).not.toHaveAttribute("readonly");
  const card = calendar(page).locator(
    `[data-entry-id="${entry.id}"] .calendar-entry-card`,
  );
  let release = () => {},
    started = () => {},
    writes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/calendar/entries/${entry.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    const response = await route.fetch();
    if (writes === 1) {
      started();
      await gate;
    }
    await route.fulfill({ response });
  });
  try {
    await title.fill("회의");
    await held;
    // A space typed after the request starts must survive its trimmed response.
    await title.press("End");
    await title.press("Space");
    release();
    await expect(card).toHaveText("회의");
    await expect(title).toHaveValue("회의 ");
    await expect
      .poll(() =>
        title.evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      )
      .toEqual([3, 3]);

    // Wait beyond the 700ms autosave interval: whitespace alone is not a write.
    await title.press("Space");
    await page.waitForTimeout(850);
    await expect(title).toHaveValue("회의  ");
    expect(writes).toBe(1);

    await title.dispatchEvent("compositionstart");
    await title.fill("  팀  회의 ");
    await title.dispatchEvent("compositionend", { data: "회의" });
    await expect(card).toHaveText("팀  회의");
    await expect(title).toHaveValue("  팀  회의 ");
    await title.press("End");
    await page.keyboard.insertText("준비");
    await close(page);
    expect((await request(page, `/calendar/entries/${entry.id}`)).title).toBe(
      "팀  회의 준비",
    );
    await card.click();
    await expect(title).toHaveValue("팀  회의 준비");
    await close(page);
  } finally {
    release();
  }
});

test("늦은 제목 저장 응답이 더 최신인 본문 미리보기와 삭제 버전을 되돌리지 않는다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "응답 순서 검증");
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "응답 순서 검증", exact: true })
    .click();
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  let release: () => void = () => {},
    started: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/calendar/entries/${entry.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await entryDialog(page)
      .getByRole("textbox", { name: "일정 제목", exact: true })
      .fill("늦게 도착한 새 제목");
    await held;
    await raw(page);
    await source(page).fill("먼저 도착한 최신 본문 미리보기");
    await expect(entryDialog(page).getByRole("status")).toHaveText("저장됨");
    release();
    await close(page);
    const card = calendar(page).getByRole("button", {
      name: /늦게 도착한 새 제목/,
    });
    await expect(card).toHaveAccessibleName(
      "늦게 도착한 새 제목 먼저 도착한 최신 본문 미리보기",
    );
    await expect(card).toHaveText("늦게 도착한 새 제목");
    await card.click();
    await entryDialog(page)
      .getByRole("button", { name: "일정 삭제", exact: true })
      .click();
    await expect(entryDialog(page)).toHaveCount(0);
  } finally {
    release();
  }
});

test("캘린더의 이미지 붙여넣기는 공통 업로더로 해당 팀에 저장하고 Markdown 왕복 후 유지한다", async ({
  page,
}) => {
  await enter(page);
  await create(page, "이미지 일정");
  const rich = entryDialog(page).getByRole("textbox", {
    name: "일정 문서 리치 편집",
  });
  const uploaded = page.waitForResponse(
    (response) =>
      /\/calendar\/entries\/[^/]+\/document\/images$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await rich.focus();
  await rich.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#177b70";
    context.fillRect(0, 0, 64, 48);
    const bytes = Uint8Array.from(
      atob(canvas.toDataURL("image/png").split(",")[1]),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "일정 이미지.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  expect((await uploaded).status()).toBe(201);
  await expect(rich.locator("img[src]")).toHaveAttribute(
    "src",
    new RegExp(`/api/document-images/${teamId}/`),
  );
  await expect
    .poll(() =>
      rich
        .locator("img[src]")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(64);
  await raw(page);
  await expect(source(page)).toHaveValue(
    new RegExp(`/api/document-images/${teamId}/`),
  );
  await close(page);
  await calendar(page)
    .getByRole("button", { name: /이미지 일정/ })
    .click();
  await expect(entryDialog(page).locator("img[src]")).toBeVisible();
});

test("새 일정 초안을 임시 보관할 수 없으면 닫기를 막고 서버 저장 후에는 정상적으로 연다", async ({
  page,
}) => {
  await enter(page);
  await calendar(page)
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).restoreCalendarStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("weekly-plan:calendar-create:"))
        throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page
    .getByRole("textbox", { name: "새 일정 제목" })
    .fill("임시 보관 실패해도 유지");
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "새 일정 제목" }),
  ).toHaveValue("임시 보관 실패해도 유지");
  await expect(dialog.getByRole("alert")).toContainText(
    "임시 보관할 수 없습니다",
  );
  await dialog
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).restoreCalendarStorage());
  await close(page);
  await expect(
    calendar(page).getByRole("button", {
      name: "임시 보관 실패해도 유지",
      exact: true,
    }),
  ).toBeVisible();
});

test("제목과 본문 저장 실패 중 초안 닫기는 본문 임시 보관까지 확인하고 복원한다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "두 입력 보호");
  await enter(page);
  await calendar(page)
    .getByRole("button", { name: "두 입력 보호", exact: true })
    .click();
  await raw(page);
  await page.route("**/api/calendar/entries/**", async (route) => {
    if (["PATCH", "PUT"].includes(route.request().method()))
      await route.fulfill({ status: 503, json: { error: "두 저장 실패" } });
    else await route.continue();
  });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).restoreCalendarStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("weekly-plan:calendar-document:"))
        throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await entryDialog(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("보관할 제목");
  await source(page).fill("보관할 본문");
  const heading = entryDialog(page).locator(".calendar-entry-heading");
  await expect(heading.getByRole("alert")).toContainText("두 저장 실패");
  await expect(entryDialog(page).locator(".document-error")).toContainText(
    "두 저장 실패",
  );
  await heading
    .getByRole("button", { name: "초안 보관하고 닫기", exact: true })
    .click();
  await expect(source(page)).toHaveValue("보관할 본문");
  await expect(entryDialog(page).locator(".document-notice")).toContainText(
    "임시 보관할 공간이 부족",
  );
  await page.evaluate(() => (window as any).restoreCalendarStorage());
  await heading
    .getByRole("button", { name: "초안 보관하고 닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
  await page.unrouteAll();
  await calendar(page)
    .getByRole("button", { name: "두 입력 보호", exact: true })
    .click();
  await raw(page);
  await expect(source(page)).toHaveValue("보관할 본문");
  await expect(
    entryDialog(page).getByRole("textbox", { name: "일정 제목", exact: true }),
  ).toHaveValue("보관할 제목");
  await close(page);
  expect(
    (await request(page, `/calendar/entries/${entry.id}/document`)).markdown,
  ).toBe("보관할 본문");
  expect((await request(page, `/calendar/entries/${entry.id}`)).title).toBe(
    "보관할 제목",
  );
});

async function october(page: Page) {
  await enter(page);
  await calendar(page).getByLabel("캘린더 연도").selectOption("2026");
  await calendar(page)
    .getByLabel("표시 월", { exact: true })
    .selectOption("10");
  await expect(
    calendar(page).locator('[data-date="2026-11-06"]'),
  ).toBeAttached();
}
const segment = (page: Page, id: string) =>
  calendar(page).locator(`[data-entry-id="${id}"]`);
async function dragToDate(
  page: Page,
  source: Locator,
  date: string,
  owner = userId,
  beforeRelease?: () => Promise<void>,
) {
  await expect(source).toBeEnabled();
  await source.scrollIntoViewIfNeeded();
  const start = (await source.boundingBox())!;
  const target = (await calendar(page)
    .locator(`.calendar-day[data-date="${date}"][data-owner-id="${owner}"]`)
    .boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 8,
    start.y + start.height / 2,
    { steps: 2 },
  );
  await page.mouse.move(target.x + target.width / 2, target.y + 14, {
    steps: 10,
  });
  await beforeRelease?.();
  await page.mouse.up();
}
async function expectRange(
  page: Page,
  id: string,
  date: string,
  endDate: string,
) {
  await expect
    .poll(async () => {
      const entry = await request(page, `/calendar/entries/${id}`);
      return [entry.date, entry.endDate];
    })
    .toEqual([date, endDate]);
}

for (const view of ["month", "shared", "team"] as const)
  test(`화면 밖 일정이 이어져도 드래그 미리보기와 저장 후 행이 같다 (${view})`, async ({
    page,
  }) => {
    const owner = view === "shared" ? null : userId;
    const entries = [];
    for (const [date, endDate] of [
      ["2026-09-01", "2026-09-26"],
      ["2026-09-26", "2026-10-06"],
      ["2026-10-02", "2026-10-02"],
    ])
      entries.push(
        await request(page, "/calendar/entries", "POST", {
          id: randomUUID(),
          teamId,
          userId: owner,
          date,
          endDate,
          title: "화면 밖 배치 연결",
        }),
      );
    const target = entries[2];
    await request(page, `/calendar/entries/${target.id}`, "PATCH", {
      lane: 2,
      expectedLane: target.lane,
      expectedDate: target.date,
      expectedEndDate: target.endDate,
    });
    await october(page);
    if (view === "shared")
      await calendar(page)
        .getByRole("button", { name: "팀 월간 보기", exact: true })
        .click();
    if (view === "team") await teamWeek(page, "2026-09-27");
    await expect(segment(page, entries[0].id)).toHaveCount(0);
    await expect(segment(page, target.id)).toHaveAttribute(
      "data-entry-lane",
      "2",
    );
    await dragToDate(
      page,
      segment(page, target.id).getByRole("button", {
        name: "화면 밖 배치 연결",
        exact: true,
      }),
      "2026-10-03",
      owner ?? "team",
      async () => {
        await expect(
          calendar(page).locator(
            `.is-drag-preview[data-entry-id="${target.id}"]`,
          ),
        ).toHaveAttribute("data-entry-lane", "2");
      },
    );
    await expectRange(page, target.id, "2026-10-03", "2026-10-03");
    await expect(segment(page, target.id)).toHaveAttribute(
      "data-entry-lane",
      "2",
    );
    expect((await request(page, `/calendar/entries/${target.id}`)).lane).toBe(
      2,
    );
  });

for (const view of ["month", "shared"] as const)
  test(`일정 7개 중 다섯 번째를 다른 주로 끌면 미리보기가 마우스가 가리킨 날짜 안에 표시된다 (${view})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1366, height: 1400 });
    const owner = view === "shared" ? null : userId;
    const entries = [];
    for (let index = 0; index < 7; index++)
      entries.push(
        await request(page, "/calendar/entries", "POST", {
          id: randomUUID(),
          teamId,
          userId: owner,
          date: "2026-10-05",
          title: `겹친 일정 ${index + 1}`,
        }),
      );
    for (let index = 0; index < 3; index++)
      await request(page, "/calendar/entries", "POST", {
        id: randomUUID(),
        teamId,
        userId: owner,
        date: "2026-10-19",
        title: `도착할 날짜의 일정 ${index + 1}`,
      });
    await october(page);
    if (view === "shared")
      await calendar(page)
        .getByRole("button", { name: "팀 월간 보기", exact: true })
        .click();
    const entry = entries[4];
    const body = segment(page, entry.id).locator(".calendar-entry-card");
    await expect(body).toBeEnabled();
    await body.scrollIntoViewIfNeeded();
    const original = (await body.boundingBox())!;
    const cell = (date: string) =>
      calendar(page).locator(`.calendar-day[data-date="${date}"]`);
    const target = cell("2026-10-12");
    const before = (await target.boundingBox())!;
    const second = (await segment(page, entries[1].id).boundingBox())!;
    const occupied = cell("2026-10-19");
    const occupiedBefore = (await occupied.boundingBox())!;
    const preview = calendar(page).locator(".is-drag-preview");
    const expectInside = async (box: { y: number; height: number }) => {
      const floating = (await preview.boundingBox())!;
      expect(floating.y).toBeGreaterThanOrEqual(box.y);
      expect(floating.y + floating.height).toBeLessThanOrEqual(
        box.y + box.height,
      );
    };
    const updates: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/calendar/entries/${entry.id}`
      )
        updates.push(req.postData()!);
    });
    await page.mouse.move(
      original.x + original.width / 2,
      original.y + original.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      second.x + second.width / 2,
      second.y + second.height / 2,
      { steps: 8 },
    );
    await expect(preview).toHaveAttribute("data-entry-lane", "1");
    expect((await preview.boundingBox())!.y).toBe(second.y);
    await page.mouse.move(before.x + before.width / 2, before.y + 25, {
      steps: 10,
    });
    await expect(preview).toHaveAttribute("data-range-start", "2026-10-12");
    await page.screenshot({
      path: info.outputPath("fifth-card-next-week.png"),
    });
    await expectInside(before);
    await expect(preview).toHaveAttribute("data-entry-lane", "0");
    expect(await target.boundingBox()).toEqual(before);
    await page.mouse.move(
      occupiedBefore.x + occupiedBefore.width / 2,
      occupiedBefore.y + 25,
      { steps: 8 },
    );
    await expect(preview).toHaveAttribute("data-range-start", "2026-10-19");
    await expect(preview).toHaveAttribute("data-entry-lane", "3");
    await expectInside(occupiedBefore);
    expect(await occupied.boundingBox()).toEqual(occupiedBefore);
    await page.mouse.move(before.x + before.width / 2, before.y + 25, {
      steps: 8,
    });
    await expect(preview).toHaveAttribute("data-entry-lane", "0");
    await expectInside(before);
    expect(updates).toHaveLength(0);
    await page.mouse.up();
    await expectRange(page, entry.id, "2026-10-12", "2026-10-12");
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-entry-lane",
      "0",
    );
    await expect(preview).toHaveCount(0);
    expect(updates).toHaveLength(1);
    await page.reload();
    await october(page);
    if (view === "shared")
      await calendar(page)
        .getByRole("button", { name: "팀 월간 보기", exact: true })
        .click();
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-entry-lane",
      "0",
    );
  });

test("다섯 번째 카드의 기간을 빈 주까지 늘려도 미리보기는 각 주 안에 있고 날짜 칸은 고정된다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1366, height: 1400 });
  const entries = [];
  for (let index = 0; index < 7; index++)
    entries.push(
      await seedEntry(
        page,
        `기간 조정 일정 ${index + 1}`,
        userId,
        "2026-10-05",
      ),
    );
  await october(page);
  const entry = entries[4];
  const target = calendar(page).locator(
    '.calendar-day[data-date="2026-10-19"]',
  );
  const before = (await target.boundingBox())!;
  const handle = segment(page, entry.id).getByRole("button", {
    name: "종료일 조정",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const original = (await handle.boundingBox())!;
  await page.mouse.move(
    original.x + original.width / 2,
    original.y + original.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2, before.y + 25, {
    steps: 10,
  });
  const previews = calendar(page).locator(".is-drag-preview");
  await expect(previews).toHaveCount(3);
  for (const preview of await previews.all()) {
    await expect(preview).toHaveAttribute("data-entry-lane", "4");
    const floating = (await preview.boundingBox())!;
    const week = await preview.evaluate((element) => {
      const { top, bottom } = element
        .closest(".calendar-week-row")!
        .getBoundingClientRect();
      return { top, bottom };
    });
    expect(floating.y).toBeGreaterThanOrEqual(week.top);
    expect(floating.y + floating.height).toBeLessThanOrEqual(week.bottom);
  }
  expect(await target.boundingBox()).toEqual(before);
  await page.screenshot({
    path: info.outputPath("fifth-card-resize-weeks.png"),
  });
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-05", "2026-10-19");
  await expect(segment(page, entry.id)).toHaveCount(3);
  for (const card of await segment(page, entry.id).all())
    await expect(card).toHaveAttribute("data-entry-lane", "4");
});

for (const view of ["month", "team"] as const)
  test(`같은 날짜에서 카드 본문으로 순서를 바꾸고 이동·삭제 후 월~화 빈칸을 채운다 (${view})`, async ({
    page,
  }, info) => {
    const a = await seedEntry(page, "월요일 이동", userId, "2026-10-12");
    const b = await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-12",
      endDate: "2026-10-13",
      title: "월요일부터 화요일",
    });
    const c = await seedEntry(page, "같은 날짜 순서", userId, "2026-10-12");
    const d = await seedEntry(page, "기존 목요일", userId, "2026-10-15");
    const show = async () => {
      await october(page);
      if (view === "team") {
        await teamWeek(page, "2026-10-11");
      }
    };
    await show();
    const row = calendar(page).locator(
      `.calendar-week-row[data-week="2026-10-11"][data-owner-id="${userId}"]`,
    );
    const card = (id: string) => row.locator(`[data-entry-id="${id}"]`);
    const body = (id: string) => card(id).locator(".calendar-entry-card");
    const assertLanes = async (expected: [string, number][]) => {
      for (const [id, lane] of expected) {
        await expect
          .poll(
            async () => (await request(page, `/calendar/entries/${id}`)).lane,
          )
          .toBe(lane);
        await expect(card(id)).toHaveAttribute("data-entry-lane", String(lane));
      }
    };
    const vertical = async (id: string, targetId: string) => {
      await expect(body(id)).toBeEnabled();
      await body(id).scrollIntoViewIfNeeded();
      const sourceBox = (await body(id).boundingBox())!;
      const targetBox = (await body(targetId).boundingBox())!;
      await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect(body(id)).toBeEnabled();
      await expect(entryDialog(page)).toHaveCount(0);
    };
    const reads: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "GET" &&
        new URL(req.url()).pathname === "/api/calendar"
      )
        reads.push(req.url());
    });
    await vertical(c.id, a.id);
    await assertLanes([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
    await expectRange(page, c.id, "2026-10-12", "2026-10-12");
    await vertical(c.id, b.id);
    await assertLanes([
      [a.id, 0],
      [b.id, 1],
      [c.id, 2],
    ]);
    await dragToDate(page, body(a.id), "2026-10-15");
    await expectRange(page, a.id, "2026-10-15", "2026-10-15");
    await assertLanes([
      [b.id, 0],
      [c.id, 1],
      [a.id, 0],
      [d.id, 1],
    ]);
    await expectRange(page, b.id, "2026-10-12", "2026-10-13");
    await dragToDate(page, body(c.id), "2026-10-15");
    await expectRange(page, c.id, "2026-10-15", "2026-10-15");
    await assertLanes([
      [b.id, 0],
      [a.id, 0],
      [c.id, 1],
      [d.id, 2],
    ]);
    await vertical(c.id, d.id);
    await assertLanes([
      [a.id, 0],
      [d.id, 1],
      [c.id, 2],
    ]);
    await body(a.id).click();
    await entryDialog(page)
      .getByRole("button", { name: "일정 삭제", exact: true })
      .click();
    await expect(entryDialog(page)).toHaveCount(0);
    await assertLanes([
      [b.id, 0],
      [d.id, 0],
      [c.id, 1],
    ]);
    expect(reads).toEqual([]);
    await page.reload();
    await show();
    await assertLanes([
      [b.id, 0],
      [d.id, 0],
      [c.id, 1],
    ]);
    await page.screenshot({
      path: `/tmp/graeboard-compact-${view}-${info.project.name}.png`,
      fullPage: true,
    });
  });

for (const view of ["month", "team"] as const)
  test(`기간 조정 후 행 위치와 드래그·키보드로 바꾼 카드 순서를 유지한다 (${view})`, async ({
    page,
  }, info) => {
    const entries = [];
    for (const title of ["첫 번째 일정", "위치 유지할 일정", "순서 바꿀 일정"])
      entries.push(
        await request(page, "/calendar/entries", "POST", {
          id: randomUUID(),
          teamId,
          userId,
          date: "2026-10-12",
          endDate: "2026-10-16",
          title,
        }),
      );
    const [a, b, c] = entries;
    const show = async () => {
      await october(page);
      if (view === "team") {
        await teamWeek(page, "2026-10-11");
      }
    };
    await show();
    const row = calendar(page).locator(
      `.calendar-week-row[data-week="2026-10-11"][data-owner-id="${userId}"]`,
    );
    const card = (id: string) => row.locator(`[data-entry-id="${id}"]`);
    const top = (id: string) =>
      card(id).evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".calendar-week-row")!.getBoundingClientRect().top,
      );
    await expect(card(b.id)).toHaveAttribute("data-entry-lane", "1");
    const before = await top(b.id);
    for (const [edge, date, start, end] of [
      ["시작일 조정", "2026-10-15", "2026-10-15", "2026-10-16"],
      ["시작일 조정", "2026-10-11", "2026-10-11", "2026-10-16"],
      ["종료일 조정", "2026-10-17", "2026-10-11", "2026-10-17"],
      ["종료일 조정", "2026-10-16", "2026-10-11", "2026-10-16"],
    ]) {
      await dragToDate(
        page,
        card(b.id).getByRole("button", { name: edge, exact: true }),
        date,
      );
      await expectRange(page, b.id, start, end);
      await expect(card(b.id).locator(".calendar-entry-card")).toBeEnabled();
      expect(await top(b.id)).toBe(before);
      await expect(card(a.id)).toHaveAttribute("data-entry-lane", "0");
      await expect(card(c.id)).toHaveAttribute("data-entry-lane", "2");
    }
    const reads: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "GET" &&
        new URL(req.url()).pathname === "/api/calendar"
      )
        reads.push(req.url());
    });
    const body = card(c.id).locator(".calendar-entry-card");
    await body.scrollIntoViewIfNeeded();
    const box = (await body.boundingBox())!;
    const first = (await card(a.id).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, first.y + box.height / 2, {
      steps: 8,
    });
    await expect(row.locator(".is-drag-preview")).toHaveAttribute(
      "data-entry-lane",
      "0",
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await request(page, `/calendar/entries/${c.id}`)).lane)
      .toBe(0);
    await expect(body).toBeEnabled();
    await expect(card(a.id)).toHaveAttribute("data-entry-lane", "1");
    await expect(card(b.id)).toHaveAttribute("data-entry-lane", "2");
    await expect(entryDialog(page)).toHaveCount(0);
    await expectRange(page, c.id, c.date, c.endDate);
    await body.press("Alt+Shift+ArrowDown");
    await expect
      .poll(async () => (await request(page, `/calendar/entries/${c.id}`)).lane)
      .toBe(1);
    await expect(body).toBeEnabled();
    await expect(card(a.id)).toHaveAttribute("data-entry-lane", "0");
    expect(reads).toEqual([]);
    await page.reload();
    await show();
    for (const [entry, lane] of [
      [a, 0],
      [c, 1],
      [b, 2],
    ] as const)
      await expect(card(entry.id)).toHaveAttribute(
        "data-entry-lane",
        String(lane),
      );
    await page.screenshot({
      path: `/tmp/graeboard-order-${view}-${info.project.name}.png`,
      fullPage: true,
    });
  });

test("카드 순서의 취소·저장 실패·재시도는 날짜와 다른 팀원을 보존한다", async ({
  page,
}) => {
  const a = await seedEntry(page, "고정 순서", userId, "2026-10-12");
  const b = await seedEntry(page, "순서 재시도", userId, "2026-10-12");
  await seedEntry(page, "순서 충돌 비교", userId, "2026-10-12");
  const other = await seedEntry(page, "다른 팀원 순서", memberId, "2026-10-12");
  await october(page);
  const body = segment(page, b.id).locator(".calendar-entry-card");
  await body.scrollIntoViewIfNeeded();
  const start = (await body.boundingBox())!;
  const target = (await segment(page, a.id).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, target.y + 14, { steps: 5 });
  await expect(calendar(page).locator(".is-drag-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(calendar(page).locator(".is-drag-preview")).toHaveCount(0);
  expect((await request(page, `/calendar/entries/${b.id}`)).lane).toBe(1);
  await page.route(`**/api/calendar/entries/${b.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "순서 저장 실패" }),
        })
      : route.continue(),
  );
  await body.press("Alt+Shift+ArrowUp");
  await expect(
    calendar(page).getByText("순서 저장 실패", { exact: true }),
  ).toBeVisible();
  await expect(segment(page, b.id)).toHaveAttribute("data-entry-lane", "0");
  await expectRange(page, b.id, b.date, b.endDate);
  await page.unroute(`**/api/calendar/entries/${b.id}`);
  await calendar(page)
    .getByRole("button", { name: "순서 변경 다시 시도", exact: true })
    .click();
  await expect
    .poll(async () => (await request(page, `/calendar/entries/${b.id}`)).lane)
    .toBe(0);
  await expect(body).toBeEnabled();
  await expect(segment(page, a.id)).toHaveAttribute("data-entry-lane", "1");
  expect((await request(page, `/calendar/entries/${other.id}`)).lane).toBe(0);
  await expectRange(page, b.id, b.date, b.endDate);
  await request(page, `/calendar/entries/${b.id}`, "PATCH", {
    lane: 2,
    expectedLane: 0,
    expectedDate: b.date,
    expectedEndDate: b.endDate,
  });
  await body.press("Alt+Shift+ArrowDown");
  await expect(
    calendar(page).getByText("최신 서버 위치: 3번째 행", { exact: true }),
  ).toBeVisible();
  await calendar(page)
    .getByRole("button", { name: "내 순서로 최신 순서 교체", exact: true })
    .click();
  await expect
    .poll(async () => (await request(page, `/calendar/entries/${b.id}`)).lane)
    .toBe(1);
  await expect(body).toBeEnabled();
  await teamWeek(page, "2026-10-11");
  const own = segment(page, b.id).locator(".calendar-entry-card");
  await own.scrollIntoViewIfNeeded();
  const origin = (await own.boundingBox())!;
  const otherCard = (await segment(page, other.id).boundingBox())!;
  await page.mouse.move(
    origin.x + origin.width / 2,
    origin.y + origin.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    otherCard.x + otherCard.width / 2,
    otherCard.y + otherCard.height / 2,
    { steps: 5 },
  );
  await expect(
    calendar(page).getByLabel("달력 가로·세로 스크롤"),
  ).toHaveAttribute("data-dragging", "invalid");
  await page.mouse.up();
  await expect(own).toBeEnabled();
  expect((await request(page, `/calendar/entries/${b.id}`)).lane).toBe(1);
  expect((await request(page, `/calendar/entries/${other.id}`)).lane).toBe(0);
});

for (const [view, gesture] of [
  ["month", "move"],
  ["month", "end"],
  ["team", "move"],
  ["team", "end"],
] as const) {
  test(`일정 저장 중 다른 카드·메뉴·체크 태그의 표시를 유지하고 중복 입력을 막는다 (${view}, ${gesture})`, async ({
    page,
  }, info) => {
    const moving = await seedEntry(page, "이동하는 일정", userId, "2026-10-12");
    const stationary = await seedEntry(
      page,
      "그대로 둘 일정",
      userId,
      "2026-10-15",
    );
    await seedEntry(page, "다른 팀원의 일정", memberId, "2026-10-14");
    const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
      id: randomUUID(),
      name: "완료",
      color: "green",
      kind: "check",
    });
    for (const entry of [moving, stationary]) {
      await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
        tagIds: [tag.id],
        expectedTagIds: [],
      });
      await request(
        page,
        `/calendar/entries/${entry.id}/tags/${tag.id}`,
        "PATCH",
        {
          checked: true,
          expectedChecked: false,
        },
      );
    }
    await october(page);
    if (view === "team") {
      await teamWeek(page, "2026-10-11");
      await expect(
        calendar(page).locator(".calendar-member-loading"),
      ).toHaveCount(0);
    }
    const card = segment(page, moving.id).locator(".calendar-entry-card");
    const checkbox = segment(page, stationary.id).getByRole("checkbox", {
      name: "완료 체크",
      exact: true,
    });
    await card.scrollIntoViewIfNeeded();
    await page.mouse.move(2, 2);
    // The annual sheet's initial viewport save is debounced by 450ms.
    // Finish that unrelated write before observing this calendar gesture.
    await page.waitForTimeout(500);
    const normalCheck = await checkbox.screenshot();
    const nodes = await page.evaluateHandle(
      (id) =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '.topbar button, .topbar select, .calendar-workspace button, .calendar-workspace select, .calendar-workspace input[type="checkbox"], .calendar-day, .calendar-scroll',
          ),
        ].filter((element) => !element.closest(`[data-entry-id="${id}"]`)),
      moving.id,
    );
    const snapshot = () =>
      nodes.evaluate((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            name: element.getAttribute("aria-label") || element.textContent,
            connected: element.isConnected,
            opacity: style.opacity,
            color: style.color,
            background: style.backgroundColor,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          };
        }),
      );
    const before = await snapshot();
    const calls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/"))
        calls.push(`${request.method()} ${url.pathname}`);
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let backendMs = 0;
    await page.route(`**/api/calendar/entries/${moving.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const start = Date.now();
      const response = await route.fetch();
      backendMs = Date.now() - start;
      await gate;
      await route.fulfill({ response });
    });
    try {
      await dragToDate(
        page,
        gesture === "move"
          ? card
          : segment(page, moving.id).getByRole("button", {
              name: "종료일 조정",
              exact: true,
            }),
        "2026-10-13",
        userId,
        async () => {
          const draggingCheck = await checkbox.screenshot();
          await info.attach("check-before-drag", {
            body: normalCheck,
            contentType: "image/png",
          });
          await info.attach("check-during-drag", {
            body: draggingCheck,
            contentType: "image/png",
          });
          expect(draggingCheck.equals(normalCheck)).toBe(true);
          await expect(checkbox).toBeChecked();
        },
      );
      await expect(segment(page, moving.id)).toHaveAttribute(
        "aria-busy",
        "true",
      );
      // Wait past the existing 250ms disabled-style delay, as on a slower network.
      await page.waitForTimeout(350);
      expect((await checkbox.screenshot()).equals(normalCheck)).toBe(true);
      await expect(checkbox).toHaveJSProperty("disabled", false);
      const during = await snapshot();
      await page.screenshot({ path: info.outputPath("saving.png") });
      await info.attach("save-rendering.json", {
        body: JSON.stringify({ before, during, calls, backendMs }, null, 2),
        contentType: "application/json",
      });
      expect(calls).toEqual([`PATCH /api/calendar/entries/${moving.id}`]);
      expect(during).toEqual(before);
      await checkbox.click({ force: true });
      await checkbox.locator("..").locator("span").click({ force: true });
      await checkbox.focus();
      await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(entryDialog(page)).toHaveCount(0);
      expect(calls).toEqual([`PATCH /api/calendar/entries/${moving.id}`]);
      await expect(
        page.getByRole("button", { name: "캘린더 닫기", exact: true }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await expect(card).toBeEnabled();
    await page.mouse.move(2, 2);
    expect(await snapshot()).toEqual(before);
    expect(calls).toEqual([`PATCH /api/calendar/entries/${moving.id}`]);
    await expectRange(
      page,
      moving.id,
      gesture === "move" ? "2026-10-13" : "2026-10-12",
      "2026-10-13",
    );
    await nodes.dispose();
  });
}

test("일정 추가는 제목에 바로 입력하고 한글 조합 뒤 Enter로 한 번만 생성한다", async ({
  page,
}) => {
  await enter(page);
  await calendar(page)
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  const title = dialog.getByRole("textbox", { name: "새 일정 제목" });
  await expect(title).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.insertText("바로 입력한");
  await page.keyboard.press("Space");
  await page.keyboard.insertText("일정");
  await expect(title).toHaveValue("바로 입력한 일정");
  // insertText can emit its own composition events. Begin the unfinished
  // composition afterward to exercise the Enter guard consistently.
  await title.dispatchEvent("compositionstart");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await title.dispatchEvent("compositionend", { data: "일정" });
  let writes = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/calendar/entries", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    await gate;
    await route.continue();
  });
  try {
    await page.keyboard.press("Enter");
    await expect.poll(() => writes).toBe(1);
    await page.keyboard.press("Enter");
    await expect(
      dialog.getByRole("button", { name: "일정 만들기" }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(entryDialog(page)).toBeVisible();
  expect(writes).toBe(1);
  await close(page);
  await expect(
    calendar(page).getByRole("button", {
      name: "바로 입력한 일정",
      exact: true,
    }),
  ).toBeVisible();
});

test("일정 양 끝을 카드 높이에서 안쪽으로 줄인 뒤 놓아도 기간이 유지된다", async ({
  page,
}, info) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-12",
    endDate: "2026-10-16",
    title: "양 끝 줄이기",
  });
  await october(page);
  for (const [edge, date, expectedStart, expectedEnd] of [
    ["종료일 조정", "2026-10-14", "2026-10-12", "2026-10-14"],
    ["시작일 조정", "2026-10-13", "2026-10-13", "2026-10-14"],
    ["종료일 조정", "2026-10-13", "2026-10-13", "2026-10-13"],
  ]) {
    const handle = segment(page, entry.id).getByRole("button", { name: edge });
    await expect(handle).toBeEnabled();
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const target = (await calendar(page)
      .locator(`.calendar-day[data-date="${date}"]`)
      .boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      target.x + target.width / 2,
      start.y + start.height / 2,
      { steps: 12 },
    );
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-range-start",
      expectedStart,
    );
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-range-end",
      expectedEnd,
    );
    await page.mouse.up();
    await expectRange(page, entry.id, expectedStart, expectedEnd);
    await expect(entryDialog(page)).toHaveCount(0);
  }
  await page.screenshot({
    path: info.outputPath("calendar-range-shortened.png"),
    fullPage: true,
  });
});

test("주를 가로질러 양 끝을 줄여도 놓은 날짜를 저장한다", async ({ page }) => {
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [1, 2, 3, 4, 5],
  });
  await seedEntry(page, "디자인 리뷰", userId, "2026-10-12");
  await seedEntry(page, "회의", userId, "2026-10-13");
  await seedEntry(page, "다음 주 준비", userId, "2026-10-16");
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-14",
    endDate: "2026-10-22",
    title: "주를 넘겨 줄이기",
  });
  await october(page);
  const handle = segment(page, entry.id)
    .last()
    .getByRole("button", { name: "종료일 조정" });
  await expect(handle).toBeEnabled();
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const target = (await calendar(page)
    .locator('.calendar-day[data-date="2026-10-15"]')
    .boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 73, {
    steps: 18,
  });
  await expect(segment(page, entry.id)).toHaveAttribute(
    "data-range-end",
    "2026-10-15",
  );
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-14", "2026-10-15");
  // The previous shrink can leave the earlier week above the scroll viewport.
  await calendar(page)
    .locator('.calendar-day[data-date="2026-10-06"]')
    .scrollIntoViewIfNeeded();
  await dragToDate(
    page,
    segment(page, entry.id)
      .first()
      .getByRole("button", { name: "시작일 조정" }),
    "2026-10-06",
  );
  await expectRange(page, entry.id, "2026-10-06", "2026-10-15");
  await dragToDate(
    page,
    segment(page, entry.id)
      .first()
      .getByRole("button", { name: "시작일 조정" }),
    "2026-10-14",
  );
  await expectRange(page, entry.id, "2026-10-14", "2026-10-15");
});

for (const view of ["month", "team"])
  test(`겹친 일정의 기간을 줄인 뒤 놓아도 날짜를 유지한다 (${view})`, async ({
    page,
  }, info) => {
    for (let i = 0; i < 3; i++)
      await request(page, "/calendar/entries", "POST", {
        id: randomUUID(),
        teamId,
        userId,
        date: "2026-10-11",
        endDate: "2026-10-14",
        title: `겹친 일정 ${i}`,
      });
    const entry = await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-12",
      endDate: "2026-10-16",
      title: "겹친 일정 줄이기",
    });
    await october(page);
    if (view === "team") {
      await teamWeek(page, "2026-10-11");
    }
    const handle = segment(page, entry.id)
      .first()
      .getByRole("button", { name: "시작일 조정" });
    await expect(handle).toBeEnabled();
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const target = (await calendar(page)
      .locator(
        `.calendar-day[data-date="2026-10-15"][data-owner-id="${userId}"]`,
      )
      .boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      target.x + target.width / 2,
      start.y + start.height / 2,
    );
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-range-start",
      "2026-10-15",
    );
    await expectRange(page, entry.id, "2026-10-12", "2026-10-16");
    await page.screenshot({
      path: info.outputPath("calendar-shrink-preview.png"),
      fullPage: true,
    });
    await page.mouse.up();
    await expectRange(page, entry.id, "2026-10-15", "2026-10-16");
    const card = segment(page, entry.id).locator(".calendar-entry-card");
    await expect(card).toBeEnabled();
    await expect(segment(page, entry.id)).toHaveAttribute(
      "data-range-start",
      "2026-10-15",
    );
    await page.screenshot({
      path: info.outputPath("calendar-shrink-saved.png"),
      fullPage: true,
    });
    await card.press("Enter");
    await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
      "2026-10-15",
    );
    await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
      "2026-10-16",
    );
    await close(page);
  });

test("긴 일정을 겹친 이전 주로 옮겨도 날짜 칸이 움직이지 않는다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 1400 });
  for (let i = 0; i < 3; i++)
    await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-04",
      endDate: "2026-10-10",
      title: `이전 주 일정 ${i}`,
    });
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-12",
    endDate: "2026-10-22",
    title: "여러 주 이동",
  });
  await october(page);
  const card = segment(page, entry.id).locator(".calendar-entry-card").last();
  await expect(card).toBeEnabled();
  const source = (await calendar(page)
    .locator('.calendar-day[data-date="2026-10-20"]')
    .boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  const target = (await calendar(page)
    .locator('.calendar-day[data-date="2026-10-13"]')
    .boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, cardBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 14, {
    steps: 12,
  });
  await expect(segment(page, entry.id).first()).toHaveAttribute(
    "data-range-start",
    "2026-10-05",
  );
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-05", "2026-10-15");
});

test("여러 주 카드의 이어지는 끝부분도 이동과 구분해 기간을 조정한다", async ({
  page,
}) => {
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [1, 2, 3, 4, 5],
  });
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-14",
    endDate: "2026-10-22",
    title: "이어지는 카드 끝부분",
  });
  await october(page);
  const card = segment(page, entry.id).locator(".calendar-entry-card").first();
  await expect(card).toBeEnabled();
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const target = (await calendar(page)
    .locator('.calendar-day[data-date="2026-10-15"]')
    .boundingBox())!;
  await page.mouse.move(box.x + box.width - 5, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, box.y + 30, { steps: 12 });
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-14", "2026-10-15");
});

test("같은 일정을 연속으로 이동·확장·축소해도 각 드롭의 기간과 화면 위치가 일치한다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1366, height: 1500 });
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [1, 2, 3, 4, 5],
  });
  for (let i = 0; i < 3; i++)
    await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-04",
      endDate: "2026-10-10",
      title: `겹친 이전 주 ${i}`,
    });
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-14",
    endDate: "2026-10-22",
    title: "연속 조정 검토",
  });
  await october(page);
  let releaseSave: () => void = () => {};
  let saveStarted: () => void = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const firstSave = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  let holdSave = true;
  await page.route(`**/api/calendar/entries/${entry.id}`, async (route) => {
    if (route.request().method() === "PATCH" && holdSave) {
      holdSave = false;
      saveStarted();
      await saveGate;
    }
    await route.continue();
  });
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  const gridTop = (await scroller.boundingBox())!.y;
  const operations = [
    ["move", "2026-10-20", "2026-10-13", "2026-10-07", "2026-10-15"],
    ["end", "2026-10-08", "2026-10-08", "2026-10-07", "2026-10-08"],
    ["end", "2026-10-08", "2026-10-21", "2026-10-07", "2026-10-21"],
    ["start", "2026-10-20", "2026-10-20", "2026-10-20", "2026-10-21"],
    ["move", "2026-10-20", "2026-10-12", "2026-10-12", "2026-10-13"],
    ["start", "2026-10-12", "2026-10-05", "2026-10-05", "2026-10-13"],
    ["start", "2026-10-05", "2026-10-12", "2026-10-12", "2026-10-13"],
    ["end", "2026-10-13", "2026-10-23", "2026-10-12", "2026-10-23"],
    ["end", "2026-10-23", "2026-10-14", "2026-10-12", "2026-10-14"],
    ["move", "2026-10-14", "2026-11-02", "2026-10-31", "2026-11-02"],
  ];
  for (const [
    index,
    [mode, from, to, startDate, endDate],
  ] of operations.entries()) {
    const row = calendar(page).locator(
      `.calendar-week-row[data-week="${calendarWeek(from)}"]`,
    );
    const item = row.locator(`[data-entry-id="${entry.id}"]`);
    const source =
      mode === "move"
        ? item.locator(".calendar-entry-card")
        : item.getByRole("button", {
            name: mode === "start" ? "시작일 조정" : "종료일 조정",
          });
    await expect(source).toBeEnabled();
    const box = (await source.boundingBox())!;
    const fromCell = (await calendar(page)
      .locator(`.calendar-day[data-date="${from}"]`)
      .boundingBox())!;
    const destination = calendar(page).locator(
      `.calendar-day[data-date="${to}"]`,
    );
    const target = (await destination.boundingBox())!;
    await page.mouse.move(
      mode === "move" ? fromCell.x + fromCell.width / 2 : box.x + box.width / 2,
      box.y + box.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 73, {
      steps: index % 2 ? 1 : 15,
    });
    await expect(segment(page, entry.id).first()).toHaveAttribute(
      "data-range-start",
      startDate,
    );
    await expect(segment(page, entry.id).first()).toHaveAttribute(
      "data-range-end",
      endDate,
    );
    const during = (await destination.boundingBox())!;
    expect(during.y).toBeCloseTo(target.y, 1);
    expect(during.height).toBeCloseTo(target.height, 1);
    await expect(calendar(page).locator(".calendar-drag-status")).toHaveCount(
      0,
    );
    if (index === 2)
      await page.screenshot({
        path: info.outputPath("calendar-drag-preview-without-toast.png"),
        fullPage: true,
      });
    await page.mouse.up();
    if (index === 0) {
      await firstSave;
      await expect(
        segment(page, entry.id).first().getByText("저장 중…", { exact: true }),
      ).toBeVisible();
      await expect(
        calendar(page).locator(".calendar-range-pending"),
      ).toHaveCount(0);
      expect((await scroller.boundingBox())!.y).toBeCloseTo(gridTop, 1);
      await page.screenshot({
        path: info.outputPath("calendar-drag-saving.png"),
        fullPage: true,
      });
      releaseSave();
    }
    await expectRange(page, entry.id, startDate, endDate);
    await expect(
      segment(page, entry.id).first().locator(".calendar-entry-card"),
    ).toBeEnabled();
    await expect(entryDialog(page)).toHaveCount(0);
    await expect(calendar(page).locator(".calendar-range-pending")).toHaveCount(
      0,
    );
  }
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
    "2026-10-31",
  );
  await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
    "2026-11-02",
  );
  await close(page);
  await page.reload();
  await october(page);
  await expect(segment(page, entry.id).first()).toHaveAttribute(
    "data-range-start",
    "2026-10-31",
  );
});

test("보조 버튼이 눌려 있어도 기본 버튼을 놓는 순간 드래그가 끝난다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "버튼 해제 시점", userId, "2026-10-12");
  await october(page);
  const card = segment(page, entry.id).locator(".calendar-entry-card");
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const target = (await calendar(page)
    .locator('.calendar-day[data-date="2026-10-13"]')
    .boundingBox())!;
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, box.y + box.height / 2);
  await expect(scroller).toHaveAttribute("data-dragging", "valid");
  // Pointer Events reports a primary-button release as pointermove when
  // another button is still down. There is no pointerup until both are up.
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "left" });
  await expect(scroller).not.toHaveAttribute("data-dragging");
  await page.mouse.move(target.x + target.width * 1.5, box.y + box.height / 2);
  await page.mouse.up({ button: "right" });
  await expectRange(page, entry.id, "2026-10-13", "2026-10-13");
  await expect(card).toBeEnabled();
  await expect(entryDialog(page)).toHaveCount(0);
  await card.click();
  await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
    "2026-10-13",
  );
});

test("브레이브의 캡처 해제·버튼 해제 이동·늦은 손 뗌 순서에서도 이동·양끝 조정·본문 순서를 한 번씩 저장한다", async ({
  page,
}) => {
  const entry = await seedEntry(
    page,
    "트랙패드 종료 순서",
    userId,
    "2026-10-12",
  );
  await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-10-12",
    endDate: "2026-10-17",
    title: "트랙패드 순서 비교",
  });
  await october(page);
  await teamWeek(page, "2026-10-11");
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith(`/calendar/entries/${entry.id}`)
    )
      writes.push(request.postDataJSON());
  });
  for (const [mode, date, expectedStart, expectedEnd] of [
    ["move", "2026-10-13", "2026-10-13", "2026-10-13"],
    ["end", "2026-10-16", "2026-10-13", "2026-10-16"],
    ["start", "2026-10-14", "2026-10-14", "2026-10-16"],
    ["order-down", "2026-10-14", "2026-10-14", "2026-10-16"],
    ["order-up", "2026-10-14", "2026-10-14", "2026-10-16"],
  ]) {
    const card = segment(page, entry.id).locator(".calendar-entry-card");
    const ordering = mode === "order-down" || mode === "order-up";
    const source =
      mode === "move" || ordering
        ? card
        : segment(page, entry.id).getByRole("button", {
            name: mode === "start" ? "시작일 조정" : "종료일 조정",
          });
    await source.scrollIntoViewIfNeeded();
    const box = (await source.boundingBox())!;
    const target = (await calendar(page)
      .locator(`.calendar-day[data-date="${date}"][data-owner-id="${userId}"]`)
      .boundingBox())!;
    await scroller.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        (event) =>
          element.setAttribute("data-test-pointer", String(event.pointerId)),
        { once: true },
      );
    });
    const x = ordering ? box.x + box.width / 2 : target.x + target.width / 2;
    const y =
      box.y +
      box.height / 2 +
      (mode === "order-down" ? 61 : mode === "order-up" ? -61 : 0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await expect(scroller).toHaveAttribute("data-dragging", "valid");
    await scroller.evaluate(
      async (element, point) => {
        const pointerId = Number(element.getAttribute("data-test-pointer"));
        // The recorded Brave trackpad release loses capture and emits a
        // buttons=0 move 12–16ms before pointerup. The move may already be a hover.
        if (!element.hasPointerCapture(pointerId))
          throw new Error("Missing drag capture");
        element.releasePointerCapture(pointerId);
        const event = {
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
          bubbles: true,
          buttons: 0,
        };
        element.dispatchEvent(
          new PointerEvent("lostpointercapture", { ...event, button: -1 }),
        );
        element.dispatchEvent(
          new PointerEvent("pointermove", {
            ...event,
            button: -1,
            clientX: 5,
            clientY: 5,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 16));
        element.dispatchEvent(
          new PointerEvent("pointerup", {
            ...event,
            button: 0,
            clientX: point.x,
            clientY: point.y,
          }),
        );
      },
      { x, y },
    );
    await page.mouse.up();
    await expectRange(page, entry.id, expectedStart, expectedEnd);
    if (ordering)
      await expect
        .poll(
          async () =>
            (await request(page, `/calendar/entries/${entry.id}`)).lane,
        )
        .toBe(mode === "order-down" ? 1 : 0);
    await expect(scroller).not.toHaveAttribute("data-dragging");
    await expect(calendar(page).locator(".is-drag-preview")).toHaveCount(0);
    await expect(card).toBeEnabled();
    await expect(entryDialog(page)).toHaveCount(0);
    await card.click();
    await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
      expectedStart,
    );
    await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
      expectedEnd,
    );
    await close(page);
  }
  expect(writes).toHaveLength(5);
});

test("캡처가 풀린 드래그는 계속 움직이고 실제 취소·창 이탈·Escape에서는 저장하지 않는다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "캡처와 취소 구분", userId, "2026-10-12");
  await october(page);
  const card = segment(page, entry.id).locator(".calendar-entry-card");
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith(`/calendar/entries/${entry.id}`)
    )
      writes++;
  });
  for (const interruption of ["pointercancel", "blur", "Escape"]) {
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    const target = (await calendar(page)
      .locator('.calendar-day[data-date="2026-10-13"]')
      .boundingBox())!;
    await scroller.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        (event) =>
          element.setAttribute("data-test-pointer", String(event.pointerId)),
        { once: true },
      );
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, box.y + box.height / 2);
    await expect(scroller).toHaveAttribute("data-dragging", "valid");
    await scroller.evaluate((element) => {
      const pointerId = Number(element.getAttribute("data-test-pointer"));
      element.releasePointerCapture(pointerId);
      element.dispatchEvent(
        new PointerEvent("lostpointercapture", {
          pointerId,
          buttons: 1,
          bubbles: true,
        }),
      );
      // An unrelated pointer's cancellation must not end the current gesture.
      element.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: pointerId + 100,
          bubbles: true,
        }),
      );
    });
    await page.mouse.move(
      target.x + target.width * 1.5,
      box.y + box.height / 2,
    );
    await expect(scroller).toHaveAttribute("data-dragging", "valid");
    if (interruption === "Escape") await page.keyboard.press("Escape");
    else
      await scroller.evaluate((element, kind) => {
        if (kind === "blur") window.dispatchEvent(new Event("blur"));
        else
          element.dispatchEvent(
            new PointerEvent("pointercancel", {
              pointerId: Number(element.getAttribute("data-test-pointer")),
              bubbles: true,
            }),
          );
      }, interruption);
    await page.mouse.up();
    await expect(scroller).not.toHaveAttribute("data-dragging");
    await expect(calendar(page).locator(".is-drag-preview")).toHaveCount(0);
    await expectRange(page, entry.id, "2026-10-12", "2026-10-12");
    await card.click();
    await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
      "2026-10-12",
    );
    await close(page);
  }
  expect(writes).toBe(0);
  await dragToDate(page, card, "2026-10-13");
  await expectRange(page, entry.id, "2026-10-13", "2026-10-13");
  expect(writes).toBe(1);
});

test("팀 주간에서 드롭·취소 뒤 일반 클릭과 다음 양끝 드래그가 바로 동작한다", async ({
  page,
}) => {
  const entry = await seedEntry(
    page,
    "주간 드래그 후 클릭",
    userId,
    "2026-10-12",
  );
  await october(page);
  await teamWeek(page, "2026-10-11");
  const section = calendar(page).locator(`[data-member-id="${userId}"]`);
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  const card = () => segment(page, entry.id).locator(".calendar-entry-card");
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith(`/calendar/entries/${entry.id}`)
    )
      writes.push(request.postDataJSON());
  });
  for (const [mode, date, expectedStart, expectedEnd] of [
    ["move", "2026-10-13", "2026-10-13", "2026-10-13"],
    ["end", "2026-10-16", "2026-10-13", "2026-10-16"],
    ["start", "2026-10-14", "2026-10-14", "2026-10-16"],
  ]) {
    const source =
      mode === "move"
        ? card()
        : segment(page, entry.id).getByRole("button", {
            name: mode === "start" ? "시작일 조정" : "종료일 조정",
          });
    await dragToDate(page, source, date);
    await expect(scroller).not.toHaveAttribute("data-dragging");
    await expect(calendar(page).locator(".is-drag-preview")).toHaveCount(0);
    await expectRange(page, entry.id, expectedStart, expectedEnd);
    await expect(card()).toBeEnabled();
    await page.mouse.move(30, 30);
    await expect(entryDialog(page)).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "일정 추가", exact: true }),
    ).toHaveCount(0);
    await card().click();
    await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
      expectedStart,
    );
    await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
      expectedEnd,
    );
    await close(page);
  }
  expect(writes).toHaveLength(3);
  const box = (await card().boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 190, box.y + 25);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(scroller).not.toHaveAttribute("data-dragging");
  await expect(entryDialog(page)).toHaveCount(0);
  await card().click();
  await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
    "2026-10-14",
  );
  await close(page);
  expect(writes).toHaveLength(3);
  await section
    .getByRole("button", { name: "지윤 다음 주", exact: true })
    .click();
  await expect(section.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-18",
  );
});

test("터치 포인터를 캡처한 뒤에도 카드 이동과 끝부분 조정이 끝까지 저장된다", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "실제 터치 입력은 Chromium CDP로 전달한다.",
  );
  const entry = await seedEntry(page, "터치 일정", userId, "2026-10-12");
  await october(page);
  const input = await page.context().newCDPSession(page);
  for (const [mode, to, endDate] of [
    ["move", "2026-10-14", "2026-10-14"],
    ["end", "2026-10-22", "2026-10-22"],
    ["end", "2026-10-15", "2026-10-15"],
  ]) {
    const item = segment(page, entry.id).last();
    const source =
      mode === "move"
        ? item.locator(".calendar-entry-card")
        : item.getByRole("button", { name: "종료일 조정" });
    await expect(source).toBeEnabled();
    const box = (await source.boundingBox())!;
    const target = (await calendar(page)
      .locator(`.calendar-day[data-date="${to}"]`)
      .boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 8; i++)
      await input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: x + ((target.x + target.width / 2 - x) * i) / 8,
            y: y + ((target.y + 73 - y) * i) / 8,
          },
        ],
      });
    await input.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expectRange(page, entry.id, "2026-10-14", endDate);
    await expect(entryDialog(page)).toHaveCount(0);
  }
  await input.detach();
});

test("카드 이동과 양 끝 드래그가 주를 넘어 연결되고 상세 기간 편집도 같은 일정을 저장한다", async ({
  page,
}, info) => {
  const entry = await seedEntry(page, "여러 주 업무", userId, "2026-10-12");
  await october(page);
  await dragToDate(
    page,
    segment(page, entry.id).locator(".calendar-entry-card"),
    "2026-10-15",
  );
  await expectRange(page, entry.id, "2026-10-15", "2026-10-15");
  await expect(entryDialog(page)).toHaveCount(0);
  await dragToDate(
    page,
    segment(page, entry.id).last().getByRole("button", { name: "종료일 조정" }),
    "2026-10-22",
  );
  await expectRange(page, entry.id, "2026-10-15", "2026-10-22");
  await expect(segment(page, entry.id)).toHaveCount(2);
  await dragToDate(
    page,
    segment(page, entry.id)
      .first()
      .getByRole("button", { name: "시작일 조정" }),
    "2026-10-13",
  );
  await expectRange(page, entry.id, "2026-10-13", "2026-10-22");
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveValue(
    "2026-10-13",
  );
  await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
    "2026-10-22",
  );
  await entryDialog(page).getByLabel("일정 시작일").fill("2026-10-10");
  await entryDialog(page).getByLabel("일정 종료일").fill("2026-10-26");
  await entryDialog(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expect(
    entryDialog(page).getByText("기간 저장됨", { exact: true }),
  ).toBeVisible();
  await close(page);
  await expectRange(page, entry.id, "2026-10-10", "2026-10-26");
  await expect(segment(page, entry.id)).toHaveCount(4);
  await page.screenshot({
    path: info.outputPath("calendar-range-month.png"),
    fullPage: true,
  });
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  await expect(segment(page, entry.id)).toHaveCount(1);
  expect(
    (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks,
  ).toHaveLength(1);
});

test("인접 월 경계 주와 숨긴 요일 사이를 가로지르는 기간을 보존한다", async ({
  page,
}, info) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: "2026-09-25",
    endDate: "2026-11-04",
    title: "월 경계 일정",
  });
  await october(page);
  await expect(
    calendar(page).locator('[data-date="2026-09-27"]'),
  ).toBeAttached();
  await expect(
    calendar(page).locator('[data-date="2026-11-07"]'),
  ).toBeAttached();
  await expect(segment(page, entry.id)).toHaveCount(6);
  await calendar(page)
    .getByRole("button", { name: "내 표시 요일 설정" })
    .click();
  const settings = page.getByRole("dialog", { name: "내 캘린더 표시 요일" });
  await settings.getByRole("button", { name: "월~금", exact: true }).click();
  await settings.getByRole("button", { name: "요일 설정 저장" }).click();
  await expect(segment(page, entry.id)).toHaveCount(6);
  await expectRange(page, entry.id, "2026-09-25", "2026-11-04");
  await calendar(page)
    .getByRole("button", { name: "팀 주간 일정 보기" })
    .click();
  await expect(segment(page, entry.id)).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("calendar-range-team.png"),
    fullPage: true,
  });
  await calendar(page).getByRole("button", { name: "개인 월간 보기" }).click();
  await calendar(page).getByLabel("표시 월", { exact: true }).selectOption("2");
  await expect(
    calendar(page).locator('[data-date="2026-01-26"]'),
  ).toBeAttached();
  await expect(
    calendar(page).locator('[data-date="2026-03-06"]'),
  ).toBeAttached();
  await expect(calendar(page).locator(".calendar-week-row")).toHaveCount(6);
});

test("드래그 취소·키보드 이동·읽기 전용과 실패한 기간 변경의 재시도를 처리한다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "기간 변경 안전성", userId, "2026-10-12");
  const other = await seedEntry(page, "서연의 기간", memberId, "2026-10-12");
  await october(page);
  const card = segment(page, entry.id).locator(".calendar-entry-card");
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 20, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-12", "2026-10-12");
  await card.press("Alt+ArrowRight");
  await expectRange(page, entry.id, "2026-10-13", "2026-10-13");
  await expect(
    segment(page, entry.id).last().getByRole("button", { name: "종료일 조정" }),
  ).toBeEnabled();
  await segment(page, entry.id)
    .last()
    .getByRole("button", { name: "종료일 조정" })
    .press("ArrowDown");
  await expectRange(page, entry.id, "2026-10-13", "2026-10-20");
  await expect(
    segment(page, entry.id)
      .first()
      .getByRole("button", { name: "시작일 조정" }),
  ).toBeEnabled();
  let fail = true;
  await page.route(`**/api/calendar/entries/${entry.id}`, async (route) => {
    if (route.request().method() === "PATCH" && fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "기간 저장 실패 테스트" }),
      });
    else await route.continue();
  });
  await segment(page, entry.id)
    .first()
    .getByRole("button", { name: "시작일 조정" })
    .press("ArrowLeft");
  await expect(
    calendar(page).getByText("기간 저장 실패 테스트", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "캘린더 닫기", exact: true }),
  ).toBeDisabled();
  await expect(calendar(page).getByLabel("캘린더 팀원")).toBeDisabled();
  await expectRange(page, entry.id, "2026-10-13", "2026-10-20");
  fail = false;
  await calendar(page)
    .getByRole("button", { name: "기간 변경 다시 시도" })
    .click();
  await expectRange(page, entry.id, "2026-10-12", "2026-10-20");
  await request(page, "/auth/logout", "POST", {});
  await request(page, "/auth/login", "POST", {
    username: memberLogin,
    password,
  });
  await page.reload();
  await enter(page);
  await calendar(page).getByLabel("캘린더 팀원").selectOption(userId);
  await expect(segment(page, entry.id)).toHaveCount(2);
  await expect(
    segment(page, entry.id).locator(".calendar-range-handle"),
  ).toHaveCount(0);
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await expect(entryDialog(page).getByLabel("일정 시작일")).toHaveAttribute(
    "readonly",
    "",
  );
  await close(page);
  expect((await request(page, `/calendar/entries/${other.id}`)).date).toBe(
    "2026-10-12",
  );
  // A period draft made before losing edit permission remains recoverable.
  await page.evaluate(
    ({ key }) =>
      sessionStorage.setItem(
        key,
        JSON.stringify({
          base: { date: "2026-10-12", endDate: "2026-10-20" },
          range: { date: "2026-10-12", endDate: "2026-10-21" },
        }),
      ),
    { key: `weekly-plan:calendar-range:${memberId}:${teamId}:${entry.id}` },
  );
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await expect(
    entryDialog(page).getByText(/현재는 읽기 전용입니다. 보관된 기간/),
  ).toBeVisible();
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toBeVisible();
  await entryDialog(page)
    .getByRole("button", { name: "초안 보관하고 닫기" })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
  await expectRange(page, entry.id, "2026-10-12", "2026-10-20");
});

test("상세 기간의 실패·충돌·초안 보존과 본문 저장 응답의 순서가 기간을 되돌리지 않는다", async ({
  page,
}) => {
  const entry = await seedEntry(page, "기간 충돌", userId, "2026-10-12");
  for (const title of ["위치 비교 첫째", "위치 비교 둘째"])
    await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: "2026-10-12",
      endDate: "2026-10-26",
      title,
    });
  const obstacle = await seedEntry(
    page,
    "충돌 후 밀려날 카드",
    userId,
    "2026-10-24",
  );
  await request(page, `/calendar/entries/${obstacle.id}`, "PATCH", {
    lane: 3,
    expectedLane: 0,
    expectedDate: obstacle.date,
    expectedEndDate: obstacle.endDate,
  });
  await october(page);
  await segment(page, entry.id).locator(".calendar-entry-card").click();
  await entryDialog(page).getByLabel("일정 종료일").fill("2026-10-19");
  await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
    date: entry.date,
    endDate: "2026-10-20",
    expectedDate: entry.date,
    expectedEndDate: entry.endDate,
  });
  await entryDialog(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expect(
    entryDialog(page).getByText("최신 서버 기간: 2026-10-12 ~ 2026-10-20"),
  ).toBeVisible();
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toBeVisible();
  await entryDialog(page)
    .getByRole("button", { name: "초안 보관하고 닫기" })
    .click();
  await expect(entryDialog(page)).toHaveCount(0);
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
    "2026-10-19",
  );
  await entryDialog(page)
    .getByRole("button", { name: "내 기간으로 최신 기간 교체" })
    .click();
  await expectRange(page, entry.id, "2026-10-12", "2026-10-19");
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(
    `**/api/calendar/entries/${entry.id}/document`,
    async (route) => {
      if (route.request().method() === "PUT") {
        const response = await route.fetch();
        reached();
        await wait;
        await route.fulfill({ response });
      } else await route.continue();
    },
  );
  await raw(page);
  await source(page).fill("기간과 별도로 저장하는 본문");
  await started;
  await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
    lane: 2,
    expectedLane: 0,
    expectedDate: "2026-10-12",
    expectedEndDate: "2026-10-19",
  });
  await entryDialog(page).getByLabel("일정 종료일").fill("2026-10-23");
  await entryDialog(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expectRange(page, entry.id, "2026-10-12", "2026-10-23");
  release();
  await close(page);
  await expect(segment(page, entry.id).first()).toHaveAttribute(
    "data-range-end",
    "2026-10-23",
  );
  for (const card of await segment(page, entry.id).all())
    await expect(card).toHaveAttribute("data-entry-lane", "2");
  await segment(page, entry.id).locator(".calendar-entry-card").first().click();
  await entryDialog(page).getByLabel("일정 시작일").fill("2026-10-25");
  await entryDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(entryDialog(page)).toBeVisible();
  await expect(
    entryDialog(page).getByText(/유효한 시작일과 종료일/),
  ).toBeVisible();
  await entryDialog(page).getByLabel("일정 시작일").fill("2026-10-12");
  await entryDialog(page).getByLabel("일정 종료일").fill("2026-10-26");
  await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
    date: "2026-10-12",
    endDate: "2026-10-24",
    expectedDate: "2026-10-12",
    expectedEndDate: "2026-10-23",
  });
  await entryDialog(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expect(
    entryDialog(page).getByText("최신 서버 기간: 2026-10-12 ~ 2026-10-24"),
  ).toBeVisible();
  let readRelease: () => void = () => {};
  let readReached: () => void = () => {};
  const readGate = new Promise<void>((resolve) => {
    readRelease = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    readReached = resolve;
  });
  await page.route(
    new RegExp(`/api/calendar/entries/${entry.id}(?:\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        const response = await route.fetch();
        readReached();
        await readGate;
        await route.fulfill({ response });
      } else await route.continue();
    },
  );
  await entryDialog(page)
    .getByRole("button", { name: "서버 기간 사용" })
    .click();
  await readStarted;
  await expect(entryDialog(page).getByLabel("일정 종료일")).toBeDisabled();
  await expect(
    entryDialog(page).getByRole("button", {
      name: "내 기간으로 최신 기간 교체",
    }),
  ).toBeDisabled();
  readRelease();
  await expect(entryDialog(page).getByLabel("일정 종료일")).toHaveValue(
    "2026-10-24",
  );
  await close(page);
  await expect(segment(page, obstacle.id)).toHaveAttribute(
    "data-entry-lane",
    "3",
  );
});

test("아래쪽 자동 스크롤로 다음 달까지 기간을 늘리고 팀원의 다른 행에는 옮기지 않는다", async ({
  page,
}, info) => {
  const entry = await seedEntry(page, "긴 기간 드래그", userId, "2026-10-12");
  await october(page);
  const handle = segment(page, entry.id)
    .last()
    .getByRole("button", { name: "종료일 조정" });
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const scroller = calendar(page).getByLabel("달력 가로·세로 스크롤");
  const bounds = (await scroller.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 150,
    bounds.y + bounds.height - 12,
    { steps: 8 },
  );
  const target = calendar(page).locator(
    '.calendar-day[data-date="2026-11-04"]',
  );
  await expect
    .poll(async () => (await target.boundingBox())!.y + 30)
    .toBeLessThan(bounds.y + bounds.height);
  const end = (await target.boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, end.y + 14, { steps: 4 });
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-12", "2026-11-04");
  await expect(segment(page, entry.id)).toHaveCount(4);
  await page.screenshot({
    path: info.outputPath("calendar-range-autoscroll.png"),
    fullPage: true,
  });
  await teamWeek(page, "2026-10-11");
  await expect(segment(page, entry.id)).toHaveCount(1);
  await dragToDate(
    page,
    segment(page, entry.id).locator(".calendar-entry-card"),
    "2026-10-14",
    memberId,
  );
  await expect(calendar(page).locator(".calendar-range-pending")).toHaveCount(
    0,
  );
  await expectRange(page, entry.id, "2026-10-12", "2026-11-04");
  const card = segment(page, entry.id).locator(".calendar-entry-card");
  const sourceDay = calendar(page).locator(
    `.calendar-day[data-date="2026-10-14"][data-owner-id="${userId}"]`,
  );
  const targetDay = calendar(page).locator(
    `.calendar-day[data-date="2026-10-16"][data-owner-id="${userId}"]`,
  );
  const sourceBox = (await sourceDay.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  const targetBox = (await targetDay.boundingBox())!;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, cardBox.y + 25);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 14, {
    steps: 8,
  });
  await page.mouse.up();
  await expectRange(page, entry.id, "2026-10-14", "2026-11-06");
  await page.setViewportSize({ width: 390, height: 844 });
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const label = (await card.locator(".calendar-entry-content").boundingBox())!;
  const weeklyColumn = (await calendar(page)
    .locator(".calendar-week-tasks")
    .first()
    .boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(weeklyColumn.x + weeklyColumn.width);
  expect(label.x + label.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("calendar-range-mobile.png"),
    fullPage: true,
  });
});
