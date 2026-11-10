import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

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
const markdown = async (page: Page, id = taskIds[0]) =>
  (await get(page, `/tasks/${id}/documents/main`)).markdown;
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
const handle = (page: Page) =>
  detail(page).getByRole("button", { name: "블록 메뉴", exact: true });
const menu = (page: Page) =>
  detail(page).getByRole("listbox", { name: "블록 메뉴", exact: true });
const option = (page: Page, name: string) =>
  menu(page).getByRole("option", { name, exact: true });
const exact = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?$`);
async function open(page: Page, id = taskIds[0]) {
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  await expect(rich(page)).toBeVisible();
}
// Native caret movements reach ProseMirror through selectionchange.
async function place(page: Page, block: ReturnType<Page["locator"]>) {
  await block.click();
  await rich(page).evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
async function hover(page: Page, block: ReturnType<Page["locator"]>) {
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + Math.min(box.height / 2, 12));
  await expect(handle(page)).toBeVisible();
  return box;
}
// Drag the visible handle to `y` and drop it there.
async function drag(page: Page, y: number) {
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
  await expect(detail(page).locator(".document-block-drop")).toBeVisible();
  await page.mouse.up();
  await expect(detail(page).locator(".document-block-drop")).toHaveCount(0);
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
      name: `블록 손잡이 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["손잡이 업무", "목록 업무"])
    taskIds.push(
      (await post(page, "/tasks", { teamId, year: 2026, fields: { title } }))
        .task.id,
    );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("블록에 마우스를 올리면 손잡이가 나타나고 끌어서 옮기면 한 번에 실행취소한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "첫째 문단\n\n둘째 문단\n\n## 셋째 제목");
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/images"))
      uploads.push(request.url());
  });
  await open(page);
  const blocks = rich(page).locator(":scope > *");
  await expect(blocks).toHaveText(["첫째 문단", "둘째 문단", "셋째 제목"]);
  // The handle sits in the left gutter on the hovered block's first line.
  const first = await hover(page, blocks.nth(0));
  let grip = (await handle(page).boundingBox())!;
  expect(grip.x + grip.width).toBeLessThanOrEqual(first.x);
  expect(Math.abs(grip.y + grip.height / 2 - (first.y + 13))).toBeLessThan(6);
  const heading = await hover(page, blocks.nth(2));
  grip = (await handle(page).boundingBox())!;
  expect(grip.y).toBeGreaterThan(heading.y - 4);
  expect(grip.y + grip.height).toBeLessThan(heading.y + heading.height + 4);

  // Drop the first paragraph below the heading.
  await hover(page, blocks.nth(0));
  await drag(page, heading.y + heading.height - 4);
  await expect(blocks).toHaveText(["둘째 문단", "셋째 제목", "첫째 문단"]);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("둘째 문단\n\n## 셋째 제목\n\n첫째 문단"));
  expect(uploads).toEqual([]);
  // One undo restores the order; redo applies the move again.
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(blocks).toHaveText(["첫째 문단", "둘째 문단", "셋째 제목"]);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("첫째 문단\n\n둘째 문단\n\n## 셋째 제목"));
  await expect(
    detail(page).getByRole("button", { name: "문서 실행취소", exact: true }),
  ).toBeDisabled();
  await detail(page)
    .getByRole("button", { name: "문서 재실행", exact: true })
    .click();
  await expect(blocks).toHaveText(["둘째 문단", "셋째 제목", "첫째 문단"]);

  // Escape cancels a drag without moving anything.
  await hover(page, blocks.nth(0));
  grip = (await handle(page).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, heading.y + 60, {
    steps: 6,
  });
  await expect(rich(page).locator(".document-block-dragging")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(detail(page)).toBeVisible();
  await expect(rich(page).locator(".document-block-dragging")).toHaveCount(0);
  await expect(blocks).toHaveText(["둘째 문단", "셋째 제목", "첫째 문단"]);

  // List items move inside their list and out of it.
  await save(page, taskIds[1], "앞 문단\n\n* 하나\n* 둘\n* 셋\n\n뒤 문단");
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await open(page, taskIds[1]);
  const items = rich(page).locator("li");
  await expect(items).toHaveText(["하나", "둘", "셋"]);
  const third = (await items.nth(2).boundingBox())!;
  await hover(page, items.nth(0));
  grip = (await handle(page).boundingBox())!;
  // The handle stays left of the bullet.
  expect(grip.x + grip.width).toBeLessThanOrEqual(third.x - 12);
  await drag(page, third.y + third.height - 3);
  await expect(items).toHaveText(["둘", "셋", "하나"]);
  await expect
    .poll(() => markdown(page, taskIds[1]))
    .toMatch(exact("앞 문단\n\n* 둘\n* 셋\n* 하나\n\n뒤 문단"));
  const before = (await rich(page)
    .locator(":scope > p")
    .first()
    .boundingBox())!;
  await hover(page, items.nth(2));
  await drag(page, before.y + 3);
  await expect(rich(page).locator(":scope > *")).toHaveText([
    "하나",
    "앞 문단",
    "둘셋",
    "뒤 문단",
  ]);
  await expect(rich(page).locator(":scope > ul")).toHaveCount(2);
});

