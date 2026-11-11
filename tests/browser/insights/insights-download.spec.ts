import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unpack } from "../../../shared/formatting/compact.js";
import { selectMonths } from "../support/annual-period";
import {
  assertPdfTableStart,
  pdfTextPages,
} from "../support/insights-pdf-pagination.mjs";

const headers = { "X-Requested-With": "WeeklyPlan" };
const output = resolve("docs/validation/insights-98/pdf-download");
const pdf = (page: Page) =>
  page.getByRole("button", { name: "PDF (인쇄 창에서 저장)", exact: true });
const card = (page: Page, title: string) =>
  page
    .locator(".insights-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
type Printed = {
  html: string;
  title: string;
  pageTitle: string;
  fonts: string[];
};
declare global {
  interface Window {
    insightPrints: Printed[];
    insightPrintMode: "close" | "hold" | "fail";
  }
}
async function api(
  page: Page,
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data ? { data } : {}),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
async function installPrintProbe(page: Page) {
  await page.addInitScript(() => {
    window.insightPrints = [];
    window.insightPrintMode = "close";
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof HTMLIFrameElement &&
            node.classList.contains("insights-print-frame")
          ) {
            const view = node.contentWindow!;
            view.print = () => {
              if (window.insightPrintMode === "fail")
                throw new Error("synthetic print failure");
              window.insightPrints.push({
                html: view.document.documentElement.outerHTML,
                title: view.document.title,
                pageTitle: document.title,
                fonts: [...view.document.fonts]
                  .filter((font) => font.status === "loaded")
                  .map((font) => font.family),
              });
              if (window.insightPrintMode === "close")
                view.dispatchEvent(new Event("afterprint"));
            };
          }
    }).observe(document, { childList: true, subtree: true });
  });
}
let teamId: string, users: { id: string; name: string }[], taskIds: string[];
const teamName = '한글 & <리포트> "출력"';
const flavorId = "reportFlavor",
  methodId = "reportMethod";
