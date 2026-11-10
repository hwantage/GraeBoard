import {
  test,
  expect,
  type Page,
  type Request,
  type Locator,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpack } from "../../../shared/formatting/compact.js";
import { todayKey } from "../../../shared/domain.js";
import { addDays } from "../../../shared/calendar/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, memberId: string, memberLogin: string;
let errors: string[];
const password = "local-secret-test-password";
const key = () => `weekly-plan:secret-calendar:${userId}`;
const createDialog = (page: Page) =>
  page.getByRole("dialog", { name: "일정 추가", exact: true });
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "시크릿 일정", exact: true });
const card = (page: Page, title: string) =>
  page
    .locator('.calendar-entry-segment[data-secret="true"] .calendar-entry-card')
    .filter({ hasText: title })
    .first();
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
async function enter(page: Page) {
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(
    page.locator(
      `.calendar-day[data-date="${todayKey()}"][data-owner-id="${userId}"]`,
    ),
  ).toBeVisible();
}
async function startCreate(page: Page, title: string) {
  await page
    .locator(
      `.calendar-day[data-date="${todayKey()}"][data-owner-id="${userId}"]`,
    )
    .getByRole("button", { name: /일정 추가/ })
    .click();
  await createDialog(page).getByRole("switch", { name: "시크릿 일정" }).check();
  await createDialog(page)
    .getByRole("textbox", { name: "새 일정 제목" })
    .fill(title);
}
async function create(page: Page, title: string) {
  await startCreate(page, title);
  await expect(
    createDialog(page).locator(".calendar-tag-picker summary"),
  ).toBeVisible();
  await createDialog(page)
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(createDialog(page)).toHaveCount(0);
  await expect(card(page, title)).toBeVisible();
}
async function closeDetail(page: Page) {
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
}
function observe(page: Page) {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  return requests;
}
function expectPrivate(requests: Request[], ...values: string[]) {
  for (const request of requests) {
    const text = decodeURIComponent(request.url()) + (request.postData() || "");
    for (const value of values) expect(text).not.toContain(value);
    expect(text).not.toContain("secret:");
  }
  expect(
    requests.filter(
      (request) =>
        (/\/api\/calendar/.test(request.url()) &&
          !["GET", "HEAD"].includes(request.method())) ||
        /\/api\/(?:document-images|document-links)|\/api\/calendar\/entries\/[^/]+\/(?:document|images)/.test(
          request.url(),
        ),
    ),
  ).toEqual([]);
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
      name: `시크릿 검증 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  memberLogin = `secret-${randomUUID()}@example.com`;
  memberId = (
    await request(page, "/admin/users", "POST", {
      username: memberLogin,
      password,
      name: "다른 팀장",
      memberships: [{ teamId, role: "lead" }],
    })
  ).user.id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  await enter(page);
});
test.afterEach(() => expect(errors).toEqual([]));

test("시크릿 생성·제목·기간·삭제·실행취소는 브라우저에만 저장된다", async ({
  page,
}) => {
  const title = `개인 비밀 ${randomUUID()}`,
    changed = `수정 비밀 ${randomUUID()}`;
  const requests = observe(page);
  await create(page, title);
  await expect(
    card(page, title).locator(".calendar-secret-icon"),
  ).toHaveAttribute("aria-label", "시크릿 일정");
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key(),
  );
  expect(stored).toMatchObject({
    version: 2,
    visible: true,
    entries: [{ teamId, title }],
  });
  await page.reload();
  await expect(card(page, title)).toBeVisible();
  await card(page, title).click();
  await expect(
    detail(page).getByRole("button", { name: "문서 링크 복사", exact: true }),
  ).toHaveCount(0);
  await detail(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill(changed);
  await detail(page)
    .getByLabel("일정 종료일", { exact: true })
    .fill(addDays(todayKey(), 2));
  await detail(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expect(
    detail(page).getByText("기간 저장됨", { exact: true }),
  ).toBeVisible();
  await closeDetail(page);
  await expect(card(page, changed)).toBeVisible();
  await expect(card(page, changed).locator("..")).toHaveAttribute(
    "data-range-end",
    addDays(todayKey(), 2),
  );
  await card(page, changed).click();
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(card(page, changed)).toHaveCount(0);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(card(page, changed)).toBeVisible();
  await page.reload();
  await expect(card(page, changed)).toBeVisible();
  expectPrivate(requests, title, changed);
  const server = await request(
    page,
    `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${addDays(todayKey(), 6)}`,
  );
  expect(server.entries).toEqual([]);
});

test("보이기 선택·검색·소유자·팀 범위와 다른 계정 격리", async ({ page }) => {
  const title = `나만 찾는 제목 ${randomUUID()}`;
  await create(page, title);
  const requests = observe(page);
  const toggle = () =>
    page.getByRole("button", { name: "시크릿 일정 숨기기", exact: true });
  await expect(toggle()).toHaveAttribute("aria-pressed", "true");
  await expect(toggle().locator("svg")).toHaveClass(/lucide-lock-keyhole/);
  await toggle().click();
  await expect(card(page, title)).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "시크릿 일정 보이기", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page
      .getByRole("button", { name: "시크릿 일정 보이기", exact: true })
      .locator("svg"),
  ).toHaveClass(/lucide-eye-off/);
  await expect(card(page, title)).toHaveCount(0);
  await page
    .getByRole("button", { name: "시크릿 일정 보이기", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "일정 제목 검색" })
    .fill("불일치하는 검색");
  await expect(card(page, title)).toBeHidden();
  await page.getByRole("searchbox", { name: "일정 제목 검색" }).fill(title);
  await expect(card(page, title)).toBeVisible();
  await page.getByRole("button", { name: "검색 지우기", exact: true }).click();
  await page
    .locator(`.calendar-owner-button[data-member-id="${memberId}"]`)
    .click();
  await expect(card(page, title)).toHaveCount(0);
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).click();
  await expect(card(page, title)).toHaveCount(0);
  await page
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  await expect(
    page
      .locator(`.calendar-team-section[data-member-id="${userId}"]`)
      .locator('[data-secret="true"]'),
  ).toHaveCount(1);
  await expect(
    page
      .locator(`.calendar-team-section[data-member-id="${memberId}"]`)
      .locator('[data-secret="true"]'),
  ).toHaveCount(0);
  expectPrivate(requests, title);
  const otherTeam = (
    await request(page, "/admin/teams", "POST", {
      name: `다른 팀 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await page.reload();
  await page.getByLabel("팀 선택", { exact: true }).selectOption(otherTeam);
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await expect(card(page, title)).toHaveCount(0);
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await expect(card(page, title)).toBeVisible();
  await request(page, "/auth/logout", "POST");
  await request(page, "/auth/login", "POST", {
    username: memberLogin,
    password,
  });
  await page.reload();
  await expect(
    page.locator(`.calendar-owner-button[data-member-id="${userId}"]`),
  ).toBeVisible();
  await page
    .locator(`.calendar-owner-button[data-member-id="${userId}"]`)
    .click();
  await expect(card(page, title)).toHaveCount(0);
  // The original account's data remains in the profile; isolation is by account key.
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key()),
  ).toContain(title);
});

