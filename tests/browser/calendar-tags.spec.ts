import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { addDays, calendarWeek } from "../../shared/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string;
let errors: string[];
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
const manager = (page: Page) =>
  page.getByRole("dialog", { name: /^(개인|팀) 태그 관리$/ });
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"] .calendar-entry-card`).first();
const addTag = (page: Page, name: string, color: string) =>
  request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name,
    color,
  });
const addEntry = (page: Page, title: string, tagIds: string[], days = 0) =>
  request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title,
    date: todayKey(),
    endDate: addDays(todayKey(), days),
    tagIds,
  });
async function openCreated(page: Page, title: string) {
  await expect(
    page.getByRole("dialog", { name: "일정 추가", exact: true }),
  ).toHaveCount(0);
  await expect(detail(page)).toHaveCount(0);
  await page
    .locator(".calendar-entry-card")
    .filter({ hasText: title })
    .first()
    .click();
  await expect(detail(page)).toBeVisible();
}
async function closeDetail(page: Page) {
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
}
async function openManager(page: Page) {
  const scope = await page
    .locator(".calendar-workspace")
    .getAttribute("data-calendar-view");
  const name = scope === "shared" ? "팀 태그 관리" : "개인 태그 관리";
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
  await expect(
    manager(page).getByRole("textbox", { name: "태그 이름" }),
  ).toBeEnabled();
}
async function closeManager(page: Page) {
  await manager(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(manager(page)).toHaveCount(0);
}
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `태그 검증 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".calendar-grid")).toBeVisible();
});
test.afterEach(() => expect(errors).toEqual([]));

test("개인 태그 목록과 변경은 팀원별로 독립적이고 공용 태그와 섞이지 않는다", async ({
  page,
}, info) => {
  const other = (
    await request(page, "/admin/users", "POST", {
      username: `personal-tags-${randomUUID()}@example.com`,
      password: "local-test-only-password",
      name: "서연",
      memberships: [{ teamId, role: "member" }],
    })
  ).user;
  const entries: { id: string; userId: string }[] = [];
  for (const owner of [userId, other.id]) {
    const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
      id: randomUUID(),
      userId: owner,
      name: "완료",
      color: "green",
      kind: "check",
    });
    entries.push(
      await request(page, "/calendar/entries", "POST", {
        id: randomUUID(),
        teamId,
        userId: owner,
        title: owner === userId ? "내 일정" : "서연 일정",
        date: todayKey(),
        tagIds: [tag.id],
        checkedTagIds: [tag.id],
      }),
    );
  }
  await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    userId: null,
    name: "공용 전용",
    color: "blue",
  });
  await page.getByRole("button", { name: "팀 주간 일정 보기" }).click();
  for (const entry of entries)
    await expect(
      page
        .locator(`[data-entry-id="${entry.id}"]`)
        .getByRole("checkbox", { name: "완료 체크" }),
    ).toBeChecked();
  await card(page, entries[1].id).click();
  await detail(page).locator(".calendar-tag-picker summary").click();
  await expect(
    detail(page).getByRole("button", { name: "공용 전용 태그" }),
  ).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "개인 태그 관리", exact: true })
    .click();
  await expect(manager(page)).toContainText("서연의 개인 일정에 사용하는 태그");
  await expect(
    manager(page).locator(".calendar-tag-list > button"),
  ).toHaveCount(1);
  await manager(page).getByRole("button", { name: "완료 1개 일정" }).click();
  await manager(page)
    .getByLabel("태그 이름", { exact: true })
    .fill("검토 완료");
  await manager(page)
    .getByRole("radio", { name: "파란색", exact: true })
    .check();
  await manager(page)
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "검토 완료 1개 일정" }),
  ).toBeVisible();
  await closeManager(page);
  await closeDetail(page);
  await expect(
    page
      .locator(`[data-entry-id="${entries[0].id}"]`)
      .getByRole("checkbox", { name: "완료 체크" }),
  ).toBeChecked();
  await expect(
    page
      .locator(`[data-entry-id="${entries[1].id}"]`)
      .getByRole("checkbox", { name: "검토 완료 체크" }),
  ).toBeChecked();
  await openManager(page);
  await expect(
    manager(page).getByRole("button", { name: "완료 1개 일정" }),
  ).toBeVisible();
  await expect(
    manager(page).getByRole("button", { name: "검토 완료 1개 일정" }),
  ).toHaveCount(0);
  await closeManager(page);
  await page.screenshot({ path: info.outputPath("personal-catalogs.png") });
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).click();
  await openManager(page);
  await expect(
    manager(page).locator(".calendar-tag-list > button"),
  ).toHaveCount(1);
  await expect(
    manager(page).getByRole("button", { name: "공용 전용 0개 일정" }),
  ).toBeVisible();
  await closeManager(page);
  await page
    .getByRole("button", { name: "개인 월간 보기", exact: true })
    .click();
  await page
    .getByRole("group", { name: "캘린더 팀원" })
    .locator(`[data-member-id="${other.id}"]`)
    .click();
  await openManager(page);
  await expect(
    manager(page).getByRole("button", { name: "검토 완료 1개 일정" }),
  ).toBeVisible();
  await expect(
    manager(page).getByRole("button", { name: "공용 전용 0개 일정" }),
  ).toHaveCount(0);
});

test("팀 월간 보기에서 일반 팀원이 공용 태그·일정을 만들고 이동·기간 조정·삭제·실행취소한다", async ({
  page,
}, info) => {
  const privateTag = await addTag(page, "개인 전용", "red");
  const privateEntry = await addEntry(page, "개인 일정", [privateTag.id]);
  const username = `shared-member-${randomUUID()}@example.com`,
    password = "local-test-only-password";
  await request(page, "/admin/users", "POST", {
    username,
    password,
    name: "공용 팀원",
    memberships: [{ teamId, role: "member" }],
  });
  await request(page, "/auth/logout", "POST");
  await request(page, "/auth/login", "POST", { username, password });
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  const shared = page.getByRole("button", {
    name: "팀 월간 보기",
    exact: true,
  });
  const personal = page.getByRole("button", {
    name: "개인 월간 보기",
    exact: true,
  });
  expect((await shared.boundingBox())!.x).toBeLessThan(
    (await personal.boundingBox())!.x,
  );
  await shared.click();
  await expect(shared).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".calendar-grid-header > div")).toHaveCount(7);
  await expect(page.locator(".calendar-week-tasks")).toHaveCount(0);
  await expect(page.getByLabel("캘린더 팀원")).toHaveCount(0);
  await expect(card(page, privateEntry.id)).toHaveCount(0);
  await openManager(page);
  await expect(manager(page)).toContainText("팀 공용 일정에 사용하는 태그");
  await expect(
    manager(page).getByRole("button", { name: "개인 전용 1개 일정" }),
  ).toHaveCount(0);
  await manager(page).getByLabel("태그 유형").selectOption("check");
  await manager(page)
    .getByLabel("태그 이름", { exact: true })
    .fill("공용 완료");
  await manager(page)
    .getByRole("radio", { name: "초록색", exact: true })
    .check();
  await manager(page).getByRole("button", { name: "태그 만들기" }).click();
  await expect(
    manager(page).getByRole("button", { name: "공용 완료 0개 일정" }),
  ).toBeVisible();
  await closeManager(page);
  const date = todayKey();
  await page
    .getByRole("button", { name: `${date} 팀 공용 일정 추가`, exact: true })
    .click();
  const creating = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await expect(creating.getByLabel("새 일정 제목")).toBeFocused();
  await creating.getByLabel("새 일정 제목").fill("함께 관리하는 일정");
  await creating.locator("summary").click();
  await creating
    .getByRole("button", { name: "공용 완료 태그", exact: true })
    .click();
  await creating.getByLabel("새 일정 제목").press("Enter");
  await openCreated(page, "함께 관리하는 일정");
  await expect(detail(page)).toBeVisible();
  await closeDetail(page);
  const listing = await request(
    page,
    `/calendar?teamId=${teamId}&scope=team&from=${date}&to=${date}`,
  );
  expect(listing.entries).toHaveLength(1);
  const entry = listing.entries[0];
  expect(entry.userId).toBeNull();
  const wrapper = () => page.locator(`[data-entry-id="${entry.id}"]`).first();
  const checkbox = () =>
    wrapper().getByRole("checkbox", { name: "공용 완료 체크", exact: true });
  await checkbox().check();
  await expect(checkbox()).toBeChecked();
  await expect(card(page, entry.id)).toBeEnabled();
  let reads = 0;
  page.on("request", (req) => {
    if (
      new URL(req.url()).pathname === "/api/calendar" &&
      req.method() === "GET"
    )
      reads++;
  });
  const movedDate = addDays(date, -1);
  const dragTo = async (
    source: ReturnType<typeof card>,
    targetDate: string,
  ) => {
    await source.scrollIntoViewIfNeeded();
    const start = (await source.boundingBox())!;
    const target = (await page
      .locator(`.calendar-day[data-owner-id="team"][data-date="${targetDate}"]`)
      .boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      start.x + start.width / 2 + 8,
      start.y + start.height / 2,
      { steps: 2 },
    );
    await page.mouse.move(target.x + target.width / 2, target.y + 14, {
      steps: 10,
    });
    await page.mouse.up();
  };
  await dragTo(card(page, entry.id), movedDate);
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${entry.id}`)).date,
    )
    .toBe(movedDate);
  await expect(card(page, entry.id)).toBeEnabled();
  await dragTo(
    wrapper().getByRole("button", { name: "종료일 조정", exact: true }),
    date,
  );
  await expect
    .poll(async () => {
      const saved = await request(page, `/calendar/entries/${entry.id}`);
      return [saved.date, saved.endDate];
    })
    .toEqual([movedDate, date]);
  await expect(checkbox()).toBeChecked();
  await expect(card(page, entry.id)).toHaveCSS(
    "background-color",
    "rgb(237, 246, 230)",
  );
  await card(page, entry.id).click();
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(card(page, entry.id)).toHaveCount(0);
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행취소", exact: true })
    .click();
  await expect(card(page, entry.id)).toBeVisible();
  await expect(checkbox()).toBeChecked();
  expect(reads).toBe(0);
  await page.screenshot({ path: info.outputPath("shared-month.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, entry.id).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("shared-month-mobile.png") });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await personal.click();
  await expect(card(page, entry.id)).toHaveCount(0);
  await shared.click();
  await expect(card(page, entry.id)).toBeVisible();
  const saved = await request(page, `/calendar/entries/${privateEntry.id}`);
  expect(saved.tagIds).toEqual([privateTag.id]);
  expect(saved.date).toBe(date);
});

test("열람자도 팀 공용 일정·태그를 편집하지만 개인 일정·태그는 읽기 전용이다", async ({
  page,
}, info) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    userId: null,
    name: "팀 회의",
    color: "purple",
  });
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId: null,
    title: "함께 보는 일정",
    date: todayKey(),
    tagIds: [tag.id],
  });
  const username = `shared-viewer-${randomUUID()}@example.com`,
    password = "local-test-only-password";
  await request(page, "/admin/users", "POST", {
    username,
    password,
    name: "공용 열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await request(page, "/auth/logout", "POST");
  await request(page, "/auth/login", "POST", { username, password });
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await page
    .getByRole("button", { name: "개인 태그 관리", exact: true })
    .click();
  await expect(
    manager(page).getByLabel("태그 이름", { exact: true }),
  ).toHaveCount(0);
  await closeManager(page);
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).click();
  await expect(card(page, entry.id)).toBeVisible();
  await expect(page.locator(".calendar-day button").first()).toBeEnabled();
  await card(page, entry.id).click();
  const title = detail(page).getByLabel("일정 제목", { exact: true });
  await expect(title).toBeEditable();
  await title.fill("함께 수정한 일정");
  await closeDetail(page);
  await expect(card(page, entry.id)).toContainText("함께 수정한 일정");
  await card(page, entry.id).click();
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(card(page, entry.id)).toHaveCount(0);
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행취소", exact: true })
    .click();
  await expect(card(page, entry.id)).toContainText("함께 수정한 일정");
  await openManager(page);
  await manager(page).getByRole("button", { name: "팀 회의 1개 일정" }).click();
  await manager(page)
    .getByLabel("태그 이름", { exact: true })
    .fill("주간 회의");
  await manager(page)
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "주간 회의 1개 일정" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("shared-tags-viewer.png") });
  await closeManager(page);
  await expect(card(page, entry.id)).toContainText("주간 회의");
});

