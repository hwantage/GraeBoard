import { build } from "esbuild";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let taskId: string;
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const res = await page.request.fetch("/api" + path, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return unpack(await res.json());
}
async function open(page: Page, markdown?: string) {
  if (markdown !== undefined)
    await request(page, `/tasks/${taskId}/documents/main`, "PUT", {
      markdown,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  const start = detail(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(rich(page).or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(rich(page)).toBeVisible();
  await rich(page).click();
}
async function paste(editor: Locator, text: string, html = "") {
  await editor.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await editor.evaluate(
    (el, { text, html }) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types: html ? ["text/plain", "text/html"] : ["text/plain"],
          getData: (type: string) =>
            type === "text/plain" ? text : type === "text/html" ? html : "",
        },
      });
      el.dispatchEvent(event);
    },
    { text, html },
  );
}
const markdown = async (page: Page) =>
  (await request(page, `/tasks/${taskId}/documents/main`)).markdown as string;
async function settle(page: Page) {
  await rich(page).evaluate(async () => {
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  });
}
async function clear(page: Page) {
  await rich(page).press("ControlOrMeta+A");
  await rich(page).press("Backspace");
}

test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await request(page, "/bootstrap");
  const team = await request(page, "/admin/teams", "POST", {
    name: `입력 ${randomUUID().slice(0, 8)}`,
    members: [{ userId: boot.user.id, role: "lead" }],
  });
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId: team.id,
      year: 2026,
      fields: { title: "입력 검증 업무" },
    })
  ).task.id;
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});

