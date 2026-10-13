import { unpack } from "../../shared/compact.js";
import { readPreferences, writePreferences } from "./preferences";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { THEMES } from "../../shared/themes.js";
import {
  defaultView,
  weeksForYear,
  visibleWeeks,
  cell,
} from "../../shared/domain.js";

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
  return r.json().then(unpack);
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
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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
    page.locator(`.period-month[data-month="${from}"]`),
    page.locator(`.period-month[data-month="${to}"]`),
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
  await expect(page.locator('[data-header-key="title"]')).toBeVisible();
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const properties = boot.teams.find((t: any) => t.id === teamId).settings
    .properties;
  const key = (name: string) => properties.find((p: any) => p.name === name).id;
  const desired = new Set(
    await page
      .locator("[data-header-key]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-header-key")),
      ),
  );
  for (const label of show) {
    const id = key(label);
    desired.add(id);
    if (!(await page.locator(`[data-header-key="${id}"]`).count()))
      await page
        .locator(`.hidden-column-reveal[data-hidden-columns~="${id}"]`)
        .click();
  }
  for (const label of hide) desired.delete(key(label));
  for (const property of properties) {
    const header = page.locator(`[data-header-key="${property.id}"]`);
    if (!desired.has(property.id) && (await header.count())) {
      await header.getByRole("button").click();
      await header.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "열 숨기기", exact: true })
        .click();
      await expect(header).toHaveCount(0);
    }
  }
  const expectedFields = properties
    .filter((property: any) => desired.has(property.id))
    .map((property: any) => property.id)
    .sort();
  await expect
    .poll(async () => {
      const { views } = await readPreferences(page, teamId);
      return views
        .find((view: any) => view.name === "__current")
        ?.data.visibleFields.slice()
        .sort();
    })
    .toEqual(expectedFields);
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
    Array.from({ length: 12 }, (_, i) =>
      i === 0 ? "2026년 1월" : `${i + 1}월`,
    ),
  );
  const weekButtons = picker.locator(".period-week");
  await expect(weekButtons).toHaveCount(53);
  expect((await picker.boundingBox())!.height).toBeLessThanOrEqual(45);
  // 달력 최소 너비 900px을 유지할 때 보기 버튼은 다음 줄로 내려간다.
  expect((await page.getByRole("grid").boundingBox())!.y).toBeLessThan(240);
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
      const data = await readPreferences(page, teamId);
      const view = data.views.find((v: any) => v.name === "__current")?.data;
      return [view?.fromWeek, view?.toWeek];
    })
    .toEqual(["2026-03-16", "2026-04-06"]);
  await page.reload();
  await expect.poll(headers).toEqual(expected("2026-03-16", "2026-04-06"));
  await picker
    .getByRole("button", { name: "2026년 1월 전체", exact: true })
    .focus();
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
      const { views } = await readPreferences(page, teamId);
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
      const data = await readPreferences(page, teamId);
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
      const data = await readPreferences(page, teamId);
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
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
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
  await expect(
    page.getByLabel("왼쪽 경계선 스타일", { exact: true }),
  ).toHaveValue("none");
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-header-key="2026-03-16"]')).toHaveCSS(
    "background-color",
    "rgb(247, 249, 249)",
  );
});

test("주차 기본 경계선은 기간 선택·날짜 숨김·월 이동 후에도 보이는 양 끝을 따른다", async ({
  page,
}, info) => {
  const settings = (
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
  ).teams.find((t: any) => t.id === teamId).settings;
  const saved = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      ...settings,
      properties: settings.properties.map((p: any) => ({
        ...p,
        visible: ["title", "status"].includes(p.id),
        placement: p.id === "status" ? "afterWeeks" : "beforeWeeks",
      })),
    },
  });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  const readTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack)
    ).tasks;
  const before = await readTasks();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.locator(".week-column-select").click();
  await page
    .getByLabel("왼쪽 경계선 스타일", { exact: true })
    .selectOption("double");
  await page.getByLabel("왼쪽 경계선 색상", { exact: true }).fill("#2255aa");
  await page
    .getByLabel("오른쪽 경계선 스타일", { exact: true })
    .selectOption("dashed");
  await page.getByLabel("오른쪽 경계선 색상", { exact: true }).fill("#bb3344");
  await page.screenshot({
    path: info.outputPath("week-boundary-settings.png"),
  });
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const headers = page.locator(".week-heading[data-header-key]");
  const assertEdges = async () => {
    await expect(headers.first()).toHaveCSS("border-left-style", "double");
    await expect(headers.last()).toHaveCSS("border-right-style", "dashed");
    const first = await headers.first().getAttribute("data-header-key");
    const last = await headers.last().getAttribute("data-header-key");
    for (const id of taskIds) {
      await expect(page.locator(`[data-cell="${id}:${first}"]`)).toHaveCSS(
        "border-left-color",
        "rgb(34, 85, 170)",
      );
      await expect(page.locator(`[data-cell="${id}:${last}"]`)).toHaveCSS(
        "border-right-color",
        "rgb(187, 51, 68)",
      );
    }
  };
  await assertEdges();
  await chooseWeeks(page, "2026-03-02", "2026-03-16");
  await expect(headers).toHaveCount(3);
  await assertEdges();
  await page
    .locator('[data-header-key="2026-03-02"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect(headers).toHaveCount(2);
  await assertEdges();
  await page
    .locator('[data-header-key="2026-03-16"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect(headers).toHaveCount(1);
  await assertEdges();
  await page.screenshot({
    path: info.outputPath("single-week-boundaries.png"),
  });
  // View saves are debounced; reload only after the hidden dates are persisted.
  await expect
    .poll(async () => {
      const { views } = await readPreferences(page, teamId);
      const current = views.find((view: any) => view.name === "__current");
      return current
        ? visibleWeeks(2026, current.data).map((week: any) => week.key)
        : [];
    })
    .toEqual(["2026-03-09"]);
  await page.reload();
  await expect(headers).toHaveCount(1);
  await assertEdges();
  await page
    .locator('[data-header-key="2026-03-09"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "열 숨기기", exact: true }).click();
  await expect(headers).toHaveCount(0);
  await expect(page.locator('[data-header-key="status"]')).not.toHaveCSS(
    "border-left-style",
    "double",
  );
  await page
    .getByRole("button", { name: "다음 달로 이동", exact: true })
    .click();
  await assertEdges();
  expect(await readTasks()).toEqual(before);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.locator(".week-column-select").click();
  await expect(
    page.getByLabel("왼쪽 경계선 스타일", { exact: true }),
  ).toHaveValue("double");
  await page
    .getByLabel("왼쪽 경계선 스타일", { exact: true })
    .selectOption("none");
  await page
    .getByLabel("오른쪽 경계선 스타일", { exact: true })
    .selectOption("none");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(headers.first()).not.toHaveCSS("border-left-style", "double");
  await expect(headers.last()).not.toHaveCSS("border-right-style", "dashed");
});

test("주차 기본 경계선은 기존 테두리 지우기·없음·업무 기본선이 있어도 날짜 필터를 따른다", async ({
  page,
}, info) => {
  const settings = (
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
  ).teams.find((t: any) => t.id === teamId).settings;
  const line = { style: "double", color: "#ff7aba" };
  const inheritedLine = { style: "thick", color: "#607984" };
  const saved = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      ...settings,
      weekBorders: { left: line, right: line },
      defaultStyle: {
        ...settings.defaultStyle,
        borderLeft: inheritedLine,
        borderRight: inheritedLine,
      },
      properties: settings.properties.map((p: any) => ({
        ...p,
        visible: ["title", "status"].includes(p.id),
        placement: p.id === "status" ? "afterWeeks" : "beforeWeeks",
      })),
    },
  });
  expect(saved.ok()).toBeTruthy();
  const inherited = await post(page, "/tasks", {
    teamId,
    year: 2026,
    fields: { title: "업무 기본선 상속" },
  });
  const ids = [...taskIds, inherited.task.id];
  const readTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack)
    ).tasks;
  const tasks = await readTasks();
  // Imported/previously formatted cells retain null or none on date and property edges.
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: taskIds.slice(0, 2).flatMap((taskId, index) =>
      [
        "title",
        "2026-11-02",
        "2026-11-09",
        "2026-11-16",
        "2026-11-23",
        "status",
      ].map((key) => ({
        taskId,
        key,
        expectedVersion:
          tasks.find((task: any) => task.id === taskId).cells[key]?.version ||
          0,
        style: {
          borderLeft: index ? { style: "none", color: "#607984" } : null,
          borderRight: index ? { style: "none", color: "#607984" } : null,
          ...(key === "status" ? { backgroundColor: "#d4bdeb" } : {}),
        },
      })),
    ),
  });
  const before = await readTasks();
  await page.reload();
  await chooseWeeks(page, "2026-11-02", "2026-11-23");
  const headers = page.locator(".week-heading[data-header-key]");
  async function assertEdges() {
    const keys = [
      await headers.first().getAttribute("data-header-key"),
      await headers.last().getAttribute("data-header-key"),
    ];
    const edges = [];
    for (const [index, side] of ["left", "right"].entries()) {
      for (const id of ids) {
        const target = page.locator(`[data-cell="${id}:${keys[index]}"]`);
        await expect(target).toHaveCSS(`border-${side}-style`, "double");
        await expect(target).toHaveCSS(
          `border-${side}-color`,
          "rgb(255, 122, 186)",
        );
        const box = (await target.boundingBox())!;
        edges.push({
          x: side === "left" ? box.x : box.x + box.width,
          y: box.y + box.height / 2,
        });
      }
    }
    // Verify painted pixels too: CSS assertions alone can miss a covered border.
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    const painted = await page.evaluate(
      async ({ png, edges }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return edges.map(({ x, y }) => {
          const { data } = context.getImageData(
            Math.floor(x) - 5,
            Math.floor(y),
            10,
            1,
          );
          for (let offset = 0; offset < data.length; offset += 4)
            if (
              [255, 122, 186].every(
                (channel, i) => Math.abs(data[offset + i] - channel) < 15,
              )
            )
              return true;
          return false;
        });
      },
      { png, edges },
    );
    expect(painted).toEqual(edges.map(() => true));
  }
  await assertEdges();
  for (const key of ["2026-11-02", "2026-11-23", "2026-11-09"]) {
    await page.locator(`[data-header-key="${key}"]`).click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "열 숨기기", exact: true })
      .click();
    await assertEdges();
  }
  await expect(headers).toHaveCount(1);
  const grid = page.getByRole("grid");
  for (const zoom of [0.9, 1.25, 1]) {
    await grid.evaluate((el, zoom) => (el.style.zoom = String(zoom)), zoom);
    await assertEdges();
  }
  await page.screenshot({
    path: info.outputPath("filtered-styled-week-boundaries.png"),
  });
  expect(await readTasks()).toEqual(before);
});

test("주차 기본 경계선보다 셀에 그린 선이 우선하고 지우면 기본 경계선을 복원한다", async ({
  page,
}) => {
  const settings = (
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
  ).teams.find((t: any) => t.id === teamId).settings;
  const response = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: {
      ...settings,
      weekBorders: {
        left: { style: "thick", color: "#2255aa" },
        right: { style: "double", color: "#bb3344" },
      },
      properties: settings.properties.map((p: any) => ({
        ...p,
        visible: ["title", "status"].includes(p.id),
        placement: p.id === "status" ? "afterWeeks" : "beforeWeeks",
      })),
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await marchWeeks(page);
  const first = page.locator(`[data-cell="${taskIds[0]}:2026-03-02"]`);
  const last = page.locator(`[data-cell="${taskIds[0]}:2026-03-16"]`);
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  // Text from the property column stops at the boundary even if weeks are empty.
  expect(
    await title
      .locator(".cell-overflow-clip")
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBe((await title.boundingBox())!.width);
  await expect(first).toHaveCSS("border-left-width", "3px");
  await first.click();
  await applyBorders(page, "왼쪽 테두리", "solid", "#339966");
  await expect(first).toHaveCSS("border-left-width", "1px");
  await expect(first).toHaveCSS("border-left-color", "rgb(51, 153, 102)");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(first).toHaveCSS("border-left-width", "3px");
  await last.click();
  await applyBorders(page, "오른쪽 테두리", "solid", "#339966");
  await expect(last).toHaveCSS("border-right-color", "rgb(51, 153, 102)");
  await applyBorders(page, "테두리 지우기");
  await expect(last).toHaveCSS("border-right-style", "double");
  await expect(
    page.locator(`[data-cell="${taskIds[1]}:2026-03-16"]`),
  ).toHaveCSS("border-right-style", "double");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(last).toHaveCSS("border-right-color", "rgb(51, 153, 102)");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(last).toHaveCSS("border-right-style", "double");
  // The property cell sharing the edge can override the default with a thinner line.
  await title.click();
  await applyBorders(page, "오른쪽 테두리", "dashed", "#339966");
  await expect(title).toHaveCSS("border-right-style", "dashed");
  await expect(first).not.toHaveCSS("border-left-width", "3px");
  await page.reload();
  await expect(title).toHaveCSS("border-right-style", "dashed");
  await expect(first).not.toHaveCSS("border-left-width", "3px");
  await expect(last).toHaveCSS("border-right-style", "double");
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
  // A "none" line applies only at the chosen position, preserving other edges.
  await applyBorders(page, "오른쪽 테두리", "none");
  for (const row of [0, 1]) {
    await expect(at(row, "2026-03-09")).toHaveCSS("border-right-width", "0px");
    await expect(at(row, "2026-03-02")).toHaveCSS("border-left-width", "3px");
  }
  await expect(at(0, "2026-03-02")).toHaveCSS("border-bottom-style", "double");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(at(0, "2026-03-09")).toHaveCSS("border-right-style", "dashed");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(at(0, "2026-03-09")).toHaveCSS("border-right-width", "0px");
  // Restore the chosen edge to the native grid without erasing other borders.
  await applyBorders(page, "오른쪽 테두리", "default");
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  await expect(
    page.getByLabel("테두리 선 스타일", { exact: true }),
  ).toHaveValue("default");
  await expect(
    page.getByLabel("테두리 선 색상", { exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("default-border-toolbar.png"),
  });
  await page.keyboard.press("Escape");
  for (const row of [0, 1]) {
    await expect(at(row, "2026-03-09")).toHaveCSS("border-right-width", "1px");
    await expect(at(row, "2026-03-09")).toHaveCSS(
      "border-right-color",
      "rgb(231, 237, 237)",
    );
    await expect(at(row, "2026-03-02")).toHaveCSS("border-left-width", "3px");
  }
  await expect(at(0, "2026-03-02")).toHaveCSS("border-bottom-style", "double");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(at(0, "2026-03-09")).toHaveCSS("border-right-width", "0px");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(at(0, "2026-03-09")).toHaveCSS(
    "border-right-color",
    "rgb(231, 237, 237)",
  );
  await applyBorders(page, "가로 안쪽 테두리", "none");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-bottom-width", "0px");
  await expect(at(1, "2026-03-02")).toHaveCSS("border-top-width", "0px");
  await expect(at(1, "2026-03-02")).toHaveCSS("border-bottom-style", "solid");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-left-width", "3px");
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

test("열 너비와 화면 배율을 바꿔도 기본 격자선과 지정한 오른쪽 테두리가 그려진다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await setColumns(page, ["Score", "Current"]);
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: taskIds.flatMap((taskId, index) =>
      ["status", "score", "current"].map((key) => ({
        taskId,
        key,
        value: key === "status" ? "status-progress" : 5,
        expectedVersion:
          tasks.find((task: any) => task.id === taskId).cells[key]?.version ||
          0,
        style: {
          backgroundColor: index === 2 ? "#ffdc78" : "#ffffff",
          ...(key === "status"
            ? { borderRight: { style: "solid", color: "#ff0000" } }
            : {}),
        },
      })),
    ),
  });
  await page.reload();
  const status = page.locator('.sheet-cell[data-column="status"]');
  await status.first().click();
  await applyBorders(page, "테두리 지우기");
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).click();
  await expect(status.and(page.locator(".selected"))).toHaveCount(0);
  const grid = page.getByRole("grid");
  // Computed borders remain correct even when Chromium drops the painted line.
  // Read screenshot pixels instead, including the erased/default and colored lines.
  async function expectPaintedBorders() {
    const edges = await status.evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { right: box.right, top: box.top, height: box.height };
      }),
    );
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    const visible = await page.evaluate(
      async ({ png, edges }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return edges.map((edge, index) => {
          const expected = index ? [255, 0, 0] : [231, 237, 237];
          return [0.25, 0.5, 0.75].every((fraction) => {
            const { data } = context.getImageData(
              Math.floor(edge.right) - 3,
              Math.floor(edge.top + edge.height * fraction),
              6,
              1,
            );
            for (let offset = 0; offset < data.length; offset += 4)
              if (
                expected.every(
                  (channel, i) => Math.abs(data[offset + i] - channel) < 10,
                )
              )
                return true;
            return false;
          });
        });
      },
      { png, edges },
    );
    expect(visible).toEqual([true, true, true]);
  }
  for (const frozen of [false, true]) {
    if (frozen) {
      await page
        .locator('[data-header-key="current"]')
        .click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "여기까지 열 고정", exact: true })
        .click();
    }
    for (const width of [94, 95, 96, 97.5, 98.25]) {
      const before = (await status.first().boundingBox())!.width;
      const handle = (await page
        .locator('[data-resize-key="status"]')
        .boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + width - before, y);
      await page.mouse.up();
      await page.mouse.move(0, 0);
      for (const zoom of [0.9, 1, 1.25]) {
        await grid.evaluate((el, zoom) => (el.style.zoom = String(zoom)), zoom);
        await expectPaintedBorders();
      }
      await grid.evaluate((el) => (el.style.zoom = "1"));
    }
  }
  await page.screenshot({ path: info.outputPath("resized-cell-borders.png") });
});

