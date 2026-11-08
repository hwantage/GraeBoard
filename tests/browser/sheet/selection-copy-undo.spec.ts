import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { defaultView, normalizeView } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
const ROWS = 60;
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function get(page: Page, path: string) {
  return (await page.request.get(`/api${path}`)).json().then(unpack);
}
async function copyContents(page: Page) {
  return page.getByRole("grid").evaluate((el) => {
    const data: Record<string, string> = {};
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData: (type: string, value: string) => {
          data[type] = value;
        },
      },
    });
    el.dispatchEvent(event);
    return data;
  });
}
async function pasteContents(page: Page, contents: Record<string, string>) {
  await page.getByRole("grid").evaluate((el, data) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: Object.keys(data),
        getData: (type: string) => data[type] || "",
      },
    });
    el.dispatchEvent(event);
  }, contents);
}
async function dragSelection(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!,
    b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}
// 가상 스크롤로 행이 빠져 있어도 표 영역 밖이면 화면 밖이다.
async function expectOffscreen(target: Locator) {
  await expect
    .poll(() =>
      target.evaluateAll((elements) =>
        elements.every((element) => {
          const box = element.getBoundingClientRect();
          const grid = element
            .closest(".sheet-scroll")!
            .getBoundingClientRect();
          return box.bottom <= grid.top + 40 || box.top >= grid.bottom;
        }),
      ),
    )
    .toBe(true);
}
// 가상 스크롤은 행으로 이동한 뒤 잠시 위치를 보정하므로, 직접 옮긴 위치가
// 두 프레임 동안 유지되고 대상 행이 보일 때까지 다시 옮긴다. 맨 위로 갈 때는
// 왼쪽 끝으로도 옮긴다(WebKit은 전체 선택 뒤 마지막 열로 가로 스크롤한다).
async function scrollTo(page: Page, top: 0 | "bottom", visible: Locator) {
  const grid = page.getByRole("grid");
  await expect(async () => {
    const position = await grid.evaluate(async (el, to) => {
      el.scrollTop = to === "bottom" ? el.scrollHeight : to;
      if (to === 0) el.scrollLeft = 0;
      const at = el.scrollTop;
      for (let i = 0; i < 2; i++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      return [at, el.scrollTop];
    }, top);
    expect(position[1]).toBe(position[0]);
    await expect(visible).toBeInViewport({ timeout: 300 });
  }).toPass();
}
const saved = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok());

let teamId: string, taskIds: string[], sheetCloneId: string;
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
      name: `선택 검증 ${randomUUID().slice(0, 8)}`,
      templateTeamId: boot.teams.find((t: any) => t.name === "UX기획팀 · 예시")
        .id,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (let i = 1; i <= ROWS; i++) {
    const { task } = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: `업무 ${String(i).padStart(2, "0")}`,
        owner: boot.user.id,
      },
    });
    taskIds.push(task.id);
  }
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: taskIds.slice(0, 4).flatMap((taskId, i) => [
      { taskId, key: "2026-03-02", value: `A${i + 1}`, expectedVersion: 0 },
      { taskId, key: "2026-03-09", value: `B${i + 1}`, expectedVersion: 0 },
    ]),
  });
  const settings = (await get(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  sheetCloneId = (
    await post(page, "/sheet-clones", {
      teamId,
      year: 2026,
      name: "선택 사본",
      referenceDate: "2026-10-14",
      view: normalizeView(defaultView(2026), settings),
      taskIds,
    })
  ).id;
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "업무 01",
  );
});

