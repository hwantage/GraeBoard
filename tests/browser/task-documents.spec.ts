import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { defaultView } from "../../shared/domain.js";

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
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
const source = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" });
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
async function close(page: Page) {
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
}
const icon = (page: Page, id = taskIds[0]) =>
  page.locator(`[data-cell="${id}:title"] .task-document-indicator`);

async function editTitle(page: Page, text: string) {
  await detail(page)
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill(text);
}

async function settleRichSelection(page: Page) {
  // Native caret movements reach ProseMirror through selectionchange.
  await rich(page).evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function pasteClipboard(page: Page, text: string, html = "") {
  await settleRichSelection(page);
  await rich(page).evaluate(
    (el, { text, html }) => {
      const data = { "text/plain": text, "text/html": html };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types: html ? ["text/plain", "text/html"] : ["text/plain"],
          getData: (type: string) => data[type as keyof typeof data] || "",
        },
      });
      el.dispatchEvent(event);
    },
    { text, html },
  );
}

async function pasteText(page: Page, text: string) {
  await pasteClipboard(page, text);
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
      name: `문서 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["첫 문서 업무", "둘째 문서 업무"])
    taskIds.push(
      (await post(page, "/tasks", { teamId, year: 2026, fields: { title } }))
        .task.id,
    );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("팀원은 다른 담당자의 표·상세 문서·담당자와 꼬리 메모를 함께 수정한다", async ({
  page,
  browser,
}, info) => {
  const boot = await get(page, "/bootstrap");
  const original = (
    await get(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((task: any) => task.id === taskIds[0]);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: original.id,
        key: "owner",
        value: boot.user.id,
        expectedVersion: original.cells.owner?.version ?? 0,
      },
    ],
  });
  await save(page, original.id, "# 담당자가 작성한 문서");
  const memoBase = `/teams/${teamId}/years/2026/memos`;
  const memoId = randomUUID();
  await post(page, memoBase, { id: memoId, title: "공동 꼬리 메모" });
  const username = `task-member-${randomUUID()}@example.com`;
  const member = (
    await post(page, "/admin/users", {
      username,
      password: "local-member-password",
      name: "공동 편집 팀원",
      memberships: [{ teamId, role: "member" }],
    })
  ).user;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 1366, height: 900 },
  });
  try {
    const peer = await context.newPage();
    await post(peer, "/auth/login", {
      username,
      password: "local-member-password",
    });
    await peer.goto("/");
    await peer.getByLabel("팀 선택").selectOption(teamId);
    const titleCell = peer.locator(`[data-cell="${original.id}:title"]`);
    await expect(titleCell).toHaveText("첫 문서 업무");
    await titleCell.dblclick();
    await peer
      .locator(".inline-editor textarea")
      .fill("팀원이 함께 수정한 작업");
    await peer.locator(".inline-editor textarea").press("Enter");
    await expect(titleCell).toHaveText("팀원이 함께 수정한 작업");
    await open(peer, original.id);
    await expect(rich(peer)).toBeEditable();
    await raw(peer);
    await source(peer).fill("# 다른 담당자의 문서를 팀원이 수정");
    await editTitle(peer, "상세 팝업에서도 공동 편집");
    await detail(peer)
      .getByRole("button", { name: "팀원 수정", exact: true })
      .click();
    await detail(peer)
      .getByRole("listbox", { name: "팀원 편집", exact: true })
      .getByRole("option", { name: member.name, exact: true })
      .click();
    await detail(peer).screenshot({
      path: info.outputPath("member-shared-task.png"),
    });
    await close(peer);
    const stored = (
      await get(page, `/tasks?teamId=${teamId}&year=2026`)
    ).tasks.find((task: any) => task.id === original.id);
    expect(stored.cells.title.value).toBe("상세 팝업에서도 공동 편집");
    expect(stored.cells.owner.value).toBe(member.id);
    expect(
      (await get(page, `/tasks/${original.id}/documents/main`)).markdown,
    ).toBe("# 다른 담당자의 문서를 팀원이 수정");
    const memos = peer.getByRole("region", { name: "연간 업무 메모 목록" });
    await memos
      .getByRole("button", { name: "꼬리 메모", exact: true, expanded: false })
      .click();
    const memo = memos.getByRole("tabpanel", {
      name: "공동 꼬리 메모",
      exact: true,
    });
    await expect(
      memo.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
    ).toBeEditable();
    await memo
      .getByRole("button", { name: "Markdown 원문", exact: true })
      .click();
    await memo
      .getByRole("textbox", { name: "연간 업무 메모 Markdown 원문" })
      .fill("# 작성자와 관계없이 공동 기록");
    await memos
      .getByRole("button", { name: "꼬리 메모", exact: true, expanded: true })
      .click();
    expect((await get(page, `${memoBase}/${memoId}`)).markdown).toBe(
      "# 작성자와 관계없이 공동 기록",
    );
  } finally {
    await context.close();
  }
});

test("문서가 없는 업무는 캐릭터 안내에서 명시적으로 작성을 시작하고 저장 후 바로 연다", async ({
  page,
  browserName,
}, info) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.mouse.move(0, 0);
  await expect(icon(page)).toHaveCSS("opacity", "0");
  await page.locator(`[data-row-id="${taskIds[0]}"] .row-select`).focus();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(icon(page)).toBeFocused();
  await expect(icon(page)).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(detail(page)).toBeVisible();
  const start = detail(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(start).toBeVisible();
  await expect(detail(page).locator(".document-empty")).toContainText(
    "Markdown 문서",
  );
  await expect(detail(page).locator(".document-empty-character")).toBeVisible();
  await expect(rich(page)).toHaveCount(0);
  await expect(source(page)).toHaveCount(0);
  await expect(detail(page).locator(".document-tabs")).toHaveCount(0);
  expect(
    requests.filter((url) => /RichMarkdownEditor|\/documents\/main/.test(url)),
  ).toEqual([]);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const empty = (await detail(page)
      .locator(".document-empty")
      .boundingBox())!;
    const shell = (await detail(page)
      .locator(".task-document-shell")
      .boundingBox())!;
    expect(
      Math.abs(empty.y + empty.height / 2 - shell.y - shell.height / 2),
    ).toBeLessThan(1);
    await detail(page).screenshot({
      path: info.outputPath(`document-empty-${width}.png`),
    });
  }
  await close(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole("button", { name: "업무 추가", exact: true }).focus();
  await page.locator(`[data-cell="${taskIds[0]}:owner"]`).hover();
  await expect(icon(page)).toHaveCSS("opacity", "0.55");
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).screenshot({
    path: info.outputPath("empty-task-detail-hint.png"),
  });
  await icon(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("업무 상세 열기");
  await expect(icon(page)).toHaveCSS("opacity", "1");
  await icon(page).click();
  await expect(start).toBeVisible();
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents`)).documents[0].revision,
  ).toBe(0);
  await start.click();
  await expect(rich(page)).toBeFocused();
  await rich(page).fill("버튼을 눌러 시작한 문서");
  await close(page);
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(rich(page)).toContainText("버튼을 눌러 시작한 문서");
  await expect(start).toHaveCount(0);
});

test("Markdown 코드 입력창은 일반·작은 팝업·전체 페이지의 남은 높이를 채운다", async ({
  page,
}, info) => {
  const markdown = "# 높이 검증\n\n" + "긴 문서의 원문입니다.\n".repeat(200);
  await save(page, taskIds[0], markdown);
  await open(page);
  await raw(page);
  const fits = async () => {
    const body = detail(page).locator(".modal-body");
    await expect
      .poll(async () => {
        const footer = (await detail(page).locator("footer").boundingBox())!;
        const input = (await source(page).boundingBox())!;
        const bottomMargin = await source(page).evaluate((el) =>
          parseFloat(getComputedStyle(el).marginBottom),
        );
        return Math.abs(input.y + input.height + bottomMargin - footer.y);
      })
      .toBeLessThan(2);
    expect(
      await body.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeLessThan(2);
    expect(
      await source(page).evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await expect(source(page)).toHaveValue(markdown);
  };
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 960, height: 650 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await fits();
    await detail(page).screenshot({
      path: info.outputPath(`document-source-${viewport.width}.png`),
    });
  }
  await detail(page)
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await fits();
  await page.setViewportSize({ width: 1366, height: 900 });
  await fits();
  await detail(page).screenshot({
    path: info.outputPath("document-source-full-page.png"),
  });
});

test("상세 속성 입력·응답 유실 재시도·동시 수정 충돌은 팝업과 입력을 보존", async ({
  page,
}) => {
  await open(page);
  await editTitle(page, "팝업에서 수정한 업무");
  const input = detail(page).getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  const writes: any[] = [];
  let loseResponse = true;
  await page.route("**/api/cells/batch", async (route) => {
    writes.push(route.request().postDataJSON());
    if (!loseResponse) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "속성 응답 유실 검증" }),
    });
  });
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(writes).toHaveLength(0);
  await expect(input).toHaveValue("팝업에서 수정한 업무");
  await input.dispatchEvent("compositionend");
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page).getByRole("alert")).toContainText(
    "속성 응답 유실 검증",
  );
  await expect(input).toHaveValue("팝업에서 수정한 업무");
  await expect(
    detail(page).getByText("속성 저장 중…", { exact: true }),
  ).toHaveCount(0);
  // Blur and the close action may each retry the same failed operation. Wait
  // for those attempts to settle before testing the explicit retry.
  const failedAttempts = writes.length;
  loseResponse = false;
  await detail(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  // Begin the conflict scenario only after the retry has finished flushing.
  await expect(detail(page).getByRole("alert")).toHaveCount(0);
  await expect(input).toHaveValue("팝업에서 수정한 업무");
  await expect(detail(page)).toBeVisible();
  expect(failedAttempts).toBeGreaterThan(0);
  expect(writes).toHaveLength(failedAttempts + 1);
  for (const request of writes) expect(request).toEqual(writes[0]);
  await expect(
    detail(page).getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("팝업에서 수정한 업무");

  await editTitle(page, "충돌해도 남을 입력");
  const current = (
    await get(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((t: any) => t.id === taskIds[0]);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        value: "다른 사용자의 최신 제목",
        expectedVersion: current.cells.title.version,
      },
    ],
  });
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "다른 사용자의 최신 제목",
  );
  await input.press("ControlOrMeta+s");
  await expect(detail(page).getByRole("alert")).toContainText(
    "입력은 유지됩니다",
  );
  await expect(input).toHaveValue("충돌해도 남을 입력");
  await detail(page)
    .getByRole("button", { name: "입력 취소", exact: true })
    .click();
  await expect(input).toHaveValue("다른 사용자의 최신 제목");
  await close(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "다른 사용자의 최신 제목",
  );
});

test("변경 없이 닫은 속성 목록은 이후 원격 변경을 표시하고 최신 버전에서 다시 편집한다", async ({
  page,
}) => {
  const boot = await get(page, "/bootstrap");
  const original = (
    await get(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((t: any) => t.id === taskIds[0]);
  const nextOwner = original.cells.owner?.value ? "" : boot.user.id;
  await open(page);
  const owner = detail(page).getByRole("button", {
    name: "팀원 수정",
    exact: true,
  });
  await owner.click();
  await expect(
    detail(page).getByRole("listbox", { name: "팀원 편집", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail(page).getByRole("listbox")).toHaveCount(0);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "owner",
        value: nextOwner,
        expectedVersion: original.cells.owner?.version || 0,
      },
      {
        taskId: taskIds[0],
        key: "title",
        value: "원격 변경 도착 확인",
        expectedVersion: original.cells.title.version,
      },
    ],
  });
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "원격 변경 도착 확인",
  );
  await expect(owner).toContainText(nextOwner ? boot.user.name : "미입력");
  await owner.click();
  await detail(page)
    .getByRole("listbox", { name: "팀원 편집", exact: true })
    .getByRole("option", {
      name: nextOwner ? "선택 안 함" : boot.user.name,
      exact: true,
    })
    .click();
  await close(page);
  const saved = (
    await get(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((t: any) => t.id === taskIds[0]);
  expect(saved.cells.owner.value).toBe(nextOwner ? "" : boot.user.id);
});

test("제목 직접 입력은 한글 조합 중 저장하지 않고 느린 응답 중 새 입력도 순서대로 저장한다", async ({
  page,
}) => {
  await open(page);
  const input = detail(page).getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: any[] = [];
  await page.route("**/api/cells/batch", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (requests.length === 1) await gate;
    await route.fulfill({ response });
  });
  await input.focus();
  await input.evaluate((el) => {
    // Firefox's fill() completes a native composition; model the in-progress
    // input event without asking the browser to commit it first.
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }),
    );
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, "한글 조합 중");
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "한글 조합 중",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  });
  await page.waitForTimeout(850); // Deliberately cross the 650ms autosave boundary.
  expect(requests).toHaveLength(0);
  await input.dispatchEvent("compositionend", { data: "한글 조합 중" });
  await expect.poll(() => requests.length).toBe(1);
  await input.fill("응답을 기다리는 동안 입력한 최신 제목");
  release();
  await expect.poll(() => requests.length).toBe(2);
  await expect(input).toHaveValue("응답을 기다리는 동안 입력한 최신 제목");
  await close(page);
  const saved = (
    await get(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((t: any) => t.id === taskIds[0]);
  expect(saved.cells.title.value).toBe("응답을 기다리는 동안 입력한 최신 제목");
  expect(requests[1].changes[0].expectedVersion).toBe(
    requests[0].changes[0].expectedVersion + 1,
  );
  expect(requests[1].operationId).not.toBe(requests[0].operationId);
});

