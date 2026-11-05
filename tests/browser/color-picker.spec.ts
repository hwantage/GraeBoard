import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { cell } from "../../shared/domain.js";
import { pickColor } from "./colors";

const headers = { "X-Requested-With": "WeeklyPlan" };
let userId: string, teamId: string, taskId: string;
const target = (page: Page) => page.locator(`[data-cell="${taskId}:title"]`);
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
async function stored(page: Page) {
  return cell(
    (await request(page, `/tasks?teamId=${teamId}&year=2026`)).tasks[0],
    "title",
  ).style;
}
async function save(page: Page, action: () => Promise<unknown>) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cells/batch") && r.ok()),
    action(),
  ]);
  await expect(
    page.getByRole("button", { name: "배경색", exact: true }),
  ).toBeEnabled();
}
async function custom(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const popup = page.getByRole("dialog", { name: label, exact: true });
  await popup.getByRole("button", { name: "다른 색", exact: true }).click();
  await expect(
    popup.getByRole("textbox", { name: "HEX", exact: true }),
  ).toBeFocused();
  return popup;
}
async function drag(page: Page, surface: Locator) {
  // The popup repositions after "다른 색" grows it; press only once it settles.
  let rect = (await surface.boundingBox())!;
  await expect
    .poll(async () => {
      const next = (await surface.boundingBox())!;
      const settled = next.x === rect.x && next.y === rect.y;
      rect = next;
      return settled;
    })
    .toBe(true);
  await page.mouse.move(rect.x + rect.width * 0.1, rect.y + rect.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.9, rect.y + rect.height * 0.7, {
    steps: 12,
  });
  await page.mouse.up();
}
function writes(page: Page) {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (
      !["GET", "HEAD"].includes(r.method()) &&
      /^\/api\/(cells\/batch|teams\/[^/]+\/settings|auth\/profile)$/.test(
        new URL(r.url()).pathname,
      )
    )
      requests.push(new URL(r.url()).pathname);
  });
  return requests;
}
const recent = (page: Page, label = "배경색") =>
  page
    .getByRole("dialog", { name: label, exact: true })
    .getByRole("group", { name: "최근 사용", exact: true });

test.beforeEach(async ({ page }) => {
  await request(page, "/auth/login", "POST", {
    username: "test@somansa.com",
    password: "1234",
  });
  userId = (await request(page, "/bootstrap")).user.id;
  teamId = (
    await request(page, "/admin/teams", "POST", {
      name: `색 선택 ${randomUUID().slice(0, 8)}`,
      members: [{ userId, role: "lead" }],
    })
  ).id;
  taskId = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: "색 선택 업무" },
    })
  ).task.id;
  await page.addInitScript(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId, teamId },
  );
  await page.goto("/");
  await expect(target(page)).toHaveText("색 선택 업무");
  await target(page).click();
});

test("사각형·색상 막대 드래그는 확인 때 한 번 저장하고 한 번 실행취소한다", async ({
  page,
}) => {
  const before = await stored(page);
  const requests = writes(page);
  const popup = await custom(page, "배경색");
  await drag(
    page,
    popup.getByRole("slider", { name: "채도와 명도", exact: true }),
  );
  await drag(page, popup.getByRole("slider", { name: "색상", exact: true }));
  const hex = await popup
    .getByRole("textbox", { name: "HEX", exact: true })
    .inputValue();
  expect(requests).toEqual([]);
  expect(await stored(page)).toEqual(before);
  await save(page, () =>
    popup.getByRole("button", { name: "확인", exact: true }).click(),
  );
  expect(requests).toEqual(["/api/cells/batch"]);
  expect((await stored(page)).backgroundColor).toBe(hex);
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  expect(await stored(page)).toEqual(before);
});