test("기본 테두리 지우기는 새로고침·실행취소·복사 후에도 기본 격자선을 유지한다", async ({
  page,
}) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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
  await applyBorders(page, "위쪽 테두리", "default");
  await expect(at(0)).toHaveCSS("border-top-width", "0px");
  // The left edge belongs to the neighboring cell when equal borders collapse.
  await expect(at(0)).toHaveCSS("border-right-width", "3px");
  await toolbar.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(at(0)).toHaveCSS("border-top-width", "3px");
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
        (await readPreferences(page, teamId)).views[0]?.data.hiddenWeeks,
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
  await applyBorders(page, "모든 테두리", "dashed", "#336699");
  await expect(at(0, "2026-03-02")).toHaveCSS("border-right-style", "dashed");
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

test("속성을 주차 날짜 오른쪽으로 옮기면 마지막 날짜 뒤에 저장하고 편집·열 선택·고정을 유지한다", async ({
  page,
}, info) => {
  const settings = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
    .press("Alt+ArrowRight");
  await page
    .getByRole("button", { name: "진척률 속성 순서 이동", exact: true })
    .press("Alt+ArrowRight");
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
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
      const views = (await readPreferences(page, teamId)).views;
      const current = views.find((v: any) => v.name === "__current").data;
      return [current.fromWeek, current.toWeek];
    })
    .toEqual(["2026-03-02", "2026-03-16"]);
  await page.reload();
  await expect.poll(headers).toEqual(expected);
  await expect(progress).toHaveText("75% 검토 중");
  const stored = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
      page.getByText("속성이 저장되었습니다.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "닫기", exact: true }).click();
  };
  await open();
  const count = await page.locator(".property-select").count();
  for (let i = 0; i < count; i++)
    await page
      .getByRole("button", { name: "주차 날짜 속성 순서 이동", exact: true })
      .press("Alt+ArrowLeft");
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
      .press("Alt+ArrowRight");
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
    )
      .json()
      .then(unpack)
  ).tasks;
  for (const task of saved)
    for (const key of keys)
      expect(cell(task, key).style.backgroundColor).toBe("#d1eee6");
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
    )
      .json()
      .then(unpack)
  ).tasks;
  const keys = await page
    .locator("[data-header-key]")
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.headerKey!),
    );
  for (const task of saved.slice(0, 2))
    for (const key of keys) expect(cell(task, key).style.fontSize).toBe(12);
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
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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
    )
      .json()
      .then(unpack)
  ).tasks;
  for (const task of saved)
    expect(cell(task, "title").style.fontSize).toBe(
      task.cells.title.value.startsWith("대상")
        ? 14
        : task.defaultStyle.fontSize,
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
      )
        .json()
        .then(unpack)
    ).tasks;
  const verifyBackground = async (formatted: boolean) => {
    for (const task of await readTasks())
      for (const key of keys)
        expect(cell(task, key).style.backgroundColor).toBe(
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

test("내 계정 하위 메뉴에서 본인 프로필의 이니셜·배경색·이미지를 저장하고 다시 연다", async ({
  page,
}, info) => {
  const username = `my-profile-${randomUUID()}@example.com`;
  const created = await post(page, "/admin/users", {
    username,
    name: "개인 프로필",
    password: "my-profile-password",
    active: true,
    memberships: [{ teamId, role: "member" }],
  });
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "owner",
        value: created.user.id,
        expectedVersion: tasks.find((task: any) => task.id === taskIds[0]).cells
          .owner.version,
      },
    ],
  });
  await post(page, "/auth/login", {
    username,
    password: "my-profile-password",
  });
  await page.reload();
  const account = page.getByRole("button", { name: "내 계정", exact: true });
  const menu = page.getByRole("menu", { name: "내 계정 메뉴" });
  await account.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "프로필",
    "비밀번호 변경",
    "로그아웃",
  ]);
  await expect(
    menu.getByRole("menuitem", { name: "프로필", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath("account-menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();
  await account.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "비밀번호 변경", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const profile = page.getByRole("dialog", { name: "프로필", exact: true });
  await expect(profile).toBeVisible();
  await expect(
    profile.getByLabel("아이디(이메일)", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await profile.getByLabel("이름", { exact: true }).fill("내가 정한 이름");
  await profile.getByRole("radio", { name: "직접 입력", exact: true }).check();
  await profile.getByLabel("아바타 글자", { exact: true }).fill("M12");
  await profile.getByLabel("아바타 배경색", { exact: true }).fill("#3377bb");
  await page.screenshot({ path: info.outputPath("my-profile.png") });
  const save = profile.getByRole("button", {
    name: "프로필 저장",
    exact: true,
  });
  await page.route("**/api/auth/profile", (route) =>
    route.fulfill({ status: 503, json: { error: "프로필 저장 재시도" } }),
  );
  await save.click();
  await expect(profile.getByRole("alert")).toHaveText("프로필 저장 재시도");
  await expect(profile.getByLabel("아바타 글자", { exact: true })).toHaveValue(
    "M12",
  );
  await page.unroute("**/api/auth/profile");
  await save.click();
  await expect(profile).toHaveCount(0);
  await expect(account.locator(".avatar")).toHaveText("M12");
  await expect(account).toContainText("내가 정한 이름");
  const owner = page.locator(`[data-cell="${taskIds[0]}:owner"]`);
  await expect(owner.locator(".avatar")).toHaveText("M12");
  await expect(owner).toContainText("내가 정한 이름");
  await expect(account.locator(".avatar")).toHaveCSS(
    "background-color",
    "rgb(51, 119, 187)",
  );
  await page.reload();
  await expect(account.locator(".avatar")).toHaveText("M12");
  const openProfile = async () => {
    await account.click();
    await menu.getByRole("menuitem", { name: "프로필", exact: true }).click();
  };
  await openProfile();
  await expect(profile.getByLabel("아바타 글자", { exact: true })).toHaveValue(
    "M12",
  );
  await profile.getByRole("radio", { name: "이미지", exact: true }).check();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3377bb";
    ctx.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await profile.getByLabel("아바타 이미지", { exact: true }).setInputFiles({
    name: "my-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(profile.locator(".avatar-preview img")).toBeVisible();
  const avatarImage = await profile
    .locator(".avatar-preview img")
    .getAttribute("src");
  await profile
    .getByRole("radio", { name: "이름 첫 글자", exact: true })
    .check();
  await expect(profile.locator(".avatar-preview img")).toHaveCount(0);
  await profile.getByRole("radio", { name: "이미지", exact: true }).check();
  await expect(profile.locator(".avatar-preview img")).toHaveAttribute(
    "src",
    avatarImage!,
  );
  await profile.getByRole("radio", { name: "직접 입력", exact: true }).check();
  await expect(profile.getByLabel("아바타 글자", { exact: true })).toHaveValue(
    "M12",
  );
  await profile.getByRole("radio", { name: "이미지", exact: true }).check();
  await expect(profile.locator(".avatar-preview img")).toHaveAttribute(
    "src",
    avatarImage!,
  );
  await expect(save).toBeEnabled();
  await save.click();
  await expect(profile).toHaveCount(0);
  await expect(account.locator(".avatar img")).toBeVisible();
  await expect(owner.locator(".avatar img")).toBeVisible();
  await page.reload();
  await expect(account.locator(".avatar img")).toBeVisible();
  await openProfile();
  await profile.getByRole("radio", { name: "직접 입력", exact: true }).check();
  await profile.getByLabel("아바타 글자", { exact: true }).fill("NO");
  await profile.getByRole("radio", { name: "이미지", exact: true }).check();
  await expect(profile.locator(".avatar-preview img")).toHaveAttribute(
    "src",
    avatarImage!,
  );
  await profile.getByRole("radio", { name: "직접 입력", exact: true }).check();
  await expect(profile.getByLabel("아바타 글자", { exact: true })).toHaveValue(
    "NO",
  );
  await profile.getByRole("button", { name: "취소", exact: true }).click();
  await expect(account.locator(".avatar img")).toBeVisible();
  await openProfile();
  await profile
    .getByRole("radio", { name: "이름 첫 글자", exact: true })
    .check();
  await save.click();
  await expect(account.locator(".avatar")).toHaveText("내");
  await expect(account.locator(".avatar img")).toHaveCount(0);
  await account.click();
  await page.locator(".page-heading h1").click();
  await expect(menu).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await openProfile();
  await profile.getByRole("radio", { name: "이미지", exact: true }).check();
  expect(
    await profile.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.screenshot({ path: info.outputPath("my-profile-mobile.png") });
});

test("내 계정 메뉴에서 비밀번호 확인 후 변경하고 로그아웃한다", async ({
  page,
}) => {
  const username = `my-password-${randomUUID()}@example.com`;
  await post(page, "/admin/users", {
    username,
    name: "비밀번호 검증",
    password: "my-password-before",
    active: true,
    memberships: [{ teamId, role: "viewer" }],
  });
  await post(page, "/auth/login", { username, password: "my-password-before" });
  await page.reload();
  const account = page.getByRole("button", { name: "내 계정", exact: true });
  await account.click();
  await page
    .getByRole("menuitem", { name: "비밀번호 변경", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "비밀번호 변경",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "로그아웃", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("현재 비밀번호", { exact: true })
    .fill("wrong-password");
  await dialog
    .getByLabel("새 비밀번호", { exact: true })
    .fill("my-password-after");
  const confirmation = dialog.getByLabel("비밀번호 확인", { exact: true });
  const change = dialog.getByRole("button", {
    name: "비밀번호 변경",
    exact: true,
  });
  let passwordRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/password")) passwordRequests++;
  });
  await change.click();
  await expect(confirmation).toBeFocused();
  expect(passwordRequests).toBe(0);
  await confirmation.fill("mismatched-password");
  await change.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "새 비밀번호와 비밀번호 확인이 일치하지 않습니다.",
  );
  await expect(confirmation).toBeFocused();
  expect(passwordRequests).toBe(0);
  await confirmation.fill("my-password-after");
  await dialog
    .getByRole("button", { name: "비밀번호 변경", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("현재 비밀번호");
  await dialog
    .getByLabel("현재 비밀번호", { exact: true })
    .fill("my-password-before");
  await dialog
    .getByRole("button", { name: "비밀번호 변경", exact: true })
    .click();
  await expect(dialog).toContainText("비밀번호를 변경했습니다.");
  await expect(dialog.getByLabel("새 비밀번호", { exact: true })).toHaveValue(
    "",
  );
  await expect(confirmation).toHaveValue("");
  await dialog
    .getByRole("button", { name: "닫기", exact: true })
    .last()
    .click();
  await account.click();
  await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  await page.getByLabel("아이디(이메일)", { exact: true }).fill(username);
  await page.getByLabel("비밀번호", { exact: true }).fill("my-password-after");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(account).toContainText("비밀번호 검증");
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
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
  ).users.find((u: any) => u.id === created.user.id);
  expect(profile.avatarImage).toMatch(/^data:image\/png;base64,/);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "사용자 계정", exact: true }).click();
  await edit();
  await page.getByRole("radio", { name: "이름 첫 글자", exact: true }).check();
  await expect(page.locator(".avatar-preview .avatar")).toHaveText("프");
  await expect(page.locator(".avatar-preview img")).toHaveCount(0);
  await page.getByRole("radio", { name: "이미지", exact: true }).check();
  await expect(page.locator(".avatar-preview img")).toHaveAttribute(
    "src",
    profile.avatarImage,
  );
  await page.getByRole("radio", { name: "이름 첫 글자", exact: true }).check();
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.propertyFilters.owner,
    )
    .toEqual([uid]);
  const readCurrentView = async () =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === "__current",
    ).data;
  const oldView = await readCurrentView();
  const savedView = await writePreferences(page, {
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
  await page
    .getByRole("button", { name: "이전 팀원 보기", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/filters?teamId=${teamId}`)
          )
            .json()
            .then(unpack)
        ).current.data.propertyFilters.owner,
    )
    .toEqual([]);
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await page
    .getByRole("button", { name: "팀원 열 선택", exact: true })
    .click({ button: "right" });
  await expect(page.locator(".property-filter")).not.toContainText(
    "최신 담당자",
  );
  await page.keyboard.press("Escape");
  await cell.getByRole("button").click();
  await expect(page.locator(".inline-editor")).toHaveCount(0);
  await cell.getByRole("button").dblclick();
  await expect(page.locator(".inline-editor")).toContainText("최신 담당자");
  await expect(
    page.getByRole("option", { name: "최신 담당자", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("former-member.png"),
    fullPage: true,
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  await page.getByRole("option", { name: boot.user.name, exact: true }).click();
  await expect(cell).toContainText(boot.user.name);
  await page.reload();
  await cell.getByRole("button").dblclick();
  await expect(page.locator(".inline-editor")).toBeVisible();
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
    createdAt: new Date().toISOString(),
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
  await status.locator(".cell-choice-trigger").dblclick();
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
    await expect(page.getByLabel("타입", { exact: true })).toBeDisabled();
    await expect(page.locator(".property-type-label")).toContainText(
      "(필수 고정 타입)",
    );
  }
  await page.getByLabel("속성 값 4 이름", { exact: true }).fill("종료");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
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
  const data = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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
  const latest = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
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
          )
            .json()
            .then(unpack)
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
  const users = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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

test("팀별 파스텔 테마를 선택·저장하고 기존 스냅샷·전환·새로고침에서 셀 서식을 보존한다", async ({
  page,
}, info) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const originalName = boot.teams.find((t: any) => t.id === teamId).name;
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        expectedVersion: 1,
        style: { color: "#243642", backgroundColor: "#ffe6dd" },
      },
    ],
  });
  const snapshot = await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "테마 변경 전 스냅샷",
    referenceDate: "2026-10-13",
    view: defaultView(2026),
    taskIds,
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
      .dblclick();
    await expect(page.locator('.cell-option[aria-selected="true"]')).toHaveCSS(
      "color",
      rgb(theme.accent),
    );
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: info.outputPath(`theme-${theme.id}.png`),
      fullPage: true,
    });
    // 같은 민트 스냅샷을 열어 저장 당시 테마가 현재 팀 테마를 덮지 않는지 확인한다.
    await page
      .getByRole("button", { name: "보고서 스냅샷", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "보고서 스냅샷", exact: true })
      .getByRole("button", { name: /테마 변경 전 스냅샷/ })
      .click();
    await expect(page.getByRole("grid")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    await expect(page.locator(".format-toolbar")).toHaveCount(0);
    await expect(page.locator(".active-report-banner")).toHaveCSS(
      "border-left-color",
      rgb(theme.snapshot),
    );
    await expect(title).toHaveCSS("background-color", "rgb(255, 230, 221)");
    await expect(title).toHaveCSS("color", "rgb(36, 54, 66)");
    await page.screenshot({
      path: info.outputPath(`snapshot-current-theme-${theme.id}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "스냅샷 수정", exact: true })
      .click();
    await expect(page.locator(".format-toolbar")).toHaveCSS(
      "background-color",
      rgb(theme.surface),
    );
    await expect(title).toHaveCSS("background-color", "rgb(255, 230, 221)");
    await page.getByRole("button", { name: "수정 취소", exact: true }).click();
    await expect(page.locator(".format-toolbar")).toHaveCount(0);
    await page
      .getByRole("button", { name: "스냅샷 보기 종료", exact: true })
      .click();
    await expect(page.getByRole("grid")).toHaveAttribute(
      "aria-readonly",
      "false",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
  }
  const saved = await (
    await page.request.get(`/api/reports/${snapshot.id}`)
  )
    .json()
    .then(unpack);
  expect(saved.settings.theme).toBe("mint");
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
    )
      .json()
      .then(unpack)
  ).tasks;
  expect(
    tasks.find((t: any) => t.id === taskIds[1]).cells.title.style.bold,
  ).toBe(true);
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/views?teamId=${teamId}&year=2026`);
      return (await r.json().then(unpack)).views[0]?.data.hiddenRows.length;
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
      )
        .json()
        .then(unpack)
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
    });
    expect(task.cells.category.style).toEqual(
      original.find((t: any) => t.id === id).cells.category.style,
    );
  }
  expect(
    stored.find((t: any) => t.id === taskIds[1]).cells.owner.style.borderTop,
  ).toBeUndefined();
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
      const { views } = await readPreferences(page, teamId);
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
      )
        .json()
        .then(unpack)
    ).tasks;
  const stored = await readTasks();
  for (const key of ["2025-12-29", "2026-03-02", "2026-12-28", "description"])
    expect(
      cell(
        stored.find((t: any) => t.id === taskIds[0]),
        key,
      ).style.fontSize,
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
    expect(cell(task, "owner").style.fontSize).toBe(16);
  await page.getByRole("button", { name: "모든 셀 선택", exact: true }).click();
  await selectFormat(page.getByLabel("글자 크기", { exact: true }), "18");
  for (const task of await readTasks())
    for (const key of ["title", "description", "2025-12-29", "2026-12-28"])
      expect(cell(task, key).style.fontSize).toBe(18);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+a");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    page.getByRole("button", { name: "기울임", exact: true }).click(),
  ]);
  for (const task of await readTasks())
    for (const key of ["title", "description", "2025-12-29", "2026-12-28"])
      expect(cell(task, key).style.italic).toBe(true);
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
  const stored = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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

test("빈 프로젝트 셀과 지정한 칩은 모두 더블클릭으로 목록을 연다", async ({
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const data = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
  const pid = data.teams
    .find((t: any) => t.id === teamId)
    .settings.properties.find((p: any) => p.name === "프로젝트").id;
  const project = page.locator(`[data-cell="${taskIds[0]}:${pid}"]`);
  await expect(project).toHaveText("");
  await expect(project.getByRole("button")).toHaveCount(0);
  await project.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
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
  await expect(project).toHaveClass(/focused/);
  await expect(popup).toHaveCount(0);
  await project.locator(".property-badge").dblclick();
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

test("짧은 셀 저장은 툴바를 깜빡이지 않고 긴 저장과 실패는 표시한다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const bold = page.getByRole("button", { name: "굵게", exact: true });
  await cell.click();
  await expect(bold).toHaveCSS("opacity", "1");
  const gridBox = await page.getByRole("grid").boundingBox();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/cells/batch", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await bold.click();
    await expect(bold).toBeDisabled();
    expect(await bold.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect(page.locator(".save-status")).toHaveCount(0);
    await expect(page.locator(".save-status")).toHaveText("저장 중");
    await expect(bold).toHaveCSS("opacity", "0.45");
    expect(await page.getByRole("grid").boundingBox()).toEqual(gridBox);
    release();
    await expect(bold).toBeEnabled();
    await expect(bold).toHaveCSS("opacity", "1");
    await expect(page.locator(".save-status")).toHaveCount(0);
  } finally {
    release();
    await page.unroute("**/api/cells/batch");
  }
  await page.route("**/api/cells/batch", (route) =>
    route.fulfill({ status: 503, json: { error: "저장 실패 검증" } }),
  );
  await bold.click();
  await expect(page.locator(".save-status")).toHaveText("저장 실패");
  await expect(page.getByRole("alert")).toContainText("저장 실패 검증");
});

test("변경 이력은 날짜 왼쪽의 상대 시간만 갱신하고 기록을 다시 조회하지 않는다", async ({
  page,
}, info) => {
  const now = Date.parse("2026-10-12T01:00:00.000Z");
  await page.clock.setFixedTime(new Date(now));
  const timestamps = [10, 90, 7200, 86400].map((seconds) =>
    new Date(now - seconds * 1000).toISOString(),
  );
  let loads = 0;
  await page.route("**/api/audit?*", (route) => {
    loads++;
    return route.fulfill({
      json: {
        entries: timestamps.map((createdAt, i) => ({
          id: `relative-time-${i}`,
          action: "create",
          actor: "지윤",
          createdAt,
          after: { title: "업무 추가" },
        })),
      },
    });
  });
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "변경 이력", exact: true });
  const relative = panel.locator(".audit-relative-time");
  await expect(relative).toHaveText([
    "10초 전",
    "1분 전",
    "2시간 전",
    "1일 전",
  ]);
  const time = panel.locator("time").first();
  await expect(time).toHaveAttribute("datetime", timestamps[0]);
  const absolute = await time.textContent();
  const left = (await relative.first().boundingBox())!;
  const right = (await time.boundingBox())!;
  expect(left.x + left.width).toBeLessThan(right.x);
  await panel.screenshot({
    path: info.outputPath("history-relative-time.png"),
  });
  await panel.locator("summary").first().click();
  await page.clock.setFixedTime(new Date(now + 51000));
  await expect(relative.first()).toHaveText("1분 전");
  await expect(time).toHaveText(absolute!);
  await expect(panel.locator("details").first()).toHaveAttribute("open", "");
  expect(loads).toBe(1);
});

for (const key of ["title", "2025-12-29"]) {
  test(`텍스트 셀을 선택한 뒤 바로 입력하면 첫 글자부터 순서대로 저장한다 (${key})`, async ({
    page,
  }) => {
    const target = page.locator(`[data-cell="${taskIds[0]}:${key}"]`);
    await target.click();
    const editor = target.getByRole("textbox");
    await expect(target.locator(".inline-editor")).toHaveCount(0);
    // fill()은 최초 키 입력으로 편집을 시작할 때의 커서 문제를 재현하지 못한다.
    await page.keyboard.type("somansa");
    await expect(editor).toHaveValue("somansa");
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([7, 7]);
    // 편집 도중 사용자가 옮긴 커서는 이후 입력에도 그대로 유지한다.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("-");
    await expect(editor).toHaveValue("somans-a");
    await page.keyboard.press("Backspace");
    await expect(editor).toHaveValue("somansa");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/cells/batch") && response.ok(),
      ),
      editor.press("Enter"),
    ]);
    await expect(target).toHaveText("somansa");
    await page.reload();
    await expect(target).toHaveText("somansa");
  });
}

for (const key of ["title", "2025-12-29"]) {
  test(`한글 IME는 셀 선택부터 같은 입력창에서 조합하고 저장한다 (${key})`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "브라우저의 IME 조합 명령은 Chromium CDP에서 제공한다.",
    );
    const client = await page.context().newCDPSession(page);
    const target = page.locator(`[data-cell="${taskIds[0]}:${key}"]`);
    await target.click();
    const input = target.locator("textarea");
    await expect(input).toBeFocused();
    const originalInput = await input.elementHandle();
    const compose = async (text: string) => {
      await client.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      expect(
        await originalInput!.evaluate(
          (element) =>
            element.isConnected && element === document.activeElement,
        ),
      ).toBe(true);
    };
    // isComposing이 아직 false인 첫 keydown도 조합 문자로 가로채지 않는다.
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Process",
      code: "KeyG",
      windowsVirtualKeyCode: 229,
    });
    for (const text of ["ㅎ", "하", "한"]) {
      await compose(text);
      await expect(input).toHaveValue(text);
    }
    await input.dispatchEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
    });
    await expect(target.locator(".inline-editor")).toHaveCount(1);
    await expect(input).toHaveValue("한");
    await client.send("Input.insertText", { text: "한" });
    for (const text of ["ㄱ", "그", "글"]) {
      await compose(text);
      await expect(input).toHaveValue(`한${text}`);
    }
    if (key === "title") {
      await client.send("Input.insertText", { text: "글" });
      await page.keyboard.type(" somansa");
      await expect(input).toHaveValue("한글 somansa");
    }
    const expected = key === "title" ? "한글 somansa" : "한글";
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/cells/batch") && response.ok(),
      ),
      key === "title"
        ? input.press("Enter")
        : page.locator(`[data-cell="${taskIds[1]}:title"]`).click(),
    ]);
    await expect(target).toHaveText(expected);
    await page.reload();
    await expect(target).toHaveText(expected);
    await client.detach();
  });
}

test("한글 조합 이벤트 중 입력창과 커서를 유지하고 조합 완료 후 취소할 수 있다", async ({
  page,
}) => {
  const target = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await target.click();
  const input = target.locator("textarea");
  await expect(input).toBeFocused();
  const originalInput = await input.elementHandle();
  await input.dispatchEvent("compositionstart", { data: "" });
  for (const text of ["ㅎ", "하", "한"]) {
    await input.dispatchEvent("compositionupdate", { data: text });
    await input.evaluate((element: HTMLTextAreaElement, text) => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(element, text);
      element.setSelectionRange(text.length, text.length);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: text,
          isComposing: true,
        }),
      );
    }, text);
    await expect(input).toHaveValue(text);
    expect(
      await originalInput!.evaluate((element: HTMLTextAreaElement) => [
        element === document.activeElement,
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([true, 1, 1]);
    await input.dispatchEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
    });
    await expect(target.locator(".inline-editor")).toHaveCount(1);
  }
  await input.dispatchEvent("compositionend", { data: "한" });
  await page.keyboard.type("somansa");
  await expect(input).toHaveValue("한somansa");
  await input.press("Escape");
  await expect(target.locator(".inline-editor")).toHaveCount(0);
  await expect(target).toHaveText("첫 업무");
  await expect(target.locator(".cell-input-ready textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(target).not.toHaveClass(/focused/);
  await expect(page.getByRole("grid")).toBeFocused();
});

test("선택한 텍스트 셀이 화면 밖에 나가도 입력 준비와 키보드 이동을 유지한다", async ({
  page,
}) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  for (let i = 0; i < 45; i++)
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: `스크롤 업무 ${i}`, owner: boot.user.id },
    });
  await page.reload();
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await first.click();
  const input = await first.locator("textarea").elementHandle();
  await page.getByRole("grid").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByRole("gridcell", { name: "스크롤 업무 44", exact: true }),
  ).toBeInViewport();
  await expect(first).not.toBeInViewport();
  expect(
    await input!.evaluate(
      (element) => element.isConnected && element === document.activeElement,
    ),
  ).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(second).toHaveClass(/focused/);
  await expect(second).toBeInViewport();
  await expect(second.locator(".cell-input-ready textarea")).toBeFocused();
  await page.keyboard.type("somansa");
  await expect(second.locator(".inline-editor textarea")).toHaveValue(
    "somansa",
  );
  await page.keyboard.press("Escape");
  await expect(second).toHaveText("숨길 업무");
});

test("IME 입력 준비 상태에서도 실제 복사·붙여넣기·실행취소와 방향키가 동작한다", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "실제 클립보드 권한을 사용하는 검사");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  await first.click();
  await expect(first.locator(".cell-input-ready textarea")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("첫 업무");
  await page.keyboard.press("ArrowDown");
  await expect(second).toHaveClass(/focused/);
  await expect(second.locator(".cell-input-ready textarea")).toBeFocused();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/cells/batch") && response.ok(),
    ),
    page.keyboard.press("ControlOrMeta+v"),
  ]);
  await expect(second).toHaveText("첫 업무");
  await expect(second.locator(".inline-editor")).toHaveCount(0);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/cells/batch") && response.ok(),
    ),
    page.keyboard.press("ControlOrMeta+z"),
  ]);
  await expect(second).toHaveText("숨길 업무");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator('.sheet-cell[aria-selected="true"]')).toHaveCount(
    2,
  );
});

test("더블클릭과 Enter·F2로 연 텍스트 편집은 기존 내용 전체 선택과 취소를 유지한다", async ({
  page,
}) => {
  const target = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  for (const action of ["double-click", "Enter", "F2"]) {
    if (action === "double-click") await target.dblclick();
    else {
      await target.click();
      await page.keyboard.press(action);
    }
    const editor = target.getByRole("textbox");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("첫 업무");
    expect(
      await editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, "첫 업무".length]);
    await page.keyboard.type("somansa");
    await expect(editor).toHaveValue("somansa");
    await editor.press("Escape");
    await expect(target).toHaveText("첫 업무");
  }
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
      )
        .json()
        .then(unpack);
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
    page.getByRole("menuitem", { name: "로그아웃", exact: true }),
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
    createdAt: new Date().toISOString(),
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
    )
      .json()
      .then(unpack)
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
for (const lastAction of ["셀 편집", "업무 추가"]) {
  test(`${lastAction}으로 51개 작업을 채우면 최근 50개만 실행취소·재실행한다`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
    const undo = page.getByRole("button", { name: "실행취소", exact: true });
    const redo = page.getByRole("button", { name: "재실행", exact: true });
    const bold = page.getByRole("button", { name: "굵게", exact: true });
    await first.click();
    await pasteContents(page, { "text/plain": "가장 오래된 편집" });
    await expect(first).toHaveText("가장 오래된 편집");
    await expect(bold).toBeEnabled();
    for (let i = 0; i < 49; i++) {
      await bold.click();
      await expect(bold).toBeEnabled();
    }
    let created: Locator | undefined;
    if (lastAction === "셀 편집") {
      await bold.click();
      await expect(bold).toBeEnabled();
    } else {
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/tasks") && r.request().method() === "POST",
        ),
        page
          .getByRole("button", { name: "업무 추가", exact: true })
          .first()
          .click(),
      ]);
      const { task } = await response.json().then(unpack);
      created = page.locator(`[data-cell="${task.id}:title"]`);
      await created.getByRole("textbox").press("Escape");
    }
    for (let i = 0; i < 50; i++) {
      await undo.click();
      await expect(redo).toBeEnabled();
    }
    await expect(undo).toBeDisabled();
    await expect(first).toHaveText("가장 오래된 편집");
    await expect(first).not.toHaveCSS("font-weight", "700");
    if (created) await expect(created).toHaveCount(0);
    for (let i = 0; i < 50; i++) {
      await redo.click();
      await expect(undo).toBeEnabled();
    }
    await expect(redo).toBeDisabled();
    if (created) await expect(created).toBeVisible();
    await undo.click();
    await expect(redo).toBeEnabled();
    await first.click();
    await pasteContents(page, { "text/plain": "실행취소 후 새 편집" });
    await expect(first).toHaveText("실행취소 후 새 편집");
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
  });
}

test("업무 추가 직후와 제목·서식 편집 후에도 단계별 실행취소·재실행이 가능하다", async ({
  page,
}) => {
  const undo = page.getByRole("button", { name: "실행취소", exact: true });
  const redo = page.getByRole("button", { name: "재실행", exact: true });
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await undo.click();
  await expect(redo).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page
      .getByRole("button", { name: "업무 추가", exact: true })
      .first()
      .click(),
  ]);
  const { task } = await response.json().then(unpack);
  const title = page.locator(`[data-cell="${task.id}:title"]`);
  await expect(title.getByRole("textbox")).toBeVisible();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  // Clicking undo also closes the untouched editor opened by task creation.
  await undo.click();
  await expect(title).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await redo.click();
  await expect(title).toBeVisible();
  await title.dblclick();
  await title.getByRole("textbox").fill("추가 후 제목 입력");
  await title.getByRole("textbox").press("Enter");
  await expect(title).toHaveText("추가 후 제목 입력");
  await title.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(title).toHaveCSS("font-weight", "700");
  await undo.click();
  await expect(title).not.toHaveCSS("font-weight", "700");
  await undo.click();
  await expect(title).toHaveText(task.cells.title?.value || "");
  // A failed delete keeps the same undo entry available for retry.
  await page.route(`**/api/tasks/${task.id}`, (route) =>
    route.fulfill({ status: 503, json: { error: "추가 취소 재시도" } }),
  );
  await undo.click();
  await expect(page.getByRole("alert")).toContainText("추가 취소 재시도");
  await expect(title).toBeVisible();
  await expect(undo).toBeEnabled();
  await page.unroute(`**/api/tasks/${task.id}`);
  await undo.click();
  await expect(title).toHaveCount(0);
  await redo.click();
  await expect(title).toBeVisible();
  await redo.click();
  await expect(title).toHaveText("추가 후 제목 입력");
  await redo.click();
  await expect(title).toHaveCSS("font-weight", "700");
  await expect(redo).toBeDisabled();
  await page.reload();
  await expect(title).toHaveText("추가 후 제목 입력");
  await expect(title).toHaveCSS("font-weight", "700");
  await expect(undo).toBeDisabled();
});

test("추가한 업무에 다른 변경이 있으면 자신의 편집을 취소해도 업무 추가 취소는 거절한다", async ({
  page,
}) => {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page
      .getByRole("button", { name: "업무 추가", exact: true })
      .first()
      .click(),
  ]);
  const { task } = await response.json().then(unpack);
  const title = page.locator(`[data-cell="${task.id}:title"]`);
  await title.getByRole("textbox").press("Escape");
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: task.id,
        key: "title",
        value: "다른 사용자의 제목",
        expectedVersion: task.cells.title?.version || 0,
      },
    ],
  });
  await expect(title).toHaveText("다른 사용자의 제목");
  await title.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(title).toHaveCSS("font-weight", "700");
  const undo = page.getByRole("button", { name: "실행취소", exact: true });
  await undo.click();
  await expect(title).not.toHaveCSS("font-weight", "700");
  let deletions = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletions++;
  });
  await undo.click();
  await expect(page.getByRole("alert")).toContainText(
    "이후 변경이 있어 되돌릴 수 없습니다",
  );
  expect(deletions).toBe(0);
  await expect(title).toHaveText("다른 사용자의 제목");
  await page.reload();
  await expect(title).toHaveText("다른 사용자의 제목");
});

test("업무 추가를 취소한 뒤 다른 사용자가 복구·수정·삭제하면 재실행은 복구 전에 거절한다", async ({
  page,
}) => {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page
      .getByRole("button", { name: "업무 추가", exact: true })
      .first()
      .click(),
  ]);
  const { task } = await response.json().then(unpack);
  const title = page.locator(`[data-cell="${task.id}:title"]`);
  await title.getByRole("textbox").press("Escape");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(title).toHaveCount(0);
  await post(page, `/tasks/${task.id}/restore`, {});
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: task.id,
        key: "title",
        expectedVersion: task.cells.title.version,
        value: "다른 사용자의 수정",
      },
    ],
  });
  const getTasks = async () =>
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack)
    ).tasks;
  const current = (await getTasks()).find((t: any) => t.id === task.id);
  const removed = await page.request.delete(`/api/tasks/${task.id}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { updatedAt: current.updatedAt },
  });
  expect(removed.ok()).toBeTruthy();
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "이후 변경이 있어 되돌릴 수 없습니다",
  );
  expect((await getTasks()).some((t: any) => t.id === task.id)).toBe(false);
  await expect(title).toHaveCount(0);
  await page.reload();
  await expect(title).toHaveCount(0);
});

