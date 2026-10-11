import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { THEMES } from "../../shared/themes.js";
import { defaultView, weeksForYear } from "../../shared/domain.js";

async function selectFormat(control: Locator, value: string) {
  const trigger = control.and(control.page().getByRole("combobox"));
  await trigger.click();
  const id = await trigger.getAttribute("aria-controls");
  await Promise.all([
    control
      .page()
      .waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    control
      .page()
      .locator(`[id="${id}"] [role="option"][data-value="${value}"]`)
      .click(),
  ]);
  await expect(trigger).toHaveAttribute("data-value", value);
  await expect(trigger).toBeEnabled();
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

async function post(page: Page, path: string, data: any) {
  const r = await page.request.post("/api" + path, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function sortHeader(
  page: Page,
  label: string,
  direction = "오름차순 정렬",
) {
  await page
    .getByRole("button", { name: `${label} 열 선택`, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: direction, exact: true }).click();
}
async function dragSelection(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!,
    b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}
async function openRowDetails(page: Page, row: Locator) {
  await row.locator(".row-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "업무 상세", exact: true }).click();
}
async function hideSelectedRows(page: Page) {
  const ids = await page
    .locator('.sheet-cell[aria-selected="true"]')
    .evaluateAll((nodes) => [
      ...new Set(
        nodes.map((node) => node.getAttribute("data-task-id")).filter(Boolean),
      ),
    ]);
  expect(ids.length).toBeGreaterThan(0);
  for (const [index, id] of ids.entries())
    await page
      .locator(`[data-row-id="${id}"] .row-select`)
      .click({ modifiers: index ? ["Meta"] : [] });
  await page
    .locator(`[data-row-id="${ids[0]}"] .row-select`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
}
let teamId: string, taskIds: string[];
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
  const name = "검증 " + randomUUID().slice(0, 8);
  teamId = (
    await post(page, "/admin/teams", {
      name,
      templateTeamId: boot.teams.find((t: any) => t.name === "UX기획팀 · 예시")
        .id,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["첫 업무", "숨길 업무", "셋째 업무"]) {
    const r = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title, owner: boot.user.id, category: "category-ux" },
    });
    taskIds.push(r.task.id);
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(
    page.getByRole("gridcell", { name: "첫 업무", exact: true }),
  ).toBeVisible();
});

async function chooseWeeks(page: Page, from: string, to = from) {
  await dragSelection(
    page,
    page.locator(`[data-week="${from}"]`),
    page.locator(`[data-week="${to}"]`),
  );
}
async function chooseMonths(page: Page, from: number, to = from) {
  await dragSelection(
    page,
    page.getByRole("button", { name: `${from}월 전체`, exact: true }),
    page.getByRole("button", { name: `${to}월 전체`, exact: true }),
  );
}
async function chooseYear(page: Page, target: number) {
  const year = page.locator(".year-value");
  await expect(year).toBeEnabled();
  let current = Number(await year.innerText());
  while (current !== target) {
    const direction = current < target ? 1 : -1;
    await page
      .getByRole("button", {
        name: direction === 1 ? "다음 연도" : "이전 연도",
        exact: true,
      })
      .click();
    current += direction;
    await expect(year).toHaveText(String(current));
    await expect(year).toBeEnabled();
  }
}
async function groupByColumn(page: Page, key: string) {
  await page.locator(`[data-header-key="${key}"]`).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true })
    .click();
}
async function expectGroupedBy(page: Page, key: string) {
  await page.locator(`[data-header-key="${key}"]`).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "묶음 해제", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
}
async function marchWeeks(page: Page) {
  await chooseWeeks(page, "2026-03-02", "2026-03-16");
}
async function freezeColumns(page: Page, count: number) {
  await page
    .locator("[data-header-key]")
    .nth(Math.max(0, count - 1))
    .click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: count ? "여기까지 열 고정" : "열 고정 해제",
      exact: true,
    })
    .click();
}
async function setColumns(page: Page, show: string[], hide: string[] = []) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  for (const label of show)
    await page.getByLabel(`${label} 열 표시`, { exact: true }).check();
  for (const label of hide)
    await page.getByLabel(`${label} 열 표시`, { exact: true }).uncheck();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
}
async function openDefaultStyle(page: Page) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "기본 서식", exact: true }).click();
}
async function saveDefaultStyle(page: Page) {
  await page
    .getByRole("button", { name: "기본 서식 저장", exact: true })
    .click();
  await expect(
    page.getByText("기본 서식을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
}
async function setDensity(page: Page, value: string) {
  await openDefaultStyle(page);
  await page.getByLabel("셀 높이", { exact: true }).selectOption(value);
  await saveDefaultStyle(page);
}
async function selectDefaultFormat(page: Page, label: string, value: string) {
  const trigger = page
    .getByRole("dialog", { name: "설정" })
    .getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  const id = await trigger.getAttribute("aria-controls");
  await page
    .locator(`[id="${id}"] [role="option"][data-value="${value}"]`)
    .click();
  await expect(trigger).toHaveAttribute("data-value", value);
}

async function applyBorders(
  page: Page,
  preset: string,
  style?: string,
  color?: string,
) {
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  if (style)
    await page
      .getByLabel("테두리 선 스타일", { exact: true })
      .selectOption(style);
  if (color)
    await page.getByLabel("테두리 선 색상", { exact: true }).fill(color);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: preset, exact: true }).click(),
  ]);
  await expect(
    page.getByRole("dialog", { name: "선택 영역 테두리" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "테두리", exact: true }),
  ).toBeEnabled();
}

test("콤팩트 기간 표는 월·주 드래그와 역방향·키보드·취소·연도 경계를 처리한다", async ({
  page,
}, info) => {
  const picker = page.getByRole("group", { name: "월·주차 기간 선택" });
  const headers = () =>
    page
      .locator(".week-heading")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-header-key")),
      );
  const expected = (from: string, to: string) =>
    weeksForYear(2026)
      .filter((w) => w.key >= from && w.key <= to)
      .map((w) => w.key);
  await expect(
    page.locator(".sidebar,.workspace-footer,.sheet-footer"),
  ).toHaveCount(0);
  await expect(page.getByText("보기 설정은 나에게만 적용됩니다.")).toHaveCount(
    0,
  );
  await expect(picker.locator(".period-month")).toHaveText(
    Array.from({ length: 12 }, (_, i) => `${i + 1}월`),
  );
  const weekButtons = picker.locator(".period-week");
  await expect(weekButtons).toHaveCount(53);
  expect((await picker.boundingBox())!.height).toBeLessThanOrEqual(45);
  expect((await page.getByRole("grid").boundingBox())!.y).toBeLessThan(200);
  for (let month = 1; month <= 12; month++) {
    const count = weeksForYear(2026).filter((w) => w.month === month).length;
    expect([4, 5]).toContain(count);
    await expect(
      picker.getByRole("button", { name: new RegExp(`^${month}월 [1-5]주$`) }),
    ).toHaveText(Array.from({ length: count }, (_, i) => String(i + 1)));
  }
  await chooseMonths(page, 6, 3);
  await expect(picker.locator('.period-month[aria-pressed="true"]')).toHaveText(
    ["3월", "4월", "5월", "6월"],
  );
  await expect.poll(headers).toEqual(
    weeksForYear(2026)
      .filter((w) => w.month >= 3 && w.month <= 6)
      .map((w) => w.key),
  );
  await chooseWeeks(page, "2026-04-06", "2026-03-16");
  await expect.poll(headers).toEqual(expected("2026-03-16", "2026-04-06"));
  await expect(
    picker.getByRole("button", { name: "3월 전체", exact: true }),
  ).toHaveAttribute("aria-pressed", "mixed");
  const a = (await picker
    .getByRole("button", { name: "7월 전체", exact: true })
    .boundingBox())!;
  const b = (await picker
    .getByRole("button", { name: "9월 전체", exact: true })
    .boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(picker.locator('.period-month[aria-pressed="true"]')).toHaveText(
    ["7월", "8월", "9월"],
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(headers).toEqual(expected("2026-03-16", "2026-04-06"));
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      const view = data.views.find((v: any) => v.name === "__current")?.data;
      return [view?.fromWeek, view?.toWeek];
    })
    .toEqual(["2026-03-16", "2026-04-06"]);
  await page.reload();
  await expect.poll(headers).toEqual(expected("2026-03-16", "2026-04-06"));
  await picker.getByRole("button", { name: "1월 전체", exact: true }).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect.poll(headers).toHaveLength(53);
  await weekButtons.first().focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(headers).toEqual(["2025-12-29", "2026-01-05"]);
  await page.screenshot({
    path: info.outputPath("compact-period-picker.png"),
    fullPage: true,
  });
  for (const year of [2025, 2026, 2027]) {
    await chooseYear(page, year);
    await chooseMonths(page, 12, 1);
    await expect.poll(headers).toEqual(weeksForYear(year).map((w) => w.key));
  }
  await post(page, "/tasks", {
    teamId,
    year: 2012,
    fields: { title: "연말 경계 확인" },
  });
  await page.reload();
  await chooseYear(page, 2012);
  await expect(weekButtons).toHaveCount(54);
  await chooseMonths(page, 12);
  await expect.poll(headers).toEqual(
    weeksForYear(2012)
      .filter((w) => w.month === 12)
      .map((w) => w.key),
  );
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(picker).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(720);
});

test("기간 밖 주차도 숨김 화살표로 펼치고 수동 숨김과 달력 표시를 함께 유지한다", async ({
  page,
}, info) => {
  const allWeeks = weeksForYear(2026).map((week) => week.key);
  const header = (key: string) => page.locator(`[data-header-key="${key}"]`);
  const reveal = (key: string) =>
    page.locator(`.hidden-column-reveal[data-hidden-columns~="${key}"]`);
  const shownWeeks = () =>
    page
      .locator(".week-heading")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-header-key")),
      );
  const selectedWeeks = () =>
    page
      .locator('.period-week[aria-pressed="true"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-week")),
      );
  const hide = async (key: string) => {
    await header(key).click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "열 숨기기", exact: true })
      .click();
    await expect(header(key)).toHaveCount(0);
  };
  // 날짜 범위를 바꾸거나 펼칠 때 속성 필터와 별도로 숨긴 행·열은 유지한다.
  await header("category").click({ button: "right" });
  await page.getByRole("checkbox", { name: "UX 개선", exact: true }).check();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click();
  await hideSelectedRows(page);
  await hide("owner");
  await chooseMonths(page, 3, 4);
  await expect(reveal("2025-12-29")).toHaveCount(1);
  await expect(reveal("2026-12-28")).toHaveCount(1);
  await hide("2026-03-16");
  await expect(page.locator('[data-week="2026-03-16"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "3월 전체", exact: true }),
  ).toHaveAttribute("aria-pressed", "mixed");
  await reveal("2025-12-29").click();
  const expanded = weeksForYear(2026)
    .filter((week) => week.month <= 4 && week.key !== "2026-03-16")
    .map((week) => week.key);
  await expect.poll(shownWeeks).toEqual(expanded);
  await expect.poll(selectedWeeks).toEqual(expanded);
  await expect(reveal("2026-03-16")).toHaveCount(1);
  await expect(reveal("2026-12-28")).toHaveCount(1);
  await expect(header("owner")).toHaveCount(0);
  await expect(page.locator(`[data-row-id="${taskIds[1]}"]`)).toHaveCount(0);
  await expect
    .poll(async () => {
      const { views } = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      const current = views.find(
        (view: any) => view.name === "__current",
      )?.data;
      return {
        hiddenWeeks: current?.hiddenWeeks,
        filters: current?.propertyFilters,
      };
    })
    .toEqual({
      hiddenWeeks: allWeeks.filter((key) => !expanded.includes(key)),
      filters: { category: ["category-ux"] },
    });
  await page.reload();
  await expect.poll(shownWeeks).toEqual(expanded);
  await expect.poll(selectedWeeks).toEqual(expanded);
  await reveal("2026-12-28").click();
  await expect
    .poll(shownWeeks)
    .toEqual(allWeeks.filter((key) => key !== "2026-03-16"));
  await reveal("2026-03-16").click();
  await expect.poll(shownWeeks).toEqual(allWeeks);
  await expect.poll(selectedWeeks).toEqual(allWeeks);
  await expect(
    page.getByRole("button", { name: "2026년 전체 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // 주차 드래그로 다시 좁힌 뒤에도 앞·뒤를 각각 복원할 수 있다.
  await chooseWeeks(page, "2026-03-16", "2026-04-06");
  await expect
    .poll(selectedWeeks)
    .toEqual(
      allWeeks.filter((key) => key >= "2026-03-16" && key <= "2026-04-06"),
    );
  await expect(reveal("2025-12-29")).toHaveCount(1);
  await expect(reveal("2026-12-28")).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("period-hidden-column-arrows.png"),
    fullPage: true,
  });
  await reveal("2025-12-29").click();
  await expect
    .poll(shownWeeks)
    .toEqual(allWeeks.filter((key) => key <= "2026-04-06"));
  await expect(header("owner")).toHaveCount(0);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "셋째 업무",
  ]);
});

test("연도 숫자로 연간 전체를 선택하고 업무 필터를 유지하며 저장한다", async ({
  page,
}) => {
  const control = page.getByRole("group", { name: "연도 선택", exact: true });
  const year = control.getByRole("button", { name: "2026년 전체 선택" });
  const allWeeks = weeksForYear(2026).map((w) => w.key);
  const headers = () =>
    page
      .locator(".week-heading")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-header-key")),
      );
  await expect(control.getByRole("combobox")).toHaveCount(0);
  await chooseMonths(page, 5, 7);
  await page.getByLabel("전체 속성 검색").fill("첫 업무");
  await expect(year).toHaveAttribute("aria-pressed", "false");
  await year.click();
  await expect.poll(headers).toEqual(allWeeks);
  await expect(year).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.period-month[aria-pressed="true"]')).toHaveCount(
    12,
  );
  await expect(page.getByLabel("전체 속성 검색")).toHaveValue("첫 업무");
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await chooseWeeks(page, "2026-03-16", "2026-04-06");
  await expect(year).toHaveAttribute("aria-pressed", "false");
  await year.focus();
  await page.keyboard.press("Enter");
  await expect.poll(headers).toEqual(allWeeks);
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      const view = data.views.find((v: any) => v.name === "__current")?.data;
      return [view?.fromMonth, view?.toMonth, view?.fromWeek, view?.toWeek];
    })
    .toEqual([1, 12, "", ""]);
  await page.reload();
  await expect.poll(headers).toEqual(allWeeks);
  await expect(year).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("전체 속성 검색")).toHaveValue("");
  await chooseWeeks(page, allWeeks[0], allWeeks[allWeeks.length - 1]);
  await expect(year).toHaveAttribute("aria-pressed", "true");
});

test("기간 선택은 바깥 테두리에서 시작하고 표 밖에서 놓아도 적용된다", async ({
  page,
}) => {
  const picker = page.locator(".period-grid");
  for (const unit of ["week", "month"] as const) {
    const cells = picker.locator(`[data-period-unit="${unit}"]`);
    const from = unit === "week" ? 7 : 8;
    const to = unit === "week" ? 12 : 2;
    const a = (await cells.nth(from).boundingBox())!;
    const b = (await cells.nth(to).boundingBox())!;
    const box = (await picker.boundingBox())!;
    await page.mouse.move(
      a.x + a.width / 2,
      unit === "week" ? box.y + box.height - 0.1 : box.y + 0.1,
    );
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, box.y + box.height + 12);
    await page.mouse.up();
    const selected = weeksForYear(2026).filter((week, index) =>
      unit === "week"
        ? index >= from && index <= to
        : week.month >= to + 1 && week.month <= from + 1,
    );
    await expect(
      picker.locator('.period-week[aria-pressed="true"]'),
    ).toHaveCount(selected.length);
    await expect
      .poll(() =>
        page
          .locator(".week-heading")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-header-key")),
          ),
      )
      .toEqual(selected.map((week) => week.key));
  }
});

test("기간 선택은 포인터 캡처가 풀려도 미리 본 범위를 확정하고 반복할 수 있다", async ({
  page,
}) => {
  const picker = page.locator(".period-grid");
  for (let attempt = 0; attempt < 8; attempt++) {
    const unit = attempt % 2 ? "week" : "month";
    const from = attempt % 2 ? 20 : 2;
    const to = attempt % 2 ? 8 + attempt : 4 + attempt;
    const cells = picker.locator(`[data-period-unit="${unit}"]`);
    const a = (await cells.nth(from).boundingBox())!;
    const b = (await cells.nth(to).boundingBox())!;
    const box = (await picker.boundingBox())!;
    await picker.evaluate((el) => {
      el.addEventListener(
        "pointerdown",
        (event) => {
          el.setAttribute(
            "data-test-pointer",
            String((event as PointerEvent).pointerId),
          );
        },
        { once: true },
      );
    });
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect(
      cells.and(picker.locator('[aria-pressed="true"]')),
    ).toHaveCount(Math.abs(from - to) + 1);
    const preview = await picker
      .locator('.period-week[aria-pressed="true"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-week")));
    await picker.evaluate((el) =>
      el.releasePointerCapture(Number(el.getAttribute("data-test-pointer"))),
    );
    await page.mouse.move(b.x + b.width / 2, box.y + box.height + 12);
    await page.mouse.up();
    await expect
      .poll(() =>
        page
          .locator(".week-heading")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-header-key")),
          ),
      )
      .toEqual(preview);
    await expect(picker).not.toHaveClass(/is-dragging/);
  }
});

test("기간 선택은 마지막 이동 이벤트가 없어도 놓은 위치까지 반영한다", async ({
  page,
}) => {
  const picker = page.locator(".period-grid");
  for (const unit of ["month", "week"] as const) {
    const cells = picker.locator(`[data-period-unit="${unit}"]`);
    const a = (await cells.nth(2).boundingBox())!;
    const b = (await cells.nth(4).boundingBox())!;
    const end = (await cells.nth(7).boundingBox())!;
    await picker.evaluate((el) => {
      el.addEventListener(
        "pointerdown",
        (event) => {
          el.setAttribute(
            "data-test-pointer",
            String((event as PointerEvent).pointerId),
          );
        },
        { once: true },
      );
    });
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    // Model a release whose final coordinates were not sent in a pointermove.
    await picker.dispatchEvent("pointerup", {
      pointerId: Number(await picker.getAttribute("data-test-pointer")),
      clientX: end.x + end.width / 2,
      clientY: end.y + end.height / 2,
      button: 0,
      buttons: 0,
    });
    await page.mouse.up();
    const selected = weeksForYear(2026).filter((week, index) =>
      unit === "month"
        ? week.month >= 3 && week.month <= 8
        : index >= 2 && index <= 7,
    );
    await expect
      .poll(() =>
        page
          .locator(".week-heading")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-header-key")),
          ),
      )
      .toEqual(selected.map((week) => week.key));
  }
});

test("기간 드래그는 버튼 해제 이동이 먼저 와도 5~7월에서 4~6월로 확정한다", async ({
  page,
}) => {
  const picker = page.locator(".period-grid");
  const selectedMonths = picker.locator('.period-month[aria-pressed="true"]');
  for (let attempt = 0; attempt < 6; attempt++) {
    await chooseMonths(page, 5, 7);
    await expect(selectedMonths).toHaveText(["5월", "6월", "7월"]);
    await picker.evaluate((el) => {
      el.addEventListener(
        "pointerdown",
        (event) => {
          el.setAttribute(
            "data-test-pointer",
            String((event as PointerEvent).pointerId),
          );
        },
        { once: true },
      );
    });
    if (attempt % 2) {
      // Also cover a missing pointerup, followed by ordinary hovering.
      await page.evaluate(() => {
        window.addEventListener(
          "pointerup",
          (event) => event.stopImmediatePropagation(),
          {
            once: true,
            capture: true,
          },
        );
      });
    }
    const start = (await picker.locator('[data-month="4"]').boundingBox())!;
    const end = (await picker.locator('[data-month="6"]').boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
    await expect(selectedMonths).toHaveText(["4월", "5월", "6월"]);
    if (!(attempt % 2)) {
      // Brave can emit buttons=0 in pointermove before delivering pointerup.
      await picker.dispatchEvent("pointermove", {
        pointerId: Number(await picker.getAttribute("data-test-pointer")),
        buttons: 0,
        clientX: start.x,
        clientY: start.y + start.height + 50,
      });
    }
    await page.mouse.up();
    await page.mouse.move(start.x, start.y + start.height + 50);
    await expect(picker).not.toHaveClass(/is-dragging/);
    await expect(selectedMonths).toHaveText(["4월", "5월", "6월"]);
    await expect
      .poll(() =>
        page
          .locator(".week-heading")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-header-key")),
          ),
      )
      .toEqual(
        weeksForYear(2026)
          .filter((w) => w.month >= 4 && w.month <= 6)
          .map((w) => w.key),
      );
  }
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      const saved = data.views.find(
        (view: any) => view.name === "__current",
      )?.data;
      return [saved?.fromMonth, saved?.toMonth];
    })
    .toEqual([4, 6]);
  await page.reload();
  await expect(selectedMonths).toHaveText(["4월", "5월", "6월"]);
  await chooseMonths(page, 5, 7);
  await expect(selectedMonths).toHaveText(["5월", "6월", "7월"]);
});

test("기본 서식 공통 툴바는 미리보기·실행취소·테두리와 직접 지정한 행 높이를 보존한다", async ({
  page,
}, info) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const handle = (await page.locator('[data-resize-row="0"]').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 1);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 61);
  await page.mouse.up();
  const manualHeight = (await first.boundingBox())!.height;
  await openDefaultStyle(page);
  const panel = page.getByRole("dialog", {
    name: "설정",
    exact: true,
  });
  const preview = page.locator(".preview-cell").first();
  await selectDefaultFormat(page, "글자 크기", "16");
  await panel.getByRole("button", { name: "굵게", exact: true }).click();
  await panel.getByLabel("배경색", { exact: true }).fill("#fff4aa");
  await expect(preview).toHaveCSS("background-color", "rgb(255, 244, 170)");
  await panel.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(preview).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await panel.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(preview).toHaveCSS("background-color", "rgb(255, 244, 170)");
  await panel.getByRole("button", { name: "테두리", exact: true }).click();
  await page
    .getByLabel("테두리 선 스타일", { exact: true })
    .selectOption("double");
  await page.getByLabel("테두리 선 색상", { exact: true }).fill("#2255aa");
  await page.getByRole("button", { name: "모든 테두리", exact: true }).click();
  await expect(preview).toHaveCSS("border-bottom-style", "double");
  await panel.getByRole("button", { name: "테두리", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "선택 영역 테두리", exact: true }),
  ).toHaveCount(0);
  await expect(panel).toBeVisible();
  await panel.getByLabel("셀 높이", { exact: true }).selectOption("dense");
  expect(
    await preview.evaluate((el) => {
      const cell = el.getBoundingClientRect();
      const text = el.querySelector("span")!.getBoundingClientRect();
      return text.top >= cell.top && text.bottom <= cell.bottom;
    }),
  ).toBeTruthy();
  await page.screenshot({
    path: info.outputPath("shared-default-toolbar.png"),
    fullPage: true,
  });
  await saveDefaultStyle(page);
  await expect(first).not.toHaveCSS("font-weight", "700");
  expect((await first.boundingBox())!.height).toBe(manualHeight);
  await expect(page.locator(".sheet-scroll")).toHaveAttribute(
    "data-density",
    "dense",
  );
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("기본 서식 확인");
  await page
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .press("Enter");
  const added = page.locator('[data-column="title"]').last();
  await expect(added).toHaveCSS("font-weight", "700");
  await expect(added).toHaveCSS("background-color", "rgb(255, 244, 170)");
  await expect(added).toHaveCSS("border-bottom-color", "rgb(34, 85, 170)");
  await page.reload();
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.height).toBe(manualHeight);
  await openDefaultStyle(page);
  await expect(panel.getByLabel("글자 크기", { exact: true })).toHaveAttribute(
    "data-value",
    "16",
  );
  await expect(panel.getByLabel("셀 높이", { exact: true })).toHaveValue(
    "dense",
  );
});

