import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { addDays, calendarWeek } from "../../shared/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
let teamId: string, userId: string, taskId: string;
test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `화면 개선 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: "문서 테스트 업무" },
    })
  ).task.id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
});
async function board(page: Page) {
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const segment = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`).first();
async function entry(page: Page, title: string, date: string, shared = false) {
  return request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId: shared ? null : userId,
    title,
    date,
    endDate: date,
  });
}

test("마지막 문서 삭제는 즉시 초기 상태를 복원하고 다시 작성할 수 있다", async ({
  page,
}, info) => {
  await board(page);
  const icon = page.locator(
    `[data-cell="${taskId}:title"] .task-document-indicator`,
  );
  await page.locator(`[data-cell="${taskId}:title"]`).hover();
  await expect(icon).toHaveCSS("opacity", "0.18");
  await icon.hover();
  await expect(icon).toHaveCSS("opacity", "0.18");
  await icon.click();
  const start = detail(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  const character = detail(page).locator(".document-empty-character");
  await expect(start).toBeVisible();
  expect((await start.boundingBox())!.y).toBeLessThan(
    (await character.boundingBox())!.y,
  );
  await start.click();
  const rich = detail(page).getByRole("textbox", {
    name: "업무 문서 리치 편집",
  });
  await rich.fill("삭제할 문서");
  await detail(page)
    .getByRole("button", { name: "문서 1 메뉴", exact: true })
    .click();
  await detail(page)
    .getByRole("menuitem", { name: "문서 삭제", exact: true })
    .click();
  await detail(page)
    .getByRole("button", { name: "문서 삭제", exact: true })
    .click();
  await expect(start).toBeVisible();
  await expect(detail(page).getByRole("tablist")).toHaveCount(0);
  await detail(page).screenshot({
    path: info.outputPath("empty-after-delete.png"),
  });
  await start.click();
  await expect(rich).toBeEmpty();
  await rich.fill("다시 작성한 문서");
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  expect(
    (await request(page, `/tasks/${taskId}/documents/main`)).markdown,
  ).toContain("다시 작성한 문서");
});

test("숨긴 요일의 일정 목록에서 해당 일정 상세를 연다", async ({ page }) => {
  const sunday = calendarWeek(todayKey());
  const hidden = await entry(page, "숨은 일요일 회의", sunday);
  await entry(page, "숨은 토요일 회의", addDays(sunday, 6));
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [1, 2, 3, 4, 5],
  });
  await board(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page.getByRole("button", { name: "숨긴 요일에 일정 2개" }).click();
  const list = page.getByRole("dialog", {
    name: "숨긴 요일의 일정",
    exact: true,
  });
  await expect(
    list.getByRole("button", { name: /숨은 일요일 회의/ }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: /숨은 토요일 회의/ }),
  ).toBeVisible();
  await list.getByRole("button", { name: /숨은 일요일 회의/ }).click();
  await expect(list).toHaveCount(0);
  const panel = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  await expect(
    panel.getByRole("textbox", { name: "일정 제목", exact: true }),
  ).toHaveValue(hidden.title);
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("searchbox", { name: "일정 제목 검색" }).fill("일요일");
  await page.getByRole("button", { name: "숨긴 요일에 일정 1개" }).click();
  await expect(
    list.getByRole("button", { name: /숨은 일요일 회의/ }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: /숨은 토요일 회의/ }),
  ).toHaveCount(0);
});