test("상세 창은 로딩 중 같은 중앙 캐릭터의 네 칸을 순서대로 밝히고 문서·도구를 함께 표시한다", async ({
  page: authenticatedPage,
  browser,
}, info) => {
  await save(
    authenticatedPage,
    taskIds[0],
    "# 긴 문서\n\n" + "불러오는 동안에도 창 크기를 유지합니다.\n\n".repeat(60),
  );
  const storageState = await authenticatedPage.context().storageState();
  for (const width of [1366, 390]) {
    // Isolate module caches: WebKit can reuse an already evaluated editor across
    // reloads even while the test holds its subsequent network request.
    const context = await browser.newContext({
      storageState,
      baseURL: new URL(authenticatedPage.url()).origin,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    let releaseChunk!: () => void,
      releaseBody!: () => void,
      releaseEditor!: () => void;
    const chunk = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const body = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const editor = new Promise<void>((resolve) => {
      releaseEditor = resolve;
    });
    const chunkPattern = /\/assets\/TaskDocumentPanel-[^/]+\.(js|css)$/;
    const editorPattern = /\/assets\/RichMarkdownEditor-[^/]+\.js$/;
    const bodyPattern = `**/api/tasks/${taskIds[0]}/documents/main`;
    await page.route(chunkPattern, async (route) => {
      await chunk;
      await route.continue();
    });
    await page.route(editorPattern, async (route) => {
      await editor;
      await route.continue();
    });
    await page.route(bodyPattern, async (route) => {
      await body;
      await route.continue();
    });
    const bodyRequested = page.waitForRequest(bodyPattern);
    const editorRequested = page.waitForRequest(editorPattern);
    // Install gates before navigation so WebKit preloads cannot bypass them.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const frames: {
        controls: boolean;
        toolbar: boolean;
        content: boolean;
      }[] = [];
      const state = { frames, done: false };
      (window as any).documentLoadingFrames = state;
      const visible = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return (
          !!element &&
          getComputedStyle(element).visibility === "visible" &&
          element.getClientRects().length > 0
        );
      };
      const sample = () => {
        if (state.done) return;
        frames.push({
          controls: visible(".document-controls"),
          toolbar: visible(".document-formatbar"),
          content: visible(".rich-document .ProseMirror h1"),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page
      .locator(`[data-cell="${taskIds[0]}:title"]`)
      .click({ button: "right" });
    const spinner = detail(page).locator(
      ".task-document-shell > .document-loading",
    );
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveAccessibleName("문서 불러오는 중");
    await expect(spinner).toHaveText("");
    const firstSpinner = (await spinner.elementHandle())!;
    const spinnerBox = (await spinner.boundingBox())!;
    const initial = (await detail(page).boundingBox())!;
    expect(initial.height).toBeGreaterThan(650);
    const stable = async () => {
      const current = (await detail(page).boundingBox())!;
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(current[key] - initial[key])).toBeLessThan(1);
    };
    const loading = async () => {
      await stable();
      await expect(spinner).toBeVisible();
      expect(
        await firstSpinner.evaluate((element) => element.isConnected),
      ).toBe(true);
      const box = (await spinner.boundingBox())!;
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(box[key] - spinnerBox[key])).toBeLessThan(1);
      const icon = (await spinner.locator("svg").boundingBox())!;
      expect(
        Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2),
      ).toBeLessThan(1);
      expect(
        Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2),
      ).toBeLessThan(1);
      await expect(
        detail(page).locator(".task-document-surface"),
      ).toHaveAttribute("inert", "");
      await expect(
        detail(page).locator(".document-controls"),
      ).not.toBeVisible();
      await expect(
        detail(page).locator(".document-formatbar"),
      ).not.toBeVisible();
      await expect(rich(page)).not.toBeVisible();
      await expect(
        detail(page).getByRole("button", { name: "문서 전체 페이지로 보기" }),
      ).toBeVisible();
    };
    await loading();
    releaseChunk();
    await bodyRequested;
    await loading();
    releaseBody();
    await editorRequested;
    await loading();
    const tiles = spinner.locator(".grae-loading-tile");
    await expect(tiles).toHaveCount(4);
    for (let active = 0; active < 4; active++) {
      const opacities = await tiles.evaluateAll(
        (elements, time) => {
          for (const element of elements)
            for (const animation of element.getAnimations()) {
              animation.pause();
              animation.currentTime = time;
            }
          return elements.map((element) =>
            Number(getComputedStyle(element).opacity),
          );
        },
        200 + active * 400,
      );
      for (let index = 0; index < 4; index++)
        if (index === active) expect(opacities[index]).toBeGreaterThan(0.7);
        else expect(opacities[index]).toBeLessThan(0.2);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(tiles.first()).toHaveCSS("animation-name", "none");
    await loading();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await detail(page).screenshot({
      path: info.outputPath(`document-loading-${width}.png`),
    });
    releaseEditor();
    await expect(rich(page)).toBeVisible();
    await expect(spinner).toHaveCount(0);
    await expect(detail(page).locator(".document-controls")).toBeVisible();
    await expect(detail(page).locator(".document-formatbar")).toBeVisible();
    const frames = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const state = (window as any).documentLoadingFrames;
      state.done = true;
      return state.frames as {
        controls: boolean;
        toolbar: boolean;
        content: boolean;
      }[];
    });
    expect(
      frames.some((frame) => frame.controls && frame.toolbar && frame.content),
    ).toBe(true);
    expect(
      frames.filter(
        (frame) =>
          (frame.controls || frame.toolbar || frame.content) &&
          !(frame.controls && frame.toolbar && frame.content),
      ),
    ).toEqual([]);
    await stable();
    const scrolling = await detail(page)
      .locator(".modal-body")
      .evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrolling).toBeGreaterThan(100);
    await detail(page).screenshot({
      path: info.outputPath(`document-stable-${width}.png`),
    });
    await raw(page);
    await stable();
    await close(page);
    await page.unroute(chunkPattern);
    await page.unroute(editorPattern);
    await page.unroute(bodyPattern);
    await context.close();
  }
});

test("문서 조회·편집기 코드 로딩 실패는 스피너를 해제하고 재시도·원문 열기를 제공한다", async ({
  page,
  browser,
}) => {
  const markdown = "# 로딩 실패 복구\n\n원문과 저장 상태를 유지합니다.";
  const saved = await save(page, taskIds[0], markdown);
  const bodyPattern = `**/api/tasks/${taskIds[0]}/documents/main`;
  const spinner = () =>
    detail(page).locator(".task-document-shell > .document-loading");
  let failBody = true;
  await page.route(bodyPattern, (route) =>
    failBody ? route.abort() : route.continue(),
  );
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  const retry = detail(page).getByRole("button", {
    name: "문서 다시 불러오기",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect(spinner()).toHaveCount(0);
  failBody = false;
  await retry.click();
  await expect(rich(page)).toContainText("로딩 실패 복구");
  await expect(spinner()).toHaveCount(0);
  await close(page);
  await page.unroute(bodyPattern);

  // Isolate the module cache as well as React.lazy's result. WebKit can reuse
  // an imported module after reload without reaching the failure route.
  for (const chunk of ["RichMarkdownEditor", "TaskDocumentPanel"]) {
    const context = await browser.newContext({
      storageState: await page.context().storageState(),
    });
    try {
      const isolated = await context.newPage();
      const pattern = new RegExp(`/assets/${chunk}-[^/]+\\.js$`);
      let failedRequests = 0;
      await isolated.route(pattern, (route) => {
        failedRequests++;
        return route.abort();
      });
      await isolated.goto(new URL("/", page.url()).href);
      await isolated.getByLabel("팀 선택").selectOption(teamId);
      await isolated
        .locator(`[data-cell="${taskIds[0]}:title"]`)
        .click({ button: "right" });
      await expect(detail(isolated).getByRole("alert")).toContainText(
        "불러오지 못했습니다",
      );
      expect(failedRequests).toBeGreaterThan(0);
      await expect(
        detail(isolated).locator(".task-document-shell > .document-loading"),
      ).toHaveCount(0);
      if (chunk === "RichMarkdownEditor") {
        await detail(isolated)
          .getByRole("button", { name: "Markdown 원문 열기", exact: true })
          .click();
        await expect(source(isolated)).toHaveValue(markdown);
      }
      await close(isolated);
    } finally {
      await context.close();
    }
  }
  const after = await get(page, `/tasks/${taskIds[0]}/documents/main`);
  expect(after.markdown).toBe(markdown);
  expect(after.revision).toBe(saved.revision);
});

test("문서 생성·Markdown 왕복·자동 저장·아이콘·재열기·새로고침·비우기", async ({
  page,
  browserName,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.reload();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(icon(page)).toHaveCSS("opacity", "0");
  expect(
    requests.filter((url) =>
      /RichMarkdownEditor|TaskDocumentPanel|\/document/.test(url),
    ),
  ).toHaveLength(0);
  await open(page);
  await expect(detail(page).locator(".detail-fields")).toBeVisible();
  await rich(page).fill("한글 첫 문서");
  await expect(detail(page).getByText("저장됨", { exact: true })).toBeVisible();
  await raw(page);
  await expect(source(page)).toHaveValue(/한글 첫 문서/);
  const markdown =
    "# 결정 사항\n\n**굵게**와 *기울임*\n\n- 목록\n- [ ] 확인\n\n> 인용\n\n[자료](https://example.com)\n\n```ts\nconst 문서 = 1;\n```\n\n| 항목 | 결과 |\n| --- | --- |\n| 검토 | 완료 |\n";
  await source(page).fill(markdown);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page)).toBeVisible();
  await expect(
    rich(page).getByRole("heading", { name: "결정 사항" }),
  ).toBeVisible();
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(rich(page).locator("strong")).toHaveText("굵게");
  await rich(page).getByRole("checkbox", { name: "체크리스트 완료" }).check();
  await raw(page);
  await expect(source(page)).toHaveValue(/\[x\] 확인/);
  await close(page);
  await expect(icon(page)).toBeVisible();
  await icon(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("업무 문서 열기");
  await expect(icon(page)).not.toHaveAttribute("title");
  await expect(icon(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(icon(page)).toHaveCSS("box-shadow", "none");
  await expect(icon(page)).toHaveCSS("border-top-width", "0px");
  await icon(page).focus();
  // WebKit on macOS uses Option+Tab to include buttons in keyboard navigation.
  await page.keyboard.press(
    browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab",
  );
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(icon(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rich(page)).toBeVisible();
  await expect(rich(page).getByRole("checkbox")).toBeChecked();
  await close(page);
  await page.reload();
  await expect(icon(page)).toBeVisible();
  await icon(page).click();
  await expect(rich(page)).toContainText("결정 사항");
  await raw(page);
  await source(page).fill("");
  await close(page);
  await page.getByRole("button", { name: "업무 추가", exact: true }).focus();
  await page.mouse.move(0, 0);
  await expect(icon(page)).toHaveCSS("opacity", "0");
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe("");
  await open(page, taskIds[1]);
  await expect(rich(page)).toHaveText("");
});

test("실패·재시도·동시 수정·응답 대기 중 입력을 보존하고 다른 문서로 전이하지 않음", async ({
  page,
}) => {
  await open(page);
  await raw(page);
  let reject = true;
  await page.route(`**/api/tasks/${taskIds[0]}/documents/main`, (route) =>
    route.request().method() === "PUT" && reject
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "저장 실패 검증" }),
        })
      : route.continue(),
  );
  await source(page).fill("실패해도 남을 입력");
  await expect(detail(page).getByRole("alert")).toContainText("저장 실패 검증");
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(source(page)).toHaveValue("실패해도 남을 입력");
  reject = false;
  await detail(page).getByRole("button", { name: "저장 다시 시도" }).click();
  await expect(detail(page).getByText("저장됨", { exact: true })).toBeVisible();
  await source(page).dispatchEvent("compositionstart");
  await source(page).fill("내 충돌 입력");
  await save(page, taskIds[0], "다른 사용자 수정", 1);
  await source(page).dispatchEvent("compositionend");
  await expect(detail(page).getByRole("alert")).toContainText(
    /같은 부분|다른 사용자가/,
  );
  await detail(page).getByText("최신 서버 문서 확인", { exact: false }).click();
  await expect(detail(page).locator(".document-conflict pre")).toHaveText(
    "다른 사용자 수정",
  );
  await expect(source(page)).toHaveValue("내 충돌 입력");
  await detail(page)
    .getByRole("button", { name: "내 입력으로 최신 문서 교체" })
    .click();
  await expect(detail(page).getByText("저장됨", { exact: true })).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  await page.route(
    `**/api/tasks/${taskIds[0]}/documents/main`,
    async (route) => {
      if (route.request().method() === "PUT") {
        const res = await route.fetch();
        await pending;
        await route.fulfill({ response: res });
      } else await route.continue();
    },
  );
  await source(page).fill("전송된 입력");
  await expect(
    detail(page).getByText("저장 중…", { exact: true }),
  ).toBeVisible();
  await source(page).fill("늦은 응답 뒤 최신 입력");
  release();
  await close(page);
  await open(page, taskIds[1]);
  await expect(rich(page)).toHaveText("");
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe("늦은 응답 뒤 최신 입력");
});

test("속성 없는 줄바꿈은 빈 문단·표·인라인에서 보존하고 코드 안의 태그는 글자로 표시한다", async ({
  page,
}) => {
  const markdown =
    "첫 문단\n\n<BR>\n\n<br/>\n\n끝 문단\n\n첫 줄<br />둘째 줄\n\n| 제목 | 빈칸 |\n| --- | --- |\n| 값 | <br> |\n\n`<br />`\n\n```html\n<br />\n```\n\n<br />\n\n<BR>\n";
  const saved = await save(page, taskIds[0], markdown);
  await open(page);
  await expect
    .poll(() =>
      rich(page).evaluate(
        (root) =>
          [...root.children].filter(
            (node) => node.tagName === "P" && !node.textContent,
          ).length,
      ),
    )
    .toBe(4);
  await expect(
    rich(page).locator("p").filter({ hasText: "첫 줄둘째 줄" }).locator("br"),
  ).toHaveCount(1);
  await expect(rich(page).locator("table td").last()).toHaveText("");
  await expect(rich(page).locator("code")).toHaveCount(2);
  for (const code of await rich(page).locator("code").all())
    await expect(code).toHaveText("<br />");
  await raw(page);
  await expect(source(page)).toHaveValue(markdown);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich(page).locator("table")).toBeVisible();
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe(markdown);

  await save(page, taskIds[0], "<br />\n", saved.revision);
  await open(page);
  await expect(rich(page)).toHaveText("");
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe("<br />\n");
});

