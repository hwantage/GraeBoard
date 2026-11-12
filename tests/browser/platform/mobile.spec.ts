import {
  test,
  expect,
  type Page,
  type Locator,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { addDays, calendarWeek } from "../../../shared/calendar/calendar.js";
import { todayKey } from "../../../shared/domain.js";

const mobile = { width: 390, height: 844 };
const desktop = { width: 1366, height: 900 };
test.use({ viewport: mobile, hasTouch: true });
// Do not use isMobile: Firefox does not implement that emulation option.
const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskId: string;
const year = Number(todayKey().slice(0, 4));
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
  return response.json().then(unpack);
}
const titleCell = (page: Page) => page.locator(`[data-cell="${taskId}:title"]`);
async function noKeyboard(page: Page) {
  await expect(page.locator(".inline-editor")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "업무 상세", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.matches(
            "input,textarea,select,[contenteditable=true]",
          ),
      ),
    )
    .toBe(false);
}
async function fits(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  const top = page.locator(".topbar");
  if (await top.count()) {
    expect(
      await top.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: `draft/mobile-screens/${info.project.name}-${name}.png`,
  });
}
async function pointer(
  cell: Locator,
  type: string,
  x: number,
  y: number,
  extra = {},
) {
  await cell.dispatchEvent(type, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    ...extra,
  });
}