test("다른 탭의 생성·수정·삭제·보이기 선택을 반영한다", async ({
  page,
  context,
}) => {
  const title = `여러 탭 ${randomUUID()}`,
    changed = `탭에서 수정 ${randomUUID()}`;
  const second = await context.newPage();
  await second.goto("/calendar");
  await expect(
    second.locator(`.calendar-day[data-owner-id="${userId}"]`).first(),
  ).toBeVisible();
  const requests = observe(page);
  const secondRequests = observe(second);
  await create(page, title);
  await expect(card(second, title)).toBeVisible();
  await card(second, title).click();
  await detail(second)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill(changed);
  await closeDetail(second);
  await expect(card(page, changed)).toBeVisible();
  await page
    .getByRole("button", { name: "시크릿 일정 숨기기", exact: true })
    .click();
  await expect(card(second, changed)).toHaveCount(0);
  await second
    .getByRole("button", { name: "시크릿 일정 보이기", exact: true })
    .click();
  await expect(card(page, changed)).toBeVisible();
  await card(second, changed).click({ button: "right" });
  await expect(
    second.getByRole("menuitem", { name: "태그 설정", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("menuitem", { name: "일정 삭제", exact: true })
    .click();
  await expect(card(page, changed)).toHaveCount(0);
  expectPrivate([...requests, ...secondRequests], title, changed);
  await second.close();
});

test("서버 저장 행을 보존하고 포인터·키보드로 시크릿 기간을 옮긴다", async ({
  page,
}) => {
  const server = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "공개 일정",
  });
  await page.reload();
  const ordinary = page.locator(`[data-entry-id="${server.id}"]`).first();
  await expect(ordinary).toBeVisible();
  const beforeLane = await ordinary.getAttribute("data-entry-lane");
  const title = `로컬 이동 ${randomUUID()}`;
  const requests = observe(page);
  await create(page, title);
  const secret = card(page, title).locator("..");
  expect(await secret.getAttribute("data-entry-lane")).not.toBe(beforeLane);
  await card(page, title).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(secret).toHaveAttribute(
    "data-range-start",
    addDays(todayKey(), 1),
  );
  await expect(ordinary).toHaveAttribute("data-entry-lane", beforeLane!);
  for (const targetDate of [todayKey(), addDays(todayKey(), 1)]) {
    const sourceBox = await card(page, title).boundingBox();
    const target = page.locator(
      `.calendar-day[data-date="${targetDate}"][data-owner-id="${userId}"]`,
    );
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + 55,
      { steps: 12 },
    );
    await expect(page.locator(".is-drag-preview[data-secret]")).toBeVisible();
    const previewLane = await page
      .locator(".is-drag-preview[data-secret]")
      .getAttribute("data-entry-lane");
    await page.mouse.up();
    await expect(secret).toHaveAttribute("data-entry-lane", previewLane!);
    await expect(secret).toHaveAttribute("data-range-start", targetDate);
  }
  await card(page, title).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(secret).toHaveAttribute("data-range-start", todayKey());
  await secret
    .getByRole("button", { name: "종료일 조정", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(secret).toHaveAttribute(
    "data-range-end",
    addDays(todayKey(), 1),
  );
  await page.reload();
  await expect(ordinary).toHaveAttribute("data-server-lane", beforeLane!);
  await expect(secret).toHaveAttribute(
    "data-range-end",
    addDays(todayKey(), 1),
  );
  expectPrivate(requests, title);
  expect((await request(page, `/calendar/entries/${server.id}`)).lane).toBe(
    Number(beforeLane),
  );
});

test("생성 초안은 시크릿 선택을 기억하고 바깥 클릭으로 로컬 저장한다", async ({
  page,
}) => {
  const title = `비밀 초안 ${randomUUID()}`;
  const requests = observe(page);
  await startCreate(page, title);
  await createDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.reload();
  await page
    .locator(
      `.calendar-day[data-date="${todayKey()}"][data-owner-id="${userId}"]`,
    )
    .getByRole("button", { name: /일정 추가/ })
    .click();
  await expect(
    createDialog(page).getByRole("switch", { name: "시크릿 일정" }),
  ).toBeChecked();
  await expect(
    createDialog(page).getByRole("textbox", { name: "새 일정 제목" }),
  ).toHaveValue(title);
  await page.mouse.click(5, 5);
  await expect(createDialog(page)).toHaveCount(0);
  await expect(card(page, title)).toBeVisible();
  expectPrivate(requests, title);
});

test("손상된 저장값과 용량 초과는 데이터를 덮어쓰지 않고 오류를 표시한다", async ({
  page,
}) => {
  await page.evaluate((key) => localStorage.setItem(key, "broken-json"), key());
  await page.reload();
  await expect(
    page.getByText(
      "시크릿 일정 저장값을 읽을 수 없습니다. 이 브라우저의 기존 데이터는 변경하지 않았습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await startCreate(page, "손상값 보존");
  await createDialog(page)
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(createDialog(page)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key())).toBe(
    "broken-json",
  );
  await createDialog(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.evaluate((key) => localStorage.removeItem(key), key());
  await page.reload();
  await create(page, "보존할 기존 시크릿");
  const before = await page.evaluate((key) => localStorage.getItem(key), key());
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("weekly-plan:secret-calendar:"))
        throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await startCreate(page, "용량 초과 시크릿");
  await createDialog(page)
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(
    createDialog(page).getByText(
      "시크릿 일정을 저장할 수 없습니다. 브라우저 저장 공간과 설정을 확인한 뒤 다시 시도해 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    createDialog(page).getByRole("textbox", { name: "새 일정 제목" }),
  ).toHaveValue("용량 초과 시크릿");
  expect(await page.evaluate((key) => localStorage.getItem(key), key())).toBe(
    before,
  );
});

async function colorContrast(card: Locator) {
  return card.evaluate((node) => {
    const style = getComputedStyle(node);
    const context = document.createElement("canvas").getContext("2d")!;
    function rgb(color: string) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }
    function luminance(color: number[]) {
      const linear = color.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    const title = node.querySelector(".calendar-entry-title");
    const foreground = rgb(title ? getComputedStyle(title).color : style.color),
      background = rgb(style.backgroundColor);
    const values = [luminance(foreground), luminance(background)].sort(
      (a, b) => b - a,
    );
    return {
      foreground,
      background,
      ratio: (values[0] + 0.05) / (values[1] + 0.05),
    };
  });
}

test("라이트·다크와 각 팔레트에서 기존 카드와 구별된다", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const server = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "공개 일정",
  });
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "보라 태그",
    userId,
    color: "purple",
  });
  const tagged = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "태그 일정",
    tagIds: [tag.id],
  });
  await page.reload();
  await create(page, "시크릿 일정");
  await startCreate(page, "태그 시크릿");
  await createDialog(page).locator(".calendar-tag-picker summary").click();
  await createDialog(page)
    .getByRole("button", { name: "보라 태그 태그", exact: true })
    .click();
  await createDialog(page)
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  const secretTagged = card(page, "태그 시크릿");
  const secret = card(page, "시크릿 일정");
  const regular = page
    .locator(`[data-entry-id="${server.id}"] .calendar-entry-card`)
    .first();
  const tagCard = page
    .locator(`[data-entry-id="${tagged.id}"] .calendar-entry-card`)
    .first();
  const contrasts = [];
  for (const theme of ["light", "dark"]) {
    for (const palette of [
      "cartoon",
      "mint",
      "sky",
      "lavender",
      "rose",
      "sand",
    ]) {
      await page.evaluate(
        ({ theme, palette }) => {
          localStorage.setItem("weekly-plan:calendar-theme", theme);
          localStorage.setItem("weekly-plan:calendar-palette", palette);
        },
        { theme, palette },
      );
      await page.reload();
      await expect(secret).toBeInViewport();
      await expect(regular).toBeInViewport();
      await expect(tagCard).toBeInViewport();
      await expect(secret).toHaveCSS("border-top-style", "dashed");
      await expect(secret).toHaveCSS("border-bottom-style", "dashed");
      await expect(regular).toHaveCSS("border-top-style", "solid");
      await expect(tagCard).toHaveCSS("border-top-style", "solid");
      const normal = await colorContrast(secret);
      expect(normal.ratio).toBeGreaterThanOrEqual(4.5);
      const ordinary = await colorContrast(regular);
      const taggedSecret = await colorContrast(secretTagged);
      expect(normal.foreground).not.toEqual(ordinary.foreground);
      expect(normal.ratio).toBeLessThan(ordinary.ratio);
      expect(taggedSecret.ratio).toBeGreaterThanOrEqual(4.5);
      expect(taggedSecret.ratio).toBeLessThan(
        (await colorContrast(tagCard)).ratio,
      );
      expect(
        await secret
          .locator(".calendar-secret-icon")
          .evaluate((node) => getComputedStyle(node).color),
      ).toBe(await regular.evaluate((node) => getComputedStyle(node).color));
      expect(normal.background).not.toEqual(
        (await colorContrast(regular)).background,
      );
      expect(normal.background).not.toEqual(
        (await colorContrast(tagCard)).background,
      );
      await secret.hover();
      const hovered = await colorContrast(secret);
      expect(hovered.ratio).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`secret-${theme}-${palette}.png`),
      });
      const toggle = page.locator(".calendar-secret-toggle");
      const visibleToggle = await colorContrast(toggle);
      expect(visibleToggle.ratio).toBeGreaterThanOrEqual(3);
      const visibleColor = await toggle.evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
        ink: getComputedStyle(node).color,
      }));
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(toggle.locator("svg")).toHaveClass(/lucide-eye-off/);
      const hiddenColor = await toggle.evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
        ink: getComputedStyle(node).color,
      }));
      const hiddenToggle = await colorContrast(toggle);
      expect(hiddenToggle.ratio).toBeGreaterThanOrEqual(3);
      contrasts.push({
        theme,
        palette,
        normal,
        taggedSecret,
        hovered,
        visibleToggle,
        hiddenToggle,
      });
      expect(hiddenColor.background).not.toBe(visibleColor.background);
      expect(hiddenColor.ink).not.toBe(visibleColor.ink);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
  }
  await testInfo.attach("secret-contrast", {
    body: JSON.stringify(contrasts, null, 2),
    contentType: "application/json",
  });
});

