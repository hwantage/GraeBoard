import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

let teamId: string, taskIds: string[];
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post("/api" + path, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function menu(page: Page, id: string) {
  await page
    .locator(`[data-row-id="${id}"] .row-select`)
    .click({ button: "right" });
}
async function insert(page: Page, id: string, label: string) {
  await menu(page, id);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page.getByRole("menuitem", { name: label, exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).task;
}
async function editTitle(page: Page, id: string, text: string) {
  const cell = page.locator(`[data-cell="${id}:title"]`);
  if (!(await cell.getByRole("textbox").count())) await cell.dblclick();
  await cell.getByRole("textbox").fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    cell.getByRole("textbox").press("Enter"),
  ]);
  await expect(cell).toHaveText(text);
}
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await post(page, "/auth/login", {
    username: "browser-test@example.com",
    password: "local-test-only-password",
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  teamId = (
    await post(page, "/admin/teams", {
      name: "행 메뉴 " + randomUUID().slice(0, 8),
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["첫 업무", "둘째 업무", "셋째 업무"]) {
    const result = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title, "2026-12-07": "출시 검토" },
    });
    taskIds.push(result.task.id);
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("행 메뉴는 위·아래 삽입과 복사 당시 행 붙여넣기·삭제 취소를 제공한다", async ({
  page,
}, info) => {
  await menu(page, taskIds[1]);
  await expect(
    page.getByRole("menuitem", { name: "복사한 행 붙여넣기", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const above = await insert(page, taskIds[1], "위에 삽입");
  await editTitle(page, above.id, "위 행");
  const below = await insert(page, taskIds[1], "아래에 삽입");
  await editTitle(page, below.id, "아래 행");
  const titles = page.locator('[data-column="title"]');
  await expect(titles).toHaveText([
    "첫 업무",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
  ]);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await menu(page, taskIds[0]);
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  await expect(titles).toHaveCount(5);
  await editTitle(page, taskIds[0], "원본 변경");
  await menu(page, taskIds[2]);
  await page.screenshot({ path: info.outputPath("row-menu.png") });
  await page.keyboard.press("Escape");
  const pasted = await insert(page, taskIds[2], "복사한 행 붙여넣기");
  const copy = page.locator(`[data-cell="${pasted.id}:title"]`);
  await expect(titles).toHaveText([
    "원본 변경",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
    "첫 업무",
  ]);
  await expect(copy).toHaveCSS("font-weight", "700");
  expect(pasted.cells["2026-12-07"].value).toBe("출시 검토");
  await menu(page, pasted.id);
  await page.getByRole("menuitem", { name: "행 삭제", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(copy).toHaveText("첫 업무");
  await page.reload();
  await expect(titles).toHaveText([
    "원본 변경",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
    "첫 업무",
  ]);
});

test("행 메뉴는 열람자에게 삽입·붙여넣기·삭제를 허용하지 않는다", async ({
  page,
}) => {
  const username = "row-viewer-" + randomUUID().slice(0, 8) + "@example.com";
  await post(page, "/admin/users", {
    username,
    password: "local-test-only-password",
    name: "열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await post(page, "/auth/login", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await menu(page, taskIds[0]);
  for (const name of [
    "위에 삽입",
    "아래에 삽입",
    "복사한 행 붙여넣기",
    "행 삭제",
  ])
    await expect(
      page.getByRole("menuitem", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "복사", exact: true }),
  ).toBeEnabled();
});

test("툴바 정렬·텍스트 표시는 가로 아이콘 메뉴이며 제거한 버튼은 표시하지 않는다", async ({
  page,
}, info) => {
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  for (const name of ["서식 초기화", "선택 셀 복사", "선택 행 숨기기"])
    await expect(
      toolbar.getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  for (const [label, values] of [
    ["세로 정렬", ["top", "middle", "bottom"]],
    ["텍스트 표시", ["overflow", "wrap", "clip"]],
  ] as const) {
    const trigger = toolbar.getByRole("combobox", { name: label, exact: true });
    await expect(trigger).toHaveText("");
    await trigger.click();
    const popup = page.getByRole("listbox", { name: label, exact: true });
    await expect(popup).toHaveAttribute("aria-orientation", "horizontal");
    const boxes = await popup.getByRole("option").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width };
      }),
    );
    expect(boxes).toHaveLength(3);
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[1].y).toBe(boxes[2].y);
    expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width);
    await page.screenshot({
      path: info.outputPath(
        label === "세로 정렬" ? "vertical-icons.png" : "text-mode-icons.png",
      ),
    });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      popup.locator(`[data-value="${values[1]}"]`).click(),
    ]);
    await expect(trigger).toHaveAttribute("data-value", values[1]);
    await trigger.click();
    await trigger.press("ArrowRight");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      trigger.press("Enter"),
    ]);
    await expect(trigger).toHaveAttribute("data-value", values[2]);
  }
  await expect(first).toHaveCSS("align-items", "safe flex-end");
  await menu(page, taskIds[1]);
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await expect(page.locator(`[data-row-id="${taskIds[1]}"]`)).toHaveCount(0);
  await expect(
    page
      .locator(".view-bar")
      .getByRole("button", { name: "숨김 해제", exact: true }),
  ).toHaveCount(0);
});