test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `모바일 ${randomUUID().slice(0, 5)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId,
      year,
      fields: { title: "모바일에서 읽는 업무", owner: userId },
    })
  ).task.id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await expect(titleCell(page)).toBeVisible();
});

test("터치 탭만 선택하고 재탭으로 편집하며 이동·긴 누름·취소는 선택을 늘리지 않는다", async ({
  page,
}, info) => {
  const cell = titleCell(page);
  await cell.tap({ position: { x: 70, y: 12 } });
  await expect(cell).toHaveAttribute("aria-selected", "true");
  await noKeyboard(page);
  const selected = await page
    .locator('[role="gridcell"][aria-selected="true"]')
    .count();
  for (const end of ["pointerup", "pointercancel"]) {
    await pointer(cell, "pointerdown", 180, 300);
    await pointer(cell, "pointermove", 60, 250);
    await pointer(cell, end, 60, 250);
    await noKeyboard(page);
    expect(
      await page.locator('[role="gridcell"][aria-selected="true"]').count(),
    ).toBe(selected);
  }
  await pointer(cell, "pointerdown", 180, 300);
  await page.waitForTimeout(400); // A held finger is not a short tap.
  await pointer(cell, "pointerup", 180, 300);
  await noKeyboard(page);
  await page.evaluate(() => {
    window.addEventListener(
      "pointerup",
      () => {
        (window as any).focusedDuringPointerUp =
          document.activeElement?.matches(".inline-editor textarea");
      },
      { once: true },
    );
  });
  await cell.tap({ position: { x: 70, y: 12 } });
  expect(
    await page.evaluate(() => (window as any).focusedDuringPointerUp),
  ).toBe(true);
  const editor = page.locator(".inline-editor textarea");
  await expect(editor).toBeFocused();
  await editor.fill("터치로 수정한 업무");
  await editor.press("Enter");
  await noKeyboard(page);
  await expect(cell).toContainText("터치로 수정한 업무");
  await fits(page);
  await screenshot(page, info, "annual-sheet");
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).tap();
  await noKeyboard(page);
});

test("실제 손가락 스와이프는 휴대폰과 태블릿에서 가로·세로 스크롤만 한다", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "연속 native touchMove 전송은 Chromium CDP에서만 지원하며 다른 엔진은 포인터 경로와 실제 탭을 검증한다.",
  );
  for (let i = 0; i < 35; i++)
    await request(page, "/tasks", "POST", {
      teamId,
      year,
      fields: { title: `스크롤 업무 ${i}` },
    });
  await page.reload();
  const cdp = await context.newCDPSession(page);
  const grid = page.getByRole("grid", { name: "연간 업무 일정" });
  for (const viewport of [mobile, { width: 1024, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.keyboard.press("Escape");
    await grid.evaluate((el) => {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    });
    await titleCell(page).tap({ position: { x: 70, y: 12 } });
    await noKeyboard(page);
    for (const axis of ["horizontal", "vertical"]) {
      // Start inside the sheet even after a native fling has carried the
      // title cell past its left edge.
      const box = (await titleCell(page).boundingBox())!;
      const area = (await grid.boundingBox())!;
      const x = Math.min(viewport.width - 35, Math.max(box.x, area.x) + 220),
        y = box.y + 15;
      const start = await grid.evaluate((el) => ({
        x: el.scrollLeft,
        y: el.scrollTop,
      }));
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: x - (axis === "horizontal" ? i * 20 : 0),
              y: y + (axis === "vertical" ? -i * 12 : 0),
            },
          ],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await noKeyboard(page);
      await expect
        .poll(() =>
          grid.evaluate(
            (el, axis) =>
              axis === "horizontal" ? el.scrollLeft : el.scrollTop,
            axis,
          ),
        )
        .toBeGreaterThan(axis === "horizontal" ? start.x : start.y);
      // A swipe along one axis leaves the other where it was: scrolling down
      // after moving right must not pull the sheet back to the left edge.
      const settled = await grid.evaluate(
        (el) =>
          new Promise<{ x: number; y: number }>((resolve) => {
            let last = "",
              same = 0;
            const check = () => {
              const now = `${el.scrollLeft}:${el.scrollTop}`;
              same = now === last ? same + 1 : 0;
              last = now;
              if (same >= 10) resolve({ x: el.scrollLeft, y: el.scrollTop });
              else requestAnimationFrame(check);
            };
            check();
          }),
      );
      if (axis === "horizontal") expect(settled.y).toBe(start.y);
      else expect(settled.x).toBe(start.x);
      expect(
        await page.locator('[role="gridcell"][aria-selected="true"]').count(),
      ).toBe(1);
    }
  }
});

test("구성원은 한 줄 아바타로 압축되고 월간·주간 본문과 데스크톱 이름을 유지한다", async ({
  page,
}, info) => {
  for (let i = 0; i < 14; i++)
    await request(page, "/admin/users", "POST", {
      username: `mobile-${randomUUID()}@example.com`,
      password: "local-mobile-password",
      name: `모바일 구성원 ${i + 1}`,
      memberships: [{ teamId, role: "member" }],
    });
  await page.reload();
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  const owners = page.getByRole("group", { name: "캘린더 팀원" });
  await expect(owners.getByRole("button")).toHaveCount(15);
  expect((await owners.boundingBox())!.height).toBeLessThan(50);
  // 한 줄에 들어가지 않으면 날짜 선택 아래 줄에서 좌우로 넘겨 본다.
  expect((await owners.boundingBox())!.y).toBeGreaterThan(
    (await page.getByRole("group", { name: "캘린더 표시 기간" }).boundingBox())!
      .y,
  );
  expect(await owners.evaluate((el) => el.scrollWidth)).toBeGreaterThan(
    await owners.evaluate((el) => el.clientWidth),
  );
  const name = owners
    .locator(".calendar-owner-button > span:not(.avatar)")
    .first();
  await expect(name).toBeHidden();
  expect(
    (await page.locator(".calendar-scroll").boundingBox())!.y,
  ).toBeLessThanOrEqual(180);
  await owners
    .getByRole("button", { name: "모바일 구성원 14", exact: true })
    .tap();
  await expect(
    owners.getByRole("button", { name: "모바일 구성원 14", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".calendar-loading")).toHaveCount(0);
  await fits(page);
  await screenshot(page, info, "calendar-month");
  await page
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .tap();
  await expect(page.locator(".calendar-team-section")).toHaveCount(15);
  await expect(
    page
      .locator(".calendar-team-section")
      .first()
      .locator(".calendar-week-row"),
  ).toBeVisible();
  await fits(page);
  await screenshot(page, info, "calendar-week");
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).tap();
  await expect(
    page.locator(
      '.calendar-workspace[data-calendar-view="shared"] .calendar-grid',
    ),
  ).toBeVisible();
  await screenshot(page, info, "calendar-shared");
  await page.setViewportSize(desktop);
  await page
    .getByRole("button", { name: "개인 월간 보기", exact: true })
    .click();
  await expect(name).toBeVisible();
  await expect(page.locator(".calendar-view-options")).toBeVisible();
});

test("팀원이 적으면 날짜 선택과 아바타를 한 줄에 둔다", async ({
  page,
}, info) => {
  for (let i = 0; i < 4; i++)
    await request(page, "/admin/users", "POST", {
      username: `mobile-${randomUUID()}@example.com`,
      password: "local-mobile-password",
      name: `모바일 구성원 ${i + 1}`,
      memberships: [{ teamId, role: "member" }],
    });
  await page.reload();
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  const owners = page.getByRole("group", { name: "캘린더 팀원" });
  const period = page.getByRole("group", { name: "캘린더 표시 기간" });
  await expect(owners.getByRole("button")).toHaveCount(5);
  // 360px에서는 5명이 날짜 선택 옆에 들어가지 않아 다음 줄로 넘긴다.
  for (const width of [390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const date = (await period.boundingBox())!;
    const list = (await owners.boundingBox())!;
    expect(list.x).toBeGreaterThanOrEqual(date.x + date.width);
    expect(
      Math.abs(list.y + list.height / 2 - (date.y + date.height / 2)),
    ).toBeLessThan(4);
    expect(await owners.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      await owners.evaluate((el) => el.clientWidth),
    );
    await fits(page);
  }
  await screenshot(page, info, "calendar-month-one-line");
});

test("일정 추가 창은 제목·시크릿·태그·버튼 사이를 같은 간격으로 둔다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  for (const viewport of [mobile, desktop]) {
    await page.setViewportSize(viewport);
    await page
      .getByRole("button", { name: /일정 추가/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
    const parts = [
      dialog.locator(".calendar-field"),
      dialog.locator(".switch-field"),
      dialog.locator(".calendar-tag-picker"),
      ...(viewport === desktop ? [dialog.locator(".calendar-hint")] : []),
      dialog.getByRole("button", { name: "일정 만들기", exact: true }),
    ];
    const boxes = [];
    for (const part of parts) boxes.push((await part.boundingBox())!);
    const gaps = boxes
      .slice(1)
      .map((box, index) => box.y - (boxes[index].y + boxes[index].height));
    for (const gap of gaps) expect(Math.abs(gap - gaps[0])).toBeLessThan(1.5);
    expect(gaps[0]).toBeGreaterThan(8);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("아이폰에서만 입력칸 자동 확대를 막고 다른 브라우저의 손가락 확대는 그대로 둔다", async ({
  page,
}) => {
  const viewport = () =>
    page.locator('meta[name="viewport"]').getAttribute("content");
  expect(await viewport()).toBe("width=device-width, initial-scale=1.0");
  // Only iOS WebKit supports touch callouts; stand in for it here.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((property: string, value?: string) =>
      property === "-webkit-touch-callout" ||
      (value === undefined
        ? supports(property)
        : supports(property, value))) as typeof CSS.supports;
  });
  await page.reload();
  await expect(titleCell(page)).toBeVisible();
  expect(await viewport()).toBe(
    "width=device-width, initial-scale=1.0, maximum-scale=1",
  );
});

test("휴대폰에서는 문서가 있는 업무에만 문서 아이콘을 보이고 선택한 작업명 칸에서 문서를 연다", async ({
  page,
}) => {
  const other = (
    await request(page, "/tasks", "POST", {
      teamId,
      year,
      fields: { title: "문서 없는 업무", owner: userId },
    })
  ).task.id;
  await request(page, `/tasks/${taskId}/documents/main`, "PUT", {
    markdown: "# 문서 있는 업무",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.reload();
  const withDocument = titleCell(page).locator(".task-document-indicator");
  const emptyCell = page.locator(`[data-cell="${other}:title"]`);
  const empty = emptyCell.locator(".task-document-indicator");
  await expect(withDocument).toHaveCSS("opacity", "1");
  await expect(empty).toHaveCSS("opacity", "0");
  await expect(empty).toHaveCSS("pointer-events", "none");
  // 작업명 칸을 선택하면 흐린 아이콘으로 업무 상세를 열어 문서를 만들 수 있다.
  await emptyCell.tap({ position: { x: 40, y: 12 } });
  await expect(emptyCell).toHaveAttribute("aria-selected", "true");
  await expect(empty).not.toHaveCSS("opacity", "0");
  await empty.tap();
  await expect(
    page.getByRole("dialog", { name: "업무 상세", exact: true }),
  ).toBeVisible();
});

test("업무 문서는 모바일에서도 모드를 전환하고 화면 폭이 바뀌어도 선택을 보존한다", async ({
  page,
}, info) => {
  await request(page, `/tasks/${taskId}/documents/main`, "PUT", {
    markdown: "# 모바일 문서\n\n읽기 쉬운 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.reload();
  await titleCell(page).locator(".task-document-indicator").tap();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  const rich = detail.getByRole("textbox", { name: "업무 문서 리치 편집" });
  await expect(rich).toContainText("읽기 쉬운 본문");
  await expect(detail.locator(".document-rich-tools")).toBeHidden();
  await expect(
    detail.getByRole("button", { name: "Markdown 원문", exact: true }),
  ).toBeVisible();
  await fits(page);
  await screenshot(page, info, "task-document");
  await page.setViewportSize(desktop);
  await expect(detail.locator(".document-rich-tools")).toBeVisible();
  await detail
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = detail.getByRole("textbox", {
    name: "업무 문서 Markdown 원문",
  });
  await source.fill("# 원문에서 변경\n\n모바일에서도 같은 내용");
  await page.setViewportSize(mobile);
  await expect(source).toHaveValue("# 원문에서 변경\n\n모바일에서도 같은 내용");
  await detail.getByRole("button", { name: "리치 문서", exact: true }).tap();
  await expect(rich).toContainText("모바일에서도 같은 내용");
  await detail
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .tap();
  await expect(detail.locator(".document-rich-tools")).toBeHidden();
  await page.setViewportSize(desktop);
  await expect(source).toBeVisible();
  await expect(source).toHaveValue("# 원문에서 변경\n\n모바일에서도 같은 내용");
});

test("일정과 메모 전체 페이지에는 모드 전환 빈 줄이 남지 않는다", async ({
  page,
}, info) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "모바일 일정",
  });
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: "# 일정 본문\n\n휴대폰에서 읽습니다.",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.goto(`/links/calendar/${entry.id}`);
  const calendar = page.getByRole("dialog", {
    name: "캘린더 일정",
    exact: true,
  });
  await expect(
    calendar.getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  // The row holds the two mode buttons, download and contents.
  const calendarRow = calendar.locator(".document-mode-bar");
  await expect(calendarRow.getByRole("button")).toHaveCount(4);
  await expect(
    calendarRow.getByRole("button", { name: "다운로드", exact: true }),
  ).toBeVisible();
  await expect(
    calendarRow.getByRole("button", { name: "목차", exact: true }),
  ).toBeVisible();
  await expect(calendar.locator(".document-rich-tools")).toBeHidden();
  await screenshot(page, info, "calendar-entry");
  const memoId = randomUUID(),
    memos = `/teams/${teamId}/years/${year}/memos`;
  await request(page, memos, "POST", { id: memoId, title: "모바일 메모" });
  await request(page, `${memos}/${memoId}`, "PUT", {
    markdown: "# 메모 본문\n\n휴대폰에서 읽습니다.",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.goto(`/links/memo/${teamId}/${year}/${memoId}`);
  const memo = page.getByRole("dialog", { name: "모바일 메모", exact: true });
  await expect(memo.getByRole("textbox", { name: /리치 편집$/ })).toContainText(
    "메모 본문",
  );
  const memoRow = memo.locator(".document-mode-bar");
  await expect(memoRow.getByRole("button")).toHaveCount(4);
  await expect(
    memoRow.getByRole("button", { name: "다운로드", exact: true }),
  ).toBeVisible();
  await expect(
    memoRow.getByRole("button", { name: "목차", exact: true }),
  ).toBeVisible();
  await expect(memo.locator(".document-rich-tools")).toBeHidden();
  await screenshot(page, info, "memo-page");
  await page.setViewportSize(desktop);
  await expect(memo.locator(".document-rich-tools")).toBeVisible();
  await expect(
    memo
      .locator(".document-rich-tools")
      .getByRole("group", { name: "문서 편집 모드" }),
  ).toBeVisible();
});

test("로그인·상단 메뉴·설정은 휴대폰 너비 안에 보인다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).tap();
  await expect(
    page.getByRole("dialog", { name: "설정", exact: true }),
  ).toBeVisible();
  await fits(page);
  await screenshot(page, info, "settings");
  await page
    .getByRole("dialog", { name: "설정", exact: true })
    .getByRole("button", { name: "닫기", exact: true })
    .tap();
  for (const width of [360, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
  }
  await request(page, "/auth/logout", "POST", {});
  await page.goto("/");
  await page.setViewportSize(mobile);
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  await fits(page);
  await screenshot(page, info, "login");
});

test("데스크톱 마우스 선택·더블클릭과 서식 도구는 그대로 동작한다", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await expect(
    page.getByRole("combobox", { name: "글꼴", exact: true }),
  ).toBeVisible();
  await titleCell(page).click();
  await expect(page.locator(".cell-input-ready textarea")).toBeFocused();
  await expect(page.locator(".inline-editor")).toHaveCount(0);
  await titleCell(page).dblclick();
  await expect(page.locator(".inline-editor textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await titleCell(page).tap({ position: { x: 70, y: 12 } });
  await expect(page.locator(".inline-editor textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await noKeyboard(page);
});

test("휴대폰 툴바는 핵심 서식 도구를 보이고 더 보기로 전체 도구를 펼친다", async ({
  page,
}, info) => {
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const tool = (name: string) =>
    toolbar.getByRole("button", { name, exact: true });
  const core = [
    "업무 추가",
    "실행취소",
    "재실행",
    "굵게",
    "글자 색상",
    "배경색",
    "도구 더 보기",
  ];
  const extra = [
    toolbar.getByRole("combobox", { name: "글꼴", exact: true }),
    tool("기울임"),
    tool("왼쪽 정렬"),
    tool("테두리"),
    toolbar.getByRole("group", { name: "확대와 축소", exact: true }),
  ];
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of core) {
      await expect(tool(name)).toBeVisible();
      const box = (await tool(name).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    for (const item of extra) await expect(item).toBeHidden();
    await fits(page);
  }
  await tool("도구 더 보기").tap();
  await expect(tool("도구 접기")).toHaveAttribute("aria-expanded", "true");
  for (const item of extra) await expect(item).toBeVisible();
  for (const name of core.slice(0, -1)) await expect(tool(name)).toBeVisible();
  await expect(tool("서식 복사")).toBeHidden();
  expect(
    await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await fits(page);
  await screenshot(page, info, "toolbar-expanded");
  await tool("도구 접기").tap();
  for (const item of extra) await expect(item).toBeHidden();
  await screenshot(page, info, "toolbar");

  await titleCell(page).tap({ position: { x: 70, y: 12 } });
  await tool("굵게").tap();
  await expect
    .poll(async () => {
      const { tasks } = await request(
        page,
        `/tasks?teamId=${teamId}&year=${year}`,
      );
      return tasks.find((task: any) => task.id === taskId).cells.title?.style
        ?.bold;
    })
    .toBe(true);
  await noKeyboard(page);

  await page.setViewportSize(desktop);
  await expect(tool("도구 더 보기")).toBeHidden();
  for (const item of extra) await expect(item).toBeVisible();
});

test("업무 색이 많아도 휴대폰 툴바의 핵심 도구는 앞에 남고 업무 버튼은 넘겨서 모두 누를 수 있다", async ({
  page,
}) => {
  const team = (await request(page, "/bootstrap")).teams.find(
    (item: any) => item.id === teamId,
  );
  await request(page, `/teams/${teamId}/settings`, "PATCH", {
    revision: team.settings.revision || 0,
    insights: {
      workColors: Array.from({ length: 12 }, (_, index) => ({
        color: `#${(0x205080 + index * 0x0a0a00).toString(16)}`,
        name: `업무 ${index + 1}`,
      })),
      charts: [],
    },
  });
  await page.reload();
  await page.setViewportSize({ width: 360, height: 844 });
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const tool = (name: string) =>
    toolbar.getByRole("button", { name, exact: true });
  const more = tool("도구 더 보기");
  await expect(tool("업무 표시: 업무 12")).toBeAttached();
  // 업무 버튼이 늘어나도 앞쪽 핵심 도구와 더 보기 버튼은 화면 안에 있다.
  for (const name of ["실행취소", "재실행", "굵게", "글자 색상", "배경색"]) {
    const box = (await tool(name).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  const moreBox = (await more.boundingBox())!;
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(360);
  expect(await toolbar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  // 마지막 업무 버튼까지 넘겨 볼 수 있고 더 보기 버튼에 가리지 않는다.
  const last = tool("업무 표시: 업무 12");
  await last.evaluate((el) =>
    el.scrollIntoView({ block: "nearest", inline: "nearest" }),
  );
  const lastBox = (await last.boundingBox())!;
  const stuck = (await more.boundingBox())!;
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(stuck.x + 1);
  await more.tap();
  expect(
    await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expect(last).toBeInViewport();
  await fits(page);
});

test("캘린더 카드 위 손가락 이동도 일정을 바꾸지 않고 스크롤한다", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "연속 native touchMove는 Chromium CDP에서만 전송할 수 있다.",
  );
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "스와이프로 이동하지 않을 일정",
  });
  for (let i = 0; i < 30; i++)
    await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: todayKey(),
      title: `아래로 이어지는 일정 ${i}`,
    });
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  const card = page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport();
  const scroll = page.locator(".calendar-scroll");
  const before = await scroll.evaluate((el) => el.scrollTop);
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - i * 12 }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before);
  await expect(page.locator(".calendar-entry-modal")).toHaveCount(0);
  await expect(scroll).not.toHaveAttribute("data-dragging");
  expect((await request(page, `/calendar/entries/${entry.id}`)).date).toBe(
    todayKey(),
  );
});