test("주차 머리글 색은 속성에서 저장하고 날짜 머리글에만 적용하며 선택 강조를 유지한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.locator(".week-column-select").click();
  await expect(page.getByText("왼쪽 경계선", { exact: false })).toHaveCount(0);
  await page.getByLabel("주차 머리글 배경색", { exact: true }).fill("#2255aa");
  await page.getByLabel("주차 머리글 글자색", { exact: true }).fill("#ffffff");
  await expect(page.locator(".week-header-preview")).toHaveCSS(
    "background-color",
    "rgb(34, 85, 170)",
  );
  await page.screenshot({
    path: info.outputPath("week-header-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const week = page.locator('[data-header-key="2026-03-09"]');
  await expect(week).toHaveCSS("background-color", "rgb(34, 85, 170)");
  await expect(week).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(page.locator('[data-header-key="title"]')).not.toHaveCSS(
    "background-color",
    "rgb(34, 85, 170)",
  );
  await week.getByRole("button").click();
  await expect(week).toHaveAttribute("aria-selected", "true");
  await expect(week).not.toHaveCSS("background-color", "rgb(34, 85, 170)");
  await page.reload();
  await expect(page.locator('[data-header-key="2026-03-16"]')).toHaveCSS(
    "background-color",
    "rgb(34, 85, 170)",
  );
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.locator(".week-column-select").click();
  await page.getByRole("button", { name: "기본값", exact: true }).click();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-header-key="2026-03-16"]')).toHaveCSS(
    "background-color",
    "rgb(247, 249, 249)",
  );
});

test("왼쪽·오른쪽·안쪽 테두리는 선택 영역의 해당 경계에만 적용한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  await dragSelection(page, at(0, "2026-03-02"), at(1, "2026-03-09"));
  await applyBorders(page, "왼쪽 테두리", "thick", "#9a2233");
  for (const row of [0, 1]) {
    await expect(at(row, "2026-03-02")).toHaveCSS("border-left-width", "3px");
    await expect(at(row, "2026-03-09")).toHaveCSS("border-left-style", "none");
  }
  await applyBorders(page, "오른쪽 테두리", "dashed", "#336699");
  for (const row of [0, 1]) {
    await expect(at(row, "2026-03-09")).toHaveCSS(
      "border-right-style",
      "dashed",
    );
    await expect(at(row, "2026-03-02")).toHaveCSS(
      "border-right-color",
      "rgb(231, 237, 237)",
    );
  }
  await applyBorders(page, "가로 안쪽 테두리", "double", "#2255aa");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-bottom-style", "double");
  await expect(at(1, "2026-03-02")).toHaveCSS("border-top-style", "none");
  await expect(at(1, "2026-03-02")).toHaveCSS("border-bottom-style", "solid");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-right-style", "solid");
  await expect(at(0, "2026-03-02")).toHaveCSS(
    "border-right-color",
    "rgb(231, 237, 237)",
  );
  await page.screenshot({
    path: info.outputPath("side-borders.png"),
    fullPage: true,
  });
  await applyBorders(page, "테두리 지우기");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-left-style", "none");
  await expect(at(0, "2026-03-02")).toHaveCSS(
    "border-bottom-color",
    "rgb(231, 237, 237)",
  );
  await expect(at(1, "2026-03-09")).toHaveCSS(
    "border-right-color",
    "rgb(231, 237, 237)",
  );
});

test("기본 테두리 지우기는 새로고침·실행취소·복사 후에도 기본 격자선을 유지한다", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const settings = boot.teams.find((t: any) => t.id === teamId).settings;
  const line = { style: "thick", color: "#dd2244" };
  const saved = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      ...settings,
      defaultStyle: {
        ...settings.defaultStyle,
        borderTop: line,
        borderRight: line,
        borderBottom: line,
        borderLeft: line,
      },
    },
  });
  expect(saved.ok()).toBeTruthy();
  const ids = [];
  for (const title of ["기본선 A", "기본선 B", "기본선 C"])
    ids.push(
      (await post(page, "/tasks", { teamId, year: 2026, fields: { title } }))
        .task.id,
    );
  await page.reload();
  const at = (row: number, key = "title") =>
    page.locator(`[data-cell="${ids[row]}:${key}"]`);
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  async function expectGrid(target: Locator) {
    await expect(target).toHaveCSS("border-top-width", "0px");
    await expect(target).toHaveCSS("border-left-width", "0px");
    await expect(target).toHaveCSS("border-right-width", "1px");
    await expect(target).toHaveCSS("border-bottom-width", "1px");
    await expect(target).toHaveCSS("border-right-color", "rgb(231, 237, 237)");
    await expect(target).toHaveCSS("border-bottom-color", "rgb(231, 237, 237)");
  }
  await expect(at(0)).toHaveCSS("border-top-width", "3px");
  await at(0).click();
  await applyBorders(page, "테두리 지우기");
  await expectGrid(at(0));
  await toolbar.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(at(0)).toHaveCSS("border-top-width", "3px");
  await toolbar.getByRole("button", { name: "재실행", exact: true }).click();
  await expectGrid(at(0));
  await page.reload();
  await expectGrid(at(0));
  await at(0).click();
  const copied = await copyContents(page);
  // 앱 클립보드와 HTML만 지원하는 복사 버튼 경로 모두 상속을 차단한다.
  for (const [row, contents] of [
    [1, copied],
    [2, { "text/html": copied["text/html"] }],
  ] as const) {
    await at(row).click();
    await pasteContents(page, contents);
    await expect(at(row)).toHaveText("기본선 A");
    await expectGrid(at(row));
  }
  // 여러 셀의 안쪽 경계도 기본 서식의 위·왼쪽 선을 다시 상속하지 않는다.
  await marchWeeks(page);
  await dragSelection(page, at(0, "2026-03-02"), at(1, "2026-03-09"));
  await applyBorders(page, "모든 테두리", "medium", "#336699");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-top-width", "2px");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-right-width", "2px");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-bottom-width", "2px");
  await expect(at(1, "2026-03-09")).toHaveCSS("border-top-width", "0px");
  await expect(at(1, "2026-03-09")).toHaveCSS("border-left-width", "0px");
  await page.reload();
  await expect(at(1, "2026-03-09")).toHaveCSS("border-top-width", "0px");
  await expect(at(1, "2026-03-09")).toHaveCSS("border-left-width", "0px");
});

test("숨긴 행은 번호를 유지하고 경계 삼각형으로 구간별·전체 숨김을 해제한다", async ({
  page,
}, info) => {
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await expect(page.locator(".sheet-row .row-select")).toHaveText(["1", "3"]);
  await expect(
    page.getByRole("button", { name: "2행 숨김 해제", exact: true }),
  ).toHaveCount(2);
  for (const marker of await page.locator(".hidden-row-marker").all()) {
    const bounds = await marker.evaluate((el) => {
      const row = el.closest(".row-number")!;
      const marker = el.getBoundingClientRect();
      const handle = row
        .querySelector(".row-drag-handle")!
        .getBoundingClientRect();
      const number = row.querySelector(".row-index")!.getBoundingClientRect();
      const hit = document.elementFromPoint(
        marker.x + marker.width / 2,
        marker.y + marker.height / 2,
      );
      return {
        markerLeft: marker.left,
        markerRight: marker.right,
        handleRight: handle.right,
        numberLeft: number.left,
        unobstructed: hit === el || el.contains(hit),
      };
    });
    expect(bounds.markerLeft).toBeGreaterThanOrEqual(bounds.handleRight);
    expect(bounds.markerRight).toBeLessThanOrEqual(bounds.numberLeft);
    expect(bounds.unobstructed).toBe(true);
    await expect(marker).toHaveCSS("border-top-width", "0px");
    await expect(marker).toHaveCSS("border-bottom-width", "0px");
    // The arrow lane is still a row selection target away from the actual arrow.
    const row = marker.locator("..");
    const rowBox = (await row.boundingBox())!;
    const markerBox = (await marker.boundingBox())!;
    await page.mouse.click(
      markerBox.x + markerBox.width / 2,
      rowBox.y + rowBox.height / 2,
    );
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".hidden-row-marker")).toHaveCount(2);
  }
  await page.screenshot({
    path: info.outputPath("hidden-row-markers.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "2행 숨김 해제", exact: true })
    .last()
    .click();
  await expect(page.locator(".sheet-row .row-select")).toHaveText([
    "1",
    "2",
    "3",
  ]);
  for (const number of [1, 3]) {
    await page
      .getByRole("button", { name: `${number}행 전체 선택`, exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "행 숨기기", exact: true })
      .click();
  }
  await expect(page.locator(".sheet-row .row-select")).toHaveText(["2"]);
  await page
    .getByRole("button", { name: "1행 숨김 해제", exact: true })
    .click();
  await expect(page.locator(".sheet-row .row-select")).toHaveText(["1", "2"]);
  await expect(
    page.getByRole("button", { name: "3행 숨김 해제", exact: true }),
  ).toHaveCount(1);
  // Finding a visible cell preserves the existing manual-hide marker.
  await page.getByLabel("전체 속성 검색", { exact: true }).fill("첫 업무");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(page.locator(".hidden-row-marker")).toHaveCount(1);
  await page.getByLabel("전체 속성 검색", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "3행 숨김 해제", exact: true })
    .click();
  await page.getByRole("grid").focus();
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  await page.keyboard.press("Control+a");
  await hideSelectedRows(page);
  await expect(page.locator(".sheet-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "숨긴 3개 행 펼치기", exact: true })
    .click();
  await expect(page.locator(".sheet-row .row-select")).toHaveText([
    "1",
    "2",
    "3",
  ]);
});

test("숨긴 열은 머리글 좌우 화살표로 구간별 복원하고 고정 열·전체 주차 숨김을 유지한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  const header = (key: string) => page.locator(`[data-header-key="${key}"]`);
  const reveal = (key: string) =>
    page.locator(`.hidden-column-reveal[data-hidden-columns~="${key}"]`);
  const hide = async (key: string) => {
    await header(key).click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "열 숨기기", exact: true })
      .click();
    await expect(header(key)).toHaveCount(0);
  };
  const originalWidth = (await page.locator(".sheet-header").boundingBox())!
    .width;
  const hiddenWidth = (await header("2026-03-09").boundingBox())!.width;
  await hide("2026-03-09");
  await expect(reveal("2026-03-09")).toHaveAccessibleName(
    "숨긴 열 1개 펼치기: 3/13",
  );
  const left = (await header("2026-03-02").boundingBox())!;
  const right = (await header("2026-03-16").boundingBox())!;
  expect(left.x + left.width).toBeCloseTo(right.x, 0);
  const leftArrow = (await reveal("2026-03-09")
    .locator(".hidden-column-arrow.left")
    .boundingBox())!;
  const rightArrow = (await reveal("2026-03-09")
    .locator(".hidden-column-arrow.right")
    .boundingBox())!;
  const borderWidth = await header("2026-03-02").evaluate((el) =>
    parseFloat(getComputedStyle(el).borderRightWidth),
  );
  expect(right.x - borderWidth - (leftArrow.x + leftArrow.width)).toBeCloseTo(
    rightArrow.x - right.x,
    1,
  );
  expect(
    (await page.locator(".sheet-header").boundingBox())!.width,
  ).toBeCloseTo(originalWidth - hiddenWidth, 0);
  await expect(reveal("2026-03-09")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(".hidden-column-gap")).toHaveCount(0);
  await expect(page.locator(".sheet-row .hidden-column-marker")).toHaveCount(0);
  const below = (await page
    .locator(`[data-cell="${taskIds[0]}:2026-03-16"]`)
    .boundingBox())!;
  expect(below.x).toBeCloseTo(right.x, 0);
  await expect(page.locator(".hidden-weeks-strip")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("hidden-column-arrows.png"),
    fullPage: true,
  });
  await reveal("2026-03-09").focus();
  await page.keyboard.press("Enter");
  await expect(header("2026-03-09")).toBeVisible();
  await hide("2026-03-02");
  await hide("2026-03-16");
  await expect(reveal("2026-03-02")).toHaveCount(1);
  await expect(reveal("2026-03-16")).toHaveCount(1);
  await chooseWeeks(page, "2026-03-02", "2026-12-28");
  await hide("2026-03-02");
  await hide("2026-03-16");
  await freezeColumns(page, 3);
  await header("title").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("grid").evaluate((el) => {
    el.scrollLeft = 80;
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await hide("owner");
  const frozen = reveal("owner");
  await expect(frozen.locator("..")).toHaveClass(/fixed/);
  const before = (await frozen.boundingBox())!.x;
  await page.getByRole("grid").evaluate((el) => {
    el.scrollLeft = 150;
  });
  expect(
    await page.getByRole("grid").evaluate((el) => el.scrollLeft),
  ).toBeGreaterThan(0);
  expect((await frozen.boundingBox())!.x).toBeCloseTo(before, 0);
  await frozen.click();
  await expect(header("owner")).toHaveCount(1);
  await expect(header("2026-03-02")).toHaveCount(0);
  await expect(header("2026-03-16")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views[0]?.data.hiddenWeeks,
    )
    .toEqual(["2026-03-02", "2026-03-16"]);
  await page.reload();
  await expect(reveal("2026-03-02")).toHaveCount(1);
  await expect(reveal("2026-03-16")).toHaveCount(1);
  await marchWeeks(page);
  await hide("2026-03-02");
  await hide("2026-03-16");
  await hide("2026-03-09");
  await expect(page.locator(".week-heading")).toHaveCount(0);
  await reveal("2026-03-09").click();
  await expect(page.locator(".week-heading")).toHaveCount(53);
  await expect(reveal("2026-03-02")).toHaveCount(0);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await chooseWeeks(page, "2026-03-09", "2026-03-16");
  await expect(header("2026-03-02")).toHaveCount(0);
  await expect(reveal("2026-03-02")).toHaveCount(1);
});

test("여러 셀을 선택하면 영역마다 외곽선을 표시한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const outline = (row: number, key: string) =>
    at(row, key).evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return [
        s.borderTopWidth,
        s.borderRightWidth,
        s.borderBottomWidth,
        s.borderLeftWidth,
      ].map((w) => (parseFloat(w) > 0 ? 1 : 0));
    });
  await dragSelection(page, at(0, "2026-03-02"), at(1, "2026-03-09"));
  await at(2, "title").click({ modifiers: ["Meta"] });
  expect(await outline(0, "2026-03-02")).toEqual([1, 0, 0, 1]);
  expect(await outline(0, "2026-03-09")).toEqual([1, 1, 0, 0]);
  expect(await outline(1, "2026-03-02")).toEqual([0, 0, 1, 1]);
  expect(await outline(1, "2026-03-09")).toEqual([0, 1, 1, 0]);
  expect(await outline(2, "title")).toEqual([1, 1, 1, 1]);
  expect(await outline(2, "2026-03-02")).toEqual([0, 0, 0, 0]);
  await page.screenshot({
    path: info.outputPath("selection-outline.png"),
    fullPage: true,
  });
});

test("열 너비 손잡이는 경계선 양쪽으로 넓게 잡히고 오른쪽에서 끌어도 해당 열을 조절한다", async ({
  page,
}) => {
  const header = page.locator('[data-header-key="title"]');
  const box = (await header.boundingBox())!;
  const boundary = box.x + box.width - 0.5;
  const handle = page.locator('[data-resize-key="title"]');
  const hb = (await handle.boundingBox())!;
  expect(Math.abs(hb.x + hb.width / 2 - boundary)).toBeLessThanOrEqual(0.5);
  expect(hb.width).toBeGreaterThanOrEqual(10);
  // 경계 오른쪽 4px을 잡아도 업무 열 손잡이가 잡힌다.
  const y = box.y + box.height / 2;
  expect(
    await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.getAttribute("data-resize-key"),
      [boundary + 4, y],
    ),
  ).toBe("title");
  await page.mouse.move(boundary + 4, y);
  await page.mouse.down();
  await page.mouse.move(boundary + 64, y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await header.boundingBox())!.width)
    .toBeCloseTo(box.width + 60, 0);
});

test("행 높이 손잡이는 경계선 양쪽으로 넓게 잡히고 아래쪽에서 끌어도 해당 행을 조절한다", async ({
  page,
}) => {
  const number = page.locator(`[data-row-id="${taskIds[0]}"] .row-number`);
  const box = (await number.boundingBox())!;
  const boundary = box.y + box.height - 0.5;
  const handle = page.locator('[data-resize-row="0"]');
  const hb = (await handle.boundingBox())!;
  expect(Math.abs(hb.y + hb.height / 2 - boundary)).toBeLessThanOrEqual(0.5);
  expect(hb.height).toBeGreaterThanOrEqual(10);
  const x = box.x + box.width / 2;
  // 경계 아래 4px을 잡아도 첫 행 손잡이가 잡힌다.
  expect(
    await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.getAttribute("data-resize-row"),
      [x, boundary + 4],
    ),
  ).toBe("0");
  const last = page.locator(`[data-resize-row="${taskIds.length - 1}"]`);
  await expect(last).toHaveClass(/end edge/);
  await page.mouse.move(x, boundary + 4);
  await page.mouse.down();
  await page.mouse.move(x, boundary + 44, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await number.boundingBox())!.height)
    .toBeCloseTo(box.height + 40, 0);
});

test("떨어진 영역의 바깥 테두리·전체 테두리는 중복 없이 저장하고 복사·실행취소한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  await dragSelection(page, at(0, "2026-03-02"), at(1, "2026-03-09"));
  await at(2, "title").click({ modifiers: ["Meta"] });
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    5,
  );
  await applyBorders(page, "바깥쪽 테두리", "double", "#9a2233");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-left-style", "double");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-top-width", "3px");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-right-width", "1px");
  await expect(at(1, "2026-03-09")).toHaveCSS("border-bottom-style", "double");
  await expect(at(2, "title")).toHaveCSS(
    "border-right-color",
    "rgb(154, 34, 51)",
  );
  await expect(at(2, "2026-03-02")).toHaveCSS("border-left-style", "none");
  await page.screenshot({
    path: info.outputPath("multiple-area-borders.png"),
    fullPage: true,
  });
  await page.keyboard.down("Meta");
  await dragSelection(page, at(1, "2026-03-16"), at(2, "2026-03-16"));
  await page.keyboard.up("Meta");
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    7,
  );
  await applyBorders(page, "모든 테두리", "dotted", "#336699");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-right-style", "dotted");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  ]);
  await expect(at(0, "2026-03-02")).toHaveCSS("border-left-style", "double");
  // Overlap must be deduplicated before the atomic cell batch is sent.
  await at(0, "2026-03-02").click({ modifiers: ["Control"] });
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    7,
  );
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "12");
  await expect(at(2, "title")).toHaveCSS("font-size", "16px");
  await expect(at(2, "2026-03-02")).toHaveCSS("font-size", "12px");
  await at(2, "title").click();
  const copied = await copyContents(page);
  await at(2, "2026-03-16").click();
  await pasteContents(page, { "text/html": copied["text/html"] });
  await expect(at(2, "2026-03-16")).toHaveText("셋째 업무");
  await expect(at(2, "2026-03-16")).toHaveCSS("border-left-style", "double");
  await applyBorders(page, "테두리 지우기");
  await expect(at(2, "2026-03-16")).toHaveCSS("border-left-style", "none");
  await page.reload();
  await expect(at(2, "title")).toHaveCSS(
    "border-right-color",
    "rgb(154, 34, 51)",
  );
  await expect(at(2, "2026-03-16")).toHaveCSS("border-left-style", "none");
});

test("Command·Ctrl+B는 셀·여러 영역·입력 중 굵게를 전환하고 일반 입력에는 간섭하지 않는다", async ({
  page,
}) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const last = page.locator(`[data-cell="${taskIds[2]}:title"]`);
  await first.click();
  await last.click({ modifiers: ["Meta"] });
  await page.keyboard.press("Meta+b");
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(last).toHaveCSS("font-weight", "700");
  await expect(
    page.getByRole("button", { name: "굵게", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+b");
  await expect(first).toHaveCSS("font-weight", "400");
  await expect(last).toHaveCSS("font-weight", "400");
  await first.dblclick();
  const editor = first.getByRole("textbox");
  await editor.fill("입력 중인 작업");
  await editor.press("Meta+b");
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(editor).toHaveValue("입력 중인 작업");
  await expect(editor).toBeFocused();
  await expect(
    page.getByRole("button", { name: "굵게", exact: true }),
  ).toBeEnabled();
  await editor.press("Enter");
  await expect(first).toHaveText("입력 중인 작업");
  await page.getByLabel("전체 속성 검색", { exact: true }).fill("입력");
  await page.getByLabel("전체 속성 검색", { exact: true }).press("Meta+b");
  await expect(first).toHaveCSS("font-weight", "700");
  await page.reload();
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(first).toHaveText("입력 중인 작업");
});

test("속성을 주차 날짜 아래로 옮기면 마지막 날짜 뒤에 저장하고 편집·열 선택·고정을 유지한다", async ({
  page,
}, info) => {
  const settings = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  const trailing = ["progress", "deadline"];
  settings.properties = [
    ...settings.properties.filter((p: any) => !trailing.includes(p.id)),
    ...trailing.map((id) => settings.properties.find((p: any) => p.id === id)),
  ].map((p: any) => ({
    ...p,
    visible: ["title", "owner", "status", ...trailing].includes(p.id),
  }));
  const saved = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: settings,
  });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  await freezeColumns(page, 5);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await expect(page.locator(".property-list-row").last()).toHaveAttribute(
    "data-column-item",
    "__weeks",
  );
  await page.locator(".week-column-select").click();
  await expect(
    page.getByRole("region", { name: "주차 날짜 배치 안내" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "선택 속성 삭제", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "목표일 속성 순서 이동", exact: true })
    .press("Alt+ArrowDown");
  await page
    .getByRole("button", { name: "진척률 속성 순서 이동", exact: true })
    .press("Alt+ArrowDown");
  const list = await page
    .locator(".property-list-row")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-column-item")));
  expect(list.slice(-3)).toEqual(["__weeks", "progress", "deadline"]);
  await page.screenshot({
    path: info.outputPath("week-column-position-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const headers = () =>
    page
      .locator("[data-header-key]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-header-key")),
      );
  await expect.poll(async () => (await headers()).slice(-2)).toEqual(trailing);
  await expect(page.locator(".header-cell.fixed")).toHaveCount(3);
  await expect(page.locator('[data-header-key="progress"]')).not.toHaveClass(
    /fixed/,
  );
  await page.locator('[data-header-key="progress"]').click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "여기까지 열 고정", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await marchWeeks(page);
  const expected = [
    "title",
    "owner",
    "status",
    "2026-03-02",
    "2026-03-09",
    "2026-03-16",
    "progress",
    "deadline",
  ];
  await expect.poll(headers).toEqual(expected);
  await page.getByRole("grid").evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const progress = page.locator(`[data-cell="${taskIds[0]}:progress"]`);
  await progress.dblclick();
  await progress.getByRole("textbox").fill("75% 검토 중");
  await progress.getByRole("textbox").press("Tab");
  await expect(
    page.locator(`[data-cell="${taskIds[0]}:deadline"]`),
  ).toHaveClass(/focused/);
  await expect(page.getByRole("grid")).toBeFocused();
  await expect(progress).toHaveText("75% 검토 중");
  await page
    .getByRole("button", { name: "진척률 열 선택", exact: true })
    .click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "12");
  for (const id of taskIds)
    await expect(page.locator(`[data-cell="${id}:progress"]`)).toHaveCSS(
      "font-size",
      "16px",
    );
  await page.screenshot({
    path: info.outputPath("columns-after-weeks.png"),
    fullPage: true,
  });
  await expect
    .poll(async () => {
      const views = (
        await (
          await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
        ).json()
      ).views;
      const current = views.find((v: any) => v.name === "__current").data;
      return [current.fromWeek, current.toWeek];
    })
    .toEqual(["2026-03-02", "2026-03-16"]);
  await page.reload();
  await expect.poll(headers).toEqual(expected);
  await expect(progress).toHaveText("75% 검토 중");
  const stored = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  expect(stored.properties).toHaveLength(settings.properties.length);
  expect(stored.properties.some((p: any) => p.id === "__weeks")).toBeFalsy();
  for (const id of trailing)
    expect(stored.properties.find((p: any) => p.id === id).placement).toBe(
      "afterWeeks",
    );
});

test("주차 날짜 묶음을 처음·끝으로 옮기고 모든 주차를 숨겨도 속성 열은 유지한다", async ({
  page,
}) => {
  const open = async () => {
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("tab", { name: "속성", exact: true }).click();
  };
  const save = async () => {
    await page.getByRole("button", { name: "속성 저장", exact: true }).click();
    await expect(
      page.getByText("속성 설정을 저장했습니다.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "닫기", exact: true }).click();
  };
  await open();
  const count = await page.locator(".property-select").count();
  for (let i = 0; i < count; i++)
    await page
      .getByRole("button", { name: "주차 날짜 속성 순서 이동", exact: true })
      .press("Alt+ArrowUp");
  await expect(page.locator(".property-list-row").first()).toHaveAttribute(
    "data-column-item",
    "__weeks",
  );
  await expect(
    page.getByRole("button", { name: "주차 날짜 속성 순서 이동", exact: true }),
  ).toBeEnabled();
  await save();
  const headers = () =>
    page
      .locator("[data-header-key]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-header-key")),
      );
  await expect.poll(async () => (await headers())[0]).toBe("2025-12-29");
  await expect
    .poll(async () => (await headers()).slice(-4))
    .toEqual(["category", "title", "owner", "status"]);
  await page.locator('[data-header-key="title"]').click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "여기까지 열 고정", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await chooseMonths(page, 3);
  await dragSelection(
    page,
    page.locator('[data-header-key="2026-03-02"]'),
    page.locator('[data-header-key="2026-03-23"]'),
  );
  await page
    .locator('[data-header-key="2026-03-23"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect.poll(headers).toEqual(["category", "title", "owner", "status"]);
  await expect(page.locator(".header-cell.fixed")).toHaveCount(0);
  await open();
  await expect(page.locator(".property-list-row").first()).toHaveAttribute(
    "data-column-item",
    "__weeks",
  );
  for (let i = 0; i < count; i++)
    await page
      .getByRole("button", { name: "주차 날짜 속성 순서 이동", exact: true })
      .press("Alt+ArrowDown");
  await expect(page.locator(".property-list-row").last()).toHaveAttribute(
    "data-column-item",
    "__weeks",
  );
  await save();
  await chooseMonths(page, 3);
  await expect
    .poll(headers)
    .toEqual([
      "category",
      "title",
      "owner",
      "status",
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
    ]);
});

test("열 머리글 드래그·Shift 선택은 전체 열에 서식을 적용하고 선택 열을 숨긴다", async ({
  page,
}, info) => {
  const title = page.locator('[data-header-key="title"]');
  const owner = page.locator('[data-header-key="owner"]');
  await title.getByRole("button").click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "14");
  for (const id of taskIds)
    await expect
      .poll(() =>
        page
          .locator(`[data-cell="${id}:title"]`)
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      )
      .toBeCloseTo((14 * 4) / 3, 1);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveCSS(
    "font-size",
    "12px",
  );
  await dragSelection(
    page,
    title.getByRole("button"),
    owner.getByRole("button"),
  );
  const keys = await page
    .locator('[data-header-key][aria-selected="true"]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.headerKey!),
    );
  expect(keys).toContain("title");
  expect(keys).toContain("owner");
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    keys.length * 3,
  );
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByLabel("배경색", { exact: true }).fill("#d1eee6"),
  ]);
  const saved = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  for (const task of saved)
    for (const key of keys)
      expect(task.cells[key].style.backgroundColor).toBe("#d1eee6");
  await owner.getByRole("button").click({ button: "right" });
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    keys.length * 3,
  );
  await page.screenshot({
    path: info.outputPath("column-selection-menu.png"),
    fullPage: true,
  });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect(owner).toHaveCount(0);
  await expect(title).toBeVisible();
  const status = page.locator('[data-header-key="status"]');
  await title.getByRole("button").click();
  await status.getByRole("button").click({ modifiers: ["Shift"] });
  await expect(title).toHaveAttribute("aria-selected", "true");
  await expect(status).toHaveAttribute("aria-selected", "true");
});