async function expectCreatingSwitch(page: Page, checked = true) {
  const dialog = createDialog(page);
  const label = dialog.locator(".switch-field");
  const track = label.locator(".switch-track");
  await expect(label.getByRole("switch")).toBeChecked({ checked });
  await expect(label).toBeInViewport({ ratio: 1 });
  await expect(track).toBeInViewport({ ratio: 1 });
  // Observe the knob's final position before capturing either switch state.
  await expect
    .poll(() =>
      track.evaluate((node) => getComputedStyle(node, "::after").transform),
    )
    .toBe(checked ? "matrix(1, 0, 0, 1, 14, 0)" : "none");
  await expect
    .poll(async () => {
      const text = await label.locator("span").first().boundingBox();
      const toggle = await track.boundingBox();
      const title = await dialog
        .getByRole("textbox", { name: "새 일정 제목" })
        .boundingBox();
      if (!text || !toggle || !title) return false;
      return (
        Math.abs(text.x - title.x) <= 1 &&
        Math.abs(text.y + text.height / 2 - toggle.y - toggle.height / 2) <=
          1 &&
        toggle.x > text.x + text.width
      );
    })
    .toBe(true);
}

test("1366px에서 시크릿 생성 스위치를 왼쪽 한 줄로 표시한다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await startCreate(page, "데스크톱 시크릿");
  await expectCreatingSwitch(page);
  await page.screenshot({
    path: testInfo.outputPath("secret-desktop-create-on.png"),
  });
  await createDialog(page)
    .getByRole("switch", { name: "시크릿 일정" })
    .uncheck();
  await expectCreatingSwitch(page, false);
  await page.screenshot({
    path: testInfo.outputPath("secret-desktop-create-off.png"),
  });
});

test("390px에서 시크릿 토글과 생성 스위치가 잘리지 않는다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.locator(".calendar-secret-toggle");
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("secret-mobile-visible.png"),
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("secret-mobile-hidden.png"),
  });
  // Date cells retain the existing horizontal scrolling; only inspect the new controls.
  await startCreate(page, "모바일 시크릿");
  await expectCreatingSwitch(page);
  await page.screenshot({
    path: testInfo.outputPath("secret-mobile-create.png"),
  });
});

test("모바일에서 시크릿 상세는 처음부터 전체 화면·전체 너비로 열린다", async ({
  page,
}) => {
  const title = `모바일 상세 ${randomUUID()}`;
  await create(page, title);
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, title).click();
  await expect(detail(page)).toHaveClass(/document-full-page/);
  await expect(detail(page)).toHaveClass(/document-full-width/);
  await expect(
    detail(page).getByRole("button", {
      name: "문서 전체 페이지로 보기",
      exact: true,
    }),
  ).toBeHidden();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(detail(page)).not.toHaveClass(/document-full-page/);
  await expect(
    detail(page).getByRole("button", {
      name: "문서 전체 페이지로 보기",
      exact: true,
    }),
  ).toBeVisible();
});

test("다른 탭의 기간 변경은 제목 저장 뒤에도 덮어쓰지 않고 초안으로 복원한다", async ({
  page,
  context,
}) => {
  const title = `동시 편집 ${randomUUID()}`,
    changed = `제목만 변경 ${randomUUID()}`;
  await create(page, title);
  const second = await context.newPage();
  await second.goto("/calendar");
  await expect(card(second, title)).toBeVisible();
  const requests = observe(page),
    secondRequests = observe(second);
  await card(page, title).click();
  await detail(page)
    .getByLabel("일정 종료일", { exact: true })
    .fill(addDays(todayKey(), 2));
  await card(second, title).click();
  await detail(second)
    .getByLabel("일정 종료일", { exact: true })
    .fill(addDays(todayKey(), 1));
  await closeDetail(second);
  await detail(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill(changed);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).entries[0].title,
        key(),
      ),
    )
    .toBe(changed);
  await detail(page)
    .getByRole("button", { name: "기간 저장", exact: true })
    .click();
  await expect(
    detail(page).getByText(
      "다른 탭에서 시크릿 일정이 변경되었습니다. 입력을 복사한 뒤 일정을 다시 열어 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].endDate,
      key(),
    ),
  ).toBe(addDays(todayKey(), 1));
  await detail(page)
    .getByRole("button", { name: "초안 보관하고 닫기", exact: true })
    .click();
  await card(page, changed).click();
  await expect(
    detail(page).getByText(
      `최신 브라우저 기간: ${todayKey()} ~ ${addDays(todayKey(), 1)}`,
      { exact: true },
    ),
  ).toBeVisible();
  await detail(page)
    .getByRole("button", { name: "내 기간으로 최신 기간 교체", exact: true })
    .click();
  await expect(
    detail(page).getByText("기간 저장됨", { exact: true }),
  ).toBeVisible();
  await closeDetail(page);
  await expect(card(second, changed).locator("..")).toHaveAttribute(
    "data-range-end",
    addDays(todayKey(), 2),
  );
  expectPrivate([...requests, ...secondRequests], title, changed);
  await second.close();
});