test("Tab은 문단에서 머물고 목록을 들여쓰며 표 셀을 옮기고 Esc로 빠져나간다", async ({
  page,
}) => {
  await open(
    page,
    "문단\n\n- 첫째\n- 둘째\n\n| A | B |\n| - | - |\n| C | D |\n",
  );
  await rich(page).locator("p").first().click();
  const before = await rich(page).textContent();
  for (const key of ["Tab", "Shift+Tab"]) {
    await rich(page).press(key);
    await expect(rich(page)).toBeFocused();
    expect(await rich(page).textContent()).toBe(before);
  }
  await rich(page).locator("li p").nth(1).click();
  await rich(page).evaluate(async () => {
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  });
  await page.keyboard.press("Tab");
  await expect(rich(page).locator("li li")).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(rich(page).locator("li li")).toHaveCount(0);
  await rich(page).locator("th p").first().click();
  await settle(page);
  await page.keyboard.press("Tab");
  await settle(page);
  expect(
    await rich(page).evaluate(
      () =>
        document.getSelection()?.anchorNode?.parentElement?.closest("th,td")
          ?.textContent,
    ),
  ).toBe("B");
  await page.keyboard.press("Escape");
  await expect(rich(page)).not.toBeFocused();
  await expect(detail(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveCount(0);
});

test("코드 블록 Tab은 2칸이고 읽기 전용 Tab은 포커스를 옮긴다", async ({
  page,
}) => {
  await open(page, "```mermaid\ngraph TD\n```\n");
  await rich(page).locator("pre code").click();
  await rich(page)
    .locator("pre code")
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await settle(page);
  await page.keyboard.press("Tab");
  await expect
    .poll(() => rich(page).locator("pre").textContent())
    .toBe("  graph TD");
  await expect(rich(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => rich(page).locator("pre").textContent())
    .toBe("  graph TD");
  await expect.poll(() => markdown(page)).toContain("  graph TD");
  // Presentation mode uses the same readOnly editor contract.
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await page
    .getByRole("button", { name: "입력 검증 업무 문서 열기", exact: true })
    .click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
  await rich(page).evaluate((el) => {
    // A native form stop makes this independent of macOS full keyboard access
    // settings: Firefox otherwise cycles the only eligible stop in the dialog.
    const next = document.createElement("input");
    next.setAttribute("aria-label", "탭 이동 검사");
    el.after(next);
    el.tabIndex = 0;
    el.focus();
  });
  await page.keyboard.press("Tab");
  await expect(rich(page)).not.toBeFocused();
  await expect(
    detail(page).getByRole("textbox", { name: "탭 이동 검사", exact: true }),
  ).toBeFocused();
});

for (const [marker, selector, saved] of [
  ["-", "ul > li", "* 항목"],
  ["*", "ul > li", "* 항목"],
  ["+", "ul > li", "* 항목"],
  ["1.", "ol > li", "1. 항목"],
  ["[ ]", "li.document-check-item", "* [ ] 항목"],
  ["[]", "li.document-check-item", "* [ ] 항목"],
  ["[x]", "li.document-check-item", "* [x] 항목"],
  ["#", "h1", "# 항목"],
  ["##", "h2", "## 항목"],
  ["###", "h3", "### 항목"],
  [">", "blockquote", "> 항목"],
  ["```", "pre", "```\n항목\n```"],
])
  test(`${marker} 스페이스는 자동 변환하고 Backspace와 실행취소로 복원한다`, async ({
    page,
  }) => {
    await open(page);
    await rich(page).pressSequentially(marker + " ");
    await expect(rich(page).locator(selector)).toHaveCount(1);
    if (marker === "[x]")
      await expect(rich(page).getByRole("checkbox")).toBeChecked();
    await page.keyboard.press("Backspace");
    expect((await rich(page).textContent())?.replaceAll("\u00a0", " ")).toBe(
      marker + " ",
    );
    await clear(page);
    await rich(page).pressSequentially(marker + " ");
    await expect(rich(page).locator(selector)).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+z");
    expect((await rich(page).textContent())?.replaceAll("\u00a0", " ")).toBe(
      marker + " ",
    );
    await clear(page);
    await rich(page).pressSequentially(marker + " ");
    await rich(page).pressSequentially("항목");
    await expect.poll(() => markdown(page)).toContain(saved);
  });

test("목록 안 체크박스와 코드 울타리 Enter도 변환하고 입력대로 복원한다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("- [ ] ");
  await expect(rich(page).locator("li.document-check-item")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(rich(page).locator("li.document-check-item")).toHaveCount(0);
  expect(
    (await rich(page).locator("li").textContent())?.replaceAll("\u00a0", " "),
  ).toBe("[ ] ");
  await clear(page);
  await rich(page).pressSequentially("```");
  await page.keyboard.press("Enter");
  await expect(rich(page).locator("pre")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(rich(page).locator("pre")).toHaveCount(0);
  await expect(rich(page)).toHaveText("```");
  await rich(page)
    .locator("p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await settle(page);
  await page.keyboard.press("Enter");
  await expect(rich(page).locator("pre")).toHaveCount(0);
  await expect(rich(page)).toHaveText("```");
});

test("코드·인라인 코드·표 셀·문장 중간에서는 자동 블록 서식이 생기지 않는다", async ({
  page,
}) => {
  await open(page, "```\n\n```\n\n| A | B |\n| - | - |\n|  |  |\n\n마지막\n");
  await rich(page).locator("pre").click();
  await rich(page).pressSequentially("- ");
  await expect(rich(page).locator("li")).toHaveCount(0);
  await rich(page).locator("td p").first().click();
  await settle(page);
  await rich(page).pressSequentially("# ");
  await expect(rich(page).locator("h1")).toHaveCount(0);
  await rich(page).locator("p").last().click();
  await page.keyboard.press("End");
  await rich(page).pressSequentially(" - ");
  await expect(rich(page).locator("li")).toHaveCount(0);
  await clear(page);
  await rich(page).pressSequentially("-");
  await rich(page).press("ControlOrMeta+A");
  await detail(page)
    .getByRole("button", { name: "인라인 코드", exact: true })
    .click();
  await expect(rich(page).locator("code")).toHaveText("-");
  await page.keyboard.press("ArrowRight");
  await settle(page);
  await rich(page).pressSequentially(" ");
  await expect(rich(page).locator("li")).toHaveCount(0);
});

test("외부 URL은 즉시 링크가 되고 제목 변경만 한 번의 실행취소로 되돌린다", async ({
  page,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/link-title?*", async (route) => {
    await wait;
    await route.fulfill({ json: { title: "사이트 <제목> & 안내" } });
  });
  await open(page);
  await paste(
    rich(page),
    "https://example.com/path",
    '<a href="https://example.com/path">https://example.com/path</a>',
  );
  await expect(rich(page).locator("a")).toHaveText("https://example.com/path");
  release();
  await expect(rich(page).locator("a")).toHaveText("사이트 <제목> & 안내");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rich(page).locator("a")).toHaveText("https://example.com/path");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(rich(page).locator("a")).toHaveText("사이트 <제목> & 안내");
  await expect.poll(() => markdown(page)).toContain("https://example.com/path");
});

test("조회 중 고친 URL과 실패한 URL은 그대로 두고 선택 글자에는 조회하지 않는다", async ({
  page,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/link-title?*", async (route) => {
    calls++;
    if (calls === 1) {
      await wait;
      await route.fulfill({ json: { title: "늦은 제목" } });
    } else await route.fulfill({ status: 502, json: { error: "조회 실패" } });
  });
  await open(page);
  await paste(rich(page), "https://example.com");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("수정");
  const response = page.waitForResponse((response) =>
    response.url().includes("/api/link-title?"),
  );
  release();
  await response;
  await settle(page);
  await expect(rich(page)).toContainText("수정");
  await expect(rich(page)).not.toContainText("늦은 제목");
  await clear(page);
  await paste(rich(page), "https://failure.example");
  await expect.poll(() => calls).toBe(2);
  await expect(rich(page).locator("a")).toHaveText("https://failure.example");
  await clear(page);
  await rich(page).pressSequentially("선택 글자");
  await page.keyboard.press("ControlOrMeta+A");
  await paste(rich(page), "https://selected.example");
  await expect(rich(page).locator("a")).toHaveText("선택 글자");
  expect(calls).toBe(2);
});

test("링크 앞 문단 편집은 제목 위치를 추적하고 코드·원문 붙여넣기는 보존한다", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/link-title?*", async (route) => {
    calls++;
    await pending;
    await route.fulfill({ json: { title: "추적한 제목" } });
  });
  await open(page, "앞 문단\n\n마지막\n");
  await rich(page).locator("p").last().click();
  await page.keyboard.press("End");
  await settle(page);
  await paste(rich(page), "https://position.example");
  await rich(page).locator("p").first().click();
  await page.keyboard.press("Home");
  await settle(page);
  await rich(page).pressSequentially("새로 ");
  release();
  await expect(rich(page).locator("a")).toHaveText("추적한 제목");
  await clear(page);
  await detail(page)
    .getByRole("combobox", { name: "문서 블록", exact: true })
    .selectOption("code");
  await paste(rich(page), "https://code.example");
  await expect(rich(page).locator("pre")).toHaveText("https://code.example");
  expect(calls).toBe(1);
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = detail(page).getByRole("textbox", {
    name: "업무 문서 Markdown 원문",
  });
  await source.fill("- ");
  await source.pressSequentially("https://source.example");
  await expect(source).toHaveValue("- https://source.example");
  expect(calls).toBe(1);
});