test("행 번호 드래그는 행 전체를 선택하고 서식·실행취소·행 숨김을 적용한다", async ({
  page,
}, info) => {
  const first = page.getByRole("button", {
    name: "1행 전체 선택",
    exact: true,
  });
  const second = page.getByRole("button", {
    name: "2행 전체 선택",
    exact: true,
  });
  const columns = await page.locator("[data-header-key]").count();
  await first.click();
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    columns,
  );
  await dragSelection(page, first, second);
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    columns * 2,
  );
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "12");
  const saved = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  const keys = await page
    .locator("[data-header-key]")
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.headerKey!),
    );
  for (const task of saved.slice(0, 2))
    for (const key of keys) expect(task.cells[key].style.fontSize).toBe(12);
  expect(saved[2].cells.title.style.fontSize).not.toBe(12);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveCSS(
    "font-size",
    "12px",
  );
  await page
    .getByRole("button", { name: "3행 전체 선택", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    columns * 3,
  );
  await page.screenshot({
    path: info.outputPath("row-selection.png"),
    fullPage: true,
  });
  await first.click();
  await second.click({ modifiers: ["Shift"] });
  await second.click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await expect(page.locator('[data-column="title"]')).toHaveText(["셋째 업무"]);
});

test("2,000셀 이상 열 전체 서식은 화면 밖 행·실행취소를 지원하고 필터에서 제외한 행을 보존한다", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  for (let i = 0; i < 45; i++)
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: `대상 ${i}`, owner: boot.user.id },
    });
  await page.reload();
  await page
    .getByRole("button", { name: "작업 열 선택", exact: true })
    .click({ button: "right" });
  const titleFilter = page.getByRole("group", {
    name: "작업 필터 선택",
    exact: true,
  });
  for (const title of ["첫 업무", "숨길 업무", "셋째 업무"])
    await titleFilter
      .getByRole("checkbox", { name: title, exact: true })
      .check();
  await titleFilter.getByRole("radio", { name: "제외", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "46");
  expect(await page.locator('[data-column="title"]').count()).toBeLessThan(45);
  await page.getByRole("button", { name: "작업 열 선택", exact: true }).click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "14");
  const saved = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  for (const task of saved)
    expect(task.cells.title.style.fontSize).toBe(
      task.cells.title.value.startsWith("대상") ? 14 : undefined,
    );
  const keys = await page
    .locator("[data-header-key]")
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.headerKey!),
    );
  expect(keys.length * 45).toBeGreaterThan(2000);
  await page.locator("[data-header-key]").first().getByRole("button").click();
  await page
    .locator("[data-header-key]")
    .last()
    .getByRole("button")
    .click({ modifiers: ["Shift"] });
  await expect(
    page.locator('[data-header-key][aria-selected="true"]'),
  ).toHaveCount(keys.length);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByLabel("배경색", { exact: true }).fill("#d1eee6"),
  ]);
  const readTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      ).json()
    ).tasks;
  const verifyBackground = async (formatted: boolean) => {
    for (const task of await readTasks())
      for (const key of keys)
        expect(task.cells[key]?.style.backgroundColor).toBe(
          formatted && task.cells.title.value.startsWith("대상")
            ? "#d1eee6"
            : undefined,
        );
  };
  await verifyBackground(true);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  ]);
  await verifyBackground(false);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: "재실행", exact: true }).click(),
  ]);
  await verifyBackground(true);
});

test("팀원 아바타의 이니셜·이미지·기본 글자와 배경색을 편집하고 다시 연다", async ({
  page,
}, info) => {
  const name = `프로필 ${randomUUID().slice(0, 6)}`;
  const created = await post(page, "/admin/users", {
    name,
    username: `profile-${randomUUID()}@example.com`,
    password: "profile-test-password",
    active: true,
    memberships: [{ teamId, role: "member" }],
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "사용자 계정", exact: true }).click();
  const member = page
    .locator(".users-table tbody tr")
    .filter({ hasText: name });
  const edit = async () => {
    await member
      .getByRole("button", { name: `${name} 사용자 수정`, exact: true })
      .click();
  };
  const save = async () => {
    await page
      .getByRole("button", { name: "사용자 저장", exact: true })
      .click();
    await expect(page.locator(".settings-form")).toHaveCount(0);
  };
  await edit();
  await page.getByRole("radio", { name: "직접 입력", exact: true }).check();
  const initials = page.getByLabel("아바타 글자", { exact: true });
  await initials.fill("WWW");
  await expect(initials).toHaveValue("WWW");
  await page.getByLabel("아바타 배경색", { exact: true }).fill("#888888");
  await expect(page.locator(".avatar-preview .avatar")).toHaveText("WWW");
  await page.screenshot({
    path: info.outputPath("avatar-editor.png"),
    fullPage: true,
  });
  await save();
  await expect(member.locator(".avatar")).toHaveText("WWW");
  await expect(member.locator(".avatar")).toHaveCSS(
    "background-color",
    "rgb(136, 136, 136)",
  );
  await edit();
  await expect(initials).toHaveValue("WWW");
  await initials.fill("김민수");
  await page.getByRole("button", { name: "사용자 저장", exact: true }).click();
  await expect(page.locator(".settings-form")).toBeVisible();
  await initials.fill("김민");
  await expect(page.locator(".avatar-preview .avatar")).toHaveText("김민");
  await page.screenshot({
    path: info.outputPath("avatar-hangul.png"),
    fullPage: true,
  });
  await save();
  await expect(member.locator(".avatar")).toHaveText("김민");
  await edit();
  await expect(initials).toHaveValue("김민");
  await page.getByRole("radio", { name: "이미지", exact: true }).check();
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#bf4962";
    ctx.fillRect(0, 0, 2, 2);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("아바타 이미지", { exact: true }).setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(page.locator(".avatar-preview img")).toBeVisible();
  await save();
  await expect(member.locator(".avatar img")).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  const profile = (
    await (await page.request.get("/api/bootstrap")).json()
  ).users.find((u: any) => u.id === created.user.id);
  expect(profile.avatarImage).toMatch(/^data:image\/png;base64,/);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "사용자 계정", exact: true }).click();
  await edit();
  await page.getByRole("radio", { name: "이름 첫 글자", exact: true }).check();
  await expect(page.locator(".avatar-preview .avatar")).toHaveText("프");
  await expect(page.locator(".avatar-preview img")).toHaveCount(0);
  await save();
});

test("팀에서 제외된 팀원은 최신 이름과 아바타로 남고 필터·새 선택에서는 제외된다", async ({
  page,
}, info) => {
  const account = {
    name: "이전 담당자",
    username: `former-${randomUUID()}@example.com`,
    password: "profile-test-password",
    active: true,
    memberships: [{ teamId, role: "member" }],
  };
  const uid = (await post(page, "/admin/users", account)).user.id;
  await setTaskCells(page, [{ index: 0, key: "owner", value: uid }]);
  await page.reload();
  await page
    .getByRole("button", { name: "팀원 열 선택", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("group", { name: "팀원 필터 선택", exact: true })
    .getByRole("checkbox", { name: /이전 담당자/ })
    .check();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-column="title"]')).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.propertyFilters
          .owner,
    )
    .toEqual([uid]);
  const readCurrentView = async () =>
    (
      await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json()
    ).views.find((v: any) => v.name === "__current").data;
  const oldView = await readCurrentView();
  const savedView = await page.request.put("/api/views", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      teamId,
      name: "이전 팀원 보기",
      data: {
        ...oldView,
        propertyFilters: { ...oldView.propertyFilters, owner: [uid] },
      },
    },
  });
  expect(savedView.ok()).toBeTruthy();
  const response = await page.request.patch(`/api/admin/users/${uid}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      ...account,
      name: "최신 담당자",
      memberships: [],
      active: false,
      avatarInitials: "WWW",
      color: "#888888",
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  const cell = page.locator(`[data-cell="${taskIds[0]}:owner"]`);
  await expect(cell).toContainText("최신 담당자");
  await expect(cell).not.toContainText(uid);
  await expect(cell.locator(".avatar")).toHaveText("WWW");
  await page.evaluate(() => document.fonts.ready);
  const avatarWidth = await cell.locator(".avatar").evaluate((el) => {
    const text = document.createRange();
    text.selectNodeContents(el);
    return {
      text: text.getBoundingClientRect().width,
      circle: el.getBoundingClientRect().width,
    };
  });
  expect(avatarWidth.text).toBeLessThanOrEqual(avatarWidth.circle - 2);
  await expect(cell.locator(".avatar")).toHaveCSS(
    "background-color",
    "rgb(136, 136, 136)",
  );
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  const viewSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/views") &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await page
    .getByRole("button", { name: "이전 팀원 보기", exact: true })
    .click();
  const applied = (await viewSaved).request().postDataJSON().data;
  expect(applied.propertyFilters.owner).toEqual([]);
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await page
    .getByRole("button", { name: "팀원 열 선택", exact: true })
    .click({ button: "right" });
  await expect(page.locator(".property-filter")).not.toContainText(
    "최신 담당자",
  );
  await page.keyboard.press("Escape");
  await cell.getByRole("button").click();
  await expect(page.locator(".inline-editor")).toContainText("최신 담당자");
  await expect(
    page.getByRole("option", { name: "최신 담당자", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("former-member.png"),
    fullPage: true,
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  await page.getByRole("option", { name: boot.user.name, exact: true }).click();
  await expect(cell).toContainText(boot.user.name);
  await page.reload();
  await cell.getByRole("button").click();
  await expect(
    page.getByRole("option", { name: "최신 담당자", exact: true }),
  ).toHaveCount(0);
});

test("혼합 서식 범위에서 현재 값을 다시 골라도 모든 셀에 적용하고 실행취소한다", async ({
  page,
}, info) => {
  const [first, second] = taskIds.map((id) =>
    page.locator(`[data-cell="${id}:title"]`),
  );
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        expectedVersion: 1,
        style: {
          fontSize: 9,
          fontFamily: "Noto Sans KR",
          verticalAlign: "top",
          textMode: "overflow",
        },
      },
      {
        taskId: taskIds[1],
        key: "title",
        expectedVersion: 1,
        style: {
          fontSize: 11,
          fontFamily: "Noto Serif KR",
          verticalAlign: "bottom",
          textMode: "wrap",
        },
      },
    ],
  });
  await page.reload();
  await second.click();
  await first.click({ modifiers: ["Shift"] });
  const size = page.getByRole("combobox", { name: "글자 크기", exact: true });
  await expect(size).toHaveAttribute("data-value", "9");
  await size.click();
  await page.screenshot({
    path: info.outputPath("reapply-font-size.png"),
    fullPage: true,
  });
  await page
    .getByRole("listbox", { name: "글자 크기", exact: true })
    .getByRole("option", { name: "9", exact: true })
    .click();
  await expect(first).toHaveCSS("font-size", "12px");
  await expect(second).toHaveCSS("font-size", "12px");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(first).toHaveCSS("font-size", "12px");
  await expect
    .poll(() =>
      second.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    )
    .toBeCloseTo((11 * 4) / 3, 1);
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(second).toHaveCSS("font-size", "12px");
  for (const [label, value, css, expected] of [
    ["글꼴", "Noto Sans KR", "font-family", /Noto Sans KR/],
    ["세로 정렬", "top", "align-items", "flex-start"],
    ["텍스트 표시", "overflow", "white-space", "nowrap"],
  ] as const) {
    const control = page.getByRole("combobox", { name: label, exact: true });
    await expect(control).toHaveAttribute("data-value", value);
    await selectFormat(control, value);
    await expect(second).toHaveCSS(css, expected);
  }
  const alignment = page.getByRole("combobox", {
    name: "세로 정렬",
    exact: true,
  });
  await selectFormat(alignment, "middle");
  await expect(second).toHaveCSS("align-items", "safe center");
  await selectFormat(alignment, "bottom");
  await expect(second).toHaveCSS("align-items", "safe flex-end");
  // Keyboard selection of the already active item must dispatch another batch too.
  await alignment.focus();
  await page.keyboard.press("Enter");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.keyboard.press("Enter"),
  ]);
  await size.click();
  await page.keyboard.press("Escape");
  await expect(size).toHaveAttribute("aria-expanded", "false");
  await expect(size).toBeFocused();
  await size.click();
  await page.getByLabel("전체 속성 검색").click();
  await expect(page.getByRole("listbox", { name: "글자 크기" })).toHaveCount(0);
  await page.reload();
  await expect(second).toHaveCSS("font-size", "12px");
  await expect(second).toHaveCSS("align-items", "safe flex-end");
  await expect(second).toHaveAttribute("data-text-mode", "overflow");
});

test("새 팀은 작업·팀원·상태와 새 보기 기본값으로 시작하고 상태별 통계를 표시한다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const name = `기본 팀 ${randomUUID().slice(0, 6)}`;
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "새 팀", exact: true }).click();
  await page.getByLabel("신규 팀 이름").fill(name);
  await expect(page.getByLabel("새 팀 양식")).toHaveValue("");
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  // 만든 팀이 바로 선택되고 구성원 탭으로 이동한다.
  await expect(page.locator(".settings-team-header h3")).toHaveText(name);
  await expect(
    page.getByRole("tab", { name: "구성원", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByLabel("팀 선택").selectOption({ label: name });
  for (const label of ["작업", "팀원", "상태"])
    await expect(
      page.getByRole("button", { name: `${label} 열 선택`, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "분류 열 선택", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".sheet-scroll")).toHaveAttribute(
    "data-density",
    "compact",
  );
  await expect(page.locator(".header-cell.fixed")).toHaveCount(0);
  await page
    .getByRole("button", { name: "업무 추가", exact: true })
    .first()
    .click();
  const title = page.locator('[data-column="title"]');
  await expect(title).toHaveCount(1);
  await expect(title).toHaveCSS("font-size", "12px");
  if (await title.getByRole("textbox").count())
    await title.getByRole("textbox").press("Escape");
  const status = page.locator('[data-column="status"]');
  const summary = page.locator(".board-summary");
  await expect(summary).toContainText("예정 1");
  await status.locator(".cell-choice-trigger").click();
  for (const label of ["예정", "검토 중", "진행 중", "완료", "보류"])
    await expect(
      page.getByRole("option", { name: label, exact: true }),
    ).toBeVisible();
  await page.getByRole("option", { name: "완료", exact: true }).click();
  await expect(summary).toContainText("완료 1");
  await expect(summary).toContainText("예정 0");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "기본 서식", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("글자 크기", { exact: true }),
  ).toHaveAttribute("data-value", "9");
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await expect(page.locator(".property-select")).toHaveCount(3);
  for (const label of ["작업", "팀원", "상태"]) {
    await page
      .locator(".property-select")
      .filter({ hasText: new RegExp(`^${label}`) })
      .click();
    await expect(
      page.getByRole("button", { name: "선택 속성 삭제", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("속성 종류", { exact: true })).toBeDisabled();
  }
  await page.getByLabel("속성 값 4 이름", { exact: true }).fill("종료");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(summary).toContainText("종료 1");
  await expect(status).toHaveText("종료");
  await page.reload();
  await expect(summary).toContainText("종료 1");
  await page.getByRole("grid").evaluate((el) => (el.scrollLeft = 0));
  await page.screenshot({
    path: info.outputPath("core-properties-status-summary.png"),
    fullPage: true,
  });
});

test("신규 팀 양식 선택으로 속성과 테마·기본 서식만 새 팀에 가져온다", async ({
  page,
}, info) => {
  const data = await (await page.request.get("/api/admin/users")).json();
  const original = data.teams.find((t: any) => t.id === teamId);
  original.settings.theme = "lavender";
  original.settings.defaultStyle.fontSize = 16;
  const saved = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: original.settings,
  });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "새 팀", exact: true }).click();
  await page.getByLabel("새 팀 양식").selectOption(teamId);
  await expect(page.getByLabel("새 팀 양식")).toHaveValue(teamId);
  await expect(
    page
      .getByRole("group", { name: "신규 팀 테마", exact: true })
      .getByRole("radio", { name: "라벤더", exact: true }),
  ).toBeChecked();
  const name = `복사 팀 ${randomUUID().slice(0, 6)}`;
  await page.getByLabel("신규 팀 이름").fill(name);
  await page.screenshot({
    path: info.outputPath("copy-team-template.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  await expect(page.locator(".settings-team-header h3")).toHaveText(name);
  const latest = await (await page.request.get("/api/admin/users")).json();
  const copied = latest.teams.find((t: any) => t.name === name);
  expect(copied.settings.properties).toEqual(original.settings.properties);
  expect(copied.settings.defaultStyle.fontSize).toBe(16);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByLabel("팀 선택").selectOption(copied.id);
  await expect(page.locator('[data-column="title"]')).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lavender");
  await expect(
    page.getByRole("button", { name: "분류 열 선택", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "업무 추가", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page
        .locator('[data-column="title"]')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    )
    .toBeCloseTo((16 * 4) / 3, 1);
});

test("팀 일반 설정의 팀 삭제는 경고 취소·확인 후 데이터와 선택을 갱신한다", async ({
  page,
}, info) => {
  const original = (
    await (await page.request.get("/api/bootstrap")).json()
  ).teams.find((t: any) => t.id === teamId);
  const member = await post(page, "/admin/users", {
    username: `delete-${randomUUID().slice(0, 8)}@example.com`,
    password: "delete-test-password",
    name: "남겨둘 팀원",
    active: true,
    memberships: [{ teamId, role: "member" }],
  });
  let deleteRequests = 0;
  page.on("request", (r) => {
    if (
      r.method() === "DELETE" &&
      r.url().endsWith(`/api/admin/teams/${teamId}`)
    )
      deleteRequests++;
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "설정 메뉴" });
  const teamLink = nav.getByRole("button", { name: original.name });
  await expect(teamLink).toHaveAttribute("aria-current", "page");
  const remove = page
    .getByRole("region", { name: "팀 삭제", exact: true })
    .getByRole("button", { name: `${original.name} 팀 삭제`, exact: true });
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain(original.name);
    expect(dialog.message()).toContain("모든 연도");
    expect(dialog.message()).toContain("영구 삭제");
    expect(dialog.message()).toContain("복구할 수 없습니다");
    await dialog.dismiss();
  });
  await remove.click();
  await expect(teamLink).toBeVisible();
  expect(deleteRequests).toBe(0);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
          ).json()
        ).tasks.length,
    )
    .toBe(3);
  await page.screenshot({
    path: info.outputPath("team-delete-actions.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(teamLink).toHaveCount(0);
  await expect(
    page.getByText(`“${original.name}” 팀과 모든 팀 데이터를 삭제했습니다.`, {
      exact: true,
    }),
  ).toBeVisible();
  expect(deleteRequests).toBe(1);
  await nav.getByRole("button", { name: "새 팀", exact: true }).click();
  await expect(
    page.getByLabel("새 팀 양식").locator(`option[value="${teamId}"]`),
  ).toHaveCount(0);
  const users = await (await page.request.get("/api/admin/users")).json();
  expect(users.users.find((u: any) => u.id === member.user.id).teamIds).toEqual(
    [],
  );
  expect(
    (await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)).status(),
  ).toBe(404);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByLabel("팀 선택")).not.toHaveValue(teamId);
  await expect(page.locator(`option[value="${teamId}"]`)).toHaveCount(0);
  for (const id of taskIds)
    await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveCount(0);
  await expect(page.locator(".board-error")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("팀 선택")).not.toHaveValue(teamId);
  await expect(page.locator(".board-error")).toHaveCount(0);
});

test("다른 화면에서 삭제된 팀은 자동 조회 때 다른 팀으로 전환한다", async ({
  page,
}) => {
  expect(
    (
      await page.request.delete(`/api/admin/teams/${teamId}`, {
        headers: { "X-Requested-With": "WeeklyPlan" },
        data: { confirmed: true },
      })
    ).ok(),
  ).toBeTruthy();
  await expect(page.getByLabel("팀 선택")).not.toHaveValue(teamId, {
    timeout: 12000,
  });
  for (const id of taskIds)
    await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveCount(0);
  await expect(page.locator(".board-error")).toHaveCount(0);
});

test("이전 팀의 늦은 보기 저장 실패는 현재 팀에 표시하지 않는다", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const nextTeam = boot.teams.find((team: any) => team.id !== teamId).id;
  let capture: (route: any) => void;
  const pending = new Promise<any>((resolve) => {
    capture = resolve;
  });
  await page.route("**/api/views", (route) => {
    if (route.request().method() === "PUT") capture(route);
    else route.continue();
  });
  await chooseMonths(page, 5, 7);
  const previousSave = await pending;
  await page.getByLabel("팀 선택").selectOption(nextTeam);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveCount(
    0,
  );
  await expect(page.getByRole("grid")).toBeVisible();
  const previousResponse = page.waitForResponse(
    (r) => r.request() === previousSave.request(),
  );
  await previousSave.fulfill({
    status: 503,
    json: { error: "이전 팀 저장 오류" },
  });
  await previousResponse;
  await expect(page.locator(".board-error")).toHaveCount(0);
  await page.unroute("**/api/views");
  await page.route("**/api/views", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "현재 팀 저장 오류" } })
      : route.continue(),
  );
  await chooseMonths(page, 4, 6);
  await expect(page.locator(".board-error")).toContainText("현재 팀 저장 오류");
});

test("팀별 파스텔 테마를 선택·저장하고 전환·새로고침·셀 서식을 보존한다", async ({
  page,
}, info) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const originalName = boot.teams.find((t: any) => t.id === teamId).name;
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        expectedVersion: 1,
        style: { color: "#243642", backgroundColor: "#ffe6dd" },
      },
    ],
  });
  await page.reload();
  await expect(title).toHaveCSS("background-color", "rgb(255, 230, 221)");
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  const open = async () =>
    page.getByRole("button", { name: "설정", exact: true }).click();
  // 설정을 열면 지금 보는 팀의 일반 탭이 선택된다.
  const general = page.getByRole("tabpanel");
  const themes = general.getByRole("group", {
    name: `${originalName} 테마`,
    exact: true,
  });
  await open();
  await expect(themes.getByRole("radio")).toHaveCount(5);
  await themes.getByRole("radio", { name: "민트", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    themes.getByRole("radio", { name: "하늘", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mint");
  for (const [index, theme] of THEMES.entries()) {
    if (index) await open();
    await themes.getByRole("radio", { name: theme.name, exact: true }).check();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/teams/${teamId}`) &&
          r.request().method() === "PATCH" &&
          r.ok(),
      ),
      general.getByRole("button", { name: "저장", exact: true }).click(),
    ]);
    await expect(
      page.getByText("팀 정보를 저장했습니다.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    if (theme.id === "lavender")
      await page.screenshot({
        path: info.outputPath("team-theme-management.png"),
        fullPage: true,
      });
    await page.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(page.locator(".format-toolbar")).toHaveCSS(
      "background-color",
      rgb(theme.surface),
    );
    // 브랜드 마크는 팀 테마를 따르지 않고 브랜드 민트를 유지한다
    await expect(page.locator(".brand-symbol rect").nth(1)).toHaveAttribute(
      "fill",
      "#24796d",
    );
    await expect(title).toHaveCSS("background-color", "rgb(255, 230, 221)");
    await expect(title).toHaveCSS("color", "rgb(36, 54, 66)");
    await page
      .locator(`[data-cell="${taskIds[0]}:category"] .cell-choice-trigger`)
      .click();
    await expect(page.locator('.cell-option[aria-selected="true"]')).toHaveCSS(
      "color",
      rgb(theme.accent),
    );
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: info.outputPath(`theme-${theme.id}.png`),
      fullPage: true,
    });
  }
  await open();
  await page.getByRole("button", { name: "새 팀", exact: true }).click();
  const newName = "로즈 팀 " + randomUUID().slice(0, 6);
  await page.getByLabel("신규 팀 이름").fill(newName);
  await page
    .getByRole("group", { name: "신규 팀 테마", exact: true })
    .getByRole("radio", { name: "로즈", exact: true })
    .check();
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  await expect(page.locator(".settings-team-header h3")).toHaveText(newName);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const otherId = await page
    .getByLabel("팀 선택")
    .selectOption({ label: newName });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose");
  await page.reload();
  await expect(page.getByLabel("팀 선택")).toHaveValue(otherId[0]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sand");
  await expect(title).toHaveCSS("background-color", "rgb(255, 230, 221)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sand");
});

