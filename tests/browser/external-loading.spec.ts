import { test, expect } from "@playwright/test";
import { unpack } from "../../shared/compact.js";

for (const status of ["unconnected", "importing"] as const) {
  const heading =
    status === "unconnected"
      ? "팀 자료를 가져와 주세요"
      : "팀 연결을 확인해 주세요";
  test(`${status} 팀은 업무·사본·실시간 조회를 보류하고 가져오기 완료 후 시작한다`, async ({
    page,
  }) => {
    await page.request.post("/api/auth/login", {
      headers: { "X-Requested-With": "WeeklyPlan" },
      data: { username: "test@somansa.com", password: "1234" },
    });
    const boot = unpack(
      await (await page.request.get("/api/bootstrap")).json(),
    );
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
            status: imported ? "active" : status,
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
    let reportReads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/tasks") taskReads++;
      if (new URL(request.url()).pathname === "/api/reports") reportReads++;
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(
      page.getByText("업무를 불러오는 중", { exact: true }),
    ).toHaveCount(0);
    expect(taskReads).toBe(0);
    expect(reportReads).toBe(0);
    await page.getByRole("button", { name: "설정 열기" }).click();
    const settings = page.getByRole("dialog", { name: "설정", exact: true });
    await settings
      .getByRole("button", { name: "서비스 연결", exact: true })
      .click();
    expect(await (await page.request.get("/__test/streams")).json()).toEqual(
      [],
    );
    await settings
      .getByRole("button", { name: "팀 가져오기", exact: true })
      .click();
    await expect.poll(() => taskReads).toBeGreaterThan(0);
    await expect.poll(() => reportReads).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/__test/streams")).json()).length,
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);
  });
}

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