test("HEX 기본 초점·유효성·Enter와 키보드 조절·Esc 취소를 지원한다", async ({
  page,
}) => {
  const requests = writes(page);
  let popup = await custom(page, "배경색");
  const hex = popup.getByRole("textbox", { name: "HEX", exact: true });
  await hex.fill("#1234567");
  await hex.press("Enter");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  expect(requests).toEqual([]);
  await hex.fill("#gggggg");
  await hex.press("Enter");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await expect(popup.getByRole("alert")).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "확인", exact: true }),
  ).toBeDisabled();
  expect(requests).toEqual([]);
  await hex.fill("#aBc");
  await save(page, () => hex.press("Enter"));
  expect((await stored(page)).backgroundColor).toBe("#aabbcc");
  popup = await custom(page, "배경색");
  await popup.getByRole("textbox", { name: "HEX", exact: true }).fill("123ABC");
  await save(page, () => page.keyboard.press("Enter"));
  expect((await stored(page)).backgroundColor).toBe("#123abc");
  const count = requests.length;
  popup = await custom(page, "배경색");
  const saturation = popup.getByRole("slider", {
    name: "채도와 명도",
    exact: true,
  });
  await saturation.focus();
  await saturation.press("ArrowLeft");
  await saturation.press("ArrowUp");
  await popup
    .getByRole("slider", { name: "색상", exact: true })
    .press("Shift+ArrowRight");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  expect(requests).toHaveLength(count);
  expect((await stored(page)).backgroundColor).toBe("#123abc");
  popup = await custom(page, "배경색");
  await popup.getByRole("button", { name: "취소", exact: true }).press("Enter");
  await expect(popup).toHaveCount(0);
  expect(requests).toHaveLength(count);
});

test("드래그 중 Escape·pointercancel과 바깥 클릭은 저장·최근 색 없이 취소한다", async ({
  page,
}) => {
  const requests = writes(page);
  for (const cancel of ["Escape", "pointercancel", "outside"]) {
    const popup = await custom(page, "배경색");
    const surface = popup.getByRole("slider", {
      name: "채도와 명도",
      exact: true,
    });
    if (cancel === "outside") {
      await drag(page, surface);
      await target(page).click();
    } else {
      const box = (await surface.boundingBox())!;
      await page.mouse.move(box.x + 10, box.y + 10);
      await surface.evaluate((element) =>
        element.addEventListener(
          "pointerdown",
          (event) =>
            element.setAttribute(
              "data-test-pointer",
              String((event as PointerEvent).pointerId),
            ),
          { once: true },
        ),
      );
      await page.mouse.down();
      await page.mouse.move(box.x + 80, box.y + 80);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      else
        await surface.dispatchEvent("pointercancel", {
          pointerId: Number(await surface.getAttribute("data-test-pointer")),
          pointerType: "mouse",
        });
      await page.mouse.up();
    }
    await expect(popup).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `weekly-plan:recent-colors:${userId}`,
      ),
    ).toBeNull();
  }
});

test("최근 색 6개는 팔레트도 포함해 최신순·중복 제거·새로고침·다른 탭을 유지한다", async ({
  page,
  context,
}) => {
  const colors = [
    "#ffffff",
    "#112233",
    "#223344",
    "#334455",
    "#445566",
    "#556677",
    "#667788",
  ];
  for (const color of colors)
    await save(page, () => pickColor(page, "배경색", color));
  await save(page, () => pickColor(page, "글자 색상", "#334455"));
  const expected = [
    "#334455",
    "#667788",
    "#556677",
    "#445566",
    "#223344",
    "#112233",
  ];
  await page.reload();
  await target(page).click();
  await page.getByRole("button", { name: "배경색", exact: true }).click();
  await expect
    .poll(() =>
      recent(page)
        .getByRole("button")
        .evaluateAll((elements) =>
          elements.map((el) => el.getAttribute("aria-label")),
        ),
    )
    .toEqual(expected.map((c) => `최근 색 ${c}`));
  const tabTask = (
    await request(page, "/tasks", "POST", {
      teamId,
      year: 2026,
      fields: { title: "다른 탭 색" },
    })
  ).task.id;
  const tab = await context.newPage();
  await tab.goto("/");
  await tab.locator(`[data-cell="${tabTask}:title"]`).click();
  await save(tab, () => pickColor(tab, "배경색", "#ffffff"));
  await expect(recent(page).getByRole("button").first()).toHaveAttribute(
    "aria-label",
    "최근 색 #ffffff",
  );
  await save(page, () =>
    recent(page)
      .getByRole("button", { name: "최근 색 #334455", exact: true })
      .click(),
  );
  expect((await stored(page)).backgroundColor).toBe("#334455");
  await tab.close();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    `weekly-plan:recent-colors:${userId}`,
  );
  expect(saved).toEqual([
    "#334455",
    "#ffffff",
    "#667788",
    "#556677",
    "#445566",
    "#223344",
  ]);
});