async function hold(target: Locator) {
  const box = (await target.boundingBox())!;
  const x = Math.max(3, box.x + Math.min(box.width / 2, 70)),
    y = box.y + box.height / 2;
  await pointer(target, "pointerdown", x, y);
  await target.page().waitForTimeout(550);
  return { x, y };
}

test("셀·행·열 길게 누르기는 기존 메뉴를 열고 손을 떼어도 편집하지 않는다", async ({
  page,
}) => {
  for (const target of [
    titleCell(page),
    page.getByRole("button", { name: "1행 전체 선택", exact: true }),
    page.locator('[data-header-key="title"]'),
  ]) {
    const point = await hold(target);
    const menu = page.locator(".grid-header-menu");
    await expect(menu).toBeVisible();
    await noKeyboard(page);
    await pointer(target, "pointerup", point.x, point.y);
    await target.dispatchEvent("click", { detail: 1 });
    await expect(menu).toBeVisible();
    await noKeyboard(page);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  // Reuse the real row copy/paste path, including the clipboard kept by the app.
  let point = await hold(titleCell(page));
  await pointer(titleCell(page), "pointerup", point.x, point.y);
  await page.getByRole("menuitem", { name: "복사", exact: true }).tap();
  point = await hold(titleCell(page));
  await pointer(titleCell(page), "pointerup", point.x, point.y);
  await expect(
    page.getByRole("menuitem", { name: "복사한 행 붙여넣기", exact: true }),
  ).toBeEnabled();
  await noKeyboard(page);
});

test("행 번호·열 머리글은 탭으로 선택하고 다시 탭하면 메뉴를 열며 손을 뗀 클릭은 항목을 실행하지 않는다", async ({
  page,
}) => {
  const menu = page.locator(".grid-header-menu");
  const count = async () =>
    (await request(page, `/tasks?teamId=${teamId}&year=${year}`)).tasks.length;
  const tasks = await count();
  const rowButton = page.getByRole("button", {
    name: "1행 전체 선택",
    exact: true,
  });
  const column = page.locator('[data-header-key="title"]');
  for (const [target, selected, title] of [
    [rowButton, page.getByRole("rowheader").first(), "선택한 행 메뉴"],
    [column, column, /열 메뉴$/],
  ] as const) {
    await target.tap();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(menu).toHaveCount(0);
    await noKeyboard(page);
    await target.tap();
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-label", title);
    await noKeyboard(page);
    // 메뉴를 연 손가락 아래 항목에 눌림 없이 도착한 클릭은 무시한다.
    await menu.getByRole("menuitem").first().dispatchEvent("click", {
      detail: 1,
    });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  expect(await count()).toBe(tasks);
  // 메뉴 안에서 직접 누른 항목은 그대로 실행한다.
  await rowButton.tap();
  await rowButton.tap();
  await page.getByRole("menuitem", { name: "아래에 삽입", exact: true }).tap();
  await expect.poll(count).toBe(tasks + 1);
});

test("시트 길게 누르기는 이동·스크롤·취소·다른 손가락에서 취소된다", async ({
  page,
}) => {
  const cell = titleCell(page);
  const grid = page.getByRole("grid", { name: "연간 업무 일정" });
  for (const cancel of ["move", "scroll", "cancel", "second"]) {
    await pointer(cell, "pointerdown", 180, 300);
    if (cancel === "move") await pointer(cell, "pointermove", 170, 300);
    if (cancel === "scroll")
      await grid.evaluate((el) => {
        el.scrollLeft += 30;
      });
    if (cancel === "cancel") await pointer(cell, "pointercancel", 180, 300);
    if (cancel === "second")
      await pointer(page.locator(".topbar"), "pointerdown", 200, 30, {
        pointerId: 2,
        isPrimary: false,
      });
    await page.waitForTimeout(550);
    await pointer(cell, "pointerup", 180, 300);
    await expect(page.locator(".grid-header-menu")).toHaveCount(0);
    await noKeyboard(page);
  }
});

test("캘린더의 모든 요일과 작은 머리줄은 360·390·430px 안에 들어간다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await request(page, "/admin/users", "POST", {
    username: `mobile-dense-${randomUUID()}@example.com`,
    password: "local-mobile-password",
    name: "긴 이름의 구성원",
    memberships: [{ teamId, role: "member" }],
  });
  const ids = new Map<string | null, string>();
  for (const owner of [userId, null]) {
    const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
      id: randomUUID(),
      userId: owner,
      name: "검토 완료 확인",
      kind: "check",
      color: "blue",
    });
    const multi = await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId: owner,
      date: calendarWeek(todayKey()),
      endDate: addDays(calendarWeek(todayKey()), 6),
      title: "여러 날짜에 걸친 아주 긴 제목의 고객 검토 일정",
      tagIds: [tag.id],
    });
    ids.set(owner, multi.id);
    for (let i = 0; i < 5; i++)
      await request(page, "/calendar/entries", "POST", {
        id: randomUUID(),
        teamId,
        userId: owner,
        date: todayKey(),
        title: `일정 ${i + 1} 길게 이어지는 제목`,
        tagIds: [tag.id],
      });
  }
  await page.reload();
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  for (const [view, name, owner] of [
    ["month", "개인 월간 보기", userId],
    ["shared", "팀 월간 보기", null],
    ["week", "팀 주간 일정 보기", userId],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).tap();
    const card = page
      .locator(`[data-entry-id="${ids.get(owner)}"] .calendar-entry-card`)
      .first();
    await expect(card).toBeVisible();
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const scroll = page.locator(".calendar-scroll");
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      });
      await fits(page);
      expect((await scroll.boundingBox())!.y).toBeLessThanOrEqual(180);
      const overflow = await scroll.evaluate((el) => {
        const right = el.getBoundingClientRect().right;
        return [...el.querySelectorAll("*")]
          .filter((node) => node.getBoundingClientRect().right > right + 1)
          .map((node) => ({
            class: node.className,
            text: node.textContent?.slice(0, 30),
            right: node.getBoundingClientRect().right,
          }));
      });
      expect(
        await scroll.evaluate((el) => el.scrollWidth - el.clientWidth),
        JSON.stringify(overflow),
      ).toBeLessThanOrEqual(1);
      const rows = page.locator(".calendar-week-row");
      for (const row of await rows.all()) {
        const days = row.locator(".calendar-day");
        await expect(days).toHaveCount(7);
        const last = (await days.last().boundingBox())!;
        expect(last.x + last.width).toBeLessThanOrEqual(width);
        await expect(row.locator(".calendar-week-tasks")).toBeHidden();
      }
      if (view === "week") {
        for (const heading of await page
          .locator(".calendar-team-heading")
          .all())
          expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(56);
      }
      await screenshot(page, info, `calendar-${view}-${width}`);
    }
    await card.tap();
    await expect(
      page.getByRole("dialog", { name: "캘린더 일정", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize(desktop);
  await expect(page.locator(".calendar-week-tasks").first()).toBeVisible();
  await expect(page.locator(".calendar-entry-tags").first()).toBeVisible();
  await expect(page.locator(".calendar-member-year").first()).toBeVisible();
});

test("일정 길게 누르기로 복제·태그·삭제 메뉴를 열고 탭은 상세를 연다", async ({
  page,
}) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "길게 눌러 메뉴",
  });
  for (let i = 0; i < 28; i++)
    await request(page, "/calendar/entries", "POST", {
      id: randomUUID(),
      teamId,
      userId,
      date: todayKey(),
      title: `스크롤 여유 ${i}`,
    });
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  const card = page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first();
  await card.scrollIntoViewIfNeeded();
  for (const cancel of ["move", "scroll", "cancel", "second"]) {
    const box = (await card.boundingBox())!;
    await pointer(card, "pointerdown", box.x + 5, box.y + 5);
    if (cancel === "move")
      await pointer(card, "pointermove", box.x + 15, box.y + 5);
    if (cancel === "scroll")
      await page.locator(".calendar-scroll").evaluate((el) => {
        el.scrollTop += 10;
      });
    if (cancel === "cancel")
      await pointer(card, "pointercancel", box.x + 5, box.y + 5);
    if (cancel === "second")
      await pointer(page.locator(".topbar"), "pointerdown", 30, 30, {
        pointerId: 2,
        isPrimary: false,
      });
    await page.waitForTimeout(550);
    await pointer(card, "pointerup", box.x + 5, box.y + 5);
    await expect(page.locator(".grid-header-menu")).toHaveCount(0);
  }
  const point = await hold(card);
  for (const name of ["일정 복제", "태그 설정", "일정 삭제"])
    await expect(
      page.getByRole("menuitem", { name, exact: true }),
    ).toBeVisible();
  await pointer(card, "pointerup", point.x, point.y);
  await card.dispatchEvent("click", { detail: 1 });
  await expect(page.locator(".calendar-entry-modal")).toHaveCount(0);
  await noKeyboard(page);
  // 메뉴 안을 누른 뒤 같은 일정을 다시 길게 눌러 열어도, 손을 뗀 클릭은
  // 손가락 아래 항목을 실행하지 않는다.
  const menu = page.locator(".grid-header-menu");
  const inside = (await menu.boundingBox())!;
  await pointer(menu, "pointerdown", inside.x + 2, inside.y + 2);
  await pointer(menu, "pointerup", inside.x + 2, inside.y + 2);
  const again = await hold(card);
  await expect(menu).toBeVisible();
  await pointer(card, "pointerup", again.x, again.y);
  await page
    .getByRole("menuitem", { name: "일정 복제", exact: true })
    .dispatchEvent("click", { detail: 1 });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator(`[data-entry-id] .calendar-entry-card`),
  ).toHaveCount(29);
  await card.tap();
  await expect(
    page.getByRole("dialog", { name: "캘린더 일정", exact: true }),
  ).toBeVisible();
});

