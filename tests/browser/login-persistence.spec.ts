import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("브라우저를 완전히 종료하고 다시 열어도 로그인하며 직접 로그아웃하면 해제된다", async ({
  playwright,
  browserName,
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), "graeboard-login-profile-"));
  const engine = playwright[browserName];
  let context = await engine.launchPersistentContext(profile, { baseURL });
  try {
    const login = await context.request.post("/api/auth/login", {
      headers: { "X-Requested-With": "WeeklyPlan" },
      data: { username: "test@somansa.com", password: "1234" },
    });
    expect(login.ok()).toBe(true);
    const cookie = (await context.cookies()).find(
      (item) => item.name === "weekly_session",
    )!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(
      29 * 24 * 60 * 60 * 1000,
    );
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByLabel("팀 선택")).toBeVisible();
    await context.close();
    context = await engine.launchPersistentContext(profile, { baseURL });
    const reopened = await context.newPage();
    const logins: string[] = [];
    reopened.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/login")
        logins.push(request.url());
    });
    await reopened.goto("/");
    await expect(reopened.getByLabel("팀 선택")).toBeVisible();
    expect(logins).toEqual([]);
    await reopened
      .getByRole("button", { name: "내 계정", exact: true })
      .click();
    await reopened
      .getByRole("menuitem", { name: "로그아웃", exact: true })
      .click();
    await reopened.reload();
    await expect(
      reopened.getByRole("button", { name: "로그인", exact: true }),
    ).toBeVisible();
    expect(
      (await context.cookies())
        .filter((item) => item.name === "weekly_session")
        .map((item) => ({
          expires: item.expires,
          hasValue: !!item.value,
          httpOnly: item.httpOnly,
        })),
    ).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
