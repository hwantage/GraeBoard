import { test, expect, type Page } from "@playwright/test";
import { unpack } from "../../../shared/formatting/compact.js";
import type { SyncLogEntry } from "../../../src/sync/sync-log-types";

const head = "a81b04e6f0c2d94b7715e3a6c1d2f8b09e4a7c35",
  ahead = "3f9a2c1d5b7e80461a2c9d3f4e5b6a7c8d9e0f12",
  at = (time: string) => `2026-11-13T${time}.000Z`;
// Newest first, as the server returns them.
const entries: SyncLogEntry[] = [
  {
    at: at("05:03:12"),
    line: 7,
    kind: "cycle",
    action: "run",
    ok: true,
    recovered: true,
    ms: 1840,
    mode: "active",
    head: ahead,
    headBefore: head,
    commits: 1,
    received: true,
    published: false,
    pending: 0,
    conflicts: 0,
    peerHead: ahead,
    peerObservedAt: at("05:03:02"),
    peerVerified: true,
  },
  {
    at: at("05:02:11"),
    line: 6,
    kind: "cycle",
    action: "run",
    ok: false,
    ms: 6120,
    mode: "active",
    head,
    received: false,
    published: true,
    pending: 0,
    conflicts: 0,
    peerHead: head,
    peerObservedAt: at("05:01:02"),
    peerVerified: true,
    error: { message: "Git operation failed (128, merge-base)", code: 128 },
  },
  {
    at: at("05:02:11"),
    line: 5,
    kind: "git",
    command: "merge-base",
    args: `merge-base --is-ancestor ${head} ${ahead}`,
    ok: false,
    code: 128,
    ms: 14,
    stderr: `fatal: Not a valid commit name ${ahead}`,
  },
  {
    at: at("05:02:04"),
    line: 4,
    kind: "action",
    action: "run",
    ok: true,
    actor: { id: "u1", name: "김팀장" },
  },
  {
    at: at("05:01:10"),
    line: 3,
    kind: "cycle",
    action: "run",
    ok: true,
    ms: 930,
    mode: "active",
    head,
    received: false,
    published: false,
    pending: 2,
    conflicts: 0,
    peerHead: head,
    peerObservedAt: at("05:01:02"),
    peerVerified: true,
  },
  {
    at: at("04:40:00"),
    line: 2,
    kind: "state",
    change: "mode",
    from: "paused",
    to: "active",
  },
  {
    at: at("04:39:58"),
    line: 1,
    kind: "image",
    path: "images/team/abc.webp",
    reason: "missing locally",
  },
  {
    at: at("04:39:50"),
    line: 0,
    kind: "server",
    event: "start",
    pid: 4310,
    node: "v22.13.0",
  },
];