test("실제 터치 길게 누르기도 시트와 일정 메뉴를 열고 상세 클릭을 남기지 않는다", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "native touchStart를 누른 상태로 유지하는 제어는 Chromium CDP에서만 지원한다.",
  );
  const cdp = await context.newCDPSession(page);
  const press = async (target: Locator) => {
    const box = (await target.boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 },
      ],
    });
    await expect(page.locator(".grid-header-menu")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.locator(".grid-header-menu")).toBeVisible();
    await noKeyboard(page);
    await page.keyboard.press("Escape");
  };
  await press(titleCell(page));
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "실제 터치 메뉴",
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  const card = page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first();
  await card.scrollIntoViewIfNeeded();
  await press(card);
  await expect(page.locator(".calendar-entry-modal")).toHaveCount(0);
});

const widthPreference = "weekly-plan:document-full-width";
async function fullDocument(page: Page, panel: Locator) {
  await expect(panel).toHaveClass(/(?:document|memo)-full-page/);
  await expect(panel).toHaveClass(/document-full-width/);
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.y).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(page.viewportSize()!.width, 0);
  expect(box.height).toBeCloseTo(page.viewportSize()!.height, 0);
  await expect(
    panel.locator(
      ".document-expand:visible, button.document-full-width:visible",
    ),
  ).toHaveCount(0);
  expect(
    await panel.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expect(
    panel.getByRole("button", { name: "닫기", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), widthPreference),
  ).toBe("0");
}

