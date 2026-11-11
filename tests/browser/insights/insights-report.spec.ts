import { selectMonths } from "../support/annual-period";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function api(
  page: Page,
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const r = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data ? { data } : {}),
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return unpack(await r.json());
}
const savedCharts = [
  {
    id: "cshort1",
    title: "짧은 카드 A",
    type: "number",
    dimensions: {},
    values: [{ kind: "count" }],
  },
  {
    id: "cmonth1",
    title: "월 카드 B",
    type: "bar",
    dimensions: { axis: { kind: "time", unit: "month", basis: "work" } },
    values: [{ kind: "workWeeks" }],
  },
  {
    id: "cmatri1",
    title: "전체 폭 표 C",
    type: "table",
    dimensions: {
      row: { kind: "owner" },
      column: { kind: "property", propertyId: "category" },
    },
    values: [{ kind: "count" }],
  },
  {
    id: "cradar1",
    title: "레이더 D",
    type: "radar",
    dimensions: {
      axis: { kind: "property", propertyId: "category" },
      series: { kind: "owner" },
    },
    values: [{ kind: "count" }],
  },
  {
    id: "cshort2",
    title: "짧은 카드 E",
    type: "number",
    dimensions: {},
    values: [{ kind: "workWeeks" }],
  },
  {
    id: "ctasks1",
    title: "전체 폭 목록 F",
    type: "top",
    dimensions: {},
    values: [{ kind: "count" }],
    sort: { kind: "duration" },
    limit: 5,
  },
];
let teamId: string, users: { id: string; name: string }[], taskIds: string[];
const source = [
  {
    owner: 0,
    category: 0,
    weeks: ["2026-01-05", "2026-01-12"],
    deadline: "2026-01-05",
  },
  {
    owner: 0,
    category: 0,
    weeks: ["2026-01-26", "2026-02-02"],
    deadline: "2026-02-06",
  },
  { owner: 0, category: 1, weeks: ["2026-03-02"], deadline: "" },
  {
    owner: 0,
    category: 2,
    weeks: [
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
      "2026-02-02",
    ],
    deadline: "2026-02-06",
  },
  {
    owner: 1,
    category: 1,
    weeks: ["2026-02-09", "2026-02-16"],
    deadline: "2026-02-09",
  },
  { owner: 1, category: 3, weeks: ["2026-01-19"], deadline: "2026-01-23" },
  { owner: 1, category: 4, weeks: ["2026-03-09"], deadline: "2026-03-09" },
  { owner: 2, category: 0, weeks: ["2026-01-05"], deadline: "" },
  { owner: 2, category: 1, weeks: ["2026-02-02"], deadline: "2026-02-06" },
  { owner: 3, category: 2, weeks: ["2026-01-12"], deadline: "" },
  { owner: 4, category: 3, weeks: ["2026-02-02"], deadline: "" },
  { owner: 5, category: 4, weeks: ["2026-03-02"], deadline: "" },
];
async function stored(page: Page) {
  return (await api(page, "/bootstrap")).teams.find((t: any) => t.id === teamId)
    .settings;
}
function card(page: Page, title: string) {
  return page
    .locator(".insights-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
test.beforeEach(async ({ page }) => {
  await api(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await api(page, "/bootstrap");
  teamId = (
    await api(page, "/admin/teams", {
      name: `보고서 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  users = [boot.user];
  for (let i = 1; i < 6; i++) {
    const { user } = await api(page, "/admin/users", {
      username: `report-${randomUUID().slice(0, 8)}@example.test`,
      name: `책임자 ${i + 1}`,
      password: "test-password-123",
      systemRole: "user",
      memberships: [{ teamId, role: "member" }],
    });
    users.push(user);
  }
  const current = await stored(page);
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      properties: [
        ...current.properties,
        {
          id: "category",
          name: "분류",
          kind: "option",
          display: "text",
          values: ["UX 개선", "차별화", "기획", "개발", "운영"].map(
            (label, i) => ({
              id: `v${i}`,
              label,
              backgroundColor: "#edf6f4",
              dotColor: "#177b70",
              emoji: "",
            }),
          ),
        },
        {
          id: "deadline",
          name: "목표일",
          kind: "date",
          display: "text",
          values: [],
        },
      ],
      insights: {
        workColors: [{ color: "#0066cc", name: "업무" }],
        deadlinePropertyId: "deadline",
        charts: savedCharts,
      },
    },
    "PATCH",
  );
  taskIds = [];
  for (const [i, item] of source.entries()) {
    const { task } = await api(page, "/tasks", {
      teamId,
      year: 2026,
      fields: {
        title: `분석 업무 ${i + 1}`,
        owner: users[item.owner].id,
        category: `v${item.category}`,
        deadline: item.deadline,
      },
    });
    taskIds.push(task.id);
  }
  await api(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: source.flatMap((item, i) =>
      item.weeks.map((key) => ({
        taskId: taskIds[i],
        key,
        style: { backgroundColor: "#0066cc", work: true },
        expectedVersion: 0,
        expectedFormatRevision: 0,
      })),
    ),
  });
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId: boot.user.id, teamId },
  );
  await page.clock.setFixedTime(new Date("2026-02-10T03:00:00Z"));
  await page.goto("/insights");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("12");
});

test("보고서 정렬: 통계·한 값/여러 값 매트릭스·업무 목록의 숫자 머리글과 셀 끝을 맞춘다", async ({
  page,
}, info) => {
  for (const title of ["책임자별 통계", "선택형 속성별 통계"]) {
    const table = card(page, title).locator("table");
    await expect(table.locator("thead th").nth(1)).toHaveCSS(
      "text-align",
      "right",
    );
    await expect(table.locator("tbody td").first()).toHaveCSS(
      "text-align",
      "right",
    );
    await expect(table.locator("thead th").first()).toHaveCSS(
      "text-align",
      "left",
    );
  }
  const one = card(page, "전체 폭 표 C");
  await expect(one.locator("thead th").nth(1)).toHaveCSS("text-align", "right");
  const list = card(page, "전체 폭 목록 F").locator("table");
  await expect(list.locator("thead th").nth(1)).toHaveCSS("text-align", "left");
  await expect(list.locator("tbody td").nth(0)).toHaveCSS("text-align", "left");
  await expect(list.locator("thead th").nth(2)).toHaveCSS(
    "text-align",
    "right",
  );
  await expect(list.locator("thead th").nth(4)).toHaveCSS("text-align", "left");
  await expect(list.locator("tbody td").nth(3)).toHaveCSS("text-align", "left");
  const current = await stored(page);
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      insights: {
        ...current.insights,
        charts: current.insights.charts.map((c: any) =>
          c.id === "cmatri1"
            ? {
                ...c,
                values: [
                  { kind: "count" },
                  { kind: "workWeeks" },
                  { kind: "avgDuration" },
                  { kind: "delayRate" },
                ],
              }
            : c,
        ),
      },
    },
    "PATCH",
  );
  await expect(one.locator("thead tr").nth(1).locator("th").first()).toHaveCSS(
    "text-align",
    "right",
  );
  await one.screenshot({ path: info.outputPath("four-value-alignment.png") });
});

test("기본 분석: 월별 0·작업 주, 선택한 책임자의 분류 비율 레이더, 전체 기간 분포와 목표일 현황을 저장 없이 제공한다", async ({
  page,
}, info) => {
  const before = await stored(page);
  const monthly = card(page, "월별 작업량"),
    radar = card(page, "책임자별 업무 비중"),
    duration = card(page, "업무 기간 분포"),
    deadline = card(page, "목표일 준수 현황");
  await expect(monthly.locator("svg.insights-bars")).toBeVisible();
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-01 · 전체: 10", exact: true }),
  ).toBeVisible();
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-02 · 전체: 6", exact: true }),
  ).toBeVisible();
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-04 · 전체: 0", exact: true }),
  ).toHaveCount(1);
  await expect(radar.locator("svg.insights-radar")).toBeVisible();
  await expect(radar.getByText(/선택한 책임자 3명/)).toBeVisible();
  for (const user of users.slice(0, 3))
    await expect(
      radar.locator(".insights-legend").getByText(user.name, { exact: true }),
    ).toBeVisible();
  await expect(radar.locator(".insights-legend li")).toHaveCount(3);
  await expect(
    radar.locator("svg").getByRole("button", {
      name: `UX 개선 · ${users[0].name}: 50%`,
      exact: true,
    }),
  ).toBeVisible();
  await radar
    .locator("svg")
    .getByRole("button", {
      name: `차별화 · ${users[0].name}: 25%`,
      exact: true,
    })
    .press("Enter");
  const drill = page.getByRole("dialog", {
    name: "책임자별 업무 비중 · 업무 목록",
    exact: true,
  });
  await expect(drill.locator("tbody tr")).toHaveCount(1);
  await expect(
    drill.getByRole("button", { name: "분석 업무 3", exact: true }),
  ).toBeVisible();
  await drill.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(
    duration
      .locator("svg")
      .getByRole("button", { name: "5~8주 · 전체: 1", exact: true }),
  ).toBeVisible();
  await expect(
    deadline
      .locator("svg")
      .getByRole("button", { name: "목표일 없음 · 전체: 5", exact: true }),
  ).toBeVisible();
  expect(await stored(page)).toEqual(before);
  await page.screenshot({
    path: info.outputPath("default-report-desktop.png"),
  });
});

async function beginDrag(page: Page, sourceId: string, x: number, y: number) {
  const handle = page.locator(
    `[data-reorder-id="${sourceId}"] .list-drag-handle`,
  );
  await handle.scrollIntoViewIfNeeded();
  await handle.evaluate((element) =>
    element.addEventListener(
      "pointerdown",
      (event) =>
        element.setAttribute("data-test-pointer", String(event.pointerId)),
      { once: true },
    ),
  );
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
}

test("차트 격자 정렬: 같은 높이의 가로 드래그도 슬롯을 보이고 저장 후 그 위치와 순서가 일치한다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1404, height: 1200 });
  const a = page.locator('[data-reorder-id="cshort1"]'),
    b = page.locator('[data-reorder-id="cmonth1"]');
  await a.locator(".list-drag-handle").scrollIntoViewIfNeeded();
  const handle = (await a.locator(".list-drag-handle").boundingBox())!,
    target = (await b.boundingBox())!;
  const patch: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/teams/${teamId}/settings`))
      patch.push(r.postData() || "");
  });
  await beginDrag(
    page,
    "cshort1",
    target.x + target.width - 20,
    handle.y + handle.height / 2,
  );
  const slot = page.locator(".insights-chart-drop-slot");
  await expect(slot).toBeVisible();
  await expect(slot).toHaveAttribute("data-reorder-preview-id", "cshort1");
  await expect(slot).toHaveAttribute("data-reorder-preview-index", "1");
  await expect(slot).toHaveCSS("pointer-events", "none");
  await expect(slot).toHaveCSS("border-top-style", "dashed");
  const tint = await b.evaluate(
    (element) => getComputedStyle(element, "::after").backgroundColor,
  );
  expect(tint).not.toBe("rgba(0, 0, 0, 0)");
  expect(tint).not.toBe("transparent");
  expect(patch).toHaveLength(0);
  const landing = (await slot.boundingBox())!;
  await page.screenshot({ path: info.outputPath("same-row-drag-preview.png") });
  await page.mouse.up();
  const order = [
    "cmonth1",
    "cshort1",
    "cmatri1",
    "cradar1",
    "cshort2",
    "ctasks1",
  ];
  await expect
    .poll(async () =>
      (await stored(page)).insights.charts.map((c: any) => c.id),
    )
    .toEqual(order);
  // Persistence can finish before the app's follow-up bootstrap renders.
  await expect
    .poll(() =>
      page
        .locator(".insights-team-chart-grid > [data-reorder-id]")
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-reorder-id")),
        ),
    )
    .toEqual(order);
  await expect(slot).toHaveCount(0);
  await expect(a).toHaveCSS("opacity", "1");
  const actual = (await a.boundingBox())!;
  expect(Math.abs(actual.x - landing.x)).toBeLessThan(2);
  expect(Math.abs(actual.y - landing.y)).toBeLessThan(2);
  expect(Math.abs(actual.width - landing.width)).toBeLessThan(2);
  expect(patch).toHaveLength(1);
});

test("레이더 선택은 실시간 갱신에도 유지하고 모든 기본 차트는 기간·PropertyFilter와 같은 원자료를 쓴다", async ({
  page,
}) => {
  const original = await stored(page);
  const radar = card(page, "책임자별 업무 비중"),
    monthly = card(page, "월별 작업량"),
    duration = card(page, "업무 기간 분포"),
    deadline = card(page, "목표일 준수 현황");
  const select = radar.locator(".insights-people-selection");
  await select.locator("summary").click();
  const picker = select.getByRole("group", {
    name: /필터 선택$/,
    exact: true,
  });
  await picker
    .getByRole("checkbox", { name: users[0].name, exact: true })
    .uncheck();
  await picker
    .getByRole("checkbox", { name: users[2].name, exact: true })
    .uncheck();
  await picker
    .getByRole("checkbox", { name: users[5].name, exact: true })
    .check();
  await select.locator("summary").click();
  const changes = [];
  for (let i = 0; i < 6; i++) {
    const { task } = await api(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: `갱신된 운영 ${i}`, owner: users[5].id, category: "v4" },
    });
    changes.push({
      taskId: task.id,
      key: "2026-01-05",
      style: { backgroundColor: "#0066cc", work: true },
      expectedVersion: 0,
      expectedFormatRevision: 0,
    });
  }
  await api(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes,
  });
  await expect(card(page, "업무 수").locator("strong")).toHaveText("18");
  await expect(radar.locator(".insights-legend li")).toHaveText([
    users[1].name,
    users[5].name,
  ]);
  await expect(
    radar.locator("svg").getByRole("button", {
      name: `운영 · ${users[5].name}: 100%`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-01 · 전체: 16", exact: true }),
  ).toBeVisible();
  await selectMonths(page, 2026, 2);
  await expect(monthly.locator("svg [role=button]")).toHaveCount(1);
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-02 · 전체: 6", exact: true }),
  ).toBeVisible();
  await expect(radar.locator(".insights-legend li")).toHaveText([
    users[1].name,
    users[5].name,
  ]);
  await expect(
    radar.locator("svg").getByRole("button", {
      name: `운영 · ${users[5].name}: 0%`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    duration
      .locator("svg")
      .getByRole("button", { name: "5~8주 · 전체: 1", exact: true }),
  ).toBeVisible();
  await expect(
    deadline
      .locator("svg")
      .getByRole("button", { name: "목표일 없음 · 전체: 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "범위 필터", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "범위 필터", exact: true });
  await popup.locator("summary").filter({ hasText: "분류" }).click();
  await popup.getByRole("checkbox", { name: "차별화", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(
    monthly
      .locator("svg")
      .getByRole("button", { name: "2026-02 · 전체: 3", exact: true }),
  ).toBeVisible();
  await expect(
    radar.locator("svg").getByRole("button", {
      name: `차별화 · ${users[1].name}: 100%`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    duration
      .locator("svg")
      .getByRole("button", { name: "5~8주 · 전체: 0", exact: true }),
  ).toHaveCount(1);
  await expect(
    deadline
      .locator("svg")
      .getByRole("button", { name: "목표일 없음 · 전체: 0", exact: true }),
  ).toHaveCount(1);
  await radar
    .getByRole("combobox", { name: "비중 비교 속성" })
    .selectOption("status");
  await expect(
    radar.locator("svg").getByRole("button", {
      name: `미지정 · ${users[1].name}: 100%`,
      exact: true,
    }),
  ).toBeVisible();
  expect(await stored(page)).toEqual(original);
});

test("기본 레이더는 실제 축/사람 한도 밖에서 표로 대체하고 빠른 시작은 기존 radar 필드로 저장한다", async ({
  page,
}, info) => {
  const original = await stored(page),
    radar = card(page, "책임자별 업무 비중");
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: original.revision,
      properties: [
        ...original.properties,
        {
          id: "tiny",
          name: "작은 분류",
          kind: "option",
          display: "text",
          values: ["유형 1", "유형 2"].map((label, i) => ({
            id: `v${i}`,
            label,
            dotColor: "#177b70",
            backgroundColor: "#edf6f4",
            emoji: "",
          })),
        },
        {
          id: "wide",
          name: "많은 분류",
          kind: "option",
          display: "text",
          values: [
            ...Array.from({ length: 14 }, (_, i) => ({
              id: `v${i}`,
              label: i === 13 ? "옛 분류" : `분류 ${i + 1}`,
              archived: false,
              dotColor: "#177b70",
              backgroundColor: "#edf6f4",
              emoji: "",
            })),
            {
              id: "missing",
              label: "제거 예정",
              dotColor: "#177b70",
              backgroundColor: "#edf6f4",
              emoji: "",
            },
          ],
        },
      ],
    },
    "PATCH",
  );
  await api(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: taskIds.flatMap((taskId, i) => [
      { taskId, key: "tiny", value: `v${i % 2}`, expectedVersion: 0 },
      {
        taskId,
        key: "wide",
        value: i === 0 ? "missing" : i === 1 ? "v13" : `v${i}`,
        expectedVersion: 0,
      },
    ]),
  });
  const configured = await stored(page);
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: configured.revision,
      properties: configured.properties.map((property: any) =>
        property.id === "wide"
          ? {
              ...property,
              values: property.values
                .filter((v: any) => v.id !== "missing")
                .map((v: any) =>
                  v.id === "v13" ? { ...v, archived: true } : v,
                ),
            }
          : property,
      ),
    },
    "PATCH",
  );
  await radar
    .getByRole("combobox", { name: "비중 비교 속성" })
    .selectOption("tiny");
  await expect(
    radar.getByText("분류 축이 3~12개가 아니어서 표로 비교합니다."),
  ).toBeVisible();
  await expect(radar.locator("svg")).toHaveCount(0);
  await expect(
    radar.getByRole("button", {
      name: `유형 1 · ${users[0].name} · 업무 수: 50%`,
      exact: true,
    }),
  ).toBeVisible();
  await radar
    .getByRole("combobox", { name: "비중 비교 속성" })
    .selectOption("wide");
  await expect(radar.locator("svg")).toHaveCount(0);
  await expect(
    radar.getByRole("rowheader", { name: "보관된 값: 옛 분류", exact: true }),
  ).toBeVisible();
  await expect(
    radar.getByRole("rowheader", { name: "보관된 값: 제거 예정", exact: true }),
  ).toBeVisible();
  await radar.screenshot({
    path: info.outputPath("radar-real-axis-fallback.png"),
  });
  await radar
    .getByRole("combobox", { name: "비중 비교 속성" })
    .selectOption("category");
  const extra = [];
  for (let i = 0; i < 3; i++) {
    const { user } = await api(page, "/admin/users", {
      username: `more-${randomUUID().slice(0, 8)}@example.test`,
      name: `추가 책임자 ${i}`,
      password: "test-password-123",
      systemRole: "user",
      memberships: [{ teamId, role: "member" }],
    });
    const { task } = await api(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: `추가 분석 ${i}`, owner: user.id, category: "v4" },
    });
    extra.push({
      taskId: task.id,
      key: "2026-01-05",
      style: { backgroundColor: "#0066cc", work: true },
      expectedVersion: 0,
      expectedFormatRevision: 0,
    });
  }
  await api(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: extra,
  });
  await expect(card(page, "업무 수").locator("strong")).toHaveText("15");
  const selection = radar.locator(".insights-people-selection");
  await selection.locator("summary").click();
  await selection.getByRole("button", { name: /필터 해제$/ }).click();
  await selection.locator("summary").click();
  await expect(
    radar.getByText(/책임자가 8명을 넘어 표로 비교합니다/),
  ).toBeVisible();
  await expect(radar.getByText(/선택한 책임자 9명/)).toBeVisible();
  await expect(radar.locator("svg")).toHaveCount(0);
  await page.getByRole("button", { name: "차트 추가", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
  await editor
    .getByRole("button", { name: "책임자별 업무 비중", exact: true })
    .click();
  await expect(editor.getByRole("combobox", { name: "차트 종류" })).toHaveValue(
    "radar",
  );
  await expect(editor.locator("svg.insights-radar")).toBeVisible();
  await editor
    .getByRole("textbox", { name: "차트 제목" })
    .fill("책임자 비중 저장");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload();
  const current = await stored(page);
  expect(current.insights.charts.slice(0, 6)).toEqual(original.insights.charts);
  const saved = current.insights.charts[6];
  expect(saved).toMatchObject({
    type: "radar",
    dimensions: {
      axis: { kind: "property", propertyId: "category" },
      series: { kind: "owner" },
    },
    values: [{ kind: "count" }],
    display: { percent: "series" },
    filter: {
      propertyFilters: { owner: users.slice(0, 3).map((user) => user.id) },
    },
  });
  expect(current.insights.workColors).toEqual(original.insights.workColors);
  expect(current.insights.deadlinePropertyId).toEqual(
    original.insights.deadlinePropertyId,
  );
  await expect(
    card(page, "책임자 비중 저장").locator("svg.insights-radar"),
  ).toBeVisible();
});

async function dropAndCheck(
  page: Page,
  sourceId: string,
  destination: () => Promise<{ x: number; y: number }>,
  order: string[],
) {
  const moving = page.locator(`[data-reorder-id="${sourceId}"]`);
  await page.locator(".insights-page").evaluate((element) => {
    const grid = element.querySelector(".insights-team-chart-grid")!;
    element.scrollTop +=
      grid.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      60;
  });
  await moving.locator(".list-drag-handle").scrollIntoViewIfNeeded();
  await moving.locator(".list-drag-handle").hover();
  const point = await destination();
  expect(point.y).toBeGreaterThan(45);
  expect(point.y).toBeLessThan(page.viewportSize()!.height - 24);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 8 });
  const slot = page.locator(".insights-chart-drop-slot");
  await expect(slot).toHaveAttribute(
    "data-reorder-preview-order",
    order.join(","),
  );
  const preview = (await slot.boundingBox())!;
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await stored(page)).insights.charts.map((chart: any) => chart.id),
    )
    .toEqual(order);
  // Check the rendered order too: the app reads bootstrap after the PATCH.
  await expect
    .poll(() =>
      page
        .locator(".insights-team-chart-grid > [data-reorder-id]")
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-reorder-id")),
        ),
    )
    .toEqual(order);
  await expect(slot).toHaveCount(0);
  const actual = (await moving.boundingBox())!;
  expect(Math.abs(actual.x - preview.x)).toBeLessThan(2);
  expect(Math.abs(actual.y - preview.y)).toBeLessThan(2);
  expect(Math.abs(actual.width - preview.width)).toBeLessThan(2);
  expect(Math.abs(actual.height - preview.height)).toBeLessThan(2);
}

