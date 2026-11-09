import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, taskIds: string[];
const card = (page: Page, title: string) =>
  page
    .locator(".insights-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
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
async function settings(page: Page) {
  return (await request(page, "/bootstrap")).teams.find(
    (team: any) => team.id === teamId,
  ).settings;
}
async function configure(
  page: Page,
  charts: any[] = [],
  colors = [{ color: "#0066cc", name: "개발 작업" }],
) {
  const current = await settings(page);
  return request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision || 0,
      insights: { workColors: colors, deadlinePropertyId: "deadline", charts },
    },
    "PATCH",
  );
}
async function paint(
  page: Page,
  index: number,
  weeks: string[],
  color = "#0066cc",
) {
  const current = (
    await request(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((task: any) => task.id === taskIds[index]);
  return request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: weeks.map((key) => ({
      taskId: current.id,
      key,
      style: { backgroundColor: color },
      expectedVersion: current.cells[key]?.version || 0,
      expectedFormatRevision: current.formatting?.revision || 0,
    })),
  });
}
async function insights(page: Page) {
  await page.getByRole("button", { name: "인사이트", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "인사이트", exact: true }),
  ).toBeVisible();
}
const chart = (id: string, title: string, type = "bar", extra = {}) => ({
  id,
  title,
  type,
  dimensions: type === "bar" ? { axis: { kind: "owner" } } : {},
  values: [{ kind: "count" }],
  ...extra,
});
test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", {
      name: `인사이트 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  const current = await settings(page);
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: current.revision || 0,
      properties: [
        ...current.properties,
        {
          id: "category",
          name: "분류",
          kind: "option",
          display: "text",
          values: ["기획", "개발", "검토"].map((label, i) => ({
            id: `v${i}`,
            label,
            backgroundColor: "#edf6f4",
            dotColor: "#177b70",
            emoji: "",
          })),
        },
        {
          id: "deadline",
          name: "목표일",
          kind: "date",
          display: "text",
          values: [],
        },
        {
          id: "score",
          name: "Score",
          kind: "text",
          display: "text",
          values: [],
        },
      ],
    },
    "PATCH",
  );
  taskIds = [];
  for (let i = 0; i < 3; i++)
    taskIds.push(
      (
        await request(page, "/tasks", {
          teamId,
          year: 2026,
          fields: {
            title: `인사이트 검증 업무 ${i + 1}`,
            owner: userId,
            category: `v${i}`,
            score: String(i + 1),
            deadline: "2026-02-06",
          },
        })
      ).task.id,
    );
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId, teamId },
  );
  await page.goto("/");
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "인사이트 검증 업무 1",
  );
});

test("메뉴·직접 주소·새로고침·뒤로가기가 동작하고 미설정 팀장과 팀원 안내를 구분한다", async ({
  page,
  browser,
}) => {
  await insights(page);
  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByText("업무 색상을 설정해 주세요")).toBeVisible();
  await page.reload();
  await expect(page.getByText("팀의 작업 주를 나타내는 배경색")).toBeVisible();
  await page.getByRole("button", { name: "연간 업무", exact: true }).click();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "인사이트", exact: true }),
  ).toBeVisible();
  const username = `member-${randomUUID().slice(0, 8)}@example.test`;
  const member = await request(page, "/admin/users", {
    username,
    name: "인사이트 팀원",
    password: "test-password-123",
    systemRole: "user",
    memberships: [{ teamId, role: "member" }],
  });
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    const other = await context.newPage();
    await request(other, "/auth/login", {
      username,
      password: "test-password-123",
    });
    await other.goto("/insights");
    await expect(
      other.getByText("팀장에게 업무 색상 설정을 요청하세요."),
    ).toBeVisible();
    await expect(
      other.getByRole("button", { name: "인사이트 설정", exact: true }),
    ).toHaveCount(0);
    expect(member).toBeTruthy();
  } finally {
    await context.close();
  }
});

test("설정 저장→배경색 프리셋→칠하기→수치 반영과 색 편집, 글자·테두리 메뉴 제외", async ({
  page,
}) => {
  await insights(page);
  await page
    .getByRole("button", { name: "인사이트 설정", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "인사이트 설정",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "업무 색상 추가", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "새 업무 색상", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "새 업무 색상",
    exact: true,
  });
  await picker
    .getByRole("textbox", { name: "새 업무 색상 HEX" })
    .fill("#0066cc");
  await picker
    .getByRole("textbox", { name: "새 업무 색상 HEX" })
    .press("Enter");
  await dialog
    .getByRole("textbox", { name: "업무 색상 1 이름" })
    .fill("개발 작업");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByText("인사이트 설정을 저장했습니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
  await page.getByRole("button", { name: "연간 업무", exact: true }).click();
  await page.locator(`[data-cell="${taskIds[0]}:2026-01-05"]`).click();
  await page.getByRole("button", { name: "글자 색상", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "글자 색상", exact: true })
      .getByRole("group", { name: "업무 색상", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  await page
    .getByRole("button", { name: "테두리 선 색상", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "테두리 선 색상", exact: true })
      .getByRole("group", { name: "업무 색상", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "배경색", exact: true }).click();
  await page
    .getByRole("dialog", { name: "배경색", exact: true })
    .getByRole("group", { name: "업무 색상", exact: true })
    .getByRole("button", { name: "개발 작업 #0066cc" })
    .click();
  await expect
    .poll(
      async () =>
        (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks.find(
          (task: any) => task.id === taskIds[0],
        ).cells["2026-01-05"]?.style.backgroundColor,
    )
    .toBe("#0066cc");
  await insights(page);
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  await page
    .getByRole("button", { name: "인사이트 설정", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "업무 색상 1", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "업무 색상 1", exact: true });
  await edit.getByRole("textbox", { name: "업무 색상 1 HEX" }).fill("#ff0000");
  await edit.getByRole("textbox", { name: "업무 색상 1 HEX" }).press("Enter");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByText("인사이트 설정을 저장했습니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
});

test("다섯 종류 저장·즉시 미리보기·편집·복제·순서 변경·삭제와 막대→목록→연간 상세", async ({
  page,
}) => {
  test.setTimeout(90000);
  await configure(page);
  for (let i = 0; i < 3; i++)
    await paint(page, i, ["2026-01-05", "2026-02-02"]);
  await insights(page);
  for (const [type, title] of [
    ["number", "숫자 검증"],
    ["bar", "막대 검증"],
    ["radar", "레이더 검증"],
    ["table", "표 검증"],
    ["top", "Top 검증"],
  ]) {
    await page.getByRole("button", { name: "차트 추가", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
    await editor.getByRole("textbox", { name: "차트 제목" }).fill(title);
    await editor
      .getByRole("combobox", { name: "차트 종류" })
      .selectOption(type);
    if (type === "table") {
      await editor.getByRole("button", { name: "값 추가" }).click();
      await editor
        .getByRole("combobox", { name: "값 2", exact: true })
        .selectOption('{"kind":"numberSum","propertyId":"score"}');
    }
    if (type === "bar") {
      await editor
        .getByRole("combobox", { name: "막대 방향" })
        .selectOption("horizontal");
      await editor
        .getByRole("combobox", { name: "막대 배치" })
        .selectOption("stacked");
    }
    await expect(
      editor
        .getByRole("region", { name: "즉시 미리보기" })
        .getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "저장", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(card(page, title)).toBeVisible();
  }
  expect(
    (await settings(page)).insights.charts.map((c: any) => c.type),
  ).toEqual(["number", "bar", "radar", "table", "top"]);
  await page.screenshot({
    path: test.info().outputPath("insights-five-charts.png"),
  });
  await card(page, "숫자 검증")
    .getByRole("button", { name: "숫자 검증 편집" })
    .click();
  const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
  await editor.getByRole("textbox", { name: "차트 제목" }).fill("숫자 수정");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await card(page, "숫자 수정")
    .getByRole("button", { name: "숫자 수정 복제" })
    .click();
  await expect(card(page, "숫자 수정 사본")).toBeVisible();
  await card(page, "숫자 수정 사본")
    .getByRole("button", { name: "숫자 수정 사본 순서 이동" })
    .focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(async () =>
      (await settings(page)).insights.charts.map((c: any) => c.title),
    )
    .toEqual([
      "숫자 수정",
      "막대 검증",
      "레이더 검증",
      "표 검증",
      "숫자 수정 사본",
      "Top 검증",
    ]);
  await card(page, "숫자 수정 사본")
    .getByRole("button", { name: "숫자 수정 사본 삭제" })
    .click();
  await expect(card(page, "숫자 수정 사본")).toHaveCount(0);
  await card(page, "막대 검증").locator("svg [role=button]").first().click();
  const list = page.getByRole("dialog", {
    name: "막대 검증 · 업무 목록",
    exact: true,
  });
  await expect(
    list.getByRole("button", { name: "인사이트 검증 업무 1", exact: true }),
  ).toBeVisible();
  await list
    .getByRole("button", { name: "인사이트 검증 업무 1", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page
      .getByRole("dialog")
      .filter({ has: page.getByText("인사이트 검증 업무 1", { exact: true }) })
      .first(),
  ).toBeVisible();
});

test("열람자는 임시 미리보기만 제공하고 다른 탭 셀 색상·설정 변경을 실시간 반영한다", async ({
  page,
  browser,
}) => {
  await configure(page, [chart("c123abc", "공용 막대")]);
  await paint(page, 0, ["2026-01-05"]);
  const username = `viewer-${randomUUID().slice(0, 8)}@example.test`;
  await request(page, "/admin/users", {
    username,
    name: "인사이트 열람자",
    password: "test-password-123",
    systemRole: "user",
    memberships: [{ teamId, role: "viewer" }],
  });
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    const viewer = await context.newPage();
    await request(viewer, "/auth/login", {
      username,
      password: "test-password-123",
    });
    await viewer.goto("/insights");
    await expect(card(viewer, "업무 수").locator("strong")).toHaveText("1");
    await viewer
      .getByRole("button", { name: "차트 미리보기", exact: true })
      .click();
    const preview = viewer.getByRole("dialog", {
      name: "차트 미리보기",
      exact: true,
    });
    await preview
      .getByRole("combobox", { name: "차트 종류" })
      .selectOption("number");
    await preview
      .getByRole("textbox", { name: "차트 제목" })
      .fill("내 임시 차트");
    await expect(
      preview.getByRole("button", { name: "저장", exact: true }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("heading", { name: "내 임시 차트", exact: true }),
    ).toBeVisible();
    await preview.getByRole("button", { name: "닫기", exact: true }).click();
    expect((await settings(page)).insights.charts).toHaveLength(1);
    await paint(page, 1, ["2026-01-12"]);
    await expect(card(viewer, "업무 수").locator("strong")).toHaveText("2");
    await configure(page, [chart("c123abc", "변경된 공용 막대")]);
    await expect(card(viewer, "변경된 공용 막대")).toBeVisible();
    await viewer.setViewportSize({ width: 650, height: 900 });
    await expect(
      viewer.getByRole("button", { name: "차트 미리보기", exact: true }),
    ).toBeDisabled();
    expect(
      await viewer
        .locator(".insights-summary")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});

test("24개월 기간은 연도별 기존 API를 합치고 전체 업무 기간과 숫자 제외·보관 경고를 유지한다", async ({
  page,
}) => {
  await configure(page, [
    chart("c123abc", "보관 차트", "table", {
      dimensions: { row: { kind: "property", propertyId: "missing" } },
      values: [{ kind: "numberSum", propertyId: "score" }],
    }),
  ]);
  await paint(page, 0, ["2026-01-05", "2027-02-01"]);
  await insights(page);
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("1");
  await expect(card(page, "평균 업무 기간").locator("strong")).toHaveText("2");
  await expect(page.getByText("참조 속성이 없습니다: missing")).toBeVisible();
  await page.getByLabel("인사이트 끝 월", { exact: true }).fill("2027-12");
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("2");
  await page.reload();
  await expect(page.getByLabel("인사이트 끝 월", { exact: true })).toHaveValue(
    "2027-12",
  );
  await expect(card(page, "작업 주 합").locator("strong")).toHaveText("2");
  await page.locator(".insights-range-filter > summary").click();
  await page
    .locator(".insights-range-filter")
    .getByText("분류", { exact: true })
    .click();
  await page
    .getByRole("group", { name: "분류 필터 선택", exact: true })
    .getByRole("checkbox", { name: "개발", exact: true })
    .check();
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
  await page.reload();
  await expect(card(page, "업무 수").locator("strong")).toHaveText("0");
  await page.locator(".insights-range-filter > summary").click();
  await page
    .locator(".insights-range-filter")
    .getByRole("button", { name: "모든 필터 초기화", exact: true })
    .click();
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  await page.getByLabel("인사이트 끝 월", { exact: true }).fill("2028-01");
  await expect(
    page.getByText("기간은 시작 월부터 최대 24개월까지 선택하세요."),
  ).toBeVisible();
});

test("차트 편집 중 다른 팀장이 저장하면 409를 표시하고 초안을 유지한다", async ({
  page,
}) => {
  await configure(page, [chart("c123abc", "동시 편집")]);
  await paint(page, 0, ["2026-01-05"]);
  await insights(page);
  await card(page, "동시 편집")
    .getByRole("button", { name: "동시 편집 편집" })
    .click();
  const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
  await editor.getByRole("textbox", { name: "차트 제목" }).fill("내 초안");
  await configure(page, [chart("c123abc", "다른 팀장 저장")]);
  await expect(card(page, "다른 팀장 저장")).toBeVisible();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    editor.getByText(/다른 관리자가 설정을 변경했습니다/),
  ).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "차트 제목" })).toHaveValue(
    "내 초안",
  );
  expect((await settings(page)).insights.charts[0].title).toBe(
    "다른 팀장 저장",
  );
});

test("느린 다른 연도 조회 중 기간·팀을 전환해도 오래된 응답이 수치를 바꾸지 않는다", async ({
  page,
}) => {
  await configure(page);
  await paint(page, 0, ["2026-01-05"]);
  const other = await request(page, "/admin/teams", {
    name: `빈 팀 ${randomUUID().slice(0, 8)}`,
    members: [{ userId, role: "lead" }],
  });
  await page.reload();
  await insights(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    loading = new Promise<void>((resolve) => {
      started = resolve;
    });
  let reads = 0;
  await page.route(/\/api\/tasks\?.*year=2027/, async (route) => {
    reads++;
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByLabel("인사이트 끝 월", { exact: true }).fill("2027-12");
  await loading;
  await page.getByLabel("인사이트 끝 월", { exact: true }).fill("2026-12");
  await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(other.id);
  await expect(page.getByText("업무 색상을 설정해 주세요")).toBeVisible();
  release();
  await expect(page.locator(".insights-summary")).toHaveCount(0);
  expect(reads).toBe(1);
});

test("완료 카드와 표의 값·계열 합계는 집계에 기여한 업무만 연다", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-09T00:00:00+09:00"));
  await page.reload();
  await configure(page, [
    chart("c123abc", "집계 목록", "table", {
      dimensions: {
        row: { kind: "property", propertyId: "category" },
        column: { kind: "owner" },
      },
      values: [{ kind: "count" }, { kind: "completed" }],
    }),
  ]);
  await paint(page, 0, ["2026-01-05"]);
  await paint(page, 1, ["2027-02-01"]);
  await paint(page, 2, ["2026-01-12"]);
  const current = (
    await request(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((task: any) => task.id === taskIds[2]);
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: current.id,
        key: "owner",
        value: "",
        expectedVersion: current.cells.owner.version,
      },
    ],
  });
  await insights(page);
  await page.getByLabel("인사이트 끝 월", { exact: true }).fill("2027-12");
  await expect(card(page, "완료").locator("strong")).toHaveText("2");
  await card(page, "완료").getByRole("button").click();
  let list = page.getByRole("dialog", {
    name: "완료 · 업무 목록",
    exact: true,
  });
  await expect(list.locator("tbody tr")).toHaveCount(2);
  await expect(
    list.getByRole("button", { name: "인사이트 검증 업무 2", exact: true }),
  ).toHaveCount(0);
  await list.getByRole("button", { name: "닫기", exact: true }).click();
  // Two values per owner: the current owner's completed total is the second
  // footer button, and excludes both the planned task and the other owner.
  await card(page, "집계 목록").locator("tfoot button").nth(1).click();
  list = page.getByRole("dialog", {
    name: "집계 목록 · 업무 목록",
    exact: true,
  });
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(
    list.getByRole("button", { name: "인사이트 검증 업무 1", exact: true }),
  ).toBeVisible();
  await list.getByRole("button", { name: "닫기", exact: true }).click();
  const row = card(page, "집계 목록")
    .getByRole("row")
    .filter({
      has: page.getByRole("rowheader", { name: "개발", exact: true }),
    });
  await row
    .getByRole("button", { name: /완료 업무 수/ })
    .first()
    .click();
  list = page.getByRole("dialog", {
    name: "집계 목록 · 업무 목록",
    exact: true,
  });
  await expect(list.locator("tbody tr")).toHaveCount(0);
});

for (const site of ["internal", "external"] as const) {
  test(`${site}: 인사이트 재시도 정책은 리소스 429의 Retry-After 동안 SSE·포커스·주기 조회를 막고 복구한다`, async ({
    page,
  }) => {
    await configure(page);
    for (let index = 0; index < 3; index++)
      await paint(page, index, ["2026-01-05"]);
    const bootstrap = await request(page, "/bootstrap");
    let bootstrapReads = 0,
      taskResponses = 0,
      reads = 0,
      failing = false;
    let recovery: Promise<void> | undefined;
    await page.route("**/api/bootstrap", (route) => {
      bootstrapReads++;
      return route.fulfill({
        json: { ...bootstrap, site, authMode: "access" },
      });
    });
    await page.addInitScript(() =>
      Object.defineProperty(window, "SharedWorker", { value: undefined }),
    );
    await page.route("**/api/tasks?**", async (route) => {
      if (failing) {
        reads++;
        return route.fulfill({
          status: 429,
          headers: { "Retry-After": "60" },
          json: { code: "RATE_LIMIT_EXCEEDED" },
        });
      }
      reads++;
      await recovery;
      return route.continue();
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/tasks") taskResponses++;
    });
    await page.clock.install();
    await page.goto("/insights");
    await expect(card(page, "업무 수").locator("strong")).toHaveText("3");
    // Annual bootstrap GET, then the insights team's initial resource snapshot.
    await expect.poll(() => taskResponses).toBe(2);
    reads = 0;
    failing = true;
    const current = await settings(page);
    await request(
      page,
      `/teams/${teamId}/settings`,
      { revision: current.revision, defaultDensity: "dense" },
      "PATCH",
    );
    const error = page.getByText(/업무 목록 조회 실패:.*요청 제한/).first();
    await expect(error).toBeVisible();
    await expect(error).toContainText("60초 뒤");
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const failedReads = reads,
      failedBootstraps = bootstrapReads;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Workspace independently checks membership once when returning to a tab.
    // Keep that existing request, while the insights refresh remains blocked.
    await expect.poll(() => bootstrapReads).toBe(failedBootstraps + 1);
    const focusBootstraps = bootstrapReads;
    await page.clock.runFor(58000);
    expect(reads, "no task retry may precede Retry-After").toBe(failedReads);
    expect(
      bootstrapReads,
      "a blocked refresh must not repeat bootstrap either",
    ).toBe(focusBootstraps);
    let resumeRecovery!: () => void;
    recovery = new Promise((resolve) => (resumeRecovery = resolve));
    failing = false;
    try {
      await page.clock.runFor(3000);
      // Keep the successful read in flight while resource and poll timers fire.
      // Both consumers must join the same tasks/bootstrap refresh.
      await expect.poll(() => reads).toBe(failedReads + 1);
      expect(bootstrapReads).toBe(focusBootstraps + 1);
    } finally {
      resumeRecovery();
    }
    await expect(error).toHaveCount(0);
    await expect(card(page, "업무 수").locator("strong")).toHaveText("3");
    expect(reads).toBe(failedReads + 1);
    expect(bootstrapReads).toBe(focusBootstraps + 1);
  });

  test(`${site}: 인사이트 재시도 정책은 기존 보완 조회 주기와 일반 오류 대기를 따른다`, async ({
    page,
  }) => {
    await configure(page);
    await paint(page, 0, ["2026-01-05"]);
    const bootstrap = await request(page, "/bootstrap");
    await page.route("**/api/bootstrap", (route) =>
      route.fulfill({ json: { ...bootstrap, site, authMode: "access" } }),
    );
    await page.addInitScript(() =>
      Object.defineProperty(window, "SharedWorker", { value: undefined }),
    );
    // Isolate the fallback timer; real resource delivery is covered above.
    await page.route("**/api/events", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    let reads = 0;
    await page.route("**/api/tasks?**", (route) => {
      reads++;
      return reads === 2
        ? route.fulfill({ status: 503, json: { error: "보완 조회 실패" } })
        : route.continue();
    });
    await page.clock.install();
    await page.goto("/insights");
    await expect(card(page, "업무 수").locator("strong")).toHaveText("1");
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.clock.runFor(site === "internal" ? 5000 : 28000);
    expect(reads).toBe(1);
    await page.clock.runFor(2000);
    await expect.poll(() => reads).toBe(2);
    const error = page.getByText(/업무 목록 조회 실패|보완 조회 실패/).first();
    await expect(error).toBeVisible();
    await page.clock.runFor(site === "internal" ? 5000 : 3000);
    expect(reads).toBe(2);
    await page.clock.runFor(3000);
    await expect.poll(() => reads).toBe(3);
    await expect(error).toHaveCount(0);
  });
}

test("숫자 레이더는 저장된 차트와 즉시 미리보기에서 비숫자 제외를 알리고 빈값은 세지 않는다", async ({
  page,
}) => {
  const radar = chart("cexcl01", "숫자 제외 레이더", "radar", {
    dimensions: {
      axis: { kind: "property", propertyId: "category" },
      series: { kind: "owner" },
    },
    values: [{ kind: "numberSum", propertyId: "score" }],
  });
  await configure(page, [radar]);
  const current = (
    await request(page, `/tasks?teamId=${teamId}&year=2026`)
  ).tasks.find((task: any) => task.id === taskIds[1]);
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: current.id,
        key: "score",
        value: "완료",
        expectedVersion: current.cells.score.version,
      },
    ],
  });
  for (let index = 0; index < 3; index++)
    await paint(page, index, ["2026-01-05"]);
  const blank = await request(page, "/tasks", {
    teamId,
    year: 2026,
    fields: { title: "빈 숫자 검증", owner: userId, category: "v1", score: "" },
  });
  taskIds.push(blank.task.id);
  await paint(page, 3, ["2026-01-05"]);
  await insights(page);
  const persisted = card(page, "숫자 제외 레이더");
  await expect(persisted.locator("svg.insights-radar")).toBeVisible();
  await expect(persisted.getByText("제외 1건", { exact: true })).toBeVisible();
  await expect(persisted.getByText("제외 2건", { exact: true })).toHaveCount(0);
  await persisted
    .getByRole("button", { name: "숫자 제외 레이더 편집", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "차트 편집", exact: true });
  await expect(
    editor.locator(".insights-editor-preview svg.insights-radar"),
  ).toBeVisible();
  await expect(
    editor
      .locator(".insights-editor-preview")
      .getByText("제외 1건", { exact: true }),
  ).toBeVisible();
});