test("업무 복제로 추가한 행도 같은 ID로 실행취소·재실행한다", async ({
  page,
}) => {
  await openRowDetails(page, page.locator(`[data-row-id="${taskIds[0]}"]`));
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "복제", exact: true }).click(),
  ]);
  const { task } = await response.json().then(unpack);
  const title = page.locator(`[data-cell="${task.id}:title"]`);
  await expect(title).toHaveText("첫 업무 사본");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(title).toHaveCount(0);
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(title).toHaveText("첫 업무 사본");
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

test("저장된 필터 목록은 항목 선택만 제공하고 닫기·바깥 클릭·Esc로 닫힌다", async ({
  page,
}) => {
  const menu = page.locator(".saved-views");
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "현재 필터 저장" }).click();
  await page.getByLabel("필터 이름").fill("필터 없는 보기");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(trigger).toHaveText("저장된 필터");
  await trigger.click();
  await expect(
    menu.getByRole("button", { name: /이름 변경|삭제/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "저장된 필터 닫기", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.locator(".sheet-scroll").click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await menu
    .getByRole("button", { name: "필터 없는 보기", exact: true })
    .click();
  await expect(banner.locator("strong")).toHaveText("필터 없는 보기");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveText("저장된 필터");
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
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
  await page.getByLabel("보고서 이름").fill("검증 보고본");
  await page.getByRole("button", { name: "현재 보기 저장" }).click();
  await expect(page.getByRole("button", { name: /검증 보고본/ })).toBeVisible();
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
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
  await expect(page.locator(".format-toolbar")).toHaveCount(0);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).dblclick();
  await expect(page.locator(".inline-editor")).toHaveCount(0);
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
    )
      .json()
      .then(unpack)
  ).tasks;
  const current = tasks.find((t: any) => t.id === taskIds[0]);
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
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
    )
      .json()
      .then(unpack)
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
    createdAt: new Date().toISOString(),
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
      return (await r.json().then(unpack)).views.find(
        (v: any) => v.name === "__current",
      )?.data.toWeek;
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

test("여러 줄 텍스트 편집창은 내용에 맞춰 늘고 줄며 행 높이를 유지한다", async ({
  page,
}, info) => {
  const original =
    "첫 번째 줄\n두 번째 줄\n세 번째 줄\n네 번째 줄\n다섯 번째 줄";
  await setTaskCells(page, [{ index: 0, key: "title", value: original }]);
  await page.reload();
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  const input = first.getByRole("textbox");
  await expect(first).toHaveText(original);
  const rowHeight = (await first.boundingBox())!.height;
  const nextRowTop = (await second.boundingBox())!.y;
  const rowHeights = async () =>
    (await readPreferences(page, teamId)).views.find(
      (view: any) => view.name === "__current",
    )?.data.rowHeights || {};
  const savedHeights = await rowHeights();
  await first.dblclick();
  await expect(input).toBeFocused();
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(rowHeight);
  const initialHeight = (await input.boundingBox())!.height;
  expect(
    await input.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  expect((await first.boundingBox())!.height).toBe(rowHeight);
  expect((await second.boundingBox())!.y).toBe(nextRowTop);
  // 펼쳐진 부분도 다음 행에 가려지지 않고 실제로 편집할 수 있어야 한다.
  expect(
    await input.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        document.elementFromPoint(box.x + box.width / 2, box.bottom - 8) === el
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("expanded-text-editor.png") });
  const longer = original + "\n여섯 번째 줄\n일곱 번째 줄";
  await input.fill(longer);
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(initialHeight);
  const beforeNewline = (await input.boundingBox())!.height;
  await input.press("Shift+Enter");
  await expect(input).toHaveValue(longer + "\n");
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(beforeNewline);
  await input.fill("짧은 내용");
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeLessThanOrEqual(rowHeight);
  await input.fill(longer);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/cells/batch") && response.ok(),
    ),
    input.press("Enter"),
  ]);
  await expect(input).toHaveCount(0);
  await expect(first).toHaveText(longer);
  await expect(second.locator(".cell-input-ready textarea")).toBeFocused();
  expect((await first.boundingBox())!.height).toBe(rowHeight);
  expect((await second.boundingBox())!.y).toBe(nextRowTop);
  await page.reload();
  await expect(first).toHaveText(longer);
  await first.dblclick();
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(rowHeight);
  await input.fill("취소할 내용\n두 줄");
  await input.press("Escape");
  await expect(first).toHaveText(longer);
  expect((await first.boundingBox())!.height).toBe(rowHeight);
  expect(await rowHeights()).toEqual(savedHeights);
});

