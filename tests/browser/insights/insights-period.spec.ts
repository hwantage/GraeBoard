import { selectMonths, moveCalendarMonths } from "../support/annual-period";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { defaultView } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskIds: string[];
let sourceTraffic: { requests: string[]; responses: number } | undefined;
async function request(
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
const card = (page: Page, name: string) =>
  page
    .locator(".insights-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
async function chooseWeek(page: Page, key: string) {
  const button = page.locator(`.period-week[data-week="${key}"]`);
  await expect(button).toBeEnabled();
  await button.focus();
  await button.press("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page
        .locator('.period-week[aria-pressed="true"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-week")),
        ),
    )
    .toEqual([key]);
}
async function openInsights(page: Page) {
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "인사이트", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "인사이트", exact: true }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }, info) => {
  sourceTraffic = undefined;
  if (info.tags.includes("@source-owner")) {
    const traffic = { requests: [] as string[], responses: 0 };
    sourceTraffic = traffic;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/api/tasks" &&
        request.method() === "GET"
      )
        traffic.requests.push(request.url());
    });
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname === "/api/tasks" &&
        response.request().method() === "GET"
      )
        traffic.responses++;
    });
    // Install before the fixture's first app mount; reloading an existing SSE
    // client can legitimately include its reconnect/recovery responses.
    await page.clock.install();
  }
  await request(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", {
      name: `공유 기간 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  const current = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision || 0,
      properties: [
        ...current.properties,
        {
          id: "initiativeFlavor",
          name: "제품 성격",
          kind: "option",
          display: "text",
          values: ["새 시도", "개선 활동", "기반 작업"].map((label, i) => ({
            id: `tone_${i}`,
            label,
            backgroundColor: "#edf6f4",
            dotColor: "#177b70",
            emoji: "",
          })),
        },
        {
          id: "weightPoints",
          name: "영향 점수",
          kind: "number",
          display: "text",
          values: [],
        },
      ],
      insights: {
        workColors: [{ color: "#0066cc", name: "명시적 작업" }],
        deadlinePropertyId: null,
        charts: [],
      },
    },
    "PATCH",
  );
  taskIds = [];
  const work = [["2026-01-05"], ["2026-01-12", "2026-01-19"], ["2026-12-28"]];
  for (let i = 0; i < work.length; i++) {
    const row = (
      await request(page, "/tasks", {
        teamId,
        year: 2026,
        fields: {
          title: `공유 범위 업무 ${i + 1}`,
          owner: userId,
          initiativeFlavor: `tone_${i}`,
          weightPoints: i + 1,
        },
      })
    ).task;
    taskIds.push(row.id);
    await request(page, "/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: work[i].map((key) => ({
        taskId: row.id,
        key,
        style: { backgroundColor: "#0066cc", work: true },
        expectedVersion: 0,
        expectedFormatRevision: 0,
      })),
    });
  }
  if (info.tags.includes("@source-owner")) {
    // An absent personal view is saved on the first navigation, legitimately
    // invalidating resources. Isolate route/subscription ownership from that
    // unrelated write by starting with a real persisted annual layout.
    await request(
      page,
      "/views",
      { teamId, name: "__current", data: defaultView(2026) },
      "PUT",
    );
  }
  await page.addInitScript(
    ({ userId, teamId }) => {
      if (!localStorage.getItem(`weekly-board:${userId}`))
        localStorage.setItem(
          `weekly-board:${userId}`,
          JSON.stringify({ teamId, year: 2026 }),
        );
      // A stale legacy Insights range must not override the annual selection.
      if (!sessionStorage.getItem(`graeboard:insights:${userId}:${teamId}`))
        sessionStorage.setItem(
          `graeboard:insights:${userId}:${teamId}`,
          JSON.stringify({
            period: { from: "2000-01", to: "2000-01" },
            filter: {},
          }),
        );
    },
    { userId, teamId },
  );
  await page.goto("/");
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "공유 범위 업무 1",
  );
});

test("연간 머리글의 통계 아이콘과 동일 PeriodPicker는 주차·월 선택을 양방향으로 공유하고 기존 월 세션을 무시한다", async ({
  page,
}, info) => {
  const heading = page.locator(".page-heading");
  const toggle = heading.getByRole("button", { name: "인사이트", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle.locator("svg")).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: info.outputPath("annual-header-desktop.png") });
  await expect(
    page
      .getByRole("navigation", { name: "주 메뉴" })
      .getByRole("button", { name: "인사이트", exact: true }),
  ).toHaveCount(0);
  await chooseWeek(page, "2026-01-12");
  await openInsights(page);
  await expect(
    heading.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "인사이트", exact: true }),
  ).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("group", { name: "월·주차 기간 선택" }),
  ).toHaveCount(1);
  await expect(page.locator('input[type="month"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "배경색", exact: true }),
  ).toHaveCount(0);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("1");
  const week = page.locator('.period-week[data-week="2026-01-12"]');
  await expect(week).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('.period-week[data-week="2026-01-05"]'),
  ).toHaveAttribute("aria-pressed", "false");
  await week.focus();
  await week.press("Shift+ArrowRight");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("2");
  await toggle.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.locator('.period-week[data-week="2026-01-19"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(`[data-cell="${taskIds[1]}:2026-01-19"]`),
  ).toBeVisible();
  await expect(
    page.locator(`[data-cell="${taskIds[1]}:2026-01-05"]`),
  ).toHaveCount(0);
  await selectMonths(page, 2026, 1);
  await openInsights(page);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("2");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("3");
  await expect(page.getByLabel("통계 속성")).toHaveValue("initiativeFlavor");
  await page.screenshot({ path: info.outputPath("shared-period-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeVisible();
  await expect(
    page.getByRole("group", { name: "월·주차 기간 선택" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("shared-period-390.png") });
});

test("연말 표시 주와 순환 12개월·연도 이동은 실제 원본 연도들을 합치며 SSE 뒤에도 경계 업무를 잃지 않는다", async ({
  page,
}, info) => {
  const next = (
    await request(page, "/tasks", {
      teamId,
      year: 2027,
      fields: {
        title: "다음 해 작업",
        owner: userId,
        initiativeFlavor: "tone_0",
        weightPoints: 4,
      },
    })
  ).task;
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: next.id,
        key: "2027-01-04",
        style: { backgroundColor: "#0066cc", work: true },
        expectedVersion: 0,
        expectedFormatRevision: 0,
      },
    ],
  });
  await openInsights(page);
  await chooseWeek(page, "2026-12-28");
  const monthly = card(page, "월별 작업량");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  await expect(
    monthly.getByRole("button", { name: "2026-12 · 전체: 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "2026년 전체 선택", exact: true })
    .click();
  await moveCalendarMonths(page, 1);
  await expect(
    page.locator('.period-month[data-year="2027"][data-month="1"]'),
  ).toBeVisible();
  await selectMonths(page, 2027, 1);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("2");
  await expect(
    monthly.getByRole("button", { name: "2027-01 · 전체: 2", exact: true }),
  ).toBeVisible();
  const reads: { year: number; startMonth: string | null }[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/tasks")
      reads.push({
        year: Number(url.searchParams.get("year")),
        startMonth: url.searchParams.get("startMonth"),
      });
  });
  const boot = await request(page, "/bootstrap");
  const current = boot.teams.find((t: any) => t.id === teamId).settings;
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      properties: current.properties.map((p: any) =>
        p.id === "initiativeFlavor" ? { ...p, name: "변경된 제품 성격" } : p,
      ),
    },
    "PATCH",
  );
  await expect
    .poll(() =>
      reads.some((read) => read.year === 2026 && read.startMonth === "2"),
    )
    .toBeTruthy();
  expect(
    reads.every((read) => read.year === 2026 && read.startMonth === "2"),
  ).toBeTruthy();
  await expect(
    page.getByLabel("통계 속성").locator("option:checked"),
  ).toHaveText("변경된 제품 성격");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("2");
  await monthly
    .getByRole("button", { name: "2027-01 · 전체: 2", exact: true })
    .click();
  const list = page.getByRole("dialog", {
    name: "월별 작업량 · 업무 목록",
    exact: true,
  });
  await expect(list.locator("tbody tr")).toHaveCount(2);
  await expect(
    list.getByRole("button", { name: "공유 범위 업무 3", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "다음 해 작업", exact: true }),
  ).toBeVisible();
  await list.getByRole("button", { name: "다음 해 작업", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await expect(detail).toContainText("다음 해 작업");
  await expect(page.locator(".year-value")).toHaveText("2026~2027");
  await expect(
    page.locator('.period-month[data-year="2027"][data-month="1"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('.period-month[data-year="2026"][data-month="2"]'),
  ).toHaveAttribute("aria-pressed", "false");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await openInsights(page);
  await request(page, "/tasks", {
    teamId,
    year: 2027,
    fields: { title: "표시 없는 자료", owner: userId },
  });
  await expect(
    page.locator(".board-summary > span").first().locator("strong"),
  ).toHaveText("5");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("2");
  await page.screenshot({ path: info.outputPath("rolling-shared-period.png") });
  await page.getByRole("button", { name: "이전 연도", exact: true }).click();
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("4");
  await expect(page.locator(".year-value")).toHaveText("2026");
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(page.locator(".year-value")).toHaveText("2027");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
});

test("2000년 첫 표시 주는 1999년 API 없이 집계하고 숨김으로 비어 있는 View는 전체 월로 넓히지 않는다", async ({
  page,
}) => {
  const row = (
    await request(page, "/tasks", {
      teamId,
      year: 2000,
      fields: { title: "첫 달력 경계", owner: userId },
    })
  ).task;
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: row.id,
        key: "1999-12-27",
        style: { backgroundColor: "#0066cc", work: true },
        expectedVersion: 0,
        expectedFormatRevision: 0,
      },
    ],
  });
  const reads: number[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/tasks")
      reads.push(Number(u.searchParams.get("year")));
  });
  await page.evaluate(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2000 }),
      ),
    { userId, teamId },
  );
  await page.goto("/insights");
  await chooseWeek(page, "1999-12-27");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("1");
  await expect(
    card(page, "월별 작업량").getByRole("button", {
      name: "2000-01 · 전체: 1",
      exact: true,
    }),
  ).toBeVisible();
  expect(reads).not.toContain(1999);
  const layout = defaultView(2000);
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/views") &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await selectMonths(page, 2000, 1);
  await saved;
  const hidden = await page
    .locator(".period-week[data-week]")
    .evaluateAll((nodes) =>
      nodes
        .filter(
          (n) =>
            n.closest(".period-grid") &&
            n.getAttribute("aria-pressed") === "true",
        )
        .map((n) => n.getAttribute("data-week")),
    );
  await request(
    page,
    "/views",
    {
      teamId,
      name: "__current",
      data: {
        ...layout,
        year: 2000,
        startMonth: 1,
        fromMonth: 1,
        toMonth: 1,
        fromWeek: "",
        toWeek: "",
        hiddenWeeks: hidden,
        collapsedMonths: [],
      },
    },
    "PUT",
  );
  await page.reload();
  await expect(page.locator('.period-week[aria-pressed="true"]')).toHaveCount(
    0,
  );
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("0");
  await expect(
    card(page, "월별 작업량").locator('svg [role="button"]'),
  ).toHaveCount(0);
  expect(reads).not.toContain(1999);
  const trend = card(page, "업무 개수 추이");
  await expect(trend).toContainText("선택한 기간이 없습니다.");
  await selectMonths(page, 2000, 2);
  await expect(trend.locator("svg.insights-lines")).toBeVisible();
  await expect
    .poll(() =>
      trend.locator(".insights-line-scroll").evaluate((node) => {
        const svg = node.querySelector("svg")!;
        return Math.abs(
          svg.viewBox.baseVal.width - Math.floor(node.clientWidth),
        );
      }),
    )
    .toBeLessThan(2);
});

test("사용자 정의 속성 ID·이름·종류의 실시간 변경과 다른 팀은 동적으로 반영하고 보관 차트 참조는 보존한다", async ({
  page,
}) => {
  const savedChart = {
    id: "cdyn001",
    title: "제품 성격 기록",
    type: "table",
    dimensions: { row: { kind: "property", propertyId: "initiativeFlavor" } },
    values: [{ kind: "numberSum", propertyId: "weightPoints" }],
  };
  let current = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      insights: { ...current.insights, charts: [savedChart] },
    },
    "PATCH",
  );
  await openInsights(page);
  for (const label of ["통계 속성", "비교 속성", "비중 비교 속성"])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(
      "initiativeFlavor",
    );
  await page
    .getByLabel("비교 값", { exact: true })
    .selectOption(
      JSON.stringify({ kind: "numberSum", propertyId: "weightPoints" }),
    );
  await expect(
    page
      .getByRole("region", { name: "책임자별 업무 비교", exact: true })
      .getByRole("button", {
        name: "전체 합계 · 숫자 열 합계 · 영향 점수: 6",
        exact: true,
      }),
  ).toBeVisible();
  current = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      properties: [
        ...current.properties.map((p: any) =>
          p.id === "initiativeFlavor"
            ? { ...p, name: "활동 방식", kind: "text", values: [] }
            : p.id === "weightPoints"
              ? { ...p, archived: true }
              : p,
        ),
        {
          id: "workVector",
          name: "업무 방향",
          kind: "option",
          display: "text",
          values: ["동쪽", "서쪽", "중앙"].map((label, i) => ({
            id: `bearing_${i}`,
            label,
            backgroundColor: "#edf6f4",
            dotColor: "#177b70",
            emoji: "",
          })),
        },
      ],
    },
    "PATCH",
  );
  for (const label of ["통계 속성", "비교 속성", "비중 비교 속성"])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(
      "workVector",
    );
  await expect(page.getByLabel("비교 값", { exact: true })).toHaveValue(
    JSON.stringify({ kind: "count" }),
  );
  const historical = card(page, "제품 성격 기록");
  await expect(
    historical.getByText("선택형 속성이 아닙니다: 활동 방식", { exact: true }),
  ).toBeVisible();
  await expect(
    historical.getByText("보관된 속성: 영향 점수", { exact: true }),
  ).toBeVisible();
  await expect(historical.getByRole("alert")).toContainText(
    "차트 설정에서 다시 선택하세요",
  );
  await expect(historical.locator("tfoot")).toHaveCount(0);
  current = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  expect(current.insights.charts).toEqual([savedChart]);
  const other = (
    await request(page, "/admin/teams", {
      name: `다른 구성 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  const otherSettings = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === other,
  ).settings;
  await request(
    page,
    `/teams/${other}/settings`,
    {
      revision: otherSettings.revision,
      properties: [
        ...otherSettings.properties,
        {
          id: "riskBand",
          name: "지원 영역",
          kind: "option",
          display: "text",
          values: ["현장", "사무", "공통"].map((label, i) => ({
            id: `support_${i}`,
            label,
            backgroundColor: "#ffffff",
            dotColor: "#000000",
            emoji: "",
          })),
        },
      ],
      insights: {
        workColors: [{ color: "#cc6600" }],
        deadlinePropertyId: null,
        charts: [],
      },
    },
    "PATCH",
  );
  await page.reload();
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(other);
  await expect(page.getByLabel("통계 속성", { exact: true })).toHaveValue(
    "riskBand",
  );
  await expect(page.getByLabel("비교 속성", { exact: true })).toHaveValue(
    "riskBand",
  );
  await expect(
    page
      .getByLabel("통계 속성", { exact: true })
      .locator('option[value="initiativeFlavor"]'),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("비교 값", { exact: true }).locator("option"),
  ).toHaveText(["업무 수", "작업 주 합"]);
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await expect(page.getByLabel("통계 속성", { exact: true })).toHaveValue(
    "workVector",
  );
  await expect(card(page, "제품 성격 기록").getByRole("alert")).toContainText(
    "차트 설정에서 다시 선택하세요",
  );
  await expect(card(page, "제품 성격 기록").locator("tfoot")).toHaveCount(0);
});

