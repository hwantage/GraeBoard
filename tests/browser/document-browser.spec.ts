import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unpack } from "../../shared/compact.js";
import { defaultView } from "../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
const longTitle =
  "여러 부서와 함께 진행하는 연간 업무 문서 정리 및 서비스 사용성 개선을 위한 상세 검토 작업 — 긴 제목의 마지막 부분까지 확인";
let teamId: string,
  taskId: string,
  secondId: string,
  emptyId: string,
  documentId: string,
  copyA: string,
  copyB: string;
async function get(page: Page, path: string) {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function send(page: Page, path: string, data: unknown, method = "POST") {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
const tree = (page: Page) =>
  page.getByRole("complementary", { name: "문서 탐색" });
const sheet = (page: Page, id = "live") =>
  tree(page).locator(`[data-source="${id}"]`);
const detail = (page: Page) =>
  page.getByRole("region", { name: "문서 상세", exact: true });
const rich = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 리치 편집" });
const raw = (page: Page) =>
  detail(page).getByRole("textbox", { name: "업무 문서 Markdown 원문" });
async function openBrowser(page: Page, scope = "all") {
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "문서 브라우저", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("문서 검색 범위")).toHaveValue("live");
  if (scope !== "live")
    await page.getByLabel("문서 검색 범위").selectOption(scope);
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(2);
}
async function openDocument(page: Page, source = "live", title = "문서 1") {
  const toggle = sheet(page, source).locator(".document-browser-source-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const task = sheet(page, source)
    .locator(".document-browser-task")
    .filter({ hasText: longTitle });
  const taskToggle = task.locator(".document-browser-task-toggle");
  if ((await taskToggle.getAttribute("aria-expanded")) === "false")
    await taskToggle.click();
  await task
    .locator(".document-browser-document")
    .filter({ hasText: title })
    .click();
  await expect(rich(page)).toBeVisible();
}
async function markdown(page: Page) {
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(raw(page)).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await send(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await get(page, "/bootstrap");
  teamId = (
    await send(page, "/admin/teams", {
      name: `문서 탐색 검증 ${randomUUID().slice(0, 5)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskId = (
    await send(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: longTitle, owner: boot.user.id },
    })
  ).task.id;
  secondId = (
    await send(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "다른 문서 작업" },
    })
  ).task.id;
  emptyId = (
    await send(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "문서 미등록 작업" },
    })
  ).task.id;
  await send(
    page,
    `/tasks/${taskId}/documents/main`,
    {
      markdown: "# 원본 문서\n\n원본에서 읽는 본문입니다.",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
    "PUT",
  );
  documentId = randomUUID();
  await send(page, `/tasks/${taskId}/documents`, {
    id: documentId,
    title: "설계 노트",
  });
  await send(
    page,
    `/tasks/${taskId}/documents/${documentId}`,
    {
      markdown: "# 설계 노트\n\n정확한 두 번째 문서의 본문입니다.",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
    "PUT",
  );
  await send(page, `/tasks/${secondId}/documents`, {
    id: randomUUID(),
    title: "등록한 빈 문서",
  });
  const createCopy = async (name: string) =>
    (
      await send(page, "/reports", {
        teamId,
        year: 2026,
        name,
        referenceDate: "2026-10-17",
        view: defaultView(2026),
        taskIds: [taskId, secondId, emptyId],
      })
    ).id;
  copyA = await createCopy("검토 사본");
  copyB = await createCopy("공유 사본");
  const doc = await get(
    page,
    `/reports/${copyA}/tasks/${taskId}/documents/main`,
  );
  await send(
    page,
    `/reports/${copyA}/tasks/${taskId}/documents/main`,
    {
      markdown: "# 검토 사본\n\n접힌 사본의 바다별 검색어입니다.",
      expectedRevision: doc.revision,
      operationId: randomUUID(),
    },
    "PUT",
  );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
});

test("접힌 사본 집계, 작업 이름 검색, 정확한 문서 선택과 원본·사본 독립 저장", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await openBrowser(page);
  for (const id of ["live", copyA, copyB])
    await expect(
      sheet(page, id).locator(".document-browser-source-toggle"),
    ).toContainText("문서 보유 작업 2개 · 문서 4개");
  await expect(
    sheet(page, copyA).locator(".document-browser-source-toggle"),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    requests.filter((url) =>
      /\/api\/reports\/[^/?]+$|\/documents\/main/.test(url),
    ),
  ).toEqual([]);
  const search = page.getByRole("searchbox", { name: "작업 이름 검색" });
  await expect(search).toHaveAttribute("placeholder", "작업 이름 검색");
  for (const q of ["바다별", "설계 노트"]) {
    await search.fill(q);
    await expect(
      page.getByRole("status").filter({ hasText: "검색 결과" }),
    ).toContainText("작업 0개 · 문서 0개");
    await expect(tree(page).locator(".document-browser-document")).toHaveCount(
      0,
    );
  }
  await search.fill("서비스 사용성");
  await expect(
    page.getByRole("status").filter({ hasText: "검색 결과" }),
  ).toContainText("작업 3개 · 문서 6개");
  await expect(
    sheet(page, copyA).locator(".document-browser-document-count"),
  ).toHaveAttribute("aria-label", "등록된 문서 2개");
  await expect(
    sheet(page, copyA)
      .getByRole("button", { name: "문서 1", exact: true })
      .locator(".document-browser-document-preview"),
  ).toHaveText("검토 사본 접힌 사본의 바다별 검색어입니다.");
  await sheet(page, copyA)
    .getByRole("button", { name: "문서 1", exact: true })
    .click();
  await expect(rich(page)).toContainText("접힌 사본의 바다별");
  await markdown(page);
  await raw(page).fill("사본에서 수정한 새 본문");
  await page.getByRole("searchbox", { name: "작업 이름 검색" }).fill("");
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(2);
  await openDocument(page, "live", "설계 노트");
  await expect(
    sheet(page)
      .getByRole("button", { name: "설계 노트", exact: true })
      .locator(".document-browser-document-preview"),
  ).toHaveText("설계 노트 정확한 두 번째 문서의 본문입니다.");
  await expect(rich(page)).toContainText("정확한 두 번째 문서");
  await expect(
    detail(page).getByRole("tab", { name: "설계 노트" }),
  ).toHaveAttribute("aria-selected", "true");
  await markdown(page);
  await raw(page).fill("원본의 두 번째 문서만 수정");
  await expect(
    sheet(page)
      .getByRole("button", { name: "설계 노트", exact: true })
      .locator(".document-browser-document-preview"),
  ).toHaveText("원본의 두 번째 문서만 수정");
  await openDocument(page, copyA);
  await expect(
    sheet(page, copyA)
      .getByRole("button", { name: "문서 1", exact: true })
      .locator(".document-browser-document-preview"),
  ).toHaveText("사본에서 수정한 새 본문");
  await expect(
    sheet(page)
      .getByRole("button", { name: "문서 1", exact: true })
      .locator(".document-browser-document-preview"),
  ).toHaveText("원본 문서 원본에서 읽는 본문입니다.");
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  expect(
    (await get(page, `/tasks/${taskId}/documents/main`)).markdown,
  ).toContain("원본에서 읽는");
  expect(
    (await get(page, `/tasks/${taskId}/documents/${documentId}`)).markdown,
  ).toBe("원본의 두 번째 문서만 수정");
  expect(
    (await get(page, `/reports/${copyA}/tasks/${taskId}/documents/main`))
      .markdown,
  ).toBe("사본에서 수정한 새 본문");
  expect(
    (await get(page, `/reports/${copyB}/tasks/${taskId}/documents/main`))
      .markdown,
  ).toContain("원본에서 읽는");
});

test("작업 제목은 첫 문서를 열고 검색·기존 선택·삭제 뒤에도 문서 순서를 따른다", async ({
  page,
}) => {
  await openBrowser(page);
  for (const source of ["live", copyA]) {
    const sourceToggle = sheet(page, source).locator(
      ".document-browser-source-toggle",
    );
    if ((await sourceToggle.getAttribute("aria-expanded")) === "false")
      await sourceToggle.click();
    const task = sheet(page, source)
      .locator(".document-browser-task")
      .filter({ hasText: longTitle });
    const title = task.getByRole("button", { name: longTitle, exact: true });
    const toggle = task.locator(".document-browser-task-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await title.click();
    await expect(
      detail(page).getByRole("tab", { name: "문서 1", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      task.getByRole("button", { name: "문서 1", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await task.getByRole("button", { name: "설계 노트", exact: true }).click();
    await markdown(page);
    const text = `${source}의 작업 제목 클릭 전에 저장할 내용`;
    await raw(page).fill(text);
    await title.click();
    await expect(
      detail(page).getByRole("tab", { name: "문서 1", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const path = `${source === "live" ? "" : `/reports/${source}`}/tasks/${taskId}/documents/${documentId}`;
    expect((await get(page, path)).markdown).toBe(text);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      detail(page).getByRole("tab", { name: "문서 1", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await title.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await page
    .getByRole("searchbox", { name: "작업 이름 검색" })
    .fill("서비스 사용성");
  await expect(sheet(page).locator(".document-browser-document")).toHaveCount(
    2,
  );
  for (const source of ["live", copyA]) {
    await sheet(page, source)
      .getByRole("button", { name: longTitle, exact: true })
      .click();
    await expect(
      detail(page).getByRole("tab", { name: "문서 1", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  const main = await get(page, `/tasks/${taskId}/documents/main`);
  await send(
    page,
    `/tasks/${taskId}/documents/main`,
    { expectedRevision: main.revision },
    "DELETE",
  );
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/document-browser/tasks?") &&
      new URL(response.url()).searchParams.get("source") === "live",
  );
  await page.locator(".document-browser-refresh").click();
  await refreshed;
  await sheet(page)
    .getByRole("button", { name: longTitle, exact: true })
    .click();
  await expect(
    detail(page).getByRole("tab", { name: "설계 노트", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("팀원 선택창을 반복해서 열고 닫아도 문서 본문 위치가 유지된다", async ({
  page,
}) => {
  await openBrowser(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
  for (const source of ["live", copyA]) {
    await page.setViewportSize({ width: 1366, height: 900 });
    await openDocument(page, source);
    const trigger = detail(page).locator('[data-property="owner"] button');
    const editor = rich(page);
    await expect(editor).toContainText(
      source === "live" ? "원본에서 읽는 본문" : "접힌 사본의 바다별",
    );
    for (const width of [1366, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          detail(page)
            .getByRole("textbox", { name: "작업 편집", exact: true })
            .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
        )
        .toBe(true);
      const before = (await editor.boundingBox())!;
      const scroll = detail(page).locator(".document-browser-detail-scroll");
      const scrollTop = await scroll.evaluate((el) => el.scrollTop);
      for (let i = 0; i < 3; i++) {
        await trigger.click();
        await expect(
          page.getByRole("listbox", { name: "팀원 편집", exact: true }),
        ).toBeVisible();
        expect((await editor.boundingBox())!.y).toBeCloseTo(before.y, 1);
        expect(await scroll.evaluate((el) => el.scrollTop)).toBe(scrollTop);
        await trigger.click();
        await expect(
          page.getByRole("listbox", { name: "팀원 편집", exact: true }),
        ).toHaveCount(0);
        expect((await editor.boundingBox())!.y).toBeCloseTo(before.y, 1);
        expect(await scroll.evaluate((el) => el.scrollTop)).toBe(scrollTop);
      }
    }
  }
  expect(writes).toEqual([]);
});

test("목록 펼침과 자동 저장은 해당 원본·사본만 갱신하고 목록 위치를 유지한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 600 });
  await openBrowser(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/document-browser/tasks")
      requests.push(url.searchParams.get("source")!);
    if (url.pathname === "/api/document-browser/sources")
      requests.push("sources");
  });
  for (const source of [copyA, copyB]) {
    requests.length = 0;
    await sheet(page, source)
      .locator(".document-browser-source-toggle")
      .click();
    await expect(
      sheet(page, source).locator(".document-browser-task-toggle"),
    ).toHaveCount(2);
    expect(requests).toEqual([source]);
  }
  for (const source of ["live", copyA]) {
    if (source === copyA) {
      await page
        .getByRole("searchbox", { name: "작업 이름 검색" })
        .fill("서비스 사용성");
      await expect(page.locator(".document-browser-search-status")).toHaveText(
        "검색 결과 · 작업 3개 · 문서 6개",
      );
    }
    await openDocument(page, source);
    await markdown(page);
    const row = sheet(page, source).getByRole("button", {
      name: "문서 1",
      exact: true,
    });
    await tree(page).evaluate((el) => {
      el.scrollTop = 20;
    });
    const node = (await row.elementHandle())!;
    const before = (await row.boundingBox())!;
    const scrollTop = await tree(page).evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const status = await page
      .locator(".document-browser-search-status")
      .textContent();
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const pattern = "**/api/document-browser/tasks?**";
    await page.route(pattern, async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("source") === source
      ) {
        requested();
        await pending;
      }
      await route.continue();
    });
    requests.length = 0;
    const text = `${source}에서만 갱신하는 본문`;
    try {
      await raw(page).fill(text);
      await intercepted;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await node.evaluate((el) => el.isConnected)).toBe(true);
      expect((await row.boundingBox())!.y).toBeCloseTo(before.y, 1);
      expect(await tree(page).evaluate((el) => el.scrollTop)).toBe(scrollTop);
      await expect(row).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".document-browser-search-status")).toHaveText(
        status || "",
      );
    } finally {
      release();
    }
    await expect(
      sheet(page, source)
        .getByRole("button", { name: "문서 1", exact: true })
        .locator(".document-browser-document-preview"),
    ).toHaveText(text);
    await page.unroute(pattern);
    expect(requests).toEqual(["sources", source]);
  }
  requests.length = 0;
  const responses = Promise.all(
    ["live", copyA, copyB].map((source) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/document-browser/tasks" &&
          url.searchParams.get("source") === source
        );
      }),
    ),
  );
  await page.locator(".document-browser-refresh").click();
  await responses;
  expect(requests.sort()).toEqual(["sources", "live", copyA, copyB].sort());
});

test("긴 제목·묶음 보기·분할 너비 기억·좁은 화면 목록 전환", async ({
  page,
}, info) => {
  const previewText =
    "긴 문서 내용도 제목 오른쪽에 한 줄로 표시되어야 합니다. ".repeat(20);
  await send(
    page,
    `/tasks/${taskId}/documents/main`,
    {
      markdown: `# 한 줄 미리보기\n\n${previewText}`,
      expectedRevision: 1,
      operationId: randomUUID(),
    },
    "PUT",
  );
  await openBrowser(page);
  await page.getByLabel("문서 묶음 보기").selectOption("owner");
  await expect(
    sheet(page)
      .locator(".document-browser-group-toggle")
      .filter({ hasText: "미입력" }),
  ).toBeVisible();
  const title = sheet(page).getByTitle(longTitle, { exact: true });
  await expect(title).toBeVisible();
  expect(
    await title.evaluate(
      (el) =>
        el.scrollWidth > el.clientWidth &&
        el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) + 1,
    ),
  ).toBeTruthy();
  const width = (await tree(page).boundingBox())!.width;
  expect(width).toBeGreaterThan(1366 * 0.33);
  const divider = page.getByRole("separator", { name: "탐색 영역 너비" });
  await divider.focus();
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await openDocument(page);
  const preview = sheet(page)
    .getByRole("button", { name: "문서 1", exact: true })
    .locator(".document-browser-document-preview");
  await expect(preview).toContainText("한 줄 미리보기 긴 문서 내용도");
  const singleLinePreview = () =>
    preview.evaluate((el) => {
      const title = el.previousElementSibling!.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        bounds.x >= title.right &&
        Math.abs(bounds.y - title.y) < 1 &&
        el.scrollWidth > el.clientWidth &&
        style.textOverflow === "ellipsis" &&
        el.clientHeight <= parseFloat(style.lineHeight) + 1
      );
    });
  expect(await singleLinePreview()).toBeTruthy();
  const fullTitle = detail(page).getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  await expect
    .poll(() =>
      fullTitle.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    )
    .toBeTruthy();
  mkdirSync("docs/validation/document-browser", { recursive: true });
  if (info.project.name === "chromium")
    await page.screenshot({
      path: "docs/validation/document-browser/desktop.png",
    });
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  await openBrowser(page);
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tree(page)).toBeVisible();
  await openDocument(page);
  await expect(tree(page)).not.toBeVisible();
  await expect(detail(page)).toBeVisible();
  await expect
    .poll(() =>
      fullTitle.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    )
    .toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  if (info.project.name === "chromium")
    await page.screenshot({
      path: "docs/validation/document-browser/mobile-detail.png",
    });
  await detail(page).getByRole("button", { name: "목록으로" }).click();
  await expect(tree(page)).toBeVisible();
  expect(await singleLinePreview()).toBeTruthy();
  if (info.project.name === "chromium")
    await page.screenshot({
      path: "docs/validation/document-browser/mobile-list.png",
    });
});

