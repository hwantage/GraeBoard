import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
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
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "보고서 스냅샷", exact: true })
    .getByRole("button", { name: /독립 편집 보고본/ })
    .click();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
}

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
      name: "독립 편집 보고본",
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

test("보고본 서식 툴바는 수정 전 선택 영역을 유지하고 배경색·테두리를 보고본에만 저장한다", async ({
  page,
}, info) => {
  const live = await get(page, `/tasks?teamId=${teamId}&year=2026`);
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  await expect(toolbar).toBeVisible();
  await openReport(page);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  const background = page.getByLabel("배경색", { exact: true });
  const borders = page.getByRole("button", { name: "테두리", exact: true });
  await first.click();
  await second.click({ modifiers: ["Shift"] });
  await expect(page.getByRole("gridcell", { selected: true })).toHaveCount(2);
  await expect(toolbar).toHaveCount(0);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await expect(toolbar).toBeVisible();
  const bannerBox = (await page
    .locator(".active-report-banner")
    .boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(bannerBox.y).toBeCloseTo(toolbarBox.y + toolbarBox.height, 0);
  await expect(background).toBeEnabled();
  await expect(borders).toBeEnabled();
  await expect(page.locator(".selection-label")).toHaveText("2개 셀");
  await background.fill("#fff4aa");
  for (const target of [first, second])
    await expect(target).toHaveCSS("background-color", "rgb(255, 244, 170)");
  await borders.click();
  await page
    .getByLabel("테두리 선 스타일", { exact: true })
    .selectOption("double");
  await page.getByLabel("테두리 선 색상", { exact: true }).fill("#2255aa");
  await page.getByRole("button", { name: "모든 테두리", exact: true }).click();
  for (const target of [first, second]) {
    await expect(target).toHaveCSS("border-bottom-style", "double");
    await expect(target).toHaveCSS("border-bottom-color", "rgb(34, 85, 170)");
  }
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(first).not.toHaveCSS("border-bottom-style", "double");
  await expect(background).toBeEnabled();
  await expect(borders).toBeEnabled();
  await expect(page.locator(".selection-label")).toHaveText("2개 셀");
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(borders).toBeEnabled();
  await expect(first).toHaveCSS("border-bottom-style", "double");
  await page.getByRole("button", { name: "밑줄", exact: true }).click();
  await page.getByRole("button", { name: "취소선", exact: true }).click();
  for (const target of [first, second])
    await expect(target.locator(".cell-text")).toHaveCSS(
      "text-decoration-line",
      "underline line-through",
    );
  await page.screenshot({
    path: info.outputPath("report-format-toolbar.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "스냅샷 수정", exact: true }),
  ).toBeVisible();
  await expect(toolbar).toHaveCount(0);
  const saved = await get(page, `/reports/${reportId}`);
  for (const task of saved.tasks) {
    expect(cell(task, "title").style).toMatchObject({
      backgroundColor: "#fff4aa",
      borderBottom: { style: "double", color: "#2255aa" },
      underline: true,
      strike: true,
    });
    expect(cell(task, "owner").style.backgroundColor).not.toBe("#fff4aa");
  }
  expect((await get(page, `/tasks?teamId=${teamId}&year=2026`)).tasks).toEqual(
    live.tasks,
  );
  await page.getByRole("button", { name: "스냅샷 보기 종료" }).click();
  await expect(toolbar).toBeVisible();
  await openReport(page);
  await expect(toolbar).toHaveCount(0);
  for (const target of [first, second]) {
    await expect(target).toHaveCSS("background-color", "rgb(255, 244, 170)");
    await expect(target).toHaveCSS("border-bottom-style", "double");
    await expect(target.locator(".cell-text")).toHaveCSS(
      "text-decoration-line",
      "underline line-through",
    );
  }
});

test("보고본 서식 툴바는 선택 없이 수정에 진입해도 첫 셀에서 사용할 수 있다", async ({
  page,
}) => {
  const username = `report-format-lead-${randomUUID()}@example.com`;
  await post(page, "/admin/users", {
    username,
    name: "보고본 서식 팀장",
    password: "report-format-password",
    active: true,
    memberships: [{ teamId, role: "lead" }],
  });
  await post(page, "/auth/login", {
    username,
    password: "report-format-password",
  });
  await page.reload();
  await page.getByLabel("팀 선택").selectOption(teamId);
  await openReport(page);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  const second = page.locator(`[data-cell="${taskIds[1]}:title"]`);
  const background = page.getByLabel("배경색", { exact: true });
  await expect(page.locator(".format-toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await expect(background).toBeEnabled();
  await expect(page.locator(".selection-label")).toHaveText("1행 · 작업");
  await background.fill("#d1eee6");
  await expect(first).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await expect(second).not.toHaveCSS("background-color", "rgb(209, 238, 230)");
  await page.getByRole("button", { name: "작업 열 선택", exact: true }).click();
  await background.fill("#fff4aa");
  for (const target of [first, second])
    await expect(target).toHaveCSS("background-color", "rgb(255, 244, 170)");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(background).toBeEnabled();
  await expect(page.locator(".selection-label")).toHaveText("1개 열 · 2개 셀");
  await expect(first).toHaveCSS("background-color", "rgb(209, 238, 230)");
  await expect(second).not.toHaveCSS("background-color", "rgb(255, 244, 170)");
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  await expect(first).not.toHaveCSS("background-color", "rgb(209, 238, 230)");
  await expect(page.locator(".format-toolbar")).toHaveCount(0);
});

test("보고본 편집은 과거 속성 수정·업무 추가·삭제·실행취소를 저장하고 원본과 이전 필터를 유지한다", async ({
  page,
}, info) => {
  let settings = (await get(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  settings.properties = settings.properties.filter(
    (p: any) => p.id !== "legacy",
  );
  settings.properties.push({
    id: "new_field",
    name: "새 메모",
    kind: "text",
    display: "text",
    visible: true,
    values: [],
  });
  expect(
    (
      await page.request.patch(`/api/teams/${teamId}/settings`, {
        headers,
        data: settings,
      })
    ).ok(),
  ).toBeTruthy();
  const live = await get(page, `/tasks?teamId=${teamId}&year=2026`);
  const filters = await get(page, `/filters?teamId=${teamId}`);
  await openReport(page);
  await expect(
    page.getByRole("button", { name: "저장된 필터", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveAttribute(
    "aria-readonly",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "스냅샷 보기 종료" }),
  ).toBeDisabled();
  await expect(page.getByLabel("팀 선택")).toBeDisabled();
  await edit(page, taskIds[0], "legacy", "원본에서 삭제된 속성도 수정");
  await edit(page, taskIds[0], "title", "보고본에서만 바뀐 제목");
  await page
    .locator(".format-toolbar")
    .getByRole("button", { name: "스냅샷에 업무 추가", exact: true })
    .click();
  await page.locator(".inline-editor textarea").fill("보고용 새 업무");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect(
    page.getByRole("gridcell", { name: "보고용 새 업무", exact: true }),
  ).toBeVisible();
  await rowAction(page, taskIds[1], "행 삭제");
  await expect(page.locator(`[data-cell="${taskIds[1]}:title"]`)).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[1]}:title"]`)).toBeVisible();
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[1]}:title"]`)).toHaveCount(
    0,
  );
  expect((await get(page, `/reports/${reportId}`)).tasks).toHaveLength(2);
  await page.screenshot({
    path: info.outputPath("report-editing.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "스냅샷 수정", exact: true }),
  ).toBeVisible();
  const saved = await get(page, `/reports/${reportId}`);
  expect(saved.tasks.map((t: any) => t.cells.title.value)).toEqual([
    "보고본에서만 바뀐 제목",
    "보고용 새 업무",
  ]);
  expect(saved.tasks[0].cells.legacy.value).toBe("원본에서 삭제된 속성도 수정");
  expect(saved.settings.properties.some((p: any) => p.id === "new_field")).toBe(
    false,
  );
  expect((await get(page, `/tasks?teamId=${teamId}&year=2026`)).tasks).toEqual(
    live.tasks,
  );
  expect(await get(page, `/filters?teamId=${teamId}`)).toEqual(filters);
  await page.getByRole("button", { name: "스냅샷 보기 종료" }).click();
  await expect(
    page.getByRole("region", { name: "필터 보기", exact: true }),
  ).toContainText("돌아갈 필터");
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "보고 전 첫 업무",
  );
  await openReport(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "보고본에서만 바뀐 제목",
  );
  await page.reload();
  await openReport(page);
  await expect(
    page.getByRole("gridcell", { name: "보고용 새 업무", exact: true }),
  ).toBeVisible();
});

test("보고본 편집은 행 복사·서식·붙여넣기를 취소하거나 저장 실패 뒤 다시 저장할 수 있다", async ({
  page,
}) => {
  const before = await get(page, `/reports/${reportId}`);
  await openReport(page);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await rowAction(page, taskIds[0], "복사");
  await edit(page, taskIds[0], "title", "복사 이후 바뀐 원본 행");
  await rowAction(page, taskIds[1], "복사한 행 붙여넣기");
  await expect(page.locator('[data-column="title"]')).toHaveCount(3);
  await expect(page.locator('[data-column="title"]').last()).toHaveText(
    "보고 전 첫 업무",
  );
  const copiedId = await page
    .locator('[data-column="title"]')
    .last()
    .getAttribute("data-task-id");
  await page.locator(`[data-row-id="${copiedId}"] .row-select`).click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await page.locator(`[data-cell="${copiedId}:title"]`).click();
  await page.getByRole("grid").evaluate((el) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], getData: () => "붙여넣은 보고 제목" },
    });
    el.dispatchEvent(event);
  });
  await expect(page.locator(`[data-cell="${copiedId}:title"]`)).toHaveText(
    "붙여넣은 보고 제목",
  );
  let attempts = 0;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      attempts++;
      if (attempts === 1) return route.abort();
      if (attempts === 2) {
        await route.fetch();
        return route.abort();
      }
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(`[data-cell="${copiedId}:title"]`)).toHaveText(
    "붙여넣은 보고 제목",
  );
  expect(await get(page, `/reports/${reportId}`)).toEqual(before);
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "변경 저장", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await get(page, `/reports/${reportId}`)).tasks).toHaveLength(3);
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "스냅샷 수정", exact: true }),
  ).toBeVisible();
  const saved = await get(page, `/reports/${reportId}`);
  expect(
    cell(
      saved.tasks.find((t: any) => t.id === copiedId),
      "title",
    ).style.bold,
  ).toBe(true);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await edit(page, taskIds[0], "title", "취소할 수정");
  await rowAction(page, taskIds[1], "행 삭제");
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "복사 이후 바뀐 원본 행",
  );
  await expect(page.locator(`[data-cell="${taskIds[1]}:title"]`)).toBeVisible();
  expect(await get(page, `/reports/${reportId}`)).toEqual(saved);
});