test("편집·기본 서식·실행취소·새로고침 복원", async ({ page }, info) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await cell.dblclick();
  await page.locator(".inline-editor textarea").fill("수정한 한글 업무");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(cell).toHaveText("수정한 한글 업무");
  await cell.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(cell).toHaveCSS("font-weight", "700");
  await page.getByLabel("글자 색상", { exact: true }).fill("#24796d");
  await expect(cell).toHaveCSS("color", "rgb(36, 121, 109)");
  await page.getByLabel("배경색", { exact: true }).fill("#d1eee6");
  await expect(cell).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await selectFormat(page.getByLabel("글꼴", { exact: true }), "Noto Serif KR");
  await expect(cell).toHaveCSS("font-family", /Noto Serif KR/);
  await selectFormat(page.getByLabel("글자 크기"), "18");
  await expect(cell).toHaveCSS("font-size", "24px");
  await page.getByRole("button", { name: "가운데 정렬", exact: true }).click();
  await expect(cell).toHaveCSS("text-align", "center");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(cell).toHaveCSS("text-align", "left");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(cell).toHaveCSS("text-align", "center");
  await page.reload();
  await expect(cell).toHaveText("수정한 한글 업무");
  await expect(cell).toHaveCSS("font-size", "24px");
  await expect(cell).toHaveCSS("text-align", "center");
  await page.screenshot({
    path: info.outputPath("workspace.png"),
    fullPage: true,
  });
});
test("숨김 행을 포함한 범위 서식과 개인 숨김 복원", async ({ page }) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`),
    hidden = page.locator(`[data-cell="${taskIds[1]}:title"]`),
    last = page.locator(`[data-cell="${taskIds[2]}:title"]`);
  await hidden.click();
  await hideSelectedRows(page);
  await expect(hidden).toHaveCount(0);
  await first.click();
  await last.click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(last).toHaveCSS("font-weight", "700");
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  expect(
    tasks.find((t: any) => t.id === taskIds[1]).cells.title.style.bold,
  ).toBe(true);
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/views?teamId=${teamId}&year=2026`);
      return (await r.json()).views[0]?.data.hiddenRows.length;
    })
    .toBe(1);
  await page.reload();
  await expect(hidden).toHaveCount(0);
  await page
    .getByRole("button", { name: "2행 숨김 해제", exact: true })
    .first()
    .click();
  await expect(hidden).toHaveText("숨길 업무");
  await expect(hidden).toHaveCSS("font-weight", "700");
});

test("숨긴 행·열을 포함한 배경색·글자·테두리는 복원과 실행취소 후에도 유지한다", async ({
  page,
}, info) => {
  await marchWeeks(page);
  const at = (row: number, key: string) =>
    page.locator(`[data-cell="${taskIds[row]}:${key}"]`);
  const readTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      ).json()
    ).tasks;
  const original = await readTasks();
  await at(1, "title").click();
  await hideSelectedRows(page);
  await page.locator('[data-header-key="owner"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await at(0, "title").click();
  await at(2, "status").click({ modifiers: ["Shift"] });
  const save = (action: () => Promise<unknown>) =>
    Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      action(),
    ]);
  await save(() => page.getByLabel("배경색", { exact: true }).fill("#d1eee6"));
  await save(() =>
    page.getByRole("button", { name: "굵게", exact: true }).click(),
  );
  await applyBorders(page, "모든 테두리", "solid", "#234567");
  const border = { style: "solid", color: "#234567" };
  let stored = await readTasks();
  for (const id of taskIds) {
    const task = stored.find((t: any) => t.id === id);
    expect(task.cells.owner.style).toMatchObject({
      backgroundColor: "#d1eee6",
      bold: true,
      borderBottom: border,
      borderRight: border,
      borderLeft: null,
    });
    expect(task.cells.category.style).toEqual(
      original.find((t: any) => t.id === id).cells.category.style,
    );
  }
  expect(
    stored.find((t: any) => t.id === taskIds[1]).cells.owner.style.borderTop,
  ).toBeNull();
  await save(() =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  stored = await readTasks();
  expect(
    stored.find((t: any) => t.id === taskIds[1]).cells.owner.style,
  ).toMatchObject({ backgroundColor: "#d1eee6", bold: true });
  expect(
    stored.find((t: any) => t.id === taskIds[1]).cells.owner.style.borderBottom,
  ).toBeUndefined();
  await save(() =>
    page.getByRole("button", { name: "재실행", exact: true }).click(),
  );
  await page
    .getByRole("button", { name: "2행 숨김 해제", exact: true })
    .first()
    .click();
  await page
    .locator('.hidden-column-reveal[data-hidden-columns~="owner"]')
    .click();
  for (const row of [0, 1, 2]) {
    await expect(at(row, "owner")).toHaveCSS(
      "background-color",
      "rgb(209, 238, 230)",
    );
    await expect(at(row, "owner")).toHaveCSS("font-weight", "700");
    await expect(at(row, "owner")).toHaveCSS("border-bottom-width", "1px");
    await expect(at(row, "owner")).toHaveCSS(
      "border-right-color",
      "rgb(35, 69, 103)",
    );
  }
  await expect
    .poll(async () => {
      const { views } = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      const current = views.find(
        (view: any) => view.name === "__current",
      )?.data;
      return [current?.hiddenRows, current?.visibleFields.includes("owner")];
    })
    .toEqual([[], true]);
  await page.reload();
  await expect(at(1, "owner")).toHaveCSS(
    "background-color",
    "rgb(209, 238, 230)",
  );
  await expect(at(1, "owner")).toHaveCSS("border-bottom-width", "1px");
  await page.screenshot({
    path: info.outputPath("restored-hidden-cell-styles.png"),
    fullPage: true,
  });
});

test("행·열·전체 선택 서식은 앞뒤 숨긴 날짜 열과 숨긴 행까지 적용한다", async ({
  page,
}) => {
  await marchWeeks(page);
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "14");
  const readTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      ).json()
    ).tasks;
  const stored = await readTasks();
  for (const key of ["2025-12-29", "2026-03-02", "2026-12-28", "description"])
    expect(
      stored.find((t: any) => t.id === taskIds[0]).cells[key].style.fontSize,
    ).toBe(14);
  expect(
    stored.find((t: any) => t.id === taskIds[1]).cells.title.style.fontSize,
  ).toBeUndefined();
  await hideSelectedRows(page);
  await page
    .getByRole("button", { name: "3행 전체 선택", exact: true })
    .click();
  await hideSelectedRows(page);
  await page.getByRole("button", { name: "팀원 열 선택", exact: true }).click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "16");
  for (const task of await readTasks())
    expect(task.cells.owner.style.fontSize).toBe(16);
  await page.getByRole("button", { name: "모든 셀 선택", exact: true }).click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "18");
  for (const task of await readTasks())
    for (const key of ["title", "description", "2025-12-29", "2026-12-28"])
      expect(task.cells[key].style.fontSize).toBe(18);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+a");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: "기울임", exact: true }).click(),
  ]);
  for (const task of await readTasks())
    for (const key of ["title", "description", "2025-12-29", "2026-12-28"])
      expect(task.cells[key].style.italic).toBe(true);
});

test("월 기간 필터·키보드 편집 및 수식 문자열 입력", async ({ page }) => {
  await chooseMonths(page, 10);
  await expect(page.getByRole("columnheader")).toHaveCount(10);
  await chooseWeeks(page, "2026-10-05");
  await expect(page.getByRole("columnheader")).toHaveCount(6);
  await chooseMonths(page, 10);
  await expect(page.getByRole("columnheader")).toHaveCount(10);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await page.keyboard.press("Enter");
  await page.locator(".inline-editor textarea").fill("=SUM(A1:A9)");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(first).toHaveText("=SUM(A1:A9)");
  await page.getByLabel("전체 속성 검색").fill("SUM");
  await expect(page.locator(".search-count")).toHaveText("1 / 1");
  await expect(first).toHaveClass(/focused/);
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
});
test("기본 서식의 셀 높이 세 단계와 촘촘한 편집 높이를 저장한다", async ({
  page,
}, info) => {
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const height = async () => (await title.boundingBox())!.height;
  await openDefaultStyle(page);
  const control = page.getByRole("combobox", { name: "셀 높이", exact: true });
  await expect(control.locator("option")).toHaveText([
    "넉넉하게",
    "편안하게",
    "촘촘하게",
  ]);
  await control.selectOption({ label: "넉넉하게" });
  await saveDefaultStyle(page);
  const roomy = await height();
  await openDefaultStyle(page);
  await control.selectOption({ label: "편안하게" });
  await saveDefaultStyle(page);
  const comfortable = await height();
  expect(comfortable).toBeLessThan(roomy);
  await openDefaultStyle(page);
  await control.selectOption({ label: "촘촘하게" });
  await saveDefaultStyle(page);
  const dense = await height();
  expect(Math.abs(dense - (comfortable * 2) / 3)).toBeLessThanOrEqual(1);
  await title.dblclick();
  await expect(title.getByRole("textbox", { name: "작업 편집" })).toBeVisible();
  expect(await height()).toBe(dense);
  await page.keyboard.press("Escape");
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "36");
  await expect(title).toHaveCSS("font-size", "48px");
  await expect
    .poll(() =>
      title.evaluate((el) => {
        const style = getComputedStyle(el);
        const available =
          el.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom);
        return (
          el.querySelector(".cell-text")!.getBoundingClientRect().height <=
          available
        );
      }),
    )
    .toBe(true);
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "11");
  await expect.poll(height).toBe(dense);
  await groupByColumn(page, "category");
  expect(await height()).toBe(dense);
  const stored = await (await page.request.get("/api/bootstrap")).json();
  expect(
    stored.teams.find((t: any) => t.id === teamId).settings.defaultDensity,
  ).toBe("dense");
  await page.reload();
  await expect(title).toBeVisible();
  expect(await height()).toBe(dense);
  await page.screenshot({
    path: info.outputPath("dense-cell-height.png"),
    fullPage: true,
  });
  await openDefaultStyle(page);
  await control.selectOption({ label: "넉넉하게" });
  await saveDefaultStyle(page);
  expect(await height()).toBe(roomy);
});

test("빈 프로젝트 셀은 안내 문구 없이 더블클릭하고 지정한 칩은 한 번 클릭한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "속성 추가", exact: true }).click();
  await page.getByLabel("속성 이름", { exact: true }).fill("프로젝트");
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  await page.getByLabel("속성 값 1 이름", { exact: true }).fill("A 프로젝트");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const data = await (await page.request.get("/api/admin/users")).json();
  const pid = data.teams
    .find((t: any) => t.id === teamId)
    .settings.properties.find((p: any) => p.name === "프로젝트").id;
  const project = page.locator(`[data-cell="${taskIds[0]}:${pid}"]`);
  await expect(project).toHaveText("");
  await expect(project.getByRole("button")).toHaveCount(0);
  await project.dblclick();
  const popup = page.getByRole("listbox", {
    name: "프로젝트 편집",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(project).toHaveText("");
  await popup.getByRole("option", { name: "A 프로젝트", exact: true }).click();
  await expect(project).toHaveText("A 프로젝트");
  await project.locator(".property-badge").click();
  await popup.getByRole("option", { name: "선택 안 함", exact: true }).click();
  await expect(project).toHaveText("");
});

test("진척률을 텍스트로 편집·붙여넣고 여섯 자리 이슈 번호를 링크로 표시한다", async ({
  page,
}, info) => {
  const created = await post(page, "/tasks", {
    teamId,
    year: 2026,
    fields: { title: "기존 진척률", progress: "35" },
  });
  await page.reload();
  await setColumns(page, ["진척률"], ["분류", "팀원", "상태"]);
  const progress = page.locator(`[data-cell="${created.task.id}:progress"]`);
  await expect(progress).toHaveText("35");
  await progress.dblclick();
  const input = progress.getByRole("textbox", {
    name: "진척률 편집",
    exact: true,
  });
  await input.fill("검토 중 · 120%");
  await input.press("Enter");
  await expect(progress).toHaveText("검토 중 · 120%");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(progress).toHaveText("35");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(progress).toHaveText("검토 중 · 120%");
  await progress.click();
  await pasteContents(page, { "text/plain": "검토 중" });
  await expect(progress).toHaveText("검토 중");
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const text = "#234566 검토 / #210161 확인 / #1234567";
  await title.dblclick();
  await title.getByRole("textbox").fill(text);
  await title.getByRole("textbox").press("Enter");
  await expect(title).toHaveText(text);
  await expect(title.getByRole("link")).toHaveCount(2);
  await expect(
    title.getByRole("link", { name: "#234566", exact: true }),
  ).toHaveAttribute("href", "http://redmine.somansa.com/redmine/issues/234566");
  await expect(
    title.getByRole("link", { name: "#210161", exact: true }),
  ).toHaveAttribute("href", "http://redmine.somansa.com/redmine/issues/210161");
  await expect(title.getByRole("link").first()).toHaveAttribute(
    "target",
    "_blank",
  );
  await page.reload();
  await expect(progress).toHaveText("검토 중");
  await expect(title.getByRole("link")).toHaveCount(2);
  await page.screenshot({
    path: info.outputPath("progress-text-redmine.png"),
    fullPage: true,
  });
});

test("셀 편집 확정은 저장 응답 전에 새 값을 표시하고 실행취소 원본을 보존한다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  let previous = "첫 업무";
  for (const [text, finish] of [
    ["저장 중에도 유지할 입력", "Enter"],
    ["", "Tab"],
    ["다른 셀을 눌러 확정한 입력", "blur"],
  ]) {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const requested = new Promise<void>((resolve) => (arrived = resolve));
    await page.route("**/api/cells/batch", async (route) => {
      arrived();
      await gate;
      await route.continue();
    });
    try {
      await cell.dblclick();
      const editor = cell.getByRole("textbox");
      await editor.fill(text);
      if (finish === "blur")
        await page.locator(`[data-cell="${taskIds[1]}:title"]`).click();
      else await editor.press(finish);
      await requested;
      await expect(editor).toHaveCount(0);
      await expect(cell).toHaveText(text);
      await expect(page.locator(".save-status")).toHaveText("저장 중");
      // 서버에는 아직 원래 값이 있어도 화면에서는 방금 확정한 값을 유지한다.
      const stored = await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      ).json();
      expect(
        stored.tasks.find((task: any) => task.id === taskIds[0]).cells.title
          .value,
      ).toBe(previous);
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      );
      release();
      await response;
      await expect(page.locator(".save-status")).toHaveCount(0);
      await expect(cell).toHaveText(text);
      previous = text;
    } finally {
      release();
      await page.unroute("**/api/cells/batch");
    }
  }
  for (const text of ["", "저장 중에도 유지할 입력", "첫 업무"]) {
    await page.getByRole("button", { name: "실행취소", exact: true }).click();
    await expect(cell).toHaveText(text);
  }
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(cell).toHaveText("저장 중에도 유지할 입력");
  await page.reload();
  await expect(cell).toHaveText("저장 중에도 유지할 입력");
});