test("문서 저장 실패 시 작업·검색·분류·닫기 이동을 막고 입력을 유지한다", async ({
  page,
}) => {
  await openBrowser(page);
  await openDocument(page);
  await markdown(page);
  await page.route(`**/api/tasks/${taskId}/documents/main`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "검증용 저장 실패" }),
        })
      : route.continue(),
  );
  await raw(page).fill("저장 실패 중 보존할 입력");
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  await expect(
    page.getByText("검증용 저장 실패", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true })
    .click();
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  await expect(page).toHaveURL(/\/documents$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  await expect(
    page.getByText("저장을 완료하지 못했습니다.", { exact: false }),
  ).toBeVisible();
  await sheet(page)
    .getByRole("button", { name: "다른 문서 작업", exact: true })
    .click();
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  await expect(
    detail(page).getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue(longTitle);
  for (const name of ["이전 연도", "다음 연도"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByLabel("문서 브라우저 연도")).toHaveValue("2026");
    await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  }
  await page.getByLabel("문서 브라우저 연도").selectOption("2025");
  await expect(page.getByLabel("문서 브라우저 연도")).toHaveValue("2026");
  const otherTeam = (await get(page, "/bootstrap")).teams.find(
    (team: { id: string }) => team.id !== teamId,
  ).id;
  await page.getByLabel("팀 선택", { exact: true }).selectOption(otherTeam);
  await expect(page.getByLabel("팀 선택", { exact: true })).toHaveValue(teamId);
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  for (const name of ["변경 이력", "설정"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  }
  let logoutRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/logout")) logoutRequests++;
  });
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "로그아웃", exact: true }),
  ).toBeEnabled();
  expect(logoutRequests).toBe(0);
  await expect(raw(page)).toHaveValue("저장 실패 중 보존할 입력");
  await page.keyboard.press("Escape");
  await page.getByLabel("문서 묶음 보기").selectOption("owner");
  await expect(page.getByLabel("문서 묶음 보기")).toHaveValue("");
  await page
    .getByRole("searchbox", { name: "작업 이름 검색" })
    .fill("다른 문서");
  await expect(
    page.getByText("저장을 완료하지 못했습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(2);
  await page.unroute(`**/api/tasks/${taskId}/documents/main`);
  await detail(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "저장 실패 중 보존할 입력",
  );
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "문서 브라우저", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
});