test("보고본 편집은 과거 팀원과 현재 팀원을 선택하고 입력 중 저장 버튼으로 확정한다", async ({
  page,
}) => {
  const boot = await get(page, "/bootstrap");
  const current = (
    await post(page, "/admin/users", {
      username: `report-member-${randomUUID()}@example.com`,
      name: "새로 배정할 팀원",
      password: "report-editing-password",
      active: true,
      memberships: [{ teamId, role: "member" }],
    })
  ).user;
  expect(
    (
      await page.request.put(`/api/teams/${teamId}/members`, {
        headers,
        data: { members: [{ userId: current.id, role: "member" }] },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await openReport(page);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  const choose = async (taskId: string, name: string) => {
    await page.locator(`[data-cell="${taskId}:owner"]`).dblclick();
    await page
      .getByRole("listbox", { name: "팀원 편집", exact: true })
      .getByRole("option", { name, exact: true })
      .click();
  };
  await choose(taskIds[0], current.name);
  await choose(taskIds[0], boot.user.name);
  await choose(taskIds[1], current.name);
  await page.locator(`[data-cell="${taskIds[0]}:title"]`).dblclick();
  await page.locator(".inline-editor textarea").fill("입력 후 바로 저장");
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "스냅샷 수정", exact: true }),
  ).toBeVisible();
  const saved = await get(page, `/reports/${reportId}`);
  expect(saved.tasks[0].cells.owner.value).toBe(boot.user.id);
  expect(saved.tasks[1].cells.owner.value).toBe(current.id);
  expect(saved.tasks[0].cells.title.value).toBe("입력 후 바로 저장");
});

test("보고본 편집은 다른 사용자의 저장과 충돌하면 입력을 보존하고 덮어쓰지 않는다", async ({
  page,
}) => {
  await openReport(page);
  await page.getByRole("button", { name: "스냅샷 수정", exact: true }).click();
  await edit(page, taskIds[0], "title", "내가 수정 중인 보고본");
  const original = await get(page, `/reports/${reportId}`);
  const remote = await page.request.patch(`/api/reports/${reportId}`, {
    headers,
    data: {
      operationId: randomUUID(),
      revision: original.revision,
      operations: [
        {
          kind: "cells",
          at: new Date().toISOString(),
          changes: [
            {
              taskId: taskIds[0],
              key: "title",
              value: "다른 사용자가 저장한 보고본",
              expectedVersion: 0,
            },
          ],
        },
      ],
    },
  });
  expect(remote.ok(), await remote.text()).toBeTruthy();
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "다른 사용자가 보고본을 수정했습니다",
  );
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "내가 수정 중인 보고본",
  );
  expect(
    (await get(page, `/reports/${reportId}`)).tasks[0].cells.title.value,
  ).toBe("다른 사용자가 저장한 보고본");
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  await page.getByRole("button", { name: "스냅샷 보기 종료" }).click();
  await openReport(page);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
    "다른 사용자가 저장한 보고본",
  );
});