test("긴 텍스트 편집창은 확대율과 화면 경계에 맞추고 내부에서 스크롤한다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1366, height: 480 });
  const cell = page.locator(`[data-cell="${taskIds[2]}:title"]`);
  const zoom = page
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
    .getByRole("spinbutton", { name: "확대율", exact: true });
  const input = cell.locator(".inline-editor textarea");
  const text = Array.from(
    { length: 80 },
    (_, i) => `${i + 1}번째 긴 내용`,
  ).join("\n");
  for (const value of [50, 150]) {
    await page.setViewportSize({ width: 1366, height: 480 });
    await zoom.fill(String(value));
    await zoom.press("Enter");
    await cell.dblclick();
    await input.fill(text);
    await expect(input).toBeFocused();
    const fits = () =>
      input.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const grid = el.closest(".sheet-scroll")!.getBoundingClientRect();
        const header = el
          .closest(".sheet-scroll")!
          .querySelector(".sheet-header")!
          .getBoundingClientRect();
        return (
          box.top >= header.bottom - 1 &&
          box.bottom <= Math.min(grid.bottom, window.innerHeight) + 1
        );
      });
    await expect.poll(fits).toBe(true);
    expect(
      await input.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    expect(
      await input.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return (
          document.elementFromPoint(box.x + box.width / 2, box.y + 8) === el
        );
      }),
    ).toBe(true);
    await input.evaluate((el) => {
      el.scrollTop = 0;
    });
    await input.hover();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() => input.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    const height = (await input.boundingBox())!.height;
    await page.setViewportSize({ width: 1366, height: 700 });
    await expect.poll(fits).toBe(true);
    await expect
      .poll(async () => (await input.boundingBox())!.height)
      .toBeGreaterThan(height);
    await expect(input).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`bounded-text-editor-${value}.png`),
    });
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(cell).toHaveText("셋째 업무");
    await expect(cell.locator(".cell-input-ready textarea")).toBeFocused();
  }
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.sortDirection,
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
  const adminData = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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

