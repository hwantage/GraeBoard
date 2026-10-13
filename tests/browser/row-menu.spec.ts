import { unpack } from "../../shared/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView, weeksForYear } from "../../shared/domain.js";

let teamId: string, taskIds: string[];
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post("/api" + path, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function menu(page: Page, id: string) {
  await page
    .locator(`[data-row-id="${id}"] .row-select`)
    .click({ button: "right" });
}
async function insert(page: Page, id: string, label: string) {
  await menu(page, id);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
    ),
    page.getByRole("menuitem", { name: label, exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json().then(unpack)).task;
}
async function editTitle(page: Page, id: string, text: string) {
  const cell = page.locator(`[data-cell="${id}:title"]`);
  if (!(await cell.getByRole("textbox").count())) await cell.dblclick();
  await cell.getByRole("textbox").fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    cell.getByRole("textbox").press("Enter"),
  ]);
  await expect(cell).toHaveText(text);
}
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
  teamId = (
    await post(page, "/admin/teams", {
      name: "행 메뉴 " + randomUUID().slice(0, 8),
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskIds = [];
  for (const title of ["첫 업무", "둘째 업무", "셋째 업무"]) {
    const result = await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title, "2026-12-07": "출시 검토" },
    });
    taskIds.push(result.task.id);
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toBeVisible();
});

test("행 메뉴는 위·아래 삽입과 복사 당시 행 붙여넣기·삭제 취소를 제공한다", async ({
  page,
}, info) => {
  await menu(page, taskIds[1]);
  await expect(
    page.getByRole("menuitem", { name: "복사한 행 붙여넣기", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const above = await insert(page, taskIds[1], "위에 삽입");
  await editTitle(page, above.id, "위 행");
  const below = await insert(page, taskIds[1], "아래에 삽입");
  await editTitle(page, below.id, "아래 행");
  const titles = page.locator('[data-column="title"]');
  await expect(titles).toHaveText([
    "첫 업무",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
  ]);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect(first).toHaveCSS("font-weight", "700");
  await menu(page, taskIds[0]);
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  await expect(titles).toHaveCount(5);
  await editTitle(page, taskIds[0], "원본 변경");
  await menu(page, taskIds[2]);
  await page.screenshot({ path: info.outputPath("row-menu.png") });
  await page.keyboard.press("Escape");
  const pasted = await insert(page, taskIds[2], "복사한 행 붙여넣기");
  const copy = page.locator(`[data-cell="${pasted.id}:title"]`);
  await expect(titles).toHaveText([
    "원본 변경",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
    "첫 업무",
  ]);
  await expect(copy).toHaveCSS("font-weight", "700");
  expect(pasted.cells["2026-12-07"].value).toBe("출시 검토");
  await menu(page, pasted.id);
  await page.getByRole("menuitem", { name: "행 삭제", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(copy).toHaveText("첫 업무");
  await page.reload();
  await expect(titles).toHaveText([
    "원본 변경",
    "위 행",
    "둘째 업무",
    "아래 행",
    "셋째 업무",
    "첫 업무",
  ]);
});

test("점선이 있는 행을 복사해 같은 행에서 붙여넣으면 내용과 서식을 그대로 보존한다", async ({
  page,
}) => {
  const sourceId = taskIds[0];
  const title = "디자인 시스템 컴포넌트 가이드 정리";
  const week = "2026-11-02";
  const { tasks } = await (
    await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
  )
    .json()
    .then(unpack);
  const source = tasks.find((task: any) => task.id === sourceId);
  const savedStyle = {
    borderTop: null,
    borderRight: { style: "dashed", color: "#856060" },
    borderBottom: null,
    borderLeft: null,
  };
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: sourceId,
        key: "title",
        expectedVersion: source.cells.title.version,
        value: title,
      },
      {
        taskId: sourceId,
        key: week,
        expectedVersion: 0,
        value: "컴포넌트 가이드 검토",
        style: savedStyle,
      },
    ],
  });
  await page.reload();
  await expect(page.locator(`[data-cell="${sourceId}:title"]`)).toHaveText(
    title,
  );
  await menu(page, sourceId);
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  const pasted = await insert(page, sourceId, "복사한 행 붙여넣기");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator('[data-column="title"]')).toHaveText([
    title,
    title,
    "둘째 업무",
    "셋째 업무",
  ]);
  expect(pasted.cells[week]).toMatchObject({
    value: "컴포넌트 가이드 검토",
    style: { borderRight: { style: "dashed", color: "#856060" } },
  });
  expect(pasted.defaultStyle).toEqual(source.defaultStyle);
  await page.reload();
  await expect(page.locator(`[data-cell="${pasted.id}:title"]`)).toHaveText(
    title,
  );
  const stored = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks.find((task: any) => task.id === pasted.id);
  expect(stored.cells).toEqual(pasted.cells);
  expect(stored.defaultStyle).toEqual(pasted.defaultStyle);
});