test("같은 브라우저의 다른 계정과 최근 색이 섞이지 않는다", async ({
  page,
}) => {
  await save(page, () => pickColor(page, "배경색", "#112233"));
  const firstId = userId;
  const username = `colors-${randomUUID()}@example.com`;
  const secondId = (
    await request(page, "/admin/users", "POST", {
      username,
      password: "colors-password",
      name: "다른 사용자",
      active: true,
      memberships: [{ teamId, role: "member" }],
    })
  ).user.id;
  await request(page, "/auth/login", "POST", {
    username,
    password: "colors-password",
  });
  await page.evaluate(
    ({ userId, teamId }) =>
      localStorage.setItem(
        `weekly-board:${userId}`,
        JSON.stringify({ teamId, year: 2026 }),
      ),
    { userId: secondId, teamId },
  );
  await page.reload();
  await target(page).click();
  await page.getByRole("button", { name: "배경색", exact: true }).click();
  await expect(recent(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await save(page, () => pickColor(page, "배경색", "#445566"));
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      `weekly-plan:recent-colors:${firstId}`,
    ),
  ).toEqual(["#112233"]);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      `weekly-plan:recent-colors:${secondId}`,
    ),
  ).toEqual(["#445566"]);
});

test("중첩 테두리 색 선택은 초안을 유지하고 테두리 적용을 한 번 저장한다", async ({
  page,
}) => {
  const requests = writes(page);
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  let popup = await custom(page, "테두리 선 색상");
  await drag(
    page,
    popup.getByRole("slider", { name: "채도와 명도", exact: true }),
  );
  await drag(page, popup.getByRole("slider", { name: "색상", exact: true }));
  const color = await popup
    .getByRole("textbox", { name: "HEX", exact: true })
    .inputValue();
  expect(requests).toEqual([]);
  await popup.getByRole("button", { name: "확인", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "선택 영역 테두리", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  popup = await custom(page, "테두리 선 색상");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "선택 영역 테두리", exact: true }),
  ).toBeVisible();
  await save(page, () =>
    page.getByRole("button", { name: "모든 테두리", exact: true }).click(),
  );
  expect(requests).toEqual(["/api/cells/batch"]);
  expect((await stored(page)).borderBottom.color).toBe(color);
});

test("기본 서식 모달 안 중첩 테두리 색은 드래그·확인 후 한 번 적용하고 실행취소한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "기본 서식", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "설정", exact: true });
  const preview = page.locator(".preview-cell").first();
  const before = await preview.evaluate(
    (el) => getComputedStyle(el).borderBottom,
  );
  const requests = writes(page);
  await settings.getByRole("button", { name: "테두리", exact: true }).click();
  const popup = await custom(page, "테두리 선 색상");
  await drag(
    page,
    popup.getByRole("slider", { name: "채도와 명도", exact: true }),
  );
  await drag(page, popup.getByRole("slider", { name: "색상", exact: true }));
  const color = await popup
    .getByRole("textbox", { name: "HEX", exact: true })
    .inputValue();
  await popup.getByRole("button", { name: "확인", exact: true }).click();
  await page.getByRole("button", { name: "모든 테두리", exact: true }).click();
  await expect
    .poll(() =>
      preview.evaluate((el) => getComputedStyle(el).borderBottomColor),
    )
    .not.toBe("rgb(231, 237, 237)");
  await settings.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect
    .poll(() => preview.evaluate((el) => getComputedStyle(el).borderBottom))
    .toBe(before);
  await settings.getByRole("button", { name: "재실행", exact: true }).click();
  expect(requests).toEqual([]);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/teams/${teamId}/settings`) && r.ok(),
    ),
    settings
      .getByRole("button", { name: "기본 서식 저장", exact: true })
      .click(),
  ]);
  expect(requests).toEqual([`/api/teams/${teamId}/settings`]);
  const team = (await request(page, "/admin/users")).teams.find(
    (team: any) => team.id === teamId,
  );
  expect(team.settings.defaultStyle.borderBottom.color).toBe(color);
});

test("속성·점·주차 머리글·경계선은 드래그 중 저장 없이 속성 저장을 한 번 한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "속성 추가", exact: true }).click();
  await page.getByLabel("속성 이름", { exact: true }).fill("색 속성");
  await page.getByLabel("표시 모양").selectOption("dot");
  await page.getByRole("button", { name: "값 추가", exact: true }).click();
  await page.getByLabel("속성 값 1 이름", { exact: true }).fill("색 값");
  const requests = writes(page);
  for (const label of ["색 값 배경색", "색 값 점 색상"]) {
    const popup = await custom(page, label);
    await drag(
      page,
      popup.getByRole("slider", { name: "채도와 명도", exact: true }),
    );
    await popup.getByRole("button", { name: "확인", exact: true }).click();
  }
  await page.locator(".week-column-select").click();
  await page
    .getByLabel("왼쪽 경계선 스타일", { exact: true })
    .selectOption("solid");
  for (const label of [
    "주차 머리글 배경색",
    "주차 머리글 글자색",
    "왼쪽 경계선 색상",
  ]) {
    const popup = await custom(page, label);
    await drag(page, popup.getByRole("slider", { name: "색상", exact: true }));
    await popup.getByRole("button", { name: "확인", exact: true }).click();
  }
  expect(requests).toEqual([]);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/teams/${teamId}/settings`) && r.ok(),
    ),
    page.getByRole("button", { name: "속성 저장", exact: true }).click(),
  ]);
  expect(requests).toEqual([`/api/teams/${teamId}/settings`]);
});

