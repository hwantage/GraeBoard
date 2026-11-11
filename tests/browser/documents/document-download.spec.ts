import {
  test,
  expect,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpack } from "../../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, taskIds: string[];
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
// Stores a plain image for the task's document and returns its address.
async function uploadImage(page: Page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 120;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#984c48";
    context.fillRect(0, 0, 200, 120);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const res = await page.request.post(
    `/api/tasks/${taskIds[0]}/documents/main/images`,
    {
      headers,
      multipart: {
        image: {
          name: "그림.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        },
      },
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).url as string;
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (scope: Locator) =>
  scope.getByRole("textbox", { name: /리치 편집$/ });
const source = (scope: Locator) =>
  scope.getByRole("textbox", { name: /Markdown 원문$/ });
const downloadButton = (scope: Locator) =>
  scope.getByRole("button", { name: "다운로드", exact: true });
const menu = (page: Page) =>
  page.getByRole("menu", { name: "다운로드 형식", exact: true });
async function open(page: Page, id = taskIds[0]) {
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  await expect(detail(page)).toBeVisible();
  await expect(rich(detail(page)).or(source(detail(page)))).toBeVisible();
}
// Picks a format from the download menu and returns the saved file.
async function download(page: Page, item: string) {
  await downloadButton(detail(page)).click();
  const saved = page.waitForEvent("download");
  await menu(page).getByRole("menuitem", { name: item }).click();
  return saved;
}
const text = async (file: Download) => readFile((await file.path())!, "utf8");
// WebKit on macOS reports the name with decomposed Hangul.
const name = (file: Download) => file.suggestedFilename().normalize("NFC");

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  // The print dialog cannot open in a test browser. Record what the page
  // would print and report the dialog closed.
  await page.addInitScript(() => {
    const printed: { title: string; pageTitle: string; html: string }[] = [];
    Object.assign(window, { printed });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof HTMLIFrameElement &&
            node.classList.contains("document-print-frame")
          ) {
            const view = node.contentWindow!;
            view.print = () => {
              printed.push({
                title: view.document.title,
                pageTitle: document.title,
                html: view.document.documentElement.outerHTML,
              });
              view.dispatchEvent(new Event("afterprint"));
            };
          }
    }).observe(document, { childList: true, subtree: true });
  });
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await request(page, "/bootstrap");
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `다운로드 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["다운로드 업무", "원문 업무"])
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

function sample(image: string) {
  const link = `/links/task/${taskIds[1]}`;
  return [
    "# 다운로드 확인",
    "본문 **굵게** 문단입니다.",
    `![그림](${image}#width=120)`,
    `[원문 업무](${link})`,
    "- [x] 끝난 일\n- [ ] 남은 일",
    "| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |",
    `<details>\n<summary><h2>접힌 토글 [원문 업무](${link})</h2></summary>\n\n토글 본문입니다.\n\n</details>`,
    "```mermaid\nflowchart LR\n  A --> B\n```",
    "```text\n코드는 그대로 ](/links/task/" + taskIds[1] + ")\n```",
  ].join("\n\n");
}

