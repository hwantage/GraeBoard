import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
});

test("업무 조회의 플랫폼 429 응답에 원인·재시도·진단 ID를 표시한다", async ({
  page,
}) => {
  await page.route("**/api/tasks?**", (route) =>
    route.fulfill({
      status: 429,
      headers: {
        "retry-after": "12",
        "sb-error-code": "RATE_LIMIT_EXCEEDED",
        "sb-request-id": "ui-request-429",
      },
      json: { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded" },
    }),
  );
  await page.goto("/");
  const error = page.getByText(/업무 목록 조회 실패:.*요청 제한/).first();
  await expect(error).toBeVisible();
  await expect(error).toContainText("12초 뒤");
  await expect(error).toContainText("HTTP 429");
  await expect(error).toContainText("ui-request-429");
  await expect(
    page.getByText("요청을 처리할 수 없습니다.", { exact: true }),
  ).toHaveCount(0);
});

test("HTML 오류 응답은 원문 대신 실패 작업과 응답 형식을 안내한다", async ({
  page,
}) => {
  await page.route("**/api/tasks?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><p>private upstream login page</p>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText(/업무 목록 조회 실패:.*예상한 데이터 형식/).first(),
  ).toBeVisible();
  await expect(page.getByText(/INVALID_RESPONSE/).first()).toBeVisible();
  await expect(page.getByText(/private upstream|Unexpected token/)).toHaveCount(
    0,
  );
});
