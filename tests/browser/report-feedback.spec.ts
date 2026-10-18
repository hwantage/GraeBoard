import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, taskId: string;
async function get(page: Page, path: string) {
  return (await page.request.get(`/api${path}`)).json().then(unpack);
}
async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/api${path}`, { headers, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
const modal = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });
async function open(page: Page) {
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  const editor = modal(page).getByRole("textbox", {
    name: "업무 문서 리치 편집",
  });
  const start = modal(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(editor.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(
    modal(page).getByRole("textbox", { name: "업무 문서 리치 편집" }),
  ).toBeVisible();
}
async function source(page: Page) {
  await modal(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  return modal(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" });
}
async function close(page: Page) {
  await modal(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
}
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "사본 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "사본 만들기", exact: true });
  await dialog.getByLabel("사본 이름").fill(name);
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return (await get(page, `/reports?teamId=${teamId}`)).reports.find(
    (r: any) => r.name === name,
  ).id;
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
      name: `사본 검증 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskId = (
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "여러 문서 업무" },
    })
  ).task.id;
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});
test("빈 사본 문서는 작성 버튼으로 시작하고 원본의 빈 안내를 유지한다", async ({
  page,
}) => {
  const copy = await create(page, "빈 문서 사본");
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  const start = modal(page).getByRole("button", {
    name: "문서 작성",
    exact: true,
  });
  await expect(start).toBeVisible();
  await expect(
    modal(page).getByRole("group", { name: "문서 편집 모드" }),
  ).toHaveCount(0);
  await start.click();
  await (await source(page)).fill("사본에서 명시적으로 작성한 문서");
  await close(page);
  expect(
    (await get(page, `/reports/${copy}/tasks/${taskId}/documents/main`))
      .markdown,
  ).toBe("사본에서 명시적으로 작성한 문서");
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "",
  );
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await page
    .locator(`[data-cell="${taskId}:title"]`)
    .click({ button: "right" });
  await expect(start).toBeVisible();
});

