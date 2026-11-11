import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { defaultView, todayKey } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskIds: string[];
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
const saveTask = (page: Page, id: string, markdown: string) =>
  request(page, `/tasks/${id}/documents/main`, "PUT", {
    markdown,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
const taskMarkdown = async (page: Page, id: string) =>
  (await request(page, `/tasks/${id}/documents/main`)).markdown as string;
async function rename(page: Page, id: string, title: string) {
  const task = (await request(page, `/calendar/tasks/${id}`)).task;
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: id,
        key: "title",
        value: title,
        expectedVersion: task.cells.title?.version ?? 0,
      },
    ],
  });
}
async function entry(page: Page, title = "링크할 일정") {
  return request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title,
    date: todayKey(),
    endDate: todayKey(),
  });
}
const details = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const calendarDetail = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const rich = (dialog: Locator) =>
  dialog.getByRole("textbox", { name: /리치 편집$/ });
const links = (dialog: Locator) => rich(dialog).locator(".document-link");
async function open(page: Page, id = taskIds[0]) {
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  const dialog = details(page).first();
  await expect(dialog).toBeVisible();
  const start = dialog.getByRole("button", { name: "문서 작성", exact: true });
  await expect(rich(dialog).or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(rich(dialog)).toBeVisible();
  return dialog;
}
async function paste(editor: Locator, text: string, html = "") {
  await editor.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await editor.evaluate(
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
// Chromium reads the real clipboard. Firefox and WebKit grant no clipboard
// permission to Playwright, so their asynchronous clipboard is observed.
async function copied(
  page: Page,
  browserName: string,
  button: Locator,
): Promise<{ text: string; html: string }> {
  // Each copy button shows its own notice next to it.
  const notice = button.locator("xpath=following-sibling::*[1]");
  if (browserName === "chromium") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await button.click();
    await expect(notice).toHaveText("링크를 복사했습니다.");
    return page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const read = async (type: string) =>
        item.types.includes(type) ? (await item.getType(type)).text() : "";
      return {
        types: item.types,
        text: await read("text/plain"),
        html: await read("text/html"),
      };
    });
  }
  await page.evaluate(() => {
    (window as any).__copied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).__copied = {
            text: await (await items[0].getType("text/plain")).text(),
            html: await (await items[0].getType("text/html")).text(),
          };
        },
      },
    });
  });
  await button.click();
  await expect(notice).toHaveText("링크를 복사했습니다.");
  return page.evaluate(() => (window as any).__copied);
}
async function memo(page: Page, title: string, year = 2026, markdown = "") {
  const id = randomUUID(),
    path = `/teams/${teamId}/years/${year}/memos`;
  await request(page, path, "POST", { id, title });
  if (markdown)
    await request(page, `${path}/${id}`, "PUT", {
      markdown,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  return id;
}
const copySheet = (page: Page, name = "링크 사본") =>
  request(page, "/sheet-clones", "POST", {
    teamId,
    year: 2026,
    name,
    referenceDate: "2026-10-26",
    view: defaultView(2026),
    taskIds,
  }).then((sheetClone) => sheetClone.id as string);
const memoCard = (page: Page, id: string) =>
  page.locator(`.memo-document-card[data-document-id="${id}"]`);
async function openMemos(page: Page) {
  const toggle = page
    .getByRole("region", { name: "연간 업무 메모 목록" })
    .getByRole("button", { name: "꼬리 메모", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
// The copy button sits immediately left of the full-page button.
async function besideExpand(scope: Locator) {
  const copy = scope.getByRole("button", { name: "링크 복사", exact: true });
  const expand = scope.locator(".document-expand");
  await expect(copy).toBeVisible();
  expect(
    await copy.evaluate((button) => {
      // Skip this button's own notice when it is showing.
      let next = button.nextElementSibling;
      while (next?.classList.contains("toast")) next = next.nextElementSibling;
      return next?.classList.contains("document-expand");
    }),
  ).toBe(true);
  const [left, right] = await Promise.all([
    copy.boundingBox(),
    expand.boundingBox(),
  ]);
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
  expect(right!.x - (left!.x + left!.width)).toBeLessThan(12);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
  return copy;
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
      name: `링크 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  taskIds = [];
  for (const title of ["링크 원본 업무", "링크 대상 업무"])
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

test("업무 상세의 링크 복사는 전체 페이지 버튼 왼쪽에서 주소와 제목을 복사하고 다른 문서에 아이콘과 제목으로 붙는다", async ({
  page,
  browserName,
}, info) => {
  const target = await open(page, taskIds[1]);
  const heading = target.locator(".modal-heading > button");
  await expect(heading).toHaveCount(2);
  await expect(heading.nth(0)).toHaveAccessibleName("링크 복사");
  await expect(heading.nth(1)).toHaveClass(/document-expand/);
  const [copy, expand] = await Promise.all(
    [heading.nth(0), heading.nth(1)].map((button) => button.boundingBox()),
  );
  expect(copy!.x + copy!.width).toBeLessThanOrEqual(expand!.x);
  expect(Math.abs(copy!.y - expand!.y)).toBeLessThan(1);
  const url = new URL(`/links/task/${taskIds[1]}`, page.url()).href;
  const clip = await copied(page, browserName, heading.nth(0));
  expect(clip.text).toBe(url);
  expect(clip.html).toContain(`href="${url}"`);
  expect(clip.html).toContain(">링크 대상 업무</a>");
  await target.screenshot({ path: info.outputPath("copy-link-button.png") });
  await target.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(details(page)).toHaveCount(0);

  const source = await open(page);
  await paste(rich(source), clip.text, clip.html);
  await expect(links(source)).toHaveCount(1);
  await expect(links(source)).toHaveText("링크 대상 업무");
  await expect(links(source).locator("svg")).toHaveCount(1);
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toContain(`[링크 대상 업무](/links/task/${taskIds[1]})`);
  await source.screenshot({ path: info.outputPath("pasted-link.png") });
  // Only an address: the looked-up title becomes the stored link text.
  const scheduled = await entry(page);
  const entryUrl = new URL(`/links/calendar/${scheduled.id}`, page.url()).href;
  await rich(source).press("End");
  await paste(rich(source), entryUrl);
  await expect(links(source)).toHaveCount(2);
  await expect(links(source).nth(1)).toHaveText("링크할 일정");
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toContain(`[링크할 일정](/links/calendar/${scheduled.id})`);
  expect(await taskMarkdown(page, taskIds[0])).not.toContain(entryUrl);
  // Undo removes the pasted link in one step.
  await source
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(links(source)).toHaveCount(1);
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .not.toContain("/links/calendar/");
  // The Markdown source shows the plain link.
  await source
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(
    source.getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toHaveValue(
    new RegExp(`\\[링크 대상 업무\\]\\(/links/task/${taskIds[1]}\\)`),
  );
});

test("주소만 쓸 수 있는 HTTP 사이트에서도 복사 명령으로 링크를 복사한다", async ({
  page,
}) => {
  const dialog = await open(page, taskIds[1]);
  await page.evaluate(() => {
    Object.defineProperty(window, "isSecureContext", { value: false });
    const copied: Record<string, string> = ((window as any).__copied = {});
    const setData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (type, value) {
      copied[type === "text/plain" ? "text" : "html"] = value;
      return setData.call(this, type, value);
    };
  });
  await dialog.getByRole("button", { name: "링크 복사", exact: true }).click();
  await expect(dialog.locator(".toast")).toHaveText("링크를 복사했습니다.");
  const clip = await page.evaluate(() => (window as any).__copied);
  expect(clip.text).toBe(new URL(`/links/task/${taskIds[1]}`, page.url()).href);
  expect(clip.html).toContain(">링크 대상 업무</a>");
});

test("링크는 대상의 현재 제목을 보여 주고 문서에는 다시 쓰지 않는다", async ({
  page,
}) => {
  const markdown = `앞 [예전 제목](/links/task/${taskIds[1]}) 뒤\n`;
  const saved = await saveTask(page, taskIds[0], markdown);
  let source = await open(page);
  await expect(links(source)).toHaveText("링크 대상 업무");
  await expect(links(source)).toHaveAttribute("data-state", "ready");
  await rename(page, taskIds[1], "바뀐 대상 업무");
  await source.getByRole("button", { name: "닫기", exact: true }).click();
  source = await open(page);
  await expect(links(source)).toHaveText("바뀐 대상 업무");
  // Renaming in the linked detail shows at once in the linking document.
  await links(source).click();
  const linked = details(page).nth(1);
  await expect(
    linked.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("바뀐 대상 업무");
  await linked
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("상세에서 바꾼 이름");
  await linked.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(details(page)).toHaveCount(1);
  await expect(links(source)).toHaveText("상세에서 바꾼 이름");
  const stored = await request(page, `/tasks/${taskIds[0]}/documents/main`);
  expect(stored.markdown).toBe(markdown);
  expect(stored.revision).toBe(saved.revision);
});

test("링크를 누르면 편집·발표 중에도 업무 상세와 일정 상세가 위에 열린다", async ({
  page,
}) => {
  const scheduled = await entry(page);
  await saveTask(
    page,
    taskIds[0],
    `[업무](/links/task/${taskIds[1]}) 와 [일정](/links/calendar/${scheduled.id})\n`,
  );
  await request(page, `/calendar/entries/${scheduled.id}/document`, "PUT", {
    markdown: `[원본으로](/links/task/${taskIds[0]})\n`,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  const source = await open(page);
  await expect(links(source)).toHaveText(["링크 대상 업무", "링크할 일정"]);
  await links(source).nth(0).click();
  await expect(details(page)).toHaveCount(2);
  const linked = details(page).nth(1);
  await expect(
    linked.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  await expect(
    linked.getByRole("button", { name: "링크 복사", exact: true }),
  ).toBeVisible();
  await linked.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(details(page)).toHaveCount(1);
  await links(source).nth(1).click();
  const scheduledDetail = calendarDetail(page);
  await expect(
    scheduledDetail.getByRole("textbox", { name: "일정 제목", exact: true }),
  ).toHaveValue("링크할 일정");
  // A link back to the detail already open below does not open it again.
  await links(scheduledDetail).click();
  await expect(details(page)).toHaveCount(1);
  await scheduledDetail
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(calendarDetail(page)).toHaveCount(0);
  await source.getByRole("button", { name: "닫기", exact: true }).click();

  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await page
    .locator(`[data-cell="${taskIds[0]}:title"] .task-document-indicator`)
    .click();
  const presented = details(page).first();
  await expect(rich(presented)).toHaveAttribute("contenteditable", "false");
  await links(presented).nth(0).click();
  const readOnly = details(page).nth(1);
  await expect(
    readOnly.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  await expect(
    readOnly.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).not.toBeEditable();
});

test("⌘/Ctrl+클릭은 새 탭으로 열고 그 주소는 팀과 화면을 바꿔 상세를 연다", async ({
  page,
}) => {
  const scheduled = await entry(page);
  await saveTask(
    page,
    taskIds[0],
    `[업무](/links/task/${taskIds[1]}) [일정](/links/calendar/${scheduled.id}) [자료](https://example.com/docs)\n`,
  );
  const source = await open(page);
  await page.evaluate(() => {
    (window as any).__opened = [];
    window.open = (...args: unknown[]) => {
      (window as any).__opened.push(args);
      return null;
    };
  });
  // A web link opens in a new tab with or without the modifier, also while
  // editing.
  const web = rich(source).getByRole("link", { name: "자료", exact: true });
  await web.click();
  await links(source)
    .nth(0)
    .click({ modifiers: ["ControlOrMeta"] });
  await web.click({ modifiers: ["ControlOrMeta"] });
  const taskUrl = new URL(`/links/task/${taskIds[1]}`, page.url()).href;
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
    [taskUrl, "_blank", "noopener,noreferrer"],
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
  ]);
  await expect(details(page)).toHaveCount(1);
  await source.getByRole("button", { name: "닫기", exact: true }).click();

  // The address opens the target's team, even from another team.
  const other = (
    await request(page, "/admin/teams", "POST", {
      name: `다른 팀 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await page.getByLabel("팀 선택").selectOption(other);
  await page.goto(taskUrl);
  await expect(page.getByLabel("팀 선택")).toHaveValue(teamId);
  const opened = details(page);
  await expect(
    opened.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  expect(new URL(page.url()).pathname).toBe("/");
  await opened.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[1]}:title"]`)).toBeVisible();

  await page.goto(`/links/calendar/${scheduled.id}`);
  await expect(
    calendarDetail(page).getByRole("textbox", {
      name: "일정 제목",
      exact: true,
    }),
  ).toHaveValue("링크할 일정");
  await expect(page.locator(".calendar-grid")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/calendar");
  await calendarDetail(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();

  // A memo address opens over its team's annual screen.
  const id = await memo(page, "주소로 연 메모", 2026, "주소 메모 본문");
  await page.getByLabel("팀 선택").selectOption(other);
  await page.goto(`/links/memo/${teamId}/2026/${id}`);
  await expect(
    page.getByRole("dialog", { name: "주소로 연 메모", exact: true }),
  ).toContainText("주소 메모 본문");
  await expect(page.getByLabel("팀 선택")).toHaveValue(teamId);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("일정 상세의 링크 복사도 전체 페이지 버튼 왼쪽에 있고 일정 주소를 복사한다", async ({
  page,
  browserName,
}) => {
  const scheduled = await entry(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${scheduled.id}"] .calendar-entry-card`)
    .first()
    .click();
  const dialog = calendarDetail(page);
  const heading = dialog.locator(".modal-heading > button");
  await expect(heading).toHaveCount(2);
  await expect(heading.nth(0)).toHaveAccessibleName("링크 복사");
  await expect(heading.nth(1)).toHaveClass(/document-expand/);
  const [copy, expand] = await Promise.all(
    [heading.nth(0), heading.nth(1)].map((button) => button.boundingBox()),
  );
  expect(copy!.x + copy!.width).toBeLessThanOrEqual(expand!.x);
  const clip = await copied(page, browserName, heading.nth(0));
  expect(clip.text).toBe(
    new URL(`/links/calendar/${scheduled.id}`, page.url()).href,
  );
  expect(clip.html).toContain(">링크할 일정</a>");
});

test("삭제했거나 열 수 없는 링크는 저장된 글자를 흐리게 보이고 누르면 안내한다", async ({
  page,
}, info) => {
  const missing = randomUUID();
  await saveTask(
    page,
    taskIds[0],
    `[지운 업무](/links/task/${taskIds[1]}) [없는 일정](/links/calendar/${missing})\n`,
  );
  await request(page, "/tasks/delete", "POST", {
    tasks: [
      {
        id: taskIds[1],
        updatedAt: (await request(page, `/calendar/tasks/${taskIds[1]}`)).task
          .updatedAt,
      },
    ],
  });
  await page.reload();
  const source = await open(page);
  await expect(links(source)).toHaveText(["지운 업무", "없는 일정"]);
  await expect(links(source).nth(0)).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  await expect(links(source).nth(1)).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  await links(source).nth(0).click();
  await expect(source.getByRole("alert")).toHaveText(
    "링크한 문서를 열 수 없습니다. 삭제되었거나 접근 권한이 없습니다.",
  );
  await expect(details(page)).toHaveCount(1);
  await source.screenshot({ path: info.outputPath("unavailable-link.png") });
  await source.getByRole("button", { name: "닫기", exact: true }).click();
  await page.goto(`/links/calendar/${missing}`);
  await expect(page.locator(".board-error")).toContainText(
    "링크한 문서를 열 수 없습니다.",
  );
  expect(new URL(page.url()).pathname).toBe("/");
});

test("기존 HTTP 링크는 붙여넣기·읽기 전용 클릭에서 그대로 동작한다", async ({
  page,
}) => {
  const source = await open(page);
  await paste(
    rich(source),
    "외부 자료",
    '<a href="https://example.com/docs">외부 자료</a>',
  );
  await expect(
    rich(source).getByRole("link", { name: "외부 자료", exact: true }),
  ).toHaveAttribute("href", "https://example.com/docs");
  // Other relative addresses stay text, as before.
  await rich(source).press("End");
  await paste(
    rich(source),
    " 상대 경로",
    '<a href="/other/path">상대 경로</a>',
  );
  await expect(rich(source)).toContainText("상대 경로");
  await expect(rich(source).getByRole("link")).toHaveCount(1);
  await expect(links(source)).toHaveCount(0);
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toMatch(/^\[외부 자료\]\(https:\/\/example\.com\/docs\)\s+상대 경로\n$/);
  await source.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await page
    .locator(`[data-cell="${taskIds[0]}:title"] .task-document-indicator`)
    .click();
  const presented = details(page);
  await page.evaluate(() => {
    (window as any).__opened = [];
    window.open = (...args: unknown[]) => {
      (window as any).__opened.push(args);
      return null;
    };
  });
  await rich(presented).getByRole("link", { name: "외부 자료" }).click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
  ]);
});

test("링크 버튼은 주소와 표시 이름을 한 줄씩 받고, 커서가 링크에 있으면 주소와 열기·복사·수정·제거를 보인다", async ({
  page,
}) => {
  await saveTask(page, taskIds[0], "앞 글자 네이버 뒤 글자\n");
  const source = await open(page);
  await page.evaluate(() => {
    (window as any).__opened = [];
    window.open = (...args: unknown[]) => {
      (window as any).__opened.push(args);
      return null;
    };
    (window as any).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).__copied.push(
            await (await items[0].getType("text/plain")).text(),
          );
        },
      },
    });
  });
  // Select "네이버".
  await rich(source)
    .locator("p")
    .first()
    .evaluate((el) => {
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, 5);
      range.setEnd(text, 8);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      (el.closest("[contenteditable]") as HTMLElement).focus();
    });
  await rich(source).evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await source.getByRole("button", { name: "링크", exact: true }).click();
  const address = source.getByRole("textbox", { name: "링크 주소" });
  const name = source.getByRole("textbox", { name: "표시 이름" });
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("");
  await expect(name).toHaveValue("네이버");
  // Each label stays on its field's line.
  for (const [label, field] of [
    ["링크 주소", address],
    ["표시 이름", name],
  ] as const) {
    const text = (await source
      .locator(".document-link-form span", { hasText: label })
      .boundingBox())!;
    const box = (await field.boundingBox())!;
    expect(text.height).toBeLessThan(box.height);
    expect(text.x + text.width).toBeLessThanOrEqual(box.x);
    expect(
      Math.abs(text.y + text.height / 2 - (box.y + box.height / 2)),
    ).toBeLessThan(4);
  }
  await address.fill("https://www.naver.com");
  await name.fill("네이버 바로가기");
  await source.getByRole("button", { name: "적용", exact: true }).click();
  const link = rich(source).getByRole("link", { name: "네이버 바로가기" });
  await expect(link).toHaveAttribute("href", "https://www.naver.com");
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toBe("앞 글자 [네이버 바로가기](https://www.naver.com) 뒤 글자\n");

  // The caret in the link shows its address and actions below it.
  const tip = source.getByRole("group", { name: "링크", exact: true });
  await expect(tip).toContainText("https://www.naver.com");
  const linkBox = (await link.boundingBox())!;
  const tipBox = (await tip.boundingBox())!;
  expect(tipBox.y).toBeGreaterThan(linkBox.y + linkBox.height - 1);
  await tip.getByRole("button", { name: "링크 열기" }).click();
  await tip.getByRole("button", { name: "링크 주소 복사" }).click();
  await expect(
    source.getByRole("status").filter({ hasText: "링크 주소를" }),
  ).toHaveText("링크 주소를 복사했습니다.");
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([
    "https://www.naver.com",
  ]);
  // Esc closes the form only.
  await tip.getByRole("button", { name: "링크 수정" }).click();
  await expect(address).toHaveValue("https://www.naver.com");
  await expect(name).toHaveValue("네이버 바로가기");
  await name.press("Escape");
  await expect(address).toHaveCount(0);
  await expect(source).toBeVisible();
  await expect(tip).toBeVisible();
  await tip.getByRole("button", { name: "링크 수정" }).click();
  await address.fill("https://example.com/docs");
  await address.press("Enter");
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toBe("앞 글자 [네이버 바로가기](https://example.com/docs) 뒤 글자\n");
  await tip.getByRole("button", { name: "링크 제거" }).click();
  await expect(rich(source).getByRole("link")).toHaveCount(0);
  await expect(tip).toHaveCount(0);
  await expect
    .poll(() => taskMarkdown(page, taskIds[0]))
    .toBe("앞 글자 네이버 바로가기 뒤 글자\n");
  // A plain click opens a web link, and its caret shows the actions.
  await rich(source).press("ControlOrMeta+z");
  await rich(source).getByRole("link", { name: "네이버 바로가기" }).click();
  await expect(tip).toContainText("https://example.com/docs");
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
    ["https://www.naver.com", "_blank", "noopener,noreferrer"],
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
  ]);
});