test("태그 관리의 고정 10색과 일정 생성의 복수 선택·Enter·재열기를 연결한다", async ({
  page,
}, info) => {
  await openManager(page);
  const panel = manager(page);
  const labels = [
    "기본",
    "회색",
    "갈색",
    "주황색",
    "노란색",
    "초록색",
    "파란색",
    "보라색",
    "분홍색",
    "빨간색",
  ];
  await expect(panel.getByRole("radio")).toHaveCount(10);
  for (const name of labels)
    await expect(panel.getByRole("radio", { name, exact: true })).toBeVisible();
  await expect(panel.getByLabel("태그 이름", { exact: true })).toBeFocused();
  await panel.getByLabel("태그 이름", { exact: true }).fill("회의");
  await panel.getByRole("radio", { name: "보라색", exact: true }).check();
  await panel.getByRole("button", { name: "태그 만들기", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "회의 0개 일정" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "새 태그", exact: true }).click();
  await panel.getByLabel("태그 이름", { exact: true }).fill("검토");
  await panel.getByRole("radio", { name: "파란색", exact: true }).check();
  await panel.getByRole("button", { name: "태그 만들기", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "검토 0개 일정" }),
  ).toBeVisible();
  await info.attach("tag-manager", {
    body: await panel.screenshot({
      path: `/tmp/graeboard-tags-manager-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await closeManager(page);
  await page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const creating = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await expect(
    creating.getByLabel("새 일정 제목", { exact: true }),
  ).toBeFocused();
  await creating
    .getByLabel("새 일정 제목", { exact: true })
    .fill("태그가 있는 하루 일정");
  await creating.locator("summary", { hasText: "태그 선택" }).click();
  await expect(creating.locator(".calendar-tag-options input")).toHaveCount(0);
  await creating
    .getByRole("button", { name: "회의 태그", exact: true })
    .click();
  await expect(
    creating.getByRole("button", { name: "회의 태그", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    creating
      .getByRole("button", { name: "회의 · 배경색 적용 중", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await creating
    .getByRole("button", { name: "검토 태그", exact: true })
    .press("Enter");
  await expect(creating).toBeVisible();
  await expect(
    creating.getByRole("button", { name: "검토 태그", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await creating
    .getByRole("button", { name: "검토 태그", exact: true })
    .press("Space");
  await expect(
    creating.getByRole("button", { name: "검토 태그", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await creating
    .getByRole("button", { name: "검토 태그", exact: true })
    .click();
  await info.attach("tag-selection", {
    body: await creating.screenshot({
      path: `/tmp/graeboard-tag-selection-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await creating.getByLabel("새 일정 제목", { exact: true }).press("Enter");
  await openCreated(page, "태그가 있는 하루 일정");
  await expect(
    detail(page).getByLabel("일정 제목", { exact: true }),
  ).toHaveValue("태그가 있는 하루 일정");
  await expect(
    detail(page).getByRole("button", {
      name: "회의 · 배경색 적용 중",
      exact: true,
    }),
  ).toBeVisible();
  await closeDetail(page);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].tagIds).toHaveLength(2);
  await expect(card(page, entries[0].id)).toHaveCSS(
    "background-color",
    "rgb(243, 239, 251)",
  );
  await card(page, entries[0].id).click();
  await expect(
    detail(page).getByRole("button", {
      name: "검토 색상을 배경에 적용",
      exact: true,
    }),
  ).toBeVisible();
  await closeDetail(page);
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await expect(card(page, entries[0].id)).toHaveCSS(
    "background-color",
    "rgb(243, 239, 251)",
  );
  await expect(
    card(page, entries[0].id).locator(".calendar-tag-chip"),
  ).toHaveText(["회의", "검토"]);
});

test("태그 색상·이름 변경과 삭제는 월간·팀 주간의 하루·여러 날짜 일정에 재조회 없이 반영된다", async ({
  page,
}, info) => {
  const first = await addTag(page, "회의", "purple"),
    second = await addTag(page, "휴무", "red");
  const day = await addEntry(page, "하루 일정", [first.id, second.id]);
  const multi = await addEntry(
    page,
    "여러 날짜 일정",
    [first.id, second.id],
    2,
  );
  for (const entry of [day, multi])
    await expect(card(page, entry.id)).toHaveCSS(
      "background-color",
      "rgb(243, 239, 251)",
    );
  await openManager(page);
  await manager(page).getByRole("button", { name: "회의 2개 일정" }).click();
  await manager(page)
    .getByLabel("태그 이름", { exact: true })
    .fill("정기 회의");
  await manager(page)
    .getByRole("radio", { name: "초록색", exact: true })
    .check();
  let calendarReads = 0;
  const countReads = (req: { url(): string; method(): string }) => {
    if (
      new URL(req.url()).pathname === "/api/calendar" &&
      req.method() === "GET"
    )
      calendarReads++;
  };
  page.on("request", countReads);
  await manager(page)
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "정기 회의 2개 일정" }),
  ).toBeVisible();
  await closeManager(page);
  for (const entry of [day, multi]) {
    await expect(card(page, entry.id)).toHaveCSS(
      "background-color",
      "rgb(237, 246, 230)",
    );
    await expect(card(page, entry.id).locator(".calendar-tag-chip")).toHaveText(
      ["정기 회의", "휴무"],
    );
  }
  expect(calendarReads).toBe(0);
  page.off("request", countReads);
  await page.getByRole("button", { name: "팀 주간 일정 보기" }).click();
  for (const entry of [day, multi])
    await expect(card(page, entry.id)).toHaveCSS(
      "background-color",
      "rgb(237, 246, 230)",
    );
  await info.attach("tagged-team-calendar", {
    body: await page.locator(".calendar-workspace").screenshot({
      path: `/tmp/graeboard-tags-calendar-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await card(page, day.id).click();
  await detail(page)
    .getByRole("button", { name: "휴무 색상을 배경에 적용", exact: true })
    .click();
  await expect(
    detail(page).getByRole("button", {
      name: "휴무 · 배경색 적용 중",
      exact: true,
    }),
  ).toBeEnabled();
  await closeDetail(page);
  await expect(card(page, day.id)).toHaveCSS(
    "background-color",
    "rgb(255, 240, 235)",
  );
  await card(page, day.id).focus();
  const moveDays = calendarWeek(todayKey()) === todayKey() ? 1 : -1;
  await card(page, day.id).press(
    moveDays === 1 ? "Alt+ArrowRight" : "Alt+ArrowLeft",
  );
  await expect(
    page.locator(`[data-entry-id="${day.id}"]`).first(),
  ).toHaveAttribute("data-range-start", addDays(todayKey(), moveDays));
  await expect(card(page, day.id)).toHaveCSS(
    "background-color",
    "rgb(255, 240, 235)",
  );
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${day.id}`)).tagIds,
    )
    .toEqual([second.id, first.id]);
  await openManager(page);
  await manager(page).getByRole("button", { name: "휴무 2개 일정" }).click();
  await manager(page)
    .getByRole("button", { name: "태그 삭제", exact: true })
    .click();
  await manager(page)
    .getByRole("button", { name: "태그 삭제 확인", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "휴무 2개 일정" }),
  ).toHaveCount(0);
  await closeManager(page);
  for (const entry of [day, multi])
    await expect(card(page, entry.id)).toHaveCSS(
      "background-color",
      "rgb(237, 246, 230)",
    );
  await openManager(page);
  await manager(page)
    .getByRole("button", { name: "정기 회의 2개 일정" })
    .click();
  await manager(page)
    .getByRole("button", { name: "태그 삭제", exact: true })
    .click();
  await manager(page)
    .getByRole("button", { name: "태그 삭제 확인", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "정기 회의 2개 일정" }),
  ).toHaveCount(0);
  await closeManager(page);
  await page.mouse.move(0, 0);
  for (const entry of [day, multi]) {
    await expect(card(page, entry.id)).toHaveCSS(
      "background-color",
      "rgb(185, 230, 166)",
    );
    expect(
      (await request(page, `/calendar/entries/${entry.id}`)).tagIds,
    ).toEqual([]);
  }
});

