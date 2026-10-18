import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { cell } from "../../shared/domain.js";

let teamId: string, ids: string[];
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function stored(page: Page) {
  return (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks;
}
async function save(page: Page, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    action(),
  ]);
  return response.json().then(unpack);
}
test.beforeEach(async ({ page }) => {
  await post(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await post(page, "/admin/teams", {
      name: `공통서식 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  ids = [];
  for (const title of ["이어지는 업무", "다른 업무"])
    ids.push(
      (
        await post(page, "/tasks", {
          teamId,
          year: 2026,
          fields: { title, owner: boot.user.id },
        })
      ).task.id,
    );
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId: boot.user.id, teamId },
  );
  await page.goto("/");
  await expect(page.locator(`[data-cell="${ids[0]}:title"]`)).toHaveText(
    "이어지는 업무",
  );
});

test("밑줄·취소선은 실제 텍스트에 표시되고 각각 해제하거나 함께 저장할 수 있다", async ({
  page,
}, info) => {
  const title = page.locator(`[data-cell="${ids[0]}:title"]`);
  const text = title.locator(".cell-text");
  await title.click();
  for (const [label, key, decoration] of [
    ["밑줄", "underline", "underline"],
    ["취소선", "strike", "line-through"],
  ] as const) {
    const button = page.getByRole("button", { name: label, exact: true });
    await save(page, () => button.click());
    expect(cell((await stored(page))[0], "title").style[key]).toBe(true);
    // 셀 컨테이너뿐 아니라 실제 글자에도 서식이 전달되어야 한다.
    await expect(text).toHaveCSS("text-decoration-line", decoration);
    await save(page, () => button.click());
    await expect(text).toHaveCSS("text-decoration-line", "none");
  }
  await save(page, () =>
    page.getByRole("button", { name: "밑줄", exact: true }).click(),
  );
  await save(page, () =>
    page.getByRole("button", { name: "취소선", exact: true }).click(),
  );
  await expect(text).toHaveCSS(
    "text-decoration-line",
    "underline line-through",
  );
  for (const mode of ["줄바꿈", "자르기", "오버플로우"]) {
    await page
      .getByRole("combobox", { name: "텍스트 표시", exact: true })
      .click();
    await save(page, () =>
      page.getByRole("option", { name: mode, exact: true }).click(),
    );
    await expect(text).toHaveCSS(
      "text-decoration-line",
      "underline line-through",
    );
  }
  await title.dblclick();
  await expect(title.locator(".inline-editor textarea")).toHaveCSS(
    "text-decoration-line",
    "underline line-through",
  );
  await title.locator(".inline-editor textarea").press("Escape");
  await page.reload();
  await expect(text).toHaveCSS(
    "text-decoration-line",
    "underline line-through",
  );
  await page.screenshot({
    path: info.outputPath("text-decorations.png"),
    fullPage: true,
  });
});

test("행 전체 서식은 빈 주차를 저장하지 않고 월 이동·새해 1월·2월·새로고침에도 이어진다", async ({
  page,
}) => {
  const before = await stored(page);
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  const result = await save(page, () =>
    page.getByLabel("배경색", { exact: true }).fill("#d1eee6"),
  );
  expect(result.formatOperation).toBe(true);
  expect(result.cells).toHaveLength(0);
  const rows = await stored(page);
  expect(Object.keys(rows[0].cells)).toEqual(Object.keys(before[0].cells));
  expect(rows[0].formatting.rules).toHaveLength(1);
  for (const key of ["2026-12-28", "2027-01-04", "2027-02-01"])
    expect(cell(rows[0], key).style.backgroundColor).toBe("#d1eee6");
  const next = page.getByRole("button", {
    name: "다음 달로 이동",
    exact: true,
  });
  for (const key of ["2027-01-04", "2027-02-01"]) {
    await next.click();
    await expect(next).toBeEnabled();
    const target = page.locator(`[data-cell="${ids[0]}:${key}"]`);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toHaveCSS("background-color", "rgb(209, 238, 230)");
    await expect(page.locator(`[data-cell="${ids[1]}:${key}"]`)).not.toHaveCSS(
      "background-color",
      "rgb(209, 238, 230)",
    );
  }
  await page.reload();
  const target = page.locator(`[data-cell="${ids[0]}:2027-02-01"]`);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveCSS("background-color", "rgb(209, 238, 230)");
});

test("열 공통 서식과 한 셀 예외를 재적용·실행취소·재실행하고 이전 값 편집도 되돌린다", async ({
  page,
}) => {
  const title = page.locator(`[data-cell="${ids[0]}:title"]`);
  await title.dblclick();
  await title.getByRole("textbox").fill("편집된 업무");
  await save(page, () => page.keyboard.press("Enter"));
  const header = page.getByRole("button", {
    name: "작업 열 선택",
    exact: true,
  });
  await header.click();
  await save(page, () =>
    page.getByLabel("배경색", { exact: true }).fill("#d1eee6"),
  );
  await title.click();
  await save(page, () =>
    page.getByLabel("배경색", { exact: true }).fill("#cebdeb"),
  );
  await expect(title).toHaveCSS("background-color", "rgb(206, 189, 235)");
  await header.click();
  await save(page, () =>
    page.getByLabel("배경색", { exact: true }).fill("#ffe599"),
  );
  await expect(title).toHaveCSS("background-color", "rgb(255, 229, 153)");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await expect(title).toHaveCSS("background-color", "rgb(206, 189, 235)");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await expect(title).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await expect(title).not.toHaveCSS("background-color", "rgb(209, 238, 230)");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await expect(title).toHaveText("이어지는 업무");
  for (let i = 0; i < 4; i++)
    await save(page, () =>
      page.getByRole("button", { name: "재실행", exact: true }).click(),
    );
  await expect(title).toHaveText("편집된 업무");
  await expect(title).toHaveCSS("background-color", "rgb(255, 229, 153)");
});

test("행 전체 글자 크기·테두리는 빈 셀을 늘리지 않고 행 높이와 새해 주차에 반영한다", async ({
  page,
}) => {
  const before = await stored(page);
  const title = page.locator(`[data-cell="${ids[0]}:title"]`);
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  const font = page.getByRole("combobox", { name: "글자 크기", exact: true });
  await font.click();
  const menu = await font.getAttribute("aria-controls");
  await save(page, () =>
    page.locator(`[id="${menu}"] [role="option"][data-value="36"]`).click(),
  );
  await expect(title).toHaveCSS("font-size", "48px");
  expect((await title.boundingBox())!.height).toBeGreaterThanOrEqual(90);
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  await page
    .getByLabel("테두리 선 스타일", { exact: true })
    .selectOption("double");
  await page.getByLabel("테두리 선 색상", { exact: true }).fill("#856060");
  await save(page, () =>
    page.getByRole("button", { name: "모든 테두리", exact: true }).click(),
  );
  await expect(title).toHaveCSS("border-bottom-style", "double");
  await expect(title).toHaveCSS("border-left-style", "double");
  const rows = await stored(page);
  expect(Object.keys(rows[0].cells)).toEqual(Object.keys(before[0].cells));
  await page
    .getByRole("button", { name: "다음 달로 이동", exact: true })
    .click();
  const january = page.locator(`[data-cell="${ids[0]}:2027-01-04"]`);
  await january.scrollIntoViewIfNeeded();
  await expect(january).toHaveCSS("border-bottom-style", "double");
  await expect(january).toHaveCSS("border-right-style", "double");
  await expect(january).toHaveCSS("font-size", "48px");
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  await expect(january).not.toHaveCSS("border-bottom-style", "double");
});

test("변경 이력 JSON은 축약 키와 사전 참조를 표시하고 다른 행 규칙을 반복하지 않는다", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  await save(page, () =>
    page.getByLabel("배경색", { exact: true }).fill("#ffe6dd"),
  );
  const result = await post(page, "/tasks", {
    teamId,
    year: 2026,
    copiedRow: {
      defaultStyle: {},
      cells: {
        title: { value: "축약 이력 확인", style: {} },
        "2026-10-19": { value: "착수", style: { backgroundColor: "#e5effc" } },
        "2026-11-02": { value: "검토", style: { backgroundColor: "#e5effc" } },
      },
    },
  });
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "변경 이력", exact: true });
  const entry = panel.locator("details").filter({ hasText: "축약 이력 확인" });
  await expect(entry).toHaveCount(1);
  await entry.locator("summary").click();
  const raw = await entry.locator("pre").innerText();
  const saved = JSON.parse(raw);
  expect(saved.$styles).toEqual([{ bg: "#e5effc" }]);
  expect(saved.$data.id).toBe(result.task.id);
  expect(saved.$data.cells["2026-10-19"]).toEqual({
    value: "착수",
    style: { $s: 0 },
    version: 1,
  });
  expect(saved.$data.cells["2026-11-02"].style).toEqual({ $s: 0 });
  expect(saved.$data.formatting).toBeUndefined();
  expect(raw).not.toContain("backgroundColor");
  expect(raw).not.toContain("#ffe6dd");
});
