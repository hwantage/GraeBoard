import { test, expect, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, taskIds: string[];
async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/api${path}`, { headers, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
async function get(page: Page, path: string) {
  const res = await page.request.get(`/api${path}`);
  expect(res.ok()).toBeTruthy();
  return res.json().then(unpack);
}
async function save(page: Page, id: string, markdown: string, revision = 0) {
  const res = await page.request.put(`/api/tasks/${id}/documents/main`, {
    headers,
    data: { markdown, expectedRevision: revision, operationId: randomUUID() },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
const document = (page: Page, id = taskIds[0]) =>
  get(page, `/tasks/${id}/documents/main`);
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
const source = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" });
const slashMenu = (page: Page) =>
  detail(page).getByRole("listbox", { name: "편집 형식 선택" });
const exact = (markdown: string) =>
  new RegExp(`^${markdown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?$`);
async function open(page: Page, id = taskIds[0]) {
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  await expect(detail(page)).toBeVisible();
  const start = detail(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(rich(page).or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(rich(page)).toBeVisible();
}
async function raw(page: Page) {
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(source(page)).toBeVisible();
}
async function richMode(page: Page) {
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page)).toBeVisible();
}
async function close(page: Page) {
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
}
async function settleRichSelection(page: Page) {
  // Native caret movements reach ProseMirror through selectionchange.
  await rich(page).evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
async function pasteImage(page: Page, color = "#408378") {
  await rich(page).focus();
  await rich(page).evaluate((element, color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 320, 180);
    const bytes = Uint8Array.from(
      atob(canvas.toDataURL("image/png").split(",")[1]),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "붙여넣기.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    // Firefox drops files from the constructor's synthetic clipboard clone.
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, color);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await post(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await get(page, "/bootstrap");
  teamId = (
    await post(page, "/admin/teams", {
      name: `블록 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["토글 업무", "메뉴 업무"])
    taskIds.push(
      (await post(page, "/tasks", { teamId, year: 2026, fields: { title } }))
        .task.id,
    );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("토글은 / 메뉴와 문서 블록으로 만들고 접고 펼치며 details HTML로 저장한다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("/토글");
  await expect(slashMenu(page).getByRole("option")).toHaveText([
    "토글",
    "토글 제목 1",
    "토글 제목 2",
    "토글 제목 3",
  ]);
  await page.keyboard.press("Enter");
  const toggle = rich(page).locator(".document-toggle");
  await expect(toggle).toHaveCount(1);
  await expect(slashMenu(page)).toHaveCount(0);
  await expect(rich(page)).not.toContainText("/토글");
  await rich(page).pressSequentially("접는 제목");
  await expect(toggle.locator(".document-toggle-summary")).toHaveText(
    "접는 제목",
  );
  await page.keyboard.press("Enter");
  await rich(page).pressSequentially("숨긴 내용");
  await expect(toggle.locator(".document-toggle-content p")).toHaveText(
    "숨긴 내용",
  );
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain(
      "<details open>\n<summary>접는 제목</summary>\n\n숨긴 내용\n\n</details>",
    );
  // Folding changes only this view, as in Notion: nothing is saved, and the
  // fold stays while the rest of the document is edited.
  const folded = (await document(page)).revision;
  const writes: string[] = [];
  const recordWrite = (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/documents/"))
      writes.push(request.url());
  };
  page.on("request", recordWrite);
  await toggle.getByRole("button", { name: "토글 접기", exact: true }).click();
  await expect(toggle.locator(".document-toggle-content")).toBeHidden();
  await expect(
    toggle.getByRole("button", { name: "토글 펼치기", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("data-open", "true");
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
  await page.waitForTimeout(1000);
  expect(writes).toEqual([]);
  expect((await document(page)).revision).toBe(folded);
  page.off("request", recordWrite);
  await toggle.locator(".document-toggle-title").click();
  await settleRichSelection(page);
  await page.keyboard.press("End");
  await page.keyboard.insertText("!");
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain("<details open>\n<summary>접는 제목!</summary>");
  await expect(toggle.locator(".document-toggle-content")).toBeHidden();
  await raw(page);
  await expect(source(page)).toHaveValue(
    /<details open>\n<summary>접는 제목!<\/summary>\n\n숨긴 내용\n\n<\/details>/,
  );
  await richMode(page);
  // A new view opens the toggle as stored.
  await expect(toggle.locator(".document-toggle-content p")).toBeVisible();
  await toggle.getByRole("button", { name: "토글 접기", exact: true }).click();
  await expect(toggle.locator(".document-toggle-content")).toBeHidden();
  await toggle
    .getByRole("button", { name: "토글 펼치기", exact: true })
    .click();
  await expect(toggle.locator(".document-toggle-content p")).toBeVisible();
  await toggle.locator(".document-toggle-title").click();
  await settleRichSelection(page);
  await detail(page)
    .getByRole("combobox", { name: "문서 블록" })
    .selectOption("toggle2");
  await expect(rich(page).locator("h2.document-toggle-summary")).toHaveText(
    "접는 제목!",
  );
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain("<summary><h2>접는 제목!</h2></summary>");
  await detail(page)
    .getByRole("combobox", { name: "문서 블록" })
    .selectOption("paragraph");
  await expect(toggle).toHaveCount(0);
  await expect(rich(page).locator(":scope > p").first()).toHaveText(
    "접는 제목!",
  );
  await expect(rich(page)).toContainText("숨긴 내용");
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(toggle).toHaveCount(1);
  await close(page);

  // Markdown written elsewhere: same-line bodies, inline marks, nesting and
  // the closed state all open in the rich editor. Unfolding saves nothing.
  const elsewhere =
    "앞 문단\n\n<details>\n<summary>**굵은** 제목</summary>\n내용 한 줄\n\n* 목록 항목\n\n<details open>\n<summary><h3>안쪽</h3></summary>\n\n안쪽 내용\n\n</details>\n\n</details>\n\n뒤 문단";
  await save(page, taskIds[1], elsewhere);
  await open(page, taskIds[1]);
  const outer = rich(page).locator(":scope > .document-toggle");
  await expect(outer).toHaveCount(1);
  await expect(outer).toHaveAttribute("data-open", "false");
  await expect(outer.locator("> .document-toggle-summary strong")).toHaveText(
    "굵은",
  );
  await outer.getByRole("button", { name: "토글 펼치기", exact: true }).click();
  await expect(outer.locator(".document-toggle-content li")).toHaveText(
    "목록 항목",
  );
  await expect(
    outer.locator(".document-toggle h3.document-toggle-summary"),
  ).toHaveText("안쪽");
  await raw(page);
  await expect(source(page)).toHaveValue(exact(elsewhere));
  await close(page);
  expect((await document(page, taskIds[1])).markdown).toBe(elsewhere);

  // Unsupported attributes keep the document in the Markdown source editor.
  const unsupported =
    '<details class="x">\n<summary>제목</summary>\n\n내용\n\n</details>';
  await save(page, taskIds[0], unsupported, (await document(page)).revision);
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(source(page)).toHaveValue(unsupported);
  await expect(detail(page).locator(".document-notice")).toContainText("원문");
});

test("닫는 태그가 없는 토글도 표·링크를 표시하며 편집 전 원문을 보존한다", async ({
  page,
}) => {
  const markdown = [
    "**\\[공유]**",
    "<br />",
    "<br />",
    "<details>\n<summary>**[소식]**</summary>",
    "| 국내 소식 |\n| :--- |\n| 새 서비스 **[공개](https://example.com/news?a=1\\&b=2)** |\n| 작성자 | 새 도구 **[소개](https://example.com/extra)** |",
    "| 해외 소식 |\n| :--- |\n| 새 도구 **[출시](https://example.com/tools)** |",
    "<br />",
    "**\\[기술]**",
    "<br />",
    "<br />",
    "**\\[마지막]**",
  ].join("\n\n");
  const saved = await save(page, taskIds[0], markdown);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/documents/"))
      writes.push(request.url());
  });
  await open(page);
  const toggle = rich(page).locator(":scope > .document-toggle");
  await expect(toggle).toHaveAttribute("data-open", "false");
  await expect(toggle.locator(".document-toggle-summary strong")).toHaveText(
    "[소식]",
  );
  await expect(toggle.locator("table")).toHaveCount(2);
  await expect(toggle.locator("table").first().locator("th")).toHaveText([
    "국내 소식",
    "",
  ]);
  await expect(toggle.locator("table").first().locator("td")).toHaveText([
    "새 서비스 공개",
    "",
    "작성자",
    "새 도구 소개",
  ]);
  await expect(toggle.locator("a").first()).toHaveAttribute(
    "href",
    "https://example.com/news?a=1&b=2",
  );
  await expect(
    toggle.locator(".document-toggle-content > p").last(),
  ).toHaveText("[마지막]");
  await raw(page);
  await expect(source(page)).toHaveValue(markdown);
  await richMode(page);
  await close(page);
  expect((await document(page)).markdown).toBe(markdown);
  expect((await document(page)).revision).toBe(saved.revision);
  expect(writes).toEqual([]);

  await open(page);
  await toggle
    .getByRole("button", { name: "토글 펼치기", exact: true })
    .click();
  await expect(toggle.locator("table").first()).toBeVisible();
  await toggle.locator("td").first().click();
  await toggle
    .locator("td p")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await settleRichSelection(page);
  await page.keyboard.insertText("추가 ");
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain("추가 새 서비스");
  const edited = (await document(page)).markdown;
  expect(edited.trimEnd()).toMatch(/\*\*\\\[마지막\]\*\*\n\n<\/details>$/);
  await close(page);
  await open(page);
  await expect(toggle.locator("table")).toHaveCount(2);
  await expect(toggle.locator("td").first()).toHaveText("추가 새 서비스 공개");
  await expect(
    toggle.locator('a[href="https://example.com/extra"]'),
  ).toHaveText("소개");
  await expect(toggle.locator("a").last()).toHaveAttribute(
    "href",
    "https://example.com/tools",
  );
});

test("열 개수가 다른 표를 붙여넣으면 모든 셀과 기존 정렬을 보존한다", async ({
  page,
}) => {
  await open(page);
  await rich(page).focus();
  await rich(page).evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      "| 가운데 | 오른쪽 |\n| :---: | ---: |\n| 짧은 행 |\n| 긴 행 | 둘째 | **[추가 링크](https://example.com/extra)** |",
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  const table = rich(page).locator("table");
  await expect(table.locator("th")).toHaveText(["가운데", "오른쪽", ""]);
  await expect(table.locator("th").nth(0)).toHaveCSS("text-align", "center");
  await expect(table.locator("th").nth(1)).toHaveCSS("text-align", "right");
  await expect(table.locator("td")).toHaveText([
    "짧은 행",
    "",
    "",
    "긴 행",
    "둘째",
    "추가 링크",
  ]);
  await expect(table.locator("td").nth(4)).toHaveCSS("text-align", "right");
  await expect(table.locator("strong a")).toHaveAttribute(
    "href",
    "https://example.com/extra",
  );
  await close(page);
  await open(page);
  await expect(table.locator("td")).toHaveCount(6);
  await expect(table.locator("td").last()).toHaveText("추가 링크");
  await expect(table.locator("td").nth(4)).toHaveCSS("text-align", "right");
});

test("닫는 태그가 없는 중첩 토글은 안쪽부터 묶고 코드 속 태그는 글자로 유지한다", async ({
  page,
}) => {
  const markdown =
    "앞 문단\n\n<details open>\n<summary>바깥</summary>\n바깥 내용\n\n<details open>\n<summary>안쪽</summary>\n안쪽 내용\n\n```html\n</details>\n```\n\n마지막 문단";
  await save(page, taskIds[0], markdown);
  await open(page);
  const outer = rich(page).locator(":scope > .document-toggle");
  const inner = outer.locator(".document-toggle");
  await expect(outer).toHaveCount(1);
  await expect(inner).toHaveCount(1);
  await expect(
    outer.locator(":scope > .document-toggle-content > p"),
  ).toHaveText(["바깥 내용"]);
  await expect(inner.locator("p")).toHaveText(["안쪽 내용", "마지막 문단"]);
  await expect(inner.locator("pre")).toHaveText("</details>");
  await raw(page);
  await expect(source(page)).toHaveValue(markdown);
  await richMode(page);
  await inner.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" 수정");
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain("마지막 문단 수정\n\n</details>\n\n</details>");
  await close(page);
  await open(page);
  await expect(inner.locator("p").last()).toHaveText("마지막 문단 수정");
  await expect(inner.locator("pre")).toHaveText("</details>");
});

