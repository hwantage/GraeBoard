import { build } from "esbuild";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let taskId: string, teamId: string;
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
  await settle(editor);
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
// Let the editor holding `target` paint the latest changes.
async function settle(target: Locator, frames = 2) {
  await target.evaluate(async (_, frames) => {
    for (let i = 0; i < frames; i++)
      await new Promise((r) => requestAnimationFrame(r));
  }, frames);
}
async function clear(page: Page) {
  await rich(page).press("ControlOrMeta+A");
  await rich(page).press("Backspace");
}
// Home differs by browser and OS, so place the caret by text offset instead.
// A just-finished click can still restore its own caret, so place it again
// until the editor keeps it.
async function caret(block: Locator, offset = 0) {
  const place = (el: Element, offset: number) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && offset > node.textContent!.length) {
      offset -= node.textContent!.length;
      node = walker.nextNode();
    }
    const range = document.createRange();
    if (node) range.setStart(node, offset);
    else range.setStart(el, 0);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const at = (el: Element) => {
    const selection = window.getSelection()!;
    if (!selection.isCollapsed || !el.contains(selection.anchorNode)) return -1;
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return range.toString().length;
  };
  await expect
    .poll(async () => {
      await block.evaluate(place, offset);
      await settle(block, 4);
      return block.evaluate(at);
    })
    .toBe(offset);
}
const text = async (locator: Locator) =>
  (await locator.textContent())?.replaceAll("\u00a0", " ");

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
  teamId = team.id;
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
  await settle(rich(page));
  await page.keyboard.press("Tab");
  await expect(rich(page).locator("li li")).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(rich(page).locator("li li")).toHaveCount(0);
  await rich(page).locator("th p").first().click();
  await settle(rich(page));
  await page.keyboard.press("Tab");
  await settle(rich(page));
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
  // Mermaid initially shows a preview. Enter code editing through its UI so
  // asynchronous rendering cannot hide the click target during this test.
  await rich(page)
    .getByRole("img", { name: "Mermaid 다이어그램", exact: true })
    .click();
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
  await settle(rich(page));
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
    expect(await text(rich(page))).toBe(marker + " ");
    await clear(page);
    await rich(page).pressSequentially(marker + " ");
    await expect(rich(page).locator(selector)).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+z");
    expect(await text(rich(page))).toBe(marker + " ");
    await clear(page);
    await rich(page).pressSequentially(marker + " ");
    await rich(page).pressSequentially("항목");
    await expect.poll(() => markdown(page)).toContain(saved);
  });

for (const [marker, selector, saved] of [
  ["-", "ul > li", "* 기존 **문장**"],
  ["*", "ul > li", "* 기존 **문장**"],
  ["+", "ul > li", "* 기존 **문장**"],
  ["1.", "ol > li", "1. 기존 **문장**"],
  ["3.", "ol > li", "3. 기존 **문장**"],
  ["[ ]", "li.document-check-item", "* [ ] 기존 **문장**"],
  ["[]", "li.document-check-item", "* [ ] 기존 **문장**"],
  ["[x]", "li.document-check-item", "* [x] 기존 **문장**"],
  ["#", "h1", "# 기존 **문장**"],
  ["##", "h2", "## 기존 **문장**"],
  ["###", "h3", "### 기존 **문장**"],
  [">", "blockquote", "> 기존 **문장**"],
])
  test(`글이 있는 문단 맨 앞의 ${marker} 스페이스도 글을 유지해 변환하고 Backspace와 실행취소로 복원한다`, async ({
    page,
  }) => {
    await open(page, "기존 **문장**\n");
    const convert = async () => {
      await caret(rich(page).locator("p").first());
      await rich(page).pressSequentially(marker + " ");
      await expect(rich(page).locator(selector)).toHaveCount(1);
      expect(await text(rich(page).locator(selector))).toBe("기존 문장");
      await expect(rich(page).locator(`${selector} strong`)).toHaveText("문장");
    };
    // The typed marker comes back in front of the kept text, with the caret
    // after it, so removing the marker restores the original paragraph.
    const restored = async () => {
      await expect(rich(page).locator(selector)).toHaveCount(0);
      expect(await text(rich(page))).toBe(marker + " 기존 문장");
      for (let i = 0; i <= marker.length; i++)
        await page.keyboard.press("Backspace");
      expect(await text(rich(page))).toBe("기존 문장");
      await expect(rich(page).locator("p strong")).toHaveText("문장");
    };
    await convert();
    if (marker === "[x]")
      await expect(rich(page).getByRole("checkbox")).toBeChecked();
    await page.keyboard.press("Backspace");
    await restored();
    await convert();
    await page.keyboard.press("ControlOrMeta+z");
    await restored();
    await convert();
    await expect.poll(() => markdown(page)).toContain(saved);
  });