const source = (page: Page) =>
  detail(page).getByRole("textbox", {
    name: "일정 문서 Markdown 원문",
    exact: true,
  });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", {
    name: "일정 문서 리치 편집",
    exact: true,
  });
async function sourceMode(page: Page) {
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(source(page)).toBeVisible();
}
async function documentSaved(page: Page) {
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
}
async function localDocument(page: Page, id: string) {
  return page.evaluate(
    async ({ userId, id }) =>
      new Promise<any>((resolve, reject) => {
        const open = indexedDB.open(`weekly-plan:secret-documents:${userId}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db
            .transaction("documents")
            .objectStore("documents")
            .get(id);
          request.onsuccess = () => {
            resolve(request.result);
            db.close();
          };
          request.onerror = () => {
            reject(request.error);
            db.close();
          };
        };
      }),
    { userId, id },
  );
}
async function localImages(page: Page, id: string) {
  return page.evaluate(
    ({ userId, id }) =>
      new Promise<any[]>((resolve, reject) => {
        const open = indexedDB.open(`weekly-plan:secret-documents:${userId}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db
            .transaction("images")
            .objectStore("images")
            .index("documentId")
            .getAll(id);
          request.onsuccess = () => {
            resolve(
              request.result.map((image) => ({
                ...image,
                bytes: Array.from(new Uint8Array(image.bytes)),
              })),
            );
            db.close();
          };
          request.onerror = () => {
            reject(request.error);
            db.close();
          };
        };
      }),
    { userId, id },
  );
}
async function storedEntries(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).entries,
    key(),
  );
}
async function attachLocalImage(page: Page, method: "paste" | "drop") {
  await rich(page).focus();
  return rich(page).evaluate((element, method) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = method === "paste" ? "#496b37" : "#7d3c59";
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = "white";
    context.font = "20px sans-serif";
    context.fillText(`local-only-${crypto.randomUUID()}`, 10, 70);
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
        "시크릿 이미지.png",
        { type: "image/png" },
      ),
    );
    const bounds = element.getBoundingClientRect();
    const event =
      method === "paste"
        ? new ClipboardEvent("paste", { bubbles: true, cancelable: true })
        : new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.right - 10,
            clientY: bounds.bottom - 10,
          });
    Object.defineProperty(
      event,
      method === "paste" ? "clipboardData" : "dataTransfer",
      { value: data },
    );
    element.dispatchEvent(event);
    return base64.slice(120, 240);
  }, method);
}

test("복제·태그·문서·이미지·삭제 복원 전 과정이 로컬에만 남는다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const title = `비공개 확장 ${randomUUID()}`,
    body = `본문 비밀 ${randomUUID()}`;
  const check = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    userId,
    name: "개인 완료",
    kind: "check",
    color: "green",
  });
  const normal = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    userId,
    name: "개인 중요",
    color: "purple",
  });
  await page.reload();
  const requests = observe(page);
  await startCreate(page, title);
  await createDialog(page).locator(".calendar-tag-picker summary").click();
  await createDialog(page)
    .getByRole("button", { name: "개인 중요 태그", exact: true })
    .click();
  await createDialog(page)
    .getByRole("button", { name: "개인 완료 태그", exact: true })
    .click();
  await createDialog(page)
    .getByRole("checkbox", { name: "개인 완료 체크", exact: true })
    .check();
  await createDialog(page)
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(card(page, title)).toBeVisible();
  const id = (await storedEntries(page))[0].id;
  const segment = () => page.locator(`[data-entry-id="${id}"]`).first();
  await expect(
    segment().getByRole("checkbox", { name: "개인 완료 체크" }),
  ).toBeChecked();
  await segment().locator(".calendar-entry-card").click();
  await detail(page)
    .getByRole("button", { name: "개인 중요 태그 제거", exact: true })
    .click();
  await detail(page).locator(".calendar-tag-picker summary").click();
  await detail(page)
    .getByRole("button", { name: "개인 중요 태그", exact: true })
    .click();
  await detail(page)
    .getByRole("button", { name: "개인 중요 색상을 배경에 적용", exact: true })
    .click();
  await sourceMode(page);
  await source(page).fill(`# ${body}\n\n두 번째 문단\n`);
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page)).toContainText(body);
  const imageBytes = await attachLocalImage(page, "paste");
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(1);
  const droppedBytes = await attachLocalImage(page, "drop");
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(2);
  const size = detail(page)
    .getByRole("slider", { name: "이미지 너비 조절" })
    .first();
  await size.focus();
  await size.press("ArrowLeft");
  await documentSaved(page);
  await rich(page).locator("img").first().dblclick();
  const preview = page.getByRole("dialog", {
    name: "이미지 크게 보기",
    exact: true,
  });
  await expect(preview.locator("img")).toHaveAttribute("src", /^data:image\//);
  await page.keyboard.press("Escape");
  await detail(page)
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await expect(detail(page)).toHaveClass(/document-full-page/);
  await detail(page).screenshot({
    path: info.outputPath("secret-document-images.png"),
  });
  const document = await localDocument(page, id);
  expect(document.markdown).toContain(body);
  expect(document.markdown).toContain("secret-image:");
  expect(document.markdown).toContain("#width=");
  expect(document.markdown).not.toContain("data:image");
  expect(document.images).toHaveLength(2);
  await closeDetail(page);
  await expect(
    card(page, title).locator(".calendar-document-icon"),
  ).toBeVisible();
  await segment().locator(".calendar-entry-card").click({ button: "right" });
  await page.getByRole("menuitem", { name: "태그 설정", exact: true }).click();
  const tags = page.getByRole("dialog", { name: "일정 태그", exact: true });
  await tags.getByRole("checkbox", { name: "개인 완료 체크" }).uncheck();
  await tags.getByRole("checkbox", { name: "개인 완료 체크" }).check();
  await tags.getByRole("button", { name: "닫기", exact: true }).click();
  await segment().locator(".calendar-entry-card").click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(card(page, `${title} (1)`)).toBeVisible();
  let entries = await storedEntries(page);
  const copied = entries.find((entry: any) => entry.title === `${title} (1)`);
  expect(copied).toMatchObject({
    tagIds: [normal.id, check.id],
    checkedTagIds: [check.id],
    date: todayKey(),
    endDate: todayKey(),
  });
  expect(await localDocument(page, copied.id)).toBeUndefined();
  await card(page, `${title} (1)`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(card(page, `${title} (2)`)).toBeVisible();
  await page.reload();
  await expect(
    segment().getByRole("checkbox", { name: "개인 완료 체크" }),
  ).toBeChecked();
  await segment().locator(".calendar-entry-card").click();
  await expect(rich(page)).toContainText(body);
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(2);
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(segment()).toHaveCount(0);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(segment()).toBeVisible();
  await segment().locator(".calendar-entry-card").click();
  await expect(rich(page)).toContainText(body);
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(2);
  await closeDetail(page);
  await page
    .getByRole("button", { name: "시크릿 일정 숨기기", exact: true })
    .click();
  await expect(segment()).toHaveCount(0);
  await page
    .getByRole("button", { name: "시크릿 일정 보이기", exact: true })
    .click();
  await expect(segment()).toBeVisible();
  expectPrivate(requests, title, body, imageBytes, droppedBytes);
  await request(page, `/calendar/tags/${normal.id}`, "DELETE", {
    expectedRevision: normal.revision,
  });
  await page.reload();
  await expect(segment()).not.toContainText("개인 중요");
  await expect(
    segment().getByRole("checkbox", { name: "개인 완료 체크" }),
  ).toBeChecked();
  const catalog = await request(page, `/calendar/teams/${teamId}`);
  expect(catalog.tags.find((tag: any) => tag.id === check.id).usageCount).toBe(
    0,
  );
  await request(page, "/auth/logout", "POST");
  await request(page, "/auth/login", "POST", {
    username: memberLogin,
    password,
  });
  await page.reload();
  await expect(page.locator("[data-secret]")).toHaveCount(0);
});