test("행 삽입·붙여넣기를 실행취소하고 같은 위치와 내용으로 재실행한다", async ({
  page,
}) => {
  const above = await insert(page, taskIds[1], "위에 삽입");
  const aboveTitle = page.locator(`[data-cell="${above.id}:title"]`);
  await aboveTitle.getByRole("textbox").press("Escape");
  const undo = page.getByRole("button", { name: "실행취소", exact: true });
  const redo = page.getByRole("button", { name: "재실행", exact: true });
  await undo.click();
  await expect(aboveTitle).toHaveCount(0);
  await redo.click();
  await expect(aboveTitle).toBeVisible();
  await expect(page.locator(".sheet-row").nth(1)).toHaveAttribute(
    "data-row-id",
    above.id,
  );
  await menu(page, taskIds[0]);
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  const pasted = await insert(page, taskIds[2], "복사한 행 붙여넣기");
  const pastedTitle = page.locator(`[data-cell="${pasted.id}:title"]`);
  await expect(pastedTitle).toHaveText("첫 업무");
  await undo.click();
  await expect(pastedTitle).toHaveCount(0);
  await undo.click();
  await expect(aboveTitle).toHaveCount(0);
  await redo.click();
  await expect(aboveTitle).toBeVisible();
  await redo.click();
  await expect(pastedTitle).toHaveText("첫 업무");
  const { tasks } = await (
    await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
  )
    .json()
    .then(unpack);
  expect(tasks.find((task: any) => task.id === pasted.id).cells).toEqual(
    pasted.cells,
  );
});

