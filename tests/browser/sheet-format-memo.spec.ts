import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { cell, defaultView, todayKey } from "../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, ids: string[];
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
const target = (page: Page, row: number, key = "title") =>
  page.locator(`[data-cell="${ids[row]}:${key}"]`);
const stored = async (page: Page) =>
  (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks;
async function save(page: Page, action: () => Promise<unknown>) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    action(),
  ]);
  await expect(
    page.getByRole("button", { name: "서식 복사", exact: true }),
  ).toBeEnabled();
}
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!,
    b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 12, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 12, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
}
test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `서식 메모 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  ids = [];
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await request(page, "/tasks", "POST", {
          teamId,
          year: 2026,
          fields: { title: `업무 ${i + 1}`, owner: userId },
        })
      ).task.id,
    );
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: ids[0],
        key: "title",
        expectedVersion: 1,
        style: {
          bold: true,
          backgroundColor: "#fff2cc",
          fontSize: 14,
          borderBottom: { style: "solid", color: "#ff0000" },
        },
      },
      {
        taskId: ids[1],
        key: "title",
        expectedVersion: 1,
        style: { italic: true, backgroundColor: "#d9ead3" },
      },
    ],
  });
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId, teamId },
  );
  await page.goto("/");
  await expect(target(page, 0)).toHaveText("업무 1");
});

test("서식 복사는 여러 셀의 내용을 보존하며 한 번에 실행취소하고 연속 적용을 취소한다", async ({
  page,
}) => {
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await target(page, 0).click();
  await brush.click();
  await expect(brush).toHaveAttribute("aria-pressed", "true");
  await save(page, () => drag(page, target(page, 1), target(page, 3)));
  await expect(brush).toHaveAttribute("aria-pressed", "false");
  for (const task of (await stored(page)).slice(1, 4)) {
    expect(cell(task, "title").style).toMatchObject({
      bold: true,
      backgroundColor: "#fff2cc",
      fontSize: 14,
      borderBottom: { style: "solid", color: "#ff0000" },
    });
    expect(cell(task, "title").style.italic).toBeFalsy();
    expect(task.cells.title.value).toBe(`업무 ${ids.indexOf(task.id) + 1}`);
  }
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  expect(cell((await stored(page))[1], "title").style).toMatchObject({
    italic: true,
    backgroundColor: "#d9ead3",
  });
  await save(page, () =>
    page.getByRole("button", { name: "재실행", exact: true }).click(),
  );
  await target(page, 0).click();
  await brush.dblclick();
  await save(page, () => target(page, 4).click());
  await expect(brush).toHaveAttribute("aria-pressed", "true");
  await save(page, () => target(page, 4, "owner").click());
  await page.keyboard.press("Escape");
  await expect(brush).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  expect(cell((await stored(page))[4], "owner").style.bold).toBe(true);
  expect((await stored(page))[4].cells.owner.value).toBe(userId);
});

test("서식 복사 중 Esc는 업무 팝업을 먼저 닫고 복사 상태를 유지한다", async ({
  page,
}) => {
  await target(page, 0).click();
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await brush.click();
  await target(page, 0).locator(".task-document-indicator").click();
  const dialog = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(brush).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(brush).toHaveAttribute("aria-pressed", "false");
});

test("Esc로 서식 복사를 취소해도 선택 범위는 유지한다", async ({ page }) => {
  await drag(page, target(page, 0), target(page, 2));
  const selected = page.locator('.sheet-cell[aria-selected="true"]');
  const cells = await selected.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-cell")),
  );
  expect(cells).toHaveLength(3);
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await brush.click();
  await expect(page.locator(".sheet-scroll")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(brush).toHaveAttribute("aria-pressed", "false");
  await expect(selected).toHaveCount(3);
  expect(
    await selected.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-cell")),
    ),
  ).toEqual(cells);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);
});

test("서식 복사 중 저장된 필터 메뉴는 Esc 한 번에 닫히며 복사도 해제한다", async ({
  page,
}) => {
  await target(page, 0).click();
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await brush.click();
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  await trigger.click();
  const menu = page.locator(".saved-views");
  await expect(menu).toBeVisible();
  await expect(brush).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(brush).toHaveAttribute("aria-pressed", "false");
  await expect(target(page, 0)).toHaveAttribute("aria-selected", "true");
});

test("연속 서식 적용은 저장 중 추가 요청을 안내하고 저장 후 다시 적용한다", async ({
  page,
}) => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requests = 0;
  await page.route("**/api/cells/batch", async (route) => {
    requests++;
    started();
    await gate;
    await route.continue();
  });
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await target(page, 0).click();
  await brush.dblclick();
  try {
    await target(page, 2).click();
    await received;
    await target(page, 3).click();
    await expect(page.getByRole("alert")).toContainText(
      "앞선 변경을 저장 중입니다. 잠시 후 다시 적용하세요.",
    );
    await page.locator(`[data-row-id="${ids[4]}"] .row-select`).click();
    await expect(brush).toHaveAttribute("aria-pressed", "true");
    expect(requests).toBe(1);
    await save(page, async () => release());
    expect(cell((await stored(page))[3], "title").style.bold).not.toBe(true);
    await save(page, () => target(page, 3).click());
    expect(cell((await stored(page))[3], "title").style.bold).toBe(true);
    await save(page, () =>
      page.locator(`[data-row-id="${ids[4]}"] .row-select`).click(),
    );
    expect(cell((await stored(page))[4], "owner").style.bold).toBe(true);
  } finally {
    release();
  }
});

test("서식 범위의 패턴을 사본에 적용하고 사본 실행취소는 원본을 바꾸지 않는다", async ({
  page,
}) => {
  await request(page, "/reports", "POST", {
    teamId,
    year: 2026,
    name: "서식 사본",
    referenceDate: "2026-10-26",
    view: defaultView(2026),
    taskIds: ids,
  });
  await page.reload();
  await page.getByRole("tab", { name: "서식 사본", exact: true }).click();
  await drag(page, target(page, 0), target(page, 1));
  await page.getByRole("button", { name: "서식 복사", exact: true }).click();
  await target(page, 2).click();
  await expect(target(page, 2)).toHaveCSS(
    "background-color",
    "rgb(255, 242, 204)",
  );
  await expect(target(page, 3)).toHaveCSS(
    "background-color",
    "rgb(217, 234, 211)",
  );
  await expect(page.locator(".sheet-save-status")).toHaveText("저장됨");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(target(page, 2)).not.toHaveCSS(
    "background-color",
    "rgb(255, 242, 204)",
  );
  expect(cell((await stored(page))[2], "title").style.bold).not.toBe(true);
});

test("열린 꼬리 메모 복원은 표 위치를 유지하고 발표에서는 툴바 없이 펼친다", async ({
  page,
}, info) => {
  for (let i = 0; i < 30; i++)
    await request(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: `긴 표 ${i}` },
    });
  const memoId = randomUUID(),
    path = `/teams/${teamId}/years/2026/memos`;
  await request(page, path, "POST", { id: memoId, title: "발표 메모" });
  await request(page, `${path}/${memoId}`, "PUT", {
    markdown: "# 회의 자료\n\n발표에서 읽을 메모",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await page.evaluate(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-plan:memo-open:${userId}:${teamId}:2026`,
        "true",
      ),
    { userId, teamId },
  );
  await page.reload();
  const grid = page.locator(".sheet-scroll"),
    memos = page.locator(".annual-memos"),
    toggle = memos.locator(".toggle-memos");
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toContainText("발표에서 읽을 메모");
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(0);
  const copy = await request(page, "/reports", "POST", {
    teamId,
    year: 2026,
    name: "메모 사본",
    referenceDate: "2026-10-26",
    view: defaultView(2026),
    taskIds: (await stored(page)).map((task: { id: string }) => task.id),
  });
  await page.evaluate(
    ({ userId, teamId, id }) =>
      localStorage.setItem(
        `weekly-plan:memo-open:${userId}:${teamId}:${id}`,
        "true",
      ),
    { userId, teamId, id: copy.id },
  );
  await grid.evaluate((el) => {
    el.scrollTop = 160;
  });
  await page.getByRole("tab", { name: "메모 사본", exact: true }).click();
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toContainText("발표에서 읽을 메모");
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(0);
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toContainText("발표에서 읽을 메모");
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(160);
  // Position the collapsed toggle before measuring, so click auto-scrolling
  // cannot stand in for revealing the newly opened document.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await grid.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(0);
  await toggle.scrollIntoViewIfNeeded();
  const beforeOpen = await grid.evaluate((el) => el.scrollTop);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => grid.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(beforeOpen);
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toBeInViewport();
  await expect(toggle).toHaveCSS("font-size", "11px");
  expect((await toggle.boundingBox())!.height).toBe(
    (await page.locator(".format-toolbar").boundingBox())!.height,
  );
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    memos.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toHaveAttribute("contenteditable", "false");
  await expect(memos.locator(".document-rich-tools")).toHaveCount(0);
  await expect(
    memos.getByRole("button", { name: "문서 추가", exact: true }),
  ).toHaveCount(0);
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("presentation-memo.png") });
});