test("손잡이 메뉴로 형식을 바꾸고 복사·삭제하며 Esc와 바깥 클릭으로 닫는다", async ({
  page,
}) => {
  await save(page, taskIds[0], "첫째 문단\n\n* 하나\n* 둘\n\n셋째 문단");
  await open(page);
  const blocks = rich(page).locator(":scope > *");
  await hover(page, blocks.nth(0));
  await handle(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(menu(page).getByRole("option")).toHaveText([
    "위에 추가",
    "아래에 추가",
    "복사",
    "위로 이동",
    "아래로 이동",
    "삭제",
    "본문",
    "제목 1",
    "제목 2",
    "제목 3",
    "글머리 목록",
    "번호 목록",
    "체크리스트",
    "인용",
    "코드 블록",
    "토글",
    "토글 제목 1",
    "토글 제목 2",
    "토글 제목 3",
  ]);
  await expect(menu(page)).toContainText("전환");
  await expect(option(page, "위로 이동")).toBeDisabled();
  await expect(option(page, "본문")).toBeDisabled();
  await expect(option(page, "위에 추가")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rich(page)).toBeFocused();
  // Keyboard navigation skips unavailable entries, like the "/" menu.
  for (const name of ["아래에 추가", "복사"]) {
    await page.keyboard.press("ArrowDown");
    await expect(option(page, name)).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "아래로 이동")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(detail(page)).toBeVisible();
  await expect(rich(page)).toBeFocused();

  await hover(page, blocks.nth(0));
  await handle(page).click();
  await option(page, "제목 2").click();
  await expect(rich(page).getByRole("heading", { level: 2 })).toHaveText(
    "첫째 문단",
  );
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("## 첫째 문단\n\n* 하나\n* 둘\n\n셋째 문단"));

  // A list item converts its list; formats that cannot apply are disabled.
  await hover(page, rich(page).locator("li").nth(1));
  await handle(page).click();
  await expect(option(page, "제목 1")).toBeDisabled();
  await option(page, "번호 목록").click();
  await expect(rich(page).locator("ol > li")).toHaveText(["하나", "둘"]);

  // Outside clicks close the menu.
  await hover(page, blocks.last());
  await handle(page).click();
  await expect(menu(page)).toBeVisible();
  await detail(page)
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .click();
  await expect(menu(page)).toHaveCount(0);

  // Copy leaves the document unchanged; deleting and undoing still work.
  await hover(page, blocks.last());
  await handle(page).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(blocks).toHaveText(["첫째 문단", "하나둘", "셋째 문단"]);
  await hover(page, blocks.nth(2));
  await handle(page).click();
  await option(page, "삭제").click();
  await expect(blocks).toHaveText(["첫째 문단", "하나둘", ""]);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("## 첫째 문단\n\n1. 하나\n2. 둘"));
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(blocks).toHaveText(["첫째 문단", "하나둘", "셋째 문단"]);
});

