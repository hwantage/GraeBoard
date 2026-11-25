import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

// Firefox turns on caret browsing (F7) from a preference, so its caret is
// checked as well; Chromium and WebKit check the selection a click leaves.
// Other browsers ignore the Firefox preference.
test.use({
  launchOptions: {
    firefoxUserPrefs: { "accessibility.browsewithcaret": true },
  },
});

const headers = { "X-Requested-With": "WeeklyPlan" };
async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/api${path}`, { headers, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
const detail = (page: Page) =>
  page.getByRole("dialog", { name: "업무 상세", exact: true });

test("헤더의 업무 제목은 눌러도 커서·선택이 생기지 않고 방향키로 움직이지 않는다", async ({
  page,
}) => {
  await post(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const { user } = unpack(
    await (await page.request.get("/api/bootstrap")).json(),
  );
  const teamId = (
    await post(page, "/admin/teams", {
      name: `헤더 제목 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: user.id, role: "lead" }],
    })
  ).id;
  const title = `헤더에서 누르는 긴 업무 제목 ${"끝까지 이어지는 설명 ".repeat(12)}끝`;
  const id = (
    await post(page, "/tasks", { teamId, year: 2026, fields: { title } })
  ).task.id;
  const res = await page.request.put(`/api/tasks/${id}/documents/main`, {
    headers,
    data: {
      markdown: Array.from({ length: 80 }, (_, i) => `문단 ${i + 1}`).join(
        "\n\n",
      ),
      expectedRevision: 0,
      operationId: randomUUID(),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  const dialog = detail(page);
  const rich = dialog.getByRole("textbox", { name: "업무 문서 리치 편집" });
  await expect(rich).toContainText("문단 80");
  const shown = dialog.locator(":scope > header .task-detail-header-title");
  const inTitle = () =>
    shown.evaluate((el) => {
      const selection = getSelection()!;
      return (
        !!selection.rangeCount &&
        (el.contains(selection.anchorNode) || el.contains(selection.focusNode))
      );
    });
  const editing = () =>
    page.evaluate(
      () =>
        !!document.activeElement?.closest(
          "input, textarea, [contenteditable=true]",
        ),
    );
  // The visible text, and the space the ellipsis leaves at its end.
  for (const end of [false, true]) {
    await dialog.locator(".modal-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(shown).toBeVisible();
    const box = (await shown.boundingBox())!;
    await page.mouse.click(
      end ? box.x + box.width - 3 : box.x + 20,
      box.y + box.height / 2,
    );
    expect(await inTitle()).toBe(false);
    expect(await editing()).toBe(false);
    for (const key of ["ArrowLeft", "ArrowRight", "End", "Home"]) {
      await page.keyboard.press(key);
      expect(await inTitle()).toBe(false);
      // Moving a caret through the clipped text would scroll it sideways.
      expect(await shown.evaluate((el) => el.scrollLeft)).toBe(0);
    }
  }
  await expect(shown).toHaveText(title);
  await expect(
    dialog.getByRole("textbox", { name: "작업 편집", exact: true }),
  ).toHaveValue(title);
  // Focus stays on the dialog itself: Esc still closes it, and after
  // reopening, Tab still moves within it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.locator(`[data-cell="${id}:title"]`).click({ button: "right" });
  await expect(rich).toContainText("문단 80");
  await dialog.locator(".modal-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await shown.click();
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate(
      (el) =>
        el !== document.activeElement && el.contains(document.activeElement),
    ),
  ).toBe(true);
});