test("닫는 태그가 없어도 지원하지 않는 토글 HTML은 원문으로 보존한다", async ({
  page,
}) => {
  for (const markdown of [
    '<details class="custom">\n<summary>제목</summary>\n\n본문',
    "<details>\n<summary>닫히지 않은 제목\n\n본문",
    "<details>\n<summary>제목</summary>\n\n<span>별도 HTML</span>",
  ]) {
    const saved = await save(
      page,
      taskIds[0],
      markdown,
      (await document(page)).revision,
    );
    await page
      .locator(`[data-cell="${taskIds[0]}:title"]`)
      .click({ button: "right" });
    await expect(source(page)).toHaveValue(markdown);
    await expect(detail(page).locator(".document-notice")).toContainText(
      "원문",
    );
    await close(page);
    expect((await document(page)).revision).toBe(saved.revision);
    expect((await document(page)).markdown).toBe(markdown);
  }
});

test("/ 메뉴는 입력한 글자로 형식을 거르고 방향키·Enter·Esc로 선택하거나 닫는다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("/");
  const options = slashMenu(page).getByRole("option");
  await expect(options.first()).toHaveText("본문");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options).toHaveCount(16);
  await page.keyboard.press("Escape");
  await expect(slashMenu(page)).toHaveCount(0);
  await rich(page).pressSequentially("표");
  await expect(slashMenu(page)).toHaveCount(0);
  await expect(rich(page)).toHaveText("/표");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await rich(page).pressSequentially("/표");
  await expect(options).toHaveText(["표"]);
  await page.keyboard.press("Enter");
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(rich(page)).not.toContainText("/표");
  // Table cells keep "/" as text.
  await rich(page).pressSequentially("/");
  await expect(slashMenu(page)).toHaveCount(0);
  await expect(rich(page).locator("th").first()).toHaveText("/");
  await close(page);

  await open(page, taskIds[1]);
  await rich(page).pressSequentially("/제목");
  await expect(options).toHaveText([
    "제목 1",
    "제목 2",
    "제목 3",
    "토글 제목 1",
    "토글 제목 2",
    "토글 제목 3",
  ]);
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await rich(page).pressSequentially("둘째 수준");
  await expect(rich(page).getByRole("heading", { level: 2 })).toHaveText(
    "둘째 수준",
  );
  await page.keyboard.press("Enter");
  await rich(page).pressSequentially("/목록 ");
  await expect(slashMenu(page)).toHaveCount(0);
  await expect(rich(page).locator(":scope > p").last()).toHaveText("/목록 ");
  await rich(page).pressSequentially("/glm");
  await expect(slashMenu(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(rich(page).locator(":scope > p")).toHaveCount(2);
  await expect
    .poll(async () => (await document(page, taskIds[1])).markdown)
    .toMatch(exact("## 둘째 수준\n\n/목록 /glm"));
});