test("시크릿 문서는 다른 탭 변경을 반영하고 겹치는 수정은 보존한다", async ({
  page,
  context,
}) => {
  const title = `동시 문서 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  await sourceMode(page);
  await source(page).fill("기준 문단\n");
  await documentSaved(page);
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    const Native = BroadcastChannel;
    (window as any).secretChannels = [];
    window.BroadcastChannel = class extends Native {
      constructor(name: string) {
        super(name);
        if (name.startsWith("weekly-plan:secret-documents:"))
          (window as any).secretChannels.push(this);
      }
    };
  });
  const requests = observe(page);
  const peerRequests = observe(peer);
  await peer.goto("/calendar");
  await card(peer, title).click();
  await sourceMode(peer);
  await expect(source(peer)).toHaveValue("기준 문단\n");
  await source(page).fill("다른 탭 반영\n");
  await documentSaved(page);
  await expect(source(peer)).toHaveValue("다른 탭 반영\n");
  // Drop the broadcast before the conflicting writes: IndexedDB revision
  // comparison must protect the saved body even without a notification.
  await peer.evaluate(() =>
    (window as any).secretChannels.forEach((channel: BroadcastChannel) =>
      channel.close(),
    ),
  );
  await source(peer).fill("보존할 내 입력\n");
  await source(peer).dispatchEvent("compositionstart");
  await source(page).fill("먼저 저장한 문단\n");
  await documentSaved(page);
  await source(peer).dispatchEvent("compositionend");
  await expect(detail(peer).getByRole("alert")).toContainText(
    "다른 탭에서 문서가 변경",
  );
  await expect(source(peer)).toHaveValue("보존할 내 입력\n");
  const id = (await storedEntries(page))[0].id;
  expect((await localDocument(page, id)).markdown).toBe("먼저 저장한 문단\n");
  await detail(peer)
    .getByRole("button", { name: "내 입력으로 최신 문서 교체" })
    .click();
  await documentSaved(peer);
  await expect(source(page)).toHaveValue("보존할 내 입력\n");
  expectPrivate(
    [...requests, ...peerRequests],
    title,
    "보존할 내 입력",
    "먼저 저장한 문단",
  );
  await closeDetail(peer);
  await peer.close();
});

test("version 1 일정을 보존하며 태그 저장 형식으로 옮기고 긴 제목을 복제한다", async ({
  page,
}) => {
  const title = "긴 제목".repeat(30),
    id = `secret:${randomUUID()}`;
  await page.evaluate(
    ({ key, teamId, title, id, date }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          visible: true,
          entries: [{ id, teamId, title, date, endDate: date, lane: 3 }],
        }),
      ),
    { key: key(), teamId, title, id, date: todayKey() },
  );
  await page.reload();
  await expect(card(page, title)).toBeVisible();
  await card(page, title).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect.poll(async () => (await storedEntries(page)).length).toBe(2);
  const entries = await storedEntries(page);
  expect(entries.find((entry: any) => entry.id === id)).toMatchObject({
    title,
    lane: 0,
    tagIds: [],
    checkedTagIds: [],
  });
  const copy = entries.find((entry: any) => entry.id !== id);
  expect(copy.title.length).toBeLessThanOrEqual(120);
  expect(copy.title).toMatch(/ \(1\)$/);
  await expectDisplayOrder(page, [id, copy.id]);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).version,
      key(),
    ),
  ).toBe(2);
});

test("IndexedDB 저장 실패는 본문을 보존하고 삭제 알림이 끝나면 문서·이미지를 정리한다", async ({
  page,
}) => {
  test.setTimeout(45000);
  const title = `용량 실패 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  await sourceMode(page);
  await source(page).fill("저장한 본문");
  await documentSaved(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).restoreSecretPut = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name.startsWith("weekly-plan:secret-documents:"))
        throw new DOMException("full", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await source(page).fill("잃으면 안 되는 본문");
  await expect(detail(page).getByRole("alert")).toContainText(
    "브라우저 저장 공간",
  );
  await expect(source(page)).toHaveValue("잃으면 안 되는 본문");
  const id = (await storedEntries(page))[0].id;
  expect((await localDocument(page, id)).markdown).toBe("저장한 본문");
  await page.evaluate(() => (window as any).restoreSecretPut());
  await detail(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await attachLocalImage(page, "paste");
  await expect(rich(page).locator("img[src]")).toHaveCount(1);
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "일정 삭제", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "실행취소", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => await localDocument(page, id), { timeout: 12000 })
    .toBeUndefined();
  expect(await localImages(page, id)).toEqual([]);
});

test("시크릿 문서 크기·이미지 형식·용량을 검사하고 서버 참조를 조회하지 않는다", async ({
  page,
}) => {
  const title = `첨부 검증 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  const requests = observe(page);
  await sourceMode(page);
  const oversized = "x".repeat(256 * 1024 + 1);
  await source(page).fill(oversized);
  await expect(detail(page).getByRole("alert")).toContainText("256KiB");
  await expect(source(page)).toHaveValue(oversized);
  await source(page).fill("보존된 문서");
  await detail(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  for (const oversized of [false, true]) {
    await rich(page).evaluate((element, oversized) => {
      const bytes = oversized
        ? new Uint8Array(10 * 1024 * 1024 + 1)
        : new TextEncoder().encode("invalid private image");
      const data = new DataTransfer();
      data.items.add(
        new File([bytes], "잘못된 첨부.png", { type: "image/png" }),
      );
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", { value: data });
      element.dispatchEvent(event);
    }, oversized);
    await expect(detail(page).getByRole("alert")).toContainText(
      oversized ? "10MiB" : "PNG·JPEG·WebP",
    );
    await expect(rich(page)).toContainText("보존된 문서");
  }
  await sourceMode(page);
  const link = `/links/calendar/${randomUUID()}`;
  for (const href of [link, new URL(link, page.url()).href]) {
    await source(page).fill(`[시크릿 링크](${href})`);
    await documentSaved(page);
    await detail(page)
      .getByRole("button", { name: "리치 문서", exact: true })
      .click();
    await expect(source(page)).toBeVisible();
    await expect(source(page)).toHaveValue(`[시크릿 링크](${href})`);
  }
  await source(page).fill(
    `![서버 이미지](/api/document-images/${teamId}/${"a".repeat(64)}.webp)`,
  );
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(source(page)).toBeVisible();
  await expect(source(page)).toHaveValue(/서버 이미지/);
  expectPrivate(requests, title, "보존된 문서", "invalid private image");
});

test("시크릿 문서는 로컬 이미지를 넣어 내려받고 서버에 내용을 보내지 않는다", async ({
  page,
}) => {
  const title = `내려받기 ${randomUUID()}`,
    body = `비밀 본문 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  const requests = observe(page);
  await sourceMode(page);
  await source(page).fill(`# ${body}\n\n두 번째 문단\n`);
  await documentSaved(page);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page)).toContainText(body);
  await attachLocalImage(page, "paste");
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(1);
  await documentSaved(page);
  const download = async (item: string) => {
    await detail(page)
      .getByRole("button", { name: "다운로드", exact: true })
      .click();
    const saved = page.waitForEvent("download");
    await page
      .getByRole("menu", { name: "다운로드 형식", exact: true })
      .getByRole("menuitem", { name: item })
      .click();
    return saved;
  };
  const md = await download("Markdown (.md)");
  // The entry's title names the file.
  expect(md.suggestedFilename().normalize("NFC")).toBe(`${title}.md`);
  const markdown = await readFile((await md.path())!, "utf8");
  expect(markdown).toMatch(new RegExp(`^# ${body}\\n\\n두 번째 문단`));
  expect(markdown).toMatch(/!\[[^\]]*\]\(data:image\/[a-z]+;base64,/);
  expect(markdown).not.toContain("secret-image:");
  const html = await readFile(
    (await (await download("HTML (.html)")).path())!,
    "utf8",
  );
  expect(html).toMatch(/<img [^>]*src="data:image\//);
  expect(html).not.toContain("secret-image:");
  expectPrivate(requests, title, body);
});