test("코드 블록 언어 뒤 정보를 리치 편집에서도 보존한다", async ({ page }) => {
  const markdown =
    '```js filename="업무.js"\nconst note = "보존";\n```\n\n```plain text\n노션 본문\n```\n\n<br />\n';
  await save(page, taskIds[0], markdown);
  await open(page);
  await expect(detail(page).locator(".document-notice")).toHaveCount(0);
  await expect(rich(page).locator('pre[data-meta="text"]')).toHaveText(
    "노션 본문",
  );
  await rich(page).locator("pre").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" // 수정");
  await close(page);
  const markdownNow = async () =>
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown;
  await expect
    .poll(markdownNow)
    .toContain('```js filename="업무.js"\nconst note = "보존"; // 수정\n```');
  expect(await markdownNow()).toContain("```plain text\n노션 본문\n```");
});

test("지원하지 않는 원문과 위험한 HTML·링크를 보존하고 실행하지 않음", async ({
  page,
}) => {
  await open(page);
  await raw(page);
  const markdown =
    "<script>window.documentAttack = true</script>\n\n[실행](javascript:alert(1))\n\n![이미지](https://example.com/private.png)\n\n각주[^1]\n\n[^1]: 보존 내용";
  await source(page).fill(markdown);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(source(page)).toHaveValue(markdown);
  await expect(detail(page).locator(".document-notice")).toContainText("원문");
  expect(
    await page.evaluate(() => (window as any).documentAttack),
  ).toBeUndefined();
  await expect(detail(page).locator("script,img")).toHaveCount(0);
  const unsafeBreak =
    '앞 문단\n\n<br onmouseover="window.documentAttack = true">\n\n뒤 문단';
  await source(page).fill(unsafeBreak);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(source(page)).toHaveValue(unsafeBreak);
  await expect(detail(page).locator("[onmouseover]")).toHaveCount(0);
  await expect(detail(page).locator(".document-notice")).toContainText("원문");
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe(unsafeBreak);
  await open(page, taskIds[1]);
  await raw(page);
  await source(page).fill(
    "첫 문단\n\n<br />\n\n![이미지](https://example.com/private.png)",
  );
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(source(page)).toHaveValue(/!\[이미지\]/);
  await expect(detail(page).locator("img[src]")).toHaveCount(0);
  await close(page);
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(source(page)).toHaveValue(unsafeBreak);
});

test("한글 조합·문서 실행취소·붙여넣기가 뒤쪽 표 입력과 분리됨", async ({
  page,
}) => {
  await open(page);
  const undo = detail(page).getByRole("button", { name: "문서 실행취소" });
  const redo = detail(page).getByRole("button", { name: "문서 재실행" });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/documents/main"))
      puts.push(r.postData() || "");
  });
  await rich(page).focus();
  // fill() commits a native composition in Firefox, so model an in-progress
  // DOM input here. The separate CDP test exercises Chromium's IME engine.
  await rich(page).evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
    el.querySelector("p")!.textContent = "한글 조합 중";
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "한글 조합 중",
        isComposing: true,
      }),
    );
  });
  await page.waitForTimeout(900);
  expect(puts).toHaveLength(0);
  await rich(page).dispatchEvent("compositionend", { data: "중" });
  await expect(detail(page).getByText("저장됨", { exact: true })).toBeVisible();
  await rich(page).press("End");
  await rich(page).pressSequentially(" undo");
  await rich(page).press("ControlOrMeta+z");
  await expect(rich(page)).not.toContainText("undo");
  await expect(redo).toBeEnabled();
  await rich(page).press("ControlOrMeta+Shift+z");
  await expect(rich(page)).toContainText("undo");
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await rich(page).press("ControlOrMeta+z");
  await expect(redo).toBeEnabled();
  await rich(page).pressSequentially("새 편집");
  await expect(redo).toBeDisabled();
  await rich(page).evaluate((el) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "\n붙여넣은 한글" : "",
      },
    });
    el.dispatchEvent(event);
  });
  await expect(rich(page)).toContainText("붙여넣은 한글");
  await close(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toContainText(
    "첫 문서 업무",
  );
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toContain("붙여넣은 한글");
});

test("Chromium IME 엔진에서 한글 조합 중 저장하지 않고 확정한 문서를 보존", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME 조합 명령은 Chromium CDP에서 제공",
  );
  await open(page);
  await rich(page).focus();
  const original = await rich(page).elementHandle();
  const client = await page.context().newCDPSession(page);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/documents/main"))
      writes.push(r.postData() || "");
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Process",
    code: "KeyG",
    windowsVirtualKeyCode: 229,
  });
  for (const text of ["ㅎ", "하", "한"]) {
    await client.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await expect(rich(page)).toHaveText(text);
    expect(
      await original!.evaluate(
        (el) => el.isConnected && el === document.activeElement,
      ),
    ).toBe(true);
  }
  await page.waitForTimeout(900);
  expect(writes).toHaveLength(0);
  await client.send("Input.insertText", { text: "한" });
  for (const text of ["ㄱ", "그", "글"]) {
    await client.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await expect(rich(page)).toHaveText(`한${text}`);
  }
  await page.waitForTimeout(900);
  expect(writes).toHaveLength(0);
  await client.send("Input.insertText", { text: "글" });
  await rich(page).pressSequentially(" document");
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown.trim(),
  ).toBe("한글 document");
  await icon(page).click();
  await expect(rich(page)).toHaveText("한글 document");
});

test("표 삽입·행과 열 추가·링크 도구가 Markdown으로 저장됨", async ({
  page,
}) => {
  await open(page);
  await rich(page).fill("참고 문서");
  await rich(page).press("ControlOrMeta+a");
  await detail(page).getByRole("button", { name: "링크", exact: true }).click();
  await detail(page).getByLabel("링크 주소").fill("javascript:alert(1)");
  await detail(page).getByRole("button", { name: "적용", exact: true }).click();
  await expect(detail(page).getByRole("alert")).toContainText("https://");
  await detail(page).getByLabel("링크 주소").fill("https://example.com/docs");
  await detail(page).getByRole("button", { name: "적용", exact: true }).click();
  await expect(
    rich(page).getByRole("link", { name: "참고 문서" }),
  ).toHaveAttribute("href", "https://example.com/docs");
  await rich(page).locator("p").first().click();
  await rich(page).press("End");
  await rich(page).press("Enter");
  await detail(page)
    .getByRole("button", { name: "표 삽입", exact: true })
    .click();
  const table = rich(page).locator("table");
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);
  await table.locator("th").first().click();
  await page.keyboard.insertText("담당");
  await detail(page)
    .getByRole("button", { name: "표 행 +", exact: true })
    .click();
  await expect(table.locator("tr")).toHaveCount(4);
  await detail(page)
    .getByRole("button", { name: "표 열 +", exact: true })
    .click();
  await expect(table.locator("tr").first().locator("th")).toHaveCount(4);
  await raw(page);
  await expect(source(page)).toHaveValue(
    /\[참고 문서\]\(https:\/\/example.com\/docs\)/,
  );
  await expect(source(page)).toHaveValue(/\| 담당/);
  await close(page);
  await icon(page).click();
  await expect(rich(page).locator("table tr")).toHaveCount(4);
});

for (const cellType of ["th", "td"])
  for (const multiline of [false, true])
    test(`리치 표 ${cellType} 셀의 커서 위치에 ${multiline ? "여러 줄과 인라인 서식을" : "일반 텍스트를"} 붙여넣고 저장한다`, async ({
      page,
    }) => {
      await save(
        page,
        taskIds[0],
        "표 앞 문단\n\n| 앞뒤 | 제목 유지 |\n| --- | --- |\n| 앞뒤 | 내용 유지 |\n\n표 뒤 문단\n",
      );
      await open(page);
      const table = rich(page).locator("table");
      const target = table.locator(cellType).first();
      const surrounding = await rich(page)
        .locator(":scope > p")
        .allTextContents();
      await target.locator("p").click({ position: { x: 1, y: 8 } });
      await page.keyboard.press("ArrowRight");
      await expect(
        detail(page).getByRole("button", { name: "표 열 +", exact: true }),
      ).toBeEnabled();
      expect(
        await target.evaluate((el) => {
          const selection = window.getSelection()!;
          return {
            inside: el.contains(selection.anchorNode),
            offset: selection.anchorOffset,
          };
        }),
      ).toEqual({ inside: true, offset: 1 });
      const text = multiline
        ? "**첫 줄**\n둘째 줄\n\n[마지막 줄](https://example.com)"
        : "복사한 한글";
      await pasteText(page, text);
      const expected = multiline
        ? "앞첫 줄둘째 줄마지막 줄뒤"
        : "앞복사한 한글뒤";
      const preserved = async () => {
        await expect(target).toHaveText(expected);
        await expect(table).toHaveCount(1);
        await expect(table.locator("tr")).toHaveCount(2);
        await expect(table.locator("th").last()).toHaveText("제목 유지");
        await expect(table.locator("td").last()).toHaveText("내용 유지");
        await expect(rich(page).locator(":scope > p")).toHaveText(surrounding);
        if (multiline) {
          await expect(target.locator("br")).toHaveCount(3);
          await expect(target.locator("strong")).toHaveText("첫 줄");
          await expect(target.getByRole("link")).toHaveAttribute(
            "href",
            "https://example.com",
          );
        }
      };
      await preserved();
      await detail(page).getByRole("button", { name: "문서 실행취소" }).click();
      await expect(target).toHaveText("앞뒤");
      await detail(page).getByRole("button", { name: "문서 재실행" }).click();
      await preserved();
      await close(page);
      await page.reload();
      await open(page);
      await preserved();
    });

for (const cellType of ["th", "td"])
  test(`리치 표 ${cellType} 셀은 Shift+Enter로 연속 줄바꿈하고 실행취소·저장한다`, async ({
    page,
  }) => {
    await save(
      page,
      taskIds[0],
      "표 앞 문단\n\n| 앞뒤 | 제목 유지 |\n| --- | --- |\n| 앞뒤 | 내용 유지 |\n\n표 뒤 문단\n",
    );
    await open(page);
    const table = rich(page).locator("table");
    const target = table.locator(cellType).first();
    const surrounding = await rich(page)
      .locator(":scope > p")
      .allTextContents();
    await target.locator("p").click({ position: { x: 1, y: 8 } });
    await page.keyboard.press("ArrowRight");
    await settleRichSelection(page);
    await expect(
      detail(page).getByRole("button", { name: "표 열 +", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Shift+Enter");
    await expect(target.locator("br")).toHaveCount(1);
    await detail(page).getByRole("button", { name: "문서 실행취소" }).click();
    await expect(target.locator("br")).toHaveCount(0);
    await expect(target).toHaveText("앞뒤");
    await detail(page).getByRole("button", { name: "문서 재실행" }).click();
    await expect(target.locator("br")).toHaveCount(1);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("새 줄");
    await page.keyboard.press("ArrowRight");
    await settleRichSelection(page);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("마지막");
    const preserved = async () => {
      await expect(target).toHaveText("앞새 줄뒤마지막");
      await expect(target.locator("br")).toHaveCount(4);
      await expect(target.locator("p")).toHaveCount(1);
      await expect(table).toHaveCount(1);
      await expect(table.locator("tr")).toHaveCount(2);
      await expect(table.locator("th").last()).toHaveText("제목 유지");
      await expect(table.locator("td").last()).toHaveText("내용 유지");
      await expect(rich(page).locator(":scope > p")).toHaveText(surrounding);
    };
    await preserved();
    await close(page);
    const document = await get(page, `/tasks/${taskIds[0]}/documents/main`);
    expect(document.markdown).toContain(
      "앞<br /><br />새 줄뒤<br /><br />마지막",
    );
    await page.reload();
    await open(page);
    await preserved();
  });

test("리치 표 셀은 선택한 글자를 교체하고 빈 셀에도 블록·HTML 원문을 보존한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "| 제목 | 상태 |\n| --- | --- |\n| 교체 | |\n");
  await open(page);
  const cells = rich(page).locator("td");
  await cells
    .first()
    .locator("p")
    .click({ position: { x: 1, y: 8 } });
  await settleRichSelection(page);
  await page.keyboard.press("Shift+ArrowRight");
  await settleRichSelection(page);
  await page.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()!.toString()))
    .toBe("교체");
  await expect(
    detail(page).getByRole("button", { name: "표 열 +", exact: true }),
  ).toBeEnabled();
  await pasteText(page, "- 첫 항목\r\n- 다음 | 내용");
  await expect(cells.first()).toHaveText("- 첫 항목- 다음 | 내용");
  await rich(page).press("Tab");
  await pasteText(page, "<em>원문</em>\n다음 줄");
  const preserved = async () => {
    await expect(cells).toHaveText([
      "- 첫 항목- 다음 | 내용",
      "<em>원문</em>다음 줄",
    ]);
    await expect(cells.locator("br")).toHaveCount(2);
    await expect(rich(page).locator("em, ul")).toHaveCount(0);
    await expect(rich(page).locator("table")).toHaveCount(1);
    await expect(rich(page).locator(":scope > p")).toHaveCount(0);
  };
  await preserved();
  await close(page);
  await open(page);
  await preserved();
});