test("붙여넣은 이미지 뒤와 문서 끝 블록 아래에서 바로 이어서 입력한다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("첫 줄");
  await pasteImage(page);
  const img = rich(page).locator("img[src]");
  await expect(img).toHaveCount(1);
  await rich(page).pressSequentially("이미지 다음 줄");
  const paragraphs = rich(page).locator(":scope > p");
  await expect(paragraphs.nth(0).locator("img[src]")).toHaveCount(1);
  await expect(paragraphs.nth(0)).toContainText("첫 줄");
  await expect(paragraphs.nth(1)).toHaveText("이미지 다음 줄");
  await expect
    .poll(async () => (await document(page)).markdown)
    .toContain("이미지 다음 줄");
  const { markdown, revision } = await document(page);
  const url = markdown.match(/\/api\/document-images\/[^)\s#]+/)![0];
  await close(page);

  // A document ending with an image always offers an empty line below it,
  // and the empty line is not saved.
  await save(page, taskIds[0], `첫 줄\n\n![그림](${url})`, revision);
  await open(page);
  await expect(paragraphs).toHaveCount(3);
  await expect(paragraphs.last()).toHaveText("");
  await page.waitForTimeout(1200);
  expect((await document(page)).revision).toBe(revision + 1);
  await paragraphs.last().click();
  await rich(page).pressSequentially("아래 입력");
  await expect(paragraphs.last()).toHaveText("아래 입력");
  await expect
    .poll(async () => (await document(page)).markdown)
    .toMatch(exact(`첫 줄\n\n![그림](${url})\n\n아래 입력`));

  // Clicking the padding under the text continues at the end.
  const prose = detail(page).locator(".document-prose");
  const box = (await prose.boundingBox())!;
  await prose.click({ position: { x: 6, y: box.height - 6 } });
  await rich(page).pressSequentially(" 이어서");
  await expect(paragraphs.last()).toHaveText("아래 입력 이어서");

  // Tables also keep a line below them.
  await rich(page).press("ControlOrMeta+a");
  await rich(page).press("Delete");
  await rich(page).pressSequentially("/표");
  await page.keyboard.press("Enter");
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(rich(page).locator(":scope > :last-child")).toHaveText("");
  await expect
    .poll(async () => (await document(page)).markdown)
    .not.toContain("<br />");
});
