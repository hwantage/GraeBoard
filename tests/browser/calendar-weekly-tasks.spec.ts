import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { calendarWeek } from "../../shared/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
const password = "local-test-only-password";
const week = calendarWeek(todayKey());
let teamId: string,
  userId: string,
  userName: string,
  memberId: string,
  memberLogin: string;
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
async function task(
  page: Page,
  title: string,
  owner: string,
  status: string,
  markdown = "",
) {
  const created = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: { title, owner, status },
    })
  ).task;
  if (markdown)
    await request(page, `/tasks/${created.id}/document`, "PUT", {
      markdown,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  return created.id as string;
}
const addToWeek = (page: Page, taskIds: string[], owner = userId) =>
  request(page, "/calendar/weekly", "POST", {
    teamId,
    userId: owner,
    weekStart: week,
    taskIds,
  });
async function open(page: Page) {
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".calendar-grid")).toBeVisible();
}
const weekTasks = (page: Page) =>
  page.locator(`.calendar-week-row[data-week="${week}"] .calendar-week-tasks`);
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "주간 업무 추가", exact: true });
const option = (dialog: Locator, title: string) =>
  dialog.locator(".calendar-task-option").filter({
    has: dialog.page().getByRole("checkbox", { name: title, exact: true }),
  });
// Holds matching requests until release() so a loading state can be checked.
async function hold(page: Page, pattern: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const continued: Promise<void>[] = [];
  await page.route(pattern, (route) => {
    const sent = held.then(() => route.continue());
    continued.push(sent);
    return sent;
  });
  return async () => {
    release();
    await Promise.all(continued);
    await page.unroute(pattern);
  };
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
  userName = boot.user.name;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `주간 할 일 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  memberLogin = `weekly-${randomUUID()}@example.com`;
  memberId = (
    await request(page, "/admin/users", "POST", {
      username: memberLogin,
      password,
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

test("캘린더·팀원·업무 목록과 이번주 할일 확인을 불러오는 동안 캐릭터 로딩을 표시한다", async ({
  page,
}, info) => {
  await task(page, "가져올 진행 업무", userId, "status-progress");
  const team = await request(page, `/calendar/teams/${teamId}`);
  await request(page, `/calendar/teams/${teamId}/rule`, "PUT", {
    propertyId: "status",
    values: ["status-progress"],
    mode: "include",
    expectedRevision: team.rule.revision,
  });
  const releaseCalendar = await hold(page, "**/api/calendar?*");
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  const calendarLoading = page.getByRole("status", {
    name: "일정을 불러오는 중",
    exact: true,
  });
  await expect(calendarLoading).toBeVisible();
  await expect(calendarLoading.locator(".grae-loading")).toHaveCount(1);
  await expect(calendarLoading).toContainText("일정을 불러오는 중");
  await releaseCalendar();
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await expect(calendarLoading).toHaveCount(0);

  const releaseImport = await hold(page, "**/api/calendar/import");
  await weekTasks(page)
    .getByRole("button", { name: "이번주 할일 확인", exact: true })
    .click();
  const importing = weekTasks(page).getByRole("status", {
    name: "업무를 불러오는 중",
    exact: true,
  });
  await expect(importing).toBeVisible();
  await expect(weekTasks(page)).toHaveAttribute("aria-busy", "true");
  // The compact character fits the narrow weekly column.
  const character = (await importing.locator(".grae-loading").boundingBox())!;
  const column = (await weekTasks(page).boundingBox())!;
  expect(character.width).toBeLessThanOrEqual(48);
  expect(character.x).toBeGreaterThanOrEqual(column.x);
  expect(character.x + character.width).toBeLessThanOrEqual(
    column.x + column.width,
  );
  await page.screenshot({ path: info.outputPath("weekly-import-loading.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await importing
      .locator(".grae-loading-tile")
      .first()
      .evaluate((tile) => getComputedStyle(tile).animationName),
  ).toBe("none");
  await page.emulateMedia({ reducedMotion: null });
  await releaseImport();
  await expect(importing).toHaveCount(0);
  await expect(weekTasks(page)).not.toHaveAttribute("aria-busy", "true");
  await expect(
    weekTasks(page).getByRole("button", {
      name: "가져올 진행 업무",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".toast")).toContainText("1개 가져옴");

  const releaseTasks = await hold(page, "**/api/calendar/tasks?*");
  await weekTasks(page)
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const pickerLoading = picker(page).getByRole("status", {
    name: "업무를 불러오는 중",
    exact: true,
  });
  await expect(pickerLoading).toBeVisible();
  await expect(pickerLoading.locator(".grae-loading")).toHaveCount(1);
  await releaseTasks();
  await expect(pickerLoading).toHaveCount(0);
  await expect(
    picker(page).getByRole("checkbox", {
      name: "가져올 진행 업무",
      exact: true,
    }),
  ).toBeChecked();
  await picker(page).getByRole("button", { name: "취소", exact: true }).click();

  const releaseMembers = await hold(page, "**/api/calendar/members?*");
  await page.getByRole("button", { name: "팀 주간 일정 보기" }).click();
  for (const name of [userName, "서연"])
    await expect(
      page.getByRole("status", {
        name: `${name}의 일정을 불러오는 중`,
        exact: true,
      }),
    ).toBeVisible();
  await releaseMembers();
  await expect(page.locator(".calendar-member-loading")).toHaveCount(0);
});

test("주간 업무 추가 창은 넓게 열려 팀원·상태·문서를 보여 주고 속성 필터로 좁혀 선택한다", async ({
  page,
}, info) => {
  const progress = await task(
    page,
    "주간 후보 진행",
    userId,
    "status-progress",
    "작성한 문서",
  );
  await task(page, "주간 후보 완료", memberId, "status-completed");
  await task(page, "주간 후보 예정", "", "status-planned");
  const searches: URL[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/calendar/tasks") searches.push(url);
  });
  await open(page);
  await weekTasks(page)
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const dialog = picker(page);
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 진행", exact: true }),
  ).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(800);
  await expect(option(dialog, "주간 후보 진행")).toContainText(userName);
  await expect(option(dialog, "주간 후보 진행")).toContainText("진행 중");
  await expect(
    option(dialog, "주간 후보 진행").getByRole("img", {
      name: "문서 1개",
      exact: true,
    }),
  ).toBeVisible();
  await expect(option(dialog, "주간 후보 완료")).toContainText("서연");
  await expect(option(dialog, "주간 후보 완료")).toContainText("완료");
  await expect(
    option(dialog, "주간 후보 완료").getByRole("img", { name: /문서/ }),
  ).toHaveCount(0);
  await dialog
    .getByRole("checkbox", { name: "주간 후보 진행", exact: true })
    .check();

  const toggle = dialog.getByRole("button", { name: "속성 필터", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const filters = dialog.getByRole("group", { name: "속성 필터", exact: true });
  await expect(filters.getByLabel("필터 속성")).toHaveValue("status");
  await filters.getByRole("checkbox", { name: "완료", exact: true }).check();
  await expect(
    dialog.getByRole("button", { name: "속성 필터 (1)", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 완료", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 진행", exact: true }),
  ).toHaveCount(0);
  expect(JSON.parse(searches.at(-1)!.searchParams.get("filters")!)).toEqual([
    { propertyId: "status", values: ["status-completed"], mode: "include" },
  ]);
  await page.screenshot({ path: info.outputPath("weekly-picker-filter.png") });
  await filters
    .getByRole("button", { name: "상태 필터 해제", exact: true })
    .click();
  await filters.getByLabel("필터 속성").selectOption("owner");
  await filters.getByRole("checkbox", { name: "서연", exact: true }).check();
  await filters.getByRole("radio", { name: "제외", exact: true }).check();
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 완료", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 예정", exact: true }),
  ).toBeVisible();
  // The selection made before filtering is kept.
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 진행", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("searchbox", { name: "업무 제목 검색" }).fill("예정");
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 진행", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 예정", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "선택한 업무 추가 (1)", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    weekTasks(page).getByRole("button", {
      name: "주간 후보 진행",
      exact: true,
    }),
  ).toBeVisible();
  const saved = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${userId}&from=${week}&to=${week}`,
  );
  expect(saved.weekly.map((item: any) => item.taskId)).toEqual([progress]);

  await page.setViewportSize({ width: 390, height: 844 });
  await weekTasks(page)
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  await dialog.getByRole("button", { name: "속성 필터", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "주간 후보 완료", exact: true }),
  ).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const panel = (await dialog
    .getByRole("group", { name: "속성 필터", exact: true })
    .boundingBox())!;
  const list = (await dialog
    .getByLabel("추가할 업무", { exact: true })
    .boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(list.y);
  expect(list.x + list.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("weekly-picker-mobile.png"),
  });
});