test("설정 완료 토스트는 연속 저장 때 시간을 갱신하고 저장 실패에는 표시하지 않는다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "설정", exact: true });
  const toast = dialog.locator(".toast");
  const save = dialog
    .getByRole("tabpanel")
    .getByRole("button", { name: "저장", exact: true });
  await page.clock.install();
  await save.click();
  await expect(toast).toHaveText("팀 정보를 저장했습니다.");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toBeInViewport();
  await expect(toast).toHaveCSS("position", "fixed");
  await page.screenshot({ path: info.outputPath("settings-saved-toast.png") });
  await page.clock.fastForward(3000);
  await save.click();
  await expect(toast).toHaveText("팀 정보를 저장했습니다.");
  await expect(save).toBeEnabled();
  await page.clock.fastForward(3000);
  await expect(toast).toBeVisible();
  await page.clock.fastForward(1100);
  await expect(toast).toHaveCount(0);
  await page.route(
    `**/api/teams/${teamId}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "팀 정보 저장 실패" }),
      }),
    { times: 1 },
  );
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("팀 정보 저장 실패");
  await expect(toast).toHaveCount(0);
  await dialog.getByRole("tab", { name: "기본 서식", exact: true }).click();
  await dialog
    .getByRole("button", { name: "기본 서식 저장", exact: true })
    .click();
  await expect(toast).toHaveText("기본 서식을 저장했습니다.");
  await expect(toast).toBeInViewport();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.clock.fastForward(5000);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(dialog.locator(".toast")).toHaveCount(0);
});

test("팀 구성원 탭에서 사용자를 추가하고 팀마다 다른 권한을 지정한다", async ({
  page,
}, info) => {
  const suffix = randomUUID().slice(0, 6),
    username = `member-${suffix}@example.com`,
    newName = `협업 ${suffix}`,
    renamed = `이름 변경 ${suffix}`;
  const original = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
    page.getByRole("dialog", { name: "설정", exact: true }).locator(".toast"),
  ).toHaveText("배속 검증님의 권한을 팀원(으)로 변경했습니다.");
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
  const users = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
  ).users;
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
    .press("Alt+ArrowLeft");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("property-management.png"),
    fullPage: true,
  });
  const data = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(first).toHaveText("🚀A 서비스");
  await first.locator(".property-badge").dblclick();
  await expect(
    page.getByRole("listbox", { name: "제품 프로젝트 편집", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.groupBy,
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

test("속성 칩·글자는 한 번 클릭해 셀을 선택하고 더블클릭해 목록을 열며 행 높이를 유지한다", async ({
  page,
}, info) => {
  const category = page.locator(`[data-cell="${taskIds[0]}:category"]`);
  const title = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const height = (await category.boundingBox())!.height;
  await category.click({ position: { x: 4, y: 4 } });
  await expect(category).toHaveClass(/focused/);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await title.click();
  await expect(title.locator(".inline-editor")).toHaveCount(0);
  const trigger = category.getByRole("button", {
    name: "분류 선택",
    exact: true,
  });
  const popup = page.getByRole("listbox", { name: "분류 편집", exact: true });
  await trigger.click();
  await expect(category).toHaveClass(/focused/);
  await expect(popup).toHaveCount(0);
  await trigger.dblclick();
  await expect(popup).toBeVisible();
  expect((await category.boundingBox())!.height).toBe(height);
  const cellBox = (await category.boundingBox())!,
    popupBox = (await popup.boundingBox())!;
  expect(popupBox.y).toBeGreaterThanOrEqual(cellBox.y + cellBox.height);
  await popup.getByRole("option", { name: "UX 개선", exact: true }).click();
  await expect(category).toHaveText("UX 개선");
  await category.locator(".property-badge").dblclick();
  await expect(popup).toBeVisible();
  await page.screenshot({
    path: info.outputPath("property-double-click.png"),
    fullPage: true,
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(category).toHaveText("차별화");
  expect((await category.boundingBox())!.height).toBe(height);
  await trigger.focus();
  await trigger.press("Enter");
  await expect(popup).toBeVisible();
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
  await expect(supporters).toHaveClass(/focused/);
  await expect(people).toHaveCount(0);
  await supporters
    .getByRole("button", { name: "지원자 선택", exact: true })
    .dblclick();
  await people.getByRole("option").first().click();
  await page.keyboard.press("Escape");
  await expect(supporters).toContainText(name.trim());
});

test("옵션을 키보드로 확정한 뒤 방향키로 셀 이동을 계속한다", async ({
  page,
}) => {
  const row = page.locator(`[data-row-id="${taskIds[0]}"]`);
  const keys = await row
    .locator("[data-column]")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute("data-column")!),
    );
  const categoryIndex = keys.indexOf("category");
  expect(categoryIndex).toBeGreaterThanOrEqual(0);
  expect(categoryIndex).toBeLessThan(keys.length - 1);
  const category = row.locator('[data-column="category"]');
  const next = row.locator(`[data-column="${keys[categoryIndex + 1]}"]`);
  const popup = page.getByRole("listbox", { name: "분류 편집", exact: true });
  await row.locator('[data-column="title"]').click();
  const offset = categoryIndex - keys.indexOf("title");
  for (let i = 0; i < Math.abs(offset); i++)
    await page.keyboard.press(offset < 0 ? "ArrowLeft" : "ArrowRight");
  await expect(category).toHaveClass(/focused/);
  await page.keyboard.press("Enter");
  await expect(
    popup.getByRole("option", { name: "UX 개선", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    popup.getByRole("option", { name: "차별화", exact: true }),
  ).toBeFocused();
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/cells/batch") && response.ok(),
  );
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect(category).toHaveText("차별화");
  await page.keyboard.press("ArrowRight");
  await expect(next).toHaveClass(/focused/);
  await expect(next.locator(".cell-input-ready textarea")).toBeFocused();
  await saved;

  // 값이 바뀌지 않는 재선택도 포커스를 표로 돌려줘야 한다.
  await page.keyboard.press("ArrowLeft");
  await expect(category).toHaveClass(/focused/);
  await page.keyboard.press("Enter");
  await expect(
    popup.getByRole("option", { name: "차별화", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(next).toHaveClass(/focused/);
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator(`[data-cell="${taskIds[1]}:${keys[categoryIndex + 1]}"]`),
  ).toHaveClass(/focused/);
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
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
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
    )
      .json()
      .then(unpack)
  ).tasks;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
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
    )
      .json()
      .then(unpack)
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.hiddenRows,
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
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
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
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.rowHeights[taskIds[0]],
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
  const data = await (
    await page.request.get("/api/admin/users")
  )
    .json()
    .then(unpack);
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.propertyFilters?.status?.length,
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
      page.locator(`.period-month[data-month="${from}"]`),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(`.period-month[data-month="${to}"]`),
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
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.propertyFilterModes,
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
      .locator('.format-toolbar[aria-label="셀 서식 도구"]')
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
    createdAt: new Date().toISOString(),
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

test("상단은 한 줄이고 발표 모드에서 전용 도구와 표를 표시한 뒤 필터·위치·편집으로 복귀한다", async ({
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
  const tools = page.getByRole("toolbar", { name: "보기모드 도구" });
  const toolsBox = (await tools.boundingBox())!;
  expect(toolsBox.y).toBe(0);
  expect(box.x).toBe(0);
  expect(box.y).toBe(toolsBox.height);
  expect(box.width).toBe(1366);
  expect(box.height).toBe(900 - toolsBox.height);
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
  await expect(
    tools.getByRole("button", { name: "보기모드 닫기 (Esc)" }),
  ).toBeVisible();
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
    .getByRole("button", { name: "보기모드 닫기 (Esc)", exact: true })
    .click();
  await expect(heading).toBeVisible();
});

test("보기모드에서 색상·펜·도형·지우개·실행취소·확대 도구를 사용하고 종료하면 원본을 유지한다", async ({
  page,
}, info) => {
  await expect
    .poll(async () =>
      (await readPreferences(page, teamId)).views.some(
        (v: any) => v.name === "__current",
      ),
    )
    .toBeTruthy();
  const original = await (
    await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
  )
    .json()
    .then(unpack);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(views|cells)/.test(request.url())
    )
      writes.push(request.url());
  });
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
  const grid = page.getByRole("grid");
  const annotations = page.locator("[data-annotation]:not([data-draft])");
  const laser = toolbar.getByRole("button", {
    name: "레이저 포인터",
    exact: true,
  });
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(
    toolbar
      .getByRole("group", { name: "펜 색상", exact: true })
      .getByRole("button"),
  ).toHaveCount(5);
  await expect(
    toolbar.getByRole("button", { name: "필기 실행취소", exact: true }),
  ).toBeDisabled();
  const draw = async (x1: number, y1: number, x2: number, y2: number) => {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 12 });
    await page.mouse.up();
  };
  await page.mouse.move(500, 200);
  await expect(page.locator(".presentation-pointer.laser i")).toBeVisible();
  await draw(500, 200, 600, 210);
  await expect(annotations).toHaveCount(0);
  for (const [i, color] of ["빨강", "노랑", "초록", "파랑", "보라"].entries()) {
    await toolbar
      .getByRole("button", { name: `펜 색상 ${color}`, exact: true })
      .click();
    await expect(
      toolbar.getByRole("button", { name: "펜", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await draw(500, 200 + 30 * i, 600, 210 + 30 * i);
  }
  await expect(annotations).toHaveCount(5);
  expect(
    new Set(
      await annotations.evaluateAll((els) =>
        els.map((el) => el.getAttribute("stroke")),
      ),
    ).size,
  ).toBe(5);
  for (const [name, x1, y1, x2, y2] of [
    ["사각형", 400, 380, 520, 450],
    ["원", 650, 380, 770, 450],
    ["화살표", 870, 385, 980, 445],
  ] as const) {
    await toolbar.getByRole("button", { name, exact: true }).click();
    await draw(x1, y1, x2, y2);
  }
  await expect(annotations).toHaveCount(8);
  await toolbar.getByRole("button", { name: "지우개", exact: true }).click();
  // 도형 내부의 빈 곳은 유지하고, 외곽선을 지날 때 해당 도형만 지운다.
  await page.mouse.click(710, 415);
  await expect(annotations).toHaveCount(8);
  await page.mouse.click(650, 415);
  await expect(annotations).toHaveCount(7);
  await expect(page.locator('[data-annotation="ellipse"]')).toHaveCount(0);
  await toolbar
    .getByRole("button", { name: "필기 실행취소", exact: true })
    .click();
  await expect(annotations).toHaveCount(8);
  await toolbar
    .getByRole("button", { name: "전체 지우기", exact: true })
    .click();
  await expect(annotations).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(annotations).toHaveCount(8);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const originalWidth = (await first.boundingBox())!.width;
  await toolbar.getByRole("button", { name: "확대", exact: true }).click();
  await toolbar.getByRole("button", { name: "확대", exact: true }).click();
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue(
    "150",
  );
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeCloseTo(originalWidth * 1.5, 0);
  const pen = page.locator('[data-annotation="pen"]').first();
  const beforeScroll = (await pen.boundingBox())!;
  await grid.evaluate((el) => {
    el.scrollLeft = 100;
  });
  await expect
    .poll(async () => (await pen.boundingBox())!.x)
    .toBeCloseTo(beforeScroll.x - 150, 0);
  await toolbar.getByRole("button", { name: "원래대로", exact: true }).click();
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue(
    "100",
  );
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeCloseTo(originalWidth, 0);
  await toolbar.getByRole("button", { name: "축소", exact: true }).click();
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue("75");
  await toolbar.getByRole("button", { name: "원래대로", exact: true }).click();
  await grid.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(910, 510);
  await page.screenshot({ path: info.outputPath("presentation-tools.png") });
  expect(writes).toEqual([]);
  expect(
    (
      await (
        await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack)
    ).tasks,
  ).toEqual(original.tasks);
  await toolbar.getByRole("button", { name: "보기모드 닫기 (Esc)" }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(annotations).toHaveCount(0);
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeCloseTo(originalWidth, 0);
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue(
    "100",
  );
  await expect(annotations).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("보기모드 레이저를 켜고 끄며 크기와 확대율을 직접 조절한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
  const grid = page.getByRole("grid");
  const laser = toolbar.getByRole("button", {
    name: "레이저 포인터",
    exact: true,
  });
  const pointer = page.locator(".presentation-pointer.laser i");
  await page.mouse.move(550, 250);
  await expect(pointer).toBeVisible();
  await expect(pointer).toHaveCSS("width", "14px");
  for (let i = 0; i < 3; i++) await page.mouse.click(550 + i * 30, 250);
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(pointer).toBeVisible();
  // 툴바로 옮겨도 레이저를 유지하며, 같은 버튼을 다시 눌러 해제한다.
  await laser.hover();
  await expect(pointer).toBeVisible();
  await laser.click();
  await expect(laser).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(550, 250);
  await expect(pointer).toBeHidden();
  await expect(grid).toHaveCSS("cursor", "default");
  await expect(page.locator("[data-annotation]")).toHaveCount(0);
  await laser.click();
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(pointer).toBeVisible();
  const size = toolbar.getByRole("slider", { name: "레이저 포인터 크기" });
  await size.focus();
  await size.press("End");
  await expect(size).toHaveValue("20");
  await expect(pointer).toHaveCSS("width", "20px");
  await size.press("Home");
  await expect(pointer).toHaveCSS("width", "12px");
  await size.press("ArrowRight");
  await expect(pointer).toHaveCSS("width", "14px");

  const pen = toolbar.getByRole("button", { name: "펜", exact: true });
  await pen.click();
  await page.mouse.move(500, 240);
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(pointer).toBeVisible();
  await expect(grid).toHaveCSS("cursor", "none");
  await page.mouse.down();
  await page.mouse.move(650, 290, { steps: 10 });
  await page.mouse.up();
  const marks = page.locator("[data-annotation]:not([data-draft])");
  await expect(marks).toHaveCount(1);
  // 레이저만 끄고 켜도 선택된 펜과 그리기는 그대로 유지한다.
  await laser.click();
  await expect(laser).toHaveAttribute("aria-pressed", "false");
  await expect(pen).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(700, 240);
  await expect(pointer).toBeHidden();
  await expect(grid).toHaveCSS("cursor", "crosshair");
  await page.mouse.down();
  await page.mouse.move(800, 290, { steps: 5 });
  await page.mouse.up();
  await expect(marks).toHaveCount(2);
  await laser.click();
  await expect(laser).toHaveAttribute("aria-pressed", "true");
  await expect(pen).toHaveAttribute("aria-pressed", "true");
  await toolbar
    .getByRole("button", { name: "펜 색상 파랑", exact: true })
    .click();
  await page.mouse.move(700, 350);
  await expect(pointer).toBeVisible();
  await expect(grid).toHaveCSS("cursor", "none");
  // 펜을 해제하면 레이저 표시만 남는다.
  await pen.click();
  await expect(pen).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(700, 350);
  await expect(marks).toHaveCount(2);
  await expect(pointer).toBeVisible();
  const mark = marks.first();
  const markWidth = (await mark.boundingBox())!.width;
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const width = (await cell.boundingBox())!.width;
  const zoom = toolbar.getByRole("spinbutton", { name: "확대율", exact: true });
  await zoom.fill("133");
  await zoom.press("Enter");
  await expect(zoom).toHaveValue("133");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(width * 1.33, 0);
  await expect
    .poll(async () => (await mark.boundingBox())!.width)
    .toBeCloseTo(markWidth * 1.33, 0);
  await zoom.fill("175");
  await zoom.press("Escape");
  await expect(toolbar).toBeVisible();
  await expect(zoom).toHaveValue("133");
  await zoom.fill("88");
  // 숫자 입력 중 실행취소가 필기를 지우면 안 된다.
  await zoom.press("ControlOrMeta+z");
  await expect(marks).toHaveCount(2);
  await zoom.fill("88");
  await zoom.press("Tab");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(width * 0.88, 0);
  for (const [value, result] of [
    ["", "88"],
    ["999", "200"],
    ["2", "50"],
  ]) {
    await zoom.fill(value);
    await zoom.press("Enter");
    await expect(zoom).toHaveValue(result);
  }
  await toolbar.getByRole("button", { name: "원래대로", exact: true }).click();
  await expect(zoom).toHaveValue("100");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(width, 0);
});

test("발표모드에서 링크를 클릭해 열고 링크 위 드래그는 필기로 남긴다", async ({
  page,
  context,
}) => {
  const created = await post(page, "/tasks", {
    teamId,
    year: 2026,
    fields: { title: "#234566 https://example.test/" },
  });
  await page.reload();
  const cell = page.locator(`[data-cell="${created.task.id}:title"]`);
  await expect(cell).toBeVisible();
  const url = cell.getByRole("link", {
    name: "https://example.test/",
    exact: true,
  });
  const issue = cell.getByRole("link", { name: "#234566", exact: true });
  await context.route(
    /https:\/\/example\.test\/|http:\/\/redmine\.somansa\.com\/redmine\/issues\/234566/,
    (route) =>
      route.fulfill({
        contentType: "text/plain; charset=utf-8",
        body: "Presentation link opened",
      }),
  );
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
  const laser = toolbar.getByRole("button", {
    name: "레이저 포인터",
    exact: true,
  });
  const marks = page.locator("[data-annotation]");
  const openLink = async (link: Locator, keyboard = false) => {
    const popupPromise = page.waitForEvent("popup");
    if (keyboard) {
      await link.focus();
      await page.keyboard.press("Enter");
    } else await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL((await link.getAttribute("href"))!);
    await expect(popup.locator("body")).toHaveText("Presentation link opened");
    await popup.close();
    await page.bringToFront();
    await expect(toolbar).toBeVisible();
  };
  await openLink(issue);
  await laser.click();
  await openLink(url);
  await laser.click();
  for (const name of ["펜", "사각형", "원", "화살표", "지우개"]) {
    await toolbar.getByRole("button", { name, exact: true }).click();
    await openLink(url);
    await expect(laser).toHaveAttribute("aria-pressed", "true");
    await expect(marks).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "필기 실행취소", exact: true }),
    ).toBeDisabled();
  }
  await toolbar.getByRole("button", { name: "펜", exact: true }).click();
  const box = (await url.boundingBox())!;
  const popupCount: Page[] = [];
  page.on("popup", (popup) => popupCount.push(popup));
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2 + 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(
    page.locator('[data-annotation="pen"]:not([data-draft])'),
  ).toHaveCount(1);
  expect(popupCount).toHaveLength(0);
  // 드래그 직후의 키보드 링크 열기와 다음 클릭도 차단되지 않는다.
  await openLink(issue, true);
  await openLink(url);
  await expect(marks).toHaveCount(1);
  await expect(cell).toHaveText("#234566 https://example.test/");
  await expect(page.locator(".inline-editor")).toHaveCount(0);
});

test("보기모드 필기는 포인터 캡처 해제·입력 중단·표 밖에서 놓기에도 유지된다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
  const grid = page.getByRole("grid");
  const marks = page.locator("[data-annotation]:not([data-draft])");
  // 실제 마우스 입력의 포인터 ID로 캡처를 풀어 브라우저의 캡처 상실을 재현한다.
  await grid.evaluate((el) => {
    el.addEventListener("gotpointercapture", (event) => {
      el.setAttribute(
        "data-test-pointer-id",
        String((event as PointerEvent).pointerId),
      );
    });
  });
  for (const [i, name] of ["펜", "사각형", "원", "화살표"].entries()) {
    await toolbar.getByRole("button", { name, exact: true }).click();
    await page.mouse.move(400, 200 + i * 90);
    await page.mouse.down();
    await page.mouse.move(470, 225 + i * 90, { steps: 4 });
    await expect(page.locator("[data-draft]")).toHaveCount(1);
    await grid.evaluate((el) => {
      el.releasePointerCapture(Number(el.getAttribute("data-test-pointer-id")));
    });
    await page.mouse.move(580, 250 + i * 90, { steps: 4 });
    await page.mouse.up();
    await expect(marks).toHaveCount(i + 1);
    // 캡처가 풀린 뒤의 좌표까지 반영되고 초안이 남지 않아야 한다.
    expect((await marks.nth(i).boundingBox())!.width).toBeGreaterThan(170);
    await expect(page.locator("[data-draft]")).toHaveCount(0);
  }
  await toolbar.getByRole("button", { name: "펜", exact: true }).click();
  for (const reason of ["pointercancel", "blur", "outside"] as const) {
    const before = await marks.count();
    await page.mouse.move(700, 350);
    await page.mouse.down();
    await page.mouse.move(780, 390, { steps: 5 });
    if (reason === "pointercancel") {
      await grid.evaluate((el) => {
        el.dispatchEvent(
          new PointerEvent("pointercancel", {
            pointerId: Number(el.getAttribute("data-test-pointer-id")),
            bubbles: true,
          }),
        );
      });
    } else if (reason === "blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else {
      await page.mouse.move(850, 20, { steps: 5 });
    }
    await page.mouse.up();
    await expect(marks).toHaveCount(before + 1);
    await expect(page.locator("[data-draft]")).toHaveCount(0);
    const points = await marks
      .last()
      .locator("polyline")
      .getAttribute("points");
    await page.mouse.move(1000, 600);
    await expect(marks.last().locator("polyline")).toHaveAttribute(
      "points",
      points!,
    );
    await toolbar
      .getByRole("button", { name: "필기 실행취소", exact: true })
      .click();
    await expect(marks).toHaveCount(before);
  }
});

test("보기모드 도구는 좁은 화면에서도 닫기를 유지하고 확대 한도와 키보드 이동을 제공한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const toolbar = page.getByRole("toolbar", { name: "보기모드 도구" });
  const close = toolbar.getByRole("button", { name: "보기모드 닫기 (Esc)" });
  const zoomIn = toolbar.getByRole("button", { name: "확대", exact: true });
  const zoomOut = toolbar.getByRole("button", { name: "축소", exact: true });
  const box = (await close.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(
    await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  for (let i = 0; i < 4; i++) await zoomIn.click();
  await expect(zoomIn).toBeDisabled();
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue(
    "200",
  );
  for (let i = 0; i < 6; i++) await zoomOut.click();
  await expect(zoomOut).toBeDisabled();
  await expect(toolbar.getByLabel("확대율", { exact: true })).toHaveValue("50");
  await toolbar.getByRole("button", { name: "원래대로", exact: true }).click();
  const laser = toolbar.getByRole("button", {
    name: "레이저 포인터",
    exact: true,
  });
  await laser.focus();
  await page.keyboard.press("ArrowRight");
  const pen = toolbar.getByRole("button", { name: "펜", exact: true });
  await expect(pen).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pen).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: info.outputPath("presentation-tools-mobile.png"),
  });
  await page.keyboard.press("End");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toolbar).toHaveCount(0);
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  const stored = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  const updated = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
  ).teams.find((t: any) => t.id === teamId).settings;
  expect(
    updated.properties.find((p: any) => p.id === prop.id).archived,
  ).toBeTruthy();
  const tasks = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
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
      const data = await readPreferences(page, teamId);
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
      return (await r.json().then(unpack)).tasks.find(
        (t: any) => t.id === taskIds[0],
      ).cells.title.style.textMode;
    })
    .toBe("overflow");
  await page.reload();
  await expect(title).toHaveText(text);
  await expect(title).toHaveAttribute("data-text-mode", "overflow");
  await expect(target).toHaveAttribute("data-text-mode", "clip");
});

test("속성 관리에서 모든 열·다섯 타입·표시 순서·삭제와 작업 이름을 관리한다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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
  const propertyList = page.getByRole("group", {
    name: "열 순서",
    exact: true,
  });
  const selectedCard = propertyList.locator(".property-list-row.current");
  for (const [kind, name] of [
    ["option", "우선 선택"],
    ["text", "메모 값"],
    ["date", "검토 날짜"],
    ["number", "예상 시간"],
    ["member", "검토 팀원"],
  ]) {
    await propertyList.evaluate((el) => (el.scrollLeft = 0));
    await page.getByRole("button", { name: "속성 추가", exact: true }).click();
    await expect(selectedCard).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("속성 이름", { exact: true })).toBeFocused();
    if (kind === "option") {
      // Reusing an unnamed card must reveal it again without adding a duplicate.
      const count = await propertyList.locator(".property-list-row").count();
      const id = await selectedCard.getAttribute("data-column-item");
      await propertyList.evaluate((el) => (el.scrollLeft = 0));
      await expect(selectedCard).not.toBeInViewport();
      await page
        .getByRole("button", { name: "속성 추가", exact: true })
        .click();
      await expect(propertyList.locator(".property-list-row")).toHaveCount(
        count,
      );
      await expect(selectedCard).toHaveAttribute("data-column-item", id!);
      await expect(selectedCard).toBeInViewport({ ratio: 1 });
    }
    await page.getByLabel("속성 이름", { exact: true }).fill(name);
    await page.getByLabel("타입", { exact: true }).selectOption(kind);
    await expect(selectedCard.locator("small")).toHaveText(
      kind[0].toUpperCase() + kind.slice(1),
    );
    await expect(page.locator(".property-type-label small")).toHaveCount(0);
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
    .press("Alt+ArrowLeft");
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: info.outputPath("unified-property-management.png"),
    fullPage: true,
  });
  const settings = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
  await setColumns(page, [], ["메모 값"]);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
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
  await setColumns(page, ["메모 값"]);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByText("보관된 속성", { exact: true }).click();
  await page.getByRole("button", { name: "진척률 복원", exact: true }).click();
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(c("메모 값")).toHaveText("직접 입력");
  const latest = (
    await (await page.request.get("/api/admin/users")).json().then(unpack)
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
    "2026년 3월 · 드래그하여 여러 월 선택",
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

test("속성 카드는 목록 아래로 대각선으로 끌어도 이동하고 취소할 수 있다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  const rows = page.locator(".property-list-row");
  const order = () =>
    rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    );
  const before = await order();
  const first = (await rows.first().boundingBox())!;
  const third = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(first.x + 18, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + 18, third.y + third.height + 70, {
    steps: 12,
  });
  const preview = page.locator(".property-drag-preview");
  await expect(preview).toBeVisible();
  const previewBox = (await preview.boundingBox())!;
  expect(Math.abs(previewBox.y - first.y)).toBeLessThan(2);
  await page.screenshot({
    path: info.outputPath("property-card-drag-preview.png"),
  });
  await page.mouse.up();
  const expected = [before[1], before[2], before[0], ...before.slice(3)];
  await expect.poll(order).toEqual(expected);
  await expect(preview).toHaveCount(0);
  await rows.first().locator(".property-select").hover();
  await page.mouse.down();
  await page.mouse.move(third.x + 18, first.y - 70, { steps: 12 });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "설정", exact: true }),
  ).toBeVisible();
  await expect.poll(order).toEqual(expected);
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await expect.poll(order).toEqual(expected);
});

test("속성 카드를 목록 양 끝까지 끌면 자동으로 스크롤하며 이동한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  const list = page.getByRole("group", { name: "열 순서" });
  const rows = list.locator(".property-list-row");
  const order = () =>
    rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    );
  const original = await order();
  const viewport = (await list.boundingBox())!;
  await rows.first().locator(".list-drag-handle").hover();
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width - 8,
    viewport.y + viewport.height + 20,
    { steps: 12 },
  );
  await expect
    .poll(() =>
      list.evaluate(
        (el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
      ),
    )
    .toBe(true);
  await page.mouse.up();
  const moved = [...original.slice(1), original[0]];
  await expect.poll(order).toEqual(moved);
  await expect(page.locator(".property-drag-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "속성 저장", exact: true }).click();
  await expect(
    page.getByText("속성이 저장되었습니다.", { exact: true }),
  ).toBeVisible();

  await rows.last().locator(".list-drag-handle").hover();
  await page.mouse.down();
  await page.mouse.move(viewport.x + 8, viewport.y + viewport.height + 20, {
    steps: 12,
  });
  await expect.poll(() => list.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.mouse.up();
  await expect.poll(order).toEqual(original);
});

test("속성 카드의 여백과 이웃 카드의 손잡이 위치에서도 끌어 순서를 바꾼다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  const rows = page.locator(".property-list-row");
  const order = () =>
    rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    );
  const original = await order();
  const selected = await page
    .locator(".property-select[aria-pressed=true]")
    .innerText();
  const swapped = [original[1], original[0], ...original.slice(2)];

  // 카드를 잡은 위치와 같은 위치에 놓는다. 대상의 왼쪽 절반이어도
  // 바로 오른쪽 카드에 놓았다면 그 자리로 순서를 옮겨야 한다.
  const targetHandle = (await rows
    .nth(1)
    .locator(".list-drag-handle")
    .boundingBox())!;
  await rows.first().locator(".list-drag-handle").hover();
  await page.mouse.down();
  await page.mouse.move(
    targetHandle.x + targetHandle.width / 2,
    targetHandle.y + targetHandle.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(order).toEqual(swapped);
  await expect(page.locator(".property-drag-preview")).toHaveCount(0);

  // 손잡이·텍스트 바깥 카드 패딩에서도 드래그를 시작할 수 있다.
  const sourceBox = (await rows.nth(1).boundingBox())!;
  const targetBox = (await rows.first().boundingBox())!;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(order).toEqual(original);
  await expect(page.locator(".property-select[aria-pressed=true]")).toHaveText(
    selected,
    { useInnerText: true },
  );
});

test("속성은 가로로 끌어 이동하고 선택값은 세로로 이동하며 열 너비를 유지한다", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  const rows = page.locator(".property-list-row");
  const before = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-column-item")),
  );
  await expect(
    page.getByRole("group", { name: "열 순서" }).getByRole("checkbox"),
  ).toHaveCount(0);
  const layout = await rows.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }),
  );
  expect(new Set(layout.map((box) => box.y)).size).toBe(1);
  expect(layout[1].x).toBeGreaterThan(layout[0].x);
  const source = rows.nth(0).locator(".list-drag-handle");
  const target = rows.nth(1);
  const box = (await target.boundingBox())!;
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + 18, box.y + box.height / 2, {
    steps: 8,
  });
  await expect(page.locator(".property-drag-preview")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".property-drag-preview")).toHaveCount(0);
  const expected = [before[1], before[0], ...before.slice(2)];
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(expected);
  // 속성 이름으로도 끌 수 있고, 이동 후에는 선택한 편집 속성이 바뀌지 않는다.
  const selected = await page
    .locator(".property-select[aria-pressed=true]")
    .innerText();
  const movedName = rows.nth(1).locator(".property-select");
  const firstColumn = (await rows.first().boundingBox())!;
  await movedName.hover();
  await page.mouse.down();
  await page.mouse.move(
    firstColumn.x + 2,
    firstColumn.y + firstColumn.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator(".property-drag-preview")).toHaveCount(0);
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(before);
  await expect(page.locator(".property-select[aria-pressed=true]")).toHaveText(
    selected,
    { useInnerText: true },
  );
  await rows.first().locator(".property-select").press("Alt+ArrowRight");
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(expected);
  const cancelTarget = (await rows.nth(2).boundingBox())!;
  await rows.first().locator(".property-select").hover();
  await page.mouse.down();
  await page.mouse.move(
    cancelTarget.x + cancelTarget.width - 2,
    cancelTarget.y + cancelTarget.height / 2,
    { steps: 8 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".property-drag-preview")).toHaveCount(0);
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-column-item")),
    ),
  ).toEqual(expected);
  await page.locator('[data-column-item="status"] .property-select').click();
  await expect(
    page.locator('[data-column-item="status"] .property-select'),
  ).toHaveAttribute("aria-pressed", "true");
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
    page.getByText("속성이 저장되었습니다.", { exact: true }),
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
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
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
      .locator('.format-toolbar[aria-label="셀 서식 도구"]')
      .getByRole("button", { name: "업무 추가", exact: true })
      .click();
    const id = (await (await created).json().then(unpack)).task.id;
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

test("필터 보기 띠에서 이름 변경·삭제·복원과 X 종료를 처리한다", async ({
  page,
}, info) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-planned" },
    { index: 1, key: "status", value: "status-completed" },
    { index: 2, key: "status", value: "status-progress" },
  ]);
  expect(
    (
      await writePreferences(page, {
        headers: { "X-Requested-With": "WeeklyPlan" },
        data: {
          teamId,
          name: "완료 제외",
          data: {
            year: 2026,
            propertyFilters: { status: ["status-completed"] },
            propertyFilterModes: { status: "exclude" },
          },
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const titles = page.locator('[data-column="title"]');
  const persistedFilters = async () =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === "__current",
    )?.data.propertyFilters;
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "완료 제외", exact: true })
    .click();
  await expect(banner).not.toContainText("저장된 필터 보기");
  await expect(banner.locator("strong")).toHaveText("완료 제외");
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  const toolbarBox = (await page.locator(".format-toolbar").boundingBox())!;
  const bannerBox = (await banner.boundingBox())!;
  const headerBox = (await page
    .locator('[data-header-key="title"]')
    .boundingBox())!;
  expect(bannerBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(headerBox.y);

  await banner.getByRole("button", { name: "필터 이름 변경" }).click();
  const input = page.getByRole("dialog").getByLabel("필터 이름");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("완료 제외");
  const renamed = "진행 중인 업무와 이번 주 검토가 필요한 업무";
  await page.keyboard.insertText(renamed);
  await input.press("Enter");
  await expect(banner.locator("strong")).toHaveText(renamed);
  await expect.poll(persistedFilters).toEqual({ status: ["status-completed"] });
  await page.reload();
  await expect(banner.locator("strong")).toHaveText(renamed);
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  await page.screenshot({ path: info.outputPath("saved-filter-banner.png") });

  await page.setViewportSize({ width: 640, height: 900 });
  const compactBox = (await banner.boundingBox())!;
  expect(compactBox.x + compactBox.width).toBeLessThanOrEqual(640);
  await expect(
    banner.getByRole("button", { name: "필터 이름 변경" }),
  ).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "필터 보기 종료" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("saved-filter-banner-compact.png"),
  });
  await page.setViewportSize({ width: 1366, height: 900 });

  await banner.getByRole("button", { name: "저장된 필터 삭제" }).click();
  await expect(banner).toHaveCount(0);
  await expect(
    banner.getByRole("button", { name: "필터 이름 변경" }),
  ).toHaveCount(0);
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행취소" })
    .click();
  await expect(page.locator(".toast")).toContainText("필터를 되살렸습니다.");
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: renamed, exact: true })
    .click();
  await expect(banner.locator("strong")).toHaveText(renamed);

  const exit = banner.getByRole("button", { name: "필터 보기 종료" });
  await exit.focus();
  await exit.press("Enter");
  await expect(banner).toHaveCount(0);
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  await expect(trigger).toBeFocused();
  await expect.poll(persistedFilters).toEqual({});
  await page.reload();
  await expect(banner).toHaveCount(0);
  await trigger.click();
  await expect(
    page
      .locator(".saved-views")
      .getByRole("button", { name: renamed, exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("저장된 필터의 이름은 선택된 입력창에서 수정하고 조건·적용 상태를 유지한다", async ({
  page,
}, info) => {
  const headers = { "X-Requested-With": "WeeklyPlan" };
  const saved = [
    {
      name: "완료 제외",
      data: {
        year: 2026,
        propertyFilters: { status: ["status-completed"] },
        propertyFilterModes: { status: "exclude" },
      },
    },
    {
      name: "대기 업무",
      data: {
        year: 2026,
        propertyFilters: { status: ["status-planned"] },
        propertyFilterModes: {},
      },
    },
  ];
  for (const filter of saved)
    expect(
      (
        await writePreferences(page, {
          headers,
          data: { teamId, ...filter },
        })
      ).ok(),
    ).toBeTruthy();
  const views = async () => (await readPreferences(page, teamId)).views;

  const original = (await views()).find((v: any) => v.name === "완료 제외");
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  await trigger.click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "완료 제외", exact: true })
    .click();
  await expect(banner.locator("strong")).toHaveText("완료 제외");
  await expect
    .poll(
      async () =>
        (await views()).find((v: any) => v.name === "__current")?.data
          .propertyFilterModes,
    )
    .toEqual({ status: "exclude" });
  const current = (await views()).find((v: any) => v.name === "__current").data;
  const dialog = page.getByRole("dialog", { name: "필터 이름 변경" });
  const input = dialog.getByLabel("필터 이름");
  await banner.getByRole("button", { name: "필터 이름 변경" }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("완료 제외");
  expect(
    await input.evaluate((el: HTMLInputElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([0, "완료 제외".length]);
  await page.keyboard.insertText("진행 업무 보기");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(banner.locator("strong")).toHaveText("진행 업무 보기");
  const renamed = (await views()).find((v: any) => v.id === original.id);
  expect(renamed.name).toBe("진행 업무 보기");
  expect(renamed.data).toEqual(original.data);
  expect((await views()).find((v: any) => v.name === "__current").data).toEqual(
    current,
  );
  await banner.getByRole("button", { name: "필터 이름 변경" }).click();
  await page.keyboard.insertText("대기 업무");
  await input.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText(
    "같은 구분에 같은 이름의 필터가 이미 있습니다.",
  );
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(banner.locator("strong")).toHaveText("진행 업무 보기");
  await expect(trigger).toHaveText("저장된 필터");
  await trigger.click();
  const menu = page.locator(".saved-views");
  await expect(
    menu.getByRole("button", { name: "진행 업무 보기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    menu.getByRole("button", { name: /이름 변경|삭제/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("saved-filter-rename.png") });
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
  await expect(page.getByLabel("필터 이름")).toBeFocused();
  await page.keyboard.insertText("완료 제외 보기");
  await expect(page.getByLabel("필터 이름")).toHaveValue("완료 제외 보기");
  await page
    .getByRole("dialog", { name: "필터 저장" })
    .getByRole("button", { name: "저장", exact: true })
    .click();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const applied = banner.locator("strong");
  await expect(banner).toHaveCount(0);
  const views = async () => (await readPreferences(page, teamId)).views;
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
      await writePreferences(page, {
        headers,
        data: { teamId, name: "__current", data: layout },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await writePreferences(page, {
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
    await expect(applied).toHaveText(name);
    await page
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await expect(
      page.locator(".saved-views").getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "완료 제외 보기", exact: true })
    .click();
  await expect(applied).toHaveText("완료 제외 보기");
  await page
    .getByRole("region", { name: "필터 보기", exact: true })
    .getByRole("button", { name: "필터 보기 종료", exact: true })
    .click();
  await expect(banner).toHaveCount(0);
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
  await expect(banner).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "필터 해제", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(
    page.locator('.saved-filter-choice[aria-pressed="true"]'),
  ).toHaveCount(0);
  await expect(page.locator(".saved-filter-choice")).toHaveCount(2);
});

test("저장된 필터를 직접 선택할 때만 보기 띠가 나타나고 상단 버튼은 유지된다", async ({
  page,
}, info) => {
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  const control = page.locator(".saved-filter-control");
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const appearance = () =>
    control.evaluate((el) => {
      const rect = el.getBoundingClientRect(),
        style = getComputedStyle(el);
      return {
        width: rect.width,
        height: rect.height,
        background: style.backgroundColor,
        border: style.borderColor,
      };
    });
  const initialAppearance = await appearance();
  await expect(banner).toHaveCount(0);
  await expect(trigger).toHaveText("저장된 필터");
  for (const name of ["검토 대상", "동일 조건 다른 이름"]) {
    expect(
      (
        await writePreferences(page, {
          headers: { "X-Requested-With": "WeeklyPlan" },
          data: {
            teamId,
            name,
            data: {
              year: 2026,
              propertyFilters: {
                status: ["status-completed", "status-progress"],
              },
              propertyFilterModes: {},
            },
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  const filter = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  const completed = filter.getByRole("checkbox", { name: "완료", exact: true });
  await completed.check();
  await filter.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await expect(banner).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () =>
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "__current",
        )?.data.propertyFilters.status?.length,
    )
    .toBe(2);
  await page.reload();
  await expect(banner).toHaveCount(0);
  await expect(trigger).toHaveText("저장된 필터");
  expect(await appearance()).toEqual(initialAppearance);
  const menu = page.locator(".saved-views");
  const choose = async (name: string) => {
    await trigger.click();
    await menu.getByRole("button", { name, exact: true }).click();
    await expect(banner.locator("strong")).toHaveText(name);
    await expect(trigger).toHaveText("저장된 필터");
    expect(await appearance()).toEqual(initialAppearance);
  };
  await choose("검토 대상");
  await choose("동일 조건 다른 이름");
  await page.reload();
  await expect(banner.locator("strong")).toHaveText("동일 조건 다른 이름");
  await trigger.click();
  await expect(menu.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(
    menu.getByRole("button", { name: "동일 조건 다른 이름", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    menu.getByRole("button", { name: /이름 변경|삭제/ }),
  ).toHaveCount(0);
  await menu.getByRole("button", { name: "검토 대상", exact: true }).hover();
  await page.screenshot({ path: info.outputPath("active-saved-filter.png") });
  await page.keyboard.press("Escape");
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  await completed.uncheck();
  await expect(banner.locator("strong")).toHaveText("동일 조건 다른 이름");
  const saved = async (name: string) =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === name,
    );
  await expect
    .poll(
      async () =>
        (await saved("동일 조건 다른 이름")).data.propertyFilters.status,
    )
    .toEqual(["status-progress"]);
  // 조건과 일치·제외 모드는 선택한 항목만 갱신한다.
  await completed.check();
  await filter.getByRole("radio", { name: "제외", exact: true }).check();
  await completed.uncheck();
  const updatedData = {
    propertyFilters: { status: ["status-progress"] },
    propertyFilterModes: { status: "exclude" },
  };
  await expect(banner.locator("strong")).toHaveText("동일 조건 다른 이름");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await saved("동일 조건 다른 이름")).data)
    .toEqual(updatedData);
  await expect
    .poll(
      async () => (await saved("__current")).data.propertyFilterModes.status,
    )
    .toBe("exclude");
  await page.reload();
  await expect(banner.locator("strong")).toHaveText("동일 조건 다른 이름");
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  await expect(completed).not.toBeChecked();
  await expect(
    filter.getByRole("radio", { name: "제외", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await choose("검토 대상");
  const exit = banner.getByRole("button", { name: "필터 보기 종료" });
  await exit.focus();
  await exit.press("Enter");
  await expect(banner).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("저장된 필터");
  expect(await appearance()).toEqual(initialAppearance);
  await expect(control.getByRole("button")).toHaveCount(1);
  expect((await saved("동일 조건 다른 이름")).data).toEqual(updatedData);
  expect((await saved("검토 대상")).data.propertyFilters.status).toEqual([
    "status-completed",
    "status-progress",
  ]);
});

test("저장된 필터 표시줄은 숨긴 열도 속성 순서대로 표시하고 조건을 바로 수정한다", async ({
  page,
}, info) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const settings = boot.teams.find((t: any) => t.id === teamId).settings;
  const first = ["owner", "status", "title"];
  settings.properties = [
    ...first.map((id) => settings.properties.find((p: any) => p.id === id)),
    ...settings.properties.filter((p: any) => !first.includes(p.id)),
  ].map((p: any) =>
    p.id === "owner" ? { ...p, placement: "afterWeeks", visible: false } : p,
  );
  const updated = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: settings,
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-completed" },
    { index: 1, key: "status", value: "status-progress" },
    { index: 2, key: "status", value: "status-planned" },
  ]);
  const name = "바로 변경할 조건";
  const savedResponse = await writePreferences(page, {
    data: {
      teamId,
      name,
      data: {
        // Deliberately differ from property order, including a hidden member column.
        propertyFilters: {
          owner: [boot.user.id],
          title: ["첫 업무", "숨길 업무", "셋째 업무"],
          status: ["status-completed", ""],
        },
        propertyFilterModes: { status: "exclude" },
      },
    },
  });
  expect(savedResponse.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name, exact: true })
    .click();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const conditions = banner.getByRole("group", {
    name: "적용된 필터 조건",
    exact: true,
  });
  const scope = banner.locator(".active-filter-heading .filter-scope-tag");
  await expect(scope).toHaveText("개인용");
  const titleBox = (await banner.locator("strong").boundingBox())!;
  const scopeBox = (await scope.boundingBox())!;
  expect(scopeBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
  expect(scopeBox.x - titleBox.x - titleBox.width).toBeLessThan(12);
  await expect(conditions.locator(".active-filter-condition-name")).toHaveText([
    "상태:",
    "작업:",
    "팀원:",
  ]);
  await expect(conditions.getByRole("button")).toHaveCount(3);
  await expect(conditions.getByRole("button").first()).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  );
  await expect(conditions.getByRole("button").nth(0)).toHaveAccessibleName(
    "상태 필터 변경: 완료, 미지정 제외",
  );
  await expect(conditions.getByRole("button").nth(2)).toHaveAccessibleName(
    `팀원 필터 변경: ${boot.user.name}`,
  );
  await expect(page.locator('[data-header-key="owner"]')).toHaveCount(0);
  const titles = page.locator('[data-column="title"]');
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무"]);
  const statusButton = conditions.getByRole("button", {
    name: /^상태 필터 변경:/,
  });
  await statusButton.focus();
  await statusButton.press("Enter");
  const status = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await expect(status.getByRole("searchbox")).toBeFocused();
  await expect(
    status.getByRole("checkbox", { name: "미지정", exact: true }),
  ).toBeChecked();
  await status.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await expect(titles).toHaveText(["셋째 업무"]);
  await status.getByRole("radio", { name: "일치", exact: true }).check();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await status
    .getByRole("button", { name: "상태 필터 해제", exact: true })
    .click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect(status).toBeVisible();
  await status.getByRole("checkbox", { name: "예정", exact: true }).check();
  await expect(titles).toHaveText(["셋째 업무"]);
  await page.keyboard.press("Escape");
  await expect(statusButton).toBeFocused();
  await expect(statusButton).toHaveAccessibleName("상태 필터 변경: 예정");
  // The same trigger toggles its popover, and another condition opens directly.
  await statusButton.click();
  await statusButton.click();
  await expect(status).toHaveCount(0);
  await conditions.getByRole("button", { name: /^작업 필터 변경:/ }).click();
  const titleFilter = page.getByRole("group", {
    name: "작업 필터 선택",
    exact: true,
  });
  await titleFilter
    .getByRole("checkbox", { name: "첫 업무", exact: true })
    .uncheck();
  await conditions.getByRole("button", { name: /^팀원 필터 변경:/ }).click();
  const owner = page.getByRole("group", {
    name: "팀원 필터 선택",
    exact: true,
  });
  await expect(titleFilter).toHaveCount(0);
  await owner.getByRole("checkbox", { name: "미지정", exact: true }).check();
  await expect(conditions.getByRole("button").nth(2)).toHaveAccessibleName(
    `팀원 필터 변경: ${boot.user.name}, 미지정`,
  );
  await expect(page.locator(".toast")).toHaveText(
    "필터 변경사항이 업데이트되었습니다.",
  );
  await expect(page.locator(".toast")).toBeInViewport();
  await expect(page.locator(".toast")).toHaveCSS("position", "fixed");
  await page.screenshot({
    path: info.outputPath("saved-filter-conditions.png"),
  });
  await page.keyboard.press("Escape");
  const saved = async () =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === name,
    );
  await expect
    .poll(async () => (await saved()).data)
    .toEqual({
      propertyFilters: {
        owner: [boot.user.id, ""],
        title: ["숨길 업무", "셋째 업무"],
        status: ["status-planned"],
      },
      propertyFilterModes: { status: "include" },
    });
  await page.reload();
  await expect(banner.locator("strong")).toHaveText(name);
  await expect(statusButton).toHaveAccessibleName("상태 필터 변경: 예정");
  await expect(titles).toHaveText(["셋째 업무"]);
  await page.setViewportSize({ width: 650, height: 900 });
  for (const button of await conditions.getByRole("button").all()) {
    await expect(button).toBeInViewport();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(650);
  }
  await conditions.getByRole("button", { name: /^팀원 필터 변경:/ }).click();
  await expect(owner).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("saved-filter-conditions-narrow.png"),
  });
  await page.keyboard.press("Escape");
  for (const propertyName of ["상태", "작업", "팀원"]) {
    await conditions
      .getByRole("button", { name: new RegExp(`^${propertyName} 필터 변경:`) })
      .click();
    await page
      .getByRole("group", { name: `${propertyName} 필터 선택`, exact: true })
      .getByRole("button", { name: `${propertyName} 필터 해제`, exact: true })
      .click();
    await page.keyboard.press("Escape");
  }
  await expect(page.locator(".toast")).toHaveText(
    "해제한 필터는 저장된 필터에서 제외됩니다.",
  );
  await expect(conditions.locator(".active-filter-condition-name")).toHaveText([
    "상태:",
    "작업:",
    "팀원:",
  ]);
  await expect(conditions.locator(".active-filter-condition-value")).toHaveText(
    ["전체 표시", "전체 표시", "전체 표시"],
  );
  await expect
    .poll(async () => (await saved()).data.propertyFilters)
    .toEqual({
      owner: [],
      title: [],
      status: [],
    });
  await banner
    .getByRole("button", { name: "필터 보기 종료", exact: true })
    .click();
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(conditions.getByRole("button")).toHaveCount(0);
  await expect(conditions.locator(".active-filter-empty")).toHaveText(
    "전체 표시",
  );
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
});

test("필터 해제 항목은 닫기 전까지 다시 수정하고 재진입하면 제외한다", async ({
  page,
}, info) => {
  const response = await writePreferences(page, {
    data: {
      teamId,
      name: "해제할 조건",
      data: { propertyFilters: { title: ["첫 업무"] } },
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "해제할 조건", exact: true })
    .click();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const conditions = banner.getByRole("group", {
    name: "적용된 필터 조건",
    exact: true,
  });
  await conditions
    .getByRole("button", { name: "작업 필터 변경: 첫 업무", exact: true })
    .click();
  const filter = page.getByRole("group", {
    name: "작업 필터 선택",
    exact: true,
  });
  await filter
    .getByRole("button", { name: "작업 필터 해제", exact: true })
    .click();
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "첫 업무",
    "숨길 업무",
    "셋째 업무",
  ]);
  await page.keyboard.press("Escape");
  const cleared = conditions.getByRole("button", {
    name: "작업 필터 변경: 전체 표시",
    exact: true,
  });
  await expect(cleared).toBeFocused();
  await expect(conditions.getByRole("button")).toHaveCount(1);
  await expect(banner.locator("strong")).toHaveText("해제할 조건");
  await expect(page.locator(".toast")).toHaveText(
    "해제한 필터는 저장된 필터에서 제외됩니다.",
  );
  await expect
    .poll(
      async () =>
        (await readPreferences(page, teamId)).views.find(
          (v: any) => v.name === "해제할 조건",
        ).data.propertyFilters.title,
    )
    .toEqual([]);
  await page.screenshot({
    path: info.outputPath("cleared-filter-condition.png"),
  });
  await cleared.click();
  await expect(
    filter.getByRole("checkbox", { name: "첫 업무", exact: true }),
  ).not.toBeChecked();
  await filter
    .getByRole("checkbox", { name: "숨길 업무", exact: true })
    .check();
  await page.keyboard.press("Escape");
  await expect(
    conditions.getByRole("button", {
      name: "작업 필터 변경: 숨길 업무",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-column="title"]')).toHaveText(["숨길 업무"]);
  await expect(page.locator(".toast")).toHaveText(
    "필터 변경사항이 업데이트되었습니다.",
  );
  // Clearing from the column menu keeps the same banner control as well.
  await page.locator('[data-header-key="title"]').click({ button: "right" });
  await filter
    .getByRole("button", { name: "작업 필터 해제", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(cleared).toBeVisible();
  await expect(page.locator(".toast")).toHaveText(
    "해제한 필터는 저장된 필터에서 제외됩니다.",
  );
  await page.setViewportSize({ width: 650, height: 900 });
  await expect(cleared).toBeInViewport();
  await expect(banner.getByRole("status")).toBeInViewport();
  const clearedBox = (await cleared.boundingBox())!;
  const narrowNoticeBox = (await banner.getByRole("status").boundingBox())!;
  expect(
    narrowNoticeBox.x - clearedBox.x - clearedBox.width,
  ).toBeGreaterThanOrEqual(0);
  expect(narrowNoticeBox.x - clearedBox.x - clearedBox.width).toBeLessThan(16);
  expect(
    Math.abs(
      narrowNoticeBox.y +
        narrowNoticeBox.height / 2 -
        clearedBox.y -
        clearedBox.height / 2,
    ),
  ).toBeLessThan(2);
  await page.screenshot({
    path: info.outputPath("cleared-filter-condition-narrow.png"),
  });
  // The visible "전체 표시" text remains an editor trigger until closing.
  await cleared.getByText("전체 표시", { exact: true }).click();
  await expect(filter).toBeVisible();
  await expect(
    filter.getByRole("checkbox", { name: "첫 업무", exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(cleared).toBeFocused();
  for (const reopen of [
    async () => {
      await banner
        .getByRole("button", { name: "필터 보기 종료", exact: true })
        .click();
      await page
        .getByRole("button", { name: "저장된 필터", exact: true })
        .click();
      await page
        .locator(".saved-views")
        .getByRole("button", { name: "해제할 조건", exact: true })
        .click();
    },
    () => page.reload(),
    async () => {
      await chooseYear(page, 2027);
      await chooseYear(page, 2026);
    },
  ]) {
    await reopen();
    await expect(banner.locator("strong")).toHaveText("해제할 조건");
    await expect(conditions.getByRole("button")).toHaveCount(0);
    await expect(conditions.locator(".active-filter-empty")).toHaveText(
      "전체 표시",
    );
    await expect(banner.getByRole("status")).toBeEmpty();
    await expect(page.locator('[data-column="title"]')).toHaveText([
      "첫 업무",
      "숨길 업무",
      "셋째 업무",
    ]);
  }
  // A newly applied condition appears again and remains saved after reload.
  await page.locator('[data-header-key="title"]').click({ button: "right" });
  await filter.getByRole("checkbox", { name: "첫 업무", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-column="title"]')).toHaveText(["첫 업무"]);
  await expect(page.locator(".toast")).toHaveText(
    "필터 변경사항이 업데이트되었습니다.",
  );
  await page.reload();
  await expect(
    conditions.getByRole("button", {
      name: "작업 필터 변경: 첫 업무",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-column="title"]')).toHaveText(["첫 업무"]);
});

test("저장된 필터는 연도 이동·새로고침에도 적용하고 수정·삭제·복원을 모든 연도에서 공유한다", async ({
  page,
}) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-completed" },
    { index: 1, key: "status", value: "status-planned" },
    { index: 2, key: "status", value: "status-progress" },
  ]);
  for (const [title, status] of [
    ["내년 완료", "status-completed"],
    ["내년 진행", "status-progress"],
  ])
    await post(page, "/tasks", {
      teamId,
      year: 2027,
      fields: { title, status, category: "category-ux" },
    });
  const otherTeam = (await post(page, "/admin/teams", { name: "별도 필터 팀" }))
    .id;
  const saveView = (name: string, data: object, targetTeam = teamId) =>
    writePreferences(page, {
      headers: { "X-Requested-With": "WeeklyPlan" },
      data: { teamId: targetTeam, name, data },
    });
  expect(
    (
      await saveView("__current", {
        ...defaultView(2027),
        visibleFields: ["title", "status"],
        widths: { title: 340 },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await saveView("전체 연도", {
        propertyFilters: {
          status: ["status-completed"],
          category: ["category-ux"],
        },
        propertyFilterModes: { status: "exclude" },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await saveView(
        "별도 팀 조건",
        { propertyFilters: { status: ["status-completed"] } },
        otherTeam,
      )
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  const titles = page.locator('[data-column="title"]');
  const choose = async (name: string) => {
    await trigger.click();
    await page
      .locator(".saved-views")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(banner.locator("strong")).toHaveText(name);
  };
  await choose("전체 연도");
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무"]);
  const filterReads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/filters"
    )
      filterReads.push(request.url());
  });
  await chooseYear(page, 2027);
  await expect(banner.locator("strong")).toHaveText("전체 연도");
  await expect(titles).toHaveText(["내년 진행"]);
  expect(filterReads).toEqual([]);
  await expect(page.locator('[data-header-key="title"]')).toHaveCSS(
    "width",
    "340px",
  );
  await page.getByLabel("팀 선택").selectOption(otherTeam);
  await expect(banner).toHaveCount(0);
  await trigger.click();
  await expect(
    page.locator(".saved-filter-choice .saved-filter-name"),
  ).toHaveText(["별도 팀 조건"]);
  await page.locator(".saved-filter-choice").click();
  await expect(banner.locator("strong")).toHaveText("별도 팀 조건");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(banner.locator("strong")).toHaveText("전체 연도");
  await page.getByLabel("팀 선택").selectOption(otherTeam);
  await expect(banner.locator("strong")).toHaveText("별도 팀 조건");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(banner.locator("strong")).toHaveText("전체 연도");
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  const filter = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await filter.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await filter.getByRole("checkbox", { name: "완료", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(titles).toHaveText(["내년 완료"]);
  await chooseYear(page, 2026);
  await expect(banner.locator("strong")).toHaveText("전체 연도");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await chooseYear(page, 2027);
  await page.reload();
  await expect(banner.locator("strong")).toHaveText("전체 연도");
  await expect(titles).toHaveText(["내년 완료"]);
  await expect(page.locator('[data-header-key="title"]')).toHaveCSS(
    "width",
    "340px",
  );
  await banner.getByRole("button", { name: "필터 이름 변경" }).click();
  const nameInput = page.getByRole("textbox", {
    name: "필터 이름",
    exact: true,
  });
  await nameInput.fill("공통 조건");
  await nameInput.press("Enter");
  await expect(banner.locator("strong")).toHaveText("공통 조건");
  await banner.getByRole("button", { name: "저장된 필터 삭제" }).click();
  await expect(banner).toHaveCount(0);
  await chooseYear(page, 2026);
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행취소" })
    .click();
  await expect(page.locator(".toast")).toContainText("필터를 되살렸습니다.");
  await choose("공통 조건");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  await chooseYear(page, 2027);
  await expect(banner.locator("strong")).toHaveText("공통 조건");
  await expect(titles).toHaveText(["내년 완료"]);
  await banner.getByRole("button", { name: "필터 보기 종료" }).click();
  await expect(banner).toHaveCount(0);
  await expect(titles).toHaveText(["내년 완료", "내년 진행"]);
});

test("저장 필터 수정 중 연도를 바꿔도 저장 완료된 최신 조건을 적용한다", async ({
  page,
}) => {
  for (const [title, status] of [
    ["내년 완료", "status-completed"],
    ["내년 진행", "status-progress"],
  ])
    await post(page, "/tasks", {
      teamId,
      year: 2027,
      fields: { title, status },
    });
  expect(
    (
      await writePreferences(page, {
        headers: { "X-Requested-With": "WeeklyPlan" },
        data: { teamId, name: "저장 중 연도 이동", data: {} },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "저장 중 연도 이동", exact: true })
    .click();
  const views = (await readPreferences(page, teamId)).views;
  const saved = views.find((v: any) => v.name === "저장 중 연도 이동");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  await page.route(`**/api/filters/${saved.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writing = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    await page
      .getByRole("group", { name: "상태 필터 선택", exact: true })
      .getByRole("checkbox", { name: "완료", exact: true })
      .check();
    await expect.poll(() => writing).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "다음 연도", exact: true }).click();
    await expect(page.locator(".year-value")).toHaveText("2027");
    release();
    await expect(
      page
        .getByRole("region", { name: "필터 보기", exact: true })
        .locator("strong"),
    ).toHaveText("저장 중 연도 이동");
    await expect(page.locator('[data-column="title"]')).toHaveText([
      "내년 완료",
    ]);
    await page.reload();
    await expect(page.locator('[data-column="title"]')).toHaveText([
      "내년 완료",
    ]);
  } finally {
    release();
  }
});