test("통계 아이콘은 셀 편집·저장 중 이동을 막고 연간 메모 flush 실패 시 날짜와 입력을 보존한다", async ({
  page,
}) => {
  const toggle = page.locator(".page-heading .insights-toggle");
  const cell = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await cell.dblclick();
  const input = page
    .locator(".inline-editor textarea,.inline-editor input")
    .first();
  await expect(input).toBeVisible();
  await expect(toggle).toBeDisabled();
  await input.press("Escape");
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let pending = false;
  await page.route("**/api/cells/batch", async (route) => {
    const response = await route.fetch();
    pending = true;
    await held;
    await route.fulfill({ response });
  });
  await cell.dblclick();
  await input.fill("저장 후에도 남는 원본 제목");
  await input.press("Enter");
  await expect.poll(() => pending).toBeTruthy();
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "다음 연도", exact: true }),
  ).toBeDisabled();
  release();
  await expect(toggle).toBeEnabled();
  await page.unroute("**/api/cells/batch");
  const memoId = randomUUID();
  const memoPath = `/teams/${teamId}/years/2026/memos/${memoId}`;
  await request(page, `/teams/${teamId}/years/2026/memos`, {
    id: memoId,
    title: "전환 전에 저장할 메모",
  });
  await page.reload();
  await chooseWeek(page, "2026-01-12");
  const memos = page.getByRole("region", {
    name: "연간 업무 메모 목록",
    exact: true,
  });
  await memos.locator(".toggle-memos").click();
  await memos
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = memos.getByRole("textbox", {
    name: "연간 업무 메모 Markdown 원문",
    exact: true,
  });
  await page.route(`**/api${memoPath}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "기간 전환 저장 실패" } })
      : route.continue(),
  );
  await source.fill("# 날짜 전환 전에 보존할 입력");
  await toggle.click();
  await expect(memos.getByRole("alert")).toContainText("기간 전환 저장 실패");
  await expect(page).toHaveURL(/\/$/);
  await expect(source).toHaveValue("# 날짜 전환 전에 보존할 입력");
  await expect(
    page.locator('.period-week[data-week="2026-01-12"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.unroute(`**/api${memoPath}`);
  await memos
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await expect(memos.getByRole("alert")).toHaveCount(0);
  await openInsights(page);
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("1");
  expect((await request(page, memoPath)).markdown).toBe(
    "# 날짜 전환 전에 보존할 입력",
  );
});

test("사본 저장·뒤로가기와 보고서 설정 저장의 기존 guard를 거쳐 원본 날짜로 복귀한다", async ({
  page,
}) => {
  const savedView = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/views") &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await chooseWeek(page, "2026-01-12");
  await savedView;
  const copy = await request(page, "/sheet-clones", {
    teamId,
    year: 2026,
    name: "다른 날짜 사본",
    referenceDate: "2026-02-01",
    view: { ...defaultView(2026), fromMonth: 2, toMonth: 2 },
    taskIds,
  });
  await page.reload();
  await openInsights(page);
  await page.locator(".page-heading .insights-toggle").click();
  await page.getByRole("tab", { name: "다른 날짜 사본", exact: true }).click();
  await expect(
    page.locator('.period-month[data-year="2026"][data-month="2"]'),
  ).toHaveAttribute("aria-pressed", "true");
  let release!: () => void;
  let pending = false;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(`**/api/sheet-clones/${copy.id}*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    pending = true;
    await held;
    await route.fulfill({ response });
  });
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).dblclick();
  const input = page
    .locator(".inline-editor textarea,.inline-editor input")
    .first();
  await input.fill("사본에서만 변경");
  await input.press("Enter");
  await expect(page.locator(".page-heading .insights-toggle")).toBeDisabled();
  await expect.poll(() => pending).toBeTruthy();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "다른 날짜 사본", exact: true }),
  ).toBeVisible();
  release();
  await expect(page.locator(".sheet-save-status")).toHaveText("저장됨");
  await openInsights(page);
  await expect(
    page.locator('.period-week[data-week="2026-01-12"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  expect(
    (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks.find(
      (t: any) => t.id === taskIds[0],
    ).cells.title.value,
  ).toBe("공유 범위 업무 1");
  let releaseSettings!: () => void;
  const heldSettings = new Promise<void>((r) => {
    releaseSettings = r;
  });
  let saving = false;
  await page.route(`**/api/teams/${teamId}/settings`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    saving = true;
    await heldSettings;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "인사이트 설정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "인사이트 설정",
    exact: true,
  });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => saving).toBeTruthy();
  await expect(page.locator(".page-heading .insights-toggle")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "다음 연도", exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator('.period-week[data-week="2026-01-12"]'),
  ).toBeDisabled();
  releaseSettings();
  await expect(
    page.locator('.period-week[data-week="2026-01-12"]'),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    page.locator('.period-week[data-week="2026-01-12"]'),
  ).toHaveAttribute("aria-pressed", "true");
});