test("연간 시트 검색과 저장된 필터는 펼친 검색에서도 같은 한 줄에 들어간다", async ({
  page,
}, info) => {
  const search = page.locator(".date-search-controls > .search-box");
  const filters = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const value of ["", "모바일"]) {
      await page
        .getByRole("textbox", { name: "전체 속성 검색", exact: true })
        .fill(value);
      const left = (await search.boundingBox())!,
        right = (await page.locator(".saved-filter-control").boundingBox())!;
      expect(left.y).toBeCloseTo(right.y, 0);
      expect(left.x + left.width).toBeLessThanOrEqual(right.x);
      expect(right.x + right.width).toBeLessThanOrEqual(width);
      expect(
        await search.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        (await search.locator("input").boundingBox())!.width,
      ).toBeGreaterThan(70);
      await expect(
        search.getByRole("button", { name: "이전 검색 결과" }),
      ).toBeVisible();
      await expect(
        search.getByRole("button", { name: "다음 검색 결과" }),
      ).toBeVisible();
      await expect(
        search.getByRole("button", { name: "검색 지우기" }),
      ).toBeVisible();
      await fits(page);
    }
    await screenshot(page, info, `annual-search-${width}`);
  }
  await filters.tap();
  await expect(page.locator(".saved-views")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize(desktop);
  await expect(filters.locator("span")).toBeVisible();
});