const charts = [
  {
    id: "cpdf001",
    title: "작업 합계 & <검토>",
    type: "number",
    dimensions: {},
    values: [{ kind: "workWeeks" }],
  },
  {
    id: "cpdf002",
    title: "긴 분류별 교차 통계",
    type: "table",
    dimensions: {
      row: { kind: "owner" },
      column: { kind: "property", propertyId: flavorId },
    },
    values: [
      { kind: "count" },
      { kind: "workWeeks" },
      { kind: "avgDuration" },
      { kind: "numberSum", propertyId: "reportScore" },
    ],
  },
  {
    id: "cpdf003",
    title: "진행 상태 작업량",
    type: "bar",
    dimensions: { axis: { kind: "progressState" } },
    values: [{ kind: "workWeeks" }],
    display: { orientation: "horizontal" },
  },
  {
    id: "cpdf004",
    title: "작업 상세 Top 50",
    type: "top",
    dimensions: {},
    values: [{ kind: "count" }],
    sort: { kind: "duration" },
    limit: 50,
  },
  {
    id: "cpdf005",
    title: "주별 업무 개수",
    type: "line",
    dimensions: { axis: { kind: "time", unit: "week", basis: "work" } },
    values: [{ kind: "count" }],
  },
  {
    id: "cpdf006",
    title: "업무 방식 비중",
    type: "pie",
    dimensions: { axis: { kind: "property", propertyId: methodId } },
    values: [{ kind: "count" }],
  },
];
async function settings(page: Page) {
  return (await api(page, "/bootstrap")).teams.find(
    (team: any) => team.id === teamId,
  ).settings;
}
async function update(page: Page, extra: object) {
  const current = await settings(page);
  return api(
    page,
    `/teams/${teamId}/settings`,
    { revision: current.revision, ...extra },
    "PATCH",
  );
}
async function task(
  page: Page,
  owner: string,
  index: number,
  weeks: string[],
  work = true,
) {
  const row = (
    await api(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: `한국어 작업 ${index + 1} · <script>문자</script> & 긴 이름을 확인하는 업무`,
        owner,
        [flavorId]: `flavor${index % 10}`,
        [methodId]: index === 2 ? "approachB" : "approachA",
        reportScore: index === 1 ? "완료" : String(index + 1),
      },
    })
  ).task;
  await api(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: weeks.map((key) => ({
      taskId: row.id,
      key,
      style: { backgroundColor: "#0066cc", work },
      expectedVersion: 0,
      expectedFormatRevision: 0,
    })),
  });
  return row.id;
}
async function open(page: Page) {
  await page.goto("/insights");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("4");
  await expect(pdf(page)).toBeEnabled();
}
test.beforeEach(async ({ page }) => {
  await installPrintProbe(page);
  await api(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await api(page, "/bootstrap");
  teamId = (
    await api(page, "/admin/teams", {
      name: teamName,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  users = [boot.user];
  for (let i = 1; i < 3; i++)
    users.push(
      (
        await api(page, "/admin/users", {
          username: `pdf-${randomUUID().slice(0, 8)}@example.test`,
          name: `합성 책임자 ${i + 1} & 검토`,
          password: "test-password-123",
          systemRole: "user",
          memberships: [{ teamId, role: "member" }],
        })
      ).user,
    );
  const current = await settings(page);
  const options = Array.from({ length: 10 }, (_, index) => ({
    id: `flavor${index}`,
    label: `분류 ${index + 1} · 장기 검토`,
    backgroundColor: "#edf6f4",
    dotColor: "#177b70",
    emoji: "",
  }));
  await update(page, {
    properties: [
      ...current.properties.filter(
        (property: any) => property.id !== "category",
      ),
      {
        id: flavorId,
        name: "분류",
        kind: "option",
        display: "text",
        values: options,
      },
      {
        id: methodId,
        name: "업무 방식",
        kind: "option",
        display: "text",
        values: ["병행 검토", "개별 검토", "추가 검토"].map((label, i) => ({
          id: `approach${["A", "B", "C"][i]}`,
          label,
          backgroundColor: "#edf6f4",
          dotColor: "#177b70",
          emoji: "",
        })),
      },
      {
        id: "reportScore",
        name: "검토 점수",
        kind: "text",
        display: "text",
        values: [],
      },
    ],
    insights: {
      workColors: [{ color: "#0066cc", name: "업무" }],
      deadlinePropertyId: null,
      charts,
    },
  });
  taskIds = [];
  const weeks = [
    ["2026-01-05", "2026-01-12"],
    ["2026-01-12"],
    ["2026-01-19"],
    ["2026-01-05"],
    ["2026-01-12"],
  ];
  for (let index = 0; index < weeks.length; index++)
    taskIds.push(
      await task(page, users[index % 3].id, index, weeks[index], index !== 4),
    );
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId: boot.user.id, teamId },
  );
});

async function print(page: Page) {
  await expect(pdf(page)).toHaveAttribute("aria-busy", "false");
  const previous = await page.evaluate(() => window.insightPrints.length);
  await pdf(page).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.insightPrints.length))
    .toBe(previous + 1);
  const printed = await page.evaluate(() => window.insightPrints.at(-1)!);
  return printed;
}
test("PDF 출력은 정확한 선택 주차·필터·현재 카드 선택과 저장 순서를 안전하게 고정한다", async ({
  page,
}, info) => {
  await open(page);
  const first = page.locator('.period-week[data-week="2026-01-12"]');
  await first.focus();
  await first.press("Enter");
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "속성 필터", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "속성 필터", exact: true });
  await filters.getByText("업무 방식", { exact: true }).click();
  await filters
    .getByRole("checkbox", { name: "병행 검토", exact: true })
    .check();
  await page.keyboard.press("Escape");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("2");
  await page.getByLabel("비교 속성", { exact: true }).selectOption(methodId);
  await page
    .getByLabel("비교 값", { exact: true })
    .selectOption('{"kind":"workWeeks"}');
  await page.getByRole("button", { name: "업무 구성", exact: true }).click();
  await page.getByLabel("통계 속성", { exact: true }).selectOption(methodId);
  const radar = card(page, "책임자별 업무 비중");
  await radar
    .getByLabel("비중 비교 속성", { exact: true })
    .selectOption(methodId);
  await radar.locator(".insights-people-selection summary").click();
  await radar
    .getByRole("checkbox", { name: users[0].name, exact: true })
    .uncheck();
  await radar
    .getByRole("checkbox", { name: users[2].name, exact: true })
    .uncheck();
  await expect(radar.locator(".insights-legend")).toHaveText(users[1].name);
  const before = await settings(page);
  const siteTitle = await page.title();
  const printed = await print(page);
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  await expect(page).toHaveTitle(siteTitle);
  await expect(pdf(page)).toBeFocused();
  expect(printed.title).toBe(`${teamName} · 인사이트 보고서`);
  expect(printed.pageTitle).toBe(printed.title);
  expect(printed.fonts.some((font) => font.includes("Noto Sans KR"))).toBe(
    true,
  );
  const preview = await page.context().newPage();
  await preview.goto("/api/health");
  await preview.setContent(printed.html);
  await expect(preview.locator("h1")).toHaveText(printed.title);
  await expect(preview.locator(".insights-report-header")).toContainText(
    "업무 방식 일치: 병행 검토",
  );
  await expect(preview.locator(".insights-report-weeks")).toHaveText(
    "선택 주차 (시작일 / 연간 표시 월): 2026-01-12 / 2026-01, 2026-01-19 / 2026-01",
  );
  await expect(card(preview, "업무 수").locator("strong")).toHaveText("2");
  await expect(card(preview, "작업 주 합").locator("strong")).toHaveText("2");
  const printedTrend = card(preview, "주별 업무 개수");
  await expect(printedTrend.locator("svg.insights-lines")).toBeVisible();
  await expect(
    printedTrend.locator(".insights-print-data tbody tr"),
  ).toHaveCount(2);
  await expect(
    printedTrend.locator(".insights-print-data tbody tr").first(),
  ).toContainText("2026-01-12");
  await expect(
    printedTrend
      .locator(".insights-print-data tbody tr")
      .first()
      .locator("td")
      .last(),
  ).toHaveText("2");
  await expect(
    printedTrend
      .locator(".insights-print-data tbody tr")
      .last()
      .locator("td")
      .last(),
  ).toHaveText("0");
  const printedPie = card(preview, "업무 방식 비중");
  await expect(printedPie.locator("svg.insights-pie circle")).toHaveCount(1);
  await expect(printedPie.locator(".insights-pie-legend")).toContainText(
    "100%",
  );
  await expect(printedPie.locator(".insights-print-data tbody tr")).toHaveCount(
    3,
  );
  await expect(card(preview, "책임자별 업무 비교")).toContainText("업무 방식");
  await expect(card(preview, "책임자별 업무 비교")).toContainText("작업 주 합");
  await expect(
    card(preview, "책임자별 업무 비교")
      .locator(".insights-comparison-controls label")
      .nth(1),
  ).toHaveText(/값\s*작업 주 합/);
  await expect(card(preview, "책임자별 업무 비교")).toContainText("업무 구성");
  await expect(card(preview, "선택형 속성별 통계")).toContainText("업무 방식");
  await expect(
    card(preview, "책임자별 업무 비중").locator(".insights-print-only"),
  ).toHaveText(`책임자 선택 (일치): ${users[1].name}`);
  await expect(
    card(preview, "책임자별 업무 비중").locator(
      ".insights-print-data tbody tr",
    ),
  ).toHaveCount(3);
  await expect(
    card(preview, "책임자별 업무 비중")
      .locator(".insights-print-data tbody tr")
      .first(),
  ).toContainText("100%");
  await expect(
    preview.locator(
      "button, select, input, textarea, script, [tabindex], [role=dialog], .insights-card-actions",
    ),
  ).toHaveCount(0);
  const order = await preview
    .locator(".insights-team-chart h3")
    .allTextContents();
  expect(order).toEqual(charts.map((chart) => chart.title));
  await expect(card(preview, "긴 분류별 교차 통계")).toContainText("제외 1건");
  await expect(card(preview, "작업 상세 Top 50")).toContainText(
    "<script>문자</script>",
  );
  expect(await settings(page)).toEqual(before);
  await expect(page.getByLabel("비교 속성", { exact: true })).toHaveValue(
    methodId,
  );
  await expect(page.getByLabel("비교 값", { exact: true })).toHaveValue(
    '{"kind":"workWeeks"}',
  );
  await expect(page.locator('.period-week[aria-pressed="true"]')).toHaveCount(
    2,
  );
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, `${info.project.name}-filtered.html`),
    printed.html,
  );
  await preview.screenshot({
    path: resolve(output, `${info.project.name}-filtered.png`),
    fullPage: true,
  });
  await preview.close();
  await page.screenshot({
    path: resolve(output, `${info.project.name}-desktop.png`),
  });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const dates = page.locator(".insights-date-row .date-controls");
    await dates.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    const controls = [
      dates,
      page.getByRole("button", { name: "속성 필터", exact: true }),
      page.getByRole("button", { name: "인사이트 설정", exact: true }),
      pdf(page),
    ];
    const boxes = await Promise.all(
      controls.map((control) => control.boundingBox()),
    );
    for (const box of boxes.slice(1)) {
      expect(
        Math.abs(
          box!.y + box!.height / 2 - (boxes[0]!.y + boxes[0]!.height / 2),
        ),
      ).toBeLessThan(2);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(boxes[0]!.width).toBeGreaterThan(30);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "속성 필터", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "속성 필터", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(output, `${info.project.name}-${width}px-filter.png`),
    });
    await page.keyboard.press("Escape");
  }
});