test("꼬리 메모와 사본의 업무 상세·메모에도 전체 페이지 버튼 왼쪽에 링크 복사가 있다", async ({
  page,
  browserName,
}, info) => {
  const id = await memo(page, "링크할 메모");
  const sheetClone = await copySheet(page);
  await page.reload();
  await openMemos(page);
  const card = memoCard(page, id);
  let clip = await copied(page, browserName, await besideExpand(card));
  expect(clip.text).toBe(
    new URL(`/links/memo/${teamId}/2026/${id}`, page.url()).href,
  );
  expect(clip.html).toContain(">링크할 메모</a>");
  await card
    .locator(".memo-document-heading")
    .screenshot({ path: info.outputPath("memo-copy-button.png") });

  const tab = page.getByRole("tab", { name: "링크 사본", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await openMemos(page);
  clip = await copied(
    page,
    browserName,
    await besideExpand(memoCard(page, id)),
  );
  expect(clip.text).toBe(
    new URL(`/links/sheet-clone-memo/${sheetClone}/${id}`, page.url()).href,
  );
  await page
    .locator(`[data-cell="${taskIds[1]}:title"]`)
    .click({ button: "right" });
  const detail = details(page);
  await expect(detail).toBeVisible();
  clip = await copied(page, browserName, await besideExpand(detail));
  expect(clip.text).toBe(
    new URL(`/links/sheet-clone-task/${sheetClone}/${taskIds[1]}`, page.url())
      .href,
  );
  expect(clip.html).toContain(">링크 대상 업무</a>");
});

const memoPage = (page: Page, title: string) =>
  page.getByRole("dialog", { name: title, exact: true });
const memoToggle = (page: Page) =>
  page
    .getByRole("region", { name: "연간 업무 메모 목록" })
    .getByRole("button", { name: "꼬리 메모", exact: true });

test("메모 링크는 지금 화면 위에 그 메모만 전체 페이지로 열고 닫으면 보던 상세로 돌아온다", async ({
  page,
}, info) => {
  const current = await memo(
    page,
    "링크할 메모",
    2026,
    `올해 메모 본문 [대상 업무](/links/task/${taskIds[1]})\n`,
  );
  const previous = await memo(page, "지난해 메모", 2025, "지난해 메모 본문");
  await saveTask(
    page,
    taskIds[0],
    `[메모](/links/memo/${teamId}/2026/${current}) [지난해](/links/memo/${teamId}/2025/${previous})\n`,
  );
  const source = await open(page);
  await expect(links(source)).toHaveText(["링크할 메모", "지난해 메모"]);
  await links(source).nth(0).click();
  const full = memoPage(page, "링크할 메모");
  await expect(full).toHaveClass(/memo-full-page/);
  await expect(full).toContainText("올해 메모 본문");
  // The detail below stays open and the screen does not move.
  await expect(source).toBeVisible();
  await expect(memoToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(
    full.getByRole("button", { name: "링크 복사", exact: true }),
  ).toBeVisible();
  await full.screenshot({ path: info.outputPath("memo-overlay.png") });

  // A chain stacks; each close returns one level.
  await links(full).click();
  const target = details(page).nth(1);
  await expect(
    target.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  await target.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(details(page)).toHaveCount(1);
  await expect(full).toBeVisible();
  // The memo saves like its card.
  await rich(full).locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 덧붙임");
  await expect
    .poll(
      async () =>
        (await request(page, `/teams/${teamId}/years/2026/memos/${current}`))
          .markdown,
    )
    .toContain("덧붙임");
  await full.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(full).toHaveCount(0);
  await expect(source).toBeVisible();
  await expect(rich(source)).toBeVisible();

  // Another year's memo opens the same way; the board stays on this year.
  await links(source).nth(1).click();
  const old = memoPage(page, "지난해 메모");
  await expect(old).toContainText("지난해 메모 본문");
  await old.press("Escape");
  await expect(old).toHaveCount(0);
  await expect(source).toBeVisible();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("일정에서 연 메모 링크를 닫으면 캘린더와 그 일정 상세가 그대로 있다", async ({
  page,
}) => {
  const id = await memo(page, "링크할 메모", 2026, "메모 본문");
  const scheduled = await entry(page);
  await request(page, `/calendar/entries/${scheduled.id}/document`, "PUT", {
    markdown: `[메모](/links/memo/${teamId}/2026/${id})\n`,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  const scroll = page.locator(".calendar-scroll, .calendar-board").first();
  await page
    .locator(`[data-entry-id="${scheduled.id}"] .calendar-entry-card`)
    .first()
    .click();
  const before = await scroll.evaluate((element) => element.scrollTop);
  await expect(links(calendarDetail(page))).toHaveText("링크할 메모");
  await links(calendarDetail(page)).click();
  const full = memoPage(page, "링크할 메모");
  await expect(full).toContainText("메모 본문");
  await full.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(full).toHaveCount(0);
  await expect(calendarDetail(page)).toBeVisible();
  await expect(
    calendarDetail(page).getByRole("textbox", {
      name: "일정 제목",
      exact: true,
    }),
  ).toHaveValue("링크할 일정");
  expect(new URL(page.url()).pathname).toBe("/calendar");
  await expect(page.locator(".calendar-grid")).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before);
});

test("사본 업무와 사본 메모 링크는 지금 시트 위에 열고 사본 업무는 사본에서 열 수 있다", async ({
  page,
}, info) => {
  const id = await memo(page, "원본 메모", 2026, "원본 메모 본문");
  const sheetClone = await copySheet(page);
  await request(page, `/sheet-clones/${sheetClone}/memos/${id}`, "PATCH", {
    title: "사본 메모 이름",
    expectedTitle: "원본 메모",
  });
  await request(
    page,
    `/sheet-clones/${sheetClone}/tasks/${taskIds[1]}/documents/main`,
    "PUT",
    {
      markdown: "사본 업무 문서",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
  );
  // The copy keeps its own row title when the original is renamed.
  await rename(page, taskIds[1], "원본만 바꾼 이름");
  await saveTask(
    page,
    taskIds[0],
    `[사본 업무](/links/sheet-clone-task/${sheetClone}/${taskIds[1]}) [사본 메모](/links/sheet-clone-memo/${sheetClone}/${id})\n`,
  );
  await page.reload();
  const original = page.getByRole("tab", { name: "원본", exact: true });
  const copyTab = page.getByRole("tab", { name: "링크 사본", exact: true });
  const source = await open(page);
  await expect(links(source)).toHaveText(["링크 대상 업무", "사본 메모 이름"]);

  await links(source).nth(1).click();
  const full = memoPage(page, "사본 메모 이름");
  await expect(full).toContainText("원본 메모 본문");
  await full.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(source).toBeVisible();
  await expect(original).toHaveAttribute("aria-selected", "true");

  await links(source).nth(0).click();
  const copyTask = details(page).nth(1);
  const title = copyTask.getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  await expect(title).toHaveValue("링크 대상 업무");
  await expect(title).not.toBeEditable();
  await expect(rich(copyTask)).toContainText("사본 업무 문서");
  await expect(rich(copyTask)).toBeEditable();
  await copyTask.screenshot({ path: info.outputPath("copy-task-overlay.png") });
  await expect(original).toHaveAttribute("aria-selected", "true");
  await copyTask.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(details(page)).toHaveCount(1);
  await expect(original).toHaveAttribute("aria-selected", "true");

  // Opening it in the copy leaves the windows and edits it there.
  await links(source).nth(0).click();
  await details(page)
    .nth(1)
    .getByRole("button", { name: "사본에서 열기", exact: true })
    .click();
  await expect(copyTab).toHaveAttribute("aria-selected", "true");
  await expect(details(page)).toHaveCount(1);
  const inCopy = details(page)
    .first()
    .getByRole("textbox", { name: "작업 편집", exact: true });
  await expect(inCopy).toHaveValue("링크 대상 업무");
  await expect(inCopy).toBeEditable();
});

test("링크로 연 일정 상세는 캘린더에서 연 것과 같은 모습이다", async ({
  page,
}, info) => {
  const scheduled = await entry(page);
  await saveTask(page, taskIds[0], `[일정](/links/calendar/${scheduled.id})\n`);
  const look = async (dialog: Locator, name: string) => {
    await expect(
      dialog.getByRole("textbox", { name: "일정 제목", exact: true }),
    ).toHaveValue("링크할 일정");
    await expect(rich(dialog)).toBeVisible();
    await page.mouse.move(0, 0);
    const header = dialog.locator(":scope > header");
    await header.screenshot({ path: info.outputPath(`${name}.png`) });
    return {
      header: await header.evaluate((element) => {
        const dialog = element.parentElement!;
        const style = (selector: string) => {
          const css = getComputedStyle(element.querySelector(selector)!);
          return [
            css.color,
            css.backgroundColor,
            css.borderTopWidth,
            css.borderTopColor,
            css.fontSize,
            css.fontWeight,
            css.fontFamily,
            css.height,
          ].join(" ");
        };
        return {
          dialog: [
            getComputedStyle(dialog).backgroundColor,
            getComputedStyle(dialog).color,
            getComputedStyle(dialog).borderTopColor,
          ].join(" "),
          header: getComputedStyle(element).backgroundColor,
          title: style(".calendar-entry-title"),
          copy: style(".document-link-copy"),
          expand: style(".document-expand"),
          close: style(":scope > .button:last-child"),
          focused: document.activeElement?.getAttribute("aria-label"),
          ring: document.activeElement?.matches(":focus-visible"),
        };
      }),
      size: (await header.boundingBox())!.height,
    };
  };
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${scheduled.id}"] .calendar-entry-card`)
    .first()
    .click();
  const direct = await look(calendarDetail(page), "calendar-direct");
  await calendarDetail(page)
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
    .click();
  const source = await open(page);
  await links(source).click();
  const linked = await look(calendarDetail(page), "calendar-linked");
  expect(linked).toEqual(direct);
});

const fullPageHint = "문서 전체 페이지로 보기 (⌘/Ctrl+클릭: 새 탭)";
// ⌘/Ctrl+click, or a middle click, on a full-page button opens a new tab.
async function openInNewTab(page: Page, button: Locator, middle = false) {
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    middle
      ? button.click({ button: "middle" })
      : button.click({ modifiers: ["ControlOrMeta"] }),
  ]);
  return tab;
}

test("전체 페이지 버튼을 ⌘/Ctrl+클릭하면 지금 상세는 그대로 두고 방금 입력까지 저장해 새 탭에서 전체 페이지로 연다", async ({
  page,
}, info) => {
  const dialog = await open(page, taskIds[1]);
  const expand = dialog.getByRole("button", {
    name: "문서 전체 페이지로 보기",
    exact: true,
  });
  await expand.hover();
  await expect(page.getByRole("tooltip")).toHaveText(fullPageHint);
  await dialog.screenshot({ path: info.outputPath("new-tab-tooltip.png") });

  // Typed just before the click: the click saves it before the tab reads it.
  // A slow save still finishes before the tab reads the document.
  const documentUrl = `/api/tasks/${taskIds[1]}/documents/main`;
  await page.route(`**${documentUrl}`, async (route) => {
    if (route.request().method() === "PUT")
      await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  const order: string[] = [];
  const context = page.context();
  context.on("requestfinished", (request) => {
    if (request.url().endsWith(documentUrl) && request.method() === "PUT")
      order.push("here saved");
  });
  context.on("request", (request) => {
    if (
      request.url().endsWith(documentUrl) &&
      request.method() === "GET" &&
      request.frame().page() !== page
    )
      order.push("tab read");
  });
  await rich(dialog).click();
  await page.keyboard.type("새 탭에서 읽을 내용");
  let tab = await openInNewTab(page, expand);
  const opened = details(tab);
  await expect(opened).toHaveClass(/document-full-page/);
  await expect(
    opened.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  await expect(rich(opened)).toContainText("새 탭에서 읽을 내용");
  await expect(tab).toHaveTitle("링크 대상 업무 · 그래보드");
  await expect(page).toHaveTitle("연간 업무 · 그래보드");
  expect(order.indexOf("here saved")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("here saved")).toBeLessThan(order.indexOf("tab read"));
  await page.unroute(`**${documentUrl}`);
  // The flag is read once and the address cleaned like any link address.
  expect(new URL(tab.url()).pathname).toBe("/");
  expect(new URL(tab.url()).search).toBe("");
  await opened.screenshot({ path: info.outputPath("new-tab-task.png") });
  // A plain click there still leaves full page.
  await opened
    .getByRole("button", { name: "전체 페이지 닫기", exact: true })
    .click();
  await expect(opened).not.toHaveClass(/document-full-page/);
  await tab.close();

  // This tab did not change.
  await expect(details(page)).toHaveCount(1);
  await expect(dialog).not.toHaveClass(/document-full-page/);
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  // A plain click toggles full page as before; its tooltip stays short.
  await expand.click();
  await expect(dialog).toHaveClass(/document-full-page/);
  const leave = dialog.getByRole("button", {
    name: "전체 페이지 닫기",
    exact: true,
  });
  await leave.hover();
  await expect(page.getByRole("tooltip")).toHaveText("전체 페이지 닫기");
  await leave.click();
  await expect(dialog).not.toHaveClass(/document-full-page/);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();

  // A calendar entry opens on the calendar, with a title typed just now.
  const scheduled = await entry(page);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${scheduled.id}"] .calendar-entry-card`)
    .first()
    .click();
  const calendar = calendarDetail(page);
  await calendar
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("새 탭 일정");
  const calendarExpand = calendar.locator(".document-expand");
  await expect(calendarExpand).toHaveAttribute("data-tooltip", fullPageHint);
  tab = await openInNewTab(page, calendarExpand);
  await expect(calendarDetail(tab)).toHaveClass(/document-full-page/);
  await expect(
    calendarDetail(tab).getByRole("textbox", {
      name: "일정 제목",
      exact: true,
    }),
  ).toHaveValue("새 탭 일정");
  await expect(tab.locator(".calendar-grid")).toBeAttached();
  await expect(tab).toHaveTitle("새 탭 일정 · 그래보드");
  expect(new URL(tab.url()).pathname).toBe("/calendar");
  await tab.close();
  await expect(calendar).not.toHaveClass(/document-full-page/);
  await expect(calendarExpand).toHaveAttribute("aria-pressed", "false");
});

test("새 문서 탭 제목은 이름 변경·문서 선택·중첩 링크와 닫기를 따라간다", async ({
  page,
}) => {
  const scheduled = await entry(page, "중첩 일정");
  await saveTask(page, taskIds[1], `[일정](/links/calendar/${scheduled.id})`);
  const source = await open(page, taskIds[1]);
  const tab = await openInNewTab(page, source.locator(".document-expand"));
  const opened = details(tab);
  await expect(tab).toHaveTitle("링크 대상 업무 · 그래보드");
  const taskTitle = opened.getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  await taskTitle.fill("변경한 업무");
  await taskTitle.press("Tab");
  await expect(tab).toHaveTitle("변경한 업무 · 그래보드");

  await links(opened).first().click();
  const calendar = calendarDetail(tab);
  await expect(tab).toHaveTitle("중첩 일정 · 그래보드");
  await calendar
    .getByRole("textbox", { name: "일정 제목", exact: true })
    .fill("변경한 일정");
  await expect(tab).toHaveTitle("변경한 일정 · 그래보드");
  await calendar.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(tab).toHaveTitle("변경한 업무 · 그래보드");

  await opened.getByRole("button", { name: "문서 추가", exact: true }).click();
  await expect(opened.getByRole("tab")).toHaveCount(2);
  await opened.getByRole("tab").last().dblclick();
  const name = opened
    .locator(".document-tabs")
    .getByRole("textbox", { name: "문서 제목", exact: true });
  await name.fill("설계 검토");
  await name.press("Enter");
  await expect(tab).toHaveTitle("설계 검토 · 그래보드");
  await opened.getByRole("tab", { name: "문서 1", exact: true }).click();
  await expect(tab).toHaveTitle("변경한 업무 · 그래보드");
  await opened.getByRole("tab", { name: "설계 검토", exact: true }).click();
  await expect(tab).toHaveTitle("설계 검토 · 그래보드");
  await opened.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(tab).toHaveTitle("연간 업무 · 그래보드");
  await tab.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(tab).toHaveTitle("캘린더 · 그래보드");
  await expect(page).toHaveTitle("연간 업무 · 그래보드");
  await tab.close();
});

test("꼬리 메모 카드와 사본 업무 상세도 전체 페이지 버튼으로 새 탭에 열고 가운데 클릭도 같다", async ({
  page,
}) => {
  const id = await memo(page, "새 탭 메모", 2026, "새 탭 메모 본문");
  const sheetClone = await copySheet(page);
  await request(page, `/sheet-clones/${sheetClone}/memos/${id}`, "PATCH", {
    title: "사본 메모 제목",
    expectedTitle: "새 탭 메모",
  });
  await page.reload();
  await openMemos(page);
  const card = memoCard(page, id);
  const expand = card.getByRole("button", {
    name: "문서 전체 페이지로 보기",
    exact: true,
  });
  await expand.hover();
  await expect(page.getByRole("tooltip")).toHaveText(fullPageHint);
  let tab = await openInNewTab(page, expand, true);
  const full = memoPage(tab, "새 탭 메모");
  await expect(full).toHaveClass(/memo-full-page/);
  await expect(full).toContainText("새 탭 메모 본문");
  await expect(tab).toHaveTitle("새 탭 메모 · 그래보드");
  await tab.close();
  await expect(card).not.toHaveClass(/memo-full-page/);
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  // In full page the button also opens a new tab and keeps this page.
  await expand.click();
  await expect(card).toHaveClass(/memo-full-page/);
  tab = await openInNewTab(
    page,
    card.getByRole("button", { name: "전체 페이지 닫기", exact: true }),
  );
  await expect(memoPage(tab, "새 탭 메모")).toHaveClass(/memo-full-page/);
  await tab.close();
  await expect(card).toHaveClass(/memo-full-page/);
  await card
    .getByRole("button", { name: "전체 페이지 닫기", exact: true })
    .click();
  await expect(card).not.toHaveClass(/memo-full-page/);

  // A copy's task opens as the copy's task.
  const copyTab = page.getByRole("tab", { name: "링크 사본", exact: true });
  await copyTab.click();
  await expect(copyTab).toHaveAttribute("aria-selected", "true");
  await page
    .locator(`[data-cell="${taskIds[1]}:title"]`)
    .click({ button: "right" });
  const detail = details(page);
  await expect(detail).toBeVisible();
  tab = await openInNewTab(page, detail.locator(".document-expand"));
  const copied = details(tab);
  await expect(copied).toHaveClass(/document-full-page/);
  await expect(
    copied.getByRole("button", { name: "사본에서 열기", exact: true }),
  ).toBeVisible();
  await expect(
    copied.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue("링크 대상 업무");
  await expect(tab).toHaveTitle("링크 대상 업무 · 그래보드");
  await tab.close();
  await expect(detail).not.toHaveClass(/document-full-page/);
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await openMemos(page);
  tab = await openInNewTab(
    page,
    memoCard(page, id).locator(".document-expand"),
  );
  await expect(memoPage(tab, "사본 메모 제목")).toBeVisible();
  await expect(tab).toHaveTitle("사본 메모 제목 · 그래보드");
  await tab.close();
});

test("저장하지 못하면 전체 페이지 버튼으로 연 새 탭을 닫고 입력을 지금 창에 남긴다", async ({
  page,
}) => {
  const dialog = await open(page, taskIds[1]);
  await page.route(
    `**/api/tasks/${taskIds[1]}/documents/main`,
    async (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "저장 실패 시험" }),
          })
        : route.continue(),
  );
  await rich(dialog).click();
  await page.keyboard.type("저장 실패 입력");
  const tab = await openInNewTab(
    page,
    dialog.getByRole("button", {
      name: "문서 전체 페이지로 보기",
      exact: true,
    }),
  );
  // The failed save closes the tab, which may happen before it is reported.
  await expect.poll(() => tab.isClosed()).toBe(true);
  await expect(dialog.getByText("저장 실패 시험")).toBeVisible();
  await expect(rich(dialog)).toContainText("저장 실패 입력");
  await expect(dialog).not.toHaveClass(/document-full-page/);
});
