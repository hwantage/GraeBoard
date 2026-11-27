import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { cell } from "../../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
let teamId: string, userId: string, ids: string[];
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
const target = (page: Page, row: number, key = "title") =>
  page.locator(`[data-cell="${ids[row]}:${key}"]`);
const stored = async (page: Page) =>
  (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks;
const title = async (page: Page, row: number) =>
  cell(
    (await stored(page)).find((t: any) => t.id === ids[row]),
    "title",
  );
const edit = async (page: Page, row: number, value: string) => {
  await target(page, row).dblclick();
  await page.locator(".inline-editor textarea").fill(value);
  await page.keyboard.press("Enter");
};
// Holds the first save until released, so the next changes are made while
// it is on its way.
async function gate(page: Page, status?: number) {
  let release!: () => void, started!: () => void;
  const g = new Promise<void>((r) => (release = r));
  const received = new Promise<void>((r) => (started = r));
  let n = 0;
  await page.route("**/api/cells/batch", async (route) => {
    if (++n === 1) {
      started();
      await g;
      // `status` fails the held save instead of letting it through.
      if (status)
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ error: "일시 오류" }),
        });
    }
    await route.continue();
  });
  return { release, received, count: () => n };
}
test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `저장 대기 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  ids = [];
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await request(page, "/tasks", "POST", {
          teamId,
          year: 2026,
          fields: { title: `업무 ${i + 1}`, owner: userId },
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
  await expect(target(page, 0)).toHaveText("업무 1");
});

// Changes made while an earlier one is being saved wait in order and keep
// what their author saw (src/sheet/cell-save-queue.js).

test("저장 중에 원래 값으로 되돌린 입력도 저장된다", async ({ page }) => {
  const g = await gate(page);
  await edit(page, 1, "새 값");
  await g.received;
  await expect(target(page, 1)).toContainText("새 값");
  await edit(page, 1, "업무 2");
  await expect(target(page, 1)).toContainText("업무 2");
  g.release();
  await expect.poll(() => g.count()).toBe(2);
  await expect.poll(async () => (await title(page, 1)).value).toBe("업무 2");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("저장 중에 굵게를 두 번 누르면 원래대로 돌아온다", async ({ page }) => {
  const bold = page.getByRole("button", { name: "굵게", exact: true });
  await target(page, 2).click();
  const g = await gate(page);
  await bold.click();
  await g.received;
  await expect(target(page, 2)).toHaveCSS("font-weight", "700");
  await bold.click();
  await expect(target(page, 2)).not.toHaveCSS("font-weight", "700");
  g.release();
  await expect.poll(() => g.count()).toBe(2);
  await expect
    .poll(async () => !!(await title(page, 2)).style.bold)
    .toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("서식 저장 중에 같은 셀에 입력해도 내 변경끼리 충돌하지 않는다", async ({
  page,
}) => {
  const bold = page.getByRole("button", { name: "굵게", exact: true });
  await target(page, 2).click();
  const g = await gate(page);
  await bold.click();
  await g.received;
  await edit(page, 2, "새 입력");
  g.release();
  await expect.poll(async () => (await title(page, 2)).value).toBe("새 입력");
  expect((await title(page, 2)).style.bold).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("저장을 기다리는 사이 다른 사람이 고친 셀은 입력을 버리면 그 뒤의 입력도 함께 버린다", async ({
  page,
}) => {
  const g = await gate(page);
  await edit(page, 1, "내 첫 값");
  await g.received;
  const v1 = (await title(page, 1)).version;
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      { taskId: ids[1], key: "title", expectedVersion: v1, value: "남의 값" },
    ],
  });
  await edit(page, 1, "내 둘째 값");
  g.release();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 못한 변경" });
  await expect(failure).toBeVisible();
  // The first input is refused. Dropping it drops the second one made on
  // top of it, which is never sent, and the other person's value shows.
  await page.getByRole("button", { name: "입력 확인" }).click();
  page.once("dialog", (d) => {
    expect(d.message()).toContain("기다리던 변경 1건");
    void d.accept();
  });
  await page.getByRole("button", { name: "입력 취소·최신 내용 보기" }).click();
  await expect(target(page, 1)).toContainText("남의 값");
  await expect(failure).toHaveCount(0);
  expect(g.count()).toBe(1);
  expect((await title(page, 1)).value).toBe("남의 값");
});

test("실패한 서식을 버리면 그 위에 만든 서식도 저장하지 않는다", async ({
  page,
}) => {
  await target(page, 2).click();
  const g = await gate(page, 503);
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await g.received;
  await page.getByRole("button", { name: "기울임", exact: true }).click();
  g.release();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 못한 변경" });
  await expect(failure).toBeVisible();
  await page.getByRole("button", { name: "입력 확인" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "입력 취소·최신 내용 보기" }).click();
  await expect(failure).toHaveCount(0);
  expect(g.count()).toBe(1);
  const style = (await title(page, 2)).style;
  expect(!!style.bold || !!style.italic).toBe(false);
});

test("편집창을 연 뒤 기다리던 내 입력이 모두 저장되어도 내 입력끼리 충돌하지 않는다", async ({
  page,
}) => {
  const g = await gate(page);
  await edit(page, 1, "a");
  await g.received;
  await edit(page, 1, "b");
  await target(page, 1).dblclick();
  await page.locator(".inline-editor textarea").fill("c");
  g.release();
  await expect.poll(async () => (await title(page, 1)).value).toBe("b");
  await page.locator(".inline-editor textarea").press("Enter");
  await expect.poll(async () => (await title(page, 1)).value).toBe("c");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("내 변경 다시 적용은 그 변경만 덮어쓰고, 그 위에 만든 입력은 충돌로 남긴다", async ({
  page,
}) => {
  await target(page, 3).click();
  const g = await gate(page);
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await g.received;
  const v = (await title(page, 3)).version;
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      { taskId: ids[3], key: "title", expectedVersion: v, value: "남의 값" },
    ],
  });
  await edit(page, 3, "내 값");
  g.release();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 못한 변경" });
  await expect(failure).toBeVisible();
  await page.getByRole("button", { name: "입력 확인" }).click();
  await page.getByRole("button", { name: "내 변경 다시 적용" }).click();
  // The bold is forced over their value; the value typed on top of the bold
  // did not see theirs, so it is refused instead of replacing it.
  await expect.poll(async () => !!(await title(page, 3)).style.bold).toBe(true);
  await expect(failure).toBeVisible();
  expect((await title(page, 3)).value).toBe("남의 값");
});

test("실패한 저장 뒤에 기다리던 지우기는 그사이 다른 사람이 고친 셀을 지우지 않는다", async ({
  page,
}) => {
  let fail = true,
    started!: () => void,
    release!: () => void;
  const received = new Promise<void>((r) => (started = r));
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/cells/batch", async (route) => {
    if (fail) {
      fail = false;
      started();
      await held;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "일시 오류" }),
      });
    }
    return route.continue();
  });
  await edit(page, 1, "내 값");
  await received;
  await target(page, 4).click();
  await page.keyboard.press("Delete");
  // The cleared cell shows at once, while it waits.
  await expect(target(page, 4)).not.toContainText("업무 5");
  release();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 못한 변경" });
  await expect(failure).toBeVisible();
  const v4 = (await title(page, 4)).version;
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: ids[4],
        key: "title",
        expectedVersion: v4,
        value: "남이 쓴 값",
      },
    ],
  });
  await page.getByRole("button", { name: "입력 확인" }).click();
  await page.getByRole("button", { name: "다시 시도" }).click();
  // The first input is saved; the clearing waited behind it is refused.
  await expect.poll(async () => (await title(page, 1)).value).toBe("내 값");
  await expect(failure).toBeVisible();
  expect((await title(page, 4)).value).toBe("남이 쓴 값");
});

const rowSelect = (page: Page, row: number) =>
  page.locator(`[data-row-id="${ids[row]}"] .row-select`);
const rowRule = (task: any) =>
  (task.formatting?.rules || []).find(
    (rule: any) => rule.rows?.length === 1 && rule.rows[0] === task.id,
  );
const taskAt = async (page: Page, row: number) =>
  (await stored(page)).find((t: any) => t.id === ids[row]);

test("셀 입력 저장 중에 같은 행 전체 서식을 적용해도 내 변경끼리 충돌하지 않는다", async ({
  page,
}) => {
  const g = await gate(page);
  await edit(page, 1, "새 값");
  await g.received;
  // The row format expects the row as it was before the own save; the save
  // answers with that stamp, so the format follows it.
  await rowSelect(page, 1).click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  g.release();
  await expect.poll(() => g.count()).toBe(2);
  await expect
    .poll(async () => rowRule(await taskAt(page, 1))?.style.bold)
    .toBe(true);
  expect((await title(page, 1)).value).toBe("새 값");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("행 전체 서식 저장 중에 같은 행 셀 서식을 바꿔도 내 변경끼리 충돌하지 않는다", async ({
  page,
}) => {
  await rowSelect(page, 2).click();
  const g = await gate(page);
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await g.received;
  // The cell change expects the formatting revision before the own format.
  await target(page, 2).click();
  await page.getByRole("button", { name: "기울임", exact: true }).click();
  g.release();
  await expect.poll(() => g.count()).toBe(2);
  await expect.poll(async () => (await title(page, 2)).style.italic).toBe(true);
  expect(rowRule(await taskAt(page, 2))?.style.bold).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("내 셀 저장보다 먼저 다른 사람이 같은 행을 바꾸면 기다리던 행 서식은 충돌로 남는다", async ({
  page,
}) => {
  const g = await gate(page);
  await edit(page, 1, "내 값");
  await g.received;
  await rowSelect(page, 1).click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  // Someone else changes another cell of the row before the own save lands.
  const other = (await taskAt(page, 1)).cells["2026-01-05"];
  await request(page, "/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      {
        taskId: ids[1],
        key: "2026-01-05",
        expectedVersion: other?.version ?? 0,
        value: "남의 입력",
      },
    ],
  });
  g.release();
  // The own cell save replaced the other person's row stamp, not the one
  // the row format saw: the format is refused instead of applied unseen.
  await expect(
    page.getByRole("alert").filter({ hasText: "저장하지 못한 변경" }),
  ).toBeVisible();
  expect(g.count()).toBe(2);
  expect((await title(page, 1)).value).toBe("내 값");
  const row = await taskAt(page, 1);
  expect(cell(row, "2026-01-05").value).toBe("남의 입력");
  expect(rowRule(row)?.style.bold).not.toBe(true);
});

test("서식 실행취소가 저장되는 동안에는 셀을 고치지 않는다", async ({
  page,
}) => {
  await rowSelect(page, 3).click();
  await page.getByRole("button", { name: "굵게", exact: true }).click();
  await expect
    .poll(async () => rowRule(await taskAt(page, 3))?.style.bold)
    .toBe(true);
  const g = await gate(page);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await g.received;
  // The undo restores a recorded state the sheet cannot show before its
  // result: a change made on top of it now would keep the undone style.
  await target(page, 3).dblclick();
  await expect(page.locator(".inline-editor textarea")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "앞선 변경을 저장 중입니다" }),
  ).toBeVisible();
  const undone = page.waitForResponse(
    (r) => r.url().endsWith("/api/cells/batch") && r.ok(),
  );
  g.release();
  await undone;
  expect(rowRule(await taskAt(page, 3))?.style.bold).not.toBe(true);
  await edit(page, 3, "실행취소 뒤 입력");
  await expect
    .poll(async () => (await title(page, 3)).value)
    .toBe("실행취소 뒤 입력");
});