test("날짜 오른쪽의 범위·설정 버튼은 한 줄을 유지하고 좁은 화면의 날짜 스크롤·키보드·팝업을 사용할 수 있다", async ({
  page,
  browserName,
}, info) => {
  await openInsights(page);
  const dates = page.locator(".insights-board .date-controls");
  const range = page.getByRole("button", { name: "속성 필터", exact: true });
  const settings = page.getByRole("button", {
    name: "인사이트 설정",
    exact: true,
  });
  // WebKit's default keyboard mode skips native buttons with plain Tab.
  const forwardTab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (const width of [1366, 700, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const dateBox = (await dates.boundingBox())!;
    const rangeBox = (await range.boundingBox())!;
    const settingsBox = (await settings.boundingBox())!;
    await info.attach(`date-actions-geometry-${width}`, {
      body: JSON.stringify({
        width,
        dates: dateBox,
        range: rangeBox,
        settings: settingsBox,
      }),
      contentType: "application/json",
    });
    expect(
      Math.abs(
        dateBox.y + dateBox.height / 2 - rangeBox.y - rangeBox.height / 2,
      ),
    ).toBeLessThan(2);
    expect(
      Math.abs(
        rangeBox.y +
          rangeBox.height / 2 -
          settingsBox.y -
          settingsBox.height / 2,
      ),
    ).toBeLessThan(2);
    expect(rangeBox.x).toBeGreaterThanOrEqual(dateBox.x + dateBox.width + 3);
    expect(settingsBox.x).toBeGreaterThanOrEqual(
      rangeBox.x + rangeBox.width + 3,
    );
    expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(width - 4);
    expect(dateBox.width).toBeGreaterThan(100);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await expect(
      page.locator(".insights-page > .insights-controls"),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".insights-board .view-controls")
        .getByRole("button", { name: "속성 필터", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`date-actions-${width}.png`),
    });
    if (width > 390) continue;
    const scroll = await dates.evaluate((el) => ({
      width: el.clientWidth,
      content: el.scrollWidth,
    }));
    expect(scroll.content).toBeGreaterThan(scroll.width);
    await selectMonths(page, 2026, 1);
    await expect(card(page, "작업 주 합").locator("strong")).toHaveText("3");
    const nextMonth = page.getByRole("button", {
      name: "다음 달로 이동",
      exact: true,
    });
    await expect(nextMonth).toBeEnabled();
    await nextMonth.focus();
    await expect(nextMonth).toBeFocused();
    await expect
      .poll(() => dates.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await page.keyboard.press(forwardTab);
    await expect(range).toBeFocused();
    await range.press("Enter");
    const popup = page.getByRole("dialog", { name: "속성 필터", exact: true });
    await expect(popup).toBeVisible();
    await popup.locator("summary").filter({ hasText: "제품 성격" }).click();
    const choice = popup.getByRole("checkbox", {
      name: "새 시도",
      exact: true,
    });
    await choice.check();
    await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: info.outputPath(`date-actions-filter-${width}.png`),
    });
    await choice.uncheck();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(range).toBeFocused();
    await page.keyboard.press(forwardTab);
    await expect(settings).toBeFocused();
    await settings.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "인사이트 설정",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(settings).toBeFocused();
  }
});

