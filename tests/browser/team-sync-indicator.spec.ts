import { test, expect, type Page } from "@playwright/test";
import { unpack } from "../../shared/compact.js";
import type { SyncStatus } from "../../src/sync-types";

const indicator = (page: Page) =>
  page.getByRole("status", { name: "팀 동기화 상태", exact: true });
const stages = (page: Page) => indicator(page).locator(".tag");
const complete = ["외부 클라우드 저장", "Git 반영", "내부망 반영 완료"];
const blue = "rgb(29, 78, 216)";
const gray = "rgb(100, 116, 139)";
const active = (): SyncStatus => ({
  mode: "active",
  canonicalHead: "current-team-head",
  pending: 0,
  conflicts: 0,
  lastLocalSavedAt: new Date().toISOString(),
  lastPublishedAt: new Date().toISOString(),
  remoteStatus: {
    verified: true,
    mode: "active",
    appliedCanonicalHead: "current-team-head",
    observedAt: new Date().toISOString(),
  },
});

async function setup(
  page: Page,
  site: "internal" | "external",
  initial: SyncStatus | null = active(),
  configured = true,
) {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  boot.teams = boot.teams.map((team: { id: string }) => ({
    ...team,
    sync: { available: configured, configured },
  }));
  // Both deployments use the same test URL. The server's explicit site setting
  // must take precedence even over the legacy authMode fallback.
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...boot,
        site,
        authMode: site === "internal" ? "access" : "password",
        accountLinking: site === "external",
      },
    }),
  );
  let status = initial;
  await page.route("**/api/teams/*/sync", (route) =>
    route.fulfill({
      status: status ? 200 : 503,
      json: status || { error: "동기화 상태 조회 실패" },
    }),
  );
  await page.route("**/api/teams/*/sync/refresh", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  const isStatus = (url: string) => /\/api\/teams\/[^/]+\/sync$/.test(url);
  const first = configured
    ? page.waitForResponse((response) => isStatus(response.url()))
    : Promise.resolve();
  await page.goto("/");
  await first;
  await expect(page.getByLabel("팀 선택")).toBeVisible();
  const refresh = async (next: SyncStatus | null) => {
    status = next;
    const response = page.waitForResponse((result) => isStatus(result.url()));
    // Exercise the normal focus refresh; hidden indicators must keep monitoring.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await (await response).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  return Object.assign(refresh, { boot });
}

test("내부망은 정상·전송 대기를 숨기고 장애·중단만 표시한 뒤 복구 시 숨긴다", async ({
  page,
}) => {
  const refresh = await setup(page, "internal");
  await expect(indicator(page)).toHaveCount(0);
  await refresh({ ...active(), pending: 3, remoteStatus: null });
  await expect(indicator(page)).toHaveCount(0);
  for (const [state, text] of [
    [{ ...active(), lastError: "Git 접속 실패" }, "외부 동기화 오류"],
    [{ ...active(), conflicts: 2 }, "공유 충돌 2"],
    [{ ...active(), mode: "recovery" }, "복구 점검 필요"],
    [{ ...active(), mode: "paused" }, "동기화 일시정지"],
    [{ ...active(), mode: "disconnected" }, "동기화 연결 해제"],
    [null, "동기화 확인 불가"],
  ] as const) {
    await refresh(state);
    await expect(indicator(page)).toHaveText(text);
  }
  await refresh(active());
  await expect(indicator(page)).toHaveCount(0);
  await refresh({ mode: "unlinked", pending: 0, conflicts: 0 });
  await expect(indicator(page)).toHaveCount(0);
});

for (const site of ["internal", "external"] as const) {
  test(`${site}: 미설정 팀은 설정 진입점을 제공하고 오류·백그라운드 동기화 요청을 숨긴다`, async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        /\/api\/teams\/[^/]+\/(sync|access-requests)(?:\/|$)/.test(
          request.url(),
        )
      )
        requests.push(request.url());
    });
    await page.clock.install();
    // Even an unavailable sync endpoint cannot affect an ordinary team.
    await setup(page, site, null, false);
    await expect(indicator(page)).toHaveCount(0);
    if (site === "internal") {
      await page.getByRole("button", { name: "내 계정", exact: true }).click();
      await expect(
        page.getByRole("menuitem", { name: "비밀번호 변경", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "일반", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "외부 동기화", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "구성원", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Google 계정 연결", exact: true }),
    ).toHaveCount(0);
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const refreshed = page.waitForResponse("**/api/bootstrap");
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++)
        window.dispatchEvent(new Event("graeboard:local-save"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await refreshed;
    await page.clock.runFor(65000);
    await expect(indicator(page)).toHaveCount(0);
    expect(requests).toEqual([]);
  });
}

test("설정 변경 반영 시 상태 조회와 예약된 저장 알림을 정리하고 재설정 뒤 다시 확인한다", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/teams\/[^/]+\/sync(?:\/|$)/.test(request.url()))
      requests.push(request.url());
  });
  await page.clock.install();
  const refresh = await setup(page, "external", {
    ...active(),
    lastError: "Git 실패",
  });
  await expect(indicator(page)).toHaveText("외부 동기화 오류");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event("graeboard:local-save")),
  );
  for (const team of refresh.boot.teams)
    team.sync = { available: false, configured: false };
  const response = page.waitForResponse("**/api/bootstrap");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
  await expect(indicator(page)).toHaveCount(0);
  const before = requests.length;
  await page.clock.runFor(65000);
  expect(requests).toHaveLength(before);
  for (const team of refresh.boot.teams)
    team.sync = { available: true, configured: true };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(indicator(page)).toHaveText("외부 동기화 오류");
  expect(requests.length).toBeGreaterThan(before);
});