test("제목 조회 중 링크를 지우면 늦은 제목으로 다시 삽입하지 않는다", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/link-title?*", async (route) => {
    await pending;
    await route.fulfill({ json: { title: "삭제한 링크 제목" } });
  });
  await open(page);
  const response = page.waitForResponse((response) =>
    response.url().includes("/api/link-title?"),
  );
  await paste(rich(page), "https://deleted.example");
  await expect(rich(page).locator("a")).toHaveCount(1);
  await clear(page);
  release();
  await response;
  await settle(page);
  await expect(rich(page).locator("a")).toHaveCount(0);
  await expect(rich(page)).toHaveText("");
});

test("제목 조회 속성이 false이면 URL을 서버에 보내지 않고 기본값은 제목을 조회한다", async ({
  page,
}) => {
  const built = await build({
    entryPoints: ["tests/browser/fixtures/rich-editor.tsx"],
    outfile: "/tmp/graeboard-rich-editor-fixture.js",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".svg": "dataurl", ".png": "dataurl" },
  });
  await page.route("**/__test/rich-editor*", (route) => {
    const path = new URL(route.request().url()).pathname;
    const extension = path.endsWith(".js")
      ? ".js"
      : path.endsWith(".css")
        ? ".css"
        : null;
    return route.fulfill(
      extension
        ? {
            contentType: extension === ".js" ? "text/javascript" : "text/css",
            body: built.outputFiles!.find((file) =>
              file.path.endsWith(extension),
            )!.text,
          }
        : {
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/__test/rich-editor.css"><div id="fixture-root"></div><script type="module" src="/__test/rich-editor.js"></script>',
          },
    );
  });
  const requested: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/link-title?"))
      requested.push(new URL(req.url()).searchParams.get("url")!);
  });
  await page.route("**/api/link-title?*", (route) =>
    route.fulfill({ json: { title: "공개 사이트 제목" } }),
  );
  await page.goto("/__test/rich-editor?linkTitles=false");
  const editor = page.getByRole("textbox", { name: "업무 문서 리치 편집" });
  await expect(editor).toBeVisible();
  await editor.click();
  await paste(editor, "https://private.example/never-send-this");
  await expect(editor.locator("a")).toHaveText(
    "https://private.example/never-send-this",
  );
  await page.waitForLoadState("networkidle");
  expect(requested).toEqual([]);
  await page.goto("/__test/rich-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await paste(editor, "https://public.example/title");
  await expect(editor.locator("a")).toHaveText("공개 사이트 제목");
  expect(requested).toEqual(["https://public.example/title"]);
});