test("주간 업무는 확인 없이 삭제하고 실행취소로 같은 자리에 되살리며 원본 업무는 그대로 둔다", async ({
  page,
  browser,
}, info) => {
  const titles = ["삭제 첫째", "삭제 둘째", "삭제 셋째"];
  const ids: string[] = [];
  for (const title of titles) {
    ids.push(await task(page, title, userId, "status-progress"));
    await addToWeek(page, [ids.at(-1)!]);
  }
  await open(page);
  const items = weekTasks(page).locator(".calendar-week-task-open");
  await expect(items).toHaveText(titles);
  const second = weekTasks(page)
    .locator(".calendar-week-task")
    .filter({ hasText: "삭제 둘째" });
  const remove = second.getByRole("button", {
    name: "삭제 둘째 주간 업무에서 삭제",
    exact: true,
  });
  await expect(remove).toHaveCSS("opacity", "0");
  await second.hover();
  await expect(remove).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("weekly-remove-hover.png") });
  const reads: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/calendar" && r.method() === "GET")
      reads.push(r.url());
  });
  let dialogs = 0;
  page.on("dialog", () => dialogs++);
  await remove.click();
  await expect(items).toHaveText([titles[0], titles[2]]);
  const toast = page.locator(".toast");
  await expect(toast).toContainText(
    "‘삭제 둘째’ 업무를 주간 할 일에서 삭제했습니다.",
  );
  expect(
    (
      await request(
        page,
        `/calendar?teamId=${teamId}&userId=${userId}&from=${week}&to=${week}`,
      )
    ).weekly.map((item: any) => item.taskId),
  ).toEqual([ids[0], ids[2]]);
  expect((await request(page, `/calendar/tasks/${ids[1]}`)).task.id).toBe(
    ids[1],
  );
  await toast.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(items).toHaveText(titles);
  await expect(toast).toContainText(
    "‘삭제 둘째’ 업무를 주간 할 일에 되살렸습니다.",
  );
  expect(dialogs).toBe(0);
  expect(reads).toHaveLength(0);

  // Keyboard focus shows the delete button too.
  await weekTasks(page)
    .getByRole("button", { name: "삭제 셋째 주간 업무에서 삭제", exact: true })
    .focus();
  await expect(
    weekTasks(page).getByRole("button", {
      name: "삭제 셋째 주간 업무에서 삭제",
      exact: true,
    }),
  ).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(items).toHaveText([titles[0], titles[1]]);
  await expect(toast).toContainText("‘삭제 셋째’");

  // A teammate who cannot edit this calendar sees no delete buttons.
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const other = await context.newPage();
  await request(other, "/auth/login", "POST", {
    username: memberLogin,
    password,
  });
  await other.goto("/");
  await other.getByRole("button", { name: "캘린더", exact: true }).click();
  await other.getByRole("button", { name: "팀 주간 일정 보기" }).click();
  const lead = other
    .locator(`.calendar-team-section[data-member-id="${userId}"]`)
    .locator(".calendar-week-tasks");
  await expect(
    lead.getByRole("button", { name: "삭제 첫째", exact: true }),
  ).toBeVisible();
  await expect(
    lead.getByRole("button", { name: /주간 업무에서 삭제/ }),
  ).toHaveCount(0);
  const response = await other.request.fetch("/api/calendar/weekly", {
    method: "DELETE",
    headers,
    data: { teamId, userId, weekStart: week, taskId: ids[0] },
  });
  expect(response.status()).toBe(403);
  await context.close();
});