test("뒤로가기 전에 문서 입력을 저장하고 앞으로가기로 다시 연다", async ({
  page,
}) => {
  await openBrowser(page);
  await openDocument(page);
  await markdown(page);
  await raw(page).fill("브라우저 뒤로가기 직전에 수정한 본문");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "브라우저 뒤로가기 직전에 수정한 본문",
  );
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "문서 브라우저", exact: true }),
  ).toBeVisible();
  await openDocument(page);
  await expect(rich(page)).toContainText(
    "브라우저 뒤로가기 직전에 수정한 본문",
  );
});

test("문서 연도 이동은 이어지는 달력과 무관하게 한 해만 조회하고 저장 후 통계를 갱신한다", async ({
  page,
}) => {
  const nextId = (
    await send(page, "/tasks", {
      teamId,
      year: 2027,
      fields: { title: "다음 해 전용 업무" },
    })
  ).task.id;
  await send(
    page,
    `/tasks/${nextId}/documents/main`,
    {
      markdown: "다음연도전용검색어",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
    "PUT",
  );
  const nextCopy = (
    await send(page, "/reports", {
      teamId,
      year: 2027,
      name: "다음 연도 사본",
      referenceDate: "2027-01-01",
      view: defaultView(2027),
      taskIds: [nextId],
    })
  ).id;
  await page
    .getByRole("button", { name: "다음 달로 이동", exact: true })
    .click();
  await expect(page.locator(`[data-cell="${nextId}:title"]`)).toBeVisible();
  await openBrowser(page);
  const year = page.getByLabel("문서 브라우저 연도");
  const summary = page.getByRole("group", { name: "선택한 연도 문서 통계" });
  await expect(year).toHaveValue("2026");
  await expect(page.getByLabel("문서 브라우저 원본 범위")).toHaveCount(0);
  await expect(summary).toHaveText("전체 문서 12문서 보유 작업 6사본 2");
  await expect(sheet(page, nextCopy)).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "작업 이름 검색" })
    .fill("다음 해 전용");
  await expect(
    page.getByText("검색 결과가 없습니다. 다른 검색어나 범위를 선택하세요."),
  ).toBeVisible();
  await expect(summary).toHaveText("전체 문서 12문서 보유 작업 6사본 2");
  await page.getByRole("searchbox", { name: "작업 이름 검색" }).fill("");
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(2);
  await openDocument(page);
  await markdown(page);
  await raw(page).fill("연도 이동 전에 저장한 원본 문서");
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(year).toHaveValue("2027");
  await expect(page.getByLabel("문서 검색 범위")).toHaveValue("live");
  await expect(summary).toHaveText("전체 문서 2문서 보유 작업 2사본 1");
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "연도 이동 전에 저장한 원본 문서",
  );
  await expect(sheet(page, copyA)).toHaveCount(0);
  await expect(sheet(page, nextCopy)).toHaveCount(0);
  await page.getByLabel("문서 검색 범위").selectOption("all");
  await expect(
    sheet(page, nextCopy).locator(".document-browser-source-toggle"),
  ).toContainText("문서 보유 작업 1개 · 문서 1개");
  await sheet(page).locator(".document-browser-task-toggle").click();
  await sheet(page)
    .getByRole("button", { name: "문서 1", exact: true })
    .click();
  await expect(rich(page)).toContainText("다음연도전용검색어");
  await page.getByRole("button", { name: "이전 연도", exact: true }).click();
  await expect(year).toHaveValue("2026");
  await expect(summary).toHaveText("전체 문서 12문서 보유 작업 6사본 2");
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(2);
  await openDocument(page);
  await expect(rich(page)).toContainText("연도 이동 전에 저장한 원본 문서");
});