test("저장된 필터를 연속 수정한 직후 다른 필터를 선택해도 수정한 항목에만 순서대로 저장한다", async ({
  page,
}) => {
  for (const [name, status] of [
    ["수정할 필터", "status-completed"],
    ["전환할 필터", "status-planned"],
  ]) {
    expect(
      (
        await writePreferences(page, {
          headers: { "X-Requested-With": "WeeklyPlan" },
          data: {
            teamId,
            name,
            data: { year: 2026, propertyFilters: { status: [status] } },
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  const saved = async (name: string) =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === name,
    );
  const original = await saved("수정할 필터");
  const other = await saved("전환할 필터");
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const choose = async (name: string) => {
    await page
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await page
      .locator(".saved-views")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(banner.locator("strong")).toHaveText(name);
  };
  await choose(original.name);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: any[] = [];
  await page.route(`**/api/filters/${original.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) await gate;
    }
    await route.continue();
  });
  try {
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    const filter = page.getByRole("group", {
      name: "상태 필터 선택",
      exact: true,
    });
    await filter
      .getByRole("checkbox", { name: "진행 중", exact: true })
      .check();
    await expect.poll(() => writes.length).toBe(1);
    await expect(banner.getByRole("status")).toHaveText(
      "필터 변경사항 저장 중…",
    );
    await filter.getByRole("radio", { name: "제외", exact: true }).check();
    await page.keyboard.press("Escape");
    await choose(other.name);
    expect(writes).toHaveLength(1);
    release();
    await expect
      .poll(async () => (await saved(original.name)).data)
      .toEqual({
        propertyFilters: { status: ["status-completed", "status-progress"] },
        propertyFilterModes: { status: "exclude" },
      });
    expect(await saved(other.name)).toEqual(other);
    await expect(banner.locator("strong")).toHaveText(other.name);
    await expect(banner.getByRole("status")).toBeEmpty();
    await choose(original.name);
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    await filter
      .getByRole("button", { name: "상태 필터 해제", exact: true })
      .click();
    await expect(banner.locator("strong")).toHaveText(original.name);
    await expect(page.locator(".toast")).toHaveText(
      "해제한 필터는 저장된 필터에서 제외됩니다.",
    );
    await expect
      .poll(
        async () => (await saved(original.name)).data.propertyFilters.status,
      )
      .toEqual([]);
    await page.keyboard.press("Escape");
    await banner.getByRole("button", { name: "필터 보기 종료" }).click();
    await expect(banner).toHaveCount(0);
    expect(writes).toHaveLength(3);
  } finally {
    release();
  }
});

test("저장된 필터 조건 저장 실패를 알리고 선택 상태에서 다시 변경할 수 있다", async ({
  page,
}) => {
  expect(
    (
      await writePreferences(page, {
        headers: { "X-Requested-With": "WeeklyPlan" },
        data: { teamId, name: "다시 수정할 필터", data: { year: 2026 } },
      })
    ).ok(),
  ).toBeTruthy();
  const saved = async () =>
    (await readPreferences(page, teamId)).views.find(
      (v: any) => v.name === "다시 수정할 필터",
    );
  const original = await saved();
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: original.name, exact: true })
    .click();
  await page.route(
    `**/api/filters/${original.id}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "일시 저장 실패" }),
      }),
    { times: 1 },
  );
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  const filter = page.getByRole("group", {
    name: "상태 필터 선택",
    exact: true,
  });
  await filter.getByRole("checkbox", { name: "완료", exact: true }).check();
  await expect(page.getByRole("alert")).toContainText("필터 저장 실패");
  const notice = page
    .getByRole("region", { name: "필터 보기", exact: true })
    .getByRole("status");
  await expect(notice).toHaveText("필터 변경사항을 저장하지 못했습니다.");
  await expect(page.locator(".active-filter-banner strong")).toHaveText(
    original.name,
  );
  expect((await saved()).data.propertyFilters).toEqual({});
  await filter.getByRole("checkbox", { name: "진행 중", exact: true }).check();
  await expect
    .poll(async () => (await saved()).data.propertyFilters.status)
    .toEqual(["status-completed", "status-progress"]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(notice).toHaveText("");
  await expect(page.locator(".toast")).toHaveText(
    "필터 변경사항이 업데이트되었습니다.",
  );
  await expect(page.locator(".active-filter-banner strong")).toHaveText(
    original.name,
  );
  await filter
    .getByRole("button", { name: "상태 필터 해제", exact: true })
    .click();
  await filter.getByRole("radio", { name: "제외", exact: true }).check();
  await expect
    .poll(async () => (await saved()).data)
    .toEqual({
      propertyFilters: { status: [] },
      propertyFilterModes: { status: "exclude" },
    });
});
test("팀장은 필터 공개 범위를 선택하고 팀원은 공용 원본 수정 없이 개인 필터를 사용한다", async ({
  page,
  browser,
}) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-completed" },
    { index: 1, key: "status", value: "status-planned" },
    { index: 2, key: "status", value: "status-progress" },
  ]);
  const trigger = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  await page.locator('[data-header-key="status"]').click({ button: "right" });
  await page
    .getByRole("group", { name: "상태 필터 선택", exact: true })
    .getByRole("checkbox", { name: "완료", exact: true })
    .check();
  await page.keyboard.press("Escape");
  const save = async (name: string, scope: "개인용" | "팀 공용") => {
    await trigger.click();
    await page
      .getByRole("button", { name: "현재 필터 저장", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "필터 저장", exact: true });
    const input = dialog.getByRole("textbox", {
      name: "필터 이름",
      exact: true,
    });
    await expect(input).toBeFocused();
    await expect(
      dialog.getByRole("radio", { name: "개인용", exact: true }),
    ).toBeChecked();
    await dialog.getByRole("radio", { name: scope, exact: true }).check();
    await input.fill(name);
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
  };
  await save("팀장 개인 조건", "개인용");
  await save("팀 완료 조건", "팀 공용");
  await trigger.click();
  const sharedChoice = page.getByRole("button", {
    name: "팀 완료 조건",
    exact: true,
  });
  await expect(sharedChoice.locator(".filter-scope-tag")).toHaveText("팀 공용");
  await expect(
    page
      .getByRole("button", { name: "팀장 개인 조건", exact: true })
      .locator(".filter-scope-tag"),
  ).toHaveText("개인용");
  await sharedChoice.click();
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  await expect(
    banner.getByRole("button", { name: "필터 이름 변경" }),
  ).toBeVisible();
  const username = `filter-member-${randomUUID()}@example.com`;
  const password = "filter-browser-member-password";
  await post(page, "/admin/users", {
    username,
    password,
    name: "필터 팀원",
    memberships: [{ teamId, role: "member" }],
  });
  const peer = await browser.newPage({
    baseURL: "http://127.0.0.1:4311",
    viewport: { width: 1366, height: 900 },
  });
  try {
    await post(peer, "/auth/login", { username, password });
    await peer.goto("/");
    const peerTrigger = peer.getByRole("button", {
      name: "저장된 필터",
      exact: true,
    });
    await peerTrigger.click();
    await expect(
      peer.getByRole("button", { name: "팀장 개인 조건", exact: true }),
    ).toHaveCount(0);
    await peer
      .getByRole("button", { name: "팀 완료 조건", exact: true })
      .click();
    const peerBanner = peer.getByRole("region", {
      name: "필터 보기",
      exact: true,
    });
    await expect(
      peerBanner.locator(".active-filter-heading .filter-scope-tag"),
    ).toHaveText("팀 공용 · 읽기 전용");
    await expect(
      peerBanner.getByRole("button", { name: "필터 이름 변경" }),
    ).toHaveCount(0);
    await expect(
      peerBanner.getByRole("button", { name: "저장된 필터 삭제" }),
    ).toHaveCount(0);
    await expect(peer.locator('[data-column="title"]')).toHaveText(["첫 업무"]);
    await banner.getByRole("button", { name: "필터 이름 변경" }).click();
    const nameInput = page.getByRole("textbox", {
      name: "필터 이름",
      exact: true,
    });
    await nameInput.fill("팀 진행 조건");
    await nameInput.press("Enter");
    await expect(banner.locator("strong")).toHaveText("팀 진행 조건");
    await page.locator('[data-header-key="status"]').click({ button: "right" });
    const status = page.getByRole("group", {
      name: "상태 필터 선택",
      exact: true,
    });
    await status
      .getByRole("checkbox", { name: "진행 중", exact: true })
      .check();
    await status.getByRole("checkbox", { name: "완료", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    const readShared = async () =>
      (
        await (
          await peer.request.get(`/api/filters?teamId=${teamId}`)
        )
          .json()
          .then(unpack)
      ).filters.find((v: any) => v.scope === "team");
    await expect
      .poll(async () => (await readShared()).data.propertyFilters.status)
      .toEqual(["status-progress"]);
    await peerTrigger.click();
    await expect(peerBanner.locator("strong")).toHaveText("팀 진행 조건");
    await expect(peer.locator('[data-column="title"]')).toHaveText([
      "셋째 업무",
    ]);
    await peer.keyboard.press("Escape");
    await peer.reload();
    await expect(peerBanner.locator("strong")).toHaveText("팀 진행 조건");
    await expect(peer.locator('[data-column="title"]')).toHaveText([
      "셋째 업무",
    ]);
    await peerBanner
      .getByRole("button", { name: "상태 필터 변경: 진행 중", exact: true })
      .click();
    const peerProgress = peer
      .getByRole("group", { name: "상태 필터 선택", exact: true })
      .getByRole("checkbox", { name: "진행 중", exact: true });
    await expect(peerProgress).toBeChecked();
    // Editing a shared filter detaches it and unmounts the banner's editor.
    await peerProgress.click();
    await peer.keyboard.press("Escape");
    await expect(peerBanner).toHaveCount(0);
    await expect(peer.locator('[data-column="title"]')).toHaveText([
      "첫 업무",
      "숨길 업무",
      "셋째 업무",
    ]);
    expect((await readShared()).data.propertyFilters.status).toEqual([
      "status-progress",
    ]);
    await peerTrigger.click();
    await peer
      .getByRole("button", { name: "현재 필터 저장", exact: true })
      .click();
    const dialog = peer.getByRole("dialog", { name: "필터 저장", exact: true });
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await dialog
      .getByRole("textbox", { name: "필터 이름", exact: true })
      .fill("팀원 개인 조건");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await peerTrigger.click();
    await expect(
      peer
        .getByRole("button", { name: "팀원 개인 조건", exact: true })
        .locator(".filter-scope-tag"),
    ).toHaveText("개인용");
    await page.screenshot({
      path: test.info().outputPath("team-filter-banner.png"),
    });
    await peer.screenshot({
      path: test.info().outputPath("filter-scope-menu.png"),
    });
    await trigger.click();
    await expect(
      page.getByRole("button", { name: "팀원 개인 조건", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await banner.getByRole("button", { name: "저장된 필터 삭제" }).click();
    await expect(banner).toHaveCount(0);
    await peer.reload();
    await peerTrigger.click();
    await expect(
      peer.getByRole("button", { name: "팀 진행 조건", exact: true }),
    ).toHaveCount(0);
    await expect(
      peer.getByRole("button", { name: "팀원 개인 조건", exact: true }),
    ).toBeVisible();
  } finally {
    await peer.close();
  }
});

test("스냅샷·필터 버튼은 나란히 표시하고 스냅샷에서는 저장된 필터를 잠근 뒤 이전 보기를 복원한다", async ({
  page,
}, info) => {
  await setTaskCells(page, [
    { index: 0, key: "status", value: "status-planned" },
    { index: 1, key: "status", value: "status-completed" },
    { index: 2, key: "status", value: "status-progress" },
  ]);
  const snapshot = await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "머리글 조건을 조정할 스냅샷",
    referenceDate: "2026-10-13",
    view: {
      ...defaultView(2026),
      propertyFilters: { status: ["status-planned", "status-completed"] },
      propertyFilterModes: { status: "include" },
    },
    taskIds,
  });
  await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "전환할 스냅샷",
    referenceDate: "2026-10-13",
    view: defaultView(2026),
    taskIds,
  });
  for (const [name, mode] of [
    ["완료 제외", "exclude"],
    ["완료만", "include"],
  ]) {
    const response = await page.request.put("/api/filters", {
      headers: { "X-Requested-With": "WeeklyPlan" },
      data: {
        teamId,
        scope: "team",
        name,
        data: {
          propertyFilters: { status: ["status-completed"] },
          propertyFilterModes: { status: mode },
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const filters = async () =>
    (await page.request.get(`/api/filters?teamId=${teamId}`)).json();
  const savedSnapshot = async () =>
    (await page.request.get(`/api/reports/${snapshot.id}`)).json().then(unpack);
  const originalSnapshot = await savedSnapshot();
  const savedFilterButton = page.getByRole("button", {
    name: "저장된 필터",
    exact: true,
  });
  const choose = async (name: string) => {
    await savedFilterButton.click();
    await page
      .locator(".saved-views")
      .getByRole("button", { name, exact: true })
      .click();
  };
  const open = async (name = "머리글 조건을 조정할 스냅샷") => {
    await page
      .getByRole("button", { name: "보고서 스냅샷", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "보고서 스냅샷", exact: true })
      .getByRole("button", { name: new RegExp(name) })
      .click();
    await expect(page.getByRole("grid")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await expect(savedFilterButton).toBeDisabled();
    await expect(savedFilterButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".saved-views")).toHaveCount(0);
  };
  const statusFilter = async (values: string[]) => {
    await page
      .getByRole("button", { name: "상태 열 선택", exact: true })
      .click({ button: "right" });
    const menu = page.getByRole("group", {
      name: "상태 필터 선택",
      exact: true,
    });
    for (const name of ["예정", "진행 중", "완료"])
      await menu
        .getByRole("checkbox", { name, exact: true })
        .setChecked(values.includes(name));
    await page.keyboard.press("Escape");
  };
  const checkButtons = async () => {
    const reportBox = (await page
      .getByRole("button", { name: "보고서 스냅샷", exact: true })
      .boundingBox())!;
    const filterBox = (await page
      .locator(".saved-filter-control")
      .boundingBox())!;
    expect(reportBox.x + reportBox.width).toBeLessThanOrEqual(filterBox.x);
    expect(filterBox.x - reportBox.x - reportBox.width).toBeLessThanOrEqual(6);
    expect(Math.abs(reportBox.y - filterBox.y)).toBeLessThan(1);
    expect(reportBox.height).toBe(filterBox.height);
    expect(reportBox.height).toBe(40);
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    if (page.viewportSize()!.width >= 1366) {
      const calendar = await page.locator(".period-scroll").evaluate((el) => ({
        viewport: el.clientWidth,
        content: el.scrollWidth,
      }));
      expect(calendar.content).toBeLessThanOrEqual(calendar.viewport + 1);
    }
    await expect(
      page
        .locator(".top-navigation")
        .getByRole("button", { name: "보고서 스냅샷", exact: true }),
    ).toHaveCount(0);
  };
  const reportBanner = page.getByRole("region", {
    name: "스냅샷 보기",
    exact: true,
  });
  const filterBanner = page.getByRole("region", {
    name: "필터 보기",
    exact: true,
  });
  const close = () =>
    reportBanner.getByRole("button", { name: "스냅샷 보기 종료" }).click();
  const titles = page.locator('[data-column="title"]');
  const header = page.locator('[data-header-key="title"]');
  const rowHeader = page.locator(".sheet-row .row-number").first();
  const background = (locator: Locator) =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  await checkButtons();
  const liveHeaderColor = await background(header);
  await choose("완료 제외");
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  const liveId = (await filters()).filters.find(
    (f: any) => f.name === "완료 제외",
  ).id;
  await expect
    .poll(async () => (await filters()).current.selectedId)
    .toBe(liveId);
  const originalFilters = await filters();
  const filterHeaderColor = await background(header);
  const filterRowColor = await background(rowHeader);

  // 기존 선택은 보관하고 스냅샷에 저장된 조건과 색상으로 시작한다.
  await open();
  await expect(reportBanner).toBeVisible();
  await expect(filterBanner).toHaveCount(0);
  await expect(titles).toHaveText(["첫 업무", "숨길 업무"]);
  expect(await filters()).toEqual(originalFilters);
  const reportHeaderColor = await background(header);
  expect(reportHeaderColor).not.toBe(filterHeaderColor);
  expect(await background(rowHeader)).not.toBe(filterRowColor);
  await page.screenshot({
    path: info.outputPath("snapshot-filter-disabled.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await checkButtons();
  await expect(savedFilterButton).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("snapshot-filter-disabled-compact.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1366, height: 900 });

  // 머리글 필터는 읽기 전용 스냅샷에서도 바꿀 수 있고 원본에는 저장하지 않는다.
  await statusFilter(["완료", "진행 중"]);
  await expect(titles).toHaveText(["숨길 업무", "셋째 업무"]);
  await expect(header).toHaveCSS("background-color", reportHeaderColor);
  await expect(filterBanner).toHaveCount(0);
  await titles.first().dblclick();
  await expect(page.locator(".inline-editor")).toHaveCount(0);
  expect(await filters()).toEqual(originalFilters);
  expect(await savedSnapshot()).toEqual(originalSnapshot);
  await open("전환할 스냅샷");
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await statusFilter(["진행 중"]);
  await expect(titles).toHaveText(["셋째 업무"]);
  await close();
  await expect(reportBanner).toHaveCount(0);
  await expect(savedFilterButton).toBeEnabled();
  await expect(filterBanner.locator("strong")).toHaveText("완료 제외");
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  await expect(header).toHaveCSS("background-color", filterHeaderColor);
  await expect(rowHeader).toHaveCSS("background-color", filterRowColor);
  await expect(page.getByRole("grid")).toHaveAttribute(
    "aria-readonly",
    "false",
  );
  expect(await filters()).toEqual(originalFilters);
  await page.reload();
  await expect(titles).toHaveText(["첫 업무", "셋째 업무"]);
  await expect(filterBanner.locator("strong")).toHaveText("완료 제외");
  expect(await filters()).toEqual(originalFilters);

  // 다시 진입하면 그 시점의 선택을 보관하고, 업무로 돌아가기로도 복원한다.
  await choose("완료만");
  await expect(titles).toHaveText(["숨길 업무"]);
  await open();
  await page
    .getByRole("button", { name: "업무로 돌아가기", exact: true })
    .click();
  await expect(titles).toHaveText(["숨길 업무"]);
  await expect(filterBanner.locator("strong")).toHaveText("완료만");
  await expect(savedFilterButton).toBeEnabled();

  // 선택된 필터가 없었던 화면과 저장하지 않은 머리글 조건도 각각 복원한다.
  await filterBanner.getByRole("button", { name: "필터 보기 종료" }).click();
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect.poll(async () => (await filters()).current.selectedId).toBe("");
  const unfiltered = await filters();
  await open();
  await statusFilter(["진행 중"]);
  await close();
  await expect(page.locator(".active-filter-banner")).toHaveCount(0);
  await expect(titles).toHaveText(["첫 업무", "숨길 업무", "셋째 업무"]);
  await expect(header).toHaveCSS("background-color", liveHeaderColor);
  expect(await filters()).toEqual(unfiltered);
  await statusFilter(["진행 중"]);
  await expect(titles).toHaveText(["셋째 업무"]);
  await expect
    .poll(async () => (await filters()).current.data.propertyFilters.status)
    .toEqual(["status-progress"]);
  const manualFilters = await filters();
  await open();
  await statusFilter(["완료"]);
  await expect(titles).toHaveText(["숨길 업무"]);
  await close();
  await expect(titles).toHaveText(["셋째 업무"]);
  await expect(page.locator(".active-filter-banner")).toHaveCount(0);
  expect(await filters()).toEqual(manualFilters);
  expect(await savedSnapshot()).toEqual(originalSnapshot);
});

test("스냅샷은 다른 연도로 전환해도 닫기와 삭제 후 직전 필터와 배치를 복원한다", async ({
  page,
}, info) => {
  const snapshot = await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "2026 보관 화면",
    referenceDate: "2026-10-12",
    view: { ...defaultView(2026), startMonth: 10, widths: { title: 390 } },
    taskIds,
  });
  const pastTask = (
    await post(page, "/tasks", {
      teamId,
      year: 2025,
      fields: { title: "2025 기록 업무" },
    })
  ).task;
  const past = await post(page, "/reports", {
    teamId,
    year: 2025,
    name: "2025 보관 화면",
    referenceDate: "2025-05-12",
    view: defaultView(2025),
    taskIds: [pastTask.id],
  });
  const liveTask = (
    await post(page, "/tasks", {
      teamId,
      year: 2027,
      fields: { title: "현재 2027 업무" },
    })
  ).task;
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[0],
        key: "title",
        value: "저장 후 바꾼 원본",
        expectedVersion: 1,
      },
    ],
  });
  await chooseYear(page, 2027);
  await expect(page.locator(`[data-cell="${liveTask.id}:title"]`)).toHaveText(
    "현재 2027 업무",
  );
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .getByRole("button", { name: "현재 필터 저장", exact: true })
    .click();
  await page.getByLabel("필터 이름", { exact: true }).fill("복원할 필터");
  await page
    .locator("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page.getByRole("button", { name: "복원할 필터", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toContainText("복원할 필터");
  const grid = page.getByRole("grid");
  await grid.evaluate((el) => {
    el.scrollLeft = 270;
  });
  const scroll = await grid.evaluate((el) => el.scrollLeft);
  await expect
    .poll(async () =>
      (await readPreferences(page, teamId, 2027)).views.some(
        (v: any) => v.name === "__current",
      ),
    )
    .toBe(true);
  const layoutBefore = (await readPreferences(page, teamId, 2027)).views.find(
    (v: any) => v.name === "__current",
  ).data;
  const open = async (name: string) => {
    await page
      .getByRole("button", { name: "보고서 스냅샷", exact: true })
      .click();
    await page
      .locator("dialog")
      .getByRole("button", { name: new RegExp(name) })
      .click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "스냅샷 보기", exact: true }),
    ).toContainText(name);
  };
  await open("2026 보관 화면");
  await expect(page.locator(".year-badge")).toHaveText("2026");
  await expect(page.locator(".year-value")).toHaveText("2026~2027");
  await expect(page.locator('[data-header-key="2026-10-05"]')).toBeVisible();
  await expect(page.locator('[data-header-key="2027-09-27"]')).toBeAttached();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "첫 업무",
  );
  await expect(page.locator('[data-header-key="title"]')).toHaveCSS(
    "width",
    "390px",
  );
  await expect(grid).toHaveAttribute("aria-readonly", "true");
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("snapshot-banner.png") });
  await open("2025 보관 화면");
  await expect(page.locator(".year-badge")).toHaveText("2025");
  await expect(page.locator(`[data-cell="${pastTask.id}:title"]`)).toHaveText(
    "2025 기록 업무",
  );
  await expect(page.locator('[data-header-key="2025-01-06"]')).toBeAttached();
  await page
    .getByRole("button", { name: "스냅샷 보기 종료", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "스냅샷 보기", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".year-badge")).toHaveText("2027");
  await expect(page.locator(`[data-cell="${liveTask.id}:title"]`)).toHaveText(
    "현재 2027 업무",
  );
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toContainText("복원할 필터");
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBe(scroll);
  await expect(grid).toHaveAttribute("aria-readonly", "false");
  expect(
    (await readPreferences(page, teamId, 2027)).views.find(
      (v: any) => v.name === "__current",
    ).data,
  ).toEqual(layoutBefore);
  await open("2026 보관 화면");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "스냅샷 삭제", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "스냅샷 보기", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".year-badge")).toHaveText("2027");
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toContainText("복원할 필터");
  expect((await page.request.get(`/api/reports/${snapshot.id}`)).status()).toBe(
    404,
  );
  expect((await page.request.get(`/api/reports/${past.id}`)).status()).toBe(
    200,
  );
  await open("2025 보관 화면");
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
  const reports = page.getByRole("dialog", {
    name: "보고서 스냅샷",
    exact: true,
  });
  await reports
    .getByRole("checkbox", { name: "2025 보관 화면 선택", exact: true })
    .check();
  page.once("dialog", (dialog) => dialog.accept());
  await reports
    .getByRole("button", { name: "선택 삭제 (1)", exact: true })
    .click();
  await expect(reports.locator(".report-item")).toHaveCount(0);
  await reports.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "스냅샷 보기", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".year-badge")).toHaveText("2027");
  await expect(page.locator(`[data-cell="${liveTask.id}:title"]`)).toHaveText(
    "현재 2027 업무",
  );
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toContainText("복원할 필터");
});