test("문서 제목 탭 추가·이름 변경·빠른 전환과 사본별 독립 저장", async ({
  page,
}, info) => {
  await open(page);
  await (await source(page)).fill("# 최초 문서\n\n원본에서 기록");
  await modal(page)
    .getByRole("button", { name: "문서 추가", exact: true })
    .click();
  await expect(
    modal(page).getByRole("tab", { name: "문서 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await (await source(page)).fill("두 번째 본문");
  await modal(page)
    .getByRole("tab", { name: "문서 2", exact: true })
    .dblclick();
  await modal(page)
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .fill("검토 기록");
  await modal(page)
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .press("Enter");
  await modal(page).getByRole("tab", { name: "문서 1", exact: true }).click();
  await expect(
    modal(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toHaveValue("# 최초 문서\n\n원본에서 기록");
  await modal(page)
    .getByRole("tab", { name: "검토 기록", exact: true })
    .click();
  await expect(
    modal(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toHaveValue("두 번째 본문");
  await page.screenshot({
    path: info.outputPath("document-title-tabs.png"),
    fullPage: true,
  });
  await close(page);
  const copy = await create(page, "내 사본");
  await open(page);
  await modal(page)
    .getByRole("tab", { name: "검토 기록", exact: true })
    .click();
  await (await source(page)).fill("사본 안의 검토 기록");
  await modal(page)
    .getByRole("tab", { name: "검토 기록", exact: true })
    .press("F2");
  await modal(page)
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .fill("사본 검토 기록");
  // Closing immediately also commits the copy's title without changing the original.
  await close(page);
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await open(page);
  await modal(page)
    .getByRole("tab", { name: "검토 기록", exact: true })
    .click();
  await expect(await source(page)).toHaveValue("두 번째 본문");
  await modal(page)
    .getByRole("textbox", { name: "업무 문서 Markdown 원문" })
    .fill("새 원본 기록");
  await close(page);
  await page.getByRole("tab", { name: "내 사본", exact: true }).click();
  await open(page);
  await modal(page)
    .getByRole("tab", { name: "사본 검토 기록", exact: true })
    .click();
  await expect(await source(page)).toHaveValue("사본 안의 검토 기록");
  await expect(
    modal(page).getByText("문서 분기 정보", { exact: true }),
  ).toHaveCount(0);
  await modal(page)
    .getByRole("button", { name: "문서 추가", exact: true })
    .click();
  await expect(modal(page).getByRole("tab")).toHaveCount(3);
  await close(page);
  expect((await get(page, `/tasks/${taskId}/documents`)).documents.length).toBe(
    2,
  );
  expect(
    (await get(page, `/reports/${copy}/tasks/${taskId}/documents`)).documents
      .length,
  ).toBe(3);
});

test("하단 사본 탭의 생성·이름 변경·중복 방지·삭제와 좁은 화면", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await create(page, "기획 사본");
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await create(page, "검토 사본");
  await page
    .getByRole("button", { name: "검토 사본 메뉴", exact: true })
    .click();
  const anchor = (await page
    .getByRole("button", { name: "검토 사본 메뉴", exact: true })
    .boundingBox())!;
  const options = (await page
    .getByRole("menu", { name: "검토 사본 관리", exact: true })
    .boundingBox())!;
  expect(
    Math.abs(options.x + options.width - anchor.x - anchor.width),
  ).toBeLessThanOrEqual(2);
  expect(options.y + options.height).toBeLessThan(anchor.y);
  await page.getByRole("menuitem", { name: "이름 변경", exact: true }).click();
  const rename = page
    .locator(".sheet-tabs-bar")
    .getByRole("textbox", { name: "사본 이름", exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await rename.fill("가".repeat(51));
  await expect(rename).toHaveValue("가".repeat(50));
  await rename.fill("iii");
  const narrow = (await rename.boundingBox())!.width;
  expect(narrow).toBeLessThan(60);
  await rename.fill("WWW");
  expect((await rename.boundingBox())!.width).toBeGreaterThan(narrow + 15);
  await rename.fill("2026-10-16 사본 사본");
  await page.screenshot({
    path: info.outputPath("copy-name-width.png"),
    fullPage: true,
  });
  await rename.fill(" 기획 사본 ");
  await rename.press("Enter");
  await expect(page.getByRole("alert")).toContainText("같은 이름의 사본");
  await expect(rename).toHaveValue(" 기획 사본 ");
  await rename.fill("확정 사본");
  await rename.press("Enter");
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "확정 사본", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "확정 사본", exact: true }).dblclick();
  await expect(rename).toBeFocused();
  await rename.fill("취소할 이름");
  // Firefox's fill() commits composition, so begin the pending composition afterward.
  await rename.dispatchEvent("compositionstart");
  await rename.press("Enter");
  await expect(rename).toBeVisible();
  await rename.dispatchEvent("compositionend");
  await rename.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "확정 사본", exact: true }),
  ).toBeVisible();
  expect(
    (await get(page, `/reports?teamId=${teamId}`)).reports.map(
      (r: any) => r.name,
    ),
  ).toEqual(["확정 사본", "기획 사본"]);
  await page.screenshot({
    path: info.outputPath("mobile-copy-tabs.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "확정 사본 메뉴", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "사본 삭제", exact: true }).click();
  await page
    .getByRole("dialog", { name: "사본 삭제", exact: true })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "확정 사본", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "원본", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: "기획 사본", exact: true }),
  ).toBeVisible();
  await page.clock.setFixedTime(new Date("2026-10-10T12:00:00"));
  for (const name of [
    "2026-10-10의 사본",
    "2026-10-10의 사본 (2)",
    "2026-10-10의 사본 (3)",
  ]) {
    await page.getByRole("button", { name: "사본 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "사본 만들기",
      exact: true,
    });
    await expect(dialog.getByLabel("사본 이름")).toHaveValue(name);
    await dialog.getByRole("button", { name: "확인", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
});

test("원본 오른쪽의 추가 버튼·최신 사본 순서와 양 끝 스크롤 화살표를 유지한다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 520, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const left = page.getByRole("button", {
    name: "탭 왼쪽으로 스크롤",
    exact: true,
  });
  const right = page.getByRole("button", {
    name: "탭 오른쪽으로 스크롤",
    exact: true,
  });
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  const first = await create(page, "처음 사본");
  const report = await get(page, `/reports/${first}`);
  const names = ["처음 사본"];
  for (let i = 1; i <= 6; i++) {
    const name = `차례로 추가한 검토 사본 ${i}`;
    names.unshift(name);
    await post(page, "/reports", {
      teamId,
      year: 2026,
      name,
      sourceId: first,
      referenceDate: "2026-10-16",
      view: report.view,
      taskIds: [taskId],
    });
  }
  await page.reload();
  const bar = page.locator(".sheet-tabs-bar");
  const strip = bar.locator(".sheet-tabs");
  await expect(bar.getByRole("tab")).toHaveText(["원본", ...names]);
  await page.evaluate(() => document.fonts.ready);
  await expect(strip).toHaveCSS("overscroll-behavior-x", "contain");
  const pageUrl = page.url();
  await strip.hover();
  await page.mouse.wheel(250, 0);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.wheel(-500, 0);
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(page).toHaveURL(pageUrl);
  await expect(bar.getByRole("tab")).toHaveText(["원본", ...names]);
  const original = (await bar
    .getByRole("tab", { name: "원본", exact: true })
    .boundingBox())!;
  const add = (await bar
    .getByRole("button", { name: "사본 추가", exact: true })
    .boundingBox())!;
  const newest = (await bar
    .getByRole("tab", { name: names[0], exact: true })
    .boundingBox())!;
  expect(add.x).toBeGreaterThanOrEqual(original.x + original.width);
  expect(add.x + add.width).toBeLessThanOrEqual(newest.x);
  await expect(left).toBeDisabled();
  await expect(right).toBeEnabled();
  const controlX = (await left.boundingBox())!.x;
  for (let i = 0; i < 20; i++) {
    if (
      await strip.evaluate(
        (el) => el.scrollWidth - el.clientWidth - el.scrollLeft <= 1,
      )
    )
      break;
    const before = await strip.evaluate((el) => el.scrollLeft);
    await right.click();
    await expect
      .poll(() => strip.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(before);
  }
  await expect(right).toBeDisabled();
  await expect(left).toBeEnabled();
  await strip.hover();
  await page.mouse.wheel(500, 0);
  await expect(page).toHaveURL(pageUrl);
  expect((await left.boundingBox())!.x).toBe(controlX);
  expect(
    await strip.evaluate(
      (el) => el.scrollWidth - el.clientWidth - el.scrollLeft,
    ),
  ).toBeLessThanOrEqual(1);
  const lastMenu = bar.getByRole("button", {
    name: "처음 사본 메뉴",
    exact: true,
  });
  await lastMenu.click();
  const anchorBox = (await lastMenu.boundingBox())!;
  const menuBox = (await page
    .getByRole("menu", { name: "처음 사본 관리", exact: true })
    .boundingBox())!;
  expect(
    Math.abs(menuBox.x + menuBox.width - anchorBox.x - anchorBox.width),
  ).toBeLessThanOrEqual(2);
  await page.screenshot({
    path: info.outputPath("anchored-copy-menu.png"),
    fullPage: true,
  });
  for (let i = 0; i < 20; i++) {
    if (await strip.evaluate((el) => el.scrollLeft <= 1)) break;
    const before = await strip.evaluate((el) => el.scrollLeft);
    await left.click();
    await expect
      .poll(() => strip.evaluate((el) => el.scrollLeft))
      .toBeLessThan(before);
  }
  await expect(left).toBeDisabled();
  await expect(right).toBeEnabled();
  await expect(
    page.getByRole("menu", { name: "처음 사본 관리", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("copy-tab-scroll.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 2200, height: 844 });
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  await page.setViewportSize({ width: 520, height: 844 });
  await expect(right).toBeEnabled();

  await bar.getByRole("tab", { name: names[0], exact: true }).click();
  await expect(
    bar.getByRole("tab", { name: names[0], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    bar.getByRole("tab", { name: names[0], exact: true }),
  ).toBeEnabled();
  await bar.getByRole("tab", { name: names[0], exact: true }).press("F2");
  const rename = bar.getByRole("textbox", { name: "사본 이름", exact: true });
  await rename.fill("포커스 이동으로 저장");
  await rename.press("Tab");
  await expect(rename).toHaveCount(0);
  await expect(
    bar.getByRole("tab", { name: "포커스 이동으로 저장", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect((await get(page, `/reports?teamId=${teamId}`)).reports[0].name).toBe(
    "포커스 이동으로 저장",
  );
});

test("사본 기본 이름은 오늘 날짜와 괄호 번호를 쓰고 확인 버튼을 오른쪽에 배치한다", async ({
  page,
}, info) => {
  await page.clock.setFixedTime(new Date("2026-10-09T03:00:00Z"));
  for (const expected of [
    "2026-10-09의 사본",
    "2026-10-09의 사본 (2)",
    "2026-10-09의 사본 (3)",
  ]) {
    await page.getByRole("button", { name: "사본 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "사본 만들기",
      exact: true,
    });
    await expect(dialog.getByLabel("사본 이름")).toHaveValue(expected);
    await dialog.getByLabel("사본 이름").fill("가".repeat(51));
    await expect(dialog.getByLabel("사본 이름")).toHaveValue("가".repeat(50));
    await dialog.getByLabel("사본 이름").fill(expected);
    const cancel = (await dialog
      .getByRole("button", { name: "취소", exact: true })
      .boundingBox())!;
    const confirm = dialog.getByRole("button", { name: "확인", exact: true });
    const confirmBox = (await confirm.boundingBox())!;
    const inputBox = (await dialog.getByLabel("사본 이름").boundingBox())!;
    expect(confirmBox.x - cancel.x - cancel.width).toBeGreaterThanOrEqual(6);
    expect(
      Math.abs(confirmBox.x + confirmBox.width - inputBox.x - inputBox.width),
    ).toBeLessThanOrEqual(2);
    await expect(
      dialog.getByRole("button", { name: "만들기", exact: true }),
    ).toHaveCount(0);
    if (expected === "2026-10-09의 사본")
      await page.screenshot({
        path: info.outputPath("copy-create-dialog.png"),
        fullPage: true,
      });
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("tab", { name: expected, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  expect(
    (await get(page, `/reports?teamId=${teamId}`)).reports.map(
      (r: any) => r.name,
    ),
  ).toEqual([
    "2026-10-09의 사본 (3)",
    "2026-10-09의 사본 (2)",
    "2026-10-09의 사본",
  ]);
});

test("문서 삭제는 선택한 문서에만 적용하고 마지막 문서를 비운 뒤 다시 작성한다", async ({
  page,
}) => {
  await open(page);
  await (await source(page)).fill("기존 본문");
  await modal(page)
    .getByRole("button", { name: "문서 추가", exact: true })
    .click();
  await expect(
    modal(page).getByRole("tab", { name: "문서 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await (await source(page)).fill("남는 본문");
  await modal(page).getByRole("tab", { name: "문서 1", exact: true }).click();
  async function remove() {
    await modal(page)
      .getByRole("button", { name: "문서 메뉴", exact: true })
      .click();
    await modal(page)
      .getByRole("menuitem", { name: "문서 삭제", exact: true })
      .click();
    await modal(page)
      .getByRole("button", { name: "문서 삭제", exact: true })
      .click();
  }
  await remove();
  await expect(modal(page).getByRole("tab")).toHaveCount(1);
  await expect(
    modal(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" }),
  ).toHaveValue("남는 본문");
  await remove();
  await expect(
    modal(page).getByRole("tab", { name: "문서 1", exact: true }),
  ).toBeVisible();
  await (await source(page)).fill("새 시작");
  await close(page);
  await open(page);
  await expect(await source(page)).toHaveValue("새 시작");
});
