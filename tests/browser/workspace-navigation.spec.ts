import { test, expect, type Page } from "@playwright/test";

const annual = (page: Page) =>
  page.getByRole("heading", { name: "연간 업무", exact: true });
const documents = (page: Page) =>
  page.getByRole("heading", { name: "문서 브라우저", exact: true });
const calendar = (page: Page) =>
  page.getByRole("region", { name: "캘린더", exact: true });

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await expect(annual(page)).toBeVisible();
  await page.evaluate(() => {
    (window as any).navigationDocument = "same document";
  });
});

test("문서·캘린더 URL과 뒤로·앞으로가기가 화면을 복원한다", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(documents(page)).toBeVisible();
  await expect(page).toHaveURL(/\/documents$/);
  const length = await page.evaluate(() => history.length);
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page)).toBeVisible();
  await expect(page).toHaveURL(/\/calendar$/);
  await page.goBack();
  await expect(documents(page)).toBeVisible();
  await expect(page).toHaveURL(/\/documents$/);
  await page.goBack();
  await expect(annual(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(documents(page)).toBeVisible();
  await page.goForward();
  await expect(calendar(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).navigationDocument)).toBe(
    "same document",
  );
});

test("그래보드 아이콘과 텍스트는 연간 업무로 이동하고 방문 기록을 유지한다", async ({
  page,
}) => {
  const home = page.getByRole("button", {
    name: "그래보드 홈 (연간 업무)",
    exact: true,
  });
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(documents(page)).toBeVisible();
  await home.getByRole("img", { name: "그래보드", exact: true }).click();
  await expect(annual(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(documents(page)).toBeVisible();
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page)).toBeVisible();
  await home.locator(".brand-symbol").click();
  await expect(annual(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(calendar(page)).toBeVisible();
  await home.focus();
  await page.keyboard.press("Enter");
  await expect(annual(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).navigationDocument)).toBe(
    "same document",
  );
});

test("여러 방문 기록을 건너뛰고 닫기로 돌아와도 URL과 화면이 일치한다", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "문서 브라우저", exact: true })
    .click();
  await expect(documents(page)).toBeVisible();
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page)).toBeVisible();
  await page.evaluate(() => history.go(-2));
  await expect(annual(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => history.go(2));
  await expect(calendar(page)).toBeVisible();
  await page.getByRole("button", { name: "캘린더 닫기", exact: true }).click();
  await expect(annual(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(calendar(page)).toBeVisible();
});

for (const path of ["/documents", "/calendar"]) {
  test(`${path} 직접 접속·새로고침 후에도 이동 기록이 동작한다`, async ({
    page,
  }) => {
    const screen = path === "/documents" ? documents : calendar;
    await page.goto(path);
    await expect(screen(page)).toBeVisible();
    await page.reload();
    await expect(screen(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.goBack();
    await expect(annual(page)).toBeVisible();
    await page.goForward();
    await expect(screen(page)).toBeVisible();
  });
}

test("캘린더 편집 중 뒤로가기는 기존 이동 제한과 방문 기록을 유지한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "캘린더", exact: true }).click();
  await expect(calendar(page).locator(".calendar-grid")).toBeVisible();
  await calendar(page)
    .getByRole("button", { name: /일정 추가/ })
    .first()
    .click();
  const title = page.getByRole("textbox", { name: "새 일정 제목" });
  await title.fill("뒤로가기 중 보존할 일정");
  await expect(
    page.getByRole("button", { name: "그래보드 홈 (연간 업무)", exact: true }),
  ).toBeDisabled();
  await page.goBack();
  await expect(title).toHaveValue("뒤로가기 중 보존할 일정");
  await expect(page).toHaveURL(/\/calendar$/);
  await page.keyboard.press("Escape");
  await expect(title).toHaveCount(0);
  await page.goBack();
  await expect(annual(page)).toBeVisible();
  await page.goForward();
  await expect(calendar(page)).toBeVisible();
});