test("스냅샷 저장 폼은 이름과 날짜를 한 줄에 배치하고 선택한 목록만 삭제한다", async ({
  page,
}, info) => {
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "보고서 스냅샷",
    exact: true,
  });
  const name = modal.getByLabel("보고서 이름", { exact: true });
  const date = modal.getByLabel("보고 기준일", { exact: true });
  const save = modal.getByRole("button", {
    name: "현재 보기 저장",
    exact: true,
  });
  const nameBox = (await name.boundingBox())!,
    dateBox = (await date.boundingBox())!,
    saveBox = (await save.boundingBox())!;
  expect(Math.abs(nameBox.y - dateBox.y)).toBeLessThan(2);
  expect(dateBox.width).toBeLessThan(170);
  expect(saveBox.x + saveBox.width).toBeCloseTo(dateBox.x + dateBox.width, 0);
  for (const title of ["삭제할 첫 기록", "삭제할 둘째 기록", "유지할 기록"]) {
    await name.fill(title);
    await save.click();
    await expect(
      modal.getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();
  }
  const items = modal.locator(".report-item");
  await expect(items).toHaveCount(3);
  await modal.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await modal
    .getByRole("checkbox", { name: "유지할 기록 선택", exact: true })
    .uncheck();
  await expect(
    modal.getByRole("checkbox", { name: "전체 선택", exact: true }),
  ).toBeChecked({ indeterminate: true });
  await page.screenshot({ path: info.outputPath("snapshot-save-list.png") });
  const remove = modal.getByRole("button", {
    name: "선택 삭제 (2)",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  await expect(items).toHaveCount(3);
  // 실패 시 목록과 체크를 유지하여 재시도할 수 있다.
  await page.route("**/api/reports", async (route) => {
    if (route.request().method() === "DELETE")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "일시적 삭제 실패" }),
      });
    else await route.fallback();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(modal.getByRole("alert")).toContainText("일시적 삭제 실패");
  await expect(items).toHaveCount(3);
  await expect(remove).toBeEnabled();
  await page.unroute("**/api/reports");
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("유지할 기록");
  await expect(
    modal.getByRole("button", { name: "선택 삭제", exact: true }),
  ).toBeDisabled();
  await modal.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
});