test("문서 제목 변경·추가·삭제와 사본 속성 변경은 탐색과 집계에 반영된다", async ({
  page,
}) => {
  await openBrowser(page);
  const owner = (source: string) =>
    sheet(page, source)
      .locator(".document-browser-task")
      .filter({ hasText: longTitle })
      .locator(".document-browser-owner");
  await expect(owner("live")).toHaveAttribute("aria-label", "담당자: 지윤");
  await expect(
    sheet(page)
      .locator(".document-browser-task")
      .filter({ hasText: "다른 문서 작업" })
      .locator(".document-browser-owner"),
  ).toHaveAttribute("aria-label", "담당자: 미지정");
  await openDocument(page, copyA);
  await expect(owner(copyA)).toHaveAttribute("aria-label", "담당자: 지윤");
  await detail(page)
    .getByRole("button", { name: "팀원 수정", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "지윤", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "선택 안 함", exact: true }).click();
  await expect(owner(copyA)).toHaveAttribute("aria-label", "담당자: 미지정");
  await expect(owner("live")).toHaveAttribute("aria-label", "담당자: 지윤");
  await detail(page)
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .fill("사본에서 바꾼 작업 이름");
  await detail(page)
    .getByRole("textbox", { name: "작업 편집", exact: true })
    .press("Tab");
  await expect(
    sheet(page, copyA).getByText("사본에서 바꾼 작업 이름", { exact: true }),
  ).toBeVisible();
  await detail(page)
    .getByRole("tab", { name: "문서 1", exact: true })
    .dblclick();
  const titleInput = detail(page).getByRole("textbox", {
    name: "문서 제목",
    exact: true,
  });
  await titleInput.fill("변경한 문서 제목");
  await titleInput.press("Enter");
  await expect(
    sheet(page, copyA).getByText("변경한 문서 제목", { exact: true }),
  ).toBeVisible();
  await detail(page)
    .getByRole("button", { name: "문서 추가", exact: true })
    .click();
  await expect(
    sheet(page, copyA).locator(".document-browser-source-toggle"),
  ).toContainText("문서 5개");
  await expect(
    sheet(page).locator(".document-browser-source-toggle"),
  ).toContainText("문서 4개");
  await detail(page)
    .getByRole("button", { name: "문서 메뉴", exact: true })
    .click();
  await detail(page)
    .getByRole("menuitem", { name: "문서 삭제", exact: true })
    .click();
  await detail(page)
    .getByRole("button", { name: "문서 삭제", exact: true })
    .click();
  await expect(
    sheet(page, copyA).locator(".document-browser-source-toggle"),
  ).toContainText("문서 4개");
  const report = await get(page, `/reports/${copyA}`);
  expect(
    report.tasks.find((task: { id: string }) => task.id === taskId).cells.title
      .value,
  ).toBe("사본에서 바꾼 작업 이름");
  expect(
    (
      await get(
        page,
        `/document-browser/task?teamId=${teamId}&year=2026&source=live&taskId=${taskId}`,
      )
    ).task.cells.title.value,
  ).toBe(longTitle);
});

