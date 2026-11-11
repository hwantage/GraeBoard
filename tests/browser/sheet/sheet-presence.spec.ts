import { unpack } from "../../../shared/formatting/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post("/api" + path, { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}
async function open(page: Page, teamId: string, taskId: string) {
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(page.locator(`[data-cell="${taskId}:title"]`)).toBeVisible();
}

test("같은 사내 서버의 다른 사람이 선택·편집 중인 셀에 이름과 색을 표시한다", async ({
  page,
  browser,
}, info) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await post(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  const teamId = (
    await post(page, "/admin/teams", {
      name: "위치 표시 " + randomUUID().slice(0, 8),
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  const taskIds: string[] = [];
  for (const title of ["첫 업무", "둘째 업무"])
    taskIds.push(
      (await post(page, "/tasks", { teamId, year: 2026, fields: { title } }))
        .task.id,
    );
  const username = `presence-${randomUUID()}@example.com`;
  await post(page, "/admin/users", {
    username,
    name: "옆자리 팀원",
    password: "presence-peer-password",
    memberships: [{ teamId, role: "member" }],
  });
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    const peer = await context.newPage();
    await post(peer, "/auth/login", {
      username,
      password: "presence-peer-password",
    });
    await open(page, teamId, taskIds[0]);
    await open(peer, teamId, taskIds[0]);
    const marker = (key: string, taskId = taskIds[0]) =>
      page.locator(`[data-cell="${taskId}:${key}"] .sheet-presence`);
    await peer.locator(`[data-cell="${taskIds[0]}:title"]`).click();
    await expect(marker("title")).toHaveAttribute("data-name", "옆자리 팀원");
    await expect(marker("title")).not.toHaveAttribute("data-editing");
    // The name tag is drawn by CSS, so the cell's own text stays the same.
    await expect(page.locator(`[data-cell="${taskIds[0]}:title"]`)).toHaveText(
      "첫 업무",
    );
    // A second tab of the same browser joins the shared stream and still gets
    // the current positions without anyone moving.
    const second = await page.context().newPage();
    await open(second, teamId, taskIds[0]);
    await expect(
      second.locator(`[data-cell="${taskIds[0]}:title"] .sheet-presence`),
    ).toHaveAttribute("data-name", "옆자리 팀원");
    await second.close();
    // The person's own selection is not drawn as someone else's.
    await expect(
      peer.locator(`[data-cell="${taskIds[0]}:title"] .sheet-presence`),
    ).toHaveCount(0);
    await peer.locator(`[data-cell="${taskIds[0]}:title"]`).dblclick();
    await expect(marker("title")).toHaveAttribute("data-editing", "true");
    await page
      .locator(".sheet-scroll")
      .screenshot({ path: info.outputPath("presence-editing.png") });
    await peer.keyboard.press("Escape");
    await expect(marker("title")).not.toHaveAttribute("data-editing");
    await peer.locator(`[data-cell="${taskIds[1]}:title"]`).click();
    await expect(marker("title", taskIds[1])).toHaveAttribute(
      "data-name",
      "옆자리 팀원",
    );
    await peer.locator(`[data-cell="${taskIds[1]}:2026-01-05"]`).click();
    await expect(marker("2026-01-05", taskIds[1])).toHaveAttribute(
      "data-name",
      "옆자리 팀원",
    );
    await page
      .locator(".sheet-scroll")
      .screenshot({ path: info.outputPath("presence-week.png") });
    await peer.locator(`[data-cell="${taskIds[1]}:title"]`).click();
    await expect(marker("title")).toHaveCount(0);
    await peer.getByRole("button", { name: "캘린더", exact: true }).click();
    await expect(page.locator(".sheet-presence")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
