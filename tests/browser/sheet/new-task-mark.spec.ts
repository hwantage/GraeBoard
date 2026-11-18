import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { unpack } from "../../../shared/formatting/compact.js";
import {
  defaultView,
  normalizeView,
  todayKey,
} from "../../../shared/domain.js";
import { calendarWeek } from "../../../shared/calendar/calendar.js";

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
// CSS draws the word, so it is read from the pseudo-element.
const markText = (mark: Locator) =>
  mark.evaluate((element) => getComputedStyle(element, "::before").content);

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `새 업무 ${randomUUID().slice(0, 6)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
});

test("새 업무는 12시간 동안 제목 끝·상세·주간 할 일에 new를 표시한다", async ({
  page,
}, info) => {
  // The mark follows the server clock: the last X-Server-Time plus
  // performance.now. When the page clock jumps, responses report the server
  // time moved by the same amount, as a real server's would.
  await page.clock.install();
  let shift = 0;
  // The shift is read when the response returns, so a request sent before a
  // jump cannot report the old server time after it.
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/events"))
      return route.fallback();
    // A 304 cannot be fulfilled; ask for the full response instead.
    const sent = { ...route.request().headers() };
    delete sent["if-none-match"];
    delete sent["if-modified-since"];
    const response = await route.fetch({ headers: sent });
    const headers = response.headers();
    const time = Date.parse(headers["x-server-time"] ?? "");
    if (Number.isFinite(time))
      headers["x-server-time"] = new Date(time + shift).toISOString();
    await route.fulfill({ response, headers });
  });
  const advance = async (time: string, ms: number) => {
    shift += ms;
    await page.clock.fastForward(time);
  };
  const task = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: Number(todayKey().slice(0, 4)),
      fields: { title: "새로 등록한 업무" },
    })
  ).task;
  await request(page, "/calendar/weekly", "POST", {
    teamId,
    userId,
    weekStart: calendarWeek(todayKey()),
    taskIds: [task.id],
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);

  const cell = page.locator(`[data-cell="${task.id}:title"]`);
  const mark = cell.locator(".task-new-mark");
  await expect(mark).toBeVisible();
  expect(await markText(mark)).toBe('"new"');
  // The word stays out of the cell text that copy and search read.
  await expect(cell).toHaveText("새로 등록한 업무");
  // Screen readers hear it through the cell's description.
  await expect(cell).toHaveAttribute("aria-description", "새 업무");
  // Left of the document button, after the title text.
  const button = cell.locator(".task-document-indicator");
  const markBox = (await mark.boundingBox())!;
  const buttonBox = (await button.boundingBox())!;
  const textBox = (await cell.locator(".cell-text").boundingBox())!;
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(buttonBox.x + 1);
  expect(textBox.x + textBox.width).toBeLessThanOrEqual(markBox.x + 1);
  await page.screenshot({ path: info.outputPath("sheet.png") });

  await cell.hover();
  await button.click();
  const detail = page.getByRole("dialog", { name: "업무 상세", exact: true });
  const detailMark = detail.locator(".modal-heading .task-new-mark");
  await expect(detailMark).toBeVisible();
  await expect(
    detail.getByRole("img", { name: "새 업무", exact: true }),
  ).toBeVisible();
  expect(await markText(detailMark)).toBe('"new"');
  await page.screenshot({ path: info.outputPath("detail.png") });
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toBeHidden();

  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  const weekly = page
    .locator(".calendar-week-task-open")
    .filter({ hasText: "새로 등록한 업무" });
  await expect(weekly.locator(".task-new-mark")).toBeVisible();
  await expect(weekly).toHaveAttribute("aria-description", "새 업무");
  await page.screenshot({ path: info.outputPath("calendar.png") });

  // The mark stays until 12 hours pass, then goes without reloading.
  await advance("11:59:00", (11 * 60 + 59) * 60_000);
  await expect(weekly.locator(".task-new-mark")).toBeVisible();
  await advance("01:30", 90_000);
  await expect(weekly.locator(".task-new-mark")).toHaveCount(0);
  await expect(weekly).not.toHaveAttribute("aria-description");
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).click();
  await expect(cell).toBeVisible();
  await expect(cell.locator(".task-new-mark")).toHaveCount(0);
  await expect(cell).not.toHaveAttribute("aria-description");
  await cell.hover();
  await button.click();
  await expect(detail.locator(".modal-heading")).toBeVisible();
  await expect(detail.locator(".task-new-mark")).toHaveCount(0);
});

test("사본과 모바일 표에도 문서 버튼 옆에 new를 표시한다", async ({
  page,
}, info) => {
  const year = Number(todayKey().slice(0, 4));
  const task = (
    await request(page, "/tasks", "POST", {
      teamId,
      year,
      fields: { title: "모바일에서 확인할 아주 긴 새 업무 제목" },
    })
  ).task;
  await request(page, `/tasks/${task.id}/document`, "PUT", {
    markdown: "본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  const { settings } = (await request(page, "/admin/users")).teams.find(
    (team: { id: string }) => team.id === teamId,
  );
  await request(page, "/sheet-clones", "POST", {
    teamId,
    year,
    name: "새 업무 사본",
    referenceDate: todayKey(),
    view: normalizeView(defaultView(year), settings),
    taskIds: [task.id],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  const cell = page.locator(`[data-cell="${task.id}:title"]`);
  await expect(cell.locator(".task-new-mark")).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile.png") });
  await page.getByRole("tab", { name: "새 업무 사본", exact: true }).click();
  // A copy keeps the original's creation time, so its row is new too.
  await expect(cell.locator(".task-new-mark")).toBeVisible();
  const mark = (await cell.locator(".task-new-mark").boundingBox())!;
  const button = (await cell
    .locator(".task-document-indicator")
    .boundingBox())!;
  expect(mark.x + mark.width).toBeLessThanOrEqual(button.x + 1);
  // Level with the document icon, both raised above the text line.
  const icon = (await cell
    .locator(".task-document-indicator svg")
    .boundingBox())!;
  expect(
    Math.abs(mark.y + mark.height / 2 - (icon.y + icon.height / 2)),
  ).toBeLessThanOrEqual(3);
  await page.screenshot({ path: info.outputPath("sheet-clone-mobile.png") });
  // A row added in the copy takes its creation time from the server clock.
  await page
    .getByRole("button", { name: "사본에 업무 추가", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "작업 편집", exact: true });
  await editor.fill("사본에서 추가한 업무");
  await editor.press("Enter");
  await expect(
    page
      .locator('[data-column="title"]')
      .filter({ hasText: "사본에서 추가한 업무" })
      .locator(".task-new-mark"),
  ).toBeVisible();
});

test("엑셀 가져오기로 만든 업무에는 new를 표시하지 않는다", async ({
  page,
}) => {
  const year = Number(todayKey().slice(0, 4));
  const added = (
    await request(page, "/tasks", "POST", {
      teamId,
      year,
      fields: { title: "직접 추가한 업무" },
    })
  ).task;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("가져오기");
  sheet.addRow(["작업"]);
  sheet.addRow(["가져온 업무"]);
  const preview = await page.request.post("/api/import/preview", {
    headers,
    multipart: {
      teamId,
      year: String(year),
      file: {
        name: "import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
    },
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const { id } = unpack(await preview.json());
  await request(page, `/import/${id}/apply`, "POST", {
    sheet: "가져오기",
    year,
    mode: "tasks",
    referenceDate: todayKey(),
    acceptWarnings: true,
    personMap: {},
  });
  await page.goto("/");
  await page.getByLabel("팀 선택", { exact: true }).selectOption(teamId);
  const imported = page
    .locator('[data-column="title"]')
    .filter({ hasText: "가져온 업무" });
  await expect(imported).toBeVisible();
  await expect(
    page.locator(`[data-cell="${added.id}:title"] .task-new-mark`),
  ).toBeVisible();
  await expect(imported.locator(".task-new-mark")).toHaveCount(0);
});