test("문서가 있는 주간 업무는 오른쪽 아래에 문서 수와 아이콘을 표시하고 상세에서 저장하면 바로 반영한다", async ({
  page,
}, info) => {
  const documented = await task(
    page,
    "문서 있는 주간 업무",
    userId,
    "status-progress",
    "작성한 문서",
  );
  const plain = await task(page, "문서 없는 주간 업무", userId, "");
  await addToWeek(page, [documented, plain]);
  await open(page);
  const item = (title: string) =>
    weekTasks(page).locator(".calendar-week-task").filter({ hasText: title });
  const indicator = item("문서 있는 주간 업무").locator(
    ".calendar-week-document",
  );
  await expect(indicator).toHaveText("1");
  await expect(indicator.locator("svg")).toHaveCount(1);
  await expect(
    weekTasks(page).getByRole("button", {
      name: "문서 있는 주간 업무",
      exact: true,
    }),
  ).toHaveAttribute("aria-description", "문서 1개");
  await expect(
    item("문서 없는 주간 업무").locator(".calendar-week-document"),
  ).toHaveCount(0);
  const card = (await item("문서 있는 주간 업무")
    .locator(".calendar-week-task-open")
    .boundingBox())!;
  const mark = (await indicator.boundingBox())!;
  expect(card.x + card.width - (mark.x + mark.width)).toBeLessThanOrEqual(8);
  expect(card.y + card.height - (mark.y + mark.height)).toBeLessThanOrEqual(8);
  await page.screenshot({
    path: info.outputPath("weekly-document-count.png"),
  });

  const reads: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/calendar" && r.method() === "GET")
      reads.push(r.url());
  });
  await weekTasks(page)
    .getByRole("button", { name: "문서 없는 주간 업무", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await detail.getByRole("button", { name: "문서 작성", exact: true }).click();
  await detail
    .getByRole("textbox", { name: "업무 문서 리치 편집" })
    .fill("캘린더에서 작성한 문서");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(
    item("문서 없는 주간 업무").locator(".calendar-week-document"),
  ).toHaveText("1");
  expect(reads).toHaveLength(0);
});
