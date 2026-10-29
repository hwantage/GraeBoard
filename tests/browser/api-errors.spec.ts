import { test, expect } from "@playwright/test";
import { unpack } from "../../shared/compact.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/auth/login", {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data: { username: "test@somansa.com", password: "1234" },
  });
});

test("업무 조회의 플랫폼 429 응답에 원인·재시도·진단 ID를 표시한다", async ({
  page,
}) => {
  await page.route("**/api/tasks?**", (route) =>
    route.fulfill({
      status: 429,
      headers: {
        "retry-after": "12",
        "sb-error-code": "RATE_LIMIT_EXCEEDED",
        "sb-request-id": "ui-request-429",
      },
      json: { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded" },
    }),
  );
  await page.goto("/");
  const error = page.getByText(/업무 목록 조회 실패:.*요청 제한/).first();
  await expect(error).toBeVisible();
  await expect(error).toContainText("12초 뒤");
  await expect(error).toContainText("HTTP 429");
  await expect(error).toContainText("ui-request-429");
  await expect(
    page.getByText("요청을 처리할 수 없습니다.", { exact: true }),
  ).toHaveCount(0);
});

test("HTML 오류 응답은 원문 대신 실패 작업과 응답 형식을 안내한다", async ({
  page,
}) => {
  await page.route("**/api/tasks?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><p>private upstream login page</p>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText(/업무 목록 조회 실패:.*예상한 데이터 형식/).first(),
  ).toBeVisible();
  await expect(page.getByText(/INVALID_RESPONSE/).first()).toBeVisible();
  await expect(page.getByText(/private upstream|Unexpected token/)).toHaveCount(
    0,
  );
});

test("이전 연도의 느린 조회가 새 연도의 갱신을 막거나 늦은 오류를 표시하지 않는다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SharedWorker", { value: undefined });
  });
  await page.route("**/api/events", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  let firstYear = "",
    oldReads = 0,
    newReads = 0,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?**", async (route) => {
    const year = new URL(route.request().url()).searchParams.get("year")!;
    firstYear ||= year;
    if (year === firstYear) {
      oldReads++;
      if (oldReads === 2) {
        await waiting;
        await route
          .fulfill({ status: 503, json: { error: "이전 연도 조회 오류" } })
          .catch(() => {});
        return;
      }
    } else newReads++;
    await route.continue();
  });
  try {
    await page.clock.install();
    await page.goto("/");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.clock.runFor(8000);
    await expect.poll(() => oldReads).toBe(2);
    await page.getByRole("button", { name: "다음 연도", exact: true }).click();
    await expect.poll(() => newReads).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("grid")).toBeVisible();
    const before = newReads;
    await page.clock.runFor(8000);
    await expect.poll(() => newReads).toBeGreaterThan(before);
  } finally {
    release();
  }
  await expect(page.getByText(/이전 연도 조회 오류/)).toHaveCount(0);
});

for (const site of ["internal", "external"] as const) {
  test(`${site}: 느린 업무 조회가 진행 중이면 주기 요청을 중복하지 않는다`, async ({
    page,
  }) => {
    const bootstrap = unpack(
      await (await page.request.get("/api/bootstrap")).json(),
    );
    await page.route("**/api/bootstrap", (route) =>
      route.fulfill({ json: { ...bootstrap, site, authMode: "access" } }),
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "SharedWorker", { value: undefined });
    });
    await page.route("**/api/events", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    let queries = 0,
      release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/tasks?**", async (route) => {
      queries++;
      if (queries > 1) await waiting;
      await route.continue();
    });
    try {
      await page.clock.install();
      await page.goto("/");
      await expect(page.getByRole("grid")).toBeVisible();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      const interval = site === "external" ? 31000 : 8000;
      await page.clock.runFor(interval);
      await expect.poll(() => queries).toBe(2);
      await page.clock.runFor(interval);
      expect(queries).toBe(2);
    } finally {
      release();
    }
  });

  test(`${site}: 429 대기 후 조회 오류만 해제하고 저장 오류는 보존한다`, async ({
    page,
  }) => {
    const bootstrap = unpack(
      await (await page.request.get("/api/bootstrap")).json(),
    );
    // Explicit internal mode must win even with an Access-compatible bootstrap.
    await page.route("**/api/bootstrap", (route) =>
      route.fulfill({
        json: { ...bootstrap, site, authMode: "access" },
      }),
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "SharedWorker", { value: undefined });
    });
    await page.route("**/api/events", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    let queries = 0,
      preflights = 0;
    await page.route("**/api/teams/*/sync/refresh", (route) => {
      preflights++;
      return route.fulfill({ json: {} });
    });
    await page.route("**/api/tasks?**", (route) => {
      queries++;
      return queries === 1
        ? route.fulfill({
            status: 429,
            headers: { "Retry-After": "12" },
            json: { code: "RATE_LIMIT_EXCEEDED" },
          })
        : route.continue();
    });
    await page.clock.install();
    await page.goto("/");
    const readError = page.getByText(/업무 목록 조회 실패:.*요청 제한/).first();
    await expect(readError).toBeVisible();
    await expect(readError).toContainText(
      site === "external" ? "외부 서버의" : "서버의",
    );
    if (site === "internal")
      await expect(readError).not.toContainText("외부 서버");
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.clock.runFor(9000);
    expect(queries).toBe(1);
    await page.clock.runFor(6000);
    await expect(readError).toHaveCount(0);
    await expect(page.getByRole("grid")).toBeVisible();

    // A later failed action shares the banner but must survive successful reads.
    await page.route("**/api/tasks", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            json: { error: "업무 추가 저장 실패 검증" },
          })
        : route.continue(),
    );
    await page.getByRole("button", { name: "업무 추가", exact: true }).click();
    await expect(
      page.getByText(
        site === "external"
          ? /업무 목록 처리 실패: 업무 추가 저장 실패 검증/
          : "업무 추가 저장 실패 검증",
        { exact: site === "internal" },
      ),
    ).toBeVisible();
    const before = queries;
    await page.clock.runFor(site === "external" ? 31000 : 8000);
    await expect.poll(() => queries).toBeGreaterThan(before);
    await expect(
      page.getByText(
        site === "external"
          ? /업무 목록 처리 실패: 업무 추가 저장 실패 검증/
          : "업무 추가 저장 실패 검증",
        { exact: site === "internal" },
      ),
    ).toBeVisible();
    expect(preflights).toBe(0);
  });

  test(`${site}: 변경 없는 화면의 보완 조회 주기를 구분한다`, async ({
    page,
  }) => {
    const bootstrap = unpack(
      await (await page.request.get("/api/bootstrap")).json(),
    );
    await page.route("**/api/bootstrap", (route) =>
      route.fulfill({ json: { ...bootstrap, site, authMode: "access" } }),
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "SharedWorker", { value: undefined });
    });
    await page.route("**/api/events", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    let queries = 0;
    await page.route("**/api/tasks?**", (route) => {
      queries++;
      return route.continue();
    });
    await page.clock.install();
    await page.goto("/");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const before = queries;
    await page.clock.runFor(8000);
    if (site === "internal") await expect.poll(() => queries).toBe(before + 1);
    else {
      expect(queries).toBe(before);
      await page.clock.runFor(23000);
      await expect.poll(() => queries).toBe(before + 1);
    }
  });
}