test("인쇄 취소·실패·재시도·중복 클릭은 제목·포커스·선택 상태와 프레임 수명을 보존한다", async ({
  page,
}) => {
  await open(page);
  const title = await page.title();
  await page.evaluate(() => {
    window.insightPrintMode = "hold";
  });
  const snapshot = await print(page);
  await expect(pdf(page)).toHaveAttribute("aria-busy", "true");
  await pdf(page).dispatchEvent("click");
  expect(await page.evaluate(() => window.insightPrints.length)).toBe(1);
  expect(await page.locator(".insights-print-frame").count()).toBe(1);
  // Realtime changes cannot alter the already captured report.
  await task(page, users[0].id, 5, ["2026-01-05"]);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("5");
  const frameText = await page
    .frameLocator(".insights-print-frame")
    .locator(".insights-summary strong")
    .first()
    .textContent();
  expect(frameText).toBe("4");
  expect(snapshot.html).toContain("인사이트 보고서");
  // Native dialogs do not distinguish Cancel from Save; both close afterprint.
  await page.evaluate(() =>
    document
      .querySelector<HTMLIFrameElement>(".insights-print-frame")!
      .contentWindow!.dispatchEvent(new Event("afterprint")),
  );
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  await expect(pdf(page)).toHaveAttribute("aria-busy", "false");
  await expect(page).toHaveTitle(title);
  await expect(pdf(page)).toBeFocused();
  await page.evaluate(() => {
    window.insightPrintMode = "fail";
  });
  await pdf(page).click();
  await expect(
    page.getByText(/보고서를 내려받지 못했습니다.*synthetic print failure/),
  ).toBeVisible();
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  await expect(page).toHaveTitle(title);
  await expect(pdf(page)).toBeEnabled();
  await page.evaluate(() => {
    window.insightPrintMode = "close";
  });
  await print(page);
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  await expect(page).toHaveTitle(title);
  await expect(pdf(page)).toHaveAttribute("aria-busy", "false");
});