test("차트 격자 정렬: 높이가 다른 카드·전체 폭·빈 간격의 앞뒤 슬롯은 실제 row-major 배치와 같다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1404, height: 1800 });
  const current = async (id: string) =>
    (await page.locator(`[data-reorder-id="${id}"]`).boundingBox())!;
  await dropAndCheck(
    page,
    "cshort2",
    async () => {
      const c = await current("cmatri1");
      return { x: c.x + 30, y: c.y + 12 };
    },
    ["cshort1", "cmonth1", "cshort2", "cmatri1", "cradar1", "ctasks1"],
  );
  await dropAndCheck(
    page,
    "cmatri1",
    async () => {
      const a = await current("cshort1");
      return { x: a.x + 20, y: a.y + 20 };
    },
    ["cmatri1", "cshort1", "cmonth1", "cshort2", "cradar1", "ctasks1"],
  );
  await dropAndCheck(
    page,
    "cshort2",
    async () => {
      const c = await current("cmatri1"),
        b = await current("cmonth1");
      return { x: c.x + 40, y: (c.y + c.height + b.y) / 2 };
    },
    ["cmatri1", "cshort2", "cshort1", "cmonth1", "cradar1", "ctasks1"],
  );
  await page.screenshot({
    path: info.outputPath("mixed-width-chart-order.png"),
  });
});