test("떨어진 영역은 같은 행 또는 같은 열이면 하나의 표로 복사하고 엇갈리면 안내한다", async ({
  page,
}) => {
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const selected = page.locator('.sheet-cell[aria-selected="true"]');
  const alert = page.getByRole("alert");
  // 같은 행의 떨어진 열: 사이의 속성·날짜 열은 건너뛴다.
  await at(0, "title").click();
  await at(1, "title").click({ modifiers: ["Shift"] });
  await at(0, "2026-03-09").click({ modifiers: ["Meta"] });
  await at(1, "2026-03-09").click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(4);
  let copied = await copyContents(page);
  expect(copied["text/plain"]).toBe("업무 01\tB1\n업무 02\tB2");
  expect(copied["text/html"].match(/<tr>/g)).toHaveLength(2);
  expect(copied["text/html"].match(/<td /g)).toHaveLength(4);
  expect(copied["text/html"]).toContain(">업무 02</td>");
  expect(copied["text/html"]).not.toContain("A1");
  expect(
    JSON.parse(copied["application/x-weekly-plan-cells+json"]).rows.map(
      (row: { text: string }[]) => row.map((c) => c.text),
    ),
  ).toEqual([
    ["업무 01", "B1"],
    ["업무 02", "B2"],
  ]);
  // 같은 열의 떨어진 행.
  await at(0, "2026-03-02").click();
  await at(0, "2026-03-09").click({ modifiers: ["Shift"] });
  await at(3, "2026-03-02").click({ modifiers: ["Meta"] });
  await at(3, "2026-03-09").click({ modifiers: ["Shift"] });
  copied = await copyContents(page);
  expect(copied["text/plain"]).toBe("A1\tB1\nA4\tB4");
  expect(copied["text/html"].match(/<tr>/g)).toHaveLength(2);
  // 열 전체 선택은 숨긴 행을 빼고 복사한다.
  await page
    .getByRole("button", { name: "3행 전체 선택", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await expect(at(2, "title")).toHaveCount(0);
  await page.locator('[data-header-key="2026-03-02"]').click();
  await page
    .locator('[data-header-key="2026-03-09"]')
    .click({ modifiers: ["Meta"] });
  copied = await copyContents(page);
  const lines = copied["text/plain"].split("\n");
  expect(lines).toHaveLength(ROWS - 1);
  expect(lines.slice(0, 4)).toEqual(["A1\tB1", "A2\tB2", "A4\tB4", "\t"]);
  // 행과 열이 엇갈린 영역은 복사하지 않고 안내한다.
  await at(0, "title").click();
  await at(1, "2026-03-02").click({ modifiers: ["Meta"] });
  copied = await copyContents(page);
  expect(copied).toEqual({});
  await expect(alert).toContainText(
    "여러 영역을 복사할 때는 같은 행 또는 같은 열의 영역을 선택하세요.",
  );
  // 같은 행으로 다시 골라 복사가 성공하면 안내를 바로 지운다.
  await at(0, "title").click();
  await at(0, "2026-03-02").click({ modifiers: ["Meta"] });
  copied = await copyContents(page);
  expect(copied["text/plain"]).toBe("업무 01\tA1");
  await expect(alert).toHaveCount(0);
  // 붙여넣기는 여러 영역에서 계속 거절하고, 그 안내는 복사 성공으로 지우지 않는다.
  await pasteContents(page, { "text/plain": "붙여넣기" });
  await expect(alert).toContainText(
    "붙여넣을 때는 하나의 연속된 영역을 선택하세요.",
  );
  await expect(at(0, "title")).toHaveText("업무 01");
  copied = await copyContents(page);
  expect(copied["text/plain"]).toBe("업무 01\tA1");
  await expect(alert).toContainText(
    "붙여넣을 때는 하나의 연속된 영역을 선택하세요.",
  );
  // 2,000셀 한도의 거절도 다음 복사가 성공하면 지운다.
  await page.getByRole("button", { name: "모든 셀 선택", exact: true }).click();
  copied = await copyContents(page);
  expect(copied).toEqual({});
  await expect(alert).toContainText(
    "한 번에 2,000개 셀까지 복사·붙여넣을 수 있습니다.",
  );
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  copied = await copyContents(page);
  expect(copied["text/plain"]).toBe("업무 01");
  await expect(alert).toHaveCount(0);
});

test("⌘/Ctrl로 이미 선택한 셀·행·열을 누르거나 끌면 선택에서 뺀다", async ({
  page,
}) => {
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const selected = page.locator('.sheet-cell[aria-selected="true"]');
  const rowHeader = (row: number) =>
    page.getByRole("button", { name: `${row}행 전체 선택`, exact: true });
  const selectedRows = page.locator('.row-number[aria-selected="true"]');
  // 같은 열에서 하나씩 고른 셀 중 하나를 다시 누르면 그 셀만 빠진다.
  await at(0, "title").click();
  for (const row of [1, 2, 3])
    await at(row, "title").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(4);
  await at(2, "title").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(3);
  await expect(at(2, "title")).toHaveAttribute("aria-selected", "false");
  for (const row of [0, 1, 3])
    await expect(at(row, "title")).toHaveAttribute("aria-selected", "true");
  // 남은 영역을 복사할 수 있고, 활성 셀은 마지막 영역에 둔다.
  expect((await copyContents(page))["text/plain"]).toBe(
    "업무 01\n업무 02\n업무 04",
  );
  await expect(at(3, "title")).toHaveClass(/focused/);
  // 사각형 가운데 셀을 빼면 나머지 여덟 칸이 남는다.
  await at(0, "2026-03-02").click();
  await at(2, "2026-03-16").click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(9);
  await at(1, "2026-03-09").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(8);
  await expect(at(1, "2026-03-09")).toHaveAttribute("aria-selected", "false");
  // 선택한 셀에서 시작한 ⌘/Ctrl 드래그는 끈 범위를 뺀다.
  await at(0, "2026-03-02").click();
  await at(2, "2026-03-16").click({ modifiers: ["Shift"] });
  await page.keyboard.down("Meta");
  await dragSelection(page, at(0, "2026-03-09"), at(2, "2026-03-09"));
  await page.keyboard.up("Meta");
  await expect(selected).toHaveCount(6);
  for (const row of [0, 1, 2])
    await expect(at(row, "2026-03-09")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  expect((await copyContents(page))["text/plain"]).toBe("A1\t\nA2\t\nA3\t");
  // 선택하지 않은 셀은 그대로 영역을 더한다.
  await at(3, "2026-03-09").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(7);
  // 행 머리글: 선택한 행을 다시 누르면 그 행만 빠진다.
  await rowHeader(1).click();
  await rowHeader(3).click({ modifiers: ["Meta"] });
  await expect(selectedRows).toHaveCount(2);
  await rowHeader(1).click({ modifiers: ["Meta"] });
  await expect(selectedRows).toHaveCount(1);
  await expect(
    page.locator(`[data-row-id="${taskIds[2]}"] .row-number`),
  ).toHaveAttribute("aria-selected", "true");
  // 행 머리글 드래그로 여러 행을 한 번에 뺀다.
  await rowHeader(1).click();
  await rowHeader(4).click({ modifiers: ["Shift"] });
  await expect(selectedRows).toHaveCount(4);
  await page.keyboard.down("Meta");
  await dragSelection(page, rowHeader(2), rowHeader(3));
  await page.keyboard.up("Meta");
  await expect(selectedRows).toHaveCount(2);
  for (const [row, value] of [
    [0, "true"],
    [1, "false"],
    [2, "false"],
    [3, "true"],
  ] as const)
    await expect(
      page.locator(`[data-row-id="${taskIds[row]}"] .row-number`),
    ).toHaveAttribute("aria-selected", value);
  // 열 머리글도 같고, 마지막 선택을 빼면 선택이 없는 상태가 된다.
  const first = page.locator('[data-header-key="2026-03-02"]');
  const second = page.locator('[data-header-key="2026-03-09"]');
  await first.click();
  await second.click({ modifiers: ["Meta"] });
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await first.click({ modifiers: ["Meta"] });
  await expect(first).toHaveAttribute("aria-selected", "false");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await second.click({ modifiers: ["Meta"] });
  await expect(second).toHaveAttribute("aria-selected", "false");
  await expect(selected).toHaveCount(0);
  await at(0, "title").click();
  await expect(at(0, "title")).toHaveClass(/focused/);
  await expect(selected).toHaveCount(1);
});

test("원본 실행취소·재실행은 화면 밖의 바뀐 셀·행·열을 선택하고 그 위치로 이동한다", async ({
  page,
}) => {
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const undo = toolbar.getByRole("button", { name: "실행취소", exact: true });
  const redo = toolbar.getByRole("button", { name: "재실행", exact: true });
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const selected = page.locator('.sheet-cell[aria-selected="true"]');
  const last = at(ROWS - 1, "title");
  // 셀 값: 마지막 행을 고친 뒤 맨 위에서 단축키로 되돌린다.
  await scrollTo(page, "bottom", last);
  await last.dblclick();
  await page.locator(".inline-editor textarea").fill("마지막 행 수정");
  await Promise.all([
    saved(page),
    page.locator(".inline-editor textarea").press("Enter"),
  ]);
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await expectOffscreen(last);
  await Promise.all([saved(page), page.keyboard.press("ControlOrMeta+z")]);
  await expect(last).toHaveText(`업무 ${ROWS}`);
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toHaveClass(/focused/);
  await expect(last).toBeInViewport();
  await expect(selected).toHaveCount(1);
  // 단축키 뒤에도 새 선택에서 키보드로 이어서 이동한다.
  await expect(last.locator(".cell-input-ready textarea")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(at(ROWS - 2, "title")).toHaveClass(/focused/);
  // 툴바 재실행도 같은 셀로 이동한다.
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await expectOffscreen(last);
  await Promise.all([saved(page), redo.click()]);
  await expect(last).toHaveText("마지막 행 수정");
  await expect(last).toHaveClass(/focused/);
  await expect(last).toBeInViewport();
  await expect(last.locator(".cell-input-ready textarea")).toBeFocused();
  // 저장을 기다리는 사이 검색창에 입력하면 선택만 옮기고 입력칸 포커스는 둔다.
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await page.route("**/api/cells/batch", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const search = page.getByLabel("전체 속성 검색", { exact: true });
  const undone = saved(page);
  await page.keyboard.press("ControlOrMeta+z");
  await search.click();
  await search.pressSequentially("없는 검색어");
  await undone;
  await page.unroute("**/api/cells/batch");
  await expect(last).toHaveText(`업무 ${ROWS}`);
  await expect(last).toHaveClass(/focused/);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("없는 검색어");
  await search.fill("");

  // 여러 셀: 붙여넣은 범위를 그대로 다시 선택한다.
  await scrollTo(page, 0, at(0, "2026-03-02"));
  await at(0, "2026-03-02").click();
  await Promise.all([
    saved(page),
    pasteContents(page, { "text/plain": "가\t나\n다\t라" }),
  ]);
  await at(5, "title").click();
  await Promise.all([saved(page), undo.click()]);
  await expect(at(0, "2026-03-02")).toHaveText("A1");
  await expect(selected).toHaveCount(4);
  for (const [row, key] of [
    [0, "2026-03-02"],
    [0, "2026-03-09"],
    [1, "2026-03-02"],
    [1, "2026-03-09"],
  ] as const)
    await expect(at(row, key)).toHaveAttribute("aria-selected", "true");
  await expect(at(0, "2026-03-02")).toBeInViewport();

  // 열 전체 서식은 열 선택으로 되돌린다.
  const header = page.locator('[data-header-key="2026-03-16"]');
  await header.click();
  await Promise.all([
    saved(page),
    page.getByRole("button", { name: "굵게", exact: true }).click(),
  ]);
  await expect(at(0, "2026-03-16")).toHaveCSS("font-weight", "700");
  await at(3, "title").click();
  await expect(header).toHaveAttribute("aria-selected", "false");
  await Promise.all([saved(page), undo.click()]);
  await expect(at(0, "2026-03-16")).not.toHaveCSS("font-weight", "700");
  await expect(header).toHaveAttribute("aria-selected", "true");
  await expect(at(3, "title")).toHaveAttribute("aria-selected", "false");

  // 행 삭제를 알림에서 되돌리면 되살린 행을 선택하고, 재실행은 그 자리의 행으로 간다.
  const row = ROWS - 5;
  await scrollTo(page, "bottom", last);
  await page
    .getByRole("button", { name: `${row + 1}행 전체 선택`, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 삭제", exact: true }).click();
  await expect(at(row, "title")).toHaveCount(0);
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  const toast = page.locator(".toast");
  await toast.getByRole("button", { name: "실행취소" }).click();
  await expect(toast).toContainText("업무를 되살렸습니다.");
  await expect(at(row, "title")).toHaveAttribute("aria-selected", "true");
  await expect(at(row, "title")).toBeInViewport();
  await expect(
    page.locator(`[data-row-id="${taskIds[row]}"] .row-number`),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.row-number[aria-selected="true"]')).toHaveCount(
    1,
  );
  await scrollTo(page, 0, at(0, "title"));
  await redo.click();
  await expect(at(row, "title")).toHaveCount(0);
  const next = page.locator(`[data-row-id="${taskIds[row + 1]}"] .sheet-cell`);
  await expect(next.and(page.locator(".focused"))).toHaveCount(1);
  await expect(next.first()).toBeInViewport();
});

test("사본 실행취소·재실행도 전후 시트를 비교해 바뀐 셀과 행을 선택한다", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "선택 사본", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveAttribute(
    "aria-readonly",
    "false",
  );
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const redo = toolbar.getByRole("button", { name: "재실행", exact: true });
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const selected = page.locator('.sheet-cell[aria-selected="true"]');
  const last = at(ROWS - 1, "title");
  await scrollTo(page, "bottom", last);
  await last.dblclick();
  await page.locator(".inline-editor textarea").fill("사본 마지막 수정");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(last).toHaveText("사본 마지막 수정");
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await expectOffscreen(last);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(last).toHaveText(`업무 ${ROWS}`);
  await expect(last).toHaveClass(/focused/);
  await expect(last).toBeInViewport();
  await expect(selected).toHaveCount(1);
  await expect(last.locator(".cell-input-ready textarea")).toBeFocused();
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(last).toHaveText("사본 마지막 수정");
  await expect(last).toHaveClass(/focused/);
  await expect(last).toBeInViewport();

  // 행 삭제를 되돌리면 되살린 행, 다시 지우면 그 자리의 행을 선택한다.
  const row = ROWS - 5;
  await page
    .getByRole("button", { name: `${row + 1}행 전체 선택`, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 삭제", exact: true }).click();
  await expect(at(row, "title")).toHaveCount(0);
  await scrollTo(page, 0, at(0, "title"));
  await at(0, "title").click();
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행취소" })
    .click();
  await expect(at(row, "title")).toHaveAttribute("aria-selected", "true");
  await expect(at(row, "title")).toBeInViewport();
  await expect(
    page.locator(`[data-row-id="${taskIds[row]}"] .row-number`),
  ).toHaveAttribute("aria-selected", "true");
  await scrollTo(page, 0, at(0, "title"));
  await redo.click();
  await expect(at(row, "title")).toHaveCount(0);
  const next = page.locator(`[data-row-id="${taskIds[row + 1]}"] .sheet-cell`);
  await expect(next.and(page.locator(".focused"))).toHaveCount(1);
  await expect(next.first()).toBeInViewport();
});