test("업무와 일정 문서는 처음부터 전체 화면이며 너비 설정과 데스크톱 선택을 보존한다", async ({
  page,
}, info) => {
  await page.evaluate((key) => localStorage.setItem(key, "0"), widthPreference);
  await request(page, `/tasks/${taskId}/documents/main`, "PUT", {
    markdown: "# 전체 화면 업무\n\n모바일 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.reload();
  await titleCell(page).locator(".task-document-indicator").tap();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await expect(
    detail.getByRole("textbox", { name: "업무 문서 리치 편집" }),
  ).toContainText("모바일 본문");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fullDocument(page, detail);
    await expect(detail.locator(".document-tabs")).toBeVisible();
    await screenshot(page, info, `task-full-${width}`);
  }
  await page.setViewportSize(desktop);
  await expect(detail).not.toHaveClass(/document-full-page/);
  await detail
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await expect(
    detail.getByRole("button", { name: "전체 너비로 보기", exact: true }),
  ).toBeVisible();
  await page.setViewportSize(mobile);
  await fullDocument(page, detail);
  await page.setViewportSize(desktop);
  await expect(detail).toHaveClass(/document-full-page/);
  await expect(detail).not.toHaveClass(/document-full-width/);
  await detail
    .getByRole("button", { name: "전체 너비로 보기", exact: true })
    .click();
  await page.setViewportSize(mobile);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), widthPreference),
  ).toBe("1");
  await page.setViewportSize(desktop);
  await expect(
    detail.getByRole("button", { name: "기본 너비로 보기", exact: true }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "기본 너비로 보기", exact: true })
    .click();
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "전체 화면 일정",
  });
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: "# 일정 전체 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.setViewportSize(mobile);
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first()
    .tap();
  const calendar = page.getByRole("dialog", {
    name: "캘린더 일정",
    exact: true,
  });
  await expect(
    calendar.getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toContainText("일정 전체 본문");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fullDocument(page, calendar);
    await expect(
      calendar.getByLabel("일정 시작일", { exact: true }),
    ).toBeInViewport();
    await screenshot(page, info, `calendar-full-${width}`);
  }
  await page.setViewportSize(desktop);
  await expect(calendar).not.toHaveClass(/document-full-page/);
  await expect(
    calendar.getByRole("button", {
      name: "문서 전체 페이지로 보기",
      exact: true,
    }),
  ).toBeVisible();
});