test("인쇄 후 탭 포커스 복귀와 화면 이탈도 프레임·제목을 정리하며 재출력이 가능하다", async ({
  page,
}) => {
  await open(page);
  const title = await page.title();
  await page.evaluate(() => {
    window.insightPrintMode = "hold";
  });
  await print(page);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  await expect(page).toHaveTitle(title);
  await print(page);
  await page
    .getByRole("navigation", { name: "주 메뉴" })
    .getByRole("button", { name: "연간 업무", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
  // The report's print title gives way to the screen it moved to.
  await expect(page).toHaveTitle("연간 업무 · 그래보드");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "인사이트", exact: true })
    .click();
  await expect(pdf(page)).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => {
    window.insightPrintMode = "close";
  });
  await print(page);
  await expect(page.locator(".insights-print-frame")).toHaveCount(0);
});

test("데이터 대기·조회 실패·미설정·잘못된 차트는 정상 PDF로 내보내지 않으며 빈 범위는 명시한다", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?**", async (route) => {
    await hold;
    await route.fulfill({
      status: 503,
      json: { error: "합성 자료 조회 실패" },
    });
  });
  await page.goto("/insights");
  await expect(
    page.getByRole("status", { name: "업무를 불러오고 있습니다", exact: true }),
  ).toBeVisible();
  await expect(pdf(page)).toHaveCount(0);
  release();
  await expect(
    page.getByRole("button", { name: "다시 연결", exact: true }),
  ).toBeVisible();
  await expect(pdf(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.insightPrints)).toHaveLength(0);
  await page.unroute("**/api/tasks?**");
  await page.getByRole("button", { name: "다시 연결", exact: true }).click();
  await expect(pdf(page)).toBeEnabled();
  await selectMonths(page, 2026, 5);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
  const empty = await print(page);
  expect(empty.html).toContain("해당 업무가 없습니다.");
  expect(empty.html).toContain("2026-05");
  await update(page, {
    insights: { workColors: [], deadlinePropertyId: null, charts },
  });
  await expect(
    page.getByText("업무 색상을 설정해 주세요", { exact: true }),
  ).toBeVisible();
  await expect(pdf(page)).toBeDisabled();
  await update(page, {
    insights: {
      workColors: [{ color: "#0066cc", name: "업무" }],
      deadlinePropertyId: null,
      charts: [
        {
          id: "cbad001",
          title: "잘못된 참조",
          type: "radar",
          dimensions: {
            axis: { kind: "property", propertyId: "unknownProperty" },
            series: { kind: "owner" },
          },
          values: [{ kind: "count" }],
        },
      ],
    },
  });
  await expect(card(page, "잘못된 참조").getByRole("alert")).toBeVisible();
  await expect(pdf(page)).toBeDisabled();
});