// Guards link-title lookups as well: a pasted address is document content.
test("시크릿 문서에 붙여넣은 외부 주소는 어떤 서버 요청에도 실리지 않는다", async ({
  page,
}) => {
  const title = `주소 검증 ${randomUUID()}`,
    address = `https://example.com/secret-${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  const requests = observe(page);
  await rich(page).click();
  await rich(page).evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, address);
  await expect(rich(page)).toContainText(address);
  await documentSaved(page);
  await page.waitForTimeout(500);
  expect(
    requests.filter((request) => request.url().includes("/api/link-title")),
  ).toEqual([]);
  expectPrivate(requests, title, address);
});

test("일정이 하나도 없어도 비정상 종료 뒤 만료된 삭제 문서를 정리한다", async ({
  page,
}) => {
  const id = `secret:${randomUUID()}`;
  await page.evaluate(
    ({ userId, teamId, id }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(`weekly-plan:secret-documents:${userId}`);
        open.onupgradeneeded = () =>
          open.result.createObjectStore("documents", { keyPath: "id" });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction(
            ["documents", "images"],
            "readwrite",
          );
          transaction.objectStore("images").put({
            url: `secret-image:${crypto.randomUUID()}`,
            documentId: id,
            bytes: new Uint8Array([1, 2, 3]).buffer,
            mimeType: "image/png",
          });
          transaction.objectStore("documents").put({
            id,
            teamId,
            markdown: "정리할 삭제 문서",
            revision: 1,
            updatedAt: null,
            images: [],
            deletedAt: Date.now() - 25 * 60 * 60 * 1000,
          });
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
    { userId, teamId, id },
  );
  await page.reload();
  await expect.poll(() => localDocument(page, id)).toBeUndefined();
  expect(await localImages(page, id)).toEqual([]);
  await expect(page.locator("[data-secret]")).toHaveCount(0);
});

test("IndexedDB version 1 이미지 바이트를 분리 이전하고 편집기 동안만 표시 주소를 캐시한다", async ({
  page,
}) => {
  const title = `이전 문서 ${randomUUID()}`;
  const requests = observe(page);
  await create(page, title);
  const id = (await storedEntries(page))[0].id;
  // Leave the app to close its database connection before preparing the old schema.
  await page.goto("/api/health");
  const legacy = await page.evaluate(
    async ({ userId, teamId, id }) => {
      const name = `weekly-plan:secret-documents:${userId}`;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      const bytes = await blob.arrayBuffer();
      const images = [0, 1].map(() => ({
        url: `secret-image:${crypto.randomUUID()}`,
        bytes,
        mimeType: blob.type,
        createdAt: 1234,
      }));
      const markdown = `이전 본문\n\n![첫 이미지](${images[0].url})\n\n![같은 이미지](${images[0].url}#width=100)\n\n![둘째 이미지](${images[1].url})`;
      const deletedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () =>
          open.result.createObjectStore("documents", { keyPath: "id" });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("documents", "readwrite"),
            store = tx.objectStore("documents");
          store.put({
            id,
            teamId,
            markdown,
            images,
            revision: 7,
            updatedAt: "2026-11-05T00:00:00.000Z",
          });
          store.put({
            id: id + "-deleted",
            teamId,
            markdown: "실행취소 본문",
            images: [
              {
                ...images[0],
                url: `secret-image:${crypto.randomUUID()}`,
                unusedSince: 2345,
              },
            ],
            revision: 3,
            updatedAt: null,
            deletedAt,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      });
      return {
        markdown,
        urls: images.map((image) => image.url),
        bytes: Array.from(new Uint8Array(bytes)),
        deletedAt,
      };
    },
    { userId, teamId, id },
  );
  await page.addInitScript(() => {
    (window as any).secretImageReads = [];
    (window as any).secretImageConversions = 0;
    (window as any).secretTransactions = [];
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (this.name.startsWith("weekly-plan:secret-documents:"))
        (window as any).secretTransactions.push({
          version: this.version,
          stores: Array.from(tx.objectStoreNames),
        });
      return tx;
    };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (
        this.name === "images" &&
        this.transaction.db.name.startsWith("weekly-plan:secret-documents:")
      )
        (window as any).secretImageReads.push(key);
      return get.call(this, key);
    };
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      (window as any).secretImageConversions++;
      return read.call(this, blob);
    };
  });
  await page.goto("/calendar");
  await card(page, title).click();
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(3);
  const document = await localDocument(page, id);
  expect(document).toMatchObject({
    id,
    teamId,
    markdown: legacy.markdown,
    revision: 7,
    updatedAt: "2026-11-05T00:00:00.000Z",
  });
  expect(document.images).toEqual(
    legacy.urls.map((url) => ({
      url,
      mimeType: "image/png",
      createdAt: 1234,
      size: legacy.bytes.length,
    })),
  );
  const images = await localImages(page, id);
  expect(images).toHaveLength(2);
  for (const image of images)
    expect(image).toMatchObject({
      documentId: id,
      bytes: legacy.bytes,
      mimeType: "image/png",
    });
  expect(await localDocument(page, id + "-deleted")).toMatchObject({
    deletedAt: legacy.deletedAt,
    revision: 3,
    images: [{ unusedSince: 2345, size: legacy.bytes.length }],
  });
  expect(await localImages(page, id + "-deleted")).toHaveLength(1);
  expect(
    await page.evaluate(() => (window as any).secretImageReads),
  ).toHaveLength(2);
  expect(
    await page.evaluate(() => (window as any).secretImageConversions),
  ).toBe(2);
  await sourceMode(page);
  await page.evaluate(() => {
    (window as any).secretTransactions = [];
  });
  await source(page).fill(legacy.markdown + "\n수정");
  await documentSaved(page);
  const transactions = await page.evaluate(
    () => (window as any).secretTransactions,
  );
  expect(transactions.length).toBeGreaterThan(0);
  for (const tx of transactions)
    expect(tx).toEqual({ version: 2, stores: ["documents"] });
  expect(
    await page.evaluate(() => (window as any).secretImageReads),
  ).toHaveLength(2);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(3);
  expect(
    await page.evaluate(() => (window as any).secretImageReads),
  ).toHaveLength(2);
  expect(
    await page.evaluate(() => (window as any).secretImageConversions),
  ).toBe(2);
  await closeDetail(page);
  await card(page, title).click();
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(3);
  expect(
    await page.evaluate(() => (window as any).secretImageReads),
  ).toHaveLength(4);
  expect(
    await page.evaluate(() => (window as any).secretImageConversions),
  ).toBe(4);
  await closeDetail(page);
  await page.reload();
  await card(page, title).click();
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(3);
  await expect(rich(page)).toContainText("수정");
  expectPrivate(requests, title, "이전 본문", "실행취소 본문");
});