test("손잡이 메뉴의 위에 추가·아래에 추가는 빈 블록을 만들고 커서를 둔다", async ({
  page,
}, info) => {
  await save(
    page,
    taskIds[0],
    "첫째 문단\n\n* 하나\n* 둘\n\n- [x] 끝난 일\n\n<details open>\n<summary>토글</summary>\n\n토글 안\n\n</details>\n\n마지막 문단",
  );
  await open(page);
  const blocks = rich(page).locator(":scope > *");
  // A paragraph above the first block; typing goes into it.
  await hover(page, blocks.nth(0));
  await handle(page).click();
  await page.screenshot({ path: info.outputPath("menu.png") });
  await option(page, "위에 추가").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(rich(page)).toBeFocused();
  await page.keyboard.type("새 첫 문단");
  await expect(blocks.nth(0)).toHaveText("새 첫 문단");
  await expect(blocks.nth(1)).toHaveText("첫째 문단");
  // In a list the new block is an item of the same list.
  await hover(page, rich(page).locator("ul > li").first());
  await handle(page).click();
  await option(page, "아래에 추가").click();
  await page.keyboard.type("하나 반");
  await expect(rich(page).locator("ul").first().locator("> li")).toHaveText([
    "하나",
    "하나 반",
    "둘",
  ]);
  // A checklist item starts unchecked.
  await hover(page, rich(page).getByText("끝난 일"));
  await handle(page).click();
  await option(page, "위에 추가").click();
  await page.keyboard.type("새 할 일");
  const tasks = rich(page).locator("li.document-check-item");
  await expect(tasks).toHaveText(["새 할 일", "끝난 일"]);
  await expect(tasks.nth(0).locator("> input")).not.toBeChecked();
  await expect(tasks.nth(1).locator("> input")).toBeChecked();
  // Inside a toggle the paragraph stays in the toggle.
  await hover(page, rich(page).getByText("토글 안"));
  await handle(page).click();
  await option(page, "아래에 추가").click();
  await page.keyboard.type("토글 안 둘째");
  await expect(rich(page).locator(".document-toggle-content > p")).toHaveText([
    "토글 안",
    "토글 안 둘째",
  ]);
  // Below the last block the empty typing line takes the caret.
  await hover(page, rich(page).getByText("마지막 문단"));
  await handle(page).click();
  await option(page, "아래에 추가").click();
  await page.keyboard.type("끝에 추가");
  await expect
    .poll(() => markdown(page))
    .toMatch(
      exact(
        "새 첫 문단\n\n첫째 문단\n\n* 하나\n* 하나 반\n* 둘\n\n- [ ] 새 할 일\n- [x] 끝난 일\n\n<details open>\n<summary>토글</summary>\n\n토글 안\n\n토글 안 둘째\n\n</details>\n\n마지막 문단\n\n끝에 추가",
      ),
    );
  // Each addition is its own undo step, typing aside.
  await detail(page)
    .getByRole("button", { name: "문서 실행취소", exact: true })
    .click();
  await expect(rich(page)).not.toContainText("끝에 추가");
  await expect(rich(page)).toContainText("토글 안 둘째");
});

test("Alt+Shift+위/아래 방향키로 현재 블록을 옮기고 목록·토글 경계를 넘는다", async ({
  page,
}) => {
  await save(
    page,
    taskIds[0],
    "첫째 문단\n\n* 하나\n* 둘\n\n<details open>\n<summary>토글 제목</summary>\n\n안쪽 하나\n\n안쪽 둘\n\n</details>\n\n마지막 문단",
  );
  await open(page);
  await place(page, rich(page).locator("li").nth(1));
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(rich(page).locator("li")).toHaveText(["둘", "하나"]);
  await expect
    .poll(() => markdown(page))
    .toContain("첫째 문단\n\n* 둘\n* 하나\n\n<details open>");
  // The first item leaves its list past the block above it.
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(rich(page).locator(":scope > *").first()).toHaveText("둘");
  await expect(rich(page).locator(":scope > ul")).toHaveCount(2);
  // The caret stays in the moved block, so typing continues there.
  await page.keyboard.type("!");
  await expect(rich(page).locator(":scope > ul").first()).toHaveText("둘!");
  // Back next to the list, it joins the list again.
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(rich(page).locator(":scope > *").first()).toHaveText(
    "첫째 문단",
  );
  await expect(rich(page).locator(":scope > ul")).toHaveCount(1);
  await expect(rich(page).locator("li")).toHaveText(["둘!", "하나"]);
  await expect
    .poll(() => markdown(page))
    .toContain("첫째 문단\n\n* 둘!\n* 하나\n\n<details open>");

  // Blocks enter and leave toggles at their edges.
  await place(page, rich(page).locator(".document-toggle-content p").first());
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(rich(page).locator(".document-toggle-content p")).toHaveText([
    "안쪽 둘",
  ]);
  await expect(
    rich(page)
      .locator(":scope > .document-toggle")
      .locator("xpath=preceding-sibling::*[1]"),
  ).toHaveText("안쪽 하나");
  await expect
    .poll(() => markdown(page))
    .toContain(
      "안쪽 하나\n\n<details open>\n<summary>토글 제목</summary>\n\n안쪽 둘\n\n</details>",
    );
  // The last block stops before the empty line kept at the end.
  await place(page, rich(page).getByText("마지막 문단"));
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(rich(page).locator(":scope > p").last()).toHaveText(
    "마지막 문단",
  );
  await page.keyboard.press("Alt+Shift+ArrowUp");
  const toggle = rich(page).locator(":scope > .document-toggle");
  await expect(toggle.locator("xpath=preceding-sibling::*[1]")).toHaveText(
    "마지막 문단",
  );
  // The document now ends with the toggle, so the empty line returns.
  await expect(toggle.locator("xpath=following-sibling::*")).toHaveText([""]);
  await expect
    .poll(() => markdown(page))
    .toMatch(/마지막 문단\n\n<details open>[\s\S]*<\/details>\n?$/);
  // One undo per move.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rich(page).locator(":scope > p").last()).toHaveText(
    "마지막 문단",
  );
});