test("리치 문서의 표와 텍스트를 함께 복사하면 서식과 구조를 유지한다", async ({
  page,
  browserName,
}) => {
  const markdown =
    "## 복사할 제목\n\n**굵게**와 *기울임*, ~~취소선~~, `코드`, [자료](https://example.com/docs)\n\n> 인용 문장\n\n- 목록 항목\n\n1. 순서 항목\n\n- [x] 완료 항목\n- [ ] 대기 항목\n\n| 항목 | 결과 |\n| :--- | ---: |\n| **표 안 굵게** | 첫 줄<br />둘째 줄 |\n\n마지막 문단\n";
  await save(page, taskIds[0], markdown);
  await open(page);
  await rich(page).press("ControlOrMeta+a");
  await settleRichSelection(page);
  let copied: { html: string; text: string };
  if (browserName === "chromium") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.keyboard.press("ControlOrMeta+c");
    copied = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return {
        html: await (await item.getType("text/html")).text(),
        text: await (await item.getType("text/plain")).text(),
      };
    });
  } else {
    // Exercise the editor's copy serializer where OS clipboard access is absent.
    copied = await rich(page).evaluate((el) => {
      const data = new Map<string, string>();
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          clearData: () => data.clear(),
          setData: (type: string, value: string) => data.set(type, value),
        },
      });
      el.dispatchEvent(event);
      return {
        html: data.get("text/html") || "",
        text: data.get("text/plain") || "",
      };
    });
  }
  expect(copied.html).toContain("<table");
  expect(copied.html).toContain("<strong");
  await rich(page)
    .locator(":scope > p")
    .last()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (el.closest("[contenteditable]") as HTMLElement).focus();
    });
  await settleRichSelection(page);
  await page.keyboard.press("Enter");
  if (browserName === "chromium") {
    await page.keyboard.press("ControlOrMeta+v");
  } else {
    await pasteClipboard(page, copied.text, copied.html);
  }
  const preserved = async () => {
    await expect(rich(page).locator("table")).toHaveCount(2);
    await expect(
      rich(page).getByRole("heading", { name: "복사할 제목" }),
    ).toHaveCount(2);
    await expect(rich(page).locator("strong")).toHaveText([
      "굵게",
      "표 안 굵게",
      "굵게",
      "표 안 굵게",
    ]);
    for (const [selector, text] of [
      ["em", "기울임"],
      ["del", "취소선"],
      ["code", "코드"],
      ["blockquote", "인용 문장"],
      ["ol li", "순서 항목"],
    ])
      await expect(rich(page).locator(selector)).toHaveText([text, text]);
    await expect(rich(page).getByRole("link", { name: "자료" })).toHaveCount(2);
    for (const link of await rich(page)
      .getByRole("link", { name: "자료" })
      .all())
      await expect(link).toHaveAttribute("href", "https://example.com/docs");
    const checks = rich(page).getByRole("checkbox", {
      name: "체크리스트 완료",
    });
    await expect(checks).toHaveCount(4);
    for (let i = 0; i < 4; i++)
      await expect(checks.nth(i)).toBeChecked({ checked: i % 2 === 0 });
    for (const table of await rich(page).locator("table").all()) {
      await expect(table.locator("th, td")).toHaveText([
        "항목",
        "결과",
        "표 안 굵게",
        "첫 줄둘째 줄",
      ]);
      await expect(table.locator("th").last()).toHaveCSS("text-align", "right");
      await expect(table.locator("td").last().locator("br")).toHaveCount(1);
    }
  };
  await preserved();
  await detail(page).getByRole("button", { name: "문서 실행취소" }).click();
  await expect(rich(page).locator("table")).toHaveCount(1);
  await detail(page).getByRole("button", { name: "문서 재실행" }).click();
  await preserved();
  await close(page);
  await page.reload();
  await open(page);
  await preserved();
});

test("HTML 붙여넣기는 서식을 보존하고 지원하지 않는 내용은 일반 텍스트로 남긴다", async ({
  page,
}) => {
  await open(page);
  await rich(page).focus();
  await pasteClipboard(
    page,
    "굵은 문장과 자료",
    '<p><strong>굵은 문장</strong>과 <a href="https://example.com/docs" onclick="window.documentAttack = true">자료</a></p>',
  );
  await expect(rich(page).locator("strong")).toHaveText("굵은 문장");
  await expect(rich(page).getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
  await expect(rich(page).locator("[onclick]")).toHaveCount(0);
  for (const html of [
    '<p><a href="javascript:window.documentAttack=true">원문 유지</a></p>',
    '<p><img src="https://example.com/private.png" onerror="window.documentAttack=true" alt="원문 유지"></p>',
    '<span data-type="html" data-value="&lt;script&gt;window.documentAttack=true&lt;/script&gt;">원문 유지</span>',
    '<sup data-type="footnote_reference" data-label="1">원문 유지</sup>',
  ]) {
    await rich(page).press("ControlOrMeta+a");
    await pasteClipboard(page, "원문 유지", html);
    await expect(rich(page)).toHaveText("원문 유지");
    await expect(rich(page).locator("a, img, script, sup")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).documentAttack),
    ).toBeUndefined();
  }
  await close(page);
  await open(page);
  await expect(rich(page)).toHaveText("원문 유지");
});

test("리치 코드 블록에 붙여넣으면 서식과 Markdown 기호를 코드 그대로 유지한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "```text\n처음\n```\n");
  await open(page);
  await rich(page)
    .locator("pre code")
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (el.closest("[contenteditable]") as HTMLElement).focus();
    });
  await pasteClipboard(
    page,
    "**문자 그대로**\n다음 줄",
    "<p><strong>문자 그대로</strong></p><p>다음 줄</p>",
  );
  await expect(rich(page).locator("pre code")).toHaveText(
    "**문자 그대로**\n다음 줄",
  );
  await expect(rich(page).locator("strong")).toHaveCount(0);
  await close(page);
  await open(page);
  await expect(rich(page).locator("pre code")).toHaveText(
    "**문자 그대로**\n다음 줄",
  );
});

test("Chromium 실제 클립보드로 복사한 문장은 리치 표 셀 안에 붙는다", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "클립보드 읽기 권한은 Chromium에서 제공",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await save(page, taskIds[0], "복사할 문장\n\n| 제목 |\n| --- |\n| 앞뒤 |\n");
  await open(page);
  await rich(page)
    .locator(":scope > p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (el.closest("[contenteditable]") as HTMLElement).focus();
    });
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("복사할 문장");
  const target = rich(page).locator("td").first();
  await target.locator("p").click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("ArrowRight");
  await expect(
    detail(page).getByRole("button", { name: "표 열 +", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(target).toHaveText("앞복사할 문장뒤");
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(rich(page).locator(":scope > p").first()).toHaveText(
    "복사할 문장",
  );
});

test("표 열 삭제는 선택한 열만 지우고 실행취소·저장·마지막 열 삭제를 지원한다", async ({
  page,
}) => {
  await save(
    page,
    taskIds[0],
    "표 앞 문장\n\n| 이름 | 담당 | 상태 |\n| --- | --- | --- |\n| 작업 A | 지윤 | 진행 |\n| 작업 B | 민수 | 완료 |\n\n표 뒤 문장\n\n| 다른 표 |\n| --- |\n| 유지 |\n",
  );
  await open(page);
  const table = rich(page).locator("table").first();
  const remove = detail(page).getByRole("button", {
    name: "표 열 -",
    exact: true,
  });
  const undo = detail(page).getByRole("button", { name: "문서 실행취소" });
  const redo = detail(page).getByRole("button", { name: "문서 재실행" });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  await rich(page).getByText("표 앞 문장", { exact: true }).click();
  await expect(remove).toBeDisabled();
  await table.locator("td").nth(1).click();
  await remove.click();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "상태",
    "작업 A",
    "진행",
    "작업 B",
    "완료",
  ]);
  await expect(rich(page)).toBeFocused();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "담당",
    "상태",
    "작업 A",
    "지윤",
    "진행",
    "작업 B",
    "민수",
    "완료",
  ]);
  await redo.click();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await close(page);
  await open(page);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "상태",
    "작업 A",
    "진행",
    "작업 B",
    "완료",
  ]);
  await table.locator("th").first().click();
  await remove.click();
  await expect(table.locator("th, td")).toHaveText(["상태", "진행", "완료"]);
  // Keyboard activation must retain the editor's selected column, too.
  await remove.focus();
  await remove.press("Enter");
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(table.locator("th, td")).toHaveText(["다른 표", "유지"]);
  await undo.click();
  await expect(rich(page).locator("table")).toHaveCount(2);
  await expect(table.locator("th, td")).toHaveText(["상태", "진행", "완료"]);
  await redo.click();
  await close(page);
  const saved = (await get(page, `/tasks/${taskIds[0]}/documents/main`))
    .markdown;
  expect(saved).toContain("표 앞 문장");
  expect(saved).toContain("표 뒤 문장");
  expect(saved).toContain("다른 표");
  expect(saved).not.toMatch(/이름|담당|상태|작업 A|작업 B|지윤|민수|진행|완료/);
});

test("표 행·전체 삭제는 주변 내용을 보존하고 문서 실행취소로 복구된다", async ({
  page,
}) => {
  await save(
    page,
    taskIds[0],
    "앞 문장\n\n| 이름 | 상태 |\n| --- | --- |\n| 작업 A | 진행 |\n| 작업 B | 완료 |\n| 작업 C | 대기 |\n\n뒤 문장\n",
  );
  await open(page);
  const table = rich(page).locator("table");
  const removeRow = detail(page).getByRole("button", {
    name: "표 행 -",
    exact: true,
  });
  const removeTable = detail(page).getByRole("button", {
    name: "표 삭제",
    exact: true,
  });
  const undo = detail(page).getByRole("button", { name: "문서 실행취소" });
  const redo = detail(page).getByRole("button", { name: "문서 재실행" });
  await rich(page).getByText("앞 문장", { exact: true }).click();
  await expect(removeRow).toBeDisabled();
  await expect(removeTable).toBeDisabled();
  await table.locator("th").first().click();
  await expect(removeRow).toBeDisabled();
  await table.getByText("작업 B", { exact: true }).click();
  await removeRow.click();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "상태",
    "작업 A",
    "진행",
    "작업 C",
    "대기",
  ]);
  await undo.click();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.getByText("작업 B", { exact: true })).toBeVisible();
  await redo.click();
  await table.getByText("작업 A", { exact: true }).click();
  await removeRow.click();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "상태",
    "작업 C",
    "대기",
  ]);
  await table.getByText("작업 C", { exact: true }).click();
  await expect(removeRow).toBeDisabled();
  await removeTable.click();
  await expect(table).toHaveCount(0);
  await expect(rich(page)).toContainText("앞 문장");
  await expect(rich(page)).toContainText("뒤 문장");
  await undo.click();
  await expect(table.locator("th, td")).toHaveText([
    "이름",
    "상태",
    "작업 C",
    "대기",
  ]);
  await redo.click();
  await close(page);
  await open(page);
  await expect(table).toHaveCount(0);
  await expect(rich(page)).toContainText("앞 문장");
  await expect(rich(page)).toContainText("뒤 문장");
});