test("위·아래 삽입은 숨긴 열을 포함한 셀별 서식과 행 높이를 상속한다", async ({
  page,
}, info) => {
  const sourceId = taskIds[1];
  const source = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks.find((task: any) => task.id === sourceId);
  const border = { style: "solid", color: "#335577" };
  const common = {
    backgroundColor: "#ddedd6",
    color: "#1b3255",
    fontFamily: "Noto Serif KR",
    fontSize: 14,
    bold: true,
    italic: true,
    underline: true,
    strike: true,
    textAlign: "right",
    verticalAlign: "bottom",
    textMode: "wrap",
    borderTop: border,
    borderRight: border,
    borderBottom: border,
    borderLeft: border,
  };
  const hiddenWeek = "2026-12-07";
  const styleFor = (key: string) =>
    key === "owner"
      ? {
          ...common,
          backgroundColor: "#fce1cc",
          bold: false,
          textAlign: "left",
          borderTop: null,
        }
      : key === hiddenWeek
        ? {
            ...common,
            backgroundColor: "#e3ddfb",
            fontFamily: "Nanum Gothic Coding",
            textAlign: "center",
            verticalAlign: "top",
            borderLeft: null,
          }
        : common;
  const keys = [
    "title",
    "owner",
    "status",
    ...weeksForYear(2026).map((week) => week.key),
  ];
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: keys.map((key) => ({
      taskId: sourceId,
      key,
      expectedVersion: source.cells[key]?.version || 0,
      style: styleFor(key),
    })),
  });
  const view = {
    ...defaultView(2026),
    fromMonth: 3,
    toMonth: 3,
    visibleFields: ["title", "status"],
    knownProperties: ["title", "owner", "status"],
    columnVisibility: { title: true, owner: true, status: true },
    rowHeights: { [sourceId]: 74 },
  };
  const headers = { "X-Requested-With": "WeeklyPlan" };
  const saveView = async (data: unknown) => {
    const response = await page.request.put("/api/views", {
      headers,
      data: { teamId, name: "__current", data },
    });
    expect(response.ok()).toBeTruthy();
  };
  const currentView = async () =>
    (
      await (
        await page.request.get(`/api/views?teamId=${teamId}&year=2026`)
      )
        .json()
        .then(unpack)
    ).views.find((v: any) => v.name === "__current")?.data;
  // 첫 화면의 보기 자동 저장이 끝난 뒤 숨김 상태를 준비한다.
  await expect
    .poll(async () => (await currentView())?.knownProperties)
    .toEqual(["title", "owner", "status"]);
  await saveView(view);
  await page.reload();
  const title = page.locator(`[data-cell="${sourceId}:title"]`);
  await expect(title).toHaveCSS("background-color", "rgb(221, 237, 214)");
  await expect(page.locator('[data-header-key="owner"]')).toHaveCount(0);
  await expect(page.locator(`[data-column="${hiddenWeek}"]`)).toHaveCount(0);
  const properties = [
    "background-color",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration-line",
    "text-align",
    "align-items",
    "white-space",
  ];
  const visualStyle = await title.evaluate(
    (element, names) =>
      names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
  const insertedIds: string[] = [];
  for (const label of ["위에 삽입", "아래에 삽입"]) {
    const inserted = await insert(page, sourceId, label);
    insertedIds.push(inserted.id);
    expect(inserted.defaultStyle).toEqual(source.defaultStyle);
    expect(inserted.cells.title.value).toBe("새 업무");
    expect(inserted.cells.owner.value).toBe("");
    expect(inserted.cells.status.value).toBe("");
    expect(inserted.cells[hiddenWeek].value).toBe("");
    for (const key of keys) {
      const expected = { ...styleFor(key) };
      if (key === "owner") delete expected.borderTop;
      if (key === hiddenWeek) delete expected.borderLeft;
      expect(inserted.cells[key].style).toEqual(expected);
    }
    await editTitle(page, inserted.id, label + " 행");
    const cell = page.locator(`[data-cell="${inserted.id}:title"]`);
    for (const [index, name] of properties.entries())
      await expect(cell).toHaveCSS(name, visualStyle[index]);
    await expect(page.locator(`[data-row-id="${inserted.id}"]`)).toHaveCSS(
      "height",
      "74px",
    );
    await expect
      .poll(async () => (await currentView()).rowHeights[inserted.id])
      .toBe(74);
  }
  await saveView({
    ...(await currentView()),
    visibleFields: ["title", "owner", "status"],
    fromMonth: 12,
    toMonth: 12,
  });
  await page.reload();
  for (const id of [sourceId, ...insertedIds]) {
    await expect(page.locator(`[data-row-id="${id}"]`)).toHaveCSS(
      "height",
      "74px",
    );
    await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveCSS(
      "background-color",
      "rgb(221, 237, 214)",
    );
    await expect(page.locator(`[data-cell="${id}:owner"]`)).toHaveCSS(
      "background-color",
      "rgb(252, 225, 204)",
    );
    await expect(page.locator(`[data-cell="${id}:${hiddenWeek}"]`)).toHaveCSS(
      "background-color",
      "rgb(227, 221, 251)",
    );
    await expect(page.locator(`[data-cell="${id}:title"]`)).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
  }
  await expect(title).toHaveText("둘째 업무");
  await page.screenshot({ path: info.outputPath("inserted-row-styles.png") });
});

test("위·아래 삽입은 작업명에 포커스하면서 보이는 열의 가로 위치를 유지한다", async ({
  page,
}) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const settings = boot.teams.find((team: any) => team.id === teamId).settings;
  settings.properties.sort(
    (a: any, b: any) =>
      ["owner", "title", "status"].indexOf(a.id) -
      ["owner", "title", "status"].indexOf(b.id),
  );
  const response = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: settings,
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("[data-header-key]").first()).toHaveAttribute(
    "data-header-key",
    "owner",
  );
  const grid = page.getByRole("grid");
  for (const [label, scrollLeft] of [
    ["위에 삽입", 0],
    ["아래에 삽입", 24],
  ] as const) {
    await grid.evaluate((el, left) => {
      el.scrollLeft = left;
    }, scrollLeft);
    const task = await insert(page, taskIds[1], label);
    const input = page
      .locator(`[data-cell="${task.id}:title"]`)
      .getByRole("textbox");
    await expect(input).toBeFocused();
    await expect
      .poll(() => grid.evaluate((el) => el.scrollLeft))
      .toBe(scrollLeft);
    await expect(
      page.getByText("새 행을 삽입했습니다.", { exact: true }),
    ).toHaveCount(0);
    await input.fill(label);
    await expect(input).toBeFocused();
    expect(await grid.evaluate((el) => el.scrollLeft)).toBe(scrollLeft);
    await input.press("Escape");
  }
});

