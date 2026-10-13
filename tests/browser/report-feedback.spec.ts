import { unpack } from "../../shared/compact.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView } from "../../shared/domain.js";

async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json().then(unpack);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const modalFor = (page: Page) =>
  page.getByRole("dialog", { name: "보고서 스냅샷", exact: true });
const saveFor = (page: Page) =>
  modalFor(page).getByRole("button", { name: "현재 보기 저장", exact: true });
async function openReports(page: Page) {
  await page
    .getByRole("button", { name: "보고서 스냅샷", exact: true })
    .click();
}

let teamId: string, taskId: string;
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await post(page, "/auth/login", {
    username: "browser-test@example.com",
    password: "local-test-only-password",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await post(page, "/admin/teams", {
      name: `저장 표시 검증 ${randomUUID().slice(0, 8)}`,
      templateTeamId: boot.teams.find((t: any) => t.name === "UX기획팀 · 예시")
        .id,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  taskId = (
    await post(page, "/tasks", {
      teamId,
      year: 2026,
      fields: { title: "스냅샷에 보관할 업무" },
    })
  ).task.id;
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(
    page.getByRole("gridcell", { name: "스냅샷에 보관할 업무", exact: true }),
  ).toBeVisible();
});

test("스냅샷 저장은 토스트로 진행과 완료를 알리고 실제 카드를 갱신한다", async ({
  page,
}, info) => {
  await post(page, "/reports", {
    teamId,
    year: 2026,
    name: "이전 주 보고서",
    referenceDate: "2026-10-05",
    view: defaultView(2026),
    taskIds: [taskId],
  });
  await openReports(page);
  const modal = modalFor(page);
  await expect(modal.locator(".report-item")).toHaveCount(1);
  await modal.getByLabel("보고서 이름", { exact: true }).fill("이번 주 보고서");
  const release = deferred();
  const stored = deferred();
  let saves = 0;
  await page.route("**/api/reports", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saves++;
    const response = await route.fetch();
    stored.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await saveFor(page).click();
    await stored.promise;
    const status = modal.getByRole("status");
    await expect(status).toHaveText("스냅샷 저장 중…");
    await expect(status).toHaveClass("toast");
    await expect(status).toBeInViewport();
    await expect(status.locator(".spin")).toBeVisible();
    await expect(modal.locator(".report-item")).toHaveCount(1);
    await expect(modal.locator(".report-item").first()).toContainText(
      "이전 주 보고서",
    );
    await expect(
      modal.getByRole("button", { name: /이전 주 보고서/ }),
    ).toBeDisabled();
    await expect(saveFor(page)).toBeDisabled();
    // Even repeated form submissions must not create another snapshot.
    await modal.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    // A slow request must not turn into a successful card on a fixed timer.
    await page.waitForTimeout(750);
    await expect(status).toHaveText("스냅샷 저장 중…");
    expect(saves).toBe(1);
    await page.screenshot({ path: info.outputPath("snapshot-saving.png") });
    release.resolve();
    await expect(status).toHaveText("스냅샷을 저장했습니다.");
    await expect(status.locator(".spin")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("snapshot-saved.png") });
    const newest = modal.locator(".report-item").first();
    await expect(
      newest.getByRole("button", { name: /이번 주 보고서/ }),
    ).toBeEnabled();
    await expect(modal.locator(".report-item")).toHaveCount(2);
    await modal.screenshot({ path: info.outputPath("snapshot-ready.png") });
    // The completion highlight must release the card's regular selection color.
    await newest.getByRole("checkbox").check();
    const previous = modal.locator(".report-item").nth(1);
    await previous.getByRole("checkbox").check();
    await newest.evaluate((el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    );
    await expect(newest).toHaveCSS(
      "background-color",
      await previous.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    const reports = await (
      await page.request.get(`/api/reports?teamId=${teamId}`)
    )
      .json()
      .then(unpack);
    expect(reports.reports).toHaveLength(2);
    await newest.getByRole("button").click();
    await expect(
      page.getByRole("region", { name: "스냅샷 보기", exact: true }),
    ).toContainText("이번 주 보고서");
  } finally {
    release.resolve();
  }
});

test("빠른 스냅샷 저장도 작은 화면에서 완료 토스트를 표시하고 4초 뒤 닫는다", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 430, height: 850 });
  await openReports(page);
  const modal = modalFor(page);
  await expect(modal.getByText("저장된 스냅샷이 없습니다")).toBeVisible();
  await modal.getByLabel("보고서 이름", { exact: true }).fill("첫 보고서");
  await page.clock.install();
  await saveFor(page).click();
  const status = modal.getByRole("status");
  await expect(status).toHaveText("스냅샷을 저장했습니다.");
  await expect(status).toBeInViewport();
  await expect(status).toHaveCSS("position", "fixed");
  await expect(modal.getByText("저장된 스냅샷이 없습니다")).toHaveCount(0);
  await expect(modal.locator(".report-item-saved")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.screenshot({
    path: info.outputPath("snapshot-mobile-saved.png"),
  });
  await expect(modal.getByRole("button", { name: /첫 보고서/ })).toBeEnabled();
  await expect(modal.locator(".report-item")).toHaveCount(1);
  await page.clock.fastForward(3000);
  await expect(status).toBeVisible();
  await page.clock.fastForward(1100);
  await expect(status).toHaveCount(0);
});

test("스냅샷 저장 실패는 완료 토스트를 표시하지 않고 같은 이름으로 재시도할 수 있다", async ({
  page,
}) => {
  await openReports(page);
  const modal = modalFor(page);
  await expect(modal.getByText("저장된 스냅샷이 없습니다")).toBeVisible();
  await modal.getByLabel("보고서 이름", { exact: true }).fill("재시도 보고서");
  await page.route("**/api/reports", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "일시적 저장 실패" }),
    }),
  );
  await saveFor(page).click();
  await expect(modal.getByRole("alert")).toContainText("일시적 저장 실패");
  await expect(modal.getByRole("status")).toHaveCount(0);
  await expect(modal.locator(".report-item")).toHaveCount(0);
  await expect(saveFor(page)).toBeEnabled();
  await expect(modal.getByLabel("보고서 이름", { exact: true })).toHaveValue(
    "재시도 보고서",
  );
  await page.unroute("**/api/reports");
  await saveFor(page).click();
  await expect(modal.getByRole("alert")).toHaveCount(0);
  await expect(
    modal.getByRole("button", { name: /재시도 보고서/ }),
  ).toBeEnabled();
  await expect(modal.locator(".report-item")).toHaveCount(1);
});