for (const initiallyAssigned of [false, true]) {
  test(`같은 Workspace의 팀 ${initiallyAssigned ? "해제→재배정" : "첫 배정→해제→재배정"}은 실제 구성원 저장과 bootstrap 뒤에도 훅·설정 상태를 유지한다`, async ({
    page,
    browser,
  }, info) => {
    const suffix = randomUUID().slice(0, 8);
    const name = `배정 점검 ${suffix}`;
    const targetName = `새 배정 팀 ${suffix}`;
    const targetId = (
      await request(page, "/admin/teams", {
        name: targetName,
        members: [{ userId, role: "lead" }],
      })
    ).id;
    const username = `assignment-${suffix}@example.test`;
    const { user: freshUser } = await request(page, "/admin/users", {
      username,
      name,
      password: "test-password-123",
      systemRole: "user",
      memberships: initiallyAssigned
        ? [{ teamId: targetId, role: "lead" }]
        : [],
    });
    const adminContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
    });
    const admin = await adminContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    admin.on("pageerror", (error) => errors.push(`admin: ${error.message}`));
    try {
      await request(admin, "/auth/login", {
        username: "test@somansa.com",
        password: "1234",
      });
      await admin.addInitScript(
        ({ userId, targetId }) =>
          localStorage.setItem(
            `weekly-board:${userId}`,
            JSON.stringify({ teamId: targetId, year: 2026 }),
          ),
        { userId, targetId },
      );
      await admin.goto("/");
      await admin.getByRole("button", { name: "설정", exact: true }).click();
      const adminSettings = admin.getByRole("dialog", {
        name: "설정",
        exact: true,
      });
      await adminSettings
        .locator(".settings-nav")
        .getByRole("button", { name: new RegExp(targetName) })
        .click();
      await adminSettings
        .getByRole("tab", { name: "구성원", exact: true })
        .click();

      await request(page, "/auth/login", {
        username,
        password: "test-password-123",
      });
      await page.addInitScript(
        ({ id, targetId }) =>
          localStorage.setItem(
            `weekly-board:${id}`,
            JSON.stringify({ teamId: targetId, year: 2026 }),
          ),
        { id: freshUser.id, targetId },
      );
      // This is the fresh user's initial mount. All membership transitions below
      // use the real settings API and existing window-focus bootstrap listener.
      await page.goto(initiallyAssigned ? "/insights" : "/");
      const marker = randomUUID();
      await page.evaluate((value) => {
        (window as any).membershipDocument = value;
      }, marker);
      const navigations: string[] = [];
      const emptyFilterScopes: string[] = [];
      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        )
          navigations.push(request.url());
        const url = new URL(request.url());
        if (url.pathname === "/api/filters" && !url.searchParams.get("teamId"))
          emptyFilterScopes.push(request.url());
      });
      let bootstrapResponses = 0;
      page.on("response", (response) => {
        if (
          new URL(response.url()).pathname === "/api/bootstrap" &&
          response.status() === 200
        )
          bootstrapResponses++;
      });
      const empty = page.getByText("참여한 팀이 없습니다", { exact: true });
      async function state(assigned: boolean) {
        await expect
          .poll(async () => ({
            errors: [...errors],
            empty: await empty.count(),
            board: await page.locator(".page-heading h1").count(),
          }))
          .toEqual({
            errors: [],
            empty: assigned ? 0 : 1,
            board: assigned ? 1 : 0,
          });
        expect(
          await page.evaluate(() => (window as any).membershipDocument),
        ).toBe(marker);
        expect(navigations).toEqual([]);
        expect(emptyFilterScopes).toEqual([]);
        const boot = await request(page, "/bootstrap");
        expect(boot.user.id).toBe(freshUser.id);
        expect(boot.teams.map((team: any) => team.id)).toEqual(
          assigned ? [targetId] : [],
        );
      }
      async function membership(assigned: boolean) {
        await admin.bringToFront();
        if (assigned) {
          const candidate = adminSettings.getByRole("combobox", {
            name: "추가할 사용자",
            exact: true,
          });
          await expect(candidate).toBeEnabled();
          await candidate.selectOption(freshUser.id);
          await adminSettings
            .getByRole("combobox", {
              name: "추가할 사용자의 팀 내 권한",
              exact: true,
            })
            .selectOption("lead");
          await adminSettings
            .getByRole("button", { name: "추가", exact: true })
            .click();
        } else {
          admin.once("dialog", (dialog) => dialog.accept());
          await adminSettings
            .getByRole("button", { name: `${name} 팀에서 제외`, exact: true })
            .click();
        }
        await expect
          .poll(async () =>
            (await request(admin, `/teams/${targetId}/members`)).members.some(
              (member: any) => member.userId === freshUser.id,
            ),
          )
          .toBe(assigned);
        const before = bootstrapResponses;
        await page.bringToFront();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await state(assigned);
        await expect.poll(() => bootstrapResponses).toBeGreaterThan(before);
      }
      await state(initiallyAssigned);
      if (!initiallyAssigned) {
        await membership(true);
        await openInsights(page);
      }
      await expect(
        page.getByRole("region", { name: "인사이트", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "설정", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "설정", exact: true });
      await expect(settings).toBeVisible();
      await membership(false);
      await expect(settings).toBeVisible();
      await membership(true);
      // panel is transient Workspace state: a remount would lose the open setting.
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "닫기", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "인사이트", exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath("membership-restored.png"),
      });
    } finally {
      await info.attach("membership-page-errors", {
        body: JSON.stringify(errors),
        contentType: "application/json",
      });
      await adminContext.close();
    }
  });
}