test("외부 저장 알림이 연속되면 마지막 저장 2초 후 상태를 한 번 조회한다", async ({
  page,
}) => {
  let reads = 0;
  page.on("request", (request) => {
    if (/\/api\/teams\/[^/]+\/sync$/.test(request.url())) reads++;
  });
  await page.clock.install();
  await setup(page, "external");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const before = reads;
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("graeboard:local-save")),
    );
    await page.clock.runFor(1000);
  }
  expect(reads).toBe(before);
  await page.clock.runFor(900);
  expect(reads).toBe(before);
  await page.clock.runFor(200);
  await expect.poll(() => reads).toBe(before + 1);
});

test("외부망은 클라우드 저장·Git·내부망 반영을 구분하고 확인되지 않은 완료를 표시하지 않는다", async ({
  page,
}) => {
  const refresh = await setup(page, "external");
  await expect(stages(page)).toHaveText(complete);
  for (const index of [0, 1, 2])
    await expect(stages(page).nth(index)).toHaveCSS("color", blue);
  await expect(indicator(page)).not.toHaveAttribute("title", /로컬 저장|상대/);
  await refresh({ ...active(), pending: 2 });
  await expect(stages(page)).toHaveText([
    "외부 클라우드 저장",
    "Git 대기 2",
    "내부망 반영 대기",
  ]);
  await expect(stages(page).nth(0)).toHaveCSS("color", blue);
  for (const index of [1, 2])
    await expect(stages(page).nth(index)).toHaveCSS("color", gray);
  for (const remoteStatus of [
    null,
    { ...active().remoteStatus!, verified: false },
    { ...active().remoteStatus!, appliedCanonicalHead: "previous-head" },
    {
      ...active().remoteStatus!,
      observedAt: new Date(Date.now() - 240000).toISOString(),
    },
  ]) {
    await refresh(active());
    await expect(stages(page)).toHaveText(complete);
    await refresh({ ...active(), remoteStatus });
    await expect(stages(page)).toHaveText([
      "외부 클라우드 저장",
      "Git 반영",
      "내부망 반영 대기",
    ]);
    await expect(stages(page).nth(1)).toHaveCSS("color", blue);
    await expect(stages(page).nth(2)).toHaveCSS("color", gray);
  }
  await refresh({ ...active(), lastError: "Git 접속 실패" });
  await expect(indicator(page)).toHaveText("외부 동기화 오류");
  await expect(indicator(page)).toHaveAttribute("title", /Git 접속 실패/);
  await refresh(active());
  await expect(stages(page)).toHaveText(complete);
  await page.setViewportSize({ width: 600, height: 900 });
  for (const stage of await stages(page).all()) {
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(600);
  }
  await page.screenshot({
    path: test.info().outputPath("sync-tags-mobile.png"),
  });
});

for (const site of ["internal", "external"] as const) {
  test(`${site}: 최초 상태 조회가 실패해도 오류를 표시하고 재조회로 복구한다`, async ({
    page,
  }) => {
    const refresh = await setup(page, site, null);
    await expect(indicator(page)).toHaveText("동기화 확인 불가");
    await refresh(active());
    if (site === "internal") await expect(indicator(page)).toHaveCount(0);
    else await expect(stages(page)).toHaveText(complete);
  });
}

test("외부 업무 저장 중·실패는 세 태그를 대기로 두고 클라우드 용어를 유지한다", async ({
  page,
}) => {
  await setup(page, "external");
  await expect(stages(page)).toHaveText(complete);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/cells/batch", async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: "저장 실패 검증" } });
  });
  try {
    await page.locator('[data-cell$=":title"]').first().dblclick();
    const editor = page.locator(".inline-editor textarea");
    await editor.fill("동기화 태그 저장 시험");
    await editor.press("Enter");
    await expect(stages(page)).toHaveText([
      "외부 클라우드 저장 중",
      "Git 대기",
      "내부망 반영 대기",
    ]);
    for (const index of [0, 1, 2])
      await expect(stages(page).nth(index)).toHaveCSS("color", gray);
    release();
    await expect(stages(page)).toHaveText([
      "외부 클라우드 저장 실패",
      "Git 대기",
      "내부망 반영 대기",
    ]);
  } finally {
    release();
  }
});