// Select the text from the start of one element to the end of another.
async function selectAcross(
  page: Page,
  first: ReturnType<Page["locator"]>,
  last: ReturnType<Page["locator"]>,
) {
  const end = await last.elementHandle();
  await first.evaluate((start, end) => {
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end!, end!.childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    (start.closest("[contenteditable]") as HTMLElement).focus();
  }, end);
  await rich(page).evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
const selected = (page: Page) => rich(page).locator(".document-block-selected");

test("여러 블록에 걸친 선택은 손잡이·메뉴·방향키로 함께 옮기고 복사·삭제한다", async ({
  page,
}) => {
  await save(page, taskIds[0], "하나\n\n둘\n\n셋\n\n넷\n\n다섯");
  await open(page);
  const blocks = rich(page).locator(":scope > *");
  await selectAcross(page, blocks.nth(1), blocks.nth(2));
  // Any selected block's handle drags all of them.
  await hover(page, blocks.nth(2));
  const fourth = (await blocks.nth(3).boundingBox())!;
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, fourth.y + fourth.height - 3, {
    steps: 8,
  });
  await expect(rich(page).locator(".document-block-dragging")).toHaveText([
    "둘",
    "셋",
  ]);
  await page.mouse.up();
  await expect(blocks).toHaveText(["하나", "넷", "둘", "셋", "다섯"]);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("하나\n\n넷\n\n둘\n\n셋\n\n다섯"));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks).toHaveText(["하나", "둘", "셋", "넷", "다섯"]);

  // The keys move the selected blocks one step at a time.
  await selectAcross(page, blocks.nth(1), blocks.nth(2));
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(blocks).toHaveText(["둘", "셋", "하나", "넷", "다섯"]);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(blocks).toHaveText(["하나", "넷", "둘", "셋", "다섯"]);

  // Copy the selected blocks without changing the document.
  await page.evaluate(() => {
    (window as any).blockClipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).blockClipboard = await (
            await items[0].getType("text/plain")
          ).text();
        },
      },
    });
  });
  await hover(page, blocks.nth(2));
  await handle(page).click();
  await option(page, "복사").click();
  await expect(
    detail(page).getByText("복사되었습니다.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).blockClipboard)).toMatch(
    exact("둘\n\n셋"),
  );
  await expect(blocks).toHaveText(["하나", "넷", "둘", "셋", "다섯"]);
  await hover(page, blocks.nth(2));
  await handle(page).click();
  await option(page, "삭제").click();
  await expect(blocks).toHaveText(["하나", "넷", "다섯"]);
  await expect.poll(() => markdown(page)).toMatch(exact("하나\n\n넷\n\n다섯"));
});

test("목록 항목 복사는 체크 상태와 목록 형식을 보존하고 이웃 항목은 제외한다", async ({
  page,
}) => {
  const source = "- [ ] 앞 항목\n- [x] 선택 항목\n- [ ] 뒤 항목";
  await save(page, taskIds[0], source);
  await open(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).blockClipboard = {
            text: await (await items[0].getType("text/plain")).text(),
            html: await (await items[0].getType("text/html")).text(),
          };
        },
      },
    });
  });
  await hover(
    page,
    rich(page).locator("li p").filter({ hasText: "선택 항목" }),
  );
  await handle(page).click();
  await option(page, "복사").click();
  await expect(
    detail(page).getByText("복사되었습니다.", { exact: true }),
  ).toBeVisible();
  const copied = await page.evaluate(() => (window as any).blockClipboard);
  expect(copied.text).toMatch(/^[-*] \[x\] 선택 항목\n?$/);
  expect(copied.html).toContain("<ul");
  expect(copied.html).toContain("선택 항목");
  expect(copied.html).not.toContain("앞 항목");
  expect(copied.html).not.toContain("뒤 항목");
  expect(await markdown(page)).toBe(source);
});

