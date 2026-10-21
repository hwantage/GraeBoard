import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";
import { addDays } from "../../shared/calendar.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string;
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "캘린더 일정", exact: true });
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"] .calendar-entry-card`).first();
const source = (page: Page) =>
  detail(page).getByRole("textbox", { name: "일정 문서 Markdown 원문" });
async function calendar(page: Page) {
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(page.locator(".calendar-grid")).toBeVisible();
}
async function seed(
  page: Page,
  tagIds: string[] = [],
  checkedTagIds: string[] = [],
) {
  return request(page, "/calendar/entries", "POST", {
    id: randomUUID(),
    teamId,
    userId,
    title: "검증 일정",
    date: todayKey(),
    endDate: addDays(todayKey(), 1),
    tagIds,
    checkedTagIds,
  });
}
async function raw(page: Page, id: string) {
  await card(page, id).click();
  await expect(
    detail(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await detail(page)
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await expect(source(page)).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `캘린더 개선 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  await request(page, "/calendar/preferences", "PUT", {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
});

test("태그 선택 목록이 열린 채 첫 클릭으로 생성하고 상세 없이 캘린더로 돌아온다", async ({
  page,
}) => {
  const label = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "회의",
    color: "blue",
  });
  const check = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "확인",
    color: "green",
    kind: "check",
  });
  await calendar(page);
  await page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  await dialog.getByLabel("새 일정 제목").fill("한 번에 저장");
  await dialog.locator("summary").click();
  await dialog.getByRole("button", { name: "회의 태그", exact: true }).click();
  await dialog.getByRole("button", { name: "확인 태그", exact: true }).click();
  await expect(dialog.locator("details")).toHaveAttribute("open", "");
  await dialog
    .getByRole("button", { name: "일정 만들기", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(detail(page)).toHaveCount(0);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].tagIds).toEqual([label.id, check.id]);
  await expect(card(page, entries[0].id)).toBeVisible();
  const tags = page.locator(
    `[data-entry-id="${entries[0].id}"] .calendar-entry-tag-overlay .calendar-tag-chip`,
  );
  const boxes = await tags.evaluateAll((nodes) =>
    nodes.map((node) => ({
      h: node.getBoundingClientRect().height,
      y: node.getBoundingClientRect().y,
    })),
  );
  expect(boxes[0].h).toBe(boxes[1].h);
  expect(boxes[0].y).toBe(boxes[1].y);
});

test("일정 추가 바깥 클릭은 빈 입력을 닫고 제목과 선택 태그가 있으면 한 번 저장한다", async ({
  page,
}) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "자동 저장 태그",
    color: "blue",
  });
  await calendar(page);
  const add = page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ });
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/calendar/entries"))
      writes++;
  });
  await add.click();
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(0);
  await add.click();
  await dialog.locator("summary").click();
  await dialog
    .getByRole("button", { name: "자동 저장 태그 태그", exact: true })
    .click();
  await page.mouse.click(3, 3);
  const title = dialog.getByLabel("새 일정 제목");
  await expect(title).toBeFocused();
  expect(writes).toBe(0);
  await title.fill("바깥 클릭으로 저장");
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(3, 3, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(writes).toBe(0);
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  await expect(detail(page)).toHaveCount(0);
  expect(writes).toBe(1);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    title: "바깥 클릭으로 저장",
    tagIds: [tag.id],
  });
  await expect(card(page, entries[0].id)).toBeVisible();
  await add.click();
  await expect(title).toHaveValue("");
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(1);
});

test("바깥 클릭 자동 저장은 중복 클릭을 막고 응답 유실 후 같은 ID로 재시도한다", async ({
  page,
}) => {
  await calendar(page);
  await page
    .locator(`[data-date="${todayKey()}"]`)
    .getByRole("button", { name: /일정 추가/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 추가", exact: true });
  const title = dialog.getByLabel("새 일정 제목");
  await title.fill("자동 저장 재시도");
  const ids: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/calendar/entries", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().id);
    if (ids.length !== 1) return route.continue();
    await gate;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.fulfill({
      status: 503,
      json: { error: "저장 응답을 받지 못했습니다." },
    });
  });
  try {
    await page.mouse.click(3, 3);
    await expect.poll(() => ids.length).toBe(1);
    await expect(title).toBeDisabled();
    await page.mouse.click(3, 3);
    expect(ids).toHaveLength(1);
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText("저장 응답");
  await expect(title).toHaveValue("자동 저장 재시도");
  await expect(title).toBeEnabled();
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${todayKey()}`,
    )
  ).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe(ids[0]);
});

