import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { THEMES } from "../../shared/themes.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
const workspace = (page: Page) =>
  page.locator('.workspace[data-screen="calendar"]');
const calendar = (page: Page) =>
  page.getByRole("region", { name: "캘린더", exact: true });
let teamId: string, entryId: string;
async function send(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
test.beforeEach(async ({ page }) => {
  await send(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await send(page, "/admin/teams", {
      name: `캘린더 테마 ${randomUUID().slice(0, 6)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  const tag = await send(page, `/calendar/teams/${teamId}/tags`, {
    id: randomUUID(),
    userId: boot.user.id,
    name: "검토",
    color: "purple",
  });
  entryId = (
    await send(page, "/calendar/entries", {
      id: randomUUID(),
      teamId,
      userId: boot.user.id,
      title: "다크 테마 검토 일정",
      date: todayKey(),
      tagIds: [tag.id],
    })
  ).id;
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
});
async function enter(page: Page) {
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page).locator(".calendar-grid")).toBeVisible();
}

test("시스템 테마를 따라가고 직접 고른 테마는 새로고침과 홈 이동 후에도 기억한다", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const annualBackground = await page
    .locator(".main-workspace")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await enter(page);
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
  await expect(workspace(page)).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
  await page
    .getByRole("button", { name: "밝은 테마로 전환", exact: true })
    .click();
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "light");
  await page.reload();
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "light");
  await page
    .getByRole("button", { name: "어두운 테마로 전환", exact: true })
    .click();
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
  await page
    .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".main-workspace")).toHaveCSS(
    "background-color",
    annualBackground,
  );
  await expect(page.locator(".workspace")).not.toHaveAttribute(
    "data-calendar-theme",
  );
  await enter(page);
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
});

test("세 캘린더 보기와 일정·태그 팝업이 다크 테마를 공유하고 태그 색상 저장값을 보존한다", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  await enter(page);
  const saved = await (
    await page.request.get(`/api/calendar/entries/${entryId}`)
  )
    .json()
    .then(unpack);
  await page
    .getByRole("button", { name: "어두운 테마로 전환", exact: true })
    .click();
  for (const name of ["팀 월간 보기", "팀 주간 일정 보기", "개인 월간 보기"]) {
    await calendar(page).getByRole("button", { name, exact: true }).click();
    await expect(workspace(page)).toHaveAttribute(
      "data-calendar-theme",
      "dark",
    );
    await expect(
      calendar(page).locator(".calendar-grid").first(),
    ).toBeVisible();
  }
  const card = page
    .locator(`[data-entry-id="${entryId}"] .calendar-entry-card`)
    .first();
  await expect(card).toBeVisible();
  const readable = async (target: ReturnType<Page["locator"]>) =>
    target.evaluate((el) => {
      const style = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d")!;
      const luminance = (color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((v) => {
            const n = v / 255;
            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  expect(await readable(card)).toBeGreaterThanOrEqual(4.5);
  const selectedView = calendar(page).getByRole("button", {
    name: "개인 월간 보기",
    exact: true,
  });
  await selectedView.hover();
  expect(await readable(selectedView)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: info.outputPath("calendar-dark-desktop.png"),
    fullPage: true,
  });
  await card.click();
  const detail = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveCSS("color-scheme", "dark");
  const sheetColor = await detail.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await expect(detail.getByLabel("일정 제목", { exact: true })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await detail
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    detail.getByRole("textbox", { name: "일정 문서 Markdown 원문" }),
  ).toHaveCSS("background-color", sheetColor);
  await page.screenshot({
    path: info.outputPath("calendar-dark-detail.png"),
    fullPage: true,
  });
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await calendar(page)
    .getByRole("button", { name: "개인 태그 관리", exact: true })
    .click();
  const manager = page.getByRole("dialog", {
    name: "개인 태그 관리",
    exact: true,
  });
  await expect(manager).toHaveCSS("color-scheme", "dark");
  await manager.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("calendar-dark-mobile.png"),
    fullPage: true,
  });
  const after = await (
    await page.request.get(`/api/calendar/entries/${entryId}`)
  )
    .json()
    .then(unpack);
  expect(after.tagIds).toEqual(saved.tagIds);
  expect(after.revision).toBe(saved.revision);
  expect(after.updatedAt).toBe(saved.updatedAt);
});

test("테마 저장소를 사용할 수 없어도 전환과 홈 이동이 동작한다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem,
      write = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (
        ["weekly-plan:calendar-theme", "weekly-plan:calendar-palette"].includes(
          key,
        )
      )
        throw new Error("storage unavailable");
      return read.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (
        ["weekly-plan:calendar-theme", "weekly-plan:calendar-palette"].includes(
          key,
        )
      )
        throw new Error("storage unavailable");
      return write.call(this, key, value);
    };
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/calendar");
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "light");
  await page
    .getByRole("button", { name: "어두운 테마로 전환", exact: true })
    .click();
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
  await page.getByLabel("캘린더 테마", { exact: true }).selectOption("mint");
  await expect(workspace(page)).toHaveAttribute(
    "data-calendar-palette",
    "mint",
  );
  await page
    .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
});

test("기존 다섯 팔레트를 밝기와 독립적으로 선택하고 새로고침 뒤 유지하며 팀 설정을 바꾸지 않는다", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const before = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const annualBackground = await page
    .locator(".main-workspace")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await enter(page);
  const picker = page.getByLabel("캘린더 테마", { exact: true });
  const board = calendar(page).locator(".calendar-board");
  const pickerBox = (await picker.boundingBox())!;
  const toggleBox = (await page
    .getByRole("button", { name: "어두운 테마로 전환", exact: true })
    .boundingBox())!;
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(toggleBox.x);
  for (const theme of THEMES) {
    await picker.selectOption(theme.id);
    await expect(workspace(page)).toHaveAttribute(
      "data-calendar-palette",
      theme.id,
    );
    expect(
      await workspace(page).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--accent").trim(),
      ),
    ).toBe(theme.accent);
    expect(
      await board.evaluate((el) => getComputedStyle(el, "::before").display),
    ).toBe("none");
    await expect(board).toHaveCSS("border-top-width", "1px");
    await page
      .getByRole("button", { name: "어두운 테마로 전환", exact: true })
      .click();
    await expect(workspace(page)).toHaveAttribute(
      "data-calendar-theme",
      "dark",
    );
    await expect(picker).toHaveValue(theme.id);
    await page
      .getByRole("button", { name: "밝은 테마로 전환", exact: true })
      .click();
    if (theme.id === "mint")
      await page.screenshot({
        path: info.outputPath("calendar-mint-light.png"),
        animations: "disabled",
        fullPage: true,
      });
  }
  await picker.selectOption("sky");
  await page.screenshot({
    path: info.outputPath("calendar-sky-light.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "어두운 테마로 전환", exact: true })
    .click();
  await page.reload();
  await expect(picker).toHaveValue("sky");
  await expect(workspace(page)).toHaveAttribute("data-calendar-theme", "dark");
  await page.screenshot({
    path: info.outputPath("calendar-sky-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page
    .locator(`[data-entry-id="${entryId}"] .calendar-entry-card`)
    .first()
    .click();
  const detail = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  await expect(detail.getByLabel("일정 제목", { exact: true })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(
    detail.getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("calendar-sky-detail.png"),
    animations: "disabled",
  });
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const control of [
    picker,
    page.getByRole("button", { name: "밝은 테마로 전환", exact: true }),
    page.getByRole("button", { name: "캘린더 닫기", exact: true }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    path: info.outputPath("calendar-sky-mobile.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
    .click();
  await expect(page.locator(".workspace")).not.toHaveAttribute(
    "data-calendar-palette",
  );
  await expect(page.locator(".main-workspace")).toHaveCSS(
    "background-color",
    annualBackground,
  );
  await enter(page);
  await expect(picker).toHaveValue("sky");
  await picker.selectOption("cartoon");
  await expect(board).toHaveCSS("border-top-width", "2px");
  expect(
    await board.evaluate((el) => getComputedStyle(el, "::before").display),
  ).not.toBe("none");
  const after = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  expect(
    after.teams.find((team: { id: string }) => team.id === teamId).settings,
  ).toEqual(
    before.teams.find((team: { id: string }) => team.id === teamId).settings,
  );
});