test("업무 삭제는 하단 왼쪽이며 캘린더 문서 확대는 입력을 유지한다", async ({
  page,
}, info) => {
  await target(page, 0).click({ button: "right" });
  const task = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await expect(
    task
      .locator("header")
      .getByRole("button", { name: "업무 삭제", exact: true }),
  ).toHaveCount(0);
  await expect(
    task
      .locator("footer")
      .getByRole("button", { name: "업무 삭제", exact: true }),
  ).toBeVisible();
  await task.getByRole("button", { name: "닫기", exact: true }).click();
  const id = randomUUID();
  await request(page, "/calendar/entries", "POST", {
    id,
    teamId,
    userId,
    title: "확대할 일정",
    date: todayKey(),
  });
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await page
    .locator(`[data-entry-id="${id}"] .calendar-entry-card`)
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "캘린더 일정", exact: true });
  await expect(
    dialog.getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const input = dialog.getByRole("textbox", {
    name: "일정 문서 Markdown 원문",
  });
  await input.fill("# 확대 중인 문서\n\n입력이 유지됩니다.");
  await dialog
    .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
    .click();
  await expect(dialog).toHaveClass(/document-full-page/);
  expect((await dialog.boundingBox())!.width).toBe(page.viewportSize()!.width);
  await expect(input).toHaveValue("# 확대 중인 문서\n\n입력이 유지됩니다.");
  await page.screenshot({ path: info.outputPath("calendar-expanded.png") });
  await dialog
    .getByRole("button", { name: "전체 페이지 닫기", exact: true })
    .click();
  await expect(dialog).not.toHaveClass(/document-full-page/);
  const title = dialog.getByRole("textbox", { name: "일정 제목", exact: true });
  await title.fill("");
  await input.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "일정 제목을 입력해 주세요.",
  );
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(70);
  await title.click();
  await expect(title).toBeFocused();
  await title.fill("확대할 일정");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  expect(
    (await request(page, `/calendar/entries/${id}/document`)).markdown,
  ).toContain("입력이 유지됩니다.");
});