test("제목 선택을 팝업 바깥에서 마쳐도 닫히지 않고 삭제는 하단에 배치한다", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const entry = await seed(page);
  await calendar(page);
  await card(page, entry.id).click();
  const title = detail(page).getByLabel("일정 제목", { exact: true });
  await expect(title).toHaveValue(entry.title);
  await expect(detail(page).locator("header input")).toHaveCount(1);
  await expect(
    detail(page).getByRole("heading", { name: "캘린더 일정" }),
  ).toHaveCount(0);
  await expect(
    detail(page).locator("header").getByRole("button", { name: "일정 삭제" }),
  ).toHaveCount(0);
  await expect(
    detail(page).locator("footer").getByRole("button", { name: "일정 삭제" }),
  ).toBeVisible();
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(3, 3, { steps: 10 });
  await page.mouse.up();
  await expect(detail(page)).toBeVisible();
  await expect(
    detail(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
  ).toBeVisible();
  await title.press("ArrowRight");
  await page.screenshot({ path: info.outputPath("calendar-light-detail.png") });
  await page.mouse.click(3, 3);
  await expect(detail(page)).toHaveCount(0);
});

test("카드 우클릭 복제는 제목·기간·태그·체크만 복사하고 이동·삭제·실행취소한다", async ({
  page,
}) => {
  const tag = await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
    id: randomUUID(),
    name: "검토",
    color: "green",
    kind: "check",
  });
  const entry = await seed(page, [tag.id], [tag.id]);
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: "복제하지 않을 문서",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await calendar(page);
  const attempts: string[] = [];
  await page.route(
    `**/api/calendar/entries/${entry.id}/copy`,
    async (route) => {
      attempts.push(route.request().postDataJSON().id);
      if (attempts.length !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.fulfill({ status: 503, json: { error: "복제 응답 유실" } });
    },
  );
  await card(page, entry.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("복제 응답 유실");
  // Editing the source after a lost response must still retry the same copy.
  const originalCheck = page
    .locator(`[data-entry-id="${entry.id}"]`)
    .getByRole("checkbox", { name: "검토 체크", exact: true });
  await originalCheck.uncheck();
  await expect(originalCheck).not.toHaveAttribute("aria-disabled", "true");
  await card(page, entry.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(page.locator(".calendar-entry-card")).toHaveCount(2);
  const entries = (
    await request(
      page,
      `/calendar?teamId=${teamId}&userId=${userId}&from=${todayKey()}&to=${addDays(todayKey(), 5)}`,
    )
  ).entries;
  const copy = entries.find((item: { id: string }) => item.id !== entry.id);
  expect(copy).toMatchObject({
    title: `${entry.title} (1)`,
    date: entry.date,
    endDate: entry.endDate,
    tagIds: [tag.id],
    checkedTagIds: [tag.id],
  });
  expect(
    (await request(page, `/calendar/entries/${copy.id}/document`)).markdown,
  ).toBe("");
  expect(attempts).toEqual([copy.id, copy.id]);
  await expect(card(page, copy.id)).toContainText(`${entry.title} (1)`);
  await card(page, entry.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(page.locator(".calendar-entry-card")).toHaveCount(3);
  await expect(
    page
      .locator(".calendar-entry-content strong")
      .filter({ hasText: `${entry.title} (2)` }),
  ).toHaveCount(1);
  await card(page, copy.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 복제", exact: true }).click();
  await expect(page.locator(".calendar-entry-card")).toHaveCount(4);
  await expect(
    page
      .locator(".calendar-entry-content strong")
      .filter({ hasText: `${entry.title} (3)` }),
  ).toHaveCount(1);
  await card(page, copy.id).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${copy.id}`)).date,
    )
    .toBe(addDays(todayKey(), 1));
  await card(page, copy.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "태그 설정", exact: true }).click();
  const tags = page.getByRole("dialog", { name: "일정 태그", exact: true });
  await tags.getByRole("checkbox", { name: "검토 체크" }).uncheck();
  await expect
    .poll(
      async () =>
        (await request(page, `/calendar/entries/${copy.id}`)).checkedTagIds,
    )
    .toEqual([]);
  await tags.getByRole("button", { name: "닫기", exact: true }).click();
  await card(page, copy.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "일정 삭제", exact: true }).click();
  await expect(card(page, copy.id)).toHaveCount(0);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(card(page, copy.id)).toBeVisible();
});

test("두 브라우저의 독립 문서 수정과 저장 중 추가 입력을 병합하고 리치 전환 때 유지한다", async ({
  page,
  browser,
}) => {
  const entry = await seed(page);
  const initial = "첫 줄\n\n둘째 줄\n\n셋째 줄";
  await request(page, `/calendar/entries/${entry.id}/document`, "PUT", {
    markdown: initial,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  const otherContext = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const other = await otherContext.newPage();
  try {
    await calendar(page);
    await calendar(other);
    await raw(page, entry.id);
    await raw(other, entry.id);
    let writes = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/calendar/entries/${entry.id}/document`,
      async (route) => {
        if (route.request().method() !== "PUT" || ++writes !== 1)
          return route.continue();
        await gate;
        await route.continue();
      },
    );
    try {
      await source(page).fill("첫 줄 A\n\n둘째 줄\n\n셋째 줄");
      await expect.poll(() => writes).toBe(1);
      await source(other).fill("첫 줄\n\n둘째 줄 B\n\n셋째 줄");
      await expect
        .poll(
          async () =>
            (await request(page, `/calendar/entries/${entry.id}/document`))
              .markdown,
        )
        .toContain("둘째 줄 B");
      await source(page).fill("첫 줄 A\n\n둘째 줄\n\n셋째 줄 C");
    } finally {
      release();
    }
    const merged = "첫 줄 A\n\n둘째 줄 B\n\n셋째 줄 C";
    await expect(source(page)).toHaveValue(merged);
    await expect(source(other)).toHaveValue(merged);
    await expect(detail(page).locator(".document-error")).toHaveCount(0);
    await source(page).fill(merged + " 추가");
    await detail(page)
      .getByRole("button", { name: "리치 문서", exact: true })
      .click();
    await expect(
      detail(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
    ).toContainText("셋째 줄 C 추가");
    await expect(source(other)).toHaveValue(merged + " 추가");
    await source(other).fill(merged + " 추가 원격");
    await expect(
      detail(page).getByRole("textbox", { name: "일정 문서 리치 편집" }),
    ).toContainText("셋째 줄 C 추가 원격");
  } finally {
    await otherContext.close();
  }
});

test("선택한 태그를 드래그·키보드로 정렬하고 체크·배경색·새로고침 순서를 보존한다", async ({
  page,
}) => {
  const tags = [];
  for (const [name, color, kind] of [
    ["회의", "blue", "label"],
    ["확인", "green", "check"],
    ["업무", "orange", "label"],
  ])
    tags.push(
      await request(page, `/calendar/teams/${teamId}/tags`, "POST", {
        id: randomUUID(),
        name,
        color,
        kind,
      }),
    );
  const entry = await seed(
    page,
    tags.map((tag) => tag.id),
    [tags[1].id],
  );
  await calendar(page);
  await card(page, entry.id).click();
  const selected = detail(page).locator(".calendar-tag-sortable");
  const from = (await selected.nth(2).boundingBox())!,
    to = (await selected.nth(0).boundingBox())!;
  await page.mouse.move(from.x + 18, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const reordered = [tags[2].id, tags[0].id, tags[1].id];
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${entry.id}`)).tagIds,
    )
    .toEqual(reordered);
  await expect(selected.nth(0)).toHaveAttribute("data-tag-id", tags[2].id);
  const check = detail(page).getByRole("checkbox", { name: "확인 체크" });
  await expect(check).not.toHaveAttribute("aria-disabled", "true");
  await check.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  const finalOrder = [tags[2].id, tags[1].id, tags[0].id];
  await expect
    .poll(
      async () => (await request(page, `/calendar/entries/${entry.id}`)).tagIds,
    )
    .toEqual(finalOrder);
  await expect(check).toBeChecked();
  await detail(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(card(page, entry.id)).toHaveCSS(
    "background-color",
    "rgb(255, 240, 221)",
  );
  await page.reload();
  await card(page, entry.id).click();
  await expect(selected.nth(1)).toHaveAttribute("data-tag-id", tags[1].id);
  await expect(check).toBeChecked();
  const before = (await request(page, `/calendar/entries/${entry.id}`)).tagIds;
  const cancelFrom = (await selected.nth(0).boundingBox())!,
    cancelTo = (await selected.nth(2).boundingBox())!;
  await page.mouse.move(
    cancelFrom.x + 18,
    cancelFrom.y + cancelFrom.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(cancelTo.x + 15, cancelTo.y + cancelTo.height / 2, {
    steps: 10,
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(detail(page)).toBeVisible();
  expect((await request(page, `/calendar/entries/${entry.id}`)).tagIds).toEqual(
    before,
  );
});