test("실패 초안을 보관해 다른 업무를 열고 새로고침 후 복구하며 늦은 조회를 무시", async ({
  page,
}) => {
  await open(page);
  await raw(page);
  await page.route(`**/api/tasks/${taskIds[0]}/documents/main`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await source(page).fill("다시 열어도 보관될 한글 초안");
  await expect(
    detail(page).getByRole("button", { name: "초안 보관하고 닫기" }),
  ).toBeVisible();
  await detail(page)
    .getByRole("button", { name: "초안 보관하고 닫기" })
    .click();
  await open(page, taskIds[1]);
  await expect(rich(page)).toHaveText("");
  await close(page);
  await page.unroute(`**/api/tasks/${taskIds[0]}/documents/main`);
  await page.reload();
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(rich(page)).toContainText("다시 열어도 보관될 한글 초안");
  await expect(
    detail(page).getByRole("button", { name: "문서 작성", exact: true }),
  ).toHaveCount(0);
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toContain("다시 열어도 보관될 한글 초안");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/tasks/${taskIds[0]}/documents/main`,
    async (route) => {
      const response = await route.fetch();
      await pending;
      await route.fulfill({ response });
    },
  );
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(detail(page)).toBeVisible();
  await close(page);
  await open(page, taskIds[1]);
  release();
  await expect(rich(page)).toHaveText("");
});

for (const copy of [false, true])
  test(`${copy ? "사본" : "원본"} 문서 개수는 두 개부터 표시하고 추가·삭제·새로고침에 반영한다`, async ({
    page,
  }, info) => {
    await save(page, taskIds[0], "개수를 확인할 문서");
    await save(page, taskIds[1], "두 자리 개수를 확인할 문서");
    for (let n = 2; n <= 10; n++)
      await post(page, `/tasks/${taskIds[1]}/documents`, { id: randomUUID() });
    if (copy)
      await post(page, "/reports", {
        teamId,
        year: 2026,
        name: "문서 개수 사본",
        referenceDate: "2026-10-14",
        view: defaultView(2026),
        taskIds,
      });
    await page.reload();
    if (copy)
      await page
        .getByRole("tab", { name: "문서 개수 사본", exact: true })
        .click();
    const count = icon(page).locator(".task-document-count");
    await page.mouse.move(0, 0);
    await expect(icon(page)).toBeVisible();
    await expect(icon(page)).toHaveCSS("opacity", "1");
    await expect(count).toHaveCount(0);
    await expect(
      icon(page, taskIds[1]).locator(".task-document-count"),
    ).toHaveText("10");
    const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
    if (copy) {
      await title.dblclick();
      const input = page
        .locator(".inline-editor textarea,.inline-editor input")
        .first();
      await input.fill("사본 제목 수정");
      await input.press("Enter");
      await expect(page.locator(".sheet-save-status")).toHaveText("저장됨");
    }
    await icon(page).click();
    for (const n of [2, 3]) {
      await detail(page)
        .getByRole("button", { name: "문서 추가", exact: true })
        .click();
      await expect(detail(page).getByRole("tab")).toHaveCount(n);
      await expect(count).toHaveText(String(n));
      await expect(icon(page)).toHaveAccessibleName(
        new RegExp(`문서 ${n}개 열기$`),
      );
    }
    await close(page);
    if (copy) {
      await page.getByRole("button", { name: "실행취소", exact: true }).click();
      await expect(title).toContainText("첫 문서 업무");
      await expect(count).toHaveText("3");
      await expect(page.locator(".sheet-save-status")).toHaveText("저장됨");
      await page.getByRole("button", { name: "재실행", exact: true }).click();
      await expect(title).toContainText("사본 제목 수정");
      await expect(count).toHaveText("3");
      await expect(page.locator(".sheet-save-status")).toHaveText("저장됨");
    }
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const cells = page.locator('[data-column="title"]');
      for (const taskId of taskIds) {
        const cell = page.locator(`[data-cell="${taskId}:title"]`);
        const bounds = (await cell.boundingBox())!;
        const button = (await icon(page, taskId).boundingBox())!;
        const number = (await icon(page, taskId)
          .locator(".task-document-count")
          .boundingBox())!;
        expect(button.x + button.width).toBeLessThanOrEqual(
          bounds.x + bounds.width,
        );
        expect(number.x + number.width).toBeLessThanOrEqual(
          button.x + button.width,
        );
        expect(button.width).toBeGreaterThanOrEqual(22);
      }
      await cells
        .first()
        .screenshot({ path: info.outputPath(`document-count-3-${width}.png`) });
      await cells.nth(1).screenshot({
        path: info.outputPath(`document-count-10-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await icon(page).click();
    for (const n of [2, 1]) {
      await detail(page)
        .locator(".document-tab-item")
        .last()
        .getByRole("button", { name: / 메뉴$/ })
        .click();
      await detail(page)
        .getByRole("menuitem", { name: "문서 삭제", exact: true })
        .click();
      await detail(page)
        .getByRole("button", { name: "문서 삭제", exact: true })
        .click();
      await expect(detail(page).getByRole("tab")).toHaveCount(n);
      if (n > 1) await expect(count).toHaveText(String(n));
      else await expect(count).toHaveCount(0);
    }
    await close(page);
    await page.reload();
    if (copy)
      await page
        .getByRole("tab", { name: "문서 개수 사본", exact: true })
        .click();
    await expect(icon(page)).toBeVisible();
    await expect(count).toHaveCount(0);
    await expect(
      icon(page, taskIds[1]).locator(".task-document-count"),
    ).toHaveText("10");
  });

test("문서 서식 버튼·세 가지 목록 아이콘과 한글 제목 셀 아이콘이 동작", async ({
  page,
}) => {
  await open(page);
  await rich(page).fill("버튼으로 편집한 문서");
  await rich(page).press("ControlOrMeta+a");
  await detail(page).getByRole("button", { name: "굵게", exact: true }).click();
  await expect(rich(page).locator("strong")).toHaveText("버튼으로 편집한 문서");
  const strike = detail(page).getByRole("button", {
    name: "취소선",
    exact: true,
  });
  await strike.click();
  await expect(rich(page).locator("del")).toHaveText("버튼으로 편집한 문서");
  await strike.click();
  await expect(rich(page).locator("del")).toHaveCount(0);
  await strike.click();
  await detail(page)
    .getByRole("combobox", { name: "문서 블록" })
    .selectOption("h2");
  await expect(rich(page).getByRole("heading", { level: 2 })).toHaveText(
    "버튼으로 편집한 문서",
  );
  await rich(page).getByRole("heading", { level: 2 }).click();
  await rich(page).press("End");
  await settleRichSelection(page);
  await rich(page).press("Enter");
  for (const [name, tag, text] of [
    ["글머리 목록", "ul", "글머리 항목"],
    ["번호 목록", "ol", "번호 항목"],
  ]) {
    await detail(page).getByRole("button", { name, exact: true }).click();
    await rich(page).pressSequentially(text);
    await expect(rich(page).locator(`:scope > ${tag} > li`)).toHaveText(text);
    await rich(page).press("Enter");
    await rich(page).press("Enter");
  }
  await detail(page)
    .getByRole("button", { name: "체크리스트", exact: true })
    .click();
  await rich(page).pressSequentially("확인");
  await expect(rich(page).getByRole("checkbox")).toBeVisible();
  await rich(page).getByRole("checkbox").check();
  await close(page);
  await expect(icon(page)).toBeVisible();
  // Saving updates the task timestamp; a subsequent detail action must use it.
  await icon(page).click();
  await detail(page)
    .getByRole("button", { name: "다음 연도에도 표시", exact: true })
    .click();
  await expect(detail(page)).toHaveCount(0);
  const tasks = (await get(page, `/tasks?teamId=${teamId}&year=2026`)).tasks;
  expect(tasks.find((task: any) => task.id === taskIds[0]).years).toContain(
    2027,
  );
  const settings = (await get(page, "/bootstrap")).teams.find(
    (team: any) => team.id === teamId,
  ).settings;
  settings.properties.find((p: any) => p.id === "title").name =
    "이름을 바꾼 컬럼";
  expect(
    (
      await page.request.patch(`/api/teams/${teamId}/settings`, {
        headers,
        data: settings,
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await expect(icon(page)).toBeVisible();
  expect(
    await page.locator(".row-select .task-document-indicator").count(),
  ).toBe(0);
  await icon(page).click();
  await expect(rich(page)).toContainText("버튼으로 편집한 문서");
  await expect(rich(page).locator("h2 del")).toHaveText("버튼으로 편집한 문서");
  await expect(
    rich(page).locator("ul > li:not(.document-check-item)"),
  ).toHaveText("글머리 항목");
  await expect(rich(page).locator("ol > li")).toHaveText("번호 항목");
  await expect(rich(page).getByRole("checkbox")).toBeChecked();
});

const listFormats = [
  { name: "글머리 목록", tag: "ul", markdown: "- **첫 항목**\n- 둘째 항목" },
  { name: "번호 목록", tag: "ol", markdown: "3. **첫 항목**\n4. 둘째 항목" },
  {
    name: "체크리스트",
    tag: "ul",
    markdown: "- [x] **첫 항목**\n- [ ] 둘째 항목",
  },
];
for (const from of listFormats)
  for (const to of listFormats.filter((format) => format !== from))
    test(`문서 목록 전환 (${from.name} → ${to.name})은 내용·실행취소·저장 후 형식을 보존한다`, async ({
      page,
    }) => {
      await save(page, taskIds[0], from.markdown);
      await open(page);
      const checkFormat = async (format: (typeof listFormats)[number]) => {
        const list = rich(page).locator(`:scope > ${format.tag}`);
        await expect(list).toHaveCount(1);
        await expect(list.locator("li")).toHaveCount(2);
        await expect(list.locator("li p")).toHaveText(["첫 항목", "둘째 항목"]);
        await expect(list.locator("strong")).toHaveText("첫 항목");
        await expect(list.locator("ul, ol")).toHaveCount(0);
        await expect(rich(page).getByRole("checkbox")).toHaveCount(
          format.name === "체크리스트" ? 2 : 0,
        );
      };
      await checkFormat(from);
      // A caret in an existing list must convert it, without wrapping or
      // requiring the user to delete and recreate its items.
      await rich(page).locator("li p").first().click();
      await settleRichSelection(page);
      const caret = () =>
        rich(page).evaluate(() => {
          const selection = window.getSelection()!;
          return {
            text: selection.anchorNode?.textContent,
            offset: selection.anchorOffset,
            collapsed: selection.isCollapsed,
          };
        });
      const before = await caret();
      await detail(page)
        .getByRole("button", { name: to.name, exact: true })
        .click();
      await checkFormat(to);
      expect(await caret()).toEqual(before);
      if (to.name === "체크리스트") {
        for (const checkbox of await rich(page).getByRole("checkbox").all())
          await expect(checkbox).not.toBeChecked();
      }
      await detail(page)
        .getByRole("button", { name: "문서 실행취소", exact: true })
        .click();
      await checkFormat(from);
      if (from.name === "체크리스트")
        await expect(rich(page).getByRole("checkbox").first()).toBeChecked();
      if (from.name === "번호 목록")
        await expect(rich(page).locator(":scope > ol")).toHaveAttribute(
          "start",
          "3",
        );
      await detail(page)
        .getByRole("button", { name: "문서 재실행", exact: true })
        .click();
      await checkFormat(to);
      await close(page);
      const saved = (await get(page, `/tasks/${taskIds[0]}/documents/main`))
        .markdown;
      expect(saved).toContain("**첫 항목**");
      expect(saved).toContain("둘째 항목");
      if (to.name === "체크리스트")
        expect(saved).toMatch(/\[ \] \*\*첫 항목\*\*/);
      else expect(saved).not.toMatch(/\[[ x]\]/);
      await page.reload();
      await open(page);
      await checkFormat(to);
    });

test("문서 목록 전환은 선택한 깊이에 적용하고 하위 목록과 주변 문단을 보존한다", async ({
  page,
}) => {
  await save(
    page,
    taskIds[0],
    "앞 문단\n\n- [x] **상위 완료**\n\n  5. 하위 첫 항목\n  6. 하위 둘째 항목\n\n- [ ] 상위 대기\n\n뒤 문단",
  );
  await open(page);
  await rich(page)
    .locator("p")
    .filter({ hasText: /^상위 완료$/ })
    .click();
  await settleRichSelection(page);
  await detail(page)
    .getByRole("button", { name: "번호 목록", exact: true })
    .click();
  const outer = rich(page).locator(":scope > ol");
  await expect(outer).toHaveCount(1);
  await expect(outer.locator(":scope > li")).toHaveCount(2);
  await expect(outer.locator("ol")).toHaveAttribute("start", "5");
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
  await expect(
    rich(page).locator(":scope > p").filter({ hasText: /문단/ }),
  ).toHaveText(["앞 문단", "뒤 문단"]);
  await rich(page).evaluate((el) => {
    const items = el.querySelectorAll("ol ol p");
    const range = document.createRange();
    range.setStart(items[0].firstChild!, 0);
    range.setEnd(items[1].firstChild!, items[1].textContent!.length);
    el.focus();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await settleRichSelection(page);
  await detail(page)
    .getByRole("button", { name: "체크리스트", exact: true })
    .click();
  await expect(outer).toHaveCount(1);
  const nested = outer.locator("ul");
  await expect(nested).toHaveCount(1);
  await expect(nested.getByRole("checkbox")).toHaveCount(2);
  await expect(outer.locator(":scope > li.document-check-item")).toHaveCount(0);
  await expect(rich(page).locator("strong")).toHaveText("상위 완료");
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(outer.locator("ol")).toHaveAttribute("start", "5");
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "문서 재실행", exact: true })
    .click();
  await expect(nested.getByRole("checkbox")).toHaveCount(2);
  await nested.getByRole("checkbox").first().check();
  await nested.locator("p").first().click();
  await settleRichSelection(page);
  await detail(page)
    .getByRole("button", { name: "체크리스트", exact: true })
    .click();
  await expect(nested.getByRole("checkbox").first()).toBeChecked();
  await close(page);
  await page.reload();
  await open(page);
  await expect(outer).toHaveCount(1);
  await expect(nested.getByRole("checkbox").first()).toBeChecked();
  await expect(nested.locator("p")).toHaveText([
    "하위 첫 항목",
    "하위 둘째 항목",
  ]);
});

for (const format of listFormats)
  test(`문서 혼합 선택을 ${format.name}으로 바꾸면 모든 문단과 목록을 변환한다`, async ({
    page,
  }) => {
    await save(
      page,
      taskIds[0],
      "선택 밖 앞\n\n앞 문단\n\n- [x] **첫 항목**\n\n  5. 하위 항목\n\n- [ ] 둘째 항목\n\n뒤 문단\n\n선택 밖 뒤",
    );
    await open(page);
    await rich(page).evaluate((el) => {
      const paragraphs = Array.from(el.querySelectorAll(":scope > p"));
      const first = paragraphs.find((p) => p.textContent === "앞 문단")!;
      const last = paragraphs.find((p) => p.textContent === "뒤 문단")!;
      el.focus();
      // Backwards selection must remain usable after the structural change.
      window
        .getSelection()!
        .setBaseAndExtent(
          last.firstChild!,
          last.textContent!.length,
          first.firstChild!,
          0,
        );
    });
    await settleRichSelection(page);
    await detail(page)
      .getByRole("button", { name: format.name, exact: true })
      .click();
    const check = async () => {
      const list = rich(page).locator(`:scope > ${format.tag}`);
      await expect(list).toHaveCount(1);
      await expect(list.locator(":scope > li > div > p")).toHaveText([
        "앞 문단",
        "첫 항목",
        "둘째 항목",
        "뒤 문단",
      ]);
      await expect(list.locator("strong")).toHaveText("첫 항목");
      await expect(list.locator("ol")).toHaveAttribute("start", "5");
      await expect(rich(page).locator(":scope > p")).toHaveText([
        "선택 밖 앞",
        "선택 밖 뒤",
      ]);
      await expect(list.getByRole("checkbox")).toHaveCount(
        format.name === "체크리스트" ? 4 : 0,
      );
      if (format.name === "체크리스트") {
        await expect(list.getByRole("checkbox").nth(1)).toBeChecked();
        await expect(list.getByRole("checkbox").nth(0)).not.toBeChecked();
        await expect(list.getByRole("checkbox").nth(2)).not.toBeChecked();
        await expect(list.getByRole("checkbox").nth(3)).not.toBeChecked();
      }
    };
    await check();
    expect(
      await rich(page).evaluate(() => {
        const selection = window.getSelection()!;
        return [
          selection.anchorNode?.textContent,
          selection.anchorOffset,
          selection.focusNode?.textContent,
          selection.focusOffset,
        ];
      }),
    ).toEqual(["뒤 문단", 4, "앞 문단", 0]);
    await detail(page)
      .getByRole("button", { name: "문서 실행취소", exact: true })
      .click();
    await expect(rich(page).locator(":scope > p")).toHaveText([
      "선택 밖 앞",
      "앞 문단",
      "뒤 문단",
      "선택 밖 뒤",
    ]);
    await expect(rich(page).getByRole("checkbox").first()).toBeChecked();
    await detail(page)
      .getByRole("button", { name: "문서 재실행", exact: true })
      .click();
    await check();
    await close(page);
    await page.reload();
    await open(page);
    await check();
  });

test("문서 목록 단축키는 툴바와 같은 전환과 실행취소를 지원한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "- [x] **완료 항목**\n- [ ] 대기 항목");
  await open(page);
  await rich(page).locator("li p").first().click();
  await settleRichSelection(page);
  await page.keyboard.press("ControlOrMeta+Alt+7");
  await expect(rich(page).locator(":scope > ol > li")).toHaveCount(2);
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+8");
  await expect(rich(page).locator(":scope > ul > li")).toHaveCount(2);
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(rich(page).locator(":scope > ol > li")).toHaveCount(2);
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(rich(page).getByRole("checkbox").first()).toBeChecked();
  await page.keyboard.press("ControlOrMeta+Alt+8");
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
  await expect(rich(page).locator("strong")).toHaveText("완료 항목");
  await close(page);
  await page.reload();
  await open(page);
  await expect(rich(page).locator(":scope > ul > li")).toHaveCount(2);
  await expect(rich(page).getByRole("checkbox")).toHaveCount(0);
});

test("열람자는 문서와 원문을 읽고 편집하지 못함", async ({ page }) => {
  await save(page, taskIds[0], "# 열람 전용\n\n- [ ] 수정 금지");
  const username = `document-viewer-${randomUUID()}@example.com`;
  await post(page, "/admin/users", {
    username,
    password: "local-test-only-password",
    name: "문서 열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await post(page, "/auth/login", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await expect(icon(page)).toBeVisible();
  await icon(page).click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
  await expect(rich(page).getByRole("checkbox")).toBeDisabled();
  await expect(
    detail(page).getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    detail(page).getByRole("button", { name: "상태 수정", exact: true }),
  ).toBeDisabled();
  await expect(
    detail(page).getByRole("group", { name: "문서 서식" }),
  ).toHaveCount(0);
  await rich(page).locator("li p").click();
  await page.keyboard.press("ControlOrMeta+Alt+7");
  await page.keyboard.press("ControlOrMeta+Alt+8");
  await expect(rich(page).getByRole("checkbox")).toHaveCount(1);
  await expect(rich(page).locator("ol")).toHaveCount(0);
  await raw(page);
  await expect(source(page)).toHaveJSProperty("readOnly", true);
  await close(page);
  await page
    .locator(`[data-cell="${taskIds[1]}:title"]`)
    .click({ button: "right" });
  await expect(
    detail(page).getByRole("heading", {
      name: "작성된 문서가 없습니다.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    detail(page).getByRole("button", { name: "문서 작성", exact: true }),
  ).toHaveCount(0);
  await expect(rich(page)).toHaveCount(0);
});

test("팀 테마 5종과 좁은 화면에서 문서·키보드 탐색·아이콘 위치", async ({
  page,
  browserName,
}, info) => {
  await save(
    page,
    taskIds[0],
    "# 주간 업무 기록\n\n팀에서 합의한 내용과 다음 할 일을 문서로 관리합니다.\n\n- [x] 자료 확인\n- [ ] 다음 주 공유\n\n> 변경한 내용은 자동으로 저장됩니다.\n\n| 상태 | 업무 내용 | 담당 |\n| --- | --- | --- |\n| 진행 | 다음 주 회의에서 공유할 자료와 검토 의견을 정리합니다. | 기획팀 |\n| 완료 | https://example.com/documents/long-reference-address-without-spaces | 개발팀 |\n",
  );
  for (const theme of ["mint", "sky", "lavender", "rose", "sand"]) {
    const settings = (await get(page, "/bootstrap")).teams.find(
      (t: any) => t.id === teamId,
    ).settings;
    expect(
      (
        await page.request.patch(`/api/teams/${teamId}`, {
          headers,
          data: {
            name: "문서 테마 검증",
            theme,
            settingsRevision: settings.revision,
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.reload();
    await expect(icon(page)).toBeVisible();
    const cellBox = (await page
        .locator(`[data-cell="${taskIds[0]}:title"]`)
        .boundingBox())!,
      iconBox = (await icon(page).boundingBox())!;
    expect(iconBox.x + iconBox.width).toBeGreaterThan(
      cellBox.x + cellBox.width - 5,
    );
    expect(iconBox.y).toBeLessThan(cellBox.y + 5);
    await icon(page).click();
    await expect(rich(page)).toContainText("주간 업무 기록");
    await expect(rich(page)).toHaveCSS("font-family", /^"?Pretendard"?,/);
    await expect(rich(page)).toHaveCSS("font-size", "15px");
    await detail(page).screenshot({
      path: info.outputPath(`document-${theme}.png`),
    });
    await close(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await icon(page).click();
  await expect(rich(page)).toBeVisible();
  expect(
    await detail(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await detail(page).screenshot({
    path: info.outputPath("document-mobile.png"),
  });
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(source(page)).toBeVisible();
  await expect(source(page)).toHaveCSS("font-family", /^"?Pretendard"?,/);
  await expect(source(page)).toHaveCSS("font-size", "15px");
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (const name of ["리치 문서"]) {
    await page.keyboard.press(tab);
    await expect(
      detail(page).getByRole("button", { name, exact: true }),
    ).toBeFocused();
  }
  await page.keyboard.press(tab);
  await expect(source(page)).toBeFocused();
  const expand = detail(page).locator(":scope > header").getByRole("button", {
    name: "문서 전체 페이지로 보기",
    exact: true,
  });
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(detail(page)).toHaveClass(/document-full-page/);
  await expect(detail(page).locator(".task-detail-properties")).toBeVisible();
  await expect(detail(page).locator(".task-detail-year")).toBeVisible();
  await expect(source(page)).toHaveCSS("font-size", "15px");
});

test("행 복사는 문서도 복사 당시 값으로 보존하고 복제본 저장을 분리", async ({
  page,
}) => {
  await save(page, taskIds[0], "복사 당시 본문");
  await page.reload();
  await page
    .locator(`[data-row-id="${taskIds[0]}"] .row-select`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("복사했습니다");
  await save(page, taskIds[0], "복사 이후 원본", 1);
  await page
    .locator(`[data-row-id="${taskIds[1]}"] .row-select`)
    .click({ button: "right" });
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/tasks") && res.request().method() === "POST",
    ),
    page
      .getByRole("menuitem", { name: "복사한 행 붙여넣기", exact: true })
      .click(),
  ]);
  const copiedId = (await response.json().then(unpack)).task.id;
  await expect(icon(page, copiedId)).toBeVisible();
  await icon(page, copiedId).click();
  await expect(rich(page)).toHaveText("복사 당시 본문");
  await raw(page);
  await source(page).fill("복제본 독립 수정");
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe("복사 이후 원본");
});

test("입력 직후 상세 복제는 최신 문서를 포함하고 저장 실패 시 숨기기를 막음", async ({
  page,
}) => {
  await open(page);
  await raw(page);
  await source(page).fill("복제 버튼 직전 마지막 입력");
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/tasks") && res.request().method() === "POST",
    ),
    detail(page).getByRole("button", { name: "복제", exact: true }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
  const copied = (await response.json().then(unpack)).task;
  expect((await get(page, `/tasks/${copied.id}/documents/main`)).markdown).toBe(
    "복제 버튼 직전 마지막 입력",
  );
  await open(page);
  await raw(page);
  await page.route(`**/api/tasks/${taskIds[0]}/documents/main`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "저장 차단 검증" }),
        })
      : route.continue(),
  );
  await source(page).fill("숨기기 전에 보존해야 할 입력");
  await detail(page)
    .getByRole("button", { name: "이 업무 숨기기", exact: true })
    .click();
  await expect(detail(page).getByRole("alert")).toContainText("저장 차단 검증");
  await expect(source(page)).toHaveValue("숨기기 전에 보존해야 할 입력");
});

test("문서 응답보다 최신 셀 이벤트가 먼저 와도 셀과 문서 아이콘을 함께 유지", async ({
  page,
}) => {
  await open(page);
  await raw(page);
  let release!: () => void, fetched!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stored = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  await page.route(
    `**/api/tasks/${taskIds[0]}/documents/main`,
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      fetched();
      await pending;
      await route.fulfill({ response });
    },
  );
  await source(page).fill("늦게 도착할 문서 저장 응답");
  await stored;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        value: "더 최신인 셀 편집",
        expectedVersion: 1,
      },
    ],
  });
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toContainText(
    "더 최신인 셀 편집",
  );
  release();
  await close(page);
  // The normal periodic refresh must not be needed to show the saved document.
  await expect(icon(page)).toBeVisible({ timeout: 2000 });
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toContainText(
    "더 최신인 셀 편집",
  );
  await icon(page).click();
  await expect(rich(page)).toContainText("늦게 도착할 문서 저장 응답");
});

async function pasteImage(page: Page, color = "#408378", invalid = false) {
  await rich(page).focus();
  await rich(page).evaluate(
    (element, { color, invalid }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "white";
      ctx.font = "24px sans-serif";
      ctx.fillText("붙여넣기 검증", 20, 80);
      const bytes = invalid
        ? new TextEncoder().encode("invalid image bytes")
        : Uint8Array.from(
            atob(canvas.toDataURL("image/png").split(",")[1]),
            (char) => char.charCodeAt(0),
          );
      const data = new DataTransfer();
      data.items.add(new File([bytes], "문서 메모.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      // Firefox drops files from the constructor's synthetic clipboard clone.
      // Supply the original DataTransfer through the real paste event; do not
      // directly call our uploader or inject the Milkdown handler in the test.
      Object.defineProperty(event, "clipboardData", { value: data });
      element.dispatchEvent(event);
    },
    { color, invalid },
  );
}

test("이미지 붙여넣기·업로드 대기·원문 왕복·스냅샷과 보관 문서 조회", async ({
  page,
}, info) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploads = 0;
  await page.route(
    `**/api/tasks/${taskIds[0]}/documents/main/images`,
    async (route) => {
      uploads++;
      await gate;
      await route.continue();
    },
  );
  await pasteImage(page);
  await expect.poll(() => uploads).toBe(1);
  await expect(detail(page).locator(".document-save-state")).toContainText(
    "이미지 업로드 중",
  );
  await expect(
    detail(page).getByRole("button", { name: "Markdown 원문", exact: true }),
  ).toBeDisabled();
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toBeVisible();
  release();
  const img = rich(page).locator("img[src]");
  await expect(img).toHaveCount(1);
  await expect
    .poll(() => img.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(320);
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
  const original = await get(page, `/tasks/${taskIds[0]}/documents/main`);
  expect(original.markdown).toContain(`/api/document-images/${teamId}/`);
  expect(original.markdown).not.toContain("data:image");
  await raw(page);
  await expect(source(page)).toHaveValue(original.markdown);
  await detail(page)
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(img).toBeVisible();
  await close(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).revision,
  ).toBe(original.revision);
  const id = (
    await post(page, "/reports", {
      teamId,
      year: 2026,
      name: "이미지 보관 보고본",
      referenceDate: "2026-10-14",
      view: defaultView(2026),
      taskIds,
    })
  ).id;
  await page.reload();
  await page
    .getByRole("tab", { name: "이미지 보관 보고본", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "이미지 보관 보고본", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await open(page);
  await expect(rich(page)).toHaveAttribute("contenteditable", "true");
  await expect(img).toBeVisible();
  await pasteImage(page, "#984c48");
  await expect(img).toHaveCount(2);
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
  await close(page);
  await open(page);
  await expect(img).toHaveCount(2);
  const saved = await get(
    page,
    `/reports/${id}/tasks/${taskIds[0]}/documents/main`,
  );
  expect(saved.markdown.match(/\/api\/document-images\//g)).toHaveLength(2);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe(original.markdown);
  await detail(page).screenshot({
    path: info.outputPath("copy-document-images.png"),
  });
});

test("잘못된 이미지 붙여넣기는 안내하고 본문을 유지하며 다음 붙여넣기는 성공한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "유지할 본문");
  await open(page);
  await pasteImage(page, "#408378", true);
  await expect(detail(page).getByRole("alert")).toContainText(
    "이미지를 읽을 수 없습니다",
  );
  await expect(rich(page)).toContainText("유지할 본문");
  await expect(rich(page).locator("img[src]")).toHaveCount(0);
  await expect(
    detail(page).locator(".document-upload-placeholder"),
  ).toHaveCount(0);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).revision,
  ).toBe(1);
  await pasteImage(page);
  await expect(rich(page).locator("img[src]")).toHaveCount(1);
  await expect(detail(page).getByRole("alert")).toHaveCount(0);
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toContain("유지할 본문");
});

test("두 문서의 탭 제목을 입력 중 번갈아 더블클릭해도 저장·전환·닫기가 응답한다", async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await save(page, taskIds[0], "유지할 첫 문서 본문");
  await post(page, `/tasks/${taskIds[0]}/documents`, { id: randomUUID() });
  await post(page, `/teams/${teamId}/years/2026/memos`, {
    id: randomUUID(),
    title: "연결 검증 메모",
  });
  await page.reload();
  const otherPage = await page.context().newPage();
  await otherPage.goto("/");
  await otherPage.getByLabel("팀 선택").selectOption(teamId);
  await expect(
    otherPage.locator(`[data-cell="${taskIds[0]}:title"]`),
  ).toBeVisible();
  // A memo and task detail must also share the sheet's connection in one page.
  await page
    .getByRole("button", { name: "꼬리 메모", exact: true, expanded: false })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "연간 업무 메모 리치 편집",
      exact: true,
    }),
  ).toBeVisible();
  await open(page);
  await expect(detail(page).getByRole("tab")).toHaveCount(2);
  await expect(rich(page)).toBeVisible();
  const tabs = detail(page).getByRole("tablist");
  const input = tabs.getByRole("textbox", { name: "문서 제목", exact: true });
  const ime =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : null;
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (let round = 0; round < 20; round++) {
      const index = round % 2;
      await test.step(`${width}px에서 ${round}회차 ${index + 1}번째 탭 이름 수정`, async () => {
        await tabs
          .locator(".document-tab-item")
          .nth(index)
          .getByRole("tab")
          .dblclick({ delay: 120 });
        await expect(input).toBeFocused();
        await input.fill("");
        await input.pressSequentially(`반복 편집 ${index} `);
        await input.fill("문서 제목을 길게 수정합니다 ".repeat(3));
        await input.fill(`${width} 작업 ${index}-${round}`);
        if (ime) {
          await input.press("End");
          for (const text of ["ㅈ", "제", "제목"])
            await ime.send("Input.imeSetComposition", {
              text,
              selectionStart: text.length,
              selectionEnd: text.length,
            });
        }
      });
    }
    if (ime) await ime.send("Input.insertText", { text: "제목" });
    await input.press("Enter");
    await expect(input).toHaveCount(0);
  }
  await info.attach("page-errors", {
    body: JSON.stringify(errors),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  await close(page);
  await open(page);
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(rich(page)).toContainText("유지할 첫 문서 본문");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__test/streams")).json()).length,
    )
    .toBe(1);
  const saved = await get(page, `/tasks/${taskIds[0]}/documents`);
  expect(saved.documents.map((doc: any) => doc.title)).toEqual([
    expect.stringContaining("390 작업 0-18"),
    expect.stringContaining("390 작업 1-19"),
  ]);
});

test("업무 상세와 꼬리 메모 탭은 제목 편집 높이·내용에 맞춘 폭·화살표 색상을 공유한다", async ({
  page,
}, info) => {
  await post(page, `/teams/${teamId}/years/2026/memos`, {
    id: randomUUID(),
    title: "문서 1",
  });
  async function checkTabs(root: Locator, name: string) {
    await page.evaluate(() => document.fonts.ready);
    const header = root.locator(".document-tabs");
    const body = root.locator(".document-page:not([hidden])").first();
    const geometry = async () => {
      const bar = (await header.boundingBox())!;
      return {
        height: bar.height,
        bodyOffset: (await body.boundingBox())!.y - bar.y,
      };
    };
    const before = await geometry();
    await root.getByRole("tab", { name: "문서 1", exact: true }).dblclick();
    const input = root.getByRole("textbox", { name: "문서 제목", exact: true });
    await expect(input).toBeFocused();
    const widths: number[] = [];
    for (const title of ["문서 1", "짧음", "가".repeat(50), "", "공통 제목"]) {
      await input.fill(title);
      const width = (await input.boundingBox())!.width;
      const expectedWidth = await root
        .locator(".document-tab-title-measure")
        .evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const style = getComputedStyle(el);
          return (
            range.getBoundingClientRect().width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth)
          );
        });
      expect
        .soft(width, `${name}: '${title}' 입력 폭`)
        .toBeCloseTo(expectedWidth, 0);
      expect
        .soft(await geometry(), `${name}: 제목 편집 중 높이와 본문 위치`)
        .toEqual(before);
      widths.push(width);
    }
    await header.screenshot({
      path: info.outputPath(`${name}-editing-tab.png`),
    });
    await input.press("Enter");
    await expect(
      root.getByRole("tab", { name: "공통 제목", exact: true }),
    ).toBeFocused();
    expect
      .soft(await geometry(), `${name}: 제목 저장 후 높이와 본문 위치`)
      .toEqual(before);
    await root
      .getByRole("button", {
        name: name === "task" ? "문서 추가" : "메모 추가",
        exact: true,
      })
      .click();
    await expect(root.getByRole("tab")).toHaveCount(2);
    for (const arrow of await header
      .locator(".document-tab-menu-trigger")
      .all()) {
      await page.mouse.move(0, 0);
      const colors = () =>
        arrow.evaluate((el) => {
          const style = getComputedStyle(el);
          return { color: style.color, background: style.backgroundColor };
        });
      const beforeHover = await colors();
      await arrow.hover();
      expect
        .soft(await colors(), `${name}: 화살표 hover 색상`)
        .toEqual(beforeHover);
    }
    return widths;
  }
  await open(page);
  const taskWidths = await checkTabs(detail(page), "task");
  await close(page);
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  await memos.getByRole("button", { name: "꼬리 메모", exact: true }).click();
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toBeVisible();
  const memoWidths = await checkTabs(memos, "memo");
  for (let index = 0; index < taskWidths.length; index++)
    expect
      .soft(taskWidths[index], "팝업과 메모의 동일 제목 입력 폭")
      .toBeCloseTo(memoWidths[index], 0);
});

test("탭 안의 제목 편집은 한글 조합·취소·저장 실패와 닫기 중 입력을 보존한다", async ({
  page,
}) => {
  await open(page);
  const input = detail(page).getByRole("textbox", {
    name: "문서 제목",
    exact: true,
  });
  let writes = 0,
    fail = false;
  let gate: Promise<void> | undefined;
  await page.route(
    `**/api/tasks/${taskIds[0]}/documents/main`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes++;
      if (gate) await gate;
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "제목 저장 실패 검증" }),
        });
      await route.continue();
    },
  );
  const firstTab = detail(page).getByRole("tab", {
    name: "문서 1",
    exact: true,
  });
  await firstTab.dblclick();
  await expect(
    detail(page)
      .locator(".document-tabs")
      .getByRole("textbox", { name: "문서 제목", exact: true }),
  ).toBeFocused();
  await expect(
    detail(page).getByRole("button", { name: "변경", exact: true }),
  ).toHaveCount(0);
  await expect(
    detail(page).getByRole("button", { name: "취소", exact: true }),
  ).toHaveCount(0);
  await input.fill("짧음");
  const shortWidth = (await input.boundingBox())!.width;
  await input.fill("가".repeat(51));
  await expect(input).toHaveValue("가".repeat(50));
  await expect
    .poll(async () => (await input.boundingBox())!.width)
    .toBeGreaterThan(shortWidth + 400);
  const measure = detail(page).locator(".document-tab-title-measure");
  expect((await input.boundingBox())!.width).toBeCloseTo(
    await measure.evaluate((element) => element.getBoundingClientRect().width),
    0,
  );
  await input.fill("짧음");
  await expect
    .poll(async () => (await input.boundingBox())!.width)
    .toBeCloseTo(shortWidth, 0);
  await input.fill("취소할 이름");
  await input.press("Escape");
  await expect(firstTab).toBeFocused();
  expect(writes).toBe(0);
  await firstTab.press("F2");
  await input.fill("   ");
  await input.press("Enter");
  await expect(detail(page).getByRole("alert")).toContainText(
    "문서 제목을 입력하세요.",
  );
  await expect(input).toBeFocused();
  await input.dispatchEvent("compositionstart");
  await input.fill("한글 문서");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(writes).toBe(0);
  await expect(input).toHaveValue("한글 문서");
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect(
    detail(page).getByRole("tab", { name: "한글 문서", exact: true }),
  ).toBeFocused();
  expect(writes).toBe(1);
  await detail(page)
    .getByRole("button", { name: "한글 문서 메뉴", exact: true })
    .click();
  await detail(page)
    .getByRole("menuitem", { name: "문서 이름 변경", exact: true })
    .click();
  await input.fill("보존할 문서 제목");
  fail = true;
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page).getByRole("alert")).toContainText(
    "제목 저장 실패 검증",
  );
  await expect(input).toHaveValue("보존할 문서 제목");
  await expect(input).toBeFocused();
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents`)).documents[0].title,
  ).toBe("한글 문서");
  fail = false;
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousWrites = writes;
  await input.press("Enter");
  await expect.poll(() => writes).toBe(previousWrites + 1);
  await expect(input).toHaveJSProperty("readOnly", true);
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail(page)).toBeVisible();
  release();
  await expect(detail(page)).toHaveCount(0);
  expect(writes).toBe(previousWrites + 1);
  await open(page);
  await expect(
    detail(page).getByRole("tab", { name: "보존할 문서 제목", exact: true }),
  ).toHaveText("보존할 문서 제목");
  await detail(page)
    .getByRole("tab", { name: "보존할 문서 제목", exact: true })
    .press("F2");
  await input.fill("가나다라마바사아자차");
  await input.press("Enter");
  const tenLetters = detail(page).getByRole("tab", {
    name: "가나다라마바사아자차",
    exact: true,
  });
  await expect(tenLetters).toHaveText("가나다라마바사아자…");
  await expect(tenLetters).toHaveAttribute("title", "가나다라마바사아자차");
  await tenLetters.press("F2");
  await expect(input).toHaveValue("가나다라마바사아자차");
  const longTitle = "나".repeat(50);
  await input.fill(longTitle);
  await rich(page).click();
  const longTab = detail(page).getByRole("tab", {
    name: longTitle,
    exact: true,
  });
  await expect(longTab).toHaveText("나".repeat(9) + "…");
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents`)).documents[0].title,
  ).toBe(longTitle);
});