test("아바타 색은 드래그 중 요청 없이 프로필 저장을 한 번 한다", async ({
  page,
}) => {
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("menuitem", { name: "프로필", exact: true }).click();
  const requests = writes(page);
  const popup = await custom(page, "아바타 배경색");
  await drag(
    page,
    popup.getByRole("slider", { name: "채도와 명도", exact: true }),
  );
  await drag(page, popup.getByRole("slider", { name: "색상", exact: true }));
  await popup.getByRole("button", { name: "확인", exact: true }).click();
  expect(requests).toEqual([]);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/profile") && r.ok(),
    ),
    page.getByRole("button", { name: "프로필 저장", exact: true }).click(),
  ]);
  expect(requests).toEqual(["/api/auth/profile"]);
});

test("390px·데스크톱 폭에서 팔레트·최근 색·HEX 선택기가 화면 안에 위치한다", async ({
  page,
}, info) => {
  await save(page, () => pickColor(page, "배경색", "#112233"));
  // Phones (700px and below) hide the sheet's cell formatting tools, so the
  // toolbar popups are checked at the narrowest width that still shows them.
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "배경색", exact: true }).click();
    const popup = page.getByRole("dialog", { name: "배경색", exact: true });
    for (const custom of [false, true]) {
      if (custom)
        await popup
          .getByRole("button", { name: "다른 색", exact: true })
          .click();
      await expect
        .poll(async () => {
          const box = (await popup.boundingBox())!;
          return (
            box.x >= 8 &&
            box.y >= 8 &&
            box.x + box.width <= width - 8 &&
            box.y + box.height <= 836
          );
        })
        .toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `color-${width}-${custom ? "hex" : "palette"}.png`,
        ),
      });
    }
    await page.keyboard.press("Escape");
  }
  let width = 720;
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  let popup = await custom(page, "테두리 선 색상");
  const inside = async () => {
    const box = (await popup.boundingBox())!;
    return (
      box.x >= 8 &&
      box.y >= 8 &&
      box.x + box.width <= width - 8 &&
      box.y + box.height <= 836
    );
  };
  await expect.poll(inside).toBe(true);
  await page.screenshot({ path: info.outputPath("color-720-border.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  width = 390;
  await page.setViewportSize({ width, height: 844 });
  await expect(
    page.getByRole("button", { name: "배경색", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.locator(".week-column-select").click();
  popup = await custom(page, "주차 머리글 배경색");
  await expect.poll(inside).toBe(true);
  await page.screenshot({ path: info.outputPath("color-390-settings.png") });
  await popup.getByRole("button", { name: "취소", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "설정", exact: true }),
  ).toBeVisible();
});

test("최근 색 저장이 차단되어도 선택·재사용하고 손상된 목록도 복구한다", async ({
  page,
}) => {
  await page.evaluate(
    (key) => localStorage.setItem(key, "not JSON"),
    `weekly-plan:recent-colors:${userId}`,
  );
  await page.reload();
  await target(page).click();
  await page.evaluate((key) => {
    localStorage.removeItem(key);
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  }, `weekly-plan:recent-colors:${userId}`);
  await save(page, () => pickColor(page, "배경색", "#abcdef"));
  await save(page, () => pickColor(page, "배경색", "#123456"));
  await page.evaluate(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
  });
  await save(page, () => pickColor(page, "배경색", "#456789"));
  await page.getByRole("button", { name: "배경색", exact: true }).click();
  await expect(recent(page).getByRole("button")).toHaveCount(3);
  await expect
    .poll(() =>
      recent(page)
        .getByRole("button")
        .evaluateAll((elements) =>
          elements.map((el) => el.getAttribute("aria-label")),
        ),
    )
    .toEqual(["최근 색 #456789", "최근 색 #123456", "최근 색 #abcdef"]);
});