test("일정 상세의 긴 제목은 앞부터 보이고 시작일·종료일 칸은 겹치지 않는다", async ({
  page,
}, info) => {
  const title = "[EndPoint][내부] 분석 시간 초과 DLPCenter 사용성 개선 요청";
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    endDate: addDays(todayKey(), 3),
    title,
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
      .first()
      .tap();
    const calendar = page.getByRole("dialog", {
      name: "캘린더 일정",
      exact: true,
    });
    const input = calendar.getByRole("textbox", {
      name: "일정 제목",
      exact: true,
    });
    await expect(input).toHaveValue(title);
    await expect(input).not.toBeFocused();
    expect(await input.evaluate((el) => el.scrollLeft)).toBe(0);
    const boxes = [];
    for (const name of ["일정 시작일", "일정 종료일"]) {
      const field = calendar.getByLabel(name, { exact: true });
      const box = (await field.boundingBox())!;
      const label = (await field.locator("xpath=..").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.x + box.width).toBeLessThanOrEqual(label.x + label.width + 1);
      boxes.push(box);
    }
    expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
    await screenshot(page, info, `calendar-entry-title-${width}`);
    await calendar.getByRole("button", { name: "닫기", exact: true }).tap();
    await expect(calendar).toHaveCount(0);
  }
});

