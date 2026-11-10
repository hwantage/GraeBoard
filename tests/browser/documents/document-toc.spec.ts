import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { todayKey } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskIds: string[];
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    data,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
async function save(page: Page, id: string, markdown: string) {
  return request(page, `/tasks/${id}/documents/main`, "PUT", {
    markdown,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (scope: Locator) =>
  scope.getByRole("textbox", { name: /리치 편집$/ });
const tocButton = (scope: Locator) =>
  scope.getByRole("button", { name: "목차", exact: true });
const toc = (scope: Locator) =>
  scope.getByRole("complementary", { name: "목차", exact: true });
const items = (scope: Locator) => toc(scope).locator(".document-toc-list li");
async function open(page: Page, id = taskIds[0]) {
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  await expect(detail(page)).toBeVisible();
  const start = detail(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(rich(detail(page)).or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(rich(detail(page))).toBeVisible();
}
const indents = (scope: Locator) =>
  items(scope)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => parseFloat(getComputedStyle(button).paddingLeft)),
    );
// The heading's top against the bottom of the rows pinned above the text.
async function headingGap(scope: Locator, heading: Locator, pinned: Locator) {
  const [box, bar] = await Promise.all([
    heading.boundingBox(),
    pinned.boundingBox(),
  ]);
  return box!.y - (bar!.y + bar!.height);
}
const screenshots = process.env.TOC_SCREENSHOTS;

const markdown = [
  "# 전체 아키텍처",
  "개요 문단입니다.",
  "## 1. Slack 연결",
  ...Array(20).fill("Slack 앱을 만들고 이벤트 구독을 설정합니다."),
  "### 토큰과 권한 범위를 확인하는 아주 긴 세부 설정 제목입니다",
  ...Array(20).fill("필요한 권한을 차례로 확인합니다."),
  "## 2. Codex CLI 준비",
  ...Array(20).fill("CLI를 설치하고 로그인합니다."),
  "<details open>\n<summary><h2>토글 제목</h2></summary>\n\n### 토글 안 제목\n\n토글 본문입니다.\n\n</details>",
  "#### 네 번째 수준",
  "##### 다섯 번째 수준",
  "###### 여섯 번째 수준",
  ...Array(30).fill("마무리 문단입니다."),
].join("\n\n");
const titles = [
  "전체 아키텍처",
  "1. Slack 연결",
  "토큰과 권한 범위를 확인하는 아주 긴 세부 설정 제목입니다",
  "2. Codex CLI 준비",
  "토글 제목",
  "토글 안 제목",
  "네 번째 수준",
  "다섯 번째 수준",
  "여섯 번째 수준",
];

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
  const boot = await request(page, "/bootstrap");
  userId = boot.user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `목차 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["목차 업무", "빈 업무"])
    taskIds.push(
      (
        await request(page, "/tasks", "POST", {
          teamId,
          year: 2026,
          fields: { title },
        })
      ).task.id,
    );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("목차는 리치 문서 오른쪽에 열고 닫으며 제목으로 이동한다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], markdown);
  await open(page);
  const body = detail(page).locator(".modal-body");
  const tools = detail(page).locator(".document-rich-tools");
  const button = tocButton(detail(page));
  // The button ends the toolbar, right of the mode switch and the download
  // button.
  await expect(tools.getByRole("button", { name: "목차" })).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  const modes = detail(page).getByRole("group", { name: "문서 편집 모드" });
  const [buttonBox, modesBox, downloadBox, toolsBox] = await Promise.all([
    button.boundingBox(),
    modes.boundingBox(),
    tools.getByRole("button", { name: "다운로드", exact: true }).boundingBox(),
    tools.boundingBox(),
  ]);
  expect(modesBox!.x + modesBox!.width).toBeLessThanOrEqual(downloadBox!.x);
  expect(downloadBox!.x - (modesBox!.x + modesBox!.width)).toBeLessThan(12);
  expect(downloadBox!.x + downloadBox!.width).toBeLessThanOrEqual(buttonBox!.x);
  expect(buttonBox!.x - (downloadBox!.x + downloadBox!.width)).toBeLessThan(12);
  expect(buttonBox!.x + buttonBox!.width).toBeGreaterThan(
    toolsBox!.x + toolsBox!.width - 24,
  );
  await expect(toc(detail(page))).toHaveCount(0);

  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(toc(detail(page))).toBeVisible();
  await expect(items(detail(page))).toHaveText(titles);
  // Indented by level from the highest level in the document.
  expect(await indents(detail(page))).toEqual([
    8, 20, 32, 20, 20, 32, 44, 56, 68,
  ]);
  const long = items(detail(page)).nth(2).getByRole("button");
  await expect(long).toHaveAttribute("title", titles[2]);
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  // The pane is on the right of the text, which keeps the rest of the width.
  const [paneBox, proseBox] = await Promise.all([
    toc(detail(page)).boundingBox(),
    rich(detail(page)).boundingBox(),
  ]);
  expect(paneBox!.x).toBeGreaterThanOrEqual(proseBox!.x + proseBox!.width);
  expect(paneBox!.width).toBeCloseTo(240, 0);
  expect(paneBox!.x + paneBox!.width).toBeCloseTo(
    toolsBox!.x + toolsBox!.width,
    0,
  );

  // The header holds the title and the close button only.
  await expect(
    toc(detail(page)).locator(".document-toc-header").getByRole("button"),
  ).toHaveCount(1);

  // A heading scrolls to the top of the detail, below the pinned toolbar.
  const target = rich(detail(page)).getByRole("heading", {
    name: "2. Codex CLI 준비",
  });
  await items(detail(page))
    .getByRole("button", { name: "2. Codex CLI 준비" })
    .click();
  await expect
    .poll(() => headingGap(detail(page), target, tools))
    .toBeGreaterThanOrEqual(0);
  expect(await headingGap(detail(page), target, tools)).toBeLessThan(40);
  await expect(
    items(detail(page)).getByRole("button", { name: "2. Codex CLI 준비" }),
  ).toHaveAttribute("aria-current", "location");
  // The pane stays beside the text while it scrolls.
  const pinnedPane = (await toc(detail(page))
    .locator(".document-toc-panel")
    .boundingBox())!;
  const toolsNow = (await tools.boundingBox())!;
  expect(
    Math.abs(pinnedPane.y - (toolsNow.y + toolsNow.height)),
  ).toBeLessThanOrEqual(1);
  // Scrolling marks the heading now at the top.
  await body.evaluate((el) => (el.scrollTop = 0));
  await expect(
    items(detail(page)).getByRole("button", { name: "전체 아키텍처" }),
  ).toHaveAttribute("aria-current", "location");
  if (screenshots)
    await detail(page).screenshot({ path: `${screenshots}/toc-desktop.png` });
  await detail(page).screenshot({ path: info.outputPath("toc-desktop.png") });

  // A heading inside a folded toggle opens it in this view without saving.
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") writes.push(request.url());
  });
  const toggle = rich(detail(page)).locator(".document-toggle");
  await toggle.getByRole("button", { name: "토글 접기", exact: true }).click();
  const inner = rich(detail(page)).getByRole("heading", {
    name: "토글 안 제목",
  });
  await expect(inner).toBeHidden();
  await items(detail(page))
    .getByRole("button", { name: "토글 안 제목" })
    .click();
  await expect(inner).toBeVisible();
  await expect
    .poll(() => headingGap(detail(page), inner, tools))
    .toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(900);
  expect(writes).toEqual([]);

  // The pane's X and the button both close it.
  await toc(detail(page))
    .getByRole("button", { name: "목차 닫기", exact: true })
    .click();
  await expect(toc(detail(page))).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(toc(detail(page))).toBeVisible();
  // Its filter starts over each time it opens.
  await expect(items(detail(page))).toHaveCount(titles.length);
  await button.click();
  await expect(toc(detail(page))).toHaveCount(0);

  // The source has no contents button; the rich view brings it back.
  await button.click();
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    detail(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toBeVisible();
  await expect(tocButton(detail(page))).toHaveCount(0);
  await expect(toc(detail(page))).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(detail(page))).toContainText("전체 아키텍처");
  await expect(toc(detail(page))).toBeVisible();
  // Esc in the pane closes it, not the detail, and focus returns to the button.
  await items(detail(page)).first().getByRole("button").focus();
  await page.keyboard.press("Escape");
  await expect(toc(detail(page))).toHaveCount(0);
  await expect(detail(page)).toBeVisible();
  await expect(tocButton(detail(page))).toBeFocused();
});

test("편집 중 목차는 새 제목을 바로 반영하고 제목이 없으면 안내한다", async ({
  page,
}) => {
  await open(page, taskIds[1]);
  await tocButton(detail(page)).click();
  await expect(toc(detail(page)).locator(".document-toc-empty")).toHaveText(
    "제목이 없습니다",
  );
  await rich(detail(page)).click();
  await page.keyboard.type("# 첫 제목");
  await page.keyboard.press("Enter");
  await page.keyboard.type("본문");
  await expect(items(detail(page))).toHaveText(["첫 제목"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("## 둘째 제목");
  await expect(items(detail(page))).toHaveText(["첫 제목", "둘째 제목"]);
  expect(await indents(detail(page))).toEqual([8, 20]);
  // Jumping while editing puts the caret at the heading's start.
  await items(detail(page)).getByRole("button", { name: "첫 제목" }).click();
  await page.keyboard.type("새 ");
  await expect(items(detail(page))).toHaveText(["새 첫 제목", "둘째 제목"]);
  await expect
    .poll(
      async () =>
        (await request(page, `/tasks/${taskIds[1]}/documents/main`)).markdown,
    )
    .toBe("# 새 첫 제목\n\n본문\n\n## 둘째 제목\n");
});

test("열람자도 목차를 열어 제목으로 이동하고 좁은 화면에서는 본문 위에 겹친다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], markdown);
  const username = `toc-viewer-${randomUUID()}@example.com`;
  await request(page, "/admin/users", "POST", {
    username,
    password: "local-test-only-password",
    name: "목차 열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await request(page, "/auth/login", "POST", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await page
    .locator(`[data-cell="${taskIds[0]}:title"] .task-document-indicator`)
    .click();
  await expect(rich(detail(page))).toHaveAttribute("contenteditable", "false");
  // Read-only, the button is beside the mode switch on the tab row.
  const tabs = detail(page).locator(".document-tabs");
  await expect(tabs.getByRole("button", { name: "목차" })).toBeVisible();
  await tocButton(detail(page)).click();
  await expect(items(detail(page))).toHaveText(titles);
  const target = rich(detail(page)).getByRole("heading", {
    name: "1. Slack 연결",
  });
  await items(detail(page))
    .getByRole("button", { name: "1. Slack 연결" })
    .click();
  await expect
    .poll(() => headingGap(detail(page), target, tabs))
    .toBeGreaterThanOrEqual(0);
  expect(await headingGap(detail(page), target, tabs)).toBeLessThan(40);
  await expect(tocButton(detail(page))).toHaveAttribute("aria-pressed", "true");

  // At phone width the pane covers the text's right edge instead of
  // narrowing it, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tocButton(detail(page))).toBeVisible();
  await expect(toc(detail(page))).toHaveAttribute("data-overlay", "");
  const [paneBox, proseBox, shellBox, dialogBox] = await Promise.all([
    toc(detail(page)).boundingBox(),
    detail(page).locator(".document-prose").boundingBox(),
    detail(page).locator(".rich-document").boundingBox(),
    detail(page).boundingBox(),
  ]);
  expect(proseBox!.width).toBeCloseTo(shellBox!.width, 0);
  expect(paneBox!.x + paneBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width + 1,
  );
  expect(paneBox!.x).toBeGreaterThan(dialogBox!.x);
  expect(
    await detail(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await items(detail(page))
    .getByRole("button", { name: "2. Codex CLI 준비" })
    .click();
  const next = rich(detail(page)).getByRole("heading", {
    name: "2. Codex CLI 준비",
  });
  await expect
    .poll(() => headingGap(detail(page), next, tabs))
    .toBeGreaterThanOrEqual(0);
  expect(await headingGap(detail(page), next, tabs)).toBeLessThan(40);
  if (screenshots)
    await page.screenshot({ path: `${screenshots}/toc-mobile.png` });
  await page.screenshot({ path: info.outputPath("toc-mobile.png") });
  await toc(detail(page))
    .getByRole("button", { name: "목차 닫기", exact: true })
    .click();
  await expect(toc(detail(page))).toHaveCount(0);
});

test("일정 문서와 메모 카드·전체 페이지에도 목차가 있다", async ({ page }) => {
  const entry = await request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    date: todayKey(),
    title: "목차 일정",
  });
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.goto(`/links/calendar/${entry.id}`);
  const calendar = page.getByRole("dialog", {
    name: "캘린더 일정",
    exact: true,
  });
  await expect(rich(calendar)).toContainText("전체 아키텍처");
  await expect(
    calendar.locator(".document-rich-tools").getByRole("button", {
      name: "목차",
    }),
  ).toBeVisible();
  await tocButton(calendar).click();
  await expect(items(calendar)).toHaveText(titles);
  const tools = calendar.locator(".document-rich-tools");
  const heading = rich(calendar).getByRole("heading", {
    name: "2. Codex CLI 준비",
  });
  await items(calendar)
    .getByRole("button", { name: "2. Codex CLI 준비" })
    .click();
  await expect
    .poll(() => headingGap(calendar, heading, tools))
    .toBeGreaterThanOrEqual(0);
  expect(await headingGap(calendar, heading, tools)).toBeLessThan(40);
  // At phone width the mode row keeps the mode and contents controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(calendar.locator(".document-rich-tools")).toBeHidden();
  await expect(calendar.locator(".document-modes")).toBeVisible();
  await expect(
    calendar.locator(".document-mode-bar").getByRole("button", {
      name: "목차",
    }),
  ).toBeVisible();
  await expect(toc(calendar)).toHaveAttribute("data-overlay", "");
  await page.setViewportSize({ width: 1366, height: 900 });

  const year = 2026;
  const memoId = randomUUID(),
    memos = `/teams/${teamId}/years/${year}/memos`;
  await request(page, memos, "POST", { id: memoId, title: "목차 메모" });
  await request(page, `${memos}/${memoId}`, "PUT", {
    markdown,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  const panel = page.getByRole("region", { name: "연간 업무 메모 목록" });
  await panel.locator(".toggle-memos").click();
  const card = panel.locator(".memo-document-card").first();
  await expect(rich(card)).toContainText("전체 아키텍처");
  await tocButton(card).click();
  await expect(items(card)).toHaveText(titles);
  // Headings outside the task detail never fall below the text, and each
  // level stays at least the size of the next.
  const sizes = await rich(card).evaluate((element) => {
    const size = (selector: string) =>
      parseFloat(getComputedStyle(element.querySelector(selector)!).fontSize);
    return ["p", "h1", "h2", "h3", "h4", "h5", "h6"].map(size);
  });
  const [text, ...levels] = sizes;
  for (const level of levels) expect(level).toBeGreaterThanOrEqual(text);
  for (let index = 1; index < levels.length; index++)
    expect(levels[index]).toBeLessThanOrEqual(levels[index - 1]);
  const memoHeading = rich(card).getByRole("heading", {
    name: "2. Codex CLI 준비",
  });
  await items(card).getByRole("button", { name: "2. Codex CLI 준비" }).click();
  await expect
    .poll(() =>
      headingGap(card, memoHeading, card.locator(".document-rich-tools")),
    )
    .toBeGreaterThanOrEqual(0);
  // A narrow card keeps its text width; the pane covers the right edge.
  await card.locator(".memo-width-handle").focus();
  await page.keyboard.press("Home");
  await expect(toc(card)).toHaveAttribute("data-overlay", "");
  const [paneBox, cardBox] = await Promise.all([
    toc(card).boundingBox(),
    card.boundingBox(),
  ]);
  expect(paneBox!.x).toBeGreaterThan(cardBox!.x);
  expect(paneBox!.x + paneBox!.width).toBeLessThanOrEqual(
    cardBox!.x + cardBox!.width + 1,
  );

  await page.goto(`/links/memo/${teamId}/${year}/${memoId}`);
  const memo = page.getByRole("dialog", { name: "목차 메모", exact: true });
  await expect(rich(memo)).toContainText("전체 아키텍처");
  await tocButton(memo).click();
  await expect(items(memo)).toHaveText(titles);
  await expect(toc(memo)).not.toHaveAttribute("data-overlay", "");
});