for (const mode of ["personal", "shared", "team"]) {
  const shared = mode === "shared";
  test(`${mode} 검색은 카드 위치를 유지하고 실제 본문이 있는 문서를 구분한다`, async ({
    page,
  }, info) => {
    const date = todayKey();
    const first = await entry(page, "먼저 배치된 일정", date, shared);
    const second = await entry(page, "찾을 회의", date, shared);
    await request(page, `/calendar/entries/${second.id}/document`, "PUT", {
      markdown: "---",
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    await board(page);
    await page.getByRole("button", { name: "캘린더", exact: true }).click();
    if (shared)
      await page
        .getByRole("button", { name: "팀 월간 보기", exact: true })
        .click();
    if (mode === "team")
      await page
        .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
        .click();
    await expect(segment(page, second.id)).toBeVisible();
    await expect(segment(page, second.id).getByLabel("문서 있음")).toHaveCount(
      0,
    );
    const updated = await request(
      page,
      `/calendar/entries/${second.id}/document`,
    );
    await request(page, `/calendar/entries/${second.id}/document`, "PUT", {
      markdown: "# 실제 문서 본문",
      expectedRevision: updated.revision,
      operationId: randomUUID(),
    });
    await expect(
      segment(page, second.id).getByLabel("문서 있음"),
    ).toBeVisible();
    await expect(segment(page, first.id).getByLabel("문서 있음")).toHaveCount(
      0,
    );
    const before = await segment(page, second.id).boundingBox();
    const search = page.getByRole("searchbox", { name: "일정 제목 검색" });
    await search.fill("찾을");
    await expect(segment(page, first.id)).toBeHidden();
    await expect(segment(page, second.id)).toBeVisible();
    expect(await segment(page, second.id).boundingBox()).toEqual(before);
    await page.screenshot({ path: info.outputPath("calendar-search.png") });
    await search.fill("없는 검색어");
    await expect(segment(page, second.id)).toBeHidden();
    await page
      .getByRole("button", { name: "검색 지우기", exact: true })
      .click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(segment(page, first.id)).toBeVisible();
    expect(await segment(page, second.id).boundingBox()).toEqual(before);
    await search.fill("없는 검색어");
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(segment(page, first.id)).toBeVisible();
    expect(await segment(page, second.id).boundingBox()).toEqual(before);
  });
}

test("꼬리 메모 제목 줄 편집·전체 화면·드래그 스크롤은 편집기를 유지한다", async ({
  page,
}, info) => {
  const path = `/teams/${teamId}/years/2026/memos`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries())
    await request(page, path, "POST", { id, title: `메모 ${index + 1}` });
  await board(page);
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  await memos.getByRole("button", { name: "꼬리 메모", exact: true }).click();
  const first = memos.locator(`[data-document-id="${ids[0]}"]`);
  await first.locator(".memo-document-title").dblclick();
  const title = first.getByRole("textbox", { name: "문서 제목", exact: true });
  await title.fill("수정한 메모");
  await title.press("Enter");
  await expect(
    memos.getByRole("tab", { name: "수정한 메모", exact: true }),
  ).toBeVisible();
  await first
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = first.getByRole("textbox", {
    name: "연간 업무 메모 Markdown 원문",
  });
  await source.fill("# 확대해도 보존할 내용");
  const originalEditor = await source.elementHandle();
  await page
    .getByRole("spinbutton", { name: "확대율", exact: true })
    .fill("75");
  await page
    .getByRole("spinbutton", { name: "확대율", exact: true })
    .press("Enter");
  await first
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await expect(first).toHaveAttribute("role", "dialog");
  expect(await first.evaluate((el) => el.matches(":modal"))).toBe(true);
  expect((await first.boundingBox())!.width).toBe(1366);
  expect(
    await source.evaluate((el, original) => el === original, originalEditor),
  ).toBe(true);
  await source.fill("# 전체 화면에서 저장한 내용");
  const header = first.locator(".memo-document-heading");
  const close = header.getByRole("button", { name: "닫기", exact: true });
  const headerBox = (await header.boundingBox())!;
  const closeBox = (await close.boundingBox())!;
  expect(headerBox.y).toBe(0);
  expect(headerBox.width).toBe(1366);
  expect(closeBox.x).toBeGreaterThan(1300);
  await first.screenshot({ path: info.outputPath("memo-full-page.png") });
  await close.click();
  await expect(first).toHaveAttribute("role", "tabpanel");
  expect(
    await source.evaluate((el, original) => el === original, originalEditor),
  ).toBe(true);
  await expect(source).toHaveValue("# 전체 화면에서 저장한 내용");
  await page.getByRole("button", { name: "원래대로", exact: true }).click();
  const slider = memos.getByRole("scrollbar", {
    name: "꼬리 메모 좌우 스크롤",
  });
  await expect(slider).toHaveAttribute("aria-disabled", "false");
  const rail = memos.locator(".memo-documents");
  const bounds = (await slider.boundingBox())!;
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(() => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(500);
  await slider.press("Home");
  await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.setViewportSize({ width: 390, height: 900 });
  const mobileSlider = (await slider.boundingBox())!;
  const toggle = memos.getByRole("button", { name: "꼬리 메모", exact: true });
  const toggleBox = (await toggle.boundingBox())!;
  expect(mobileSlider.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width);
  expect(mobileSlider.x + mobileSlider.width).toBeLessThanOrEqual(390);
  await slider.press("End");
  await expect
    .poll(() => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await slider.press("Home");
  await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBe(0);
  await memos.screenshot({ path: info.outputPath("memo-mobile.png") });
  await memos.getByRole("button", { name: "꼬리 메모", exact: true }).click();
  expect((await request(page, `${path}/${ids[0]}`)).markdown).toContain(
    "전체 화면에서 저장한 내용",
  );
  expect((await request(page, path)).documents[0].title).toBe("수정한 메모");
});

for (const offset of [9 * 60_000, -2 * 86400_000]) {
  test(`PC 시각 ${offset}ms 차이와 로그인 후 시각 변경에도 표·상세 저장이 성공한다`, async ({
    page,
  }) => {
    await page.clock.setSystemTime(Date.now() + offset);
    await board(page);
    const cell = page.locator(`[data-cell="${taskId}:title"]`);
    const writes: any[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/cells/batch"))
        writes.push(unpack(r.postDataJSON()));
    });
    await cell.dblclick();
    const editor = page
      .locator(".inline-editor textarea,.inline-editor input")
      .first();
    await editor.fill("PC 시각과 무관한 저장");
    await editor.press("Enter");
    await expect
      .poll(
        async () =>
          (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks.find(
            (t: any) => t.id === taskId,
          ).cells.title.value,
      )
      .toBe("PC 시각과 무관한 저장");
    await page.clock.setSystemTime(Date.now() + 30 * 86400_000);
    await cell.click({ button: "right" });
    await detail(page)
      .getByRole("textbox", { name: "작업 편집", exact: true })
      .fill("시각 변경 후 상세 저장");
    await detail(page)
      .getByRole("button", { name: "닫기", exact: true })
      .click();
    await expect(detail(page)).toHaveCount(0);
    expect(
      (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks.find(
        (t: any) => t.id === taskId,
      ).cells.title.value,
    ).toBe("시각 변경 후 상세 저장");
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const write of writes)
      expect(Math.abs(Date.parse(write.createdAt) - Date.now())).toBeLessThan(
        60_000,
      );
  });
}

test("프로필 아래 접속 토큰에서 무기한 생성·재조회·복사·삭제를 관리한다", async ({
  page,
}, info) => {
  await board(page);
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  const items = page
    .getByRole("menu", { name: "내 계정 메뉴" })
    .getByRole("menuitem");
  expect(
    (await items.allTextContents()).map((text) => text.trim()).slice(0, 2),
  ).toEqual(["프로필", "접속 토큰"]);
  await page.getByRole("menuitem", { name: "접속 토큰", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "접속 토큰", exact: true });
  await panel.getByLabel("토큰 이름", { exact: true }).fill("개인 일정 조회");
  await expect(panel.getByLabel("유효기간", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "토큰 생성", exact: true }).click();
  const secret = panel.getByLabel("개인 일정 조회 토큰", { exact: true });
  await expect(secret).toHaveValue(/^gbt_[a-f0-9]{64}$/);
  const token = await secret.inputValue();
  expect(
    await page.evaluate(
      (value) =>
        JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      token,
    ),
  ).toBe(false);
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("menuitem", { name: "접속 토큰", exact: true }).click();
  await expect(
    panel.getByRole("list", { name: "접속 토큰 목록" }),
  ).toContainText("개인 일정 조회");
  await expect(secret).toHaveCount(0);
  await panel
    .getByRole("button", { name: "개인 일정 조회 토큰 보기", exact: true })
    .click();
  await expect(secret).toHaveValue(token);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedToken = text;
        },
      },
    });
  });
  await panel
    .getByRole("button", { name: "개인 일정 조회 토큰 복사", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__copiedToken)).toBe(token);
  await panel
    .getByRole("button", { name: "개인 일정 조회 토큰 숨기기", exact: true })
    .click();
  await expect(secret).toHaveCount(0);
  expect((await request(page, "/access-tokens")).tokens[0]).not.toHaveProperty(
    "expiresAt",
  );
  await panel.screenshot({ path: info.outputPath("access-token-list.png") });
  await panel
    .getByRole("button", { name: "개인 일정 조회 토큰 삭제", exact: true })
    .click();
  await expect(panel.getByText("생성한 접속 토큰이 없습니다.")).toBeVisible();
  expect((await request(page, "/access-tokens")).tokens).toEqual([]);
});