test("문장 중간 기호와 글 앞 코드 울타리·구분선은 변환하지 않고 뒤쪽 인라인 코드는 막지 않는다", async ({
  page,
}) => {
  await open(page, "기존 문장\n\n기존 `코드` 문장\n\n`코드`로 시작\n");
  const first = rich(page).locator("p").first();
  for (const [offset, marker, selector] of [
    [3, "- ", "li"],
    [2, "# ", "h1"],
    [0, "``` ", "pre"],
    [0, "*** ", "hr"],
  ] as const) {
    await caret(first, offset);
    await rich(page).pressSequentially(marker);
    await expect(rich(page).locator(selector)).toHaveCount(0);
    const typed = "기존 문장".slice(0, offset) + marker;
    expect(await text(first)).toBe(typed + "기존 문장".slice(offset));
    for (let i = 0; i < marker.length; i++)
      await page.keyboard.press("Backspace");
    expect(await text(first)).toBe("기존 문장");
  }
  await caret(rich(page).locator("p").nth(1));
  await rich(page).pressSequentially("- ");
  await expect(rich(page).locator("ul > li")).toHaveCount(1);
  expect(await text(rich(page).locator("li"))).toBe("기존 코드 문장");
  await expect(rich(page).locator("li code")).toHaveText("코드");
  // Inline code is not inclusive, so a marker typed before it stays plain.
  await caret(rich(page).locator("p", { hasText: "로 시작" }));
  await rich(page).pressSequentially("> ");
  await expect(rich(page).locator("blockquote")).toHaveCount(1);
  expect(await text(rich(page).locator("blockquote"))).toBe("코드로 시작");
  await expect(rich(page).locator("blockquote code")).toHaveText("코드");
  await expect
    .poll(() => markdown(page))
    .toContain("* 기존 `코드` 문장\n\n> `코드`로 시작");
});

test("목록 항목과 인용 안의 글 앞 기호는 빈 문단과 같은 규칙으로 바꾼다", async ({
  page,
}) => {
  await open(page, "- 첫째\n\n> 인용 문장\n");
  const item = rich(page).locator("li p");
  // A list item starts with a paragraph, so only the checklist form applies.
  await caret(item);
  await rich(page).pressSequentially("- ");
  await expect(rich(page).locator("li li")).toHaveCount(0);
  expect(await text(item)).toBe("- 첫째");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await caret(item);
  await rich(page).pressSequentially("[ ] ");
  await expect(rich(page).locator("li.document-check-item")).toHaveCount(1);
  expect(await text(item)).toBe("첫째");
  await caret(rich(page).locator("blockquote p"));
  await rich(page).pressSequentially("- ");
  await expect(rich(page).locator("blockquote ul > li")).toHaveCount(1);
  expect(await text(rich(page).locator("blockquote li"))).toBe("인용 문장");
  await expect.poll(() => markdown(page)).toContain("* [ ] 첫째");
});

test("문단 맨 앞에 이미 있던 기호 뒤의 스페이스도 변환하고 Backspace로 되돌린다", async ({
  page,
}) => {
  await open(page, "1.5배 증가\n");
  const first = rich(page).locator("p").first();
  await caret(first, 2);
  await rich(page).pressSequentially(" ");
  await expect(rich(page).locator("ol > li")).toHaveCount(1);
  expect(await text(rich(page).locator("li"))).toBe("5배 증가");
  await page.keyboard.press("Backspace");
  await expect(rich(page).locator("ol")).toHaveCount(0);
  expect(await text(first)).toBe("1. 5배 증가");
  await page.keyboard.press("Backspace");
  expect(await text(first)).toBe("1.5배 증가");
});