test("문서 메뉴는 바깥 클릭·Escape·키보드 초점 이동으로 닫히고 상세는 유지된다", async ({
  page,
  browserName,
}) => {
  await save(page, taskIds[0], "메뉴 밖의 본문");
  const secondId = randomUUID();
  await post(page, `/tasks/${taskIds[0]}/documents`, {
    id: secondId,
    title: "둘째 문서",
  });
  await open(page);
  const tabs = detail(page).getByRole("tablist");
  await expect(tabs.getByRole("button", { name: / 메뉴$/ })).toHaveCount(2);
  await expect(
    detail(page).locator(".document-tab-actions [aria-haspopup=menu]"),
  ).toHaveCount(0);
  const trigger = tabs.getByRole("button", {
    name: "문서 1 메뉴",
    exact: true,
  });
  const menu = detail(page).getByRole("menu", {
    name: "문서 메뉴",
    exact: true,
  });
  const rename = menu.getByRole("menuitem", {
    name: "문서 이름 변경",
    exact: true,
  });
  await tabs.getByRole("tab", { name: "문서 1", exact: true }).focus();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rename).toBeFocused();
  await rich(page).getByText("메뉴 밖의 본문", { exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(rich(page)).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(detail(page)).toBeVisible();
  await trigger.click();
  await expect(rename).toBeFocused();
  await page.keyboard.press("Tab");
  // Safari may skip buttons in its native Tab order.
  if (
    await menu
      .getByRole("menuitem", { name: "문서 삭제", exact: true })
      .evaluateAll((items) =>
        items.some((item) => item === document.activeElement),
      )
  )
    await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(detail(page)).toBeVisible();
  await trigger.click();
  await expect(menu).toBeVisible();
  await trigger.click();
  await expect(menu).toHaveCount(0);
  // An inactive tab's menu saves the current draft, then targets its own document.
  await raw(page);
  await source(page).fill("메뉴 이동 직전 입력");
  await tabs
    .getByRole("button", { name: "둘째 문서 메뉴", exact: true })
    .click();
  await expect(
    tabs.getByRole("tab", { name: "둘째 문서", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe("메뉴 이동 직전 입력");
  await rename.click();
  const title = detail(page).getByRole("textbox", {
    name: "문서 제목",
    exact: true,
  });
  await title.fill("이름 바꾼 둘째");
  await title.press("Enter");
  await tabs.getByRole("tab", { name: "문서 1", exact: true }).click();
  await tabs
    .getByRole("button", { name: "이름 바꾼 둘째 메뉴", exact: true })
    .click();
  await menu.getByRole("menuitem", { name: "문서 삭제", exact: true }).click();
  await expect(detail(page).getByRole("alert")).toContainText(
    "‘이름 바꾼 둘째’ 문서를 삭제할까요?",
  );
  await detail(page)
    .getByRole("button", { name: "문서 삭제", exact: true })
    .click();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(source(page)).toHaveValue("메뉴 이동 직전 입력");
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents`)).documents.map(
      (doc: { id: string }) => doc.id,
    ),
  ).toEqual(["main"]);
});

test("문서 제목 제스처는 가로로 스크롤하고 양 끝 탐색을 막으며 도구는 같은 줄에 남는다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], "# 첫 문서\n\n" + "긴 본문 검증\n\n".repeat(45));
  for (let index = 0; index < 9; index++)
    await post(page, `/tasks/${taskIds[0]}/documents`, {
      id: randomUUID(),
      title: `설계 검토와 회의 기록 ${index + 1}`,
    });
  await open(page);
  const strip = detail(page).getByRole("tablist", {
    name: "업무 문서",
    exact: true,
  });
  const header = detail(page).locator(".document-tabs");
  const controls = header.locator(".document-controls");
  await expect(controls).toHaveCount(1);
  await expect(strip).toHaveCSS("overscroll-behavior-x", "contain");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await detail(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const headerBox = (await header.boundingBox())!;
  const controlsBox = (await controls.boundingBox())!;
  expect(controlsBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(
    headerBox.y + headerBox.height,
  );
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await strip.hover();
  await page.mouse.wheel(350, 0);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  const url = page.url();
  for (const direction of [1, -1]) {
    await strip.evaluate((el, direction) => {
      el.scrollLeft = direction > 0 ? el.scrollWidth : 0;
    }, direction);
    const before = await strip.evaluate((el) => el.scrollLeft);
    await page.mouse.wheel(direction * 300, 0);
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(before);
    expect(
      await strip.evaluate((el, direction) => {
        const wheel = new WheelEvent("wheel", {
          deltaX: direction * 300,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(wheel);
        return wheel.defaultPrevented;
      }, direction),
    ).toBe(true);
    expect(page.url()).toBe(url);
  }
  // Vertical gestures still scroll the document.
  await strip.hover();
  await page.mouse.wheel(0, 350);
  const body = detail(page).locator(".modal-body");
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await strip.getByRole("tab", { name: "문서 1", exact: true }).press("End");
  const last = strip.getByRole("tab", {
    name: "설계 검토와 회의 기록 9",
    exact: true,
  });
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const viewport = (await strip.boundingBox())!;
      const tab = (await last.boundingBox())!;
      const visibleWidth =
        Math.min(viewport.x + viewport.width, tab.x + tab.width) -
        Math.max(viewport.x, tab.x);
      return visibleWidth >= Math.min(viewport.width, tab.width) - 1;
    })
    .toBe(true);
  await expect(controls).toHaveCount(1);
  const lastMenu = strip.getByRole("button", {
    name: "설계 검토와 회의 기록 9 메뉴",
    exact: true,
  });
  await lastMenu.click();
  const popup = detail(page).getByRole("menu", {
    name: "문서 메뉴",
    exact: true,
  });
  await expect(popup).toBeVisible();
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(390);
  for (const item of await popup.getByRole("menuitem").all()) {
    expect(
      await item.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    ).toBe(true);
  }
  await detail(page).screenshot({
    path: info.outputPath("document-tab-menu-mobile.png"),
  });
  await strip.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(popup).toHaveCount(0);
  await last.press("F2");
  const input = header.getByRole("textbox", { name: "문서 제목", exact: true });
  await input.fill("긴 제목을 탭에서 바로 수정합니다 ".repeat(3));
  expect((await header.boundingBox())!.height).toBeCloseTo(headerBox.height, 0);
  await detail(page).screenshot({
    path: info.outputPath("document-inline-title-mobile.png"),
  });
  await input.press("Escape");
  await raw(page);
  await source(page).fill("마지막 문서에만 저장되는 본문");
  await last.press("Home");
  await expect(rich(page)).toContainText("첫 문서");
  await expect(
    header.getByRole("button", { name: "리치 문서", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 1366, height: 900 });
  await detail(page).screenshot({
    path: info.outputPath("document-compact-header.png"),
  });
  await close(page);
});

test("문서 제목 탭과 리치 도구는 긴 문서에서 고정되고 이미지 크기·확대가 유지된다", async ({
  page,
}, info) => {
  await save(
    page,
    taskIds[0],
    "# 긴 문서\n\n<br />\n\n| 항목 | 내용 |\n| --- | --- |\n| 확인 | 정상 |\n\n" +
      "검토할 긴 본문입니다.\n\n".repeat(60),
  );
  await open(page);
  await expect(rich(page).locator("table")).toHaveCount(1);
  await expect(rich(page)).not.toContainText("<br");
  const body = detail(page).locator(".modal-body");
  await body.evaluate((el) => (el.scrollTop = 700));
  const bounds = await body.boundingBox(),
    tabs = await detail(page).locator(".document-tabs").boundingBox(),
    controls = await detail(page).locator(".document-controls").boundingBox(),
    tools = await detail(page).locator(".document-rich-tools").boundingBox();
  expect(tabs!.y).toBeCloseTo(bounds!.y, 0);
  expect(controls!.y).toBeGreaterThanOrEqual(tabs!.y);
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(
    tabs!.y + tabs!.height,
  );
  expect(tools!.y).toBeCloseTo(tabs!.y + tabs!.height, 0);
  await body.evaluate((el) => (el.scrollTop = 0));
  await rich(page).focus();
  await rich(page).press("ControlOrMeta+Home");
  await pasteImage(page);
  const image = rich(page).locator("img[src]");
  await expect(image).toBeVisible();
  const size = detail(page).getByRole("slider", { name: "이미지 너비 조절" });
  await size.focus();
  await size.press("ArrowLeft");
  await expect(detail(page).locator(".document-save-state")).toHaveText(
    "저장됨",
  );
  const markdown = (await get(page, `/tasks/${taskIds[0]}/documents/main`))
    .markdown;
  expect(markdown).toContain("width=");
  await image.dblclick();
  const preview = page.getByRole("dialog", {
    name: "이미지 크게 보기",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await detail(page)
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await expect(detail(page).locator(".task-detail-properties")).toBeVisible();
  await detail(page).screenshot({
    path: info.outputPath("document-tabs-rich-image.png"),
  });
  await close(page);
  await open(page);
  expect(
    (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
  ).toBe(markdown);
});

test("빈 문서 안내를 열어 둔 상태에서도 다른 사용자의 첫 본문이 자동으로 나타난다", async ({
  page,
}) => {
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  await expect(
    detail(page).getByRole("button", { name: "문서 작성", exact: true }),
  ).toBeVisible();
  await save(page, taskIds[0], "다른 사용자가 처음 작성한 본문");
  await expect(rich(page)).toContainText("다른 사용자가 처음 작성한 본문", {
    timeout: 3000,
  });
});

test("SharedWorker는 여덟 탭의 시트·문서를 한 연결로 공유하고 첫 탭 종료·재접속을 복구한다", async ({
  page,
}) => {
  test.setTimeout(90000);
  await save(page, taskIds[0], "공유 첫 본문");
  await save(page, taskIds[1], "다른 업무 본문");
  const tabs = [page];
  const connections = async () =>
    await (await page.request.get("/__test/streams")).json();
  const cell = (tab: Page) => tab.locator(`[data-cell="${taskIds[0]}:title"]`);
  for (let i = 1; i < 8; i++) {
    const tab = await page.context().newPage();
    tabs.push(tab);
    await tab.goto("/");
    await tab.getByLabel("팀 선택").selectOption(teamId);
    await expect(cell(tab)).toBeVisible();
    if (i === 1)
      await expect.poll(async () => (await connections()).length).toBe(1);
  }
  await expect
    .poll(async () => (await connections())[0]?.streams.length)
    .toBe(2);
  await open(tabs[1], taskIds[0]);
  await open(tabs[2], taskIds[1]);
  await expect(rich(tabs[1])).toContainText("공유 첫 본문");
  await expect(rich(tabs[2])).toContainText("다른 업무 본문");
  await open(tabs[3], taskIds[0]);
  await expect
    .poll(async () => (await connections())[0]?.streams.length)
    .toBe(6);
  await raw(tabs[1]);
  await source(tabs[1]).fill("여덟 탭에서도 저장되는 본문");
  await expect(rich(tabs[3])).toContainText("여덟 탭에서도 저장되는 본문");
  await expect(rich(tabs[2])).toHaveText("다른 업무 본문");
  await tabs[1].getByRole("tab", { name: "문서 1", exact: true }).dblclick();
  const title = tabs[1].getByRole("textbox", {
    name: "문서 제목",
    exact: true,
  });
  await title.fill("여러 탭 제목 변경");
  await title.press("Enter");
  await expect(
    tabs[3].getByRole("tab", { name: "여러 탭 제목 변경", exact: true }),
  ).toBeVisible();
  await page.close(); // The page which originally created the worker is gone.
  await tabs[2].close(); // Its private document subscriptions must disappear.
  await expect
    .poll(async () => (await connections())[0]?.streams.length)
    .toBe(4);
  const changeCell = async (value: string) => {
    const data = await get(tabs[1], `/tasks?teamId=${teamId}&year=2026`);
    await post(tabs[1], "/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: taskIds[0],
          key: "title",
          value,
          expectedVersion: data.tasks.find(
            (task: any) => task.id === taskIds[0],
          ).cells.title.version,
        },
      ],
    });
  };
  await changeCell("첫 탭 종료 후 실시간 변경");
  await expect(cell(tabs[7])).toHaveText("첫 탭 종료 후 실시간 변경");
  // Periodic full polling must not hide a broken replay connection.
  await tabs[7].route("**/api/tasks?**", (route) => route.abort());
  await tabs[1].request.post("/__test/streams/disconnect");
  await changeCell("연결 단절 중 변경");
  // Development proxies may keep the downstream open; the broker also detects
  // missing server heartbeats, independently of the worker's page heartbeat.
  await expect
    .poll(async () => (await connections()).length, { timeout: 50000 })
    .toBe(1);
  await expect(cell(tabs[7])).toHaveText("연결 단절 중 변경");
  // Page lifecycle cleanup and return preserve subscriptions and cursors.
  await tabs[7].evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await changeCell("복귀 시 복구할 변경");
  await tabs[7].evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(cell(tabs[7])).toHaveText("복귀 시 복구할 변경");
  for (const tab of tabs.filter((tab) => !tab.isClosed())) await tab.close();
  await expect.poll(async () => (await connections()).length).toBe(0);
});

test("SharedWorker를 사용할 수 없어도 한 페이지의 문서 저장과 실시간 연결은 유지한다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SharedWorker", { value: undefined });
  });
  await page.reload();
  await save(page, taskIds[0], "폴백 기존 본문");
  await open(page);
  await raw(page);
  await source(page).fill("폴백에서도 저장");
  await expect
    .poll(
      async () =>
        (await get(page, `/tasks/${taskIds[0]}/documents/main`)).markdown,
    )
    .toBe("폴백에서도 저장");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__test/streams")).json()).length,
    )
    .toBe(1);
  await close(page);
});

test("SharedWorker가 종료되어도 화면 복귀 시 연결과 본문 동기화를 복구한다", async ({
  page,
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "실제 worker 종료는 CDP로 검증한다");
  await save(page, taskIds[0], "종료 전 본문");
  await open(page);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__test/streams")).json()).length,
    )
    .toBe(1);
  const pageSession = await page.context().newCDPSession(page);
  const { targetInfo } = await pageSession.send("Target.getTargetInfo");
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const worker = targetInfos.find(
    (target: any) =>
      target.type === "shared_worker" &&
      target.browserContextId === targetInfo.browserContextId &&
      target.url.includes("event-stream.worker"),
  );
  expect(worker).toBeDefined();
  expect(
    (await session.send("Target.closeTarget", { targetId: worker!.targetId }))
      .success,
  ).toBeTruthy();
  await save(page, taskIds[0], "종료 중 변경 본문", 1);
  await page.bringToFront();
  // Simulate the elapsed heartbeat deadline without a 45-second test sleep.
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 46000;
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = now;
  });
  await expect(rich(page)).toContainText("종료 중 변경 본문");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__test/streams")).json()).length,
    )
    .toBe(1);
  await session.detach();
  await pageSession.detach();
});

test("다른 탭의 상세 열기·문서 전환은 현재 탭의 시트 재조회와 본문 재전송을 만들지 않는다", async ({
  page,
}, info) => {
  await save(page, taskIds[0], "관찰할 본문");
  await save(page, taskIds[1], "전환할 본문");
  const second = randomUUID();
  await post(page, `/tasks/${taskIds[1]}/documents`, {
    id: second,
    title: "전환 문서",
  });
  const peer = await page.context().newPage();
  await peer.addInitScript(() => {
    // Isolate subscription-triggered requests from the independent safety poll.
    const interval = window.setInterval.bind(window);
    window.setInterval = (handler, timeout, ...args) =>
      interval(timeout === 7000 ? () => {} : handler, timeout, ...args);
    const Native = window.SharedWorker;
    (window as any).__streamObservation = { documents: [], opens: 0 };
    window.SharedWorker = class extends Native {
      constructor(...args: ConstructorParameters<typeof SharedWorker>) {
        super(...args);
        this.port.addEventListener("message", (event) => {
          const message = event.data;
          const observation = (window as any).__streamObservation;
          if (message.kind === "event" && message.event === "document")
            observation.documents.push(message);
          if (message.kind === "state" && message.readyState === 1)
            observation.opens++;
        });
      }
    };
  });
  await peer.goto("/");
  await peer.getByLabel("팀 선택").selectOption(teamId);
  await open(peer, taskIds[0]);
  await expect(rich(peer)).toHaveText("관찰할 본문");
  const observed = () =>
    peer.evaluate(() => (window as any).__streamObservation);
  await expect
    .poll(async () => (await observed()).documents.length)
    .toBeGreaterThan(0);
  await peer.waitForTimeout(500);
  await peer.evaluate(() => {
    (window as any).__streamObservation.documents = [];
  });
  const requests: string[] = [];
  peer.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      ["/api/tasks", "/api/bootstrap", "/api/reports"].includes(path)
    )
      requests.push(path);
  });
  async function churn(action: () => Promise<void>) {
    const before = (await observed()).opens;
    await action();
    await expect
      .poll(async () => (await observed()).opens)
      .toBeGreaterThan(before);
    await peer.waitForTimeout(500);
  }
  await churn(() => open(page, taskIds[1]));
  await churn(async () => {
    await detail(page)
      .getByRole("tab", { name: "전환 문서", exact: true })
      .click();
    await expect(
      detail(page).getByRole("tab", { name: "전환 문서", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await churn(() => close(page));
  await churn(() => open(page, taskIds[0])); // A new listener to the peer's existing body channel.
  await close(page);
  await peer.waitForTimeout(500);
  const result = {
    requests,
    documentFrames: (await observed()).documents.length,
  };
  await info.attach("two-tab-network.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result).toEqual({ requests: [], documentFrames: 0 });
  await expect(rich(peer)).toHaveText("관찰할 본문");
  await peer.close();
});

test("문서 메뉴를 여는 저장 대기 중 원격 삭제되어도 패널이 유지된다", async ({
  page,
}) => {
  await save(page, taskIds[0], "삭제 경합 전 본문");
  const second = randomUUID();
  const collection = `/tasks/${taskIds[0]}/documents`;
  await post(page, collection, { id: second, title: "원격 삭제할 문서" });
  await open(page);
  await raw(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving = false;
  await page.route(`**/api${collection}/main`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saving = true;
    await gate;
    await route.continue();
  });
  try {
    await source(page).fill("삭제 경합 중 보존할 본문");
    await detail(page)
      .getByRole("button", { name: "원격 삭제할 문서 메뉴", exact: true })
      .click();
    await expect.poll(() => saving).toBe(true);
    const removed = await page.request.delete(`/api${collection}/${second}`, {
      headers,
      data: { expectedRevision: 0 },
    });
    expect(removed.ok(), await removed.text()).toBeTruthy();
    await expect(
      detail(page).getByRole("tab", { name: "원격 삭제할 문서", exact: true }),
    ).toHaveCount(0);
    release();
    await expect
      .poll(async () => (await get(page, `${collection}/main`)).markdown)
      .toBe("삭제 경합 중 보존할 본문");
    await detail(page)
      .getByRole("tab", { name: "문서 1", exact: true })
      .click();
    await expect(source(page)).toHaveValue("삭제 경합 중 보존할 본문");
    await detail(page)
      .getByRole("button", { name: "문서 1 메뉴", exact: true })
      .click();
    await expect(
      detail(page).getByRole("menu", { name: "문서 메뉴", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await close(page);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
