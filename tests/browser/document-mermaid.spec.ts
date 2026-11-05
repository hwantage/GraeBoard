import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, taskId: string;
let violations: string[];
const diagram = "flowchart LR\n  A[시작] --> B[완료]";
const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
const block = (page: Page) => rich(page).locator(".document-mermaid");
async function api(page: Page, path: string, method = "GET", data?: unknown) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    data,
    headers,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
async function save(page: Page, markdown: string, revision = 0) {
  return api(page, `/tasks/${taskId}/documents/main`, "PUT", {
    markdown,
    expectedRevision: revision,
    operationId: randomUUID(),
  });
}
async function stored(page: Page) {
  return (await api(page, `/tasks/${taskId}/documents/main`)).markdown;
}
async function open(page: Page) {
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  await expect(rich(page)).toBeVisible();
}
async function selectContents(locator: Locator) {
  await locator.evaluate(async (el) => {
    (el.closest("[contenteditable=true]") as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    // Notify the editor before its delayed focus handler restores the cursor.
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
async function editSource(page: Page, value: string, index = 0) {
  const current = block(page).nth(index);
  if (!(await current.locator("pre").isVisible()))
    await current.getByRole("img", { name: "Mermaid 다이어그램" }).click();
  await expect(current.locator("pre")).toBeVisible();
  await selectContents(current.locator("code"));
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(await current.locator("code").textContent());
  await page.keyboard.insertText(value);
}

test.beforeEach(async ({ page }) => {
  violations = [];
  page.on("console", (message) => {
    if (
      /content.security.policy|violat.*(?:csp|directive)|refused to (?:load|execute|apply)/i.test(
        message.text(),
      )
    )
      violations.push(message.text());
  });
  await page.addInitScript(() => {
    (window as any).mermaidCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as any).mermaidCspViolations.push(event.violatedDirective);
    });
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await api(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await api(page, "/bootstrap");
  teamId = (
    await api(page, "/admin/teams", "POST", {
      name: `다이어그램 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskId = (
    await api(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: "Mermaid 문서" },
    })
  ).task.id;
  const response = await page.goto("/");
  expect(response!.headers()["content-security-policy"]).toContain(
    "script-src 'self'",
  );
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(() => (window as any).mermaidCspViolations),
  ).toEqual([]);
});

test("Mermaid 소스 편집·미리보기·실행취소·복사와 일반 펜스 저장", async ({
  page,
}, info) => {
  await save(page, `${fence(diagram)}\n\n나머지 문단\n`);
  await open(page);
  await expect(block(page).locator("svg")).toContainText("완료");
  await expect(block(page).locator("pre")).toBeHidden();
  const changed = diagram.replace("완료", "검토 완료");
  await editSource(page, changed);
  await expect(block(page).locator("svg")).toContainText("검토 완료");
  await detail(page).screenshot({ path: info.outputPath("mermaid-edit.png") });
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(block(page).locator("svg")).not.toContainText("검토 완료");
  await detail(page)
    .getByRole("button", { name: "문서 재실행", exact: true })
    .click();
  await expect(block(page).locator("svg")).toContainText("검토 완료");
  await rich(page).locator("p", { hasText: "나머지 문단" }).click();
  await expect(block(page).locator("pre")).toBeHidden();
  await selectContents(rich(page));
  const copied = await rich(page).evaluate((el) => {
    const data: Record<string, string> = {};
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        clearData: () => {},
        setData: (type: string, value: string) => {
          data[type] = value;
        },
      },
    });
    el.dispatchEvent(event);
    return data;
  });
  expect(copied["text/plain"]).toContain(fence(changed));
  expect(copied["text/html"]).not.toContain("<svg");
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    detail(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toHaveValue(`${fence(changed)}\n\n나머지 문단\n`);
  await expect
    .poll(() => stored(page))
    .toBe(`${fence(changed)}\n\n나머지 문단\n`);
});

test("소스 편집 중 원격 문단 수정이 병합되어 다이어그램과 원문을 함께 보존한다", async ({
  page,
}) => {
  const initial = await save(page, `${fence(diagram)}\n\n나머지 문단\n`);
  await open(page);
  await expect(block(page).locator("svg")).toBeVisible();
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/tasks/${taskId}/documents/main`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (++writes === 1) await held;
    await route.continue();
  });
  const changed = diagram.replace("완료", "동시 수정");
  try {
    await editSource(page, changed);
    await expect.poll(() => writes).toBe(1);
    await save(page, `${fence(diagram)}\n\n원격 문단 수정\n`, initial.revision);
  } finally {
    release();
  }
  await expect
    .poll(() => stored(page))
    .toBe(`${fence(changed)}\n\n원격 문단 수정\n`);
  await expect(block(page).locator("svg")).toContainText("동시 수정");
  await expect(
    rich(page).locator("p", { hasText: "원격 문단 수정" }),
  ).toBeVisible();
});

test("발표 모드의 업무 문서와 꼬리 메모에서도 읽기 전용 다이어그램을 표시한다", async ({
  page,
}) => {
  await save(page, `${fence(diagram)}\n`);
  const path = `/teams/${teamId}/years/2026/memos`;
  const id = randomUUID();
  await api(page, path, "POST", { id, title: "Mermaid 메모" });
  await api(page, `${path}/${id}`, "PUT", {
    markdown: fence(diagram),
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.reload();
  await page
    .getByRole("button", { name: "꼬리 메모", exact: true, expanded: false })
    .click();
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const memo = page.locator(".annual-memos .document-mermaid");
  await expect(memo.locator("svg")).toBeVisible();
  await expect(memo.locator("pre")).toBeHidden();
  await page
    .locator(`[data-cell="${taskId}:title"] .task-document-indicator`)
    .click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
  await expect(block(page).locator("svg")).toContainText("완료");
  await block(page).locator("svg").click();
  await expect(block(page).locator("pre")).toBeHidden();
});

test("일정 문서의 다이어그램이 캘린더 밝기 변경을 따라간다", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const boot = await api(page, "/bootstrap");
  await api(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  const entry = await api(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId: boot.user.id,
    title: "Mermaid 일정",
    date: todayKey(),
    endDate: todayKey(),
    tagIds: [],
    checkedTagIds: [],
  });
  await api(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: fence(diagram),
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${entry.id}"] .calendar-entry-card`)
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  const shape = dialog.locator(".document-mermaid svg .node rect").first();
  await expect(shape).toBeVisible();
  const light = await shape.evaluate((el) => getComputedStyle(el).fill);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".workspace")).toHaveAttribute(
    "data-calendar-theme",
    "dark",
  );
  await expect
    .poll(() => shape.evaluate((el) => getComputedStyle(el).fill))
    .not.toBe(light);
  await dialog.screenshot({ path: info.outputPath("mermaid-dark.png") });
});

test("문법 오류를 소스와 함께 표시하고 복구·삭제 후 임시 DOM을 정리한다", async ({
  page,
}) => {
  await save(
    page,
    `${fence("flowchart LR\n A[")}\n\n나머지 문단\n\n${fence(diagram)}\n`,
  );
  await open(page);
  await expect(block(page).first().locator(".document-error")).toBeVisible();
  await expect(
    block(page).first().locator(".document-mermaid-error-detail"),
  ).toHaveText(/^Parse error on line \d+:?$/);
  await expect(block(page).first().locator("pre")).toHaveText(
    "flowchart LR\n A[",
  );
  await expect(block(page).nth(1).locator("svg")).toContainText("완료");
  await expect(
    rich(page).locator("p", { hasText: "나머지 문단" }),
  ).toBeVisible();
  for (const source of [
    diagram,
    "sequenceDiagram\n nonsense %%%",
    diagram.replace("완료", "복구"),
  ]) {
    await editSource(page, source);
    if (source.startsWith("sequence"))
      await expect(
        block(page).first().locator(".document-error"),
      ).toBeVisible();
    else await expect(block(page).first().locator("svg")).toBeVisible();
  }
  await expect(
    page.locator(
      "body > .document-mermaid-render, body > [id^=ddocument-mermaid]",
    ),
  ).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(block(page)).toHaveCount(0);
  await expect(page.locator(".document-mermaid-render")).toHaveCount(0);
});

test("다이어그램 도구 불러오기 실패는 문법 오류와 구분하고 소스 편집을 보존한다", async ({
  page,
}) => {
  let failedRequests = 0;
  const chunk = "**/assets/mermaid.core-*.js";
  await page.route(chunk, (route) => {
    failedRequests++;
    return route.fulfill({
      status: 404,
      contentType: "text/javascript",
      headers: { "Cache-Control": "no-store" },
      body: "",
    });
  });
  await save(page, `${fence(diagram)}\n`);
  await open(page);
  const error = block(page).locator(".document-error");
  await expect(error).toHaveText(
    "다이어그램 도구를 불러오지 못했습니다. 새로고침해 주세요.",
  );
  expect(failedRequests).toBeGreaterThan(0);
  await expect(block(page).locator("pre")).toHaveText(diagram);
  await expect(block(page).locator("svg")).toHaveCount(0);
  await expect(error.locator(".document-mermaid-error-detail")).toHaveCount(0);
  const changed = diagram.replace("완료", "입력 보존");
  await editSource(page, changed);
  await expect.poll(() => stored(page)).toBe(`${fence(changed)}\n`);
  await expect(page.locator(".document-mermaid-render")).toHaveCount(0);
  await page.unroute(chunk);
});

test("오류 상세는 첫 줄 200자만 표시하고 HTML을 글자로 보존한다", async ({
  page,
}) => {
  const source =
    '<img src=x onerror="window.mermaidErrorAttack=true">' +
    "x".repeat(250) +
    "\n두 번째 줄";
  await save(page, `${fence(source)}\n`);
  await open(page);
  const error = block(page).locator(".document-error");
  const detail = error.locator(".document-mermaid-error-detail");
  await expect(detail).toContainText("No diagram type detected");
  await expect(detail).toContainText(
    /<img src=x onerror=["']window.mermaidErrorAttack=true["']>/,
  );
  expect((await detail.textContent())?.length).toBe(200);
  await expect(detail).not.toContainText("두 번째 줄");
  await expect(error.locator("img, script, [onerror]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).mermaidErrorAttack),
  ).toBeUndefined();
  await expect(block(page).locator("pre")).toHaveText(source);
});

test("일반 문서는 Mermaid를 로드하지 않고 슬래시 메뉴에서 예시를 추가한다", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await save(page, "일반 문단\n");
  await open(page);
  expect(requests.some((url) => url.includes("mermaid.core"))).toBe(false);
  await rich(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("/mermaid");
  await page.getByRole("option", { name: "Mermaid 다이어그램" }).click();
  await expect(block(page).locator("svg")).toContainText("시작");
  expect(requests.some((url) => url.includes("mermaid.core"))).toBe(true);
  await expect.poll(() => stored(page)).toContain(fence(diagram));
});

test("큰 다이어그램은 블록 안에서 스크롤하고 strict 모드가 클릭 코드를 실행하지 않는다", async ({
  page,
}) => {
  const source = `%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n${Array.from({ length: 14 }, (_, i) => `N${i}[긴 다이어그램 ${i}] --> N${i + 1}`).join("\n")}\nclick N0 mermaidAttack`;
  await page.evaluate(() => {
    (window as any).mermaidAttack = () => {
      (window as any).mermaidAttacked = true;
    };
  });
  await save(page, fence(source));
  await open(page);
  const preview = block(page).locator(".document-mermaid-preview");
  await expect(preview.locator("svg")).toBeVisible();
  expect(await preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  expect(await preview.evaluate((el) => getComputedStyle(el).overflowX)).toBe(
    "auto",
  );
  await preview.locator("svg").click({ position: { x: 20, y: 20 } });
  expect(
    await page.evaluate(() => (window as any).mermaidAttacked),
  ).toBeUndefined();
  await expect(
    preview.locator("script, [onclick], a[href^='javascript:']"),
  ).toHaveCount(0);
});