test("행 복사 직후 붙여넣기는 작업 셀을 선택하면서 가로 스크롤을 유지한다", async ({
  page,
}) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const settings = boot.teams.find((team: any) => team.id === teamId).settings;
  settings.properties.sort(
    (a: any, b: any) =>
      ["owner", "title", "status"].indexOf(a.id) -
      ["owner", "title", "status"].indexOf(b.id),
  );
  const response = await page.request.patch(`/api/teams/${teamId}/settings`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: settings,
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("[data-header-key]").first()).toHaveAttribute(
    "data-header-key",
    "owner",
  );
  const grid = page.getByRole("grid");
  // 작업 열이 이미 보이는 위치와 화면 밖에 있는 위치 모두 유지한다.
  for (const scrollLeft of [0, 24, 900]) {
    await grid.evaluate((el, left) => {
      el.scrollLeft = left;
    }, scrollLeft);
    await expect
      .poll(() => grid.evaluate((el) => el.scrollLeft))
      .toBe(scrollLeft);
    await menu(page, taskIds[0]);
    await page.getByRole("menuitem", { name: "복사", exact: true }).click();
    const pasted = await insert(page, taskIds[0], "복사한 행 붙여넣기");
    const cell = page.locator(`[data-cell="${pasted.id}:title"]`);
    await expect(cell).toHaveText("첫 업무");
    await expect(cell).toHaveClass(/\bfocused\b/);
    await expect(cell.locator(".inline-editor")).toHaveCount(0);
    await expect
      .poll(() => grid.evaluate((el) => el.scrollLeft))
      .toBe(scrollLeft);
    await expect(page.locator(".sheet-row").nth(1)).toHaveAttribute(
      "data-row-id",
      pasted.id,
    );
  }
});

test("묶음 안에 삽입하면 해당 선택값만 유지하고 헤더에 묶음 아이콘을 표시한다", async ({
  page,
}, info) => {
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const settings = boot.teams.find((team: any) => team.id === teamId).settings;
  settings.properties.push({
    id: "p_category",
    name: "분류",
    kind: "option",
    display: "square",
    visible: true,
    values: [
      {
        id: "o_design",
        label: "디자인",
        backgroundColor: "#edf6f4",
        dotColor: "#177b70",
        emoji: "📌",
      },
    ],
  });
  expect(
    (
      await page.request.patch(`/api/teams/${teamId}/settings`, {
        headers: { "X-Requested-With": "WeeklyPlan" },
        data: settings,
      })
    ).ok(),
  ).toBeTruthy();
  await post(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: taskIds[1],
        key: "p_category",
        expectedVersion: 0,
        value: "o_design",
        style: { backgroundColor: "#ddedd6" },
      },
    ],
  });
  await page.reload();
  for (const [key, label] of [
    ["owner", "팀원"],
    ["status", "상태"],
    ["p_category", "분류"],
  ]) {
    const header = page.locator(`[data-header-key="${key}"]`);
    await header.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "이 열로 묶음 보기", exact: true })
      .click();
    const indicator = header.getByRole("img", {
      name: `${label} 묶음 보기 적용`,
    });
    await expect(indicator).toBeVisible();
    await expect(page.locator(".column-group-indicator")).toHaveCount(1);
    const iconBox = (await indicator.boundingBox())!;
    const labelBox = (await header.getByRole("button").boundingBox())!;
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(labelBox.x);
    for (const placement of ["위에 삽입", "아래에 삽입"]) {
      const task = await insert(page, taskIds[1], placement);
      expect(task.cells[key]?.value).toBe(
        key === "owner"
          ? boot.user.id
          : key === "status"
            ? "status-planned"
            : "o_design",
      );
      for (const other of ["owner", "status", "p_category"].filter(
        (k) => k !== key,
      ))
        expect(task.cells[other]?.value || "").toBe("");
      expect(task.cells.p_category.style).toEqual({
        backgroundColor: "#ddedd6",
      });
      const editor = page
        .locator(`[data-cell="${task.id}:title"]`)
        .getByRole("textbox");
      await expect(editor).toBeFocused();
      await editor.press("Escape");
      await expect(indicator).toBeVisible();
      const ids = await page
        .locator("[data-row-id]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-row-id")));
      expect(ids.indexOf(task.id) - ids.indexOf(taskIds[1])).toBe(
        placement === "위에 삽입" ? -1 : 1,
      );
    }
  }
  await page.screenshot({ path: info.outputPath("grouped-column-header.png") });
  await page
    .locator('[data-header-key="p_category"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "묶음 해제", exact: true }).click();
  await expect(page.locator(".column-group-indicator")).toHaveCount(0);
  const task = await insert(page, taskIds[1], "아래에 삽입");
  expect(task.cells.owner?.value || "").toBe("");
  expect(task.cells.status?.value || "").toBe("");
  expect(task.cells.p_category.value).toBe("");
});