test("열람자도 PDF를 출력하고 좁은 화면의 날짜·속성 필터 행은 유지된다", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    // Create the viewer through the administrator's real API session.
    const admin = await browser.newContext({ baseURL });
    const adminPage = await admin.newPage();
    await api(adminPage, "/auth/login", {
      username: "test@somansa.com",
      password: "1234",
    });
    const username = `pdf-viewer-${randomUUID().slice(0, 8)}@example.test`;
    const user = (
      await api(adminPage, "/admin/users", {
        username,
        name: "보고서 열람자",
        password: "test-password-123",
        systemRole: "user",
        memberships: [{ teamId, role: "viewer" }],
      })
    ).user;
    await admin.close();
    await installPrintProbe(page);
    await api(page, "/auth/login", { username, password: "test-password-123" });
    await page.addInitScript(
      ({ userId, teamId }) =>
        localStorage.setItem(
          `weekly-board:${userId}`,
          JSON.stringify({ teamId, year: 2026 }),
        ),
      { userId: user.id, teamId },
    );
    await open(page);
    await expect(
      page.getByRole("button", { name: "인사이트 설정", exact: true }),
    ).toHaveCount(0);
    const [dates, filter, button] = await Promise.all([
      page.locator(".insights-date-row .date-controls").boundingBox(),
      page
        .getByRole("button", { name: "속성 필터", exact: true })
        .boundingBox(),
      pdf(page).boundingBox(),
    ]);
    expect(button!.x + button!.width).toBeLessThanOrEqual(390);
    expect(
      Math.abs(
        filter!.y + filter!.height / 2 - (button!.y + button!.height / 2),
      ),
    ).toBeLessThan(2);
    expect(
      Math.abs(dates!.y + dates!.height / 2 - (button!.y + button!.height / 2)),
    ).toBeLessThan(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: resolve(
        output,
        `viewer-${browser.browserType().name()}-mobile.png`,
      ),
    });
    const before = await settings(page);
    await print(page);
    await expect(page.locator(".insights-print-frame")).toHaveCount(0);
    expect(await settings(page)).toEqual(before);
  } finally {
    await context.close();
  }
});