test("차트 드래그 취소·밖 드롭·권한과 키보드는 저장 횟수·강조 초기화·기존 동작을 보존한다", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1404, height: 1200 });
  const original = (await stored(page)).insights.charts;
  let saves = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/teams/${teamId}/settings`))
      saves++;
  });
  const start = async () => {
    const a = page.locator('[data-reorder-id="cshort1"] .list-drag-handle');
    await a.scrollIntoViewIfNeeded();
    const b = (await page
        .locator('[data-reorder-id="cmonth1"]')
        .boundingBox())!,
      h = (await a.boundingBox())!;
    await beginDrag(page, "cshort1", b.x + b.width - 12, h.y + h.height / 2);
    await expect(page.locator(".insights-chart-drop-slot")).toBeVisible();
    await expect(page.locator(".insights-team-chart-grid")).toHaveAttribute(
      "data-reorder-grid-active",
      "true",
    );
  };
  await start();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await expect(page.locator('[data-reordering="true"]')).toHaveCount(0);
  await start();
  await page.mouse.move(5, 5);
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await page.mouse.up();
  await start();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await start();
  await page
    .locator('[data-reorder-id="cshort1"] .list-drag-handle')
    .evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: Number(element.getAttribute("data-test-pointer")),
          bubbles: true,
        }),
      );
    });
  await page.mouse.up();
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await start();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await page.mouse.up();
  await page.setViewportSize({ width: 1404, height: 1200 });
  const secondTeam = (
    await api(page, "/admin/teams", {
      name: `전환 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: users[0].id, role: "lead" }],
    })
  ).id;
  await page.reload();
  await expect(
    page.locator(`select[aria-label="팀 선택"] option[value="${secondTeam}"]`),
  ).toHaveCount(1);
  await start();
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(secondTeam);
  await page.mouse.up();
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await expect(page.locator('[data-reorder-id="cshort1"]')).toBeVisible();
  await start();
  await page.goto("/");
  await page.mouse.up();
  await page.goto("/insights");
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await expect(page.locator('[data-reorder-grid-active="true"]')).toHaveCount(
    0,
  );
  expect(saves).toBe(0);
  expect((await stored(page)).insights.charts).toEqual(original);
  const handle = page.locator('[data-reorder-id="cshort1"] .list-drag-handle');
  await handle.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(async () =>
      (await stored(page)).insights.charts.map((c: any) => c.id),
    )
    .toEqual([
      "cmonth1",
      "cshort1",
      "cmatri1",
      "cradar1",
      "cshort2",
      "ctasks1",
    ]);
  expect(saves).toBe(1);
  const username = `readonly-${randomUUID().slice(0, 8)}@example.test`;
  await api(page, "/admin/users", {
    username,
    name: "열람자",
    password: "test-password-123",
    systemRole: "user",
    memberships: [{ teamId, role: "viewer" }],
  });
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const other = await context.newPage();
    await api(other, "/auth/login", {
      username,
      password: "test-password-123",
    });
    await other.goto("/insights");
    await expect(
      other.getByRole("region", { name: "인사이트", exact: true }),
    ).toBeVisible();
    await expect(
      other.locator(".insights-team-chart-grid .list-drag-handle"),
    ).toHaveCount(0);
    await expect(
      other.getByRole("button", { name: "차트 미리보기", exact: true }),
    ).toBeVisible();
    await expect(other.locator(".insights-chart-drop-slot")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("드래그 중 다른 관리자가 변경하면 실제 revision CAS가 보호하고 미리보기와 강조를 정리한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1404, height: 1200 });
  const handle = page.locator('[data-reorder-id="cshort1"] .list-drag-handle');
  await handle.scrollIntoViewIfNeeded();
  const a = (await handle.boundingBox())!,
    b = (await page.locator('[data-reorder-id="cmonth1"]').boundingBox())!;
  await beginDrag(page, "cshort1", b.x + b.width - 10, a.y + a.height / 2);
  await expect(page.locator(".insights-chart-drop-slot")).toBeVisible();
  const current = await stored(page);
  const concurrent = current.insights.charts.map((c: any) =>
    c.id === "cshort1" ? { ...c, title: "다른 관리자의 제목" } : c,
  );
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      insights: { ...current.insights, charts: concurrent },
    },
    "PATCH",
  );
  await expect(card(page, "다른 관리자의 제목")).toBeVisible();
  const failed = page.waitForResponse(
    (r) => r.url().endsWith(`/teams/${teamId}/settings`) && r.status() === 409,
  );
  await page.mouse.up();
  await failed;
  await expect(
    page.getByText(/다른 관리자가 설정을 변경했습니다/),
  ).toBeVisible();
  await expect(page.locator(".insights-chart-drop-slot")).toHaveCount(0);
  await expect(page.locator('[data-reorder-grid-active="true"]')).toHaveCount(
    0,
  );
  expect((await stored(page)).insights.charts).toEqual(concurrent);
});

