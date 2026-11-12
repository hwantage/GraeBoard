import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { todayKey } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskId: string;
// Recent picks are kept per user.
const recentKey = () => `weekly-plan:recent-emojis:${userId}`;
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
const details = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const calendarDetail = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "이모지 복사", exact: true });
const emojiButton = (dialog: Locator) =>
  dialog
    .locator(":scope > header")
    .getByRole("button", { name: "이모지 복사", exact: true });
const notice = (page: Page) =>
  page.locator(".toast").filter({ hasText: "이모지를 복사했습니다." });
async function openTask(page: Page) {
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  await expect(details(page)).toBeVisible();
  return details(page);
}
// Chromium reads the real clipboard. Firefox and WebKit grant no clipboard
// permission to Playwright, so their asynchronous clipboard is observed.
async function watchClipboard(page: Page, browserName: string) {
  if (browserName === "chromium") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    return () => page.evaluate(() => navigator.clipboard.readText());
  }
  await page.evaluate(() => {
    (window as any).__copied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).__copied = await (
            await items[0].getType("text/plain")
          ).text();
        },
      },
    });
  });
  return () => page.evaluate(() => (window as any).__copied as string);
}
// The emoji button is the header button right before the close button.
async function besideClose(dialog: Locator) {
  const buttons = dialog.locator(":scope > header > button");
  await expect(buttons.last()).toHaveAccessibleName("닫기");
  await expect(buttons.nth(-2)).toHaveAccessibleName("이모지 복사");
  const [emoji, close] = await Promise.all(
    [buttons.nth(-2), buttons.last()].map((button) => button.boundingBox()),
  );
  expect(emoji!.x + emoji!.width).toBeLessThanOrEqual(close!.x);
  expect(close!.x - (emoji!.x + emoji!.width)).toBeLessThan(16);
  expect(Math.abs(emoji!.y - close!.y)).toBeLessThan(2);
  const box = (await dialog.boundingBox())!;
  expect(close!.x + close!.width).toBeLessThanOrEqual(box.x + box.width);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `이모지 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: "이모지 업무" },
    })
  ).task.id;
  await page.goto("/");
  await page.evaluate((key) => localStorage.removeItem(key), recentKey());
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});

test("업무 상세의 이모지 복사는 닫기 바로 왼쪽에서 이름으로 찾아 복사하고 최근 사용에 남긴다", async ({
  page,
  browserName,
}, info) => {
  const dialog = await openTask(page);
  await besideClose(dialog);
  // The task actions and copy-link buttons keep their places.
  await expect(dialog.locator(".modal-heading > button")).toHaveCount(2);
  await expect(
    dialog.getByRole("group", { name: "업무 동작", exact: true }),
  ).toBeVisible();
  const clipboard = await watchClipboard(page, browserName);

  await emojiButton(dialog).click();
  await expect(picker(page)).toBeVisible();
  await expect(emojiButton(dialog)).toHaveAttribute("aria-expanded", "true");
  // The grid hangs from the button inside the detail, not inside its header.
  await expect(dialog.locator("header .emoji-popover")).toHaveCount(0);
  const search = picker(page).getByRole("textbox", { name: "이모지 검색" });
  await expect(search).toBeFocused();
  await expect(
    picker(page).getByRole("region", { name: "최근 사용" }),
  ).toHaveCount(0);
  await expect(
    picker(page).getByRole("region", { name: "표정", exact: true }),
  ).toBeVisible();
  // The emoji are one tab stop, not one per emoji.
  const tabStops = picker(page).locator('.emoji-option[tabindex="0"]');
  await expect(tabStops).toHaveCount(1);
  await expect(tabStops).toHaveAccessibleName("활짝 웃는 얼굴");
  await expect(picker(page).locator(".emoji-option")).toHaveCount(382);
  const [grid, trigger] = await Promise.all([
    picker(page).boundingBox(),
    emojiButton(dialog).boundingBox(),
  ]);
  expect(grid!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
  expect(
    Math.abs(grid!.x + grid!.width - (trigger!.x + trigger!.width)),
  ).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("task-emoji-picker.png") });

  await search.fill("하트");
  const results = picker(page).getByRole("region", { name: "검색 결과" });
  await expect(results.getByRole("button").first()).toHaveAccessibleName(
    "빨간 하트",
  );
  await expect(
    results.getByRole("button", { name: "주황 하트", exact: true }),
  ).toBeVisible();
  await expect(
    results.getByRole("button", { name: "강아지", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("task-emoji-search.png") });
  await search.press("Enter");
  await expect(notice(page)).toHaveText("❤️ 이모지를 복사했습니다.");
  expect(await clipboard()).toBe("❤️");
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(emojiButton(dialog)).toBeFocused();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      recentKey(),
    ),
  ).toEqual(["❤️"]);

  // A word that matches nothing says so.
  await emojiButton(dialog).click();
  await search.fill("없는이모지");
  await expect(picker(page)).toContainText("찾는 이모지가 없습니다.");
  await search.fill("");
  // The recent row comes first, and the categories move the list.
  const recent = picker(page).getByRole("region", { name: "최근 사용" });
  await expect(recent.getByRole("button")).toHaveCount(1);
  await expect(recent.getByRole("button")).toHaveAccessibleName("빨간 하트");
  const categories = picker(page).getByRole("group", { name: "이모지 분류" });
  await expect(
    categories.getByRole("button", { name: "최근 사용", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await categories.getByRole("button", { name: "음식", exact: true }).click();
  await expect(
    categories.getByRole("button", { name: "음식", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  // ↓ from the search goes into the chosen category.
  await search.press("ArrowDown");
  await expect(
    picker(page).getByRole("button", { name: "사과", exact: true }),
  ).toBeFocused();
  await expect(
    picker(page).getByRole("button", { name: "커피", exact: true }),
  ).toBeInViewport();
  await picker(page).getByRole("button", { name: "커피", exact: true }).click();
  await expect(notice(page)).toHaveText("☕ 이모지를 복사했습니다.");
  expect(await clipboard()).toBe("☕");
  await emojiButton(dialog).click();
  await expect(recent.getByRole("button")).toHaveText(["☕", "❤️"]);
  await page.screenshot({ path: info.outputPath("task-emoji-recent.png") });
  // Esc closes the grid only and returns to its button.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(emojiButton(dialog)).toBeFocused();
  // A click outside closes the grid only.
  await emojiButton(dialog).click();
  await expect(picker(page)).toBeVisible();
  await dialog
    .locator(".task-detail-heading")
    .click({ position: { x: 4, y: 4 } });
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Full page keeps the button beside the close button.
  await dialog.locator(".document-expand").click();
  await expect(dialog).toHaveClass(/document-full-page/);
  await besideClose(dialog);
  await emojiButton(dialog).click();
  await expect(picker(page)).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toHaveClass(/document-full-page/);
  // So does the small screen, where the detail opens as a full page.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await besideClose(dialog);
    await emojiButton(dialog).click();
    await expect(picker(page)).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`task-emoji-mobile-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
  }
});