test("24시간 미사용 이미지만 문서 메타데이터와 함께 정리한다", async ({
  page,
}) => {
  const title = `미사용 정리 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  await attachLocalImage(page, "paste");
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(1);
  await documentSaved(page);
  const id = (await storedEntries(page))[0].id;
  await sourceMode(page);
  const urls = await page.evaluate(
    ({ userId, id }) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(`weekly-plan:secret-documents:${userId}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction(["documents", "images"], "readwrite"),
            docs = tx.objectStore("documents"),
            images = tx.objectStore("images");
          const get = docs.get(id);
          const urls: string[] = [];
          get.onsuccess = () => {
            const doc = get.result;
            const original = images.get(doc.images[0].url);
            original.onsuccess = () => {
              for (const unusedSince of [
                Date.now() - 25 * 3600000,
                Date.now(),
              ]) {
                const url = `secret-image:${crypto.randomUUID()}`;
                urls.push(url);
                doc.images.push({ ...doc.images[0], url, unusedSince });
                images.put({ ...original.result, url });
              }
              docs.put(doc);
            };
          };
          tx.oncomplete = () => {
            db.close();
            resolve(urls);
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    { userId, id },
  );
  const markdown = await source(page).inputValue();
  await source(page).fill(markdown + "\n정리 후 본문");
  await documentSaved(page);
  expect(
    (await localDocument(page, id)).images.map((image: any) => image.url),
  ).not.toContain(urls[0]);
  const images = await localImages(page, id);
  expect(images).toHaveLength(2);
  expect(images.map((image) => image.url)).not.toContain(urls[0]);
  expect(images.map((image) => image.url)).toContain(urls[1]);
  await closeDetail(page);
  await page.reload();
  await card(page, title).click();
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(1);
});

test("이미지 업로드 중 메타데이터 저장 실패는 두 저장소를 함께 되돌린다", async ({
  page,
}) => {
  const title = `이미지 원자성 ${randomUUID()}`;
  await create(page, title);
  await card(page, title).click();
  await sourceMode(page);
  await source(page).fill("원래 본문");
  await documentSaved(page);
  const id = (await storedEntries(page))[0].id;
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as any).restoreSecretPut = () => {
      IDBObjectStore.prototype.put = put;
    };
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.name === "documents" &&
        this.transaction.db.name.startsWith("weekly-plan:secret-documents:")
      )
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await attachLocalImage(page, "paste");
  await expect(detail(page).getByRole("alert")).toContainText(
    "브라우저 저장 공간",
  );
  expect((await localDocument(page, id)).images).toEqual([]);
  expect(await localImages(page, id)).toEqual([]);
  await expect(rich(page)).toContainText("원래 본문");
  await page.evaluate(() => (window as any).restoreSecretPut());
  await attachLocalImage(page, "paste");
  await expect(rich(page).locator("img[src^='data:image/']")).toHaveCount(1);
  await documentSaved(page);
  expect(await localImages(page, id)).toHaveLength(1);
});

async function expectDisplayOrder(page: Page, ids: string[]) {
  let previousTop = -Infinity;
  for (const [index, id] of ids.entries()) {
    const segment = page.locator(`[data-entry-id="${id}"]`).first();
    await expect(segment).toHaveAttribute("data-entry-lane", String(index));
    const top = (await segment.boundingBox())!.y;
    expect(top).toBeGreaterThan(previousTop);
    previousTop = top;
  }
}
async function dragOrder(page: Page, id: string, targetId: string) {
  const segment = (id: string) =>
    page.locator(`[data-entry-id="${id}"]`).first();
  const body = segment(id).locator(".calendar-entry-card");
  await body.scrollIntoViewIfNeeded();
  const from = (await body.boundingBox())!,
    to = (await segment(targetId).boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, to.y + from.height / 2, { steps: 12 });
  const preview = page.locator(".is-drag-preview").first();
  await expect(preview).toBeVisible();
  const lane = await preview.getAttribute("data-entry-lane");
  const previewTop = (await preview.boundingBox())!.y;
  await page.mouse.up();
  await expect(segment(id)).toHaveAttribute("data-entry-lane", lane!);
  expect(
    Math.abs((await segment(id).boundingBox())!.y - previewTop),
  ).toBeLessThanOrEqual(1);
}

test("시크릿 생성·연속 복제는 표시 맨 아래에 번호 순으로 쌓이고 탭과 새로고침에 유지된다", async ({
  page,
  context,
}) => {
  const server = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "맨 위 일반 일정",
  });
  await page.reload();
  const title = `순서 복제 ${randomUUID()}`;
  const requests = observe(page);
  await create(page, title);
  const original = (await storedEntries(page))[0].id;
  const ids = [server.id, original];
  for (let i = 1; i <= 3; i++) {
    await page
      .locator(`[data-entry-id="${original}"] .calendar-entry-card`)
      .first()
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "일정 복제", exact: true })
      .click();
    await expect
      .poll(async () => (await storedEntries(page)).length)
      .toBe(i + 1);
    ids.push(
      (await storedEntries(page)).find(
        (entry: any) => entry.title === `${title} (${i})`,
      ).id,
    );
    await expectDisplayOrder(page, ids);
  }
  // Editing the first card must not replace its creation tie breaker.
  const orders = (await storedEntries(page)).map((entry: any) => entry.order);
  await page
    .locator(`[data-entry-id="${original}"] .calendar-entry-card`)
    .first()
    .click();
  await detail(page)
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill(title + " 수정");
  await closeDetail(page);
  expect((await storedEntries(page)).map((entry: any) => entry.order)).toEqual(
    orders,
  );
  await create(page, "나중에 만든 시크릿");
  ids.push(
    (await storedEntries(page)).find(
      (entry: any) => entry.title === "나중에 만든 시크릿",
    ).id,
  );
  await expectDisplayOrder(page, ids);
  const peer = await context.newPage();
  await peer.goto("/calendar");
  await expectDisplayOrder(peer, ids);
  await page.reload();
  await expectDisplayOrder(page, ids);
  expectPrivate(requests, title, "나중에 만든 시크릿");
  await peer.close();
});