test("커서가 토글 제목에 있어도 안쪽 블록의 손잡이는 그 블록만 다룬다", async ({
  page,
}) => {
  await save(
    page,
    taskIds[0],
    "<details open>\n<summary>토글 제목</summary>\n\n안쪽 하나\n\n안쪽 둘\n\n</details>\n\n바깥 문단",
  );
  await open(page);
  await place(page, rich(page).locator(".document-toggle-title"));
  const inner = rich(page).locator(".document-toggle-content p");
  await hover(page, inner.nth(0));
  await handle(page).click();
  await option(page, "삭제").click();
  await expect(inner).toHaveText(["안쪽 둘"]);
  await expect(rich(page).locator(".document-toggle-title")).toHaveText(
    "토글 제목",
  );
  await expect
    .poll(() => markdown(page))
    .toContain("<summary>토글 제목</summary>\n\n안쪽 둘\n\n</details>");
});

test("본문 옆 여백을 끌거나 Shift+클릭으로 블록을 선택해 옮기고 지운다", async ({
  page,
}) => {
  await save(page, taskIds[0], "하나\n\n둘\n\n---\n\n* 가\n* 나\n* 다\n\n끝");
  await open(page);
  const blocks = rich(page).locator(":scope > *");
  const prose = (await detail(page).locator(".document-prose").boundingBox())!;
  const first = (await blocks.nth(0).boundingBox())!;
  const divider = (await blocks.nth(2).boundingBox())!;
  // Dragging down the left margin selects the blocks it passes, the divider
  // included, and Esc cancels.
  await page.mouse.move(prose.x + 6, first.y + 4);
  await page.mouse.down();
  await page.mouse.move(prose.x + 120, divider.y + divider.height / 2, {
    steps: 6,
  });
  await expect(detail(page).locator(".document-block-marquee")).toBeVisible();
  await expect(selected(page)).toHaveCount(3);
  await page.mouse.up();
  await expect(detail(page).locator(".document-block-marquee")).toHaveCount(0);
  await expect(selected(page)).toHaveCount(3);
  await expect(rich(page)).toBeFocused();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(blocks.nth(0)).toHaveText("가나다");
  await expect(selected(page)).toHaveCount(3);
  await page.keyboard.press("Backspace");
  await expect(blocks).toHaveText(["가나다", "끝"]);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact("* 가\n* 나\n* 다\n\n끝"));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks).toHaveCount(5);
  await expect(selected(page)).toHaveCount(0);

  // Shift+click on a handle selects from the caret's block to that block.
  const items = rich(page).locator("li");
  await place(page, items.nth(0));
  await hover(page, items.nth(1));
  await handle(page).click({ modifiers: ["Shift"] });
  await expect(selected(page)).toHaveText(["가", "나"]);
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect(items).toHaveText(["다", "가", "나"]);
  await expect.poll(() => markdown(page)).toContain("* 다\n* 가\n* 나");
  // Esc keeps the caret and ends the block selection, not the detail.
  await page.keyboard.press("Escape");
  await expect(selected(page)).toHaveCount(0);
  await expect(detail(page)).toBeVisible();
  // A click in the margin also ends it.
  await place(page, items.nth(0));
  await hover(page, items.nth(2));
  await handle(page).click({ modifiers: ["Shift"] });
  await expect(selected(page)).toHaveText(["다", "가", "나"]);
  await page.mouse.click(prose.x + 6, (await items.nth(0).boundingBox())!.y);
  await expect(selected(page)).toHaveCount(0);
});

