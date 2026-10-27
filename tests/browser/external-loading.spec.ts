import { test, expect } from "@playwright/test";
import { unpack } from "../../shared/compact.js";

test("최초 가져오기 전에는 로딩 대신 가져오기 안내를 표시하고 같은 팀의 가져오기 완료 후 업무를 조회한다", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  let imported = false;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...boot,
        site: "external",
        authMode: "access",
        accountLinking: true,
        teams: boot.teams.map((team: object) => ({
          ...team,
          status: imported ? "active" : "unconnected",
        })),
      },
    }),
  );
  await page.route("**/api/admin/service-connections", (route) =>
    route.fulfill({
      json: {
        site: "external",
        siteName: "팀 외부",
        database: { provider: "PostgreSQL", version: 1, status: "ok" },
        profiles: [
          {
            profileId: "team",
            teamId: boot.teams[0].id,
            name: "팀 자원",
            ready: true,
          },
        ],
      },
    }),
  );
  await page.route("**/api/admin/sync/import", (route) => {
    imported = true;
    return route.fulfill({ json: { ok: true } });
  });
  let taskReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/tasks") taskReads++;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "팀 자료를 가져와 주세요" }),
  ).toBeVisible();
  await expect(
    page.getByText("업무를 불러오는 중", { exact: true }),
  ).toHaveCount(0);
  expect(taskReads).toBe(0);
  await page.getByRole("button", { name: "설정 열기" }).click();
  const settings = page.getByRole("dialog", { name: "설정", exact: true });
  await settings
    .getByRole("button", { name: "서비스 연결", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "팀 가져오기", exact: true })
    .click();
  await expect.poll(() => taskReads).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "팀 자료를 가져와 주세요" }),
  ).toHaveCount(0);
});

test("업무 조회 실패 시 로딩을 끝내고 재연결 방법을 표시한다", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
  await page.route("**/api/tasks?**", (route) =>
    route.fulfill({ status: 503, json: { error: "조회 실패 검증" } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "업무를 불러오지 못했습니다" }),
  ).toBeVisible();
  await expect(
    page.getByText("업무를 불러오는 중", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "다시 연결", exact: true }),
  ).toBeVisible();
});