test("통신 실패에서 입력을 보존하고 같은 작업을 재시도한다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await page.route("**/api/cells/batch", (r) => r.abort("failed"));
  await cell.dblclick();
  await page.locator(".inline-editor textarea").fill("실패 뒤 복구할 입력");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(page.getByRole("button", { name: "입력 확인" })).toBeVisible();
  await expect(cell).toHaveText("첫 업무");
  await page.getByTitle("내 계정", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "로그아웃", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "입력 확인" }).click();
  await expect(page.locator(".failed-input")).toContainText(
    "실패 뒤 복구할 입력",
  );
  await page.unroute("**/api/cells/batch");
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(cell).toHaveText("실패 뒤 복구할 입력");
});
test("동시 수정 충돌을 보여주고 사용자 선택 후 최신 버전에 적용한다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await cell.dblclick();
  await page.locator(".inline-editor textarea").fill("나의 입력");
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        value: "다른 사람의 입력",
        expectedVersion: 1,
      },
    ],
  });
  await page.locator(".inline-editor textarea").press("Enter");
  await page.getByRole("button", { name: "입력 확인" }).click();
  await expect(page.locator("dialog")).toContainText("다른 사람의 입력");
  await expect(page.locator(".failed-input")).toContainText("나의 입력");
  await page.getByRole("button", { name: "내 변경 다시 적용" }).click();
  await expect(cell).toHaveText("나의 입력");
  await expect(page.locator("dialog")).toHaveCount(0);
});
test("숨긴 행을 건너뛰어 줄바꿈·빈 값·수식 텍스트를 붙여넣고 한글 조합 중 저장하지 않는다", async ({
  page,
}) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`),
    hidden = page.locator(`[data-cell="${taskIds[1]}:title"]`),
    last = page.locator(`[data-cell="${taskIds[2]}:title"]`);
  await hidden.click();
  await hideSelectedRows(page);
  await first.click();
  await page.getByRole("grid").evaluate((el) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["text/plain"],
        getData: () => '"한글\n두 번째 줄"\n"=SUM(A1:A2)"',
      },
    });
    el.dispatchEvent(event);
  });
  await expect(first).toHaveText("한글\n두 번째 줄");
  await expect(last).toHaveText("=SUM(A1:A2)");
  const stored = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  expect(stored.find((t: any) => t.id === taskIds[1]).cells.title.value).toBe(
    "숨길 업무",
  );
  await first.dblclick();
  await page.locator(".inline-editor textarea").fill("한글 조합 검증");
  await page.locator(".inline-editor textarea").evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(page.locator(".inline-editor textarea")).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(0);
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(first).toHaveText("한글 조합 검증");
});
test("업무 삭제는 확인 없이 지우고 툴바 실행취소와 재실행으로 되돌린다", async ({
  page,
}) => {
  const titles = page.locator('[data-column="title"]');
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const undo = toolbar.getByRole("button", { name: "실행취소", exact: true });
  const redo = toolbar.getByRole("button", { name: "재실행", exact: true });
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    d.dismiss();
  });
  await expect(undo).toBeDisabled();
  await openRowDetails(page, page.locator(`[data-row-id="${taskIds[1]}"]`));
  await page
    .getByRole("button", { name: "휴지통으로 이동", exact: true })
    .click();
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  expect(dialogs).toBe(0);
  const toast = page.locator(".toast");
  await expect(toast).toHaveText("‘숨길 업무’ 업무를 삭제했습니다.");
  await expect(toast.getByRole("button")).toHaveCount(0);
  // 툴바 실행취소로 되살리고 재실행으로 다시 지운다.
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect(toast).toHaveText("‘숨길 업무’ 업무를 되살렸습니다.");
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  // 삭제 알림에는 실행취소 버튼이 없다.
  await expect(toast).toHaveText("‘숨길 업무’ 업무를 삭제했습니다.");
  await expect(toast.getByRole("button")).toHaveCount(0);
  await undo.click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await page.reload();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
});

test("새 업무 삭제는 이전 재실행을 비우고 삭제 재실행은 다음 기록을 보존한다", async ({
  page,
}) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const undo = toolbar.getByRole("button", { name: "실행취소", exact: true });
  const redo = toolbar.getByRole("button", { name: "재실행", exact: true });
  async function editTitle(target: Locator, text: string) {
    await target.dblclick();
    await target.getByRole("textbox").fill(text);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      target.getByRole("textbox").press("Enter"),
    ]);
    await expect(undo).toBeEnabled();
  }
  await editTitle(first, "첫 업무 수정");
  await undo.click();
  await expect(first).toHaveText("첫 업무");
  await expect(redo).toBeEnabled();
  await openRowDetails(page, page.locator(`[data-row-id="${taskIds[0]}"]`));
  await page
    .getByRole("button", { name: "휴지통으로 이동", exact: true })
    .click();
  await expect(first).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  // 삭제 뒤 다른 셀 편집까지 되돌렸다면 삭제 재실행 후 편집 재실행이 남는다.
  await editTitle(second, "숨길 업무 수정");
  await undo.click();
  await expect(second).toHaveText("숨길 업무");
  await undo.click();
  await expect(first).toHaveText("첫 업무");
  await redo.click();
  await expect(first).toHaveCount(0);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(second).toHaveText("숨길 업무 수정");
  await expect(redo).toBeDisabled();
  await page.reload();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveText("숨길 업무 수정");
});

test("저장된 필터는 닫기 버튼으로 닫고 휴지통으로 삭제한 뒤 알림에서 실행취소한다", async ({
  page,
}) => {
  const menu = page.locator(".saved-views");
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page.getByRole("button", { name: "현재 필터 저장" }).click();
  await page.getByLabel("필터 이름").fill("삭제할 보기");
  await page
    .locator("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.locator("dialog")).toHaveCount(0);
  const applied = page.getByRole("status", { name: "적용 중인 필터" });
  await expect(applied).toHaveText("삭제할 보기");
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(menu).toBeVisible();
  await page
    .getByRole("button", { name: "저장된 필터 닫기", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  // 바깥을 누르거나 Esc를 눌러도 닫힌다.
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(menu).toBeVisible();
  await page.locator(".sheet-scroll").click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(
    menu.getByRole("button", { name: "삭제할 보기", exact: true }),
  ).toBeVisible();
  await menu
    .getByRole("button", { name: "삭제할 보기 삭제", exact: true })
    .click();
  await expect(
    menu.getByRole("button", { name: "삭제할 보기", exact: true }),
  ).toHaveCount(0);
  await expect(applied).toHaveText("저장된 필터");
  const toast = page
    .getByRole("status")
    .filter({ hasText: "필터를 삭제했습니다" });
  await expect(toast).toContainText("‘삭제할 보기’ 필터를 삭제했습니다.");
  await toast.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(
    menu.getByRole("button", { name: "삭제할 보기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".toast")).toHaveText(
    "‘삭제할 보기’ 필터를 되살렸습니다.",
  );
  await expect(applied).toHaveText("저장된 필터");
  const views = (
    await (
      await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
    ).json()
  ).views.map((v: { name: string }) => v.name);
  expect(views).toContain("삭제할 보기");
});

test("검색·필터 저장과 읽기 전용 보고본의 원본 분리를 확인한다", async ({
  page,
}) => {
  await page.getByLabel("전체 속성 검색").fill("업무");
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await page.getByRole("button", { name: "저장된 필터" }).click();
  await page.getByRole("button", { name: "현재 필터 저장" }).click();
  await page.getByLabel("필터 이름").fill("나의 검토 업무");
  await page
    .locator("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "주간 보고본", exact: true }).click();
  await page.getByLabel("보고본 이름").fill("검증 보고본");
  await page.getByRole("button", { name: "현재 보기 3개 업무 저장" }).click();
  await expect(page.getByRole("button", { name: /검증 보고본/ })).toBeVisible();
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        expectedVersion: 1,
        value: "보고 이후 변경",
      },
    ],
  });
  await page.getByRole("button", { name: /검증 보고본/ }).click();
  await expect(
    page.getByRole("heading", { name: "검증 보고본" }),
  ).toBeVisible();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "첫 업무",
  );
  await expect(
    page.getByRole("button", { name: "굵게", exact: true }),
  ).toBeDisabled();
});
test("같은 셀의 연속 실행취소·재실행과 사이에 발생한 타인의 변경을 보호한다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const edit = async (text: string) => {
    await cell.dblclick();
    await page.locator(".inline-editor textarea").fill(text);
    await page.locator(".inline-editor textarea").press("Enter");
    await expect(cell).toHaveText(text);
  };
  await edit("첫 번째 수정");
  await edit("두 번째 수정");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(cell).toHaveText("첫 번째 수정");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(cell).toHaveText("첫 업무");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(cell).toHaveText("첫 번째 수정");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(cell).toHaveText("두 번째 수정");
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  const current = tasks.find((t: any) => t.id === taskIds[0]);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: current.id,
        key: "title",
        expectedVersion: current.cells.title.version,
        value: "타인의 다음 수정",
      },
    ],
  });
  // SSE has already delivered the new version, so undo rejects locally before
  // sending a stale write. Verify the protection rather than an HTTP-only UI.
  await expect(cell).toHaveText("타인의 다음 수정", { timeout: 3000 });
  let undoRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/cells/batch")
    )
      undoRequests++;
  });
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "이후 변경이 있어 되돌릴 수 없습니다",
  );
  expect(undoRequests).toBe(0);
  const latest = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks.find((t: any) => t.id === taskIds[0]);
  expect(latest.cells.title.value).toBe("타인의 다음 수정");
});
test("늦게 도착한 조회 응답이 저장한 입력을 덮어쓰지 않는다", async ({
  page,
}) => {
  let release: () => void = () => {};
  let held: () => void = () => {};
  const arrived = new Promise<void>((r) => (held = r));
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/tasks?**", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    held();
    await gate;
    await route.fulfill({ response });
  });
  await arrived;
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await cell.dblclick();
  await page
    .locator(".inline-editor textarea")
    .fill("조회보다 나중에 저장한 입력");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(cell).toHaveText("조회보다 나중에 저장한 입력");
  const response = page.waitForResponse((r) => r.url().includes("/api/tasks?"));
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.unroute("**/api/tasks?**");
  await expect(cell).toHaveText("조회보다 나중에 저장한 입력");
});
test("로그인 만료 후 같은 계정으로 재인증하고 미저장 입력을 복구한다", async ({
  page,
}) => {
  await page.context().clearCookies();
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await cell.dblclick();
  await page.locator(".inline-editor textarea").fill("로그인 만료 중 입력");
  await page.locator(".inline-editor textarea").press("Enter");
  await page.getByRole("button", { name: "입력 확인" }).click();
  await expect(page.locator(".failed-input")).toContainText(
    "로그인 만료 중 입력",
  );
  await page.getByLabel("계정 비밀번호").fill("local-test-only-password");
  await page.getByRole("button", { name: "로그인 후 재시도" }).click();
  await expect(cell).toHaveText("로그인 만료 중 입력");
  await expect(page.locator("dialog")).toHaveCount(0);
});
test("팀·연도 전환과 기간 선택은 표의 맨 왼쪽에서 시작한다", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-09T12:00:00+09:00") });
  const otherTeam = await post(page, "/admin/teams", {
    name: "스크롤 검증 " + randomUUID().slice(0, 8),
  });
  await post(page, "/tasks", {
    teamId: otherTeam.id,
    year: 2026,
    fields: { title: "다른 팀의 업무" },
  });
  await page.reload();
  const grid = page.getByRole("grid");
  const year = page.locator(".year-value");
  const left = () => grid.evaluate((el) => el.scrollLeft);
  const scrollAway = async () => {
    await grid.evaluate((el) => {
      el.scrollLeft = 650;
    });
    await expect.poll(left).toBeGreaterThan(0);
  };
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
  await expect.poll(left).toBe(0);
  await scrollAway();
  await page.getByLabel("팀 선택").selectOption(otherTeam.id);
  await expect(
    page.getByRole("gridcell", { name: "다른 팀의 업무", exact: true }),
  ).toBeVisible();
  await expect.poll(left).toBe(0);
  await scrollAway();
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(year).toHaveText("2027");
  await expect(year).toBeEnabled();
  await expect.poll(left).toBe(0);
  await scrollAway();
  await chooseYear(page, 2026);
  await expect(
    page.getByRole("gridcell", { name: "다른 팀의 업무", exact: true }),
  ).toBeVisible();
  await expect.poll(left).toBe(0);
  await scrollAway();
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
  await expect.poll(left).toBe(0);
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(year).toHaveText("2027");
  await expect(year).toBeEnabled();
  await page.getByRole("button", { name: "이전 연도", exact: true }).click();
  await expect(year).toHaveText("2026");
  await expect(year).toBeEnabled();
  await chooseMonths(page, 10);
  await expect(
    page.locator('[data-column="2026-10-05"]').first(),
  ).toBeInViewport();
  await expect.poll(left).toBe(0);
  await page.reload();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
  await expect.poll(left).toBe(0);
});

test("정확한 주차 범위·속성 묶음·열 메뉴의 고정 영역을 저장한다", async ({
  page,
}) => {
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[1],
        key: "category",
        expectedVersion: 1,
        value: "category-other",
      },
    ],
  });
  await page.reload();
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await groupByColumn(page, "category");
  await expect(page.locator(".group-heading")).toHaveCount(2);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "첫 업무",
  );
  await chooseWeeks(page, "2026-10-05", "2026-10-26");
  await freezeColumns(page, 2);
  await expect(page.getByRole("columnheader")).toHaveCount(9);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveCSS(
    "position",
    "sticky",
  );
  await expect(page.locator(`[data-cell="${taskIds[0]}:owner"]`)).toHaveCSS(
    "position",
    "relative",
  );
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/views?teamId=${teamId}&year=2026`);
      return (await r.json()).views.find((v: any) => v.name === "__current")
        ?.data.toWeek;
    })
    .toBe("2026-10-26");
  await page.reload();
  await expect(page.getByRole("columnheader")).toHaveCount(9);
  await expect(page.locator(".group-heading")).toHaveCount(2);
  await chooseWeeks(page, "2026-01-05");
  await expect(page.getByRole("columnheader")).toHaveCount(6);
  await freezeColumns(page, 0);
  await expect(page.locator(".header-cell.fixed")).toHaveCount(0);
  await expect(
    page.locator('[data-column="2026-01-05"]').first(),
  ).toBeInViewport();
});