test("기본 툴바의 셀 확대율은 편집과 크기 조절에 적용되고 발표 종료 시 복원된다", async ({
  page,
}, info) => {
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  const input = toolbar.getByRole("spinbutton", {
    name: "확대율",
    exact: true,
  });
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const header = page.locator('[data-header-key="title"]');
  const original = (await cell.boundingBox())!;
  await expect(input).toHaveValue("100");
  await toolbar.getByRole("button", { name: "확대", exact: true }).click();
  await expect(input).toHaveValue("125");
  await input.fill("150");
  await input.press("Enter");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(original.width * 1.5, 0);
  const handle = (await page
    .locator('[data-resize-key="title"]')
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 60,
    handle.y + handle.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await header.boundingBox())!.width)
    .toBeCloseTo(original.width * 1.5 + 60, 0);
  const rowHeight = (await page
    .locator(`[data-row-id="${taskIds[0]}"] .row-number`)
    .boundingBox())!.height;
  const rowHandle = (await page
    .locator('[data-resize-row="0"]')
    .boundingBox())!;
  await page.mouse.move(
    rowHandle.x + rowHandle.width / 2,
    rowHandle.y + rowHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rowHandle.x + rowHandle.width / 2,
    rowHandle.y + rowHandle.height / 2 + 45,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await page
          .locator(`[data-row-id="${taskIds[0]}"] .row-number`)
          .boundingBox())!.height,
    )
    .toBeCloseTo(rowHeight + 45, 0);
  await cell.dblclick();
  await page.locator(".inline-editor textarea").fill("확대 화면에서 편집");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(cell).toHaveText("확대 화면에서 편집");
  await expect(
    page.getByRole("button", { name: "발표 모드", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "발표 모드", exact: true }).click();
  const presentation = page.getByRole("toolbar", { name: "보기모드 도구" });
  await expect(presentation.getByLabel("확대율", { exact: true })).toHaveValue(
    "150",
  );
  await presentation
    .getByRole("button", { name: "원래대로", exact: true })
    .click();
  await presentation
    .getByRole("button", { name: "보기모드 닫기 (Esc)", exact: true })
    .click();
  await expect(input).toHaveValue("150");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(original.width * 1.5 + 60, 0);
  await input.fill("75");
  await input.press("Escape");
  await expect(input).toHaveValue("150");
  await input.fill("30");
  await input.press("Enter");
  await expect(input).toHaveValue("50");
  await expect(
    toolbar.getByRole("button", { name: "축소", exact: true }),
  ).toBeDisabled();
  await input.fill("300");
  await input.press("Enter");
  await expect(input).toHaveValue("200");
  await expect(
    toolbar.getByRole("button", { name: "확대", exact: true }),
  ).toBeDisabled();
  await toolbar.getByRole("button", { name: "원래대로", exact: true }).click();
  await expect(input).toHaveValue("100");
  await expect
    .poll(async () => (await cell.boundingBox())!.width)
    .toBeCloseTo(original.width + 40, 0);
  await page.screenshot({ path: info.outputPath("base-zoom-toolbar.png") });
});

test("스냅샷을 불러오는 중 목록을 닫으면 늦은 응답이 현재 화면을 바꾸지 않는다", async ({
  page,
}) => {
  const snapshot = await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "늦게 도착하는 기록",
    referenceDate: "2026-10-12",
    view: defaultView(2026),
    taskIds,
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(`**/api/reports/${snapshot.id}`, async (route) => {
    const response = await route.fetch();
    requested();
    await pending;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "보고서 스냅샷",
    exact: true,
  });
  await modal.getByRole("button", { name: /늦게 도착하는 기록/ }).click();
  await started;
  await modal.getByRole("button", { name: "닫기", exact: true }).click();
  await chooseYear(page, 2027);
  const response = page.waitForResponse((r) =>
    r.url().endsWith(`/api/reports/${snapshot.id}`),
  );
  release();
  await (await response).finished();
  await expect(page.locator(".year-badge")).toHaveText("2027");
  await expect(
    page.getByRole("region", { name: "스냅샷 보기", exact: true }),
  ).toHaveCount(0);
});