test("기본 범위는 원본이고 작업의 프로필 사진과 사본의 다른 담당자 아바타를 표시한다", async ({
  page,
}) => {
  const avatarImage = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#3467bc";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png");
  });
  const { user } = await send(page, "/admin/users", {
    username: `avatar-${randomUUID()}@example.com`,
    password: "local-test-only-password",
    name: "아바타 팀원",
    color: "#3467bc",
    avatarInitials: "M1",
    avatarImage,
    memberships: [{ teamId, role: "member" }],
  });
  const current = await get(
    page,
    `/document-browser/task?teamId=${teamId}&year=2026&source=live&taskId=${taskId}`,
  );
  await send(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId,
        key: "owner",
        value: user.id,
        expectedVersion: current.task.cells.owner.version,
      },
    ],
  });
  await openBrowser(page, "live");
  await expect(tree(page).locator(".document-browser-source")).toHaveCount(1);
  const owner = sheet(page).getByRole("img", {
    name: "담당자: 아바타 팀원",
    exact: true,
  });
  await expect(owner.locator("img")).toHaveAttribute("src", avatarImage);
  await expect(owner.locator(".document-browser-owner-name")).toHaveText(
    "아바타 팀원",
  );
  const count = owner.locator("..").locator(".document-browser-document-count");
  await expect(count).toHaveText("2");
  await expect(count.locator("svg")).toBeVisible();
  await expect(count).toHaveAttribute("aria-label", "등록된 문서 2개");
  await expect
    .poll(() =>
      owner.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByLabel("문서 검색 범위").selectOption("all");
  await openDocument(page, copyA);
  await expect(
    sheet(page, copyA)
      .getByRole("img", { name: "담당자: 지윤", exact: true })
      .locator(".avatar"),
  ).toHaveText("지");
  await expect(owner.locator("img")).toHaveAttribute("src", avatarImage);
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  await openBrowser(page, "live");
  await expect(tree(page).locator(".document-browser-source")).toHaveCount(1);
});