test("셀 내부에서 바로 입력하고 Tab·포커스 이동으로 저장하며 Esc는 취소한다", async ({
  page,
}) => {
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`),
    second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  const rowHeight = (await first.boundingBox())!.height;
  await first.dblclick();
  expect((await first.boundingBox())!.height).toBe(rowHeight);
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(first.getByRole("textbox")).toBeFocused();
  await first.getByRole("textbox").fill("직접 입력\n두 번째 줄");
  expect((await first.boundingBox())!.height).toBe(rowHeight);
  await first.getByRole("textbox").press("Tab");
  await expect(first).toHaveText("직접 입력\n두 번째 줄");
  await expect(page.locator(`[data-cell="${taskIds[0]}:owner"]`)).toHaveClass(
    /focused/,
  );
  // 화면의 낙관적 표시와 서버 저장 완료는 별개이므로 다음 편집 전에 기다린다.
  await expect(page.locator(".save-status")).toHaveCount(0);
  await first.dblclick();
  await first.getByRole("textbox").fill("취소할 변경");
  await first.getByRole("textbox").press("Escape");
  await expect(first).toHaveText("직접 입력\n두 번째 줄");
  await first.dblclick();
  await first.getByRole("textbox").fill("포커스를 옮겨 저장");
  await second.click();
  await expect(first).toHaveText("포커스를 옮겨 저장");
  await expect(second).toHaveClass(/focused/);
  await expect(page.locator(".save-status")).toHaveCount(0);
  await second.press("F2");
  await expect(second.getByRole("textbox")).toBeFocused();
  await second.getByRole("textbox").fill("키보드 입력");
  await second.getByRole("textbox").press("Enter");
  await expect(second).toHaveText("키보드 입력");
  const third = page.locator(`[data-cell="${taskIds[2]}:title"]`);
  const from = (await first.boundingBox())!,
    to = (await third.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(second).toHaveCSS("font-weight", "700");
  await expect(third).toHaveCSS("font-weight", "700");
  await page.reload();
  await expect(first).toHaveText("포커스를 옮겨 저장");
  await expect(second).toHaveText("키보드 입력");
  await openRowDetails(
    page,
    page.locator(".sheet-row").filter({ has: second }),
  );
  await page
    .locator(".detail-fields > div")
    .filter({ has: page.locator("dt").filter({ hasText: /^설명$/ }) })
    .getByRole("button")
    .click();
  const description = page.locator(`[data-cell="${taskIds[1]}:description"]`);
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(description.getByRole("textbox")).toBeFocused();
  await description.getByRole("textbox").fill("숨긴 열도 셀에서 편집");
  await description.getByRole("textbox").press("Enter");
  await expect(description).toHaveText("숨긴 열도 셀에서 편집");
});

test("컬럼 클릭은 열을 선택하고 우클릭 메뉴에서 정렬·해제를 저장한다", async ({
  page,
}) => {
  const header = page.locator('[data-header-key="title"]');
  const button = page.getByRole("button", {
    name: "작업 열 선택",
    exact: true,
  });
  const titles = page.locator('[data-column="title"]');
  await button.click();
  await expect(header).toHaveAttribute("aria-selected", "true");
  await expect(header).toHaveAttribute("aria-sort", "none");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect(
    page.locator('[data-column="title"][aria-selected="true"]'),
  ).toHaveCount(3);
  await button.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "정렬 해제", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  for (const [action, order] of [
    ["오름차순 정렬", "ascending"],
    ["내림차순 정렬", "descending"],
    ["정렬 해제", "none"],
  ]) {
    await button.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "열 숨기기", exact: true }),
    ).toBeDisabled();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    await expect(header).toHaveAttribute("aria-sort", order);
    await expect(titles).toHaveText(
      order === "ascending"
        ? ["셋째 업무", "숨길 업무", "첫 업무"]
        : ["첫 업무", "숨길 업무", "셋째 업무"],
    );
  }
  await button.focus();
  await button.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await sortHeader(page, "작업");
  for (const other of [
    page.locator('[data-header-key="status"]'),
    page.locator(".week-heading").first(),
  ]) {
    await other.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "정렬 해제", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(header).toHaveAttribute("aria-sort", "ascending");
  }
  await button.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "정렬 해제", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.sortDirection,
    )
    .toBe("asc");
  await page.reload();
  await expect(titles).toHaveText(["셋째 업무", "숨길 업무", "첫 업무"]);
});

test("사용자 계정은 팀별 권한을 보여 주고 검색과 팀 구성원 이동을 제공한다", async ({
  page,
}, info) => {
  const suffix = randomUUID().slice(0, 6);
  const secondTeam = await post(page, "/admin/teams", {
    name: `협업 ${suffix}`,
  });
  const usernames = [
    `single-${suffix}@example.com`,
    `shared-${suffix}@example.com`,
    `unassigned-${suffix}@example.com`,
  ];
  const memberships = [
    [{ teamId, role: "member" }],
    [
      { teamId, role: "member" },
      { teamId: secondTeam.id, role: "lead" },
    ],
    [],
  ];
  for (const [i, username] of usernames.entries())
    await post(page, "/admin/users", {
      name: ["기획 담당", "협업 담당", "배속 대기"][i],
      username,
      password: "new-member-password",
      active: true,
      memberships: memberships[i],
    });
  const adminData = await (await page.request.get("/api/admin/users")).json();
  const firstName = adminData.teams.find((t: any) => t.id === teamId).name;
  const secondName = `협업 ${suffix}`;
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "사용자 계정", exact: true }).click();
  const rows = page.locator(".users-table tbody tr");
  const sharedRow = rows.filter({ hasText: usernames[1] });
  for (const username of usernames)
    await expect(rows.filter({ hasText: username })).toBeVisible();
  // 같은 사람이 팀마다 다른 팀 내 권한을 가진다.
  await expect(sharedRow.locator(".team-chips .tag")).toHaveCount(2);
  await expect(sharedRow).toContainText(`${firstName} · 팀원`);
  await expect(sharedRow).toContainText(`${secondName} · 팀장`);
  await expect(rows.filter({ hasText: usernames[2] })).toContainText(
    "소속 없음",
  );
  await page.getByLabel("사용자 검색").fill(`shared-${suffix}@example.com`);
  await expect(rows).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("user-accounts.png"),
    fullPage: true,
  });
  await page.getByLabel("사용자 검색").fill("");
  await expect(rows).toHaveCount(adminData.users.length);
  // 수정 폼은 누른 사용자 바로 아래에 열리고, 같은 버튼으로 닫는다.
  const editButton = sharedRow.getByRole("button", {
    name: "협업 담당 사용자 수정",
    exact: true,
  });
  await editButton.click();
  await expect(editButton).toHaveAttribute("aria-expanded", "true");
  await expect(editButton).toHaveText("닫기");
  const editRow = sharedRow.locator("+ tr.user-edit-row");
  await expect(editRow.getByLabel("이름", { exact: true })).toBeFocused();
  await expect(editRow.getByLabel("이름", { exact: true })).toHaveValue(
    "협업 담당",
  );
  await expect(page.locator(".settings-form")).toHaveCount(1);
  const activeSwitch = editRow.getByRole("switch", {
    name: "계정 활성화",
    exact: true,
  });
  await expect(activeSwitch).toBeChecked();
  // 폼을 여는 스크롤이 끝난 뒤 실제 보이는 스위치를 누른다.
  await editRow.locator(".switch-track").click();
  await expect(activeSwitch).not.toBeChecked();
  await expect(editRow.locator(".switch-field")).toContainText("비활성");
  await expect(editRow.locator(".switch-warning")).toBeVisible();
  await editButton.click();
  await expect(page.locator(".settings-form")).toHaveCount(0);
  await sharedRow
    .getByRole("button", { name: `${secondName} · 팀장`, exact: true })
    .click();
  await expect(page.locator(".settings-team-header h3")).toHaveText(secondName);
  await expect(
    page.getByRole("tab", { name: "구성원", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("combobox", { name: "협업 담당 팀 내 권한", exact: true }),
  ).toHaveValue("lead");
});

test("팀 구성원 탭에서 사용자를 추가하고 팀마다 다른 권한을 지정한다", async ({
  page,
}, info) => {
  const suffix = randomUUID().slice(0, 6),
    username = `member-${suffix}@example.com`,
    newName = `협업 ${suffix}`,
    renamed = `이름 변경 ${suffix}`;
  const original = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).name;
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "설정 메뉴" });
  await expect(nav.getByRole("button", { name: original })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("tab", { name: "일반", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // 계정은 시스템 › 사용자 계정에서 만들고, 팀 소속은 각 팀에서 정한다.
  await nav.getByRole("button", { name: "사용자 계정", exact: true }).click();
  await page.getByRole("button", { name: "사용자 추가", exact: true }).click();
  const form = page.locator(".settings-form");
  await form.getByLabel("이름", { exact: true }).fill("배속 검증");
  await form.getByLabel("아이디(이메일)", { exact: true }).fill(username);
  await form.getByLabel("초기 비밀번호").fill("new-member-password");
  await form.getByRole("button", { name: "사용자 저장", exact: true }).click();
  const memberRow = page
    .locator(".users-table tbody tr")
    .filter({ hasText: username });
  await expect(memberRow).toContainText("소속 없음");
  await nav.getByRole("button", { name: "새 팀", exact: true }).click();
  await page.getByLabel("신규 팀 이름").fill(newName);
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  await expect(page.locator(".settings-team-header h3")).toHaveText(newName);
  const addMember = async (role: string) => {
    await page
      .getByLabel("추가할 사용자", { exact: true })
      .selectOption({ label: `배속 검증 (${username})` });
    await page
      .getByLabel("추가할 사용자의 팀 내 권한", { exact: true })
      .selectOption(role);
    await page.getByRole("button", { name: "추가", exact: true }).click();
  };
  const roleSelect = page.getByRole("combobox", {
    name: "배속 검증 팀 내 권한",
    exact: true,
  });
  await addMember("lead");
  await expect(roleSelect).toHaveValue("lead");
  await nav.getByRole("button", { name: original }).click();
  // 팀을 바꿔도 같은 탭(구성원)을 유지한다.
  await expect(
    page.getByRole("tab", { name: "구성원", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await addMember("viewer");
  await expect(roleSelect).toHaveValue("viewer");
  await roleSelect.selectOption("member");
  await expect(
    page.getByText("배속 검증님의 권한을 팀원(으)로 변경했습니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("team-members.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "일반", exact: true }).click();
  await page.getByLabel("팀 이름", { exact: true }).fill(renamed);
  await page
    .getByRole("tabpanel")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.getByText("팀 정보를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole("button", { name: renamed })).toBeVisible();
  await nav.getByRole("button", { name: "사용자 계정", exact: true }).click();
  await expect(memberRow).toContainText(`${renamed} · 팀원`);
  await expect(memberRow).toContainText(`${newName} · 팀장`);
  await memberRow
    .getByRole("button", { name: `${newName} · 팀장`, exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "배속 검증 팀에서 제외", exact: true })
    .click();
  await expect(roleSelect).toHaveCount(0);
  const users = (await (await page.request.get("/api/admin/users")).json())
    .users;
  expect(users.find((u: any) => u.username === username).teamRoles).toEqual({
    [teamId]: "member",
  });
});

test("팀장은 자기 팀만 설정하고 시스템 메뉴 없이 기존 사용자를 추가한다", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const ledTeam = await post(page, "/admin/teams", {
    name: `팀장 팀 ${suffix}`,
  });
  const account = {
    username: `lead-${suffix}@example.com`,
    password: "lead-test-password",
  };
  await post(page, "/admin/users", {
    ...account,
    name: `팀장 ${suffix}`,
    active: true,
    memberships: [
      { teamId: ledTeam.id, role: "lead" },
      { teamId, role: "member" },
    ],
  });
  await post(page, "/admin/users", {
    username: `peer-${suffix}@example.com`,
    password: "peer-test-password",
    name: `동료 ${suffix}`,
    active: true,
  });
  await post(page, "/auth/login", account);
  await page.reload();
  await page.getByLabel("팀 선택").selectOption(teamId);
  // 팀원인 팀을 보고 있어도 팀장인 팀이 있으면 설정을 열 수 있다.
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "설정 메뉴" });
  await expect(nav.getByRole("listitem")).toHaveCount(1);
  await expect(
    nav.getByRole("button", { name: `팀장 팀 ${suffix}` }),
  ).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "사용자 계정" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "새 팀" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "팀 삭제" })).toHaveCount(0);
  await page.getByRole("tab", { name: "구성원", exact: true }).click();
  await page
    .getByLabel("추가할 사용자", { exact: true })
    .selectOption({ label: `동료 ${suffix} (peer-${suffix}@example.com)` });
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: `동료 ${suffix} 팀 내 권한`,
      exact: true,
    }),
  ).toHaveValue("member");
});

test("프로젝트 속성의 값·모양·색·순서를 편집하고 해당 속성으로 묶어 본다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "속성 추가", exact: true }).click();
  await expect(page.getByLabel("속성 이름", { exact: true })).toBeFocused();
  await expect(page.getByLabel("속성 이름", { exact: true })).toHaveValue("");
  await page.keyboard.insertText("프로젝트");
  await page.getByLabel("표시 모양").selectOption("dot");
  for (const [i, name] of [
    "A 프로젝트",
    "B 프로젝트",
    "C 프로젝트",
  ].entries()) {
    await page.getByRole("button", { name: "값 추가", exact: true }).click();
    await expect(
      page.getByLabel(`속성 값 ${i + 1} 이름`, { exact: true }),
    ).toBeFocused();
    await expect(
      page.getByLabel(`속성 값 ${i + 1} 이름`, { exact: true }),
    ).toHaveValue("");
    await page.keyboard.insertText(name);
  }
  await page.getByLabel("A 프로젝트 배경색").fill("#fff2c6");
  await page.getByLabel("A 프로젝트 점 색상").fill("#e84a2f");
  await page
    .getByRole("button", { name: "C 프로젝트 값 순서 이동", exact: true })
    .press("Alt+ArrowUp");
  await page
    .getByRole("button", { name: "C 프로젝트 값 순서 이동", exact: true })
    .press("Alt+ArrowUp");
  await expect(page.getByLabel("속성 값 1 이름", { exact: true })).toHaveValue(
    "C 프로젝트",
  );
  await page
    .getByRole("button", { name: "프로젝트 속성 순서 이동", exact: true })
    .press("Alt+ArrowUp");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("property-management.png"),
    fullPage: true,
  });
  const data = await (await page.request.get("/api/admin/users")).json();
  const property = data.teams
    .find((t: any) => t.id === teamId)
    .settings.properties.find((p: any) => p.name === "프로젝트");
  expect(property.values.map((v: any) => v.label)).toEqual([
    "C 프로젝트",
    "A 프로젝트",
    "B 프로젝트",
  ]);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  for (const [i, label] of [
    "A 프로젝트",
    "C 프로젝트",
    "B 프로젝트",
  ].entries()) {
    const cell = page.locator(`[data-cell="${taskIds[i]}:${property.id}"]`);
    await cell.dblclick();
    await page
      .getByRole("listbox", { name: "프로젝트 편집", exact: true })
      .getByRole("option", { name: label, exact: true })
      .click();
    await expect(cell).toHaveText(label);
  }
  const first = page.locator(`[data-cell="${taskIds[0]}:${property.id}"]`);
  await expect(first.locator(".property-dot > i")).toHaveCSS(
    "background-color",
    "rgb(232, 74, 47)",
  );
  await expect(first.locator(".property-dot")).toHaveCSS(
    "background-color",
    "rgb(255, 242, 198)",
  );
  await groupByColumn(page, property.id);
  await expect(page.locator(".group-heading")).toHaveCount(3);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "숨길 업무",
    "첫 업무",
    "셋째 업무",
  ]);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page
    .locator(".property-select")
    .filter({ hasText: "프로젝트" })
    .click();
  await page.getByLabel("속성 이름", { exact: true }).fill("제품 프로젝트");
  await page.getByLabel("속성 값 2 이름", { exact: true }).fill("A 서비스");
  await page.getByLabel("표시 모양").selectOption("emoji");
  await expect(
    page.locator('.property-editor input[type="color"]'),
  ).toHaveCount(0);
  await page.getByLabel("A 서비스 이모지").fill("🚀");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(first).toHaveText("🚀A 서비스");
  await first.locator(".property-badge").click();
  await expect(
    page.getByRole("listbox", { name: "제품 프로젝트 편집", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.groupBy,
    )
    .toBe(property.id);
  await page.reload();
  await expect(first).toHaveText("🚀A 서비스");
  await expectGroupedBy(page, property.id);
  await page.screenshot({
    path: info.outputPath("property-groups.png"),
    fullPage: true,
  });
});

test("속성은 칩·글자만 한 번 눌러 아래 목록을 열고 행 높이를 유지한다", async ({
  page,
}, info) => {
  const category = page.locator(`[data-cell="${taskIds[0]}:category"]`);
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const height = (await category.boundingBox())!.height;
  await category.click({ position: { x: 4, y: 4 } });
  await expect(category).toHaveClass(/focused/);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await title.click();
  await expect(title.getByRole("textbox")).toHaveCount(0);
  await category
    .getByRole("button", { name: "분류 선택", exact: true })
    .click();
  const popup = page.getByRole("listbox", { name: "분류 편집", exact: true });
  await expect(popup).toBeVisible();
  expect((await category.boundingBox())!.height).toBe(height);
  const cellBox = (await category.boundingBox())!,
    popupBox = (await popup.boundingBox())!;
  expect(popupBox.y).toBeGreaterThanOrEqual(cellBox.y + cellBox.height);
  await popup.getByRole("option", { name: "UX 개선", exact: true }).click();
  await expect(category).toHaveText("UX 개선");
  await category.locator(".property-badge").click();
  await expect(popup).toBeVisible();
  await page.screenshot({
    path: info.outputPath("property-single-click.png"),
    fullPage: true,
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(category).toHaveText("차별화");
  expect((await category.boundingBox())!.height).toBe(height);
  await category.locator(".property-badge").click();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(category).toHaveText("차별화");

  await setColumns(page, ["지원자"]);
  const supporters = page.locator(`[data-cell="${taskIds[0]}:supporters"]`);
  const before = (await supporters.boundingBox())!.height;
  await expect(supporters).toHaveText("");
  await supporters.dblclick();
  const people = page.getByRole("listbox", {
    name: "지원자 편집",
    exact: true,
  });
  await expect(people).toHaveAttribute("aria-multiselectable", "true");
  expect((await supporters.boundingBox())!.height).toBe(before);
  const option = people.getByRole("option").first(),
    name = await option.innerText();
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(people).toHaveCount(0);
  await expect(supporters).toContainText(name.trim());
  expect((await supporters.boundingBox())!.height).toBe(before);
  await supporters
    .getByRole("button", { name: "지원자 선택", exact: true })
    .click();
  await people.getByRole("option").first().click();
  await page.keyboard.press("Escape");
  await expect(supporters).toContainText(name.trim());
});

test("모든 셀과 날짜 셀은 편집·넘침·밀도에 관계없이 좌우 여백 4px를 사용한다", async ({
  page,
}) => {
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const week = page.locator(`[data-cell="${taskIds[0]}:2025-12-29"]`);
  for (const target of [
    title,
    week,
    page.locator(".week-heading").first(),
    title.locator(".cell-overflow-content"),
  ]) {
    await expect(target).toHaveCSS("padding-left", "4px");
    await expect(target).toHaveCSS("padding-right", "4px");
  }
  await week.dblclick();
  await expect(week.getByRole("textbox")).toHaveCSS("padding-left", "4px");
  await expect(week.getByRole("textbox")).toHaveCSS("padding-right", "4px");
  await week.getByRole("textbox").fill("주간 일정");
  await week.getByRole("textbox").press("Tab");
  await expect(week.locator(".cell-overflow-content")).toHaveCSS(
    "padding-left",
    "4px",
  );
  await week.click();
  await selectFormat(page.getByLabel("텍스트 표시", { exact: true }), "wrap");
  await expect(week).toHaveCSS("padding-right", "4px");
  await title.dblclick();
  await expect(title.getByRole("textbox")).toHaveCSS("padding-left", "4px");
  await title.getByRole("textbox").press("Escape");
  await setDensity(page, "dense");
  await expect(title).toHaveCSS("padding-left", "4px");
  await expect(week).toHaveCSS("padding-right", "4px");
});

test("6pt와 새 글꼴을 기본 서식·복사·외부 HTML 붙여넣기에 유지한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "기본 서식", exact: true }).click();
  await selectDefaultFormat(page, "글꼴", "Pretendard");
  await selectDefaultFormat(page, "글자 크기", "6");
  await page
    .getByRole("button", { name: "기본 서식 저장", exact: true })
    .click();
  await expect(
    page.getByText("기본 서식을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "작업 편집", exact: true });
  await editor.fill("한글과 영문 Pretendard 6pt");
  await editor.press("Enter");
  const added = page.locator('[data-column="title"]').last();
  await expect(added).toHaveCSS("font-size", "8px");
  await expect(added).toHaveCSS("font-family", /^Pretendard|^"Pretendard"/);
  expect(
    await page.evaluate(async () => {
      const fonts = await document.fonts.load("12px Pretendard", "한글");
      return (
        fonts.length > 0 && fonts.every((font) => font.status === "loaded")
      );
    }),
  ).toBe(true);
  await added.click();
  const copied = await copyContents(page);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await pasteContents(page, copied);
  await expect(first).toHaveCSS("font-size", "8px");
  await expect(first).toHaveCSS("font-family", /Pretendard/);
  await selectFormat(page.getByLabel("글꼴", { exact: true }), "맑은 고딕");
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "7");
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "6");
  await expect(first).toHaveCSS("font-family", /Malgun Gothic.*Pretendard/);
  await expect(first).toHaveCSS("font-size", "8px");
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await second.click();
  await pasteContents(page, {
    "text/html":
      '<table><tr><td style="font-family:Malgun Gothic; font-size:6pt">맑은 고딕 HTML</td></tr></table>',
  });
  await expect(second).toHaveText("맑은 고딕 HTML");
  await expect(second).toHaveCSS("font-size", "8px");
  await page.reload();
  await expect(second).toHaveCSS("font-family", /Malgun Gothic.*Pretendard/);
  await expect(second).toHaveCSS("font-size", "8px");
  await second.click();
  await page.getByLabel("글자 크기", { exact: true }).click();
  await expect(
    page.getByRole("option", { name: "6", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: info.outputPath("six-point-fonts.png"),
    fullPage: true,
  });
});

test("업무 상세는 속성·정보·동작을 구분하고 작은 화면에서도 셀 편집으로 이동한다", async ({
  page,
}, info) => {
  await setTaskCells(page, [
    { index: 0, key: "title", value: "권한 관리 화면 프로토타입" },
    {
      index: 0,
      key: "description",
      value:
        "관리자와 팀원의 권한을 확인합니다.\n모바일 화면에서도 설정을 검토합니다.",
    },
    { index: 0, key: "deadline", value: "2026-10-30" },
  ]);
  await page.reload();
  const row = page.locator(`[data-row-id="${taskIds[0]}"]`);
  await openRowDetails(page, row);
  const dialog = page.locator(".task-detail-modal");
  await expect(dialog.locator(".task-detail-title")).toHaveText(
    "권한 관리 화면 프로토타입",
  );
  await expect(
    dialog
      .getByRole("button", { name: "상태 수정", exact: true })
      .locator(".property-badge"),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("button", { name: "팀원 수정", exact: true })
      .locator(".avatar"),
  ).toBeVisible();
  await expect(dialog.locator(".task-detail-meta code")).toBeHidden();
  await expect(
    dialog
      .getByRole("group", { name: "업무 순서 이동", exact: true })
      .getByRole("button"),
  ).toHaveCount(2);
  const actions = dialog.locator(".task-detail-actions");
  const dialogBox = (await dialog.boundingBox())!;
  const actionsBox = (await actions.boundingBox())!;
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(
    dialogBox.y + dialogBox.height,
  );
  await dialog.screenshot({
    path: info.outputPath("task-detail-organized.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator(".task-detail-meta summary").click();
  await expect(dialog.locator("code")).toHaveText(taskIds[0]);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await dialog.screenshot({
    path: info.outputPath("task-detail-mobile.png"),
  });
  await dialog.getByRole("button", { name: "설명 수정", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const description = page.locator(`[data-cell="${taskIds[0]}:description"]`);
  await expect(description.getByRole("textbox")).toBeFocused();
  await description.getByRole("textbox").fill("상세 창에서 이동하여 수정");
  await description.getByRole("textbox").press("Tab");
  await expect(description).toHaveText("상세 창에서 이동하여 수정");
});

test("주간 날짜 헤더는 월/일 한 줄·절반 너비이며 정렬하지 않는다", async ({
  page,
}, info) => {
  const week = page.locator(".week-heading").first();
  await expect(week).toHaveText("1/2");
  await expect(week).toHaveCSS("width", "40px");
  await expect(week).toHaveCSS("height", "32px");
  await expect(page.locator(".sheet-header")).toHaveCSS("height", "32px");
  await expect(
    week.getByRole("button", { name: "1/2 주차 열 선택", exact: true }),
  ).toBeVisible();
  expect(await week.getAttribute("aria-sort")).toBeNull();
  await sortHeader(page, "작업");
  const rows = page.locator('[data-column="title"]');
  await expect(rows).toHaveText(["셋째 업무", "숨길 업무", "첫 업무"]);
  await week.click();
  await expect(rows).toHaveText(["셋째 업무", "숨길 업무", "첫 업무"]);
  await week.click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect(page.locator(".week-heading").first()).toHaveText("1/9");
  await page
    .locator('.hidden-column-reveal[data-hidden-columns~="2025-12-29"]')
    .click();
  await expect(week).toHaveText("1/2");
  await page.screenshot({
    path: info.outputPath("compact-date-columns.png"),
    fullPage: true,
  });
});

async function setTaskCells(
  page: Page,
  entries: { index: number; key: string; value: string }[],
) {
  const current = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: entries.map((e) => ({
      taskId: taskIds[e.index],
      key: e.key,
      value: e.value,
      expectedVersion:
        current.find((t: any) => t.id === taskIds[e.index]).cells[e.key]
          ?.version || 0,
    })),
  });
}

async function dragRow(
  page: Page,
  sourceId: string,
  targetId: string,
  placement: "before" | "after",
  whileDragging?: () => Promise<void>,
) {
  const source = page.locator(`[data-row-id="${sourceId}"] .row-drag-handle`);
  const target = page.locator(`[data-row-id="${targetId}"]`);
  await source.scrollIntoViewIfNeeded();
  await page.getByRole("grid").evaluate((el) => {
    el.scrollLeft = 0;
  });
  const a = (await source.boundingBox())!,
    b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    a.x + a.width / 2,
    placement === "before" ? b.y + 5 : b.y + b.height - 5,
    { steps: 12 },
  );
  await whileDragging?.();
  await page.mouse.up();
}

test("행 번호 가운데는 선택하고 왼쪽 손잡이는 겹침 없이 한 행을 이동한다", async ({
  page,
}) => {
  const first = page.locator(`[data-row-id="${taskIds[0]}"]`);
  const number = first.locator(".row-number");
  await number.hover();
  const handle = (await first.locator(".row-drag-handle").boundingBox())!;
  const select = (await first.locator(".row-select").boundingBox())!;
  expect(handle.x + handle.width).toBeLessThanOrEqual(select.x);
  await expect(first.locator(".row-menu-trigger")).toHaveCount(0);
  const numberBox = (await number.boundingBox())!;
  expect(numberBox.width).toBeLessThanOrEqual(50);
  expect(select.x).toBeCloseTo(handle.x + handle.width, 0);
  expect(select.x + select.width).toBeCloseTo(
    numberBox.x + numberBox.width - 1,
    0,
  );
  await page.mouse.click(
    // This is the space just after the handle, well before the number text.
    select.x + 2,
    select.y + select.height / 2,
  );
  await expect(number).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".row-drag-preview")).toHaveCount(0);
  await dragRow(page, taskIds[0], taskIds[2], "after");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "숨길 업무",
    "셋째 업무",
    "첫 업무",
  ]);
  await page.reload();
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "숨길 업무",
    "셋째 업무",
    "첫 업무",
  ]);
});

test("선택한 여러 행은 어느 손잡이에서든 순서를 유지하며 함께 이동하고 Esc로 취소한다", async ({
  page,
}, info) => {
  const first = page.getByRole("button", {
    name: "1행 전체 선택",
    exact: true,
  });
  await first.click();
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click({ modifiers: ["Shift"] });
  await dragRow(page, taskIds[1], taskIds[2], "after", async () => {
    await expect(page.locator(".row-drag-preview")).toContainText("2개 행");
    await expect(page.locator(".sheet-row.row-dragging")).toHaveCount(2);
    await page.keyboard.press("Escape");
  });
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await expect(
    page.locator('[role="rowheader"][aria-selected="true"]'),
  ).toHaveCount(2);
  const moved = page.waitForResponse(
    (r) => r.url().endsWith("/api/tasks/reorder") && r.ok(),
  );
  await dragRow(page, taskIds[1], taskIds[2], "after", async () => {
    await expect(page.locator(".row-drag-preview")).toContainText("2개 행");
    await expect(page.locator(".sheet-row.row-dragging")).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath("multiple-row-drag.png"),
      fullPage: true,
    });
  });
  expect(
    (await moved)
      .request()
      .postDataJSON()
      .tasks.map((t: any) => t.id),
  ).toEqual(taskIds.slice(0, 2));
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "셋째 업무",
    "첫 업무",
    "숨길 업무",
  ]);
  await expect(
    page.locator('[role="rowheader"][aria-selected="true"]'),
  ).toHaveCount(2);
  // Alt+Arrow on a selected handle moves the same block back up.
  await page
    .getByRole("button", { name: "숨길 업무 순서 이동", exact: true })
    .focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await page.reload();
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
});

test("숨긴 행을 건너뛰어 여러 행을 선택하고 보이는 행만 함께 이동한다", async ({
  page,
}) => {
  const added = await post(page, "/tasks", {
    teamId,
    year: 2026,
    fields: { title: "넷째 업무" },
  });
  taskIds.push(added.task.id);
  await page.reload();
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "3행 전체 선택", exact: true })
    .click({ modifiers: ["Shift"] });
  await dragRow(page, taskIds[2], taskIds[3], "after");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "넷째 업무",
    "첫 업무",
    "셋째 업무",
  ]);
  const saved = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  expect(saved.map((t: any) => t.cells.title.value)).toEqual([
    "숨길 업무",
    "넷째 업무",
    "첫 업무",
    "셋째 업무",
  ]);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.hiddenRows,
    )
    .toEqual([taskIds[1]]);
  await page.reload();
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "넷째 업무",
    "첫 업무",
    "셋째 업무",
  ]);
});

test("여러 행 이동은 묶음 경계를 지키고 정렬 해제 후 손잡이를 다시 사용할 수 있다", async ({
  page,
}) => {
  await setTaskCells(page, [
    { index: 2, key: "category", value: "category-new" },
  ]);
  await page.reload();
  await groupByColumn(page, "category");
  await page
    .getByRole("button", { name: "1행 전체 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click({ modifiers: ["Shift"] });
  await dragRow(page, taskIds[1], taskIds[2], "after", async () => {
    await expect(page.locator(".row-drag-preview.invalid")).toContainText(
      "같은 묶음 안에서만",
    );
    await expect(page.locator(".sheet-row.row-dragging")).toHaveCount(2);
  });
  await expect(page.getByRole("alert")).toContainText("같은 묶음 안에서만");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await page.getByRole("button", { name: "알림 닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "2행 전체 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "3행 전체 선택", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.locator(`[data-row-id="${taskIds[1]}"] .row-drag-handle`).click();
  await expect(page.getByRole("alert")).toContainText("같은 묶음의 행만");
  await expect(page.locator(".row-drag-preview")).toHaveCount(0);
  await sortHeader(page, "작업");
  await expect(page.locator(".row-drag-handle:disabled")).toHaveCount(3);
  await sortHeader(page, "작업", "정렬 해제");
  await expect(page.locator(".row-drag-handle:disabled")).toHaveCount(0);
  await dragRow(page, taskIds[0], taskIds[1], "after");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "숨길 업무",
    "첫 업무",
    "셋째 업무",
  ]);
});

test("묶음·정렬 중에도 새 업무는 미지정 묶음의 맨 아래에 추가된다", async ({
  page,
}) => {
  await setTaskCells(page, [
    { index: 1, key: "category", value: "category-new" },
  ]);
  await page.reload();
  await groupByColumn(page, "category");
  await sortHeader(page, "작업");
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "작업 편집", exact: true });
  await expect(editor).toBeFocused();
  await expect(
    page.locator('[data-column="title"]').last().getByRole("textbox"),
  ).toBeFocused();
  await editor.fill("맨 아래 새 업무");
  await editor.press("Enter");
  await expect(page.locator('[data-column="title"]').last()).toHaveText(
    "맨 아래 새 업무",
  );
  await expect(page.locator(".group-heading").last()).toContainText(
    "분류 미지정",
  );
  await expect(
    page.getByRole("columnheader").filter({
      has: page.getByRole("button", { name: "작업 열 선택", exact: true }),
    }),
  ).toHaveAttribute("aria-sort", "none");
  await page.reload();
  await expect(page.locator('[data-column="title"]').last()).toHaveText(
    "맨 아래 새 업무",
  );
});

test("번호 열을 드래그해 순서를 저장하고 묶음 경계 이동은 막는다", async ({
  page,
}, info) => {
  const dragged = page.locator(`[data-row-id="${taskIds[0]}"]`);
  // The source stays identifiable even before the pointer reaches another row.
  const handle = (await dragged.locator(".row-drag-handle").boundingBox())!;
  await page.mouse.move(handle.x + 10, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 24, handle.y + handle.height / 2);
  await expect(dragged).toHaveClass(/row-dragging/);
  await expect(dragged.locator('[data-column="title"]')).toHaveCSS(
    "opacity",
    "0.35",
  );
  await expect(page.locator(".row-drag-preview")).toContainText("첫 업무");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".row-drag-preview")).toHaveCount(0);
  await expect(dragged).not.toHaveClass(/row-dragging/);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await dragRow(page, taskIds[0], taskIds[2], "after", async () => {
    await expect(dragged).toHaveClass(/row-dragging/);
    await expect(page.locator(`[data-row-id="${taskIds[2]}"]`)).toHaveClass(
      /row-drop-after/,
    );
    await expect(page.locator(".row-drag-preview")).toContainText("표시된 선");
    await page.screenshot({
      path: info.outputPath("row-drag-feedback.png"),
      fullPage: true,
    });
  });
  await expect(page.locator(".row-drag-preview")).toHaveCount(0);
  const titles = page.locator('[data-column="title"]');
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무", "첫 업무"]);
  await page.reload();
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무", "첫 업무"]);
  await setTaskCells(page, [
    { index: 2, key: "category", value: "category-new" },
  ]);
  await page.reload();
  await groupByColumn(page, "category");
  await expect(titles).toHaveText(["숨길 업무", "첫 업무", "셋째 업무"]);
  await dragRow(page, taskIds[0], taskIds[1], "before");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await dragRow(page, taskIds[0], taskIds[2], "after", async () => {
    await expect(page.locator(".row-drag-preview.invalid")).toContainText(
      "같은 묶음 안에서만",
    );
    await expect(page.locator(`[data-row-id="${taskIds[2]}"]`)).toHaveClass(
      /row-drop-invalid/,
    );
    await expect(dragged.locator(".group-heading")).toHaveCSS("opacity", "1");
  });
  await expect(page.getByRole("alert")).toContainText("같은 묶음 안에서만");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await page.getByRole("button", { name: "알림 닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "첫 업무 순서 이동", exact: true })
    .focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(titles).toHaveText(["숨길 업무", "첫 업무", "셋째 업무"]);
  await page.screenshot({
    path: info.outputPath("row-reordering.png"),
    fullPage: true,
  });
});

test("기본 서식 탭의 설정은 새 업무에 적용하고 줄바꿈 내용은 첫 줄부터 보인다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "기본 서식", exact: true }).click();
  await selectDefaultFormat(page, "글꼴", "Nanum Gothic Coding");
  await selectDefaultFormat(page, "글자 크기", "16");
  const defaultAlignment = page
    .getByRole("dialog")
    .getByLabel("세로 정렬", { exact: true });
  await selectDefaultFormat(page, "세로 정렬", "middle");
  await selectDefaultFormat(page, "텍스트 표시", "wrap");
  await expect(defaultAlignment).toBeEnabled();
  await expect(defaultAlignment).toHaveAttribute("data-value", "middle");
  await selectDefaultFormat(page, "세로 정렬", "bottom");
  await expect(page.locator(".preview-cell").first()).toHaveCSS(
    "align-items",
    "safe flex-end",
  );
  await selectDefaultFormat(page, "텍스트 표시", "overflow");
  await expect(defaultAlignment).toHaveAttribute("data-value", "bottom");
  await selectDefaultFormat(page, "텍스트 표시", "wrap");
  await selectDefaultFormat(page, "세로 정렬", "middle");
  await page
    .getByRole("button", { name: "기본 서식 저장", exact: true })
    .click();
  await expect(
    page.getByText("기본 서식을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("default-format.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "업무 추가", exact: true })
    .click();
  const text = "첫 입력 문구\n두 번째 줄\n세 번째 줄\n네 번째 줄";
  await page
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill(text);
  await page
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .press("Enter");
  const title = page.locator('[data-column="title"]').last();
  await expect(title).toHaveText(text);
  await expect(title).toHaveCSS("font-family", /Nanum Gothic Coding/);
  expect(
    await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeCloseTo((16 * 4) / 3, 1);
  await expect(title).toHaveCSS("align-items", "safe center");
  const firstLineVisible = await title.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.querySelector("span")!.firstChild!, 0);
    range.setEnd(el.querySelector("span")!.firstChild!, 2);
    const text = range.getBoundingClientRect(),
      box = el.getBoundingClientRect();
    return text.top >= box.top && text.bottom <= box.bottom;
  });
  expect(firstLineVisible).toBe(true);
  expect(
    await page
      .locator(`[data-cell="${taskIds[0]}:title"]`)
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeCloseTo((9 * 4) / 3, 1);
  const id = await title.getAttribute("data-task-id");
  expect(
    await page
      .locator(`[data-cell="${id}:2026-01-05"]`)
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeCloseTo((16 * 4) / 3, 1);
  await page.reload();
  await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveText(text);
  await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveCSS(
    "align-items",
    "safe center",
  );
  const old = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await old.dblclick();
  await old.getByRole("textbox").fill(text);
  await old.getByRole("textbox").press("Enter");
  await old.click();
  await selectFormat(page.getByLabel("세로 정렬", { exact: true }), "middle");
  await selectFormat(page.getByLabel("텍스트 표시", { exact: true }), "wrap");
  await expect(page.getByLabel("세로 정렬", { exact: true })).toHaveAttribute(
    "data-value",
    "middle",
  );
  await expect(old).toHaveCSS("align-items", "safe center");
  await page.screenshot({
    path: info.outputPath("wrapped-top-alignment.png"),
    fullPage: true,
  });
});

test("줄바꿈과 세로 정렬은 독립적이고 넘치는 내용은 첫 줄부터 표시한다", async ({
  page,
}, info) => {
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const alignment = page.getByLabel("세로 정렬", { exact: true });
  const wrap = page.getByLabel("텍스트 표시", { exact: true });
  const metrics = () =>
    title.evaluate((el) => {
      const style = getComputedStyle(el);
      const cell = el.getBoundingClientRect();
      const text = el.querySelector(".cell-text")!.getBoundingClientRect();
      return {
        top:
          text.top -
          cell.top -
          parseFloat(style.borderTopWidth) -
          parseFloat(style.paddingTop),
        height: text.height,
        available:
          el.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
      };
    });
  async function aligned(mode: string, overflowing = false) {
    await selectFormat(alignment, mode);
    await expect(alignment).toHaveAttribute("data-value", mode);
    await expect
      .poll(async () => {
        const m = await metrics();
        const expected =
          overflowing || mode === "top"
            ? 0
            : (m.available - m.height) / (mode === "middle" ? 2 : 1);
        return Math.abs(m.top - expected);
      })
      .toBeLessThanOrEqual(1);
  }
  async function resizeRow(delta: number) {
    const handle = page.locator('[data-resize-row="0"]');
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + 1;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + delta);
    await page.mouse.up();
  }
  await setDensity(page, "dense");
  await title.click();
  await selectFormat(alignment, "middle");
  for (const mode of ["middle", "bottom", "top"]) {
    await aligned(mode);
    const before = await metrics();
    await selectFormat(
      wrap,
      (await wrap.getAttribute("data-value")) === "wrap" ? "overflow" : "wrap",
    );
    await expect(alignment).toHaveAttribute("data-value", mode);
    await aligned(mode);
    expect(Math.abs((await metrics()).top - before.top)).toBeLessThanOrEqual(1);
    await selectFormat(
      wrap,
      (await wrap.getAttribute("data-value")) === "wrap" ? "overflow" : "wrap",
    );
    await expect(alignment).toHaveAttribute("data-value", mode);
  }
  await selectFormat(
    wrap,
    (await wrap.getAttribute("data-value")) === "wrap" ? "overflow" : "wrap",
  );
  await resizeRow(80);
  const text = "첫 번째 줄\n두 번째 줄\n세 번째 줄";
  await title.dblclick();
  await title.getByRole("textbox").fill(text);
  await title.getByRole("textbox").press("Enter");
  await title.click();
  const fitting = await metrics();
  expect(fitting.height).toBeLessThan(fitting.available);
  for (const mode of ["top", "bottom", "middle"]) await aligned(mode);
  await page.screenshot({
    path: info.outputPath("wrap-alignment-fitting.png"),
    fullPage: true,
  });
  await resizeRow(-80);
  await title.click();
  const overflowing = await metrics();
  expect(overflowing.height).toBeGreaterThan(overflowing.available);
  for (const mode of ["bottom", "top", "middle"]) await aligned(mode, true);
  const copied = await copyContents(page);
  expect(copied["text/html"]).toContain("vertical-align:middle");
  expect(copied["text/html"]).toContain("white-space:pre-wrap");
  const target = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await target.click();
  await pasteContents(page, { "text/html": copied["text/html"] });
  await expect(target).toHaveText(text);
  await expect(target).toHaveCSS("align-items", "safe center");
  await expect(alignment).toHaveAttribute("data-value", "middle");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.rowHeights[
          taskIds[0]
        ],
    )
    .toBe(26);
  await page.reload();
  await expect(title).toHaveText(text);
  await title.click();
  await expect(alignment).toHaveAttribute("data-value", "middle");
  await expect(wrap).toHaveAttribute("data-value", "wrap");
  await aligned("middle", true);
  await page.screenshot({
    path: info.outputPath("wrap-alignment-overflow.png"),
    fullPage: true,
  });
});

test("헤더의 속성 다중 필터·월 드래그 선택을 저장한다", async ({
  page,
}, info) => {
  const data = await (await page.request.get("/api/admin/users")).json();
  const settings = data.teams.find((t: any) => t.id === teamId).settings;
  const pid = `prop_${randomUUID()}`;
  settings.properties.push({
    id: pid,
    name: "프로젝트",
    display: "text",
    values: ["A", "B", "C"].map((label) => ({
      id: label.toLowerCase(),
      label,
      backgroundColor: "#edf6f4",
      dotColor: "#177b70",
      emoji: "📌",
    })),
  });
  const response = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: settings,
  });
  expect(response.ok()).toBeTruthy();
  await setTaskCells(page, [
    { index: 0, key: pid, value: "a" },
    { index: 1, key: pid, value: "b" },
    { index: 2, key: pid, value: "c" },
    { index: 1, key: "status", value: "status-progress" },
    { index: 2, key: "status", value: "status-progress" },
  ]);
  await page.reload();
  const dates = page.locator(".date-controls"),
    filters = page.locator(".view-bar");
  await expect(
    dates.getByRole("button", { name: "2026년 전체 선택" }),
  ).toBeVisible();
  await expect(
    dates.getByRole("group", { name: "월·주차 기간 선택" }),
  ).toBeVisible();
  await expect(
    filters.getByRole("button", { name: "모든 팀원", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "보기 설정", exact: true }),
  ).toHaveCount(0);
  await expect(filters.locator(".property-filter")).toHaveCount(0);
  await page
    .getByRole("button", { name: "프로젝트 열 선택", exact: true })
    .click({ button: "right" });
  const project = page.getByRole("group", {
    name: "프로젝트 필터 선택",
    exact: true,
  });
  await project.getByRole("checkbox", { name: "A", exact: true }).check();
  await project.getByRole("checkbox", { name: "B", exact: true }).check();
  const titles = page.locator('[data-column="title"]');
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await page
    .getByRole("button", { name: "상태 열 선택", exact: true })
    .click({ button: "right" });
  const status = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await status.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await expect(titles).toHaveText(["숨길 업무"]);
  await status.getByRole("checkbox", { name: "예정", exact: true }).check();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data.propertyFilters
          ?.status?.length,
    )
    .toBe(2);
  await page.reload();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  for (const [from, to] of [
    [1, 3],
    [4, 6],
    [7, 9],
    [10, 12],
    [1, 6],
    [7, 12],
  ]) {
    await chooseMonths(page, from, to);
    await expect(
      page.getByRole("button", { name: `${from}월 전체`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: `${to}월 전체`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const labels = await page
      .locator(".week-heading .week-label")
      .allTextContents();
    expect(
      labels.every(
        (label) =>
          (Number(label.split("/")[0]) >= Number(from) &&
            Number(label.split("/")[0]) <= Number(to)) ||
          (to === 12 && label === "1/1"),
      ),
    ).toBeTruthy();
  }
  await page.screenshot({
    path: info.outputPath("property-filters-periods.png"),
    fullPage: true,
  });
});

test("헤더 필터는 일치·제외 전환과 미지정·빈 결과를 처리하고 새로고침 후 유지한다", async ({
  page,
}, info) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-completed" },
    { index: 1, key: "status", value: "status-progress" },
    { index: 2, key: "status", value: "" },
  ]);
  await page.reload();
  const titles = page.locator('[data-column="title"]');
  const open = async (name: string) => {
    await page
      .getByRole("button", { name: `${name} 열 선택`, exact: true })
      .click({ button: "right" });
    return page.getByRole("group", { name: `${name} 필터 선택`, exact: true });
  };
  await expect(
    page
      .locator(".view-bar")
      .getByRole("button", { name: "상태 필터", exact: true }),
  ).toHaveCount(0);
  const status = await open("상태");
  const search = status.getByRole("searchbox");
  await search.fill("완");
  await search.press("ArrowDown");
  await expect(search).toBeFocused();
  await expect(
    status.getByRole("checkbox", { name: "진행 중", exact: true }),
  ).toHaveCount(0);
  await status.getByRole("checkbox", { name: "완료", exact: true }).check();
  await expect(titles).toHaveText(["첫 업무"]);
  await status.getByRole("radio", { name: "일치", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    status.getByRole("radio", { name: "제외", exact: true }),
  ).toBeChecked();
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무"]);
  await search.fill("");
  const modeBox = (await status.getByRole("radiogroup").boundingBox())!;
  const clearBox = (await status
    .getByRole("button", { name: "상태 필터 해제" })
    .boundingBox())!;
  expect(modeBox.x + modeBox.width).toBeLessThan(clearBox.x);
  const menuBox = (await page.locator(".grid-header-menu").boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(8);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(
    page.viewportSize()!.height - 7,
  );
  await page.screenshot({
    path: info.outputPath("header-exclude-filter.png"),
    fullPage: true,
  });
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
          ).json()
        ).views.find((v: any) => v.name === "__current")?.data
          .propertyFilterModes,
    )
    .toEqual({ status: "exclude" });
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무"]);
  await expect(page.getByRole("img", { name: "상태 필터 적용" })).toBeVisible();
  await open("상태");
  await expect(
    status.getByRole("radio", { name: "제외", exact: true }),
  ).toBeChecked();
  await expect(
    status.getByRole("checkbox", { name: "완료", exact: true }),
  ).toBeChecked();
  await status.getByRole("checkbox", { name: "미지정", exact: true }).check();
  await expect(titles).toHaveText(["숨길 업무"]);
  await status.getByRole("button", { name: "상태 필터 해제" }).click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect(page.getByRole("img", { name: "상태 필터 적용" })).toHaveCount(
    0,
  );
  const title = await open("작업");
  await expect(
    title.getByRole("radio", { name: "일치", exact: true }),
  ).toBeChecked();
  await title.getByRole("checkbox", { name: "첫 업무", exact: true }).check();
  await expect(titles).toHaveText(["첫 업무"]);
  await title.getByRole("checkbox", { name: "숨길 업무", exact: true }).check();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await title.getByRole("radio", { name: "제외", exact: true }).check();
  await expect(titles).toHaveText(["셋째 업무"]);
  await title.getByRole("checkbox", { name: "셋째 업무", exact: true }).check();
  await expect(titles).toHaveCount(0);
  await expect(title).toBeVisible();
  await title.getByRole("button", { name: "작업 필터 해제" }).click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await page.keyboard.press("Escape");
  await page.locator(".week-heading").first().click({ button: "right" });
  await expect(page.locator(".property-filter")).toHaveCount(0);
});

test("초기 조회 중에는 보기와 업무 추가를 잠그고 조회 후 묶음 선택을 보존한다", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?**", async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload();
  await expect(
    page.getByLabel("전체 속성 검색", { exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".sheet-scroll")).toHaveCount(0);
  await expect(
    page
      .locator(".heading-actions")
      .getByRole("button", { name: "업무 추가", exact: true }),
  ).toBeDisabled();
  release();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
  await groupByColumn(page, "category");
  await expect(page.locator(".group-heading")).toHaveCount(1);
  await expectGroupedBy(page, "category");
});

test("셀 범위를 복사하면 빈 값·줄바꿈·서식이 함께 이동하고 실행취소된다", async ({
  page,
}, info) => {
  const weekA = "2025-12-29",
    weekB = "2026-01-05";
  const rich = {
    color: "#8766ad",
    backgroundColor: "#fff2c6",
    fontFamily: "Noto Serif KR",
    fontSize: 18,
    bold: true,
    italic: true,
    underline: true,
    strike: true,
    textAlign: "right",
    verticalAlign: "top",
    textMode: "wrap",
  };
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    changes: [
      {
        taskId: taskIds[0],
        key: weekA,
        value: '첫 줄\n"둘째 줄"',
        style: rich,
        expectedVersion: 0,
      },
      {
        taskId: taskIds[0],
        key: weekB,
        value: "",
        style: { backgroundColor: "#ffe6dd" },
        expectedVersion: 0,
      },
      {
        taskId: taskIds[1],
        key: weekA,
        value: "=SUM(A1:A2)",
        style: { bold: false, textMode: "overflow" },
        expectedVersion: 0,
      },
      {
        taskId: taskIds[1],
        key: weekB,
        value: "다음 셀",
        style: { color: "#24796d", textAlign: "center" },
        expectedVersion: 0,
      },
      {
        taskId: taskIds[2],
        key: weekA,
        value: "대상 원본",
        style: { bold: true, italic: true, backgroundColor: "#8766ad" },
        expectedVersion: 0,
      },
    ],
  });
  await page.reload();
  const start = page.locator(`[data-cell="${taskIds[0]}:${weekA}"]`);
  await start.click();
  await page
    .locator(`[data-cell="${taskIds[1]}:${weekB}"]`)
    .click({ modifiers: ["Shift"] });
  const copied = await copyContents(page);
  expect(copied["text/plain"]).toContain('""둘째 줄""');
  expect(copied["text/html"]).toContain("background-color:#fff2c6");
  const target = page.locator(`[data-cell="${taskIds[1]}:${weekA}"]`);
  await target.click();
  await pasteContents(page, copied);
  await expect(target).toHaveText('첫 줄\n"둘째 줄"');
  await expect(target).toHaveCSS("font-family", /Noto Serif KR/);
  await expect(target).toHaveCSS("font-size", "24px");
  await expect(target).toHaveCSS("font-weight", "700");
  await expect(target).toHaveCSS("font-style", "italic");
  await expect(target).toHaveCSS(
    "text-decoration-line",
    "underline line-through",
  );
  await expect(target).toHaveCSS("text-align", "right");
  await expect(target).toHaveCSS("align-items", "flex-start");
  await expect(target).toHaveCSS("white-space", "pre-wrap");
  await expect(target).toHaveCSS("color", "rgb(135, 102, 173)");
  await expect(target).toHaveCSS("background-color", "rgb(255, 242, 198)");
  const blank = page.locator(`[data-cell="${taskIds[1]}:${weekB}"]`),
    plain = page.locator(`[data-cell="${taskIds[2]}:${weekA}"]`);
  await expect(blank).toHaveText("");
  await expect(blank).toHaveCSS("background-color", "rgb(255, 230, 221)");
  await expect(plain).toHaveText("=SUM(A1:A2)");
  await expect(plain).toHaveCSS("font-weight", "400");
  await expect(plain).toHaveCSS("font-style", "normal");
  await expect(plain).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(target).toHaveText("=SUM(A1:A2)");
  await expect(plain).toHaveText("대상 원본");
  await expect(plain).toHaveCSS("background-color", "rgb(135, 102, 173)");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(target).toHaveCSS("font-size", "24px");
  await page.reload();
  await expect(target).toHaveCSS("background-color", "rgb(255, 242, 198)");
  await expect(blank).toHaveCSS("background-color", "rgb(255, 230, 221)");
  await page.screenshot({
    path: info.outputPath("formatted-paste.png"),
    fullPage: true,
  });
});

test("복사한 HTML은 서식을 유지하고 일반 텍스트는 대상 서식을 보존한다", async ({
  page,
}) => {
  const source = page.locator(`[data-cell="${taskIds[0]}:title"]`),
    target = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await source.click();
  await selectFormat(page.getByLabel("글자 크기"), "18");
  await expect(source).toHaveCSS("font-size", "24px");
  await page.getByLabel("배경색", { exact: true }).fill("#d1eee6");
  await expect(source).toHaveCSS("background-color", "rgb(209, 238, 230)");
  const copied = await copyContents(page);
  const contents = {
    "text/html": copied["text/html"],
    "text/plain": copied["text/plain"],
  };
  expect(contents["text/html"]).toContain("font-size:18pt");
  await target.click();
  await pasteContents(page, contents);
  await expect(target).toHaveText("첫 업무");
  await expect(target).toHaveCSS("font-size", "24px");
  await expect(target).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await pasteContents(page, { "text/plain": "일반 텍스트" });
  await expect(target).toHaveText("일반 텍스트");
  await expect(target).toHaveCSS("font-size", "24px");
  await expect(target).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await target.dblclick();
  const editor = page.getByRole("textbox", { name: "작업 편집", exact: true });
  await expect(editor).toBeVisible();
  await editor.evaluate((el) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["text/html"],
        getData: () =>
          '<table><tr><td style="font-size:36pt">편집 중</td></tr></table>',
      },
    });
    el.dispatchEvent(event);
  });
  await expect(editor).toBeVisible();
  await editor.press("Escape");
  await expect(target).toHaveText("일반 텍스트");
  await expect(target).toHaveCSS("font-size", "24px");
});

test("외부 HTML 표의 기본 서식만 가져오고 범위·속성 검증 실패는 모두 취소한다", async ({
  page,
}) => {
  const target = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await target.click();
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/cells/batch")) requests++;
  });
  await pasteContents(page, {
    "text/html":
      '<table><tr><td style="color:rgb(36,121,109);background-color:#fff2c6;font-family:Arial;font-size:24px;text-align:center;vertical-align:bottom;white-space:nowrap"><b>안전한 &lt;문구&gt;<br>둘째 줄</b><script>window.__pasteExecuted=true</script><img src="https://invalid.example/paste.png" onerror="window.__pasteExecuted=true"></td></tr></table>',
  });
  await expect(target).toHaveText("안전한 <문구>\n둘째 줄");
  await expect(target).toHaveCSS("background-color", "rgb(255, 242, 198)");
  await expect(target).toHaveCSS("color", "rgb(36, 121, 109)");
  await expect(target).toHaveCSS("font-size", "24px");
  await expect(target).toHaveCSS("font-family", /Noto Sans KR/);
  await expect(target).toHaveCSS("text-align", "center");
  expect(
    await page.evaluate(() => (window as any).__pasteExecuted),
  ).toBeUndefined();
  await expect(target.locator("script,img")).toHaveCount(0);
  await pasteContents(page, {
    "text/html":
      '<table><tr><td style="background-color:#000000">변경되면 안 됨</td><td>없는 담당자</td></tr></table>',
  });
  await expect(page.getByRole("alert")).toContainText(
    "정확히 연결할 수 없습니다",
  );
  await expect(target).toHaveText("안전한 <문구>\n둘째 줄");
  await expect(target).toHaveCSS("background-color", "rgb(255, 242, 198)");
  await pasteContents(page, {
    "text/html": '<table><tr><td colspan="2">병합된 값</td></tr></table>',
  });
  await expect(page.getByRole("alert")).toContainText("병합을 해제");
  await pasteContents(page, {
    "text/plain": Array(2001).fill("범위 초과").join("\t"),
  });
  await expect(page.getByRole("alert")).toContainText("2,000개");
  expect(requests).toBe(1);
});

test("상단은 한 줄이고 발표 모드에서 표만 표시한 뒤 필터·위치·편집으로 복귀한다", async ({
  page,
}, info) => {
  const heading = page.locator(".page-heading");
  const layout = await heading.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    fits: el.scrollWidth <= el.clientWidth,
    centers: [".heading-line", ".board-summary", ".heading-actions"].map(
      (s) => {
        const box = el.querySelector(s)!.getBoundingClientRect();
        return box.y + box.height / 2;
      },
    ),
  }));
  expect(layout.height).toBeLessThan(60);
  expect(layout.fits).toBeTruthy();
  expect(
    Math.max(...layout.centers) - Math.min(...layout.centers),
  ).toBeLessThan(2);
  await expect(heading.locator("p")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("compact-header.png"),
    fullPage: true,
  });
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await page.locator(`[data-cell="${taskIds[1]}:title"]`).click();
  await hideSelectedRows(page);
  await groupByColumn(page, "category");
  const grid = page.getByRole("grid");
  await grid.evaluate((el) => {
    el.scrollLeft = 450;
  });
  const scroll = await grid.evaluate((el) => el.scrollLeft);
  const groups = await page.locator(".group-heading").allTextContents();
  const rows = await page.locator('[data-column="title"]').allTextContents();
  let writes = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/cells/batch")) writes++;
  });
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(heading).toBeHidden();
  await expect(page.locator(".view-controls")).toBeHidden();
  await expect(page.locator(".format-toolbar")).toBeHidden();
  await expect(page.locator(".sheet-footer")).toBeHidden();
  await expect(grid).toHaveAttribute("aria-readonly", "true");
  const box = (await grid.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  expect(box.width).toBe(1366);
  expect(box.height).toBe(900);
  await expect(grid.locator("button,.column-resizer,.row-resizer")).toHaveCount(
    0,
  );
  await expect(page.locator('[data-column="title"]')).toHaveText(rows);
  await expect(page.locator(".group-heading")).toHaveText(groups);
  await first.dblclick();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  await page.keyboard.press("ControlOrMeta+z");
  await pasteContents(page, { "text/plain": "발표 중 변경 금지" });
  await first.click({ button: "right" });
  await expect(page.locator(".inline-editor,dialog")).toHaveCount(0);
  await expect(first).toHaveText("첫 업무");
  await expect(first).toHaveCSS("font-weight", "700");
  expect(writes).toBe(0);
  await page.mouse.move(600, 500);
  await expect(page.locator(".presentation-exit")).toHaveCSS("opacity", "0");
  await page.screenshot({
    path: info.outputPath("presentation.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(heading).toBeVisible();
  await expect(
    page.getByRole("button", { name: "발표 모드", exact: true }),
  ).toBeFocused();
  await expect(grid).toHaveAttribute("aria-readonly", "false");
  expect(await grid.evaluate((el) => el.scrollLeft)).toBe(scroll);
  await expectGroupedBy(page, "category");
  await expect(page.locator('[data-column="title"]')).toHaveText(rows);
  await first.dblclick();
  await expect(
    page.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await page
    .getByRole("button", { name: "발표 모드 종료 (Esc)", exact: true })
    .click();
  await expect(heading).toBeVisible();
});

test("빈 속성·값에 바로 입력하고 15자 제한과 하단 속성 삭제 확인을 제공한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "속성 추가", exact: true }).click();
  const name = page.getByLabel("속성 이름", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("속성 이름을 입력하세요");
  await expect(name).toBeFocused();
  await page.keyboard.insertText("검토 프로젝트");
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  const option = page.getByLabel("속성 값 1 이름", { exact: true });
  await expect(option).toBeFocused();
  await expect(option).toHaveValue("");
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  await expect(page.locator(".property-values tbody tr")).toHaveCount(1);
  await expect(option).toBeFocused();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("1~15자");
  await expect(option).toBeFocused();
  await option.pressSequentially("가나다라마바사아자차카타파하가나");
  await expect(option).toHaveValue("가나다라마바사아자차카타파하가");
  await expect(option).toHaveAttribute("maxlength", "15");
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  const second = page.locator(".property-values tbody tr").last();
  await expect(
    second.getByLabel("속성 값 2 이름", { exact: true }),
  ).toBeFocused();
  await second.getByRole("button", { name: /값 제거/ }).click();
  await expect(page.locator(".property-values tbody tr")).toHaveCount(1);
  const manager = page.locator(".properties-manager"),
    footer = manager.locator(".form-actions");
  const remove = footer.getByRole("button", {
    name: "선택 속성 삭제",
    exact: true,
  });
  await expect(remove).toBeVisible();
  await footer.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  const stored = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  const prop = stored.properties.find((p: any) => p.name === "검토 프로젝트");
  expect(prop.values).toHaveLength(1);
  await setTaskCells(page, [
    { index: 0, key: prop.id, value: prop.values[0].id },
  ]);
  let warning = "";
  page.once("dialog", async (d) => {
    warning = d.message();
    await d.dismiss();
  });
  await remove.click();
  expect(warning).toContain("검토 프로젝트");
  expect(warning).toContain("기존 업무 값은 보관");
  await expect(name).toHaveValue("검토 프로젝트");
  await page.screenshot({
    path: info.outputPath("property-entry-actions.png"),
    fullPage: true,
  });
  page.once("dialog", async (d) => {
    await d.accept();
  });
  await remove.click();
  await expect(
    manager.locator(".property-select").filter({ hasText: "검토 프로젝트" }),
  ).toHaveCount(0);
  await footer.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  const updated = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  expect(
    updated.properties.find((p: any) => p.id === prop.id).archived,
  ).toBeTruthy();
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    ).json()
  ).tasks;
  expect(tasks.find((t: any) => t.id === taskIds[0]).cells[prop.id].value).toBe(
    prop.values[0].id,
  );
  await manager
    .locator(".archived-properties summary")
    .filter({ hasText: "보관된 속성" })
    .click();
  await page
    .getByRole("button", { name: "검토 프로젝트 복원", exact: true })
    .click();
  await expect(name).toHaveValue("검토 프로젝트");
});

test("열 머리글 메뉴로 묶음을 바꾸고 저장·키보드 선택·해제를 처리한다", async ({
  page,
}, info) => {
  await setTaskCells(page, [
    { index: 1, key: "category", value: "category-new" },
    { index: 2, key: "status", value: "status-completed" },
  ]);
  await page.reload();
  await expect(page.locator(".group-control,.people-popover")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "모든 팀원", exact: true }),
  ).toHaveCount(0);
  await groupByColumn(page, "category");
  await expect(page.locator(".group-heading")).toHaveCount(2);
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json();
      return data.views.find((v: any) => v.name === "__current")?.data.groupBy;
    })
    .toBe("category");
  await page.reload();
  await expectGroupedBy(page, "category");
  await page.getByRole("button", { name: "상태 열 선택", exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".group-heading")).toHaveCount(2);
  await expectGroupedBy(page, "status");
  await page.locator(".week-heading").first().click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "묶음 해제", exact: true }).click();
  await expect(page.locator(".group-heading")).toHaveCount(0);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await page
    .getByRole("button", { name: "분류 열 선택", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "묶음 해제", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("header-group-menu.png"),
    fullPage: true,
  });
});

test("전체 속성 검색은 포커스와 긴 입력 중에도 테두리 안에 맞고 지울 수 있다", async ({
  page,
}, info) => {
  const input = page.getByLabel("전체 속성 검색", { exact: true });
  const box = page.locator(".search-box");
  const titles = page.locator('[data-column="title"]');
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: 900 });
    const before = (await box.boundingBox())!;
    await input.fill("아주 긴 전체 속성 검색 문장을 입력합니다 ".repeat(20));
    await expect(input).toBeFocused();
    const after = (await box.boundingBox())!;
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    const fits = await input.evaluate((el) => {
      const outer = el.parentElement!.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const ring =
        style.outlineStyle === "none"
          ? 0
          : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const clear = el
        .parentElement!.querySelector('[aria-label="검색 지우기"]')!
        .getBoundingClientRect();
      return (
        rect.left - ring >= outer.left - 2 &&
        rect.right + ring <= outer.right + 2 &&
        rect.top - ring >= outer.top - 2 &&
        rect.bottom + ring <= outer.bottom + 2 &&
        rect.right <= clear.left &&
        clear.right <= outer.right
      );
    });
    expect(fits).toBeTruthy();
    await input.fill("첫 업무");
    await expect(page.locator(".search-count")).toHaveText("1 / 1");
    await expect(titles).toHaveCount(3);
    await box.screenshot({
      path: info.outputPath(`search-focus-${width}.png`),
    });
    await page
      .getByRole("button", { name: "검색 지우기", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await expect(titles).toHaveCount(3);
  }
});

test("오버플로우는 빈 셀까지 표시하고 다음 값 앞에서 자르며 세 모드와 서식을 저장한다", async ({
  page,
}, info) => {
  await setColumns(page, ["설명", "진척률"], ["분류", "팀원", "상태"]);
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const description = page.locator(`[data-cell="${taskIds[0]}:description"]`);
  const progress = page.locator(`[data-cell="${taskIds[0]}:progress"]`);
  const mode = page.getByLabel("텍스트 표시", { exact: true });
  const text =
    "오버플로우 첫 글자부터 오른쪽의 빈 셀을 지나 다음 값 앞까지만 이어서 표시합니다. ".repeat(
      3,
    );
  await progress.dblclick();
  await progress.getByRole("textbox").fill("다음 값");
  await progress.getByRole("textbox").press("Enter");
  await title.dblclick();
  await title.getByRole("textbox").fill(text);
  await title.getByRole("textbox").press("Enter");
  await title.click();
  await expect(mode).toHaveAttribute("data-value", "overflow");
  await page.getByRole("grid").evaluate((el) => (el.scrollLeft = 0));
  const originalHeight = (await title.boundingBox())!.height;
  const width = async () =>
    (await title.locator(".cell-overflow-clip").boundingBox())!.width;
  const endAt = (await progress.boundingBox())!.x;
  await expect
    .poll(async () =>
      Math.abs((await width()) + (await title.boundingBox())!.x - endAt),
    )
    .toBeLessThanOrEqual(1);
  expect(
    (await title.locator(".cell-text").boundingBox())!.width,
  ).toBeGreaterThan((await title.boundingBox())!.width);
  await description.click();
  await expect(description).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: info.outputPath("text-overflow-empty-neighbor.png"),
    fullPage: true,
  });
  await freezeColumns(page, 3);
  await page.getByRole("grid").evaluate((el) => (el.scrollLeft = 160));
  await description.click();
  const pinnedTitle = (await title.boundingBox())!;
  const pinnedNext = (await progress.boundingBox())!;
  expect(
    Math.abs((await width()) + pinnedTitle.x - pinnedNext.x),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("text-overflow-frozen-columns.png"),
    fullPage: true,
  });
  // The overflow layer must not steal clicks from the otherwise empty next cell.
  await description.dblclick();
  await description.getByRole("textbox", { name: "설명 편집" }).fill("차단 셀");
  await description.getByRole("textbox").press("Enter");
  await title.click();
  await expect
    .poll(async () =>
      Math.abs((await width()) - (await title.boundingBox())!.width),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("text-overflow-blocked.png"),
    fullPage: true,
  });
  await selectFormat(mode, "clip");
  await expect(title.locator(".cell-overflow-clip")).toHaveCount(0);
  await expect(title.locator(".cell-text")).toHaveCSS("text-overflow", "clip");
  const copied = await copyContents(page);
  expect(copied["text/html"]).toContain('data-text-mode="clip"');
  const target = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await target.click();
  await pasteContents(page, { "text/html": copied["text/html"] });
  await expect(target).toHaveAttribute("data-text-mode", "clip");
  await title.click();
  await selectFormat(page.getByLabel("세로 정렬", { exact: true }), "middle");
  await selectFormat(mode, "wrap");
  await expect(title).toHaveCSS("white-space", "pre-wrap");
  expect((await title.boundingBox())!.height).toBe(originalHeight);
  await expect(page.getByLabel("세로 정렬", { exact: true })).toHaveAttribute(
    "data-value",
    "middle",
  );
  await selectFormat(mode, "overflow");
  await expect(title).toHaveAttribute("data-text-mode", "overflow");
  // 저장 상태 표시는 저장 중·실패일 때만 나타나므로 서버 값으로 저장을 확인한다.
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`);
      return (await r.json()).tasks.find((t: any) => t.id === taskIds[0]).cells
        .title.style.textMode;
    })
    .toBe("overflow");
  await page.reload();
  await expect(title).toHaveText(text);
  await expect(title).toHaveAttribute("data-text-mode", "overflow");
  await expect(target).toHaveAttribute("data-text-mode", "clip");
});