test("꼬리 메모와 링크 문서는 전체 화면으로 읽고 메모 탭·입력·저장 실패를 보존한다", async ({
  page,
}, info) => {
  await page.evaluate((key) => localStorage.setItem(key, "0"), widthPreference);
  const memos = `/teams/${teamId}/years/${year}/memos`;
  const ids = [randomUUID(), randomUUID()];
  for (const [i, id] of ids.entries()) {
    await request(page, memos, "POST", { id, title: `전체 메모 ${i + 1}` });
    await request(page, `${memos}/${id}`, "PUT", {
      markdown: `# 메모 ${i + 1} 본문`,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  }
  await page.reload();
  await page.getByRole("button", { name: "꼬리 메모", exact: true }).tap();
  const panel = page.getByRole("dialog", {
    name: "연간 업무 메모 목록",
    exact: true,
  });
  await expect(
    panel.getByRole("tab", { name: "전체 메모 2", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "전체 메모 2", exact: true }).tap();
  const rich = page.locator(
    '.memo-panel .memo-document-card[data-selected] [contenteditable="true"]',
  );
  await expect(rich).toContainText("메모 2 본문");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fullDocument(page, panel);
    await expect(panel.locator(".memo-document-card:visible")).toHaveCount(1);
    await screenshot(page, info, `memo-full-${width}`);
  }
  await rich.fill("화면 전환 중인 메모 내용");
  await page.setViewportSize(desktop);
  const desktopPanel = page.getByRole("region", {
    name: "연간 업무 메모 목록",
    exact: true,
  });
  await expect(desktopPanel).not.toHaveClass(/document-full-page/);
  await expect(desktopPanel.locator(".document-expand").first()).toBeVisible();
  await expect(rich).toHaveText("화면 전환 중인 메모 내용");
  await titleCell(page).click();
  await titleCell(page).locator(".task-document-indicator").click();
  const above = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await expect(above).toBeVisible();
  await page.setViewportSize(mobile);
  await fullDocument(page, above);
  await above.getByRole("button", { name: "닫기", exact: true }).tap();
  await expect(above).toHaveCount(0);
  await fullDocument(page, panel);
  await expect(rich).toHaveText("화면 전환 중인 메모 내용");
  const routePath = `**/api${memos}/${ids[1]}`;
  await page.route(routePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "모바일 메모 저장 실패" }),
        })
      : route.continue(),
  );
  await rich.fill("저장 실패해도 남는 메모");
  await panel.getByRole("button", { name: "닫기", exact: true }).tap();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".document-error")).toBeVisible();
  await expect(rich).toHaveText("저장 실패해도 남는 메모");
  await page.unroute(routePath);
  await panel
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .tap();
  await expect(panel.locator(".document-error")).toHaveCount(0);
  await panel.getByRole("button", { name: "닫기", exact: true }).tap();
  await expect(panel).toHaveCount(0);
  for (const [path, title, className] of [
    [`/links/memo/${teamId}/${year}/${ids[0]}`, "전체 메모 1", "memo-link"],
    [`/links/task/${taskId}`, "업무 상세", "task-link"],
  ]) {
    await page.goto(path);
    const linked = page.getByRole("dialog", { name: title, exact: true });
    await fullDocument(page, linked);
    await screenshot(page, info, className);
    await linked.getByRole("button", { name: "닫기", exact: true }).tap();
    await expect(linked).toHaveCount(0);
  }
});

test("모바일 캘린더 설정 메뉴는 기존 세 대화상자와 표시 요일 변경을 연결한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "캘린더", exact: true }).tap();
  await page.getByRole("button", { name: "개인 월간 보기", exact: true }).tap();
  const settings = page.getByRole("button", {
    name: "캘린더 설정",
    exact: true,
  });
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const tabs = (await page.locator(".calendar-view-switch").boundingBox())!,
      icon = (await settings.boundingBox())!;
    expect(tabs.y).toBeCloseTo(icon.y, 0);
    expect(tabs.x + tabs.width).toBeLessThanOrEqual(icon.x);
    expect(icon.x + icon.width).toBeLessThanOrEqual(width);
    for (const [item, title] of [
      ["주간 할 일 기준", "주간 할 일 기준"],
      ["개인 태그 관리", "개인 태그 관리"],
      ["표시 요일", "내 캘린더 표시 요일"],
    ]) {
      await settings.tap();
      await expect(
        page
          .getByRole("menu", { name: "캘린더 설정", exact: true })
          .getByRole("menuitem"),
      ).toHaveCount(3);
      await page.getByRole("menuitem", { name: item, exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(
        await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await screenshot(page, info, `calendar-settings-${item}-${width}`);
      await dialog.getByRole("button", { name: "닫기", exact: true }).tap();
    }
  }
  await settings.tap();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "캘린더 설정" })).toHaveCount(0);
  await settings.tap();
  await page.locator(".calendar-date time").first().tap();
  await expect(page.getByRole("menu", { name: "캘린더 설정" })).toHaveCount(0);
  await settings.tap();
  await page.getByRole("menuitem", { name: "표시 요일", exact: true }).tap();
  const weekdays = page.getByRole("dialog", {
    name: "내 캘린더 표시 요일",
    exact: true,
  });
  await weekdays.getByRole("button", { name: "월~금", exact: true }).tap();
  await weekdays
    .getByRole("button", { name: "요일 설정 저장", exact: true })
    .tap();
  await expect(weekdays).toHaveCount(0);
  for (const view of ["개인 월간 보기", "팀 월간 보기", "팀 주간 일정 보기"]) {
    await page.getByRole("button", { name: view, exact: true }).tap();
    const row = page.locator(".calendar-week-row").first(),
      days = row.locator(".calendar-day");
    await expect(days).toHaveCount(5);
    const first = (await days.first().boundingBox())!,
      last = (await days.last().boundingBox())!;
    expect(last.x + last.width - first.x).toBeCloseTo(
      (await row.boundingBox())!.width,
      0,
    );
    expect(
      await page
        .locator(".calendar-scroll")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize(desktop);
  await expect(settings).toBeHidden();
  await expect(page.locator(".calendar-view-options")).toBeVisible();
});