test("앱에서 생성한 보고서는 긴 한글·모든 행·여러 값의 매트릭스와 SVG를 실제 다중 페이지 PDF로 출력한다", async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(90000);
  await mkdir(output, { recursive: true });
  for (let index = 0; index < 35; index++) {
    const user = (
      await api(page, "/admin/users", {
        username: `pdf-long-${randomUUID().slice(0, 8)}@example.test`,
        name: `장기 과제 책임자 ${String(index + 4).padStart(2, "0")} · 제품 경험과 업무 개선을 함께 검토하는 담당자`,
        password: "test-password-123",
        systemRole: "user",
        memberships: [{ teamId, role: "member" }],
      })
    ).user;
    await task(page, user.id, index + 5, ["2026-01-05", "2026-01-12"]);
  }
  const current = await settings(page);
  await update(page, {
    insights: {
      ...current.insights,
      charts: charts.map((chart) =>
        chart.id === "cpdf003"
          ? {
              ...chart,
              title: "책임자별 작업 주 합",
              dimensions: { axis: { kind: "owner" } },
            }
          : chart,
      ),
    },
  });
  await page.goto("/insights");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("39");
  const before = await settings(page);
  const printed = await print(page);
  const preview = await page.context().newPage();
  await preview.goto("/api/health");
  await preview.setContent(printed.html);
  await preview.emulateMedia({ media: "print" });
  await preview.evaluate(() => document.fonts.ready);
  expect(
    await preview.evaluate(() =>
      [...document.fonts].some(
        (font) =>
          font.family.includes("Noto Sans KR") && font.status === "loaded",
      ),
    ),
  ).toBe(true);
  const matrix = card(preview, "긴 분류별 교차 통계");
  await expect(matrix.locator("table")).toHaveCount(6);
  for (const table of await matrix.locator("table").all()) {
    await expect(table.locator("tbody tr")).toHaveCount(38);
    await expect(
      table.locator("tbody tr").filter({ hasText: "책임자 38" }),
    ).toHaveCount(1);
    expect(
      await table.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
  }
  const matrixStarts = await matrix.locator("table").evaluateAll((nodes) =>
    nodes.map((node) => {
      const table = node as HTMLTableElement;
      return {
        title: table.getAttribute("aria-label") || "",
        columns: [...table.tHead!.rows[0].cells].map((cell) =>
          cell.textContent!.trim(),
        ),
        firstRow: [...table.tBodies[0].rows[0].cells]
          .map((cell) => cell.textContent!.trim())
          .join("\t"),
      };
    }),
  );
  expect(matrixStarts.map((start) => start.title)).toEqual(
    Array.from(
      { length: 6 },
      (_, index) => `긴 분류별 교차 통계 · 열 묶음 ${index + 1}/6`,
    ),
  );
  for (const start of matrixStarts) {
    await expect(
      matrix.getByRole("heading", { name: start.title, exact: true }),
    ).toBeVisible();
    await expect(
      matrix.getByRole("table", { name: start.title, exact: true }),
    ).toBeVisible();
  }
  const overflow = await preview
    .locator(
      ".insights-table-scroll, .insights-chart-scroll, .insights-matrix-scroll",
    )
    .evaluateAll((nodes) =>
      nodes
        .filter(
          (node) =>
            node.scrollWidth > node.clientWidth + 2 ||
            node.scrollHeight > node.clientHeight + 2,
        )
        .map((node) => node.className),
    );
  expect(overflow).toEqual([]);
  await expect(
    card(preview, "작업 상세 Top 50").locator("tbody tr"),
  ).toHaveCount(39);
  await expect(preview.locator("svg.insights-radar")).toHaveCount(1);
  const longBars = card(preview, "책임자별 작업 주 합");
  expect(await longBars.locator("figure").count()).toBeGreaterThan(1);
  await expect(longBars.locator(".insights-print-data tbody tr")).toHaveCount(
    38,
  );
  const plotted = await longBars.locator("figure svg").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const box = (node as SVGSVGElement).viewBox.baseVal;
      return [...node.querySelectorAll(".insights-axis-label")]
        .filter((label) => {
          const y = Number(label.getAttribute("y"));
          return y >= box.y && y < box.y + box.height;
        })
        .map((label) => label.textContent);
    }),
  );
  expect(plotted).toHaveLength(38);
  expect(new Set(plotted).size).toBe(38);
  await expect(preview.locator(".insights-heat-cell")).not.toHaveCount(0);
  await writeFile(
    resolve(output, `${browserName}-multipage.html`),
    printed.html,
  );
  if (browserName === "chromium") {
    await preview.pdf({
      path: resolve(output, "synthetic-multipage.pdf"),
      preferCSSPageSize: true,
      printBackground: true,
    });
    const firstTask = await card(preview, "작업 상세 Top 50")
      .locator("tbody tr .insights-task-link")
      .first()
      .innerText();
    const pages = pdfTextPages(resolve(output, "synthetic-multipage.pdf"));
    await writeFile(
      resolve(output, "pdf-matrix-starts.json"),
      JSON.stringify(
        matrixStarts.map((start) => ({
          ...start,
          ...assertPdfTableStart(pages, start),
        })),
        null,
        2,
      ),
    );
    const pagination = assertPdfTableStart(pages, {
      title: "작업 상세 Top 50",
      columns: ["작업명", "책임자", "작업 주", "업무 기간", "목표일 상태"],
      firstRow: firstTask,
    });
    const compact = (text: string) =>
      text.normalize("NFC").replace(/\s+/gu, "");
    const allText = compact(pages.join("\n"));
    expect(allText).toContain(compact("주별 업무 개수"));
    expect(allText).toContain(compact("업무 방식 비중"));
    const sectionStart = allText.indexOf(compact("작업 상세 Top 50"));
    const sectionEnd = allText.indexOf(
      compact("가장 오래 걸린 업무 Top 10"),
      sectionStart,
    );
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const taskSection = allText.slice(sectionStart, sectionEnd);
    const taskTitles = await card(preview, "작업 상세 Top 50")
      .locator("tbody tr .insights-task-link")
      .allTextContents();
    expect(taskTitles).toHaveLength(39);
    for (const title of taskTitles)
      expect(taskSection).toContain(compact(title));
    await writeFile(
      resolve(output, "pdf-table-start.json"),
      JSON.stringify(
        { ...pagination, firstTask, taskRows: taskTitles.length },
        null,
        2,
      ),
    );
    await info.attach("actual-multipage-report", {
      path: resolve(output, "synthetic-multipage.pdf"),
      contentType: "application/pdf",
    });
  }
  await preview.screenshot({
    path: resolve(output, `${browserName}-print-layout.png`),
    fullPage: true,
  });
  expect(await settings(page)).toEqual(before);
  await preview.close();
});