test("저장 후 목록 조회만 실패하면 저장 완료를 알리고 다시 열 때 실제 스냅샷을 보여 준다", async ({
  page,
}) => {
  await openReports(page);
  const modal = modalFor(page);
  await expect(modal.getByText("저장된 스냅샷이 없습니다")).toBeVisible();
  await modal
    .getByLabel("보고서 이름", { exact: true })
    .fill("저장은 완료된 보고서");
  await page.route("**/api/reports?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "목록 조회 실패" }),
    }),
  );
  await saveFor(page).click();
  await expect(modal.getByRole("status")).toHaveText("스냅샷을 저장했습니다.");
  await expect(modal.getByRole("alert")).toContainText(
    "스냅샷은 저장되었지만 목록을 불러오지 못했습니다.",
  );
  await expect(saveFor(page)).toBeEnabled();
  await page.unroute("**/api/reports?*");
  await modal.getByRole("button", { name: "닫기", exact: true }).click();
  await openReports(page);
  await expect(
    modal.getByRole("button", { name: /저장은 완료된 보고서/ }),
  ).toBeEnabled();
  await expect(modal.locator(".report-item")).toHaveCount(1);
});

for (const phase of ["saving", "saved"] as const) {
  test(`스냅샷 ${phase} 표시 중 닫아도 늦은 응답과 타이머가 다시 연 목록에 영향을 주지 않는다`, async ({
    page,
  }) => {
    await openReports(page);
    const modal = modalFor(page);
    await expect(modal.getByText("저장된 스냅샷이 없습니다")).toBeVisible();
    await modal
      .getByLabel("보고서 이름", { exact: true })
      .fill("닫기 전 보고서");
    const release = deferred();
    const stored = deferred();
    await page.route("**/api/reports", async (route) => {
      const response = await route.fetch();
      stored.resolve();
      if (phase === "saving") await release.promise;
      await route.fulfill({ response });
    });
    try {
      await saveFor(page).click();
      await stored.promise;
      await expect(modal.getByRole("status")).toHaveText(
        phase === "saving" ? "스냅샷 저장 중…" : "스냅샷을 저장했습니다.",
      );
      await modal.getByRole("button", { name: "닫기", exact: true }).click();
      await openReports(page);
      await expect(
        modal.getByRole("button", { name: /닫기 전 보고서/ }),
      ).toBeEnabled();
      await modal
        .getByLabel("보고서 이름", { exact: true })
        .fill("다음 보고서");
      release.resolve();
      await page.waitForTimeout(1600);
      await expect(modal.getByRole("status")).toHaveCount(0);
      await expect(
        modal.getByLabel("보고서 이름", { exact: true }),
      ).toHaveValue("다음 보고서");
      await expect(modal.locator(".report-item")).toHaveCount(1);
      await expect(saveFor(page)).toBeEnabled();
    } finally {
      release.resolve();
    }
  });
}