test("다운로드 버튼은 리치·원문 모두 목차 버튼 바로 왼쪽의 같은 자리에 있다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], "# 위치\n\n본문");
  await open(page);
  await expect(rich(detail(page))).toBeVisible();
  const tools = detail(page).locator(".document-rich-tools");
  const modes = detail(page).getByRole("group", { name: "문서 편집 모드" });
  const button = downloadButton(tools);
  const contents = tools.getByRole("button", { name: "목차", exact: true });
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  const [modesBox, buttonBox, contentsBox, toolbar] = await Promise.all([
    modes.boundingBox(),
    button.boundingBox(),
    contents.boundingBox(),
    tools.boundingBox(),
  ]);
  // Second from the right: the switch, then download, then the contents.
  expect(buttonBox!.x - (modesBox!.x + modesBox!.width)).toBeGreaterThan(0);
  expect(buttonBox!.x - (modesBox!.x + modesBox!.width)).toBeLessThan(12);
  expect(contentsBox!.x - (buttonBox!.x + buttonBox!.width)).toBeGreaterThan(0);
  expect(contentsBox!.x - (buttonBox!.x + buttonBox!.width)).toBeLessThan(12);
  expect(contentsBox!.x + contentsBox!.width).toBeGreaterThan(
    toolbar!.x + toolbar!.width - 24,
  );
  await tools.screenshot({ path: info.outputPath("toolbar-rich.png") });

  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(menu(page).getByRole("menuitem")).toHaveText([
    "PDF (인쇄 창에서 저장)",
    "Markdown (.md)",
    "HTML (.html)",
  ]);
  await page.screenshot({ path: info.outputPath("menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(detail(page)).toBeVisible();

  await modes.getByRole("button", { name: "Markdown 원문" }).click();
  await expect(source(detail(page))).toBeVisible();
  const sourceBox = (await downloadButton(tools).boundingBox())!;
  expect(sourceBox.x).toBeCloseTo(buttonBox!.x, 0);
  expect(sourceBox.y).toBeCloseTo(buttonBox!.y, 0);
  await tools.screenshot({ path: info.outputPath("toolbar-source.png") });
});

test("Markdown은 원문 그대로 이미지를 넣고 문서 링크를 전체 주소로 바꿔 저장한다", async ({
  page,
}) => {
  const image = await uploadImage(page);
  const markdown = sample(image);
  await save(page, taskIds[0], markdown);
  await open(page);
  const file = await download(page, "Markdown (.md)");
  expect(name(file)).toBe("문서 1.md");
  const saved = await text(file);
  const origin = new URL(page.url()).origin;
  const link = `/links/task/${taskIds[1]}`;
  const embedded = saved.match(/!\[그림\]\((data:image\/webp;base64,[^)]+)\)/);
  expect(embedded).toBeTruthy();
  expect(saved).toBe(
    markdown
      .replace(`${image}#width=120`, embedded![1])
      .replace(`[원문 업무](${link})`, `[원문 업무](${origin}${link})`)
      .replace(
        `<h2>접힌 토글 [원문 업무](${link})`,
        `<h2>접힌 토글 [원문 업무](${origin}${link})`,
      ),
  );
  // The code block keeps its text, links and all.
  expect(saved).toContain(`코드는 그대로 ](${link})`);
  // The embedded image is the stored file.
  const stored = await page.request.get(image);
  expect(Buffer.from(embedded![1].split(",")[1], "base64")).toEqual(
    await stored.body(),
  );
});

test("HTML은 화면과 같은 블록을 이미지·다이어그램과 함께 한 파일로 저장한다", async ({
  page,
}, info) => {
  const image = await uploadImage(page);
  await save(
    page,
    taskIds[0],
    `${sample(image)}\n\n<details>\n<summary>[원본 이미지](${image})</summary>\n\n![보관 원본](${image})\n\n</details>`,
  );
  await open(page);
  const file = await download(page, "HTML (.html)");
  expect(name(file)).toBe("문서 1.html");
  const html = await text(file);
  expect(html).not.toContain("원본 이미지");
  expect(html).not.toContain("보관 원본");
  const origin = new URL(page.url()).origin;
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain("<title>문서 1</title>");
  expect(html).toMatch(/<h1 [^>]*>다운로드 확인<\/h1>/);
  expect(html).toContain("<strong>굵게</strong>");
  expect(html).toMatch(/<img [^>]*src="data:image\/webp;base64,/);
  expect(html).toMatch(/<img [^>]*width="120"/);
  expect(html).toContain(
    `<a href="${origin}/links/task/${taskIds[1]}">원문 업무</a>`,
  );
  expect(html).toMatch(
    /<li class="task"><input type="checkbox" tabindex="-1" checked="">/,
  );
  expect(html).toMatch(
    /<li class="task"><input type="checkbox" tabindex="-1">/,
  );
  expect(html).toContain("<th");
  // A folded toggle stays folded and opens in the browser.
  expect(html).toContain("<details><summary><h2>접힌 토글");
  expect(html).toContain('<div class="toggle-content"><p>토글 본문입니다.</p>');
  expect(html).toMatch(/<figure class="mermaid"><svg /);
  expect(html).toContain(`코드는 그대로 ](/links/task/${taskIds[1]})`);
  // No editor attributes or scripts in the page.
  const outside = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
  expect(outside).not.toMatch(/ data-[a-z-]+=/);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toContain("contenteditable");

  // The saved file opens away from the site, images and diagram included.
  const viewer = await page.context().newPage();
  await viewer.setContent(html);
  await expect(viewer.locator("img")).toHaveJSProperty("complete", true);
  expect(
    await viewer
      .locator("img")
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(200);
  await expect(viewer.locator("figure.mermaid svg")).toBeVisible();
  // The checkboxes show the saved state and do not change.
  const done = viewer.locator("li.task input").first();
  const box = (await done.boundingBox())!;
  await viewer.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(done).toBeChecked();
  await expect(viewer.getByText("토글 본문입니다.")).toBeHidden();
  await viewer.getByText("접힌 토글").click();
  await expect(viewer.getByText("토글 본문입니다.")).toBeVisible();
  await viewer.screenshot({
    path: info.outputPath("html.png"),
    fullPage: true,
  });
  await viewer.close();
});

test("PDF는 모든 토글을 펼친 문서만 인쇄 창으로 보낸다", async ({
  page,
}, info) => {
  const image = await uploadImage(page);
  const toggle = (alt: string) =>
    `<details>\n<summary>원본 이미지</summary>\n\n![${alt}](${image})\n\n</details>`;
  // The older unlinked archive follows its image; the same shape after
  // other blocks is a user's toggle and prints.
  await save(
    page,
    taskIds[0],
    `${sample(image).replace(
      `![그림](${image}#width=120)`,
      `![그림](${image}#width=120)\n\n${toggle("보관 원본")}`,
    )}\n\n${toggle("사용자 토글")}`,
  );
  await open(page);
  const siteTitle = await page.title();
  await downloadButton(detail(page)).click();
  await menu(page)
    .getByRole("menuitem", { name: "PDF (인쇄 창에서 저장)" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).printed.length))
    .toBe(1);
  const [printed] = await page.evaluate(() => (window as any).printed);
  expect(printed.html.match(/원본 이미지/g)).toHaveLength(1);
  expect(printed.html).toContain("사용자 토글");
  expect(printed.html).not.toContain("보관 원본");
  // The document's title names the PDF: Chromium takes the page's title,
  // others the frame's.
  expect(printed.title).toBe("문서 1");
  expect(printed.pageTitle).toBe("문서 1");
  expect(printed.html).toContain('<details open=""><summary><h2>접힌 토글');
  expect(printed.html).toMatch(/<img [^>]*src="data:image\/webp;base64,/);
  expect(printed.html).toMatch(/<figure class="mermaid"><svg /);
  // The app's fonts come along, and the page prints without its chrome.
  expect(printed.html).toMatch(/@font-face\s*{[^}]*Pretendard/);
  expect(printed.html).not.toContain("document-rich-tools");
  // The frame goes and the page's title returns once the dialog closes.
  await expect(page.locator(".document-print-frame")).toHaveCount(0);
  await expect(page).toHaveTitle(siteTitle);
  await expect(downloadButton(detail(page))).toBeEnabled();
  const preview = await page.context().newPage();
  await preview.setContent(printed.html);
  await preview.emulateMedia({ media: "print" });
  await preview.screenshot({
    path: info.outputPath("pdf-page.png"),
    fullPage: true,
  });
  await preview.close();
});

test("원문으로만 여는 문서도 내려받고 HTML은 글자로 남기며 외부 주소를 요청하지 않는다", async ({
  page,
}) => {
  const markdown =
    "# 원문 문서\n\n<span>표시</span> 문단\n\n<script>alert(1)</script>\n\n[나쁜 링크](javascript:alert(1))\n\n![외부 그림](https://example.com/tracker.png)";
  await save(page, taskIds[0], markdown);
  await open(page);
  await expect(source(detail(page))).toBeVisible();
  const outside: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1")
      outside.push(request.url());
  });
  const md = await download(page, "Markdown (.md)");
  expect(await text(md)).toBe(markdown);
  const html = await text(await download(page, "HTML (.html)"));
  expect(html).not.toMatch(/<script|<span>|javascript:|<img/i);
  expect(html).toContain("&lt;span&gt;표시&lt;/span&gt; 문단");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("나쁜 링크");
  // An outside image is not part of the rich document: it stays a link.
  expect(html).toContain(
    '<a href="https://example.com/tracker.png">외부 그림</a>',
  );
  await downloadButton(detail(page)).click();
  await menu(page)
    .getByRole("menuitem", { name: "PDF (인쇄 창에서 저장)" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).printed.length))
    .toBe(1);
  expect(outside).toEqual([]);
});

test("키보드로 메뉴를 열어 형식을 고르면 다운로드 버튼으로 돌아온다", async ({
  page,
}) => {
  await save(page, taskIds[0], "# 키보드\n\n본문");
  await open(page);
  const button = downloadButton(detail(page));
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(
    menu(page).getByRole("menuitem", { name: "PDF (인쇄 창에서 저장)" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu(page).getByRole("menuitem", { name: "Markdown (.md)" }),
  ).toBeFocused();
  const saved = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect(await text(await saved)).toBe("# 키보드\n\n본문");
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  // Printing focuses its frame; focus comes back once the dialog closes.
  await page.keyboard.press("Enter");
  await expect(
    menu(page).getByRole("menuitem", { name: "PDF (인쇄 창에서 저장)" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).printed.length))
    .toBe(1);
  await expect(page.locator(".document-print-frame")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("좁은 화면에서도 다운로드 버튼이 목차 왼쪽에 있다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], "# 좁은 화면\n\n본문");
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const button = downloadButton(detail(page));
  const contents = detail(page).getByRole("button", {
    name: "목차",
    exact: true,
  });
  await expect(button).toBeVisible();
  const [buttonBox, contentsBox] = await Promise.all([
    button.boundingBox(),
    contents.boundingBox(),
  ]);
  expect(contentsBox!.x - (buttonBox!.x + buttonBox!.width)).toBeGreaterThan(0);
  expect(contentsBox!.x - (buttonBox!.x + buttonBox!.width)).toBeLessThan(12);
  await page.screenshot({ path: info.outputPath("mobile.png") });
  const file = await download(page, "Markdown (.md)");
  expect(await text(file)).toBe("# 좁은 화면\n\n본문");
});