test("읽기 전용 문서와 원문 모드에는 블록 손잡이가 없다", async ({ page }) => {
  await save(page, taskIds[0], "# 읽기 전용\n\n둘째 문단");
  await open(page);
  await hover(page, rich(page).locator("p"));
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(handle(page)).toHaveCount(0);
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  const username = `block-viewer-${randomUUID()}@example.com`;
  await post(page, "/admin/users", {
    username,
    password: "local-test-only-password",
    name: "블록 열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await post(page, "/auth/login", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await page.getByLabel("팀 선택").selectOption(teamId);
  await page
    .locator(`[data-cell="${taskIds[0]}:title"] .task-document-indicator`)
    .click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
  const box = (await rich(page).locator("p").boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.move(box.x - 10, box.y + 10);
  await page.waitForTimeout(100);
  await expect(handle(page)).toHaveCount(0);
  await page.keyboard.press("Alt+Shift+ArrowUp");
  expect(await markdown(page)).toBe("# 읽기 전용\n\n둘째 문단");
});

test("이미지 문단도 끌어서 옮기며 이미지를 다시 올리지 않는다", async ({
  page,
}) => {
  await save(page, taskIds[0], "첫째 문단\n\n둘째 문단");
  await open(page);
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/images"))
      uploads.push(request.url());
  });
  await rich(page).locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await rich(page).evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#408378";
    ctx.fillRect(0, 0, 160, 90);
    const bytes = Uint8Array.from(
      atob(canvas.toDataURL("image/png").split(",")[1]),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "옮길 그림.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  const image = rich(page).locator("img[src]");
  await expect(image).toHaveCount(1);
  await expect.poll(() => markdown(page)).toContain("![옮길 그림]");
  expect(uploads).toHaveLength(1);
  const url = (await markdown(page)).match(
    /\/api\/document-images\/[^)\s#]+/,
  )![0];
  const first = (await rich(page).locator("p").first().boundingBox())!;
  await hover(page, image);
  await drag(page, first.y + 3);
  await expect(rich(page).locator("p").first().locator("img[src]")).toHaveCount(
    1,
  );
  await expect
    .poll(() => markdown(page))
    .toMatch(exact(`![옮길 그림](${url})\n\n첫째 문단\n\n둘째 문단`));
  expect(uploads).toHaveLength(1);
});

test("큰 이미지 문단은 위가 가려져도 보이는 부분 옆에 손잡이를 두고 끌어 옮긴다", async ({
  page,
}) => {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 1400;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#408378";
    context.fillRect(0, 0, 600, 1400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const res = await page.request.post(
    `/api/tasks/${taskIds[0]}/documents/main/images`,
    {
      headers,
      multipart: {
        image: {
          name: "긴 그림.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        },
      },
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  const { url } = await res.json();
  await save(page, taskIds[0], `첫째 문단\n\n![긴 그림](${url})\n\n둘째 문단`);
  await open(page);
  const image = rich(page).locator(".document-image");
  await expect
    .poll(() =>
      image
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalHeight),
    )
    .toBe(1400);
  // On the image's line, the handle sits at its top like a first line.
  let box = (await image.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 60);
  await expect(handle(page)).toBeVisible();
  let grip = (await handle(page).boundingBox())!;
  expect(grip.x + grip.width).toBeLessThanOrEqual(box.x);
  expect(Math.abs(grip.y + grip.height / 2 - (box.y + 20))).toBeLessThan(4);

  // With the top scrolled under the toolbar, the handle stays beside the
  // part in view.
  await rich(page).locator("p").last().scrollIntoViewIfNeeded();
  box = (await image.boundingBox())!;
  const tools = (await detail(page)
    .locator(".document-rich-tools")
    .boundingBox())!;
  expect(box.y).toBeLessThan(tools.y);
  await page.mouse.move(box.x + 40, tools.y + tools.height + 200, {
    steps: 4,
  });
  await expect(handle(page)).toBeVisible();
  grip = (await handle(page).boundingBox())!;
  expect(grip.x + grip.width).toBeLessThanOrEqual(box.x);
  expect(grip.y).toBeGreaterThanOrEqual(tools.y + tools.height);
  expect(grip.y).toBeLessThan(tools.y + tools.height + 16);

  // Dragging it moves the image's paragraph like any block.
  const last = (await rich(page).locator("p").last().boundingBox())!;
  await drag(page, last.y + last.height - 3);
  await expect
    .poll(() => markdown(page))
    .toMatch(exact(`첫째 문단\n\n둘째 문단\n\n![긴 그림](${url})`));
  await expect(rich(page).locator("p").nth(1)).toHaveText("둘째 문단");
});