test("속성 관리에서 모든 열·다섯 종류·표시 순서·삭제와 작업 이름을 관리한다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const second = await post(page, "/admin/users", {
    username: `property-${randomUUID().slice(0, 8)}@example.com`,
    name: "협업 팀원",
    password: "test-only-password",
    active: true,
    memberships: [{ teamId, role: "member" }],
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  for (const name of [
    "작업",
    "설명",
    "팀원",
    "지원자",
    "진척률",
    "목표일",
    "Score",
    "Current",
  ]) {
    await expect(
      page
        .locator(".property-select")
        .filter({ hasText: new RegExp(`^${name}`) }),
    ).toHaveCount(1);
  }
  await page.locator(".property-select").filter({ hasText: /^작업/ }).click();
  await expect(
    page.getByRole("button", { name: "선택 속성 삭제", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("속성 이름", { exact: true }).fill("업무 제목");
  for (const [kind, name] of [
    ["option", "우선 선택"],
    ["text", "메모 값"],
    ["date", "검토 날짜"],
    ["number", "예상 시간"],
    ["member", "검토 팀원"],
  ]) {
    await page.getByRole("button", { name: "속성 추가", exact: true }).click();
    await page.getByLabel("속성 이름", { exact: true }).fill(name);
    await page.getByLabel("속성 종류", { exact: true }).selectOption(kind);
    if (kind === "option") {
      await page.getByLabel("표시 모양").selectOption("round");
      await page.getByRole("button", { name: "값 추가", exact: true }).click();
      await page.getByLabel("속성 값 1 이름", { exact: true }).fill("높음");
    }
    if (kind === "member")
      await page.getByLabel("여러 팀원 선택", { exact: true }).check();
  }
  await page
    .getByRole("button", { name: "검토 팀원 속성 순서 이동", exact: true })
    .press("Alt+ArrowUp");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: info.outputPath("unified-property-management.png"),
    fullPage: true,
  });
  const settings = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  const key = (name: string) =>
    settings.properties.find((p: any) => p.name === name).id;
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await setColumns(page, [], ["분류", "팀원", "상태"]);
  await expect(
    page.getByRole("button", { name: "업무 제목 열 선택", exact: true }),
  ).toBeVisible();
  const c = (name: string) =>
    page.locator(`[data-cell="${taskIds[0]}:${key(name)}"]`);
  for (const [name, val] of [
    ["메모 값", "직접 입력"],
    ["검토 날짜", "2026-10-20"],
    ["예상 시간", "-2.5"],
  ]) {
    await c(name).dblclick();
    const input = c(name).locator("input, textarea");
    await input.fill(val);
    await input.press("Enter");
    await expect(c(name)).toHaveText(val);
  }
  await c("우선 선택").dblclick();
  await page.getByRole("option", { name: "높음", exact: true }).click();
  await expect(c("우선 선택").locator(".property-round")).toHaveText("높음");
  await c("검토 팀원").dblclick();
  const list = page.getByRole("listbox", {
    name: "검토 팀원 편집",
    exact: true,
  });
  await list.getByRole("option", { name: boot.user.name, exact: true }).click();
  await list.getByRole("option", { name: "협업 팀원", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(c("검토 팀원").locator(".avatar")).toHaveCount(2);
  await expect(c("검토 팀원")).toContainText("협업 팀원");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByLabel("메모 값 열 표시", { exact: true }).uncheck();
  await page
    .locator(".property-select")
    .filter({ hasText: /^검토 팀원/ })
    .click();
  await page.getByLabel("표시 모양").selectOption("text");
  await page
    .locator(".property-select")
    .filter({ hasText: /^진척률/ })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "선택 속성 삭제", exact: true })
    .click();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(c("메모 값")).toHaveCount(0);
  await expect(c("검토 팀원").locator(".avatar")).toHaveCount(0);
  await expect(c("검토 팀원")).toContainText(`${boot.user.name}, 협업 팀원`);
  await page.reload();
  await expect(c("메모 값")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "업무 제목 열 선택", exact: true }),
  ).toBeVisible();
  await page.getByRole("grid").evaluate((el) => (el.scrollLeft = 0));
  await page.screenshot({
    path: info.outputPath("typed-property-cells.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByLabel("메모 값 열 표시", { exact: true }).check();
  await page.getByText("보관된 속성", { exact: true }).click();
  await page.getByRole("button", { name: "진척률 복원", exact: true }).click();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(c("메모 값")).toHaveText("직접 입력");
  const latest = (
    await (await page.request.get("/api/admin/users")).json()
  ).teams.find((t: any) => t.id === teamId).settings;
  expect(
    latest.properties.find((p: any) => p.id === "progress").archived,
  ).toBeFalsy();
});

test("행 선택 테두리는 손잡이 호버에도 유지되고 즉시 툴팁은 기간 바와 툴바에만 표시한다", async ({
  page,
}, info) => {
  const row = page.locator(`[data-row-id="${taskIds[0]}"]`);
  await row.locator(".row-select").click();
  await row.locator(".row-drag-handle").hover();
  await expect(row.getByRole("rowheader")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const outline = await row.getByRole("rowheader").evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { border: s.borderLeftWidth, z: s.zIndex, pointer: s.pointerEvents };
  });
  expect(outline).toEqual({ border: "1px", z: "4", pointer: "none" });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("selected-row-handle.png") });
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const bold = toolbar.getByRole("button", { name: "굵게", exact: true });
  await bold.hover();
  await expect(page.getByRole("tooltip")).toHaveText("굵게", { timeout: 300 });
  await expect(bold).not.toHaveAttribute("title");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const year = page.getByRole("button", {
    name: "2026년 전체 선택",
    exact: true,
  });
  await year.hover();
  await expect(page.getByRole("tooltip")).toHaveText("2026년 전체 선택", {
    timeout: 300,
  });
  await page.getByRole("button", { name: "3월 전체", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "3월 · 드래그하여 여러 월 선택",
    { timeout: 300 },
  );
  const title = row.locator('[data-column="title"]');
  await title.hover();
  await expect(title).toHaveAttribute("title", "첫 업무");
  await expect(title).not.toHaveAttribute("data-tooltip");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const settings = page.getByRole("button", { name: "설정", exact: true });
  await settings.hover();
  await expect(settings).toHaveAttribute("title", "설정");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await openDefaultStyle(page);
  const undo = page
    .getByRole("dialog", { name: "설정" })
    .getByRole("button", { name: "실행취소", exact: true });
  await expect(undo).toBeDisabled();
  await undo.hover();
  await expect(page.locator("dialog .instant-tooltip")).toHaveText("실행취소", {
    timeout: 300,
  });
});