test("변환 직후 다른 곳에서 바뀐 내용을 받으면 Backspace가 기호를 되살리지 않는다", async ({
  page,
}) => {
  await open(page, "기존 문장\n");
  await caret(rich(page).locator("p").first());
  await rich(page).pressSequentially("- ");
  await expect(rich(page).locator("ul > li")).toHaveCount(1);
  await expect.poll(() => markdown(page)).toContain("* 기존 문장");
  const path = `/tasks/${taskId}/documents/main`;
  const saved = await request(page, path);
  await request(page, path, "PUT", {
    markdown: "* 기존 문장\n\n원격 문단\n",
    expectedRevision: saved.revision,
    operationId: randomUUID(),
  });
  await expect(rich(page)).toContainText("원격 문단");
  // The remote change clears the shortcut's inverse, so Backspace runs its
  // usual command wherever the caret is now (delete a character, or lift the
  // list item) instead of bringing the typed "- " back.
  const before = await rich(page).innerHTML();
  await page.keyboard.press("Backspace");
  await expect.poll(() => rich(page).innerHTML()).not.toBe(before);
  await expect(rich(page)).not.toContainText("- 기존");
});

test("여러 편집기가 함께 열린 꼬리 메모에서도 모든 메모가 글 앞 기호와 코드 울타리를 바꾼다", async ({
  page,
}) => {
  // Milkdown keeps one module-level rule object per built-in rule and points it
  // at the last editor initialized, so each memo must use its own rules.
  const titles = ["첫 메모", "둘째 메모"];
  for (const title of titles) {
    const id = randomUUID();
    await request(page, `/teams/${teamId}/years/2026/memos`, "POST", {
      id,
      title,
    });
    await request(page, `/teams/${teamId}/years/2026/memos/${id}`, "PUT", {
      markdown: "기존 문장\n",
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  const memos = page.locator(".annual-memos");
  await memos
    .getByRole("button", { name: "꼬리 메모", expanded: false, exact: true })
    .click();
  const editor = (title: string) =>
    memos
      .getByRole("tabpanel", { name: title, exact: true })
      .getByRole("textbox", { name: "연간 업무 메모 리치 편집" });
  for (const title of titles)
    await expect(editor(title)).toHaveText("기존 문장");
  for (const title of titles) {
    await editor(title).click();
    await caret(editor(title).locator("p").first());
    await editor(title).pressSequentially("- ");
    await expect(editor(title).locator("ul > li")).toHaveCount(1);
    expect(await text(editor(title).locator("li"))).toBe("기존 문장");
    await caret(editor(title).locator("li p"), 5);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await editor(title).pressSequentially("```");
    await page.keyboard.press("Enter");
    await expect(editor(title).locator("pre")).toHaveCount(1);
  }
});

test("목록 안 체크박스와 코드 울타리 Enter도 변환하고 입력대로 복원한다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("- [ ] ");
  await expect(rich(page).locator("li.document-check-item")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(rich(page).locator("li.document-check-item")).toHaveCount(0);
  expect(await text(rich(page).locator("li"))).toBe("[ ] ");
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
  await settle(rich(page));
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
  await settle(rich(page));
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
  await settle(rich(page));
  await rich(page).pressSequentially(" ");
  await expect(rich(page).locator("li")).toHaveCount(0);
});

for (const [typed, symbol] of [
  ["->", "→"],
  ["<-", "←"],
  ["=>", "⇒"],
  ["<=", "⇐"],
  ["<->", "↔"],
  ["<=>", "⇔"],
])
  test(`${typed}는 글자 사이에서도 ${symbol}로 바꾸고 Backspace와 실행취소로 입력한 글자를 복원한다`, async ({
    page,
  }) => {
    await open(page);
    await rich(page).pressSequentially(`가${typed}`);
    await expect.poll(() => text(rich(page))).toBe(`가${symbol}`);
    await page.keyboard.press("Backspace");
    await expect.poll(() => text(rich(page))).toBe(`가${typed}`);
    await clear(page);
    await rich(page).pressSequentially(`가${typed}`);
    await expect.poll(() => text(rich(page))).toBe(`가${symbol}`);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => text(rich(page))).toBe(`가${typed}`);
    await clear(page);
    await rich(page).pressSequentially(`a${typed}b 다음`);
    await expect.poll(() => text(rich(page))).toBe(`a${symbol}b 다음`);
    await expect.poll(() => markdown(page)).toBe(`a${symbol}b 다음\n`);
  });

test("화살표 합치기는 방금 바뀐 화살표에만 적용하고 제목에서도 입력한 글자로 되돌린다", async ({
  page,
}) => {
  // A backtick inside existing inline code does not open new inline code.
  await open(page, "``a`b`` 끝\n");
  await rich(page).locator("p").first().click();
  await page.keyboard.press("End");
  await settle(rich(page));
  await rich(page).pressSequentially(" c->d");
  await expect(rich(page).locator("p code")).toHaveText("a`b");
  await expect
    .poll(() => text(rich(page).locator("p").first()))
    .toBe("a`b 끝 c→d");
  await clear(page);
  // After the caret moves away and back, `>` is an ordinary character.
  await rich(page).pressSequentially("x<-");
  await expect.poll(() => text(rich(page))).toBe("x←");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  await rich(page).pressSequentially(">");
  await expect.poll(() => text(rich(page))).toBe("x←>");
  await clear(page);
  // The bold shortcut after the arrow is the last conversion; `>` stays.
  await rich(page).pressSequentially("**a<-**>");
  await expect(rich(page).locator("strong")).toHaveText("a←");
  await expect.poll(() => text(rich(page))).toBe("a←>");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(rich(page))).toBe("a←");
  await expect(rich(page).locator("strong")).toHaveText("a←");
  await clear(page);
  // `<-` restored by Backspace and then `>` is typed `<->`.
  await rich(page).pressSequentially("y<-");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(rich(page))).toBe("y<-");
  await rich(page).pressSequentially(">");
  await expect.poll(() => text(rich(page))).toBe("y↔");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(rich(page))).toBe("y<->");
  await clear(page);
  // Milkdown's heading id sync must not drop the undo information.
  await rich(page).pressSequentially("## x <->");
  const headings = rich(page).locator("h2");
  await expect(headings).toHaveText("x ↔");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(headings)).toBe("x <->");
  await page.keyboard.press("Enter");
  await rich(page).pressSequentially("## x a->");
  await expect(headings.nth(1)).toHaveText("x a→");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(headings.nth(1))).toBe("x a->");
  await expect.poll(() => markdown(page)).toBe("## x <->\n\n## x a->\n");
});

