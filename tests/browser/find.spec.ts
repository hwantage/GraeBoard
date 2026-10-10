import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView } from "../../shared/domain.js";

const memoKey = `prop_${randomUUID()}`;
const headers = { "X-Requested-With": "WeeklyPlan" };
async function post(page: Page, path: string, data: any) {
  const response = await page.request.post(`/api${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
let teamId: string, ids: string[], userId: string;
test.beforeEach(async ({ page }) => {
  await post(page, "/auth/login", {
    username: "browser-test@example.com",
    password: "local-test-only-password",
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  userId = boot.user.id;
  teamId = (
    await post(page, "/admin/teams", {
      name: `찾기 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  const latest = await (await page.request.get("/api/bootstrap")).json();
  const settings = latest.teams.find(
    (team: any) => team.id === teamId,
  ).settings;
  const status = settings.properties.find(
    (property: any) => property.id === "status",
  ).values[0];
  status.label = "공통 상태";
  settings.properties.push({
    id: memoKey,
    name: "추가 메모",
    kind: "text",
    display: "text",
    visible: false,
    placement: "afterWeeks",
    values: [],
  });
  const changed = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers,
    data: settings,
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  ids = [];
  for (const [title, memo] of [
    ["공통 첫 작업", ""],
    ["둘째 업무", "공통 메모"],
    ["마지막 업무", "공통 메모"],
  ]) {
    const created = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title,
        owner: userId,
        status: ids.length ? "" : status.label,
        [memoKey]: memo,
      },
    });
    ids.push(created.task.id);
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${ids[0]}:title"]`)).toBeVisible();
});

test("전체 속성 찾기는 목록을 유지하고 셀 개수·이전/다음·숨겨진 열 이동을 제공한다", async ({
  page,
}, info) => {
  const input = page.getByLabel("전체 속성 검색", { exact: true });
  const count = page.locator(".search-count");
  const cell = (row: number, key: string) =>
    page.locator(`[data-cell="${ids[row]}:${key}"]`);
  await input.fill("공통");
  await expect(count).toHaveText("1 / 4");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
  await expect(cell(0, "title")).toHaveClass(/focused/);
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(count).toHaveText("2 / 4");
  await expect(cell(0, "status")).toHaveClass(/focused/);
  await page
    .getByRole("button", { name: "다음 검색 결과", exact: true })
    .click();
  await expect(count).toHaveText("3 / 4");
  await expect(cell(1, memoKey)).toHaveClass(/focused/);
  await expect(cell(1, memoKey)).toBeInViewport();
  expect(
    await page.getByRole("grid").evaluate((el) => el.scrollLeft),
  ).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "이전 검색 결과", exact: true })
    .click();
  await expect(count).toHaveText("2 / 4");
  await input.press("Shift+Enter");
  await expect(count).toHaveText("1 / 4");
  await input.press("Shift+Enter");
  await expect(count).toHaveText("4 / 4");
  await expect(cell(2, memoKey)).toHaveClass(/focused/);
  await input.press("Enter");
  await expect(count).toHaveText("1 / 4");
  await input.fill("지윤");
  await expect(count).toHaveText("1 / 3");
  await expect(cell(0, "owner")).toHaveClass(/focused/);
  await input.fill(userId);
  await expect(count).toHaveText("0 / 0");
  await expect(
    page.getByRole("button", { name: "다음 검색 결과", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await input.fill("공통");
  await expect(count).toHaveText("1 / 4");
  await page.screenshot({
    path: info.outputPath("find-all-properties.png"),
    fullPage: true,
  });
});

test("찾기는 화면 밖 숨긴 행·날짜 뒤 속성에 이동하고 수정·정렬 후 결과를 갱신한다", async ({
  page,
}) => {
  for (let i = 0; i < 70; i++) {
    const created = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: `행 ${String(i).padStart(3, "0")}`,
        owner: userId,
        [memoKey]: i === 69 ? "멀리찾기" : "",
      },
    });
    ids.push(created.task.id);
  }
  const targetId = ids.at(-1)!;
  const saved = await page.request.put("/api/views", {
    headers,
    data: {
      teamId,
      name: "__current",
      data: {
        ...defaultView(2026),
        hiddenRows: [targetId],
        groupBy: "owner",
        rowHeights: { [targetId]: 96 },
      },
    },
  });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  const input = page.getByLabel("전체 속성 검색", { exact: true });
  const target = page.locator(`[data-cell="${targetId}:${memoKey}"]`);
  await expect(target).toHaveCount(0);
  await input.fill("멀리찾기");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(target).toHaveClass(/focused/);
  await expect(target).toBeInViewport();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "74");
  const bounds = await target.evaluate((el) => {
    const cell = el.getBoundingClientRect();
    const grid = el.closest(".sheet-scroll")!.getBoundingClientRect();
    return {
      top: cell.top,
      bottom: cell.bottom,
      gridTop: grid.top,
      gridBottom: grid.bottom,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.gridTop + 32);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.gridBottom);
  await target.dblclick();
  await target.getByRole("textbox").fill("수정된 메모");
  await target.getByRole("textbox").press("Enter");
  await expect(page.locator(".search-count")).toHaveText("0 / 0");
  await input.fill("수정된 메모");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(target).toHaveClass(/focused/);
  await page.locator('[data-header-key="title"]').click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "내림차순 정렬", exact: true })
    .click();
  await page
    .getByRole("button", { name: "다음 검색 결과", exact: true })
    .click();
  await expect(target).toHaveClass(/focused/);
  await expect(target).toBeInViewport();
});

