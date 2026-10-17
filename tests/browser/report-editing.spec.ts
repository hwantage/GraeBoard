import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { unpack } from "../../shared/compact.js";
import { defaultView, normalizeView, cell } from "../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function get(page: Page, path: string) {
  return (await page.request.get(`/api${path}`)).json().then(unpack);
}
async function edit(page: Page, taskId: string, key: string, text: string) {
  await page.locator(`[data-cell="${taskId}:${key}"]`).dblclick();
  const input = page
    .locator(".inline-editor textarea,.inline-editor input")
    .first();
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator(".inline-editor")).toHaveCount(0);
}
async function rowAction(page: Page, taskId: string, name: string) {
  await page
    .locator(`[data-row-id="${taskId}"] .row-select`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function openReport(page: Page) {
  await page.getByRole("tab", { name: "편집 사본", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveAttribute(
    "aria-readonly",
    "false",
  );
}
const saved = (page: Page) =>
  expect(page.locator(".sheet-save-status")).toHaveText("저장됨");

test("사본은 가져오기·내보내기·다중 삭제·이력 복구를 독립적으로 처리한다", async ({
  page,
}) => {
  await openReport(page);
  await expect(
    page.getByRole("button", { name: "업무로 돌아가기", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "가져오기", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "내보내기", exact: true }),
  ).toBeEnabled();
  const original = await get(page, `/tasks?teamId=${teamId}&year=2026`);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("추가 자료").addRows([
    ["작업", "과거 메모"],
    ["사본으로 가져온 업무", "사본 속성으로 해석"],
  ]);
  await page.getByRole("button", { name: "가져오기", exact: true }).click();
  const importer = page.getByRole("dialog", {
    name: "기존 업무 가져오기",
    exact: true,
  });
  await expect(importer).toContainText("가져올 위치: 편집 사본");
  await importer.getByLabel("XLSX 파일 선택").setInputFiles({
    name: "copy.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  await expect(
    importer.getByText("사본으로 가져온 업무", { exact: true }),
  ).toBeVisible();
  await expect(importer.getByLabel("반영 방식")).toHaveCount(0);
  await importer.getByRole("checkbox").check();
  await importer.getByRole("button", { name: "1개 반영", exact: true }).click();
  await expect(importer).toHaveCount(0);
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  const copy = await get(page, `/reports/${reportId}`);
  const imported = copy.tasks.find(
    (t: any) => t.cells.title.value === "사본으로 가져온 업무",
  );
  expect(imported.cells.legacy.value).toBe("사본 속성으로 해석");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const exporter = page.getByRole("dialog", {
    name: "업무 내보내기",
    exact: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exporter.getByRole("button", { name: "내보내기", exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(Buffer.concat(chunks));
  expect(exported.worksheets[0].getColumn(1).values).toContain(
    "사본으로 가져온 업무",
  );
  await page.locator(`[data-row-id="${taskIds[0]}"] .row-select`).click();
  await page
    .locator(`[data-row-id="${taskIds[1]}"] .row-select`)
    .click({ modifiers: ["Shift"] });
  await rowAction(page, taskIds[0], "행 삭제");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "사본으로 가져온 업무",
  ]);
  await saved(page);
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  const history = page.getByRole("dialog", { name: "변경 이력", exact: true });
  await expect(history).toContainText("현재 시트: 편집 사본");
  const deleted = history
    .locator("details")
    .filter({ hasText: "업무 삭제 · 2개" });
  await deleted.locator("summary").click();
  await deleted.getByRole("button", { name: "삭제한 업무 복구" }).click();
  await expect(
    deleted.getByRole("button", { name: "삭제한 업무 복구" }),
  ).toHaveCount(0);
  await history.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  expect((await get(page, `/tasks?teamId=${teamId}&year=2026`)).tasks).toEqual(
    original.tasks,
  );
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  await expect(history).not.toContainText("업무 삭제 · 2개");
});

let teamId: string, taskIds: string[], reportId: string;
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
  const boot = await get(page, "/bootstrap");
  teamId = (
    await post(page, "/admin/teams", {
      name: `보고본 편집 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  let settings = (await get(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  settings.properties.push({
    id: "legacy",
    name: "과거 메모",
    kind: "text",
    display: "text",
    visible: true,
    values: [],
  });
  const configured = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers,
    data: settings,
  });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  settings = (await configured.json().then(unpack)).settings;
  taskIds = [];
  for (const title of ["보고 전 첫 업무", "보고 전 둘째 업무"]) {
    const { task } = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title, owner: boot.user.id, legacy: "당시 메모" },
    });
    taskIds.push(task.id);
  }
  reportId = (
    await post(page, "/reports", {
      teamId,
      year: 2026,
      name: "편집 사본",
      referenceDate: "2026-10-14",
      view: normalizeView(defaultView(2026), settings),
      taskIds,
    })
  ).id;
  const filter = await page.request.put("/api/filters", {
    headers,
    data: {
      teamId,
      scope: "personal",
      name: "돌아갈 필터",
      data: { propertyFilters: {}, propertyFilterModes: {} },
    },
  });
  expect(filter.ok(), await filter.text()).toBeTruthy();
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "보고 전 첫 업무",
  );
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "돌아갈 필터", exact: true })
    .click();
});

test("하단 사본은 즉시 편집·자동 저장하고 원본과 필터를 유지한다", async ({
  page,
}, info) => {
  await openReport(page);
  await expect(
    page.getByRole("button", { name: "스냅샷 수정", exact: true }),
  ).toHaveCount(0);
  await edit(page, taskIds[0], "title", "사본에서만 수정");
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).tasks[0].cells.title.value,
  ).toBe("사본에서만 수정");
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "보고 전 첫 업무",
  );
  await expect(page.locator(".active-saved-filter-banner")).toContainText(
    "돌아갈 필터",
  );
  await openReport(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "사본에서만 수정",
  );
  const tabs = await page.locator(".sheet-tabs-bar").boundingBox();
  const grid = await page.locator(".sheet-scroll").boundingBox();
  expect(tabs!.y).toBeGreaterThanOrEqual(grid!.y + grid!.height - 1);
  await page.screenshot({
    path: info.outputPath("sheet-copy-tabs.png"),
    fullPage: true,
  });
});

test("느린 자동 저장 중에도 새 셀 입력을 이어서 저장하고 저장 후 실행취소·재실행한다", async ({
  page,
}) => {
  await openReport(page);
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    if (route.request().method() === "PATCH" && first) {
      first = false;
      const res = await route.fetch();
      await wait;
      await route.fulfill({ response: res });
    } else await route.continue();
  });
  await edit(page, taskIds[0], "title", "첫 저장");
  await expect(page.locator(".sheet-save-status")).toHaveText("저장 중…");
  await expect.poll(() => first).toBe(false);
  await edit(page, taskIds[1], "title", "저장 중 추가 입력");
  release();
  await saved(page);
  let current = await get(page, `/reports/${reportId}`);
  expect(current.tasks.map((t: any) => t.cells.title.value)).toEqual([
    "첫 저장",
    "저장 중 추가 입력",
  ]);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).tasks[1].cells.title.value,
  ).toBe("보고 전 둘째 업무");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).tasks[1].cells.title.value,
  ).toBe("저장 중 추가 입력");
});

test("이름 변경 뒤 늦게 도착한 표 자동 저장 응답은 새 사본 이름을 유지한다", async ({
  page,
}) => {
  await openReport(page);
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let responseReady = false;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    responseReady = true;
    await wait;
    await route.fulfill({ response });
  });
  await edit(page, taskIds[0], "title", "이름 변경 중 저장한 업무");
  await expect.poll(() => responseReady).toBe(true);
  await page
    .getByRole("button", { name: "편집 사본 메뉴", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "이름 변경", exact: true }).click();
  const rename = page
    .locator(".sheet-tabs-bar")
    .getByRole("textbox", { name: "사본 이름", exact: true });
  await rename.fill("새 사본 이름");
  await rename.press("Enter");
  await expect(rename).toHaveCount(0);
  release();
  await saved(page);
  await expect(
    page.getByRole("tab", { name: "새 사본 이름", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect((await get(page, `/reports/${reportId}`)).name).toBe("새 사본 이름");
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await page.getByRole("tab", { name: "새 사본 이름", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "이름 변경 중 저장한 업무",
  );
});

test("사본 저장 실패는 입력과 탭을 보존하고 재시도 후 전환한다", async ({
  page,
}) => {
  await openReport(page);
  let fail = true;
  await page.route(`**/api/reports/${reportId}`, (route) =>
    route.request().method() === "PATCH" && fail
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "검증용 저장 실패" }),
        })
      : route.continue(),
  );
  await edit(page, taskIds[0], "title", "실패해도 남는 입력");
  await expect(
    page.getByRole("button", { name: "저장 재시도", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "편집 사본", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "실패해도 남는 입력",
  );
  fail = false;
  await page.getByRole("button", { name: "저장 재시도", exact: true }).click();
  await saved(page);
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await openReport(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "실패해도 남는 입력",
  );
});

test("사본 서식·행 복제·삭제·복원은 원본에 영향이 없다", async ({ page }) => {
  await openReport(page);
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).click();
  await page.getByLabel("배경색", { exact: true }).fill("#fff4aa");
  await saved(page);
  expect(
    cell((await get(page, `/reports/${reportId}`)).tasks[0], "title").style
      .backgroundColor,
  ).toBe("#fff4aa");
  await rowAction(page, taskIds[0], "복사");
  await rowAction(page, taskIds[0], "복사한 행 붙여넣기");
  await saved(page);
  await expect
    .poll(async () => (await get(page, `/reports/${reportId}`)).tasks.length)
    .toBe(3);
  await rowAction(page, taskIds[1], "행 삭제");
  await saved(page);
  await expect
    .poll(async () => (await get(page, `/reports/${reportId}`)).tasks.length)
    .toBe(2);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("사본에서 업무를 삭제했습니다.");
  await toast.getByRole("button", { name: "실행취소", exact: true }).click();
  await saved(page);
  await expect
    .poll(async () => (await get(page, `/reports/${reportId}`)).tasks.length)
    .toBe(3);
  const original = await get(page, `/tasks?teamId=${teamId}&year=2026`);
  expect(original.tasks.length).toBe(2);
  expect(cell(original.tasks[0], "title").style.backgroundColor).not.toBe(
    "#fff4aa",
  );
});

test("사본 다중 삭제 알림은 즉시 복구하고 시트 전환·후속 편집 때 사라진다", async ({
  page,
}) => {
  await openReport(page);
  // The sheet still shows empty documents; another editor saved after it loaded.
  const documentPath = `/reports/${reportId}/tasks/${taskIds[0]}/documents/main`;
  const lateDocument = await page.request.put(`/api${documentPath}`, {
    headers,
    data: {
      markdown: "삭제 직전 다른 편집자가 저장한 문서",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
  });
  expect(lateDocument.ok()).toBeTruthy();
  const documentReads: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes(`/reports/${reportId}/`) &&
      (request.url().includes("/documents/batch") ||
        request.url().includes("content=1"))
    )
      documentReads.push(new URL(request.url()).pathname);
  });
  await page.locator(`[data-row-id="${taskIds[0]}"] .row-select`).click();
  await page
    .locator(`[data-row-id="${taskIds[1]}"] .row-select`)
    .click({ modifiers: ["Shift"] });
  await rowAction(page, taskIds[0], "행 삭제");
  const toast = page.locator(".toast");
  await expect(toast).toContainText("사본에서 2개 업무를 삭제했습니다.");
  expect(documentReads).toEqual([`/api/reports/${reportId}/documents/batch`]);
  await toast.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.locator('[data-column="title"]')).toHaveCount(2);
  await saved(page);
  expect((await get(page, documentPath)).markdown).toBe(
    "삭제 직전 다른 편집자가 저장한 문서",
  );
  await rowAction(page, taskIds[0], "행 삭제");
  await expect(toast.getByRole("button", { name: "실행취소" })).toBeEnabled();
  await edit(page, taskIds[1], "title", "삭제 이후 사본 편집");
  await expect(toast).toHaveCount(0);
  await page
    .locator('.format-toolbar[aria-label="셀 서식 도구"]')
    .getByRole("button", { name: "실행취소", exact: true })
    .click();
  await expect(page.locator('[data-column="title"]')).toHaveText([
    "보고 전 둘째 업무",
  ]);
  await expect(toast.getByRole("button")).toHaveCount(0);
  await rowAction(page, taskIds[1], "행 삭제");
  await expect(toast.getByRole("button", { name: "실행취소" })).toBeEnabled();
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await expect(page.locator('[data-column="title"]')).toHaveCount(2);
  await expect(toast).toHaveCount(0);
  await openReport(page);
  await expect(page.locator('[data-column="title"]')).toHaveCount(0);
  await expect(toast).toHaveCount(0);
});

test("사본의 달력·필터도 편집하며 원본 보기 설정은 보존한다", async ({
  page,
}, info) => {
  const copyFilter = {
    propertyFilters: { title: ["보고 전 첫 업무"] },
    propertyFilterModes: {},
  };
  const response = await page.request.put("/api/filters", {
    headers,
    data: {
      teamId,
      scope: "personal",
      name: "첫 업무 필터",
      data: copyFilter,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const originalFilters = await get(page, `/filters?teamId=${teamId}`);
  const banner = page.getByRole("region", { name: "필터 보기", exact: true });
  const titles = page.locator('[data-column="title"]');
  await openReport(page);
  await expect(banner).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await get(page, `/views?teamId=${teamId}&year=2026`)).views.length,
    )
    .toBeGreaterThan(0);
  const before = await get(page, `/views?teamId=${teamId}&year=2026`);
  const november = page.locator('.period-month[data-month="11"]');
  await november.click();
  await november.press("Shift+ArrowRight");
  await page
    .getByRole("button", { name: "다음 달로 이동", exact: true })
    .click();
  await expect(page.locator('.period-month[aria-pressed="true"]')).toHaveText([
    "11월",
    "12월",
  ]);
  await saved(page);
  expect((await get(page, `/reports/${reportId}`)).view).toMatchObject({
    startMonth: 2,
    fromMonth: 10,
    toMonth: 11,
  });
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "2027년 전체 선택", exact: true }),
  ).toBeVisible();
  await saved(page);
  expect((await get(page, `/reports/${reportId}`)).year).toBe(2027);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "첫 업무 필터", exact: true })
    .click();
  await expect(banner).toBeVisible();
  await expect(banner.locator("strong")).toHaveText("첫 업무 필터");
  await expect(banner).toContainText("개인용");
  await expect(titles).toHaveText(["보고 전 첫 업무"]);
  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await expect(
    page.locator(".saved-views").getByRole("button", {
      name: "첫 업무 필터",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "저장된 필터 닫기" }).click();
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).view.propertyFilters,
  ).toEqual(copyFilter.propertyFilters);
  await page.screenshot({ path: info.outputPath("copy-filter-banner.png") });

  await banner
    .getByRole("button", { name: /필터 변경: 보고 전 첫 업무/ })
    .click();
  await page.getByRole("radio", { name: "제외", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(banner.locator("strong")).toHaveText("첫 업무 필터");
  await expect(titles).toHaveText(["보고 전 둘째 업무"]);
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).view.propertyFilterModes,
  ).toEqual({ title: "exclude" });
  await banner.getByRole("button", { name: "필터 보기 종료" }).click();
  await expect(banner).toHaveCount(0);
  await expect(titles).toHaveText(["보고 전 첫 업무", "보고 전 둘째 업무"]);
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).view.propertyFilters,
  ).toEqual({});

  await page.getByRole("button", { name: "저장된 필터", exact: true }).click();
  await page
    .locator(".saved-views")
    .getByRole("button", { name: "첫 업무 필터", exact: true })
    .click();
  await expect(banner.locator("strong")).toHaveText("첫 업무 필터");
  await saved(page);
  await page.getByRole("tab", { name: "원본", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "2026년 전체 선택", exact: true }),
  ).toBeVisible();
  await expect(banner.locator("strong")).toHaveText("돌아갈 필터");
  await expect(titles).toHaveText(["보고 전 첫 업무", "보고 전 둘째 업무"]);
  expect(await get(page, `/views?teamId=${teamId}&year=2026`)).toEqual(before);
  expect(await get(page, `/filters?teamId=${teamId}`)).toEqual(originalFilters);
});

test("사본 상세 속성은 자동 저장하고 실패 안내·재시도를 팝업 안에 표시한다", async ({
  page,
}) => {
  await openReport(page);
  let fail = true;
  await page.route(`**/api/reports/${reportId}`, (route) =>
    route.request().method() === "PATCH" && fail
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "속성 자동 저장 실패" }),
        })
      : route.continue(),
  );
  await page
    .locator(`[data-cell="${taskIds[0]}:title"]`)
    .click({ button: "right" });
  const dialog = page.getByRole("dialog", { name: "업무 상세", exact: true });
  await dialog
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("팝업에서 편집한 사본");
  await expect(dialog.getByRole("alert")).toContainText("속성 자동 저장 실패");
  fail = false;
  await dialog
    .getByRole("button", { name: "사본 저장 재시도", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await saved(page);
  expect(
    (await get(page, `/reports/${reportId}`)).tasks[0].cells.title.value,
  ).toBe("팝업에서 편집한 사본");
  expect(
    (await get(page, `/tasks?teamId=${teamId}&year=2026`)).tasks[0].cells.title
      .value,
  ).toBe("보고 전 첫 업무");
});