test("화살표는 코드·인라인 코드·붙여넣기·원문에서는 그대로 두고 표 셀과 목록에서는 바꾼다", async ({
  page,
}) => {
  await open(page, "```\n\n```\n\n| A | B |\n| - | - |\n|  |  |\n\n마지막\n");
  await rich(page).locator("pre").click();
  await rich(page).pressSequentially("a->b <=> c");
  await expect(rich(page).locator("pre")).toHaveText("a->b <=> c");
  await rich(page).locator("td p").first().click();
  await settle(rich(page));
  await rich(page).pressSequentially("x<->y");
  await expect(rich(page).locator("td").first()).toHaveText("x↔y");
  await rich(page).locator("p").last().click();
  await page.keyboard.press("End");
  await settle(rich(page));
  // Inline code typed with backticks keeps its arrow; text after it converts.
  await rich(page).pressSequentially(" `c->d` e->f");
  await expect(rich(page).locator("p code")).toHaveText("c->d");
  await expect(rich(page).locator("p").last()).toHaveText("마지막 c->d e→f");
  // Typing inside an existing inline code mark keeps the characters too.
  await caret(rich(page).locator("p code"), 1);
  await rich(page).pressSequentially("<=");
  await expect(rich(page).locator("p code")).toHaveText("c<=->d");
  await rich(page).locator("p").last().click();
  await page.keyboard.press("End");
  await settle(rich(page));
  // Pasted text is not typed input, so it keeps its characters.
  await paste(rich(page), "p->q");
  await expect(rich(page).locator("p").last()).toContainText("p->q");
  await page.keyboard.press("Enter");
  await rich(page).pressSequentially("- 목록=>끝");
  await expect(rich(page).locator("li")).toHaveText("목록⇒끝");
  const saved = [
    "```\na->b <=> c\n```",
    "| x↔y |",
    "마지막 `c<=->d` e→f",
    "p->q",
    "* 목록⇒끝",
  ];
  await expect
    .poll(async () => {
      const stored = await markdown(page);
      return saved.filter((part) => !stored.includes(part));
    })
    .toEqual([]);
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = detail(page).getByRole("textbox", {
    name: "업무 문서 Markdown 원문",
  });
  await source.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await source.pressSequentially("원문->그대로");
  await expect(source).toHaveValue(/원문->그대로$/);
  await expect.poll(() => markdown(page)).toContain("원문->그대로");
});