test("일정 태그 저장 실패를 알리고 지연된 태그 저장이 동시 제목 저장을 덮어쓰지 않는다", async ({
  page,
}) => {
  const tag = await addTag(page, "검토", "blue");
  const otherTag = await addTag(page, "긴급", "red");
  const entry = await addEntry(page, "원래 제목", []);
  await card(page, entry.id).click();
  const path = `**/api/calendar/entries/${entry.id}`;
  await page.route(path, async (route) => {
    if (
      route.request().method() === "PATCH" &&
      "tagIds" in route.request().postDataJSON()
    )
      await route.fulfill({
        status: 503,
        json: { error: "태그 저장 재시도 검증" },
      });
    else await route.continue();
  });
  await detail(page).locator("summary", { hasText: "태그 선택" }).click();
  await detail(page)
    .getByRole("button", { name: "검토 태그", exact: true })
    .click();
  await expect(detail(page).getByText("태그 저장 재시도 검증")).toBeVisible();
  await expect(
    detail(page).getByRole("button", { name: "검토 태그", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.unroute(path);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    if (
      route.request().method() === "PATCH" &&
      "tagIds" in route.request().postDataJSON()
    ) {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await detail(page)
      .getByRole("button", { name: "검토 태그", exact: true })
      .click();
    await expect(
      detail(page).getByRole("button", { name: "검토 태그", exact: true }),
    ).toBeDisabled();
    await detail(page)
      .getByLabel("일정 제목", { exact: true })
      .fill("동시에 바꾼 제목");
    await expect
      .poll(
        async () =>
          (await request(page, `/calendar/entries/${entry.id}`)).title,
      )
      .toBe("동시에 바꾼 제목");
  } finally {
    release();
  }
  await expect(
    detail(page).getByRole("button", { name: "검토 태그", exact: true }),
  ).toBeEnabled();
  await closeDetail(page);
  await expect(card(page, entry.id)).toHaveCSS(
    "background-color",
    "rgb(234, 245, 252)",
  );
  await expect(card(page, entry.id).locator("strong")).toHaveText(
    "동시에 바꾼 제목",
  );
  expect((await request(page, `/calendar/entries/${entry.id}`)).tagIds).toEqual(
    [tag.id],
  );
  await card(page, entry.id).click();
  await expect(
    detail(page).getByRole("button", {
      name: "검토 · 배경색 적용 중",
      exact: true,
    }),
  ).toBeEnabled();
  await request(page, `/calendar/entries/${entry.id}`, "PATCH", {
    tagIds: [otherTag.id],
    expectedTagIds: [tag.id],
  });
  await detail(page)
    .getByRole("button", { name: "검토 태그 제거", exact: true })
    .click();
  await expect(
    detail(page).getByText(
      "다른 사용자가 일정 태그를 변경했습니다. 최신 태그를 확인하고 다시 선택하세요.",
    ),
  ).toBeVisible();
  await expect(
    detail(page).getByRole("button", {
      name: "긴급 · 배경색 적용 중",
      exact: true,
    }),
  ).toBeEnabled();
  await closeDetail(page);
  await expect(card(page, entry.id)).toHaveCSS(
    "background-color",
    "rgb(255, 240, 235)",
  );
  await expect(card(page, entry.id).locator(".calendar-tag-chip")).toHaveText([
    "긴급",
  ]);
});

test("좁은 화면의 일정 추가 안에서 태그를 관리하고 작성 중인 제목을 유지한다", async ({
  page,
}, info) => {
  await page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const creating = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await creating
    .getByLabel("새 일정 제목", { exact: true })
    .fill("작성 중인 제목");
  await page.setViewportSize({ width: 390, height: 844 });
  await creating.locator("summary", { hasText: "태그 선택" }).click();
  await creating
    .getByRole("button", { name: "개인 태그 관리", exact: true })
    .click();
  await expect(
    manager(page).getByLabel("태그 이름", { exact: true }),
  ).toBeFocused();
  await manager(page)
    .getByLabel("태그 이름", { exact: true })
    .fill("모바일 검토");
  await manager(page)
    .getByRole("radio", { name: "노란색", exact: true })
    .check();
  await manager(page)
    .getByRole("button", { name: "태그 만들기", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "모바일 검토 0개 일정" }),
  ).toBeVisible();
  expect(
    await manager(page).evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await info.attach("narrow-tag-manager", {
    body: await manager(page).screenshot({
      path: `/tmp/graeboard-tags-narrow-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await closeManager(page);
  await expect(
    creating.getByLabel("새 일정 제목", { exact: true }),
  ).toHaveValue("작성 중인 제목");
  await creating.locator("summary", { hasText: "태그 선택" }).click();
  await creating
    .getByRole("button", { name: "모바일 검토 태그", exact: true })
    .click();
  await creating.getByLabel("새 일정 제목", { exact: true }).press("Enter");
  await openCreated(page, "작성 중인 제목");
  await expect(
    detail(page).getByRole("button", {
      name: "모바일 검토 · 배경색 적용 중",
      exact: true,
    }),
  ).toBeVisible();
  await closeDetail(page);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].tagIds).toHaveLength(1);
});

test("체크 태그를 만들고 일정별 체크·키보드·배경색·유형 변경을 저장한다", async ({
  page,
}, info) => {
  await openManager(page);
  await manager(page)
    .getByLabel("태그 유형", { exact: true })
    .selectOption("check");
  await manager(page).getByLabel("태그 이름", { exact: true }).fill("완료");
  await manager(page)
    .getByRole("radio", { name: "초록색", exact: true })
    .check();
  await manager(page)
    .getByRole("button", { name: "태그 만들기", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "완료 0개 일정" }),
  ).toBeVisible();
  await info.attach("check-tag-manager", {
    body: await manager(page).screenshot({
      path: `/tmp/graeboard-check-tag-manager-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await closeManager(page);
  const tag = (await request(page, `/calendar/teams/${teamId}/tags`)).tags[0];
  expect(tag.kind).toBe("check");
  await page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const creating = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await creating.getByLabel("새 일정 제목").fill("체크한 일정");
  await creating.locator("summary", { hasText: "태그 선택" }).click();
  await creating
    .getByRole("button", { name: "완료 태그", exact: true })
    .click();
  await creating
    .getByRole("checkbox", { name: "완료 체크", exact: true })
    .check();
  await creating.getByLabel("새 일정 제목").press("Enter");
  await openCreated(page, "체크한 일정");
  await expect(
    detail(page).getByRole("checkbox", { name: "완료 체크", exact: true }),
  ).toBeChecked();
  await closeDetail(page);
  const first = (
    await request(
      page,
      `/calendar?teamId=${teamId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries[0];
  const second = await addEntry(
    page,
    "따로 체크할 여러 날짜 일정",
    [tag.id],
    3,
  );
  const label = await addTag(page, "회의", "purple");
  // Reload after API seeding so remote seed notifications are not counted as local UI writes.
  await page.reload();
  const checks = (id: string) =>
    page
      .locator(`[data-entry-id="${id}"]`)
      .getByRole("checkbox", { name: "완료 체크", exact: true });
  await expect(checks(first.id).first()).toBeChecked();
  await expect(checks(second.id).first()).not.toBeChecked();
  await expect(card(page, first.id).locator("input")).toHaveCount(0);
  const reads: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "GET" &&
      new URL(req.url()).pathname === "/api/calendar"
    )
      reads.push(req.url());
  });
  await checks(first.id).first().uncheck();
  await expect(checks(first.id).first()).toBeEnabled();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.locator(".is-drag-preview")).toHaveCount(0);
  await checks(first.id).first().press("Space");
  await expect(checks(first.id).first()).toBeEnabled();
  await expect(checks(first.id).first()).toBeChecked();
  await expect(checks(second.id).first()).not.toBeChecked();
  await checks(second.id).first().check();
  await expect(checks(second.id).first()).toBeEnabled();
  for (const checkbox of await checks(second.id).all())
    await expect(checkbox).toBeChecked();
  const offset = new Date(`${todayKey()}T00:00:00Z`).getUTCDay() === 6 ? -1 : 1;
  const destination = addDays(todayKey(), offset);
  const bodyBox = (await card(page, first.id).boundingBox())!;
  const dayBox = (await page
    .locator(`.calendar-day[data-date="${destination}"]`)
    .boundingBox())!;
  await page.mouse.move(
    bodyBox.x + bodyBox.width / 2,
    bodyBox.y + bodyBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dayBox.x + dayBox.width / 2,
    bodyBox.y + bodyBox.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(card(page, first.id)).toBeEnabled();
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${first.id}`)).date,
    )
    .toBe(destination);
  await expect(checks(first.id).first()).toBeChecked();
  await expect(detail(page)).toHaveCount(0);
  expect((await request(page, `/calendar/entries/${first.id}`)).lane).toBe(
    first.lane,
  );
  expect(
    (await request(page, `/calendar/entries/${second.id}`)).checkedTagIds,
  ).toEqual([tag.id]);
  await card(page, first.id).click();
  await detail(page).locator("summary", { hasText: "태그 선택" }).click();
  await detail(page)
    .getByRole("button", { name: "회의 태그", exact: true })
    .click();
  await expect(
    detail(page).getByRole("button", {
      name: "회의 색상을 배경에 적용",
      exact: true,
    }),
  ).toBeEnabled();
  await detail(page)
    .getByRole("button", { name: "회의 색상을 배경에 적용", exact: true })
    .click();
  await expect(
    detail(page).getByRole("checkbox", { name: "완료 체크", exact: true }),
  ).toBeEnabled();
  await expect(
    detail(page).getByRole("checkbox", { name: "완료 체크", exact: true }),
  ).toBeChecked();
  await closeDetail(page);
  await expect(card(page, first.id)).toHaveCSS(
    "background-color",
    "rgb(243, 239, 251)",
  );
  const firstSaved = await request(page, `/calendar/entries/${first.id}`);
  expect(firstSaved.tagIds).toEqual([label.id, tag.id]);
  expect(firstSaved.checkedTagIds).toEqual([tag.id]);
  expect(reads).toEqual([]);
  await page.screenshot({
    path: `/tmp/graeboard-check-tag-calendar-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await expect(checks(first.id).first()).toBeChecked();
  await expect(checks(second.id).first()).toBeChecked();
  await page
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  await expect(checks(first.id).first()).toBeChecked();
  await expect(checks(second.id).first()).toBeChecked();
  await openManager(page);
  await manager(page).getByRole("button", { name: "완료 2개 일정" }).click();
  await manager(page)
    .getByLabel("태그 유형", { exact: true })
    .selectOption("label");
  await manager(page)
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await expect(
    manager(page).getByRole("button", { name: "변경 저장", exact: true }),
  ).toBeEnabled();
  await closeManager(page);
  await expect(checks(first.id)).toHaveCount(0);
  expect(
    (await request(page, `/calendar/entries/${first.id}`)).checkedTagIds,
  ).toEqual([]);
});

test("체크 실패는 복원하고 늦은 제목·본문 저장 응답은 체크 상태를 덮어쓰지 않는다", async ({
  page,
}) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "검토 완료",
    color: "blue",
    kind: "check",
  });
  const entry = await addEntry(page, "동시 체크", [tag.id]);
  const box = page
    .locator(`[data-entry-id="${entry.id}"]`)
    .getByRole("checkbox", { name: "검토 완료 체크", exact: true })
    .first();
  const checkPath = `**/api/calendar/entries/${entry.id}/tags/${tag.id}`;
  await page.route(checkPath, (route) =>
    route.fulfill({ status: 503, json: { error: "체크 저장 실패 검증" } }),
  );
  await box.click();
  await expect(
    page.getByText("체크 저장 실패 검증", { exact: true }),
  ).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(detail(page)).toHaveCount(0);
  await page.unroute(checkPath);
  await card(page, entry.id).click();
  let release = () => {},
    titleStarted = () => {},
    documentStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const titleHeld = new Promise<void>((resolve) => {
    titleStarted = resolve;
  });
  const documentHeld = new Promise<void>((resolve) => {
    documentStarted = resolve;
  });
  await page.route(`**/api/calendar/entries/${entry.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    titleStarted();
    await gate;
    await route.fulfill({ response });
  });
  await page.route(
    `**/api/calendar/entries/${entry.id}/document`,
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      documentStarted();
      await gate;
      await route.fulfill({ response });
    },
  );
  try {
    await detail(page)
      .getByLabel("일정 제목", { exact: true })
      .fill("체크와 함께 저장한 제목");
    await titleHeld;
    await detail(page)
      .getByRole("button", { name: "Markdown 원문", exact: true })
      .click();
    await detail(page)
      .getByRole("textbox", { name: "일정 문서 Markdown 원문" })
      .fill("체크와 함께 저장한 본문");
    await documentHeld;
    const check = detail(page).getByRole("checkbox", {
      name: "검토 완료 체크",
      exact: true,
    });
    await check.check();
    await expect(check).toBeEnabled();
    expect(
      (await request(page, `/calendar/entries/${entry.id}`)).checkedTagIds,
    ).toEqual([tag.id]);
    release();
    await expect(detail(page).locator(".document-save-state")).toHaveText(
      "저장됨",
    );
    await expect(check).toBeChecked();
    await closeDetail(page);
    await expect(box).toBeChecked();
    await expect(card(page, entry.id).locator("strong")).toHaveText(
      "체크와 함께 저장한 제목",
    );
    await card(page, entry.id).click();
    await expect(
      detail(page).getByRole("checkbox", {
        name: "검토 완료 체크",
        exact: true,
      }),
    ).toBeChecked();
    await detail(page)
      .getByRole("checkbox", { name: "검토 완료 체크", exact: true })
      .uncheck();
    await expect(
      detail(page).getByRole("checkbox", {
        name: "검토 완료 체크",
        exact: true,
      }),
    ).toBeEnabled();
    await closeDetail(page);
    await expect(box).not.toBeChecked();
  } finally {
    release();
  }
});

test("열람자는 체크 태그의 상태를 볼 수 있지만 변경할 수 없다", async ({
  page,
}) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "완료",
    color: "green",
    kind: "check",
  });
  const entry = await addEntry(page, "열람용 체크", [tag.id]);
  await request(page, `/calendar/entries/${entry.id}/tags/${tag.id}`, "PATCH", {
    checked: true,
    expectedChecked: false,
  });
  const username = `check-viewer-${randomUUID()}@example.com`,
    password = "local-test-only-password";
  await request(page, "/admin/users", "POST", {
    username,
    password,
    name: "체크 열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await request(page, "/auth/logout", "POST");
  await request(page, "/auth/login", "POST", { username, password });
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await page
    .getByRole("group", { name: "캘린더 팀원" })
    .locator(`[data-member-id="${userId}"]`)
    .click();
  const box = page
    .locator(`[data-entry-id="${entry.id}"]`)
    .getByRole("checkbox", { name: "완료 체크", exact: true })
    .first();
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await card(page, entry.id).click();
  await expect(
    detail(page).getByRole("checkbox", { name: "완료 체크", exact: true }),
  ).toBeChecked();
  await expect(
    detail(page).getByRole("checkbox", { name: "완료 체크", exact: true }),
  ).toBeDisabled();
});

test("일정 상세를 간결하게 표시하고 즉시 삭제·실행취소로 입력 중 내용과 태그·순서를 복원한다", async ({
  page,
}, info) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "완료",
    color: "green",
    kind: "check",
  });
  await addTag(page, "회의", "purple");
  const entry = await addEntry(page, "복원 전 일정", [tag.id], 2);
  const below = await addEntry(page, "아래 일정", []);
  await request(page, `/calendar/entries/${entry.id}/tags/${tag.id}`, "PATCH", {
    checked: true,
    expectedChecked: false,
  });
  await page.reload();
  await expect(card(page, entry.id)).toBeVisible();
  const reads: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "GET" &&
      new URL(req.url()).pathname === "/api/calendar"
    )
      reads.push(req.url());
  });
  await card(page, entry.id).click();
  const panel = detail(page),
    heading = panel.locator(".calendar-entry-heading");
  await expect(
    panel.getByRole("textbox", { name: "일정 제목", exact: true }),
  ).toHaveValue(entry.title);
  await expect(panel.getByRole("button", { name: /전체 페이지/ })).toHaveCount(
    0,
  );
  await expect(heading.getByText("일정 제목", { exact: true })).toHaveCount(0);
  await expect(heading.getByText("일정 기간", { exact: true })).toHaveCount(0);
  await expect(heading.locator(":scope > p")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /완료.*배경/ })).toHaveCount(
    0,
  );
  const remove = panel.getByRole("button", { name: "일정 삭제", exact: true });
  await expect(remove).toHaveCSS("color", "rgb(184, 67, 64)");
  const check = panel.getByRole("checkbox", { name: "완료 체크", exact: true });
  await expect(check).toBeChecked();
  const tags = panel.locator(".calendar-tag-picker"),
    choices = tags.locator("summary");
  expect((await tags.boundingBox())!.height).toBeLessThanOrEqual(36);
  const beforeHeight = (await heading.boundingBox())!.height;
  await choices.click();
  await expect(
    panel.getByRole("button", { name: "회의 태그", exact: true }),
  ).toBeVisible();
  expect((await heading.boundingBox())!.height).toBe(beforeHeight);
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(choices).toBeFocused();
  await expect(tags.locator("details")).not.toHaveAttribute("open");
  await info.attach("compact-detail", {
    body: await panel.screenshot({
      path: `/tmp/graeboard-compact-detail-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await choices.click();
  const options = tags.locator(".calendar-tag-options");
  await expect(options).toBeVisible();
  const box = (await options.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await panel.getByRole("textbox", { name: "일정 제목", exact: true }).click();
  await expect(options).not.toBeVisible();
  await info.attach("compact-detail-mobile", {
    body: await panel.screenshot({
      path: `/tmp/graeboard-compact-detail-mobile-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  await panel
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const markdown = "# 실행취소로 복원할 본문\n\n- [x] 확인 완료";
  await panel
    .getByRole("textbox", { name: "일정 문서 Markdown 원문" })
    .fill(markdown);
  await panel
    .getByLabel("일정 종료일", { exact: true })
    .fill(addDays(entry.endDate, 1));
  await panel
    .getByLabel("일정 제목", { exact: true })
    .fill("삭제 직전 입력한 제목");
  await remove.click();
  await expect(panel).toHaveCount(0);
  await expect(card(page, entry.id)).toHaveCount(0);
  const toast = page
    .locator(".toast")
    .filter({ hasText: "일정을 삭제했습니다." });
  await expect(toast).toContainText("삭제 직전 입력한 제목");
  await toast.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(card(page, entry.id)).toBeVisible();
  await expect(card(page, entry.id)).toContainText("삭제 직전 입력한 제목");
  const restoredToast = page.locator(".toast");
  await expect(restoredToast).toHaveText(
    "‘삭제 직전 입력한 제목’ 일정을 되살렸습니다.",
  );
  await expect(page.locator(".calendar-notice")).toHaveCount(0);
  await info.attach("calendar-restored-toast", {
    body: await restoredToast.screenshot({
      path: `/tmp/graeboard-calendar-restored-toast-${info.project.name}.png`,
    }),
    contentType: "image/png",
  });
  await expect(
    page
      .locator(`[data-entry-id="${entry.id}"]`)
      .getByRole("checkbox", { name: "완료 체크" })
      .first(),
  ).toBeChecked();
  expect(reads).toEqual([]);
  const restored = await request(page, `/calendar/entries/${entry.id}`);
  expect(restored.tagIds).toEqual([tag.id]);
  expect(restored.checkedTagIds).toEqual([tag.id]);
  expect(restored.endDate).toBe(addDays(entry.endDate, 1));
  expect(restored.lane).toBe(0);
  expect((await request(page, `/calendar/entries/${below.id}`)).lane).toBe(1);
  expect(
    (await request(page, `/calendar/entries/${entry.id}/document`)).markdown,
  ).toBe(markdown);
  await page.reload();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await expect(card(page, entry.id)).toContainText("삭제 직전 입력한 제목");
});

test("삭제와 실행취소 응답이 유실되어도 오류를 표시하고 같은 요청으로 재시도한다", async ({
  page,
}) => {
  const entry = await addEntry(page, "응답 유실 복원", []);
  await card(page, entry.id).click();
  const path = `**/api/calendar/entries/${entry.id}`;
  const deletionIds: string[] = [];
  await page.route(path, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletionIds.push(route.request().postDataJSON().deletionId);
    const response = await route.fetch();
    if (deletionIds.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: "삭제 응답 유실 검증" },
      });
    await route.fulfill({ response });
  });
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(
    detail(page).getByText("삭제 응답 유실 검증", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(detail(page)).toHaveCount(0);
  expect(deletionIds).toHaveLength(2);
  expect(deletionIds[0]).toBe(deletionIds[1]);
  const restoreIds: string[] = [];
  await page.route(`${path}/restore`, async (route) => {
    restoreIds.push(route.request().postDataJSON().deletionId);
    const response = await route.fetch();
    if (restoreIds.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: "복구 응답 유실 검증" },
      });
    await route.fulfill({ response });
  });
  const undo = page
    .locator(".toast")
    .getByRole("button", { name: "실행취소", exact: true });
  await undo.click();
  await expect(
    page.getByText("복구 응답 유실 검증", { exact: true }),
  ).toBeVisible();
  await expect(card(page, entry.id)).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(card(page, entry.id)).toBeVisible();
  await expect(page.locator(".toast")).toHaveText(
    "‘응답 유실 복원’ 일정을 되살렸습니다.",
  );
  await expect(page.locator(".calendar-notice")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 5500 });
  expect(restoreIds).toEqual([deletionIds[0], deletionIds[0]]);
});