test("기본 보고서는 데스크톱·390·360px에서 읽을 수 있고 빈 기간에도 실제 기간·분류의 0만 보인다", async ({
  page,
}, info) => {
  const before = await stored(page);
  const radar = card(page, "책임자별 업무 비중"),
    monthly = card(page, "월별 작업량"),
    duration = card(page, "업무 기간 분포"),
    deadline = card(page, "목표일 준수 현황");
  for (const width of [1404, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [chart, name] of [
      [monthly, "monthly"],
      [radar, "radar"],
      [duration, "duration"],
      [deadline, "deadline"],
    ] as const) {
      await chart.scrollIntoViewIfNeeded();
      const box = (await chart.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (name === "radar") {
        await expect
          .poll(() =>
            radar
              .locator("svg")
              .evaluate((svg) =>
                Math.abs(
                  svg.viewBox.baseVal.width - svg.getBoundingClientRect().width,
                ),
              ),
          )
          .toBeLessThan(2);
        const labels = await radar
          .locator(".insights-radar-axis-label")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const b = node.getBoundingClientRect();
              return { left: b.left, right: b.right };
            }),
          );
        expect(labels).toHaveLength(5);
        for (const label of labels) {
          expect(label.left).toBeGreaterThanOrEqual(box.x + 4);
          expect(label.right).toBeLessThanOrEqual(box.x + box.width - 4);
        }
      }
      await chart.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
    }
  }
  await selectMonths(page, 2026, 4);
  await expect(monthly.locator("svg [role=button]")).toHaveCount(1);
  await expect(monthly.locator('[data-value="0"] rect')).toHaveAttribute(
    "height",
    "0",
  );
  await expect(radar.locator("svg")).toHaveCount(0);
  await expect(
    radar.getByText("선택 범위에 집계할 업무가 없습니다."),
  ).toBeVisible();
  await expect(duration.locator('[data-value="0"]')).toHaveCount(4);
  await expect(deadline.locator('[data-value="0"]')).toHaveCount(6);
  expect(await stored(page)).toEqual(before);
});

