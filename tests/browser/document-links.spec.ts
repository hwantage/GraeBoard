import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";

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
  if (browserName === "chromium") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await button.click();
    await expect(page.locator(".toast")).toBeVisible();
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
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__copied))
    .toBe(true);
  return page.evaluate(() => (window as any).__copied);
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
  await expect(target.locator(".toast")).toHaveText("링크를 복사했습니다.");
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
  // A plain click on a web link only places the caret while editing.
  const web = rich(source).getByRole("link", { name: "자료", exact: true });
  await web.click();
  await links(source)
    .nth(0)
    .click({ modifiers: ["ControlOrMeta"] });
  await web.click({ modifiers: ["ControlOrMeta"] });
  const taskUrl = new URL(`/links/task/${taskIds[1]}`, page.url()).href;
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
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
  await expect(dialog.locator(".toast")).toHaveText("링크를 복사했습니다.");
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