test("서식 복사는 행·열·전체 선택과 취소된 드래그를 기존 저장 경로로 처리한다", async ({
  page,
}) => {
  const brush = page.getByRole("button", { name: "서식 복사", exact: true });
  await target(page, 0).click();
  await brush.click();
  const from = (await target(page, 2).boundingBox())!;
  const to = (await target(page, 4).boundingBox())!;
  await page.mouse.move(from.x + 12, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 12, to.y + to.height / 2, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(cell((await stored(page))[2], "title").style.bold).not.toBe(true);
  await expect(brush).toHaveAttribute("aria-pressed", "false");
  await target(page, 0).click();
  await brush.click();
  await save(page, () =>
    page.locator(`[data-row-id="${ids[1]}"] .row-select`).click(),
  );
  let row = (await stored(page))[1];
  expect(cell(row, "owner").style.bold).toBe(true);
  expect(cell(row, "2026-06-01").style.backgroundColor).toBe("#fff2cc");
  await target(page, 0).click();
  await brush.click();
  await save(page, () =>
    page.getByRole("button", { name: "팀원 열 선택", exact: true }).click(),
  );
  for (const task of await stored(page)) {
    expect(cell(task, "owner").style.bold).toBe(true);
    expect(cell(task, "owner").style.backgroundColor).toBe("#fff2cc");
    expect(cell(task, "owner").value).toBe(userId);
  }
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  expect(cell((await stored(page))[2], "owner").style.bold).not.toBe(true);
  expect(cell((await stored(page))[1], "owner").style.bold).toBe(true);
  await target(page, 4).click();
  await brush.click();
  await save(page, () =>
    page.getByRole("button", { name: "모든 셀 선택", exact: true }).click(),
  );
  row = (await stored(page))[1];
  expect(cell(row, "title").style.bold).toBeFalsy();
  expect(cell(row, "title").style.italic).toBeFalsy();
  expect(cell(row, "owner").value).toBe(userId);
  expect(cell(row, "2026-06-01").style.backgroundColor).not.toBe("#fff2cc");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await target(page, 0).click();
  await brush.click();
  await expect(page.locator(".sheet-scroll")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await save(page, () => page.keyboard.press("Enter"));
  expect(cell((await stored(page))[2], "title").style.bold).toBe(true);
});

async function imageDocument(page: Page, path: string, title: string) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#408378";
    context.fillRect(0, 0, 320, 180);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const uploaded = await page.request.post(`/api${path}/images`, {
    headers,
    multipart: {
      image: {
        name: "presentation.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      },
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const { url } = await uploaded.json();
  await request(page, path, "PUT", {
    markdown: `# ${title}\n\n![발표 이미지](${url})`,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
}

for (const copy of [false, true]) {
  test(`${copy ? "사본" : "원본"} 발표에서 업무 문서를 읽고 이미지 팝업을 닫아도 발표와 필기를 유지한다`, async ({
    page,
  }, info) => {
    await imageDocument(
      page,
      `/tasks/${ids[0]}/documents/main`,
      "발표할 업무 문서",
    );
    const second = randomUUID();
    await request(page, `/tasks/${ids[0]}/documents`, "POST", {
      id: second,
      title: "두 번째 자료",
    });
    await request(page, `/tasks/${ids[0]}/documents/${second}`, "PUT", {
      markdown: "# 두 번째 문서 본문",
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    const memoId = randomUUID(),
      path = `/teams/${teamId}/years/2026/memos`;
    await request(page, path, "POST", { id: memoId, title: "그림 메모" });
    await imageDocument(page, `${path}/${memoId}`, "발표할 꼬리 메모");
    if (copy)
      await request(page, "/reports", "POST", {
        teamId,
        year: 2026,
        name: "발표 사본",
        referenceDate: "2026-10-26",
        view: defaultView(2026),
        taskIds: ids,
      });
    await page.reload();
    if (copy)
      await page.getByRole("tab", { name: "발표 사본", exact: true }).click();
    const writes: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method()) &&
        /\/api\/(cells|tasks|reports|teams\/[^/]+\/years\/\d+\/memos)(\/|$)/.test(
          path,
        )
      )
        writes.push(`${req.method()} ${path}`);
    });
    await page.getByRole("button", { name: "발표 모드", exact: true }).click();
    const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
    await toolbar.getByRole("button", { name: "펜", exact: true }).click();
    await page.mouse.move(700, 160);
    await page.mouse.down();
    await page.mouse.move(800, 180, { steps: 5 });
    await page.mouse.up();
    await expect(
      page.locator("[data-annotation]:not([data-draft])"),
    ).toHaveCount(1);
    const indicator = target(page, 0).locator(".task-document-indicator");
    await indicator.click();
    const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
    await expect(
      detail.getByRole("textbox", { name: "작업 편집", exact: true }),
    ).not.toBeEditable();
    await expect(
      detail.locator(
        ".task-detail-actions,.task-detail-footer,.document-rich-tools",
      ),
    ).toHaveCount(0);
    const rich = detail.getByRole("textbox", { name: "업무 문서 리치 편집" });
    await expect(rich).toHaveAttribute("contenteditable", "false");
    await expect(rich).toContainText("발표할 업무 문서");
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    await expect(
      detail.getByRole("button", { name: "닫기", exact: true }),
    ).not.toHaveCSS("cursor", "none");
    await detail
      .getByRole("tab", { name: "두 번째 자료", exact: true })
      .click();
    await expect(rich).toContainText("두 번째 문서 본문");
    await detail.getByRole("tab").first().click();
    await detail
      .getByRole("button", { name: "문서 전체 페이지로 보기", exact: true })
      .click();
    await rich.locator("img[src]").dblclick();
    const preview = page.getByRole("dialog", {
      name: "이미지 크게 보기",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "실제 크기", exact: true }),
    ).not.toHaveCSS("cursor", "none");
    await preview
      .getByRole("button", { name: "실제 크기", exact: true })
      .click();
    await expect(preview.locator(".document-image-canvas")).toHaveClass(
      /actual-size/,
    );
    await page.keyboard.press("ControlOrMeta+z");
    await expect(
      page.locator("[data-annotation]:not([data-draft])"),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(page.locator(".workspace")).toHaveClass(/presentation-mode/);
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(toolbar).toBeVisible();
    // The existing document button also opens from the keyboard in presentation mode.
    await indicator.focus();
    await indicator.press("Enter");
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await page.mouse.move(500, 150);
    await expect(page.locator(".presentation-pointer")).toBeVisible();
    if (copy) {
      await toolbar
        .getByRole("button", { name: "레이저 포인터", exact: true })
        .click();
      await toolbar
        .getByRole("button", { name: "지우개", exact: true })
        .click();
    }
    const memos = page.locator(".annual-memos");
    const memoToggle = memos.getByRole("button", {
      name: "꼬리 메모",
      exact: true,
    });
    await memoToggle.hover();
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    await expect(memoToggle).toHaveCSS("cursor", "pointer");
    await memoToggle.click();
    const memoRich = memos.getByRole("textbox", {
      name: "연간 업무 메모 리치 편집",
    });
    await memoRich.locator("h1").hover();
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    await expect(memoRich).not.toHaveCSS("cursor", /none|crosshair/);
    const memoTab = memos.getByRole("tab", { name: "그림 메모", exact: true });
    await memoTab.hover();
    await expect(memoTab).toHaveCSS("cursor", "pointer");
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    // Returning to the table restores the selected laser or eraser pointer.
    await target(page, 0).hover();
    await expect(target(page, 0)).toHaveCSS("cursor", "none");
    await expect(page.locator(".presentation-pointer")).toBeVisible();
    await expect(
      toolbar.getByRole("button", { name: "레이저 포인터", exact: true }),
    ).toHaveAttribute("aria-pressed", String(!copy));
    await memoRich.locator("img[src]").hover();
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    await memoRich.locator("img[src]").dblclick();
    await expect(preview).toBeVisible();
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    const close = preview.getByRole("button", { name: "닫기", exact: true });
    await expect(close).not.toHaveCSS("cursor", "none");
    await preview
      .getByRole("button", { name: "실제 크기", exact: true })
      .click();
    await preview
      .getByRole("button", { name: "화면에 맞추기", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath("presentation-image-preview.png"),
    });
    await close.click();
    await expect(preview).toHaveCount(0);
    await memoRich.locator("h1").hover();
    await expect(page.locator(".presentation-pointer")).toBeHidden();
    await expect(memoRich).not.toHaveCSS("cursor", /none|crosshair/);
    await expect(toolbar).toBeVisible();
    await expect(
      page.locator("[data-annotation]:not([data-draft])"),
    ).toHaveCount(1);
    expect(writes).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
  });
}