test("팀원도 위·아래에 미지정 행을 삽입하고 작업명을 바로 입력한다", async ({
  page,
}) => {
  const username = `insert-member-${randomUUID()}@example.com`;
  const password = "insert-member-test-password";
  await post(page, "/admin/users", {
    username,
    password,
    name: "삽입 팀원",
    memberships: [{ teamId, role: "member" }],
  });
  await post(page, "/auth/login", { username, password });
  await page.reload();
  for (const label of ["위에 삽입", "아래에 삽입"]) {
    const task = await insert(page, taskIds[1], label);
    expect(task.cells.owner?.value || "").toBe("");
    expect(task.cells.status?.value || "").toBe("");
    const editor = page
      .locator(`[data-cell="${task.id}:title"]`)
      .getByRole("textbox");
    await expect(editor).toBeFocused();
    await editTitle(page, task.id, label + " 미지정 업무");
  }
});

test("행 메뉴는 열람자에게 삽입·붙여넣기·삭제를 허용하지 않는다", async ({
  page,
}) => {
  const username = "row-viewer-" + randomUUID().slice(0, 8) + "@example.com";
  await post(page, "/admin/users", {
    username,
    password: "local-test-only-password",
    name: "열람자",
    memberships: [{ teamId, role: "viewer" }],
  });
  await page.context().clearCookies();
  await post(page, "/auth/login", {
    username,
    password: "local-test-only-password",
  });
  await page.reload();
  await menu(page, taskIds[0]);
  for (const name of [
    "위에 삽입",
    "아래에 삽입",
    "복사한 행 붙여넣기",
    "행 삭제",
  ])
    await expect(
      page.getByRole("menuitem", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "복사", exact: true }),
  ).toBeEnabled();
});

test("툴바 정렬·텍스트 표시는 가로 아이콘 메뉴이며 제거한 버튼은 표시하지 않는다", async ({
  page,
}, info) => {
  const toolbar = page.locator('.format-toolbar[aria-label="셀 서식 도구"]');
  for (const name of ["서식 초기화", "선택 셀 복사", "선택 행 숨기기"])
    await expect(
      toolbar.getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  const first = page.locator(`[data-cell="${taskIds[0]}:title"]`);
  await first.click();
  for (const [label, values] of [
    ["세로 정렬", ["top", "middle", "bottom"]],
    ["텍스트 표시", ["overflow", "wrap", "clip"]],
  ] as const) {
    const trigger = toolbar.getByRole("combobox", { name: label, exact: true });
    await expect(trigger).toHaveText("");
    await trigger.click();
    const popup = page.getByRole("listbox", { name: label, exact: true });
    await expect(popup).toHaveAttribute("aria-orientation", "horizontal");
    const boxes = await popup.getByRole("option").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width };
      }),
    );
    expect(boxes).toHaveLength(3);
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[1].y).toBe(boxes[2].y);
    expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width);
    await page.screenshot({
      path: info.outputPath(
        label === "세로 정렬" ? "vertical-icons.png" : "text-mode-icons.png",
      ),
    });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      popup.locator(`[data-value="${values[1]}"]`).click(),
    ]);
    await expect(trigger).toHaveAttribute("data-value", values[1]);
    await trigger.click();
    await trigger.press("ArrowRight");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
      ),
      trigger.press("Enter"),
    ]);
    await expect(trigger).toHaveAttribute("data-value", values[2]);
  }
  await expect(first).toHaveCSS("align-items", "safe flex-end");
  await menu(page, taskIds[1]);
  await page.getByRole("menuitem", { name: "행 숨기기", exact: true }).click();
  await expect(page.locator(`[data-row-id="${taskIds[1]}"]`)).toHaveCount(0);
  await expect(
    page
      .locator(".view-bar")
      .getByRole("button", { name: "숨김 해제", exact: true }),
  ).toHaveCount(0);
});