test("열람자는 원본과 사본을 읽지만 속성·문서를 수정하지 못한다", async ({
  page,
}) => {
  const username = `browser-viewer-${randomUUID()}@example.com`;
  await send(page, "/admin/users", {
    username,
    password: "local-test-only-password",
    name: "열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await send(page, "/auth/login", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await openBrowser(page);
  for (const source of ["live", copyA]) {
    await openDocument(page, source);
    await expect(rich(page)).toHaveAttribute("contenteditable", "false");
    await expect(
      detail(page).getByRole("textbox", { name: "작업 편집", exact: true }),
    ).toHaveJSProperty("readOnly", true);
    await expect(
      detail(page).getByRole("button", { name: "문서 추가", exact: true }),
    ).toHaveCount(0);
  }
});

test("검색 중·오류·결과 없음과 문서 없는 연도 상태", async ({ page }, info) => {
  await openBrowser(page);
  await page.route("**/api/document-browser/tasks?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "실패")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "검색 서버 오류" }),
      });
    await route.continue();
  });
  await page.getByRole("searchbox", { name: "작업 이름 검색" }).fill("실패");
  await expect(tree(page).getByRole("alert").first()).toContainText(
    "검색 서버 오류",
  );
  await page
    .getByRole("searchbox", { name: "작업 이름 검색" })
    .fill("존재하지않는문구");
  await expect(
    page.getByText("검색 결과가 없습니다. 다른 검색어나 범위를 선택하세요."),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "작업 이름 검색" }).fill("");
  await page.getByLabel("문서 브라우저 연도").selectOption("2025");
  await expect(
    page.getByText(
      "등록된 문서가 없습니다. 연간 업무의 작업 상세에서 문서를 작성해 보세요.",
    ),
  ).toBeVisible();
  if (info.project.name === "chromium")
    await page.screenshot({
      path: "docs/validation/document-browser/empty.png",
    });
});