test(
  "연간·인사이트는 같은 원본 조회·구독을 유지하고 화면 전환·폴링·설정 변경·캘린더 정리를 중복 없이 처리한다",
  { tag: "@source-owner" },
  async ({ page }) => {
    const traffic = sourceTraffic!;
    const requests = traffic.requests;
    const active = async () =>
      (await (await page.request.get("/__test/streams")).json()).flatMap(
        (connection: any) => connection.streams,
      );
    const cells = async () =>
      (await active()).filter((stream: any) =>
        stream.path.startsWith("/api/cells/events?"),
      );
    await expect.poll(async () => (await cells()).length).toBe(1);
    // The shared resource stream sends its initial snapshot as subscriptions
    // join. Drain those startup invalidations before measuring route changes.
    await page.clock.pauseAt(
      new Date(await page.evaluate(() => Date.now() + 1000)),
    );
    await page.clock.runFor(1000);
    await expect.poll(() => traffic.responses).toBe(requests.length);
    const baseline = requests.length;
    expect(baseline).toBeGreaterThan(0);
    await page.clock.resume();
    const initialPaths = (await active())
      .map((stream: any) => stream.path)
      .sort();
    const identity = randomUUID();
    await page.evaluate((value) => {
      (window as any).insightsOwnerDocument = value;
    }, identity);
    for (let i = 0; i < 3; i++) {
      await openInsights(page);
      await expect(card(page, "작업 주 합").locator("strong")).toHaveText("4");
      await page
        .locator(".page-heading")
        .getByRole("button", { name: "인사이트", exact: true })
        .click();
      await expect(
        page.locator(`[data-cell="${taskIds[0]}:title"]`),
      ).toBeVisible();
    }
    expect(requests).toHaveLength(baseline);
    expect((await active()).map((stream: any) => stream.path).sort()).toEqual(
      initialPaths,
    );
    await openInsights(page);
    const current = (await request(page, "/bootstrap")).teams.find(
      (team: any) => team.id === teamId,
    ).settings;
    await request(
      page,
      `/teams/${teamId}/settings`,
      { revision: current.revision, defaultDensity: "dense" },
      "PATCH",
    );
    await expect.poll(() => traffic.responses).toBe(baseline + 1);
    expect(requests).toHaveLength(baseline + 1);
    await page.clock.pauseAt(
      new Date(await page.evaluate(() => Date.now() + 1000)),
    );
    await page.clock.runFor(7000);
    await expect.poll(() => traffic.responses).toBe(baseline + 2);
    expect(requests).toHaveLength(baseline + 2);
    await page
      .getByRole("button", { name: "캘린더", exact: true })
      .press("Enter");
    await page.clock.runFor(100);
    await expect(
      page.getByRole("region", { name: "캘린더", exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await cells()).length).toBe(0);
    const inactive = requests.length;
    await page.clock.runFor(15000);
    expect(requests).toHaveLength(inactive);
    await page.clock.resume();
    await page
      .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
      .click();
    await expect(
      page.locator(`[data-cell="${taskIds[0]}:title"]`),
    ).toBeVisible();
    await openInsights(page);
    await expect(card(page, "작업 주 합").locator("strong")).toHaveText("4");
    await expect.poll(async () => (await cells()).length).toBe(1);
    expect(
      await page.evaluate(() => (window as any).insightsOwnerDocument),
    ).toBe(identity);
  },
);

test("원본 조회의 늦은 bootstrap은 보고서 차트 저장 뒤 최신 팀 설정과 원본 헤더를 덮어쓰지 않는다", async ({
  page,
}) => {
  await openInsights(page);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("3");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const waiting = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let hold = true;
  await page.route("**/api/bootstrap", async (route) => {
    if (!hold) return route.continue();
    hold = false;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await request(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "원본 소유자 추가 업무", owner: userId },
    });
    await waiting;
    await page.getByRole("button", { name: "차트 추가", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
    await editor
      .getByRole("textbox", { name: "차트 제목", exact: true })
      .fill("저장 뒤 유지되는 차트");
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(card(page, "저장 뒤 유지되는 차트")).toBeVisible();
    release();
    await expect(
      page.locator(".board-summary > span").first().locator("strong"),
    ).toHaveText("4");
    await expect(card(page, "업무 수").locator("strong")).toHaveText("3");
    await expect(card(page, "저장 뒤 유지되는 차트")).toBeVisible();
    const stored = (await request(page, "/bootstrap")).teams.find(
      (team: any) => team.id === teamId,
    ).settings;
    expect(stored.insights.charts.map((chart: any) => chart.title)).toEqual([
      "저장 뒤 유지되는 차트",
    ]);
  } finally {
    release();
  }
});