test("일정 상세의 이모지 복사도 닫기 바로 왼쪽에 있고 방향키로 고른 이모지를 복사한 뒤 제목으로 돌아간다", async ({
  page,
  browserName,
}, info) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "이모지 일정",
    date: todayKey(),
    endDate: todayKey(),
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first()
    .click();
  const dialog = calendarDetail(page);
  const title = dialog.getByRole("textbox", { name: "일정 제목", exact: true });
  await expect(title).toHaveValue("이모지 일정");
  await besideClose(dialog);
  await expect(dialog.locator(".modal-heading > button")).toHaveCount(2);
  const clipboard = await watchClipboard(page, browserName);

  await title.click();
  await title.press("End");
  await emojiButton(dialog).click();
  await expect(picker(page)).toBeVisible();
  await expect(dialog.locator("header input")).toHaveCount(1);
  const search = picker(page).getByRole("textbox", { name: "이모지 검색" });
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  const smileys = picker(page)
    .getByRole("region", { name: "표정", exact: true })
    .getByRole("button");
  await expect(smileys.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(smileys.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(smileys.nth(9)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(smileys.nth(8)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(smileys.nth(0)).toBeFocused();
  // The focused emoji keeps the single tab stop.
  await expect(smileys.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(picker(page).locator('.emoji-option[tabindex="0"]')).toHaveCount(
    1,
  );
  // Moving through rows that scroll never hides the emoji under the sticky
  // category heading.
  const belowHeading = () =>
    page.evaluate(() => {
      const focused = document.activeElement as HTMLElement;
      const heading = focused.closest("section")!.querySelector("h3")!;
      return (
        focused.getBoundingClientRect().top -
        heading.getBoundingClientRect().bottom
      );
    });
  for (const key of [
    ...Array(8).fill("ArrowDown"),
    ...Array(8).fill("ArrowUp"),
  ]) {
    await page.keyboard.press(key);
    expect(await belowHeading()).toBeGreaterThanOrEqual(-0.5);
  }
  await expect(smileys.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.screenshot({ path: info.outputPath("calendar-emoji-picker.png") });
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("😃 이모지를 복사했습니다.");
  expect(await clipboard()).toBe("😃");
  await expect(picker(page)).toHaveCount(0);
  // The pick returns to the title being edited, ready to paste.
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("이모지 일정");

  // The dark calendar paints the grid in its own colors.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    page.locator('.workspace[data-screen="calendar"]'),
  ).toHaveAttribute("data-calendar-theme", "dark");
  // Esc in the grid leaves the entry open.
  await emojiButton(dialog).click();
  await expect(picker(page)).not.toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({ path: info.outputPath("calendar-emoji-dark.png") });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(emojiButton(dialog)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("HTTP 사이트에서도 복사 명령으로 이모지를 복사한다", async ({ page }) => {
  const dialog = await openTask(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "isSecureContext", { value: false });
    (window as any).__copied = null;
    const setData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (type, value) {
      if (type === "text/plain") (window as any).__copied = value;
      return setData.call(this, type, value);
    };
  });
  await emojiButton(dialog).click();
  await picker(page).getByRole("textbox", { name: "이모지 검색" }).fill("커피");
  await picker(page).getByRole("button", { name: "커피", exact: true }).click();
  await expect(notice(page)).toHaveText("☕ 이모지를 복사했습니다.");
  expect(await page.evaluate(() => (window as any).__copied)).toBe("☕");
  await expect(picker(page)).toHaveCount(0);
  await expect(emojiButton(dialog)).toBeFocused();
});

test("손가락으로 연 이모지 목록은 검색칸에 포커스하지 않고 Esc는 목록만 닫는다", async ({
  page,
}) => {
  const dialog = await openTask(page);
  const button = emojiButton(dialog);
  await button.dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
  });
  await button.dispatchEvent("click", { detail: 1 });
  await expect(picker(page)).toBeVisible();
  await expect(
    picker(page).getByRole("textbox", { name: "이모지 검색" }),
  ).not.toBeFocused();
  expect(
    await picker(page).evaluate((popup) =>
      popup.contains(document.activeElement),
    ),
  ).toBe(false);
  // A hardware keyboard's Esc closes the list, not the detail around it.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