test("속성과 선택값은 왼쪽 손잡이로 드래그하고 값 편집 중 열 너비를 유지한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  const rows = page.locator(".property-list-row");
  const before = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-column-item")),
  );
  const source = rows.nth(0).locator(".list-drag-handle");
  const target = rows.nth(1);
  const box = (await target.boundingBox())!;
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + 12, box.y + box.height - 3, { steps: 8 });
  await expect(target).toHaveAttribute("data-reorder-drop", "after");
  await page.mouse.up();
  const expected = [before[1], before[0], ...before.slice(2)];
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(expected);
  await page.locator('[data-column-item="status"] .property-select').click();
  const valueRows = page.locator(".property-values tbody tr");
  const values = await valueRows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-option-id")),
  );
  const last = valueRows.last().locator(".list-drag-handle");
  await last.hover();
  const firstBox = (await valueRows.first().boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 16, firstBox.y + 2, { steps: 10 });
  await expect(valueRows.first()).toHaveAttribute(
    "data-reorder-drop",
    "before",
  );
  await page.mouse.up();
  await expect(valueRows.first()).toHaveAttribute(
    "data-option-id",
    values.at(-1)!,
  );
  const widths = () =>
    page
      .locator(".property-values th")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  const initialWidths = await widths();
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  expect(await widths()).toEqual(initialWidths);
  await page
    .getByLabel(`속성 값 ${values.length + 1} 이름`, { exact: true })
    .fill("열 너비가 유지되는 긴 이름");
  expect(await widths()).toEqual(initialWidths);
  await page.getByLabel("속성 값 1 이름", { exact: true }).fill("A");
  expect(await widths()).toEqual(initialWidths);
  await page.screenshot({
    path: info.outputPath("property-drag-fixed-columns.png"),
  });
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(expected);
  await page.locator('[data-column-item="status"] .property-select').click();
  await expect(valueRows.first()).toHaveAttribute(
    "data-option-id",
    values.at(-1)!,
  );
  await expect(page.getByLabel("속성 값 1 이름", { exact: true })).toHaveValue(
    "A",
  );
});

test("새 팀의 기본 세로 정렬은 중간이며 미리보기와 추가 행의 맞닿은 테두리는 1px이다", async ({
  page,
}, info) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const fresh = await post(page, "/admin/teams", {
    name: `중간 정렬 ${randomUUID().slice(0, 6)}`,
    members: [{ userId: boot.user.id, role: "lead" }],
  });
  await page.reload();
  await page.getByLabel("팀 선택").selectOption(fresh.id);
  await openDefaultStyle(page);
  await expect(
    page
      .getByRole("dialog", { name: "설정", exact: true })
      .getByRole("combobox", { name: "세로 정렬", exact: true }),
  ).toHaveAttribute("data-value", "middle");
  await page
    .getByRole("dialog", { name: "설정", exact: true })
    .getByRole("button", { name: "테두리", exact: true })
    .click();
  await page.getByRole("button", { name: "모든 테두리", exact: true }).click();
  const preview = page.locator(".preview-cell");
  await expect(preview.nth(0)).toHaveCSS("border-right-width", "1px");
  await expect(preview.nth(1)).toHaveCSS("border-left-width", "0px");
  await expect(preview.nth(0)).toHaveCSS("border-bottom-width", "1px");
  await expect(preview.nth(3)).toHaveCSS("border-top-width", "0px");
  await page.screenshot({
    path: info.outputPath("default-borders-preview.png"),
  });
  await saveDefaultStyle(page);
  const ids: string[] = [];
  for (const title of ["추가 A", "추가 B"]) {
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/tasks") &&
        r.request().method() === "POST" &&
        r.ok(),
    );
    await page
      .locator(".heading-actions")
      .getByRole("button", { name: "업무 추가", exact: true })
      .click();
    const id = (await (await created).json()).task.id;
    ids.push(id);
    const input = page
      .locator(`[data-cell="${id}:title"]`)
      .getByRole("textbox");
    await input.fill(title);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      input.press("Enter"),
    ]);
  }
  const first = page.locator(`[data-cell="${ids[0]}:title"]`);
  const next = page.locator(`[data-cell="${ids[1]}:title"]`);
  const owner = page.locator(`[data-cell="${ids[1]}:owner"]`);
  await expect(first).toHaveCSS("border-bottom-width", "1px");
  await expect(next).toHaveCSS("border-top-width", "0px");
  await expect(next).toHaveCSS("border-right-width", "1px");
  await expect(owner).toHaveCSS("border-left-width", "0px");
  await expect(next).toHaveCSS("align-items", "safe center");
  await page.reload();
  await expect(next).toHaveCSS("border-top-width", "0px");
  await expect(owner).toHaveCSS("border-left-width", "0px");
  await page.screenshot({
    path: info.outputPath("added-rows-single-borders.png"),
  });
});

test("저장된 필터는 열 조건만 저장하고 적용·해제할 때 현재 숨김과 배치를 유지한다", async ({
  page,
}) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-completed" },
  ]);
  await page.reload();
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  const filter = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await filter.getByRole("checkbox", { name: "완료", exact: true }).check();
  await filter.getByRole("radio", { name: "제외", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .getByRole("button", { name: "현재 필터 저장", exact: true })
    .click();
  await page.getByLabel("필터 이름").fill("완료 제외 보기");
  await page
    .getByRole("dialog", { name: "필터 저장" })
    .getByRole("button", { name: "저장", exact: true })
    .click();
  const applied = page.getByRole("status", { name: "적용 중인 필터" });
  await expect(applied).toHaveText("완료 제외 보기");
  const views = async () =>
    (
      await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      ).json()
    ).views;
  await expect
    .poll(
      async () =>
        (await views()).find((v: any) => v.name === "__current")?.data
          .propertyFilterModes,
    )
    .toEqual({ status: "exclude" });
  const saved = (await views()).find(
    (v: any) => v.name === "완료 제외 보기",
  ).data;
  expect(saved).toEqual({
    year: 2026,
    propertyFilters: { status: ["status-completed"] },
    propertyFilterModes: { status: "exclude" },
  });
  const current = (await views()).find((v: any) => v.name === "__current").data;
  const layout = {
    ...current,
    propertyFilters: {},
    propertyFilterModes: {},
    visibleFields: ["title"],
    hiddenRows: [taskIds[1]],
    hiddenWeeks: ["2026-03-02"],
    collapsedMonths: [2],
    fromMonth: 2,
    toMonth: 5,
    frozenColumns: 1,
    widths: { title: 370 },
    rowHeights: { [taskIds[2]]: 62 },
    sortKey: "title",
    sortDirection: "desc",
  };
  const headers = { "X-Requested-With": "WeeklyPlan" };
  expect(
    (
      await page.request.put("/api/views", {
        headers,
        data: { teamId, name: "__current", data: layout },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put("/api/views", {
        headers,
        data: {
          teamId,
          name: "필터 없음",
          data: { year: 2026, propertyFilters: {}, propertyFilterModes: {} },
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  for (const [name, expectedFilters, expectedModes, titles] of [
    [
      "완료 제외 보기",
      saved.propertyFilters,
      saved.propertyFilterModes,
      ["셋째 업무"],
    ],
    ["필터 없음", {}, {}, ["첫 업무", "셋째 업무"]],
  ] as const) {
    await page
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(applied).toHaveText(name);
    await expect(page.locator('[data-column="title"]')).toHaveText([...titles]);
    await expect
      .poll(
        async () =>
          (await views()).find((v: any) => v.name === "__current").data,
      )
      .toEqual({
        ...layout,
        propertyFilters: expectedFilters,
        propertyFilterModes: expectedModes,
      });
    await expect(page.locator('[data-header-key="status"]')).toHaveCount(0);
    await expect(page.locator(`[data-row-id="${taskIds[1]}"]`)).toHaveCount(0);
    await page.reload();
    await expect(applied).toHaveText(
      name === "필터 없음" ? "저장된 필터" : name,
    );
    await page
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await expect(
      page.locator(".saved-views").getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", String(name !== "필터 없음"));
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "완료 제외 보기", exact: true })
    .click();
  await expect(applied).toHaveText("완료 제외 보기");
  await page.getByRole("button", { name: "필터 해제", exact: true }).click();
  await expect(applied).toHaveText("저장된 필터");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "셋째 업무",
  ]);
  await expect
    .poll(
      async () => (await views()).find((v: any) => v.name === "__current").data,
    )
    .toEqual(layout);
  await page.reload();
  await expect(applied).toHaveText("저장된 필터");
  await expect(
    page.getByRole("button", { name: "필터 해제", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(
    page.locator('.saved-filter-choice[aria-pressed="true"]'),
  ).toHaveCount(0);
  await expect(page.locator(".saved-filter-choice")).toHaveCount(2);
});

test("적용 필터 표시는 같은 조건의 선택 순서와 직접 수정·해제를 반영한다", async ({
  page,
}, info) => {
  const applied = page.getByRole("status", { name: "적용 중인 필터" });
  const control = page.locator(".saved-filter-control");
  await expect(control).toHaveCSS("height", "40px");
  await expect(
    control.getByRole("status", { name: "적용 중인 필터" }),
  ).toHaveCount(1);
  await expect(page.locator(".applied-filter")).toHaveCount(0);
  await expect(applied).toHaveText("저장된 필터");
  await expect(page.getByRole("button", { name: "보기 초기화" })).toHaveCount(
    0,
  );
  await expect(page.locator(".view-bar")).not.toContainText("개 업무 표시");
  for (const name of ["검토 대상", "동일 조건 다른 이름"]) {
    const result = await page.request.put("/api/views", {
      headers: { "X-Requested-With": "WeeklyPlan" },
      data: {
        teamId,
        name,
        data: {
          year: 2026,
          propertyFilters: { status: ["status-completed", "status-progress"] },
          propertyFilterModes: {},
        },
      },
    });
    expect(result.ok()).toBeTruthy();
  }
  const menu = page.locator(".saved-views");
  const choose = async (name: string) => {
    await page
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await menu.getByRole("button", { name, exact: true }).click();
    await expect(applied).toHaveText(name);
  };
  await choose("검토 대상");
  await choose("동일 조건 다른 이름");
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(menu.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(
    menu.getByRole("button", { name: "동일 조건 다른 이름", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(menu.locator(".popover-title strong")).toHaveCSS(
    "font-size",
    "11px",
  );
  await expect(
    menu.getByRole("button", { name: "현재 필터 저장", exact: true }),
  ).toHaveCSS("border-radius", "6px");
  await page.screenshot({ path: info.outputPath("active-saved-filter.png") });
  await page.keyboard.press("Escape");

  await page.locator('[data-header-key="status"]').click({ button: "right" });
  const filter = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  const completed = filter.getByRole("checkbox", { name: "완료", exact: true });
  await completed.uncheck();
  await expect(applied).toHaveText("사용자 지정 필터");
  // 다시 선택하면 저장할 때와 값의 배열 순서가 달라도 같은 조건이다.
  await completed.check();
  await expect(applied).toHaveText("동일 조건 다른 이름");
  await filter.getByRole("radio", { name: "제외", exact: true }).check();
  await expect(applied).toHaveText("사용자 지정 필터");
  await filter.getByRole("radio", { name: "일치", exact: true }).check();
  await expect(applied).toHaveText("동일 조건 다른 이름");
  await filter
    .getByRole("button", { name: "상태 필터 해제", exact: true })
    .click();
  await expect(applied).toHaveText("저장된 필터");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(menu.locator('[aria-pressed="true"]')).toHaveCount(0);
  await menu.getByRole("button", { name: "검토 대상", exact: true }).click();
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  await filter.getByRole("radio", { name: "제외", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(applied).toHaveText("사용자 지정 필터");
  const clear = control.getByRole("button", { name: "필터 해제", exact: true });
  await clear.focus();
  await clear.press("Enter");
  await expect(applied).toHaveText("저장된 필터");
  await expect(
    control.getByRole("button", { name: "저장된 필터", exact: true }),
  ).toBeFocused();
  await expect(clear).toHaveCount(0);
});