test("사본 속성 저장 실패와 응답 유실은 입력을 보존하고 같은 요청으로 재시도한다", async ({
  page,
}) => {
  await openBrowser(page);
  await openDocument(page, copyA);
  let fail = true;
  await page.route(`**/api/reports/${copyA}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (fail) {
      fail = false;
      await route.fetch(); // The server committed, but the browser lost the response.
      return route.abort("failed");
    }
    return route.continue();
  });
  const title = detail(page).getByRole("textbox", {
    name: "작업 편집",
    exact: true,
  });
  await title.fill("응답 유실 뒤 복구한 제목");
  await title.press("Tab");
  await expect(detail(page).locator(".task-property-error")).toBeVisible();
  await detail(page)
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await expect(detail(page).locator(".task-property-error")).toHaveCount(0);
  await expect(
    sheet(page, copyA).getByText("응답 유실 뒤 복구한 제목", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  expect(
    (await get(page, `/reports/${copyA}`)).tasks.find(
      (t: { id: string }) => t.id === taskId,
    ).cells.title.value,
  ).toBe("응답 유실 뒤 복구한 제목");
});

test("목록 조회 뒤 삭제된 문서를 선택해도 다른 문서로 바뀌지 않는다", async ({
  page,
}) => {
  await openBrowser(page);
  await sheet(page)
    .locator(".document-browser-task")
    .filter({ hasText: longTitle })
    .locator(".document-browser-task-toggle")
    .click();
  const doc = await get(page, `/tasks/${taskId}/documents/${documentId}`);
  await send(
    page,
    `/tasks/${taskId}/documents/${documentId}`,
    { expectedRevision: doc.revision },
    "DELETE",
  );
  await sheet(page)
    .getByRole("button", { name: "설계 노트", exact: true })
    .click();
  await expect(
    detail(page).getByText("선택한 문서를 찾을 수 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(rich(page)).toHaveCount(0);
  await detail(page).getByRole("tab", { name: "문서 1", exact: true }).click();
  await expect(rich(page)).toContainText("원본에서 읽는");
});

test("큰 목록의 다음 페이지와 편집 뒤 갱신은 이미 펼친 작업을 유지한다", async ({
  page,
}) => {
  for (let n = 0; n < 40; n++) {
    const id = (
      await send(page, "/tasks", {
        teamId,
        year: 2026,
        fields: { title: `페이지 작업 ${String(n).padStart(2, "0")}` },
      })
    ).task.id;
    await send(
      page,
      `/tasks/${id}/documents/main`,
      { markdown: `본문 ${n}`, expectedRevision: 0, operationId: randomUUID() },
      "PUT",
    );
  }
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(40);
  await sheet(page)
    .getByRole("button", { name: "다음 작업 더 보기", exact: false })
    .click();
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(42);
  const last = sheet(page)
    .locator(".document-browser-task")
    .filter({ hasText: "페이지 작업 39" });
  await last.locator(".document-browser-task-toggle").click();
  await last.getByRole("button", { name: "문서 1", exact: true }).click();
  await expect(rich(page)).toContainText("본문 39");
  await markdown(page);
  await raw(page).fill("마지막 페이지에서 편집함");
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(
    sheet(page).locator(".document-browser-task-toggle"),
  ).toHaveCount(42);
  await expect(
    last.getByRole("button", { name: "문서 1", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});

test("공통 상단의 팀 선택은 저장 후 목록·테마를 바꾸고 연간 업무에서도 유지한다", async ({
  page,
}) => {
  const boot = await get(page, "/bootstrap");
  const other = (
    await send(page, "/admin/teams", {
      name: `다른 테마 팀 ${randomUUID().slice(0, 5)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  const settings = (await get(page, "/bootstrap")).teams.find(
    (team: { id: string }) => team.id === other,
  ).settings;
  await send(
    page,
    `/teams/${other}`,
    {
      name: "다른 테마 팀",
      theme: "rose",
      settingsRevision: settings.revision,
    },
    "PATCH",
  );
  await page.reload();
  await expect(page.getByLabel("팀 선택", { exact: true })).toHaveValue(teamId);
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  const teamPosition = await page
    .getByLabel("팀 선택", { exact: true })
    .boundingBox();
  await openBrowser(page);
  await expect(page.locator("header.topbar")).toHaveCount(1);
  const picker = page
    .locator("header.topbar")
    .getByLabel("팀 선택", { exact: true });
  await expect(picker).toHaveCount(1);
  expect(await picker.boundingBox()).toEqual(teamPosition);
  await openDocument(page);
  await markdown(page);
  await raw(page).fill("공통 팀 선택으로 이동하기 전에 저장할 문서");
  await picker.selectOption(other);
  await expect(picker).toHaveValue(other);
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "공통 팀 선택으로 이동하기 전에 저장할 문서",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose");
  await expect(
    page.getByText("등록된 문서가 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    sheet(page).locator(".document-browser-source-toggle"),
  ).toContainText("문서 보유 작업 0개");
  await page.getByRole("button", { name: "연간 업무로 돌아가기" }).click();
  await expect(
    page.getByRole("heading", { name: "연간 업무", exact: true }),
  ).toBeVisible();
  await expect(picker).toHaveValue(other);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose");
  await picker.selectOption(teamId);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    originalTheme!,
  );
});

test("공통 메뉴는 문서 저장 후 열리고 표 단축키가 문서 화면에 간섭하지 않는다", async ({
  page,
}) => {
  const cell = page.locator(`[data-cell="${secondId}:title"]`);
  await cell.dblclick();
  const editor = page
    .locator(".inline-editor textarea,.inline-editor input")
    .first();
  await editor.fill("공통 메뉴 검증 업무");
  await editor.press("Enter");
  await expect(cell).toContainText("공통 메뉴 검증 업무");
  await openBrowser(page);
  const divider = page.getByRole("separator", { name: "탐색 영역 너비" });
  await divider.focus();
  await divider.press("ControlOrMeta+z");
  expect(
    (
      await get(
        page,
        `/document-browser/task?teamId=${teamId}&year=2026&source=live&taskId=${secondId}`,
      )
    ).task.cells.title.value,
  ).toBe("공통 메뉴 검증 업무");
  await openDocument(page);
  await markdown(page);
  await raw(page).fill("설정을 열기 전에 저장할 문서");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "설정", exact: true });
  await expect(settings).toBeVisible();
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "설정을 열기 전에 저장할 문서",
  );
  await settings.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  const history = page.getByRole("dialog", { name: "변경 이력", exact: true });
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("menuitem", { name: "프로필", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "프로필", exact: true });
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(raw(page)).toHaveValue("설정을 열기 전에 저장할 문서");
  expect(
    (
      await get(
        page,
        `/document-browser/task?teamId=${teamId}&year=2026&source=live&taskId=${secondId}`,
      )
    ).task.cells.title.value,
  ).toBe("공통 메뉴 검증 업무");
  await raw(page).fill("로그아웃 전에 저장할 문서");
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  await send(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  expect((await get(page, `/tasks/${taskId}/documents/main`)).markdown).toBe(
    "로그아웃 전에 저장할 문서",
  );
});
