import { test, expect } from "@playwright/test";

test("설정 조회 실패 시 비밀번호 로그인을 표시하지 않고 재연결 후 외부 계정 연결로 진행한다", async ({
  page,
}) => {
  let unavailable = true;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: 401,
      json: { error: "연결할 사내 계정을 선택하세요." },
    }),
  );
  await page.route("**/api/setup", (route) =>
    route.fulfill(
      unavailable
        ? {
            status: 503,
            json: { error: "서비스 연결을 확인한 뒤 다시 시도하세요." },
          }
        : {
            json: {
              required: true,
              tokenRequired: true,
              authMode: "access",
              accountLinking: true,
              email: "google@example.com",
              accounts: [
                {
                  id: "leader",
                  name: "팀장",
                  username: "lead@example.com",
                  role: "lead",
                  status: "unlinked",
                },
              ],
            },
          },
    ),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "서버에 연결할 수 없습니다" }),
  ).toBeVisible();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("아이디(이메일)", { exact: true })).toHaveCount(
    0,
  );
  unavailable = false;
  await page.getByRole("button", { name: "다시 연결", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "팀장 계정 연결" }),
  ).toBeVisible();
  await expect(page.getByLabel("연결할 사내 팀장 계정")).toBeVisible();
  await expect(page.getByLabel("초기 설정 키")).toBeVisible();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
});

test("내부 서버의 설정 조회가 성공하면 기존 비밀번호 로그인을 표시한다", async ({
  page,
}) => {
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ status: 401, json: { error: "로그인하세요." } }),
  );
  await page.route("**/api/setup", (route) =>
    route.fulfill({ json: { required: false } }),
  );
  await page.goto("/");
  await expect(
    page.getByLabel("아이디(이메일)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
});
