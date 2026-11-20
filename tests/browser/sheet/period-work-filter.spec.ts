import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView } from "../../../shared/domain.js";
import { unpack } from "../../../shared/formatting/compact.js";
import { writePreferences } from "../support/preferences";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function request(
  page: Page,
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data ? { data } : {}),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}

test("선택 기간 업무 필터는 고른 주차에 업무 표시가 있는 업무만 보여 주고 저장하지 않는다", async ({
  page,
}, info) => {
  await request(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const userId = (await request(page, "/bootstrap")).user.id;
  const teamId = (
    await request(page, "/admin/teams", {
      name: `기간 필터 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  const titles = [
    "기간 업무",
    "기간 밖 업무",
    "일반 배경",
    "상속 업무",
    "표시 없음",
  ];
  const tasks = [];
  for (const title of titles)
    tasks.push(
      (
        await request(page, "/tasks", {
          teamId,
          year: 2026,
          fields: { title, owner: userId },
        })
      ).task,
    );
  const view = {
    ...defaultView(2026),
    fromWeek: "2026-09-28",
    toWeek: "2026-11-23",
    visibleFields: ["title"],
    knownProperties: ["title", "owner", "status"],
    columnVisibility: { title: true, owner: true, status: true },
  };
  const preferences = await writePreferences(page, {
    data: { teamId, name: "__current", data: view },
  });
  expect(preferences.ok(), await preferences.text()).toBeTruthy();
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId, teamId },
  );
  const rows = page.locator('[data-column="title"]');
  const toggle = page.getByRole("button", {
    name: /선택 기간에 업무 표시가 있는 업무만 보기|업무 색상을 등록하면/,
  });

  // Without work colors there is nothing to filter by.
  await page.goto("/");
  await expect(rows).toHaveText(titles);
  await expect(toggle).toBeDisabled();

  const settings = (await request(page, "/bootstrap")).teams.find(
    (t: any) => t.id === teamId,
  ).settings;
  await request(
    page,
    `/teams/${teamId}/settings`,
    {
      revision: settings.revision || 0,
      insights: {
        workColors: [{ color: "#0066cc", name: "수행" }],
        charts: [],
      },
    },
    "PATCH",
  );
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      [0, "2026-10-05", true],
      [1, "2026-03-02", true],
      [2, "2026-10-05", false],
    ].map(([index, key, work]) => ({
      taskId: tasks[index as number].id,
      key,
      expectedVersion: 0,
      expectedFormatRevision: tasks[index as number].formatting?.revision || 0,
      style: { backgroundColor: "#0066cc", work },
    })),
  });
  // An inherited work mark counts although the week has no own cell.
  const current = (await request(page, `/tasks?teamId=${teamId}&year=2026`))
    .tasks;
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    format: {
      teamId,
      expectedRevision: current[0].formatting?.revision || 0,
      expectedTasks: Object.fromEntries(
        current.map((task: any) => [task.id, task.updatedAt]),
      ),
      scopes: [
        {
          rows: [tasks[3].id],
          keys: ["2026-10-12"],
          style: { backgroundColor: "#0066cc", work: true },
        },
      ],
    },
  });

  await page.reload();
  await expect(rows).toHaveText(titles);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveText([titles[0], titles[3]]);
  await page.screenshot({ path: info.outputPath("period-work-filter.png") });

  // The list follows the selected period.
  await page.getByRole("button", { name: "2026년 전체 선택" }).click();
  await expect(rows).toHaveText([titles[0], titles[1], titles[3]]);

  const reset = page.getByRole("button", { name: "모든 필터 초기화" });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveText(titles);
  await expect(reset).toBeDisabled();

  // The switch is not stored: a reload shows every task again.
  await toggle.click();
  await expect(rows).toHaveText([titles[0], titles[1], titles[3]]);
  await page.reload();
  await expect(rows).toHaveText(titles);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