test("구분선 단축키는 그대로이고 한 화면의 여러 꼬리 메모 편집기에서 모두 바꾼다", async ({
  page,
}) => {
  await open(page);
  await rich(page).pressSequentially("---");
  await expect(rich(page).locator("hr")).toHaveCount(1);
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  const path = `/teams/${teamId}/years/2026/memos`;
  const memoIds: string[] = [];
  for (const title of ["첫 메모", "둘째 메모"]) {
    const id = randomUUID();
    memoIds.push(id);
    await request(page, path, "POST", { id, title });
    await request(page, `${path}/${id}`, "PUT", {
      markdown: `${title} 내용\n`,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
  }
  await page.reload();
  const toggle = page
    .getByRole("region", { name: "연간 업무 메모 목록" })
    .getByRole("button", { name: "꼬리 메모", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const memoEditor = (id: string) =>
    page
      .locator(`.memo-document-card[data-document-id="${id}"]`)
      .getByRole("textbox", { name: "연간 업무 메모 리치 편집" });
  // Both editors are created before typing, so neither replaces the other's
  // rules; the first one created still converts.
  await expect(memoEditor(memoIds[0])).toContainText("첫 메모 내용");
  await expect(memoEditor(memoIds[1])).toContainText("둘째 메모 내용");
  for (const [index, id] of [memoIds[0], memoIds[1], memoIds[0]].entries()) {
    const editor = memoEditor(id);
    await editor.locator("p").last().click();
    await page.keyboard.press("End");
    await settle(editor);
    await editor.pressSequentially(` ${index}->`);
    await expect(editor.locator("p").last()).toContainText(`${index}→`);
  }
  await expect
    .poll(
      async () =>
        (await request(page, `${path}/${memoIds[0]}`)).markdown as string,
    )
    .toBe("첫 메모 내용 0→ 2→\n");
  await expect
    .poll(
      async () =>
        (await request(page, `${path}/${memoIds[1]}`)).markdown as string,
    )
    .toBe("둘째 메모 내용 1→\n");
});

test("Chromium IME 한글 조합 앞뒤에서도 화살표를 바꾼다", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME 조합 명령은 Chromium CDP에서 제공",
  );
  await open(page);
  const client = await page.context().newCDPSession(page);
  async function compose(steps: string[]) {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Process",
      code: "KeyG",
      windowsVirtualKeyCode: 229,
    });
    for (const step of steps) {
      await client.send("Input.imeSetComposition", {
        text: step,
        selectionStart: step.length,
        selectionEnd: step.length,
      });
      await expect.poll(() => text(rich(page))).toContain(step);
    }
    await client.send("Input.insertText", { text: steps.at(-1)! });
  }
  await compose(["ㅎ", "하", "한"]);
  await rich(page).pressSequentially("->");
  await expect.poll(() => text(rich(page))).toBe("한→");
  await compose(["ㄱ", "그", "글"]);
  await expect.poll(() => text(rich(page))).toBe("한→글");
  await rich(page).pressSequentially("<=>");
  await compose(["ㅁ", "마", "말"]);
  await expect.poll(() => text(rich(page))).toBe("한→글⇔말");
  await expect.poll(() => markdown(page)).toBe("한→글⇔말\n");
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
  await settle(rich(page));
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
  await settle(rich(page));
  await paste(rich(page), "https://position.example");
  await rich(page).locator("p").first().click();
  await page.keyboard.press("Home");
  await settle(rich(page));
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
  await settle(rich(page));
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
