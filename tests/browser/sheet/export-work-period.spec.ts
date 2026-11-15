import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView } from "../../../shared/domain.js";
import { unpack } from "../../../shared/formatting/compact.js";
import { writePreferences } from "../support/preferences";
import { selectMonths } from "../support/annual-period";

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

test("선택 기간 수행 업무는 원본·사본에서 숨김과 필터를 넘어 업무 표시만 세고 기존 내보내기 경로로 저장한다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await request(page, "/auth/login", {
    username: "test@somansa.com",
    password: "1234",
  });
  const userId = (await request(page, "/bootstrap")).user.id;
  const teamId = (
    await request(page, "/admin/teams", {
      name: `기간 내보내기 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
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
  const titles = [
    "기간 업무",
    "기간 밖 업무",
    "일반 배경",
    "숨긴 업무",
    "필터 제외 업무",
    "상속 업무",
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
  await request(page, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: [
      [0, "2026-09-28", true],
      [0, "2026-11-23", true],
      [1, "2026-09-21", true],
      [2, "2026-10-05", false],
      [3, "2026-10-05", true],
      [4, "2026-11-23", true],
    ].map(([index, key, work]) => ({
      taskId: tasks[index as number].id,
      key,
      expectedVersion: 0,
      expectedFormatRevision: tasks[index as number].formatting?.revision || 0,
      ...(index === 0 && key === "2026-09-28" ? { value: "리뷰 회의" } : {}),
      style: { backgroundColor: "#0066cc", work },
    })),
  });
  // An effective common rule must count even though the week has no own cell.
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
          rows: [tasks[5].id],
          keys: ["2026-10-12"],
          style: { backgroundColor: "#0066cc", work: true },
        },
      ],
    },
  });
  const view = {
    ...defaultView(2026),
    fromWeek: "2026-09-28",
    toWeek: "2026-11-23",
    visibleFields: ["title"],
    knownProperties: ["title", "owner", "status"],
    columnVisibility: { title: true, owner: true, status: true },
    hiddenRows: [tasks[3].id],
    propertyFilters: { title: [titles[0], titles[2], titles[3], titles[5]] },
  };
  const preferences = await writePreferences(page, {
    data: { teamId, name: "__current", data: view },
  });
  expect(preferences.ok(), await preferences.text()).toBeTruthy();
  const copyName = "기간 내보내기 사본";
  await request(page, "/sheet-clones", {
    teamId,
    year: 2026,
    name: copyName,
    referenceDate: "2026-11-15",
    taskIds: tasks.map((t) => t.id),
    view,
  });
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId, teamId },
  );
  await page.goto("/");
  await expect(page.locator('[data-column="title"]')).toHaveText([
    titles[0],
    titles[2],
    titles[5],
  ]);

  const downloads = async (
    scope: string,
    expected: string[],
    workedCount = 4,
    format = "csv",
  ) => {
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    const box = page.getByRole("dialog", {
      name: "업무 내보내기",
      exact: true,
    });
    await expect(
      box.getByLabel("내보낼 범위").locator('option[value="worked"]'),
    ).toHaveText(
      `선택 기간 수행 업무 · 10월 1주~11월 4주 · ${workedCount}개 업무`,
    );
    await box.getByLabel("내보낼 범위").selectOption(scope);
    if (scope === "worked")
      await box.screenshot({ path: info.outputPath("export-work-period.png") });
    await box.getByLabel("파일 형식").selectOption(format);
    if (format === "json-data") {
      await expect(
        box.getByLabel("파일 형식").locator("option:checked"),
      ).toHaveText("JSON (.json) · 업무 데이터");
      await box.screenshot({ path: info.outputPath(`json-data-${scope}.png`) });
    }
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      box.getByRole("button", { name: "내보내기", exact: true }).click(),
    ]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (format === "json-data") {
      const data = JSON.parse(text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.map((row: any) => row.작업)).toEqual(expected);
      for (const row of data) {
        expect(Object.keys(row)).toEqual(
          scope === "all" ? ["작업", "팀원", "상태"] : ["작업"],
        );
      }
      expect(download.suggestedFilename().normalize("NFC")).toBe(
        scope === "all"
          ? "graeboard-2026-tasks.json"
          : "graeboard-2026년-10월1주~11월4주-tasks.json",
      );
      expect(text).not.toContain("리뷰 회의");
    } else if (format === "json") {
      const data = unpack(JSON.parse(text));
      expect(data.schemaVersion).toBe(7);
      expect(data.tasks).toHaveLength(expected.length);
      expect(data.tasks.map((task: any) => task.cells.title?.value)).toEqual(
        expected,
      );
      expect(download.suggestedFilename().normalize("NFC")).toBe(
        scope === "all"
          ? "graeboard-2026.json"
          : "graeboard-2026년-10월1주~11월4주.json",
      );
    }
    if (format !== "json")
      for (const title of titles)
        expect(text.includes(title), title).toBe(expected.includes(title));
    await expect(box).toHaveCount(0);
  };
  await downloads("worked", [titles[0], titles[3], titles[4], titles[5]]);
  await downloads("view", [titles[0], titles[2], titles[5]]);
  await downloads("all", titles);
  await downloads("view", [titles[0], titles[2], titles[5]], 4, "json-data");
  await downloads(
    "worked",
    [titles[0], titles[3], titles[4], titles[5]],
    4,
    "json-data",
  );
  await downloads("all", titles, 4, "json-data");
  await downloads("view", [titles[0], titles[2], titles[5]], 4, "json");
  await downloads("all", titles, 4, "json");
  const tab = page.getByRole("tab", { name: copyName, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await downloads("worked", [titles[0], titles[3], titles[4], titles[5]]);
  await downloads(
    "worked",
    [titles[0], titles[3], titles[4], titles[5]],
    4,
    "json-data",
  );
  await downloads("all", titles, 4, "json-data");

  await selectMonths(page, 2026, 1);
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const box = page.getByRole("dialog", { name: "업무 내보내기", exact: true });
  await expect(
    box.getByLabel("내보낼 범위").locator('option[value="worked"]'),
  ).toHaveText(/선택 기간 수행 업무 · 1월 1주~1월 5주 · 0개 업무/);
  await box.getByLabel("내보낼 범위").selectOption("worked");
  await box.getByLabel("파일 형식").selectOption("json-data");
  const [empty] = await Promise.all([
    page.waitForEvent("download"),
    box.getByRole("button", { name: "내보내기", exact: true }).click(),
  ]);
  const chunks = [];
  for await (const chunk of (await empty.createReadStream())!)
    chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  expect(JSON.parse(text)).toEqual([]);
  expect(empty.suggestedFilename().normalize("NFC")).toBe(
    "graeboard-2026년-1월1주~1월5주-tasks.json",
  );
  for (const title of titles) expect(text).not.toContain(title);

  for (const [week, extend, filename] of [
    ["2026-09-28", 0, "graeboard-2026년-10월1주-tasks.json"],
    ["2026-12-21", 2, "graeboard-2026년12월4주~2027년1월2주-tasks.json"],
  ] as const) {
    if (extend)
      await page
        .getByRole("button", { name: "다음 달로 이동", exact: true })
        .click();
    const start = page.locator(`.period-week[data-week="${week}"]`);
    await start.click();
    for (let index = 0; index < extend; index++)
      await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    await box.getByLabel("내보낼 범위").selectOption("worked");
    await box.getByLabel("파일 형식").selectOption("json-data");
    const [result] = await Promise.all([
      page.waitForEvent("download"),
      box.getByRole("button", { name: "내보내기", exact: true }).click(),
    ]);
    expect(result.suggestedFilename().normalize("NFC")).toBe(filename);
    await expect(box).toHaveCount(0);
  }
});