async function open(
  page: Page,
  { systemAdmin = true, site = "internal" } = {},
) {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const teamId = boot.teams[0].id;
  boot.teams = boot.teams.map((team: { id: string }) => ({
    ...team,
    sync: { available: true, configured: true },
  }));
  if (!systemAdmin) boot.user = { ...boot.user, systemRole: "user" };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...boot,
        site,
        authMode: site === "internal" ? "access" : "password",
      },
    }),
  );
  // The system administrator's settings list teams from this response.
  await page.route("**/api/admin/users", async (route) => {
    const data = unpack(await (await route.fetch()).json());
    data.teams = boot.teams;
    await route.fulfill({ json: data });
  });
  await page.route("**/api/teams/*/sync", (route) =>
    route.fulfill({
      json: {
        mode: "active",
        profileId: "team",
        canonicalHead: head,
        pending: 0,
        conflicts: 0,
        lastError: "Git operation failed (128, merge-base)",
      },
    }),
  );
  await page.route("**/api/teams/*/sync/refresh", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/admin/teams/*/connection", (route) =>
    route.fulfill({
      json: {
        profileId: "team",
        revision: 1,
        profiles: [
          {
            profileId: "team",
            name: "team",
            teamId,
            repository: "https://github.com/example/data",
            database: "SQLite",
            images: "내부 이미지 폴더",
            ready: true,
          },
        ],
      },
    }),
  );
  let level = "cycles";
  const requests: URL[] = [];
  await page.route("**/api/teams/*/sync/log?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const date = url.searchParams.get("date") || "2026-11-13",
      before = url.searchParams.get("before"),
      matching =
        date !== "2026-11-13"
          ? []
          : entries.filter(
              (entry) =>
                url.searchParams.get("problems") !== "1" ||
                entry.ok === false ||
                ["state", "worker", "image"].includes(entry.kind),
            ),
      // Two pages so "more" is exercised.
      shown = matching.filter((entry) =>
        before === null ? entry.line >= 3 : entry.line < Number(before),
      );
    return route.fulfill({
      json: {
        level,
        levels: ["changes", "cycles", "git"],
        canSetLevel: systemAdmin,
        retentionDays: 14,
        date,
        dates: ["2026-11-13", "2026-11-12"],
        entries: shown,
        next:
          before === null && matching.some((entry) => entry.line < 3)
            ? 3
            : null,
      },
    });
  });
  const levels: string[] = [];
  await page.route("**/api/admin/teams/*/sync-log-level", (route) => {
    level = unpack(route.request().postDataJSON()).level;
    levels.push(level);
    return route.fulfill({ json: { level } });
  });
  await page.route("**/api/teams/*/sync/log/download", (route) =>
    route.fulfill({
      headers: {
        "content-type": "application/x-ndjson",
        "content-disposition":
          'attachment; filename="sync-log-2026-11-13.jsonl"',
      },
      body: entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "연결 검사 및 실행", exact: true }),
  ).toBeVisible();
  return { requests, levels };
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "동기화 로그", exact: true });

test("동기화 로그 팝업은 실패한 Git 단계의 원문과 조치 안내를 보여 주고 걸러 보기·더 보기·내려받기를 한다", async ({
  page,
}) => {
  const { requests, levels } = await open(page);
  await page.getByRole("button", { name: "동기화 로그", exact: true }).click();
  const box = dialog(page);
  await expect(box).toBeVisible();
  const rows = box.locator(".sync-log-entry");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("회복 · 받음 · 커밋 1개");
  await expect(rows.nth(1)).toContainText(
    "동기화 실패 · Git operation failed (128, merge-base)",
  );
  await expect(rows.nth(2)).toContainText("git merge-base · 종료 코드 128");
  await expect(rows.nth(3)).toContainText("김팀장 · 지금 동기화");
  await expect(rows.nth(4)).toContainText("변경 없음 · 미전송 2건");
  // The failed Git command: what Git printed, and what it means.
  await rows.nth(2).getByRole("button").click();
  await expect(rows.nth(2).locator(".sync-log-raw")).toHaveText(
    `fatal: Not a valid commit name ${ahead}`,
  );
  await expect(rows.nth(2).locator(".sync-log-guidance")).toContainText(
    "외부 서버가 알린 커밋을 사내 서버가 아직 받지 않았습니다.",
  );
  await expect(rows.nth(2).locator(".sync-log-guidance")).toContainText(
    "조치가 필요 없습니다.",
  );
  await expect(rows.nth(2)).toContainText(
    `git merge-base --is-ancestor ${head} ${ahead}`,
  );
  // The failed cycle explains the same cause and shows both heads.
  await rows.nth(1).getByRole("button").click();
  await expect(rows.nth(1).locator(".sync-log-guidance")).toBeVisible();
  await expect(rows.nth(1).locator(".sync-log-raw")).toHaveText(
    `fatal: Not a valid commit name ${ahead}`,
  );
  await expect(rows.nth(1)).toContainText("a81b04e");
  // A successful cycle has no guidance.
  await rows.nth(0).getByRole("button").click();
  await expect(rows.nth(0).locator(".sync-log-guidance")).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("a81b04e → 3f9a2c1");

  await box.getByRole("button", { name: "이전 기록 더 보기" }).click();
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(5)).toContainText("상태 변경: 일시정지 → 동기화 중");
  await expect(rows.nth(6)).toContainText(
    "이미지 건너뜀 · 사내 서버에 파일 없음",
  );
  await expect(rows.nth(7)).toContainText("사내 서버 시작");
  await expect(
    box.getByRole("button", { name: "이전 기록 더 보기" }),
  ).toHaveCount(0);

  await box.getByLabel("결과").selectOption("problems");
  await expect(rows).toHaveCount(2);
  expect(requests.at(-1)!.searchParams.get("problems")).toBe("1");
  await box.getByLabel("날짜").selectOption("2026-11-12");
  await expect(
    box.getByText("이 날짜에는 실패나 상태 변화가 없습니다."),
  ).toBeVisible();
  // The filter hides entries, not the day's file.
  await expect(box.getByRole("button", { name: "내려받기" })).toBeEnabled();
  await box.getByLabel("결과").selectOption("all");
  await expect(box.getByText("이 날짜에는 기록이 없습니다.")).toBeVisible();
  await expect(box.getByRole("button", { name: "내려받기" })).toBeDisabled();
  await box.getByLabel("날짜").selectOption("2026-11-13");
  await expect(rows).toHaveCount(5);

  await box.getByLabel("기록 수준").selectOption("git");
  await expect(box.getByLabel("기록 수준")).toHaveValue("git");
  expect(levels).toEqual(["git"]);

  const saved = page.waitForEvent("download");
  await box.getByRole("button", { name: "내려받기" }).click();
  expect((await saved).suggestedFilename()).toBe("sync-log-2026-11-13.jsonl");

  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
});

test("팀장은 로그를 보되 기록 수준은 바꾸지 못하고, 좁은 화면에서도 넘치지 않는다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await open(page, { systemAdmin: false });
  await page.getByRole("button", { name: "동기화 로그", exact: true }).click();
  const box = dialog(page);
  await expect(box.locator(".sync-log-entry")).toHaveCount(5);
  await expect(box.getByLabel("기록 수준")).toBeDisabled();
  await box.locator(".sync-log-entry").nth(2).getByRole("button").click();
  await expect(box.locator(".sync-log-raw")).toBeVisible();
  expect(
    await box.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("외부 서버에는 동기화 로그 버튼이 없다", async ({ page }) => {
  await open(page, { site: "external" });
  await expect(
    page.getByRole("button", { name: "동기화 로그", exact: true }),
  ).toHaveCount(0);
});