test("여러 날의 혼합 카드 사이로 시크릿을 끌고 일반 순서는 시크릿을 제외해 저장한다", async ({
  page,
  context,
}) => {
  const servers = [];
  for (const title of ["일반 위", "일반 아래"])
    servers.push(
      await request(page, "/calendar/entries", "POST", {
        id: randomUUID(),
        teamId,
        userId,
        date: todayKey(),
        endDate: addDays(todayKey(), 2),
        title,
      }),
    );
  await page.reload();
  const requests = observe(page);
  const locals = [];
  for (const title of ["시크릿 첫째", "시크릿 둘째", "시크릿 셋째"]) {
    await create(page, title);
    await card(page, title).click();
    await detail(page)
      .getByLabel("일정 종료일", { exact: true })
      .fill(addDays(todayKey(), 2));
    await closeDetail(page);
    locals.push(
      (await storedEntries(page)).find((entry: any) => entry.title === title)
        .id,
    );
  }
  const [s0, s1] = servers.map((entry) => entry.id),
    [a, b, c] = locals;
  await expectDisplayOrder(page, [s0, s1, a, b, c]);
  const peer = await context.newPage();
  await peer.goto("/calendar");
  const peerRequests = observe(peer);
  await dragOrder(page, c, s1);
  await expectDisplayOrder(page, [s0, c, s1, a, b]);
  await expectDisplayOrder(peer, [s0, c, s1, a, b]);
  await page.reload();
  await expectDisplayOrder(page, [s0, c, s1, a, b]);
  const body = page
    .locator(`[data-entry-id="${b}"] .calendar-entry-card`)
    .first();
  await expect(body).toHaveAccessibleDescription(
    /시크릿 일정은 Alt와 위아래 방향키로도 순서를 변경합니다/,
  );
  await body.press("Alt+ArrowUp");
  await expectDisplayOrder(page, [s0, c, s1, b, a]);
  await body.press("Alt+ArrowUp");
  await expectDisplayOrder(page, [s0, c, b, s1, a]);
  await dragOrder(page, a, s0);
  await expectDisplayOrder(page, [a, s0, c, b, s1]);
  await expectDisplayOrder(peer, [a, s0, c, b, s1]);
  expectPrivate(
    [...requests, ...peerRequests],
    "시크릿 첫째",
    "시크릿 둘째",
    "시크릿 셋째",
  );
  const writes: Request[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().includes("/calendar/entries/")
    )
      writes.push(request);
  });
  await dragOrder(page, s1, a);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].postDataJSON()).toMatchObject({ lane: 0, expectedLane: 1 });
  expect(writes[0].postData()).not.toContain("secret:");
  await expectDisplayOrder(page, [a, s1, c, b, s0]);
  await page
    .getByRole("button", { name: "시크릿 일정 숨기기", exact: true })
    .click();
  await expectDisplayOrder(page, [s1, s0]);
  expect((await request(page, `/calendar/entries/${s1}`)).lane).toBe(0);
  expect((await request(page, `/calendar/entries/${s0}`)).lane).toBe(1);
  await page.reload();
  await expectDisplayOrder(page, [s1, s0]);
  await page
    .getByRole("button", { name: "시크릿 일정 보이기", exact: true })
    .click();
  await expectDisplayOrder(page, [a, s1, c, b, s0]);
  await peer.close();
});

test("팀 월간은 시크릿 토글·생성 스위치를 숨기고 개인 월간·팀 주간은 선택을 유지한다", async ({
  page,
  browserName,
}) => {
  const title = `보기 전환 ${randomUUID()}`;
  const requests = observe(page);
  const toggle = page.locator(".calendar-secret-toggle");
  const search = page.getByRole("searchbox", { name: "일정 제목 검색" });
  const tabKey =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await create(page, title);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const stored = await page.evaluate((key) => localStorage.getItem(key), key());
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).click();
  await expect(toggle).toHaveCount(0);
  await expect(card(page, title)).toHaveCount(0);
  await page
    .getByRole("button", { name: "다음 달", exact: true })
    .press(tabKey);
  await expect(search).toBeFocused();
  await page
    .locator(`.calendar-day[data-date="${todayKey()}"][data-owner-id="team"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  await expect(createDialog(page)).toBeVisible();
  await expect(
    createDialog(page).getByRole("switch", { name: "시크릿 일정" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(createDialog(page)).toHaveCount(0);
  await page.reload();
  // Reload uses the existing personal-month default; only visibility persists.
  await expect(
    page.getByRole("button", { name: "개인 월간 보기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "팀 월간 보기", exact: true }).click();
  await expect(toggle).toHaveCount(0);
  const mine = page.locator(
    `.calendar-team-section[data-member-id="${userId}"]`,
  );
  for (const view of [
    "개인 월간 보기",
    "팀 주간 일정 보기",
    "개인 월간 보기",
  ]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(card(page, title)).toHaveCount(0);
    await toggle.press(tabKey);
    // The team week keeps it left of the user's own week dates.
    await expect(
      view === "팀 주간 일정 보기"
        ? mine.getByRole("button", { name: /이전 주$/ })
        : search,
    ).toBeFocused();
    expect(await page.evaluate((key) => localStorage.getItem(key), key())).toBe(
      stored,
    );
  }
  await toggle.click();
  await expect(card(page, title)).toBeVisible();
  expectPrivate(requests, title);
});

test("시크릿 토글은 내 개인 월간과 팀 주간의 내 주간 날짜 왼쪽에만 있다", async ({
  page,
}, testInfo) => {
  const toggle = page.locator(".calendar-secret-toggle");
  const toolbar = page.locator(".calendar-toolbar");
  await expect(toolbar.locator(".calendar-secret-toggle")).toHaveCount(1);
  // Another member's personal month has no secret entries to show or hide.
  await page
    .locator(`.calendar-owner-button[data-member-id="${memberId}"]`)
    .click();
  await expect(toggle).toHaveCount(0);
  await page
    .locator(`.calendar-owner-button[data-member-id="${userId}"]`)
    .click();
  await expect(toolbar.locator(".calendar-secret-toggle")).toHaveCount(1);

  await page
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  const mine = page.locator(
    `.calendar-team-section[data-member-id="${userId}"]`,
  );
  await expect(toggle).toHaveCount(1);
  await expect(toolbar.locator(".calendar-secret-toggle")).toHaveCount(0);
  await expect(
    page
      .locator(`.calendar-team-section[data-member-id="${memberId}"]`)
      .locator(".calendar-secret-toggle"),
  ).toHaveCount(0);
  const navigation = mine.locator(".calendar-member-navigation");
  await expect(navigation.locator(".calendar-secret-toggle")).toBeVisible();
  const box = (await toggle.boundingBox())!;
  const dates = (await navigation
    .locator(".calendar-period-control")
    .boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(dates.x);
  expect(
    Math.abs(box.y + box.height / 2 - dates.y - dates.height / 2),
  ).toBeLessThanOrEqual(1);
  await mine.screenshot({ path: testInfo.outputPath("secret-team-week.png") });

  // Moving another member's week keeps the toggle in the user's own section,
  // and the personal month that follows is that member's.
  await page
    .locator(`.calendar-team-section[data-member-id="${memberId}"]`)
    .getByRole("button", { name: /다음 주$/ })
    .click();
  await expect(navigation.locator(".calendar-secret-toggle")).toHaveCount(1);
  await page
    .getByRole("button", { name: "개인 월간 보기", exact: true })
    .click();
  await expect(toggle).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "팀 주간 일정 보기", exact: true })
    .click();
  await expect(navigation.locator(".calendar-secret-toggle")).toBeInViewport({
    ratio: 1,
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await mine.screenshot({
    path: testInfo.outputPath("secret-team-week-mobile.png"),
  });
});