test("찾기는 한글 조합 중 이동하지 않고 최신 검색만 반영하며 새로고침 후 초기화한다", async ({
  page,
}) => {
  const input = page.getByLabel("전체 속성 검색", { exact: true });
  await input.dispatchEvent("compositionstart");
  await input.fill("공");
  await input.press("Enter");
  await expect(page.locator(".search-count")).toHaveText("검색 중");
  await expect(page.locator(".sheet-cell.focused")).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  await expect(page.locator(".search-count")).toHaveText("1 / 4");
  await input.fill("없는 검색어");
  await input.fill("마지막 업무");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(page.locator(`[data-cell="${ids[2]}:title"]`)).toHaveClass(
    /focused/,
  );
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
});

test("찾기는 컬럼 필터를 존중하고 긴 검색어와 결과 버튼이 좁은 화면에 맞는다", async ({
  page,
}, info) => {
  await page.locator('[data-header-key="title"]').click({ button: "right" });
  await page.getByRole("checkbox", { name: "둘째 업무", exact: true }).check();
  await page.keyboard.press("Escape");
  const input = page.getByLabel("전체 속성 검색", { exact: true });
  await input.fill("공통");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(page.locator(`[data-cell="${ids[1]}:${memoKey}"]`)).toHaveClass(
    /focused/,
  );
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "2");
  await page.setViewportSize({ width: 720, height: 900 });
  const before = (await page.locator(".search-box").boundingBox())!;
  await input.fill("아주 긴 검색어 ".repeat(100));
  await expect(page.locator(".search-count")).toHaveText("0 / 0");
  const after = (await page.locator(".search-box").boundingBox())!;
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(720);
  await page.getByRole("button", { name: "검색 지우기", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await page
    .locator(".view-bar")
    .screenshot({ path: info.outputPath("find-compact.png") });
});

test("검색 대상을 여러 속성으로 좁히고 선택한 셀 결과만 순환한다", async ({
  page,
}, info) => {
  const search = page.getByRole("search", { name: "속성 찾기" });
  const input = search.getByRole("textbox");
  const count = search.locator(".search-count");
  const toggle = search.getByRole("button", { name: "검색 대상 속성 선택" });
  const popup = page.getByRole("dialog", { name: "검색 대상 속성 선택" });
  await input.fill("공통");
  await expect(count).toHaveText("1 / 4");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  for (const name of ["전체 선택", "작업", "팀원", "상태", "추가 메모"])
    await expect(
      popup.getByRole("checkbox", { name, exact: true }),
    ).toBeChecked();
  const searchBox = (await search.boundingBox())!;
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
  await popup
    .getByRole("checkbox", { name: "전체 선택", exact: true })
    .uncheck();
  await expect(count).toHaveText("0 / 0");
  await expect(input).toHaveValue("공통");
  await expect(
    search.getByRole("button", { name: "다음 검색 결과" }),
  ).toBeDisabled();
  await expect(popup).toContainText("검색할 속성을 선택하세요.");
  await popup.getByRole("checkbox", { name: "작업", exact: true }).check();
  await expect(count).toHaveText("1 / 1");
  await expect(input).toHaveAttribute("placeholder", "작업 검색");
  await expect(page.locator(`[data-cell="${ids[0]}:title"]`)).toHaveClass(
    /focused/,
  );
  await popup.getByRole("checkbox", { name: "추가 메모", exact: true }).check();
  await expect(count).toHaveText("1 / 3");
  await expect(
    popup.getByRole("checkbox", { name: "전체 선택", exact: true }),
  ).toBeChecked({ indeterminate: true });
  await page.screenshot({
    path: info.outputPath("find-selected-properties.png"),
  });
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(input).toHaveValue("공통");
  await search.getByRole("button", { name: "다음 검색 결과" }).click();
  await expect(count).toHaveText("2 / 3");
  await expect(page.locator(`[data-cell="${ids[1]}:${memoKey}"]`)).toHaveClass(
    /focused/,
  );
  await search.getByRole("button", { name: "다음 검색 결과" }).click();
  await expect(count).toHaveText("3 / 3");
  await expect(page.locator(`[data-cell="${ids[2]}:${memoKey}"]`)).toHaveClass(
    /focused/,
  );
  await input.press("Enter");
  await expect(count).toHaveText("1 / 3");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
  await input.fill("지윤");
  await expect(count).toHaveText("0 / 0");
  await toggle.click();
  await popup.getByRole("checkbox", { name: "팀원", exact: true }).check();
  await expect(count).toHaveText("1 / 3");
  await expect(page.locator(`[data-cell="${ids[0]}:owner"]`)).toHaveClass(
    /focused/,
  );
  await popup.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await expect(input).toHaveAttribute("placeholder", "전체 속성 검색");
  await input.fill("공통");
  await expect(popup).toHaveCount(0);
  await expect(count).toHaveText("1 / 4");
});

test("검색 대상은 빠른 변경·키보드 선택을 반영하고 검색어를 지워도 유지한다", async ({
  page,
}, info) => {
  const search = page.getByRole("search", { name: "속성 찾기" });
  const input = search.getByRole("textbox");
  const toggle = search.getByRole("button", { name: "검색 대상 속성 선택" });
  const popup = page.getByRole("dialog", { name: "검색 대상 속성 선택" });
  await input.fill("공통");
  await expect(search.locator(".search-count")).toHaveText("1 / 4");
  await toggle.focus();
  await toggle.press("ArrowDown");
  const all = popup.getByRole("checkbox", { name: "전체 선택", exact: true });
  await expect(all).toBeFocused();
  await all.press("Space");
  await popup.getByRole("checkbox", { name: "상태", exact: true }).check();
  await popup.getByRole("checkbox", { name: "추가 메모", exact: true }).check();
  await popup.getByRole("checkbox", { name: "상태", exact: true }).uncheck();
  await expect(search.locator(".search-count")).toHaveText("1 / 2");
  await expect(page.locator(`[data-cell="${ids[1]}:${memoKey}"]`)).toHaveClass(
    /focused/,
  );
  await page.keyboard.press("Escape");
  await search.getByRole("button", { name: "검색 지우기" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "추가 메모 검색");
  await input.fill("공통");
  await expect(search.locator(".search-count")).toHaveText("1 / 2");
  await page.setViewportSize({ width: 720, height: 420 });
  await toggle.click();
  await expect(
    popup.getByRole("checkbox", { name: "추가 메모", exact: true }),
  ).toBeChecked();
  await expect(
    popup.getByRole("checkbox", { name: "작업", exact: true }),
  ).not.toBeChecked();
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(720);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(420);
  await page.screenshot({ path: info.outputPath("find-scope-compact.png") });
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "전체 속성 검색");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(all).toBeChecked();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "전체 속성 검색");
});
