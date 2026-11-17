import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
test("변경 이력은 연간 열의 금요일을 표시하고 복원에는 월요일 키를 유지한다", async ({
  page,
}) => {
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return unpack(await response.json());
  };
  await post("/auth/login", { username: "test@somansa.com", password: "1234" });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const team = await post("/admin/teams", {
    name: `이력 날짜 ${randomUUID().slice(0, 8)}`,
    members: [{ userId: boot.user.id, role: "lead" }],
  });
  const { task } = await post("/tasks", {
    teamId: team.id,
    year: 2026,
    fields: { title: "금요일 표시 확인" },
  });
  await post("/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      { taskId: task.id, key: "2026-11-16", value: "검토", expectedVersion: 0 },
      {
        taskId: task.id,
        key: "2026-12-28",
        value: "연도 경계",
        expectedVersion: 0,
      },
    ],
  });
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  await expect(page.locator('[data-header-key="2026-11-16"]')).toContainText(
    "11/20",
  );
  await expect(page.locator('[data-header-key="2026-12-28"]')).toContainText(
    "1/1",
  );
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "변경 이력", exact: true });
  const entry = panel.locator("details").filter({ hasText: "셀 편집" }).first();
  await entry.locator("summary").click();
  await expect(entry.locator(".audit-changes")).toContainText("2026-11-20(금)");
  await expect(entry.locator(".audit-changes")).toContainText("2027-01-01(금)");
  await expect(entry.locator(".audit-changes")).not.toContainText("2026-11-16");
  const restore = page.waitForRequest((request) =>
    /\/audit\/[^/]+\/restore$/.test(request.url()),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await entry
    .getByRole("button", { name: "변경 전으로 복원", exact: true })
    .click();
  expect((await restore).postDataJSON().versions).toEqual({
    [`${task.id}:2026-11-16`]: 1,
    [`${task.id}:2026-12-28`]: 1,
  });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const audit = unpack(
    await (
      await page.request.get(`/api/audit?teamId=${team.id}&sheetId=original`)
    ).json(),
  );
  const original = audit.entries.find((entry: any) => entry.action === "cells");
  expect(original.after.map((cell: any) => cell.key)).toEqual([
    "2026-11-16",
    "2026-12-28",
  ]);
});