test("드래그 중 실시간 차트 높이가 바뀌면 실제 카드와 같은 크기의 도착 칸을 유지한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1404, height: 900 });
  await page.locator(".insights-page").evaluate((element) => {
    const grid = element.querySelector(".insights-team-chart-grid")!;
    element.scrollTop +=
      grid.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      80;
  });
  const moving = page.locator('[data-reorder-id="cmatri1"]');
  await moving.locator(".list-drag-handle").hover();
  const target = (await page
    .locator('[data-reorder-id="cshort1"]')
    .boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(target.x + 30, target.y + 20, { steps: 8 });
  const slot = page.locator(".insights-chart-drop-slot");
  await expect(slot).toBeVisible();
  const before = (await moving.boundingBox())!;
  const current = await stored(page);
  const changed = current.insights.charts.map((c: any) =>
    c.id === "cmatri1"
      ? {
          ...c,
          values: [
            { kind: "count" },
            { kind: "workWeeks" },
            { kind: "avgDuration" },
            { kind: "delayRate" },
          ],
        }
      : c,
  );
  await api(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision,
      insights: { ...current.insights, charts: changed },
    },
    "PATCH",
  );
  await expect(moving.locator("thead tr")).toHaveCount(2);
  expect((await moving.boundingBox())!.height).toBeGreaterThan(
    before.height + 10,
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await slot.boundingBox())!.height -
          (await moving.boundingBox())!.height,
      ),
    )
    .toBeLessThan(2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(slot).toHaveCount(0);
  expect((await stored(page)).insights.charts).toEqual(changed);
});
