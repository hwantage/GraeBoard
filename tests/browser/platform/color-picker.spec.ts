import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../../shared/formatting/compact.js";
import { cell } from "../../../shared/domain.js";
import { pickColor } from "../support/colors";

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
async function open(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const popup = page.getByRole("dialog", { name: label, exact: true });
  await expect(
    popup.getByRole("textbox", { name: `${label} HEX`, exact: true }),
  ).toBeVisible();
  return popup;
}
// The browser's own picker is native UI, so replay what it sends: one
// "input" per color passed while dragging and one "change" on confirm.
async function drag(
  popup: Locator,
  label: string,
  colors: string[],
  confirm = true,
) {
  await popup.getByLabel(`${label} 직접 선택`, { exact: true }).evaluate(
    (input: HTMLInputElement, { colors, confirm }) => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      for (const color of colors) {
        set.call(input, color);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (confirm) input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { colors, confirm },
  );
  return colors.at(-1)!;
}
const sweep = Array.from(
  { length: 12 },
  (_, i) => `#${(0x203040 + i * 0x0a0b0c).toString(16)}`,
);
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

test("기본 선택기로 끄는 동안은 저장하지 않고 확정할 때 한 번 저장·한 번 실행취소한다", async ({
  page,
}) => {
  const before = await stored(page);
  const requests = writes(page);
  const popup = await open(page, "배경색");
  const last = await drag(popup, "배경색", sweep, false);
  await expect(
    popup.getByRole("textbox", { name: "배경색 HEX", exact: true }),
  ).toHaveValue(last);
  expect(requests).toEqual([]);
  expect(await stored(page)).toEqual(before);
  await save(page, () => drag(popup, "배경색", [last]));
  await expect(popup).toHaveCount(0);
  expect(requests).toEqual(["/api/cells/batch"]);
  expect((await stored(page)).backgroundColor).toBe(last);
  await save(page, () =>
    page.getByRole("button", { name: "실행취소", exact: true }).click(),
  );
  expect(await stored(page)).toEqual(before);
});

test("다른 색의 HEX 칸은 처음부터 현재 색을 보이고 유효성·Enter·Esc를 지원한다", async ({
  page,
}) => {
  const requests = writes(page);
  let popup = await open(page, "배경색");
  let hex = popup.getByRole("textbox", { name: "배경색 HEX", exact: true });
  await expect(hex).toHaveValue("#ffffff");
  await expect(popup.getByRole("alert")).toHaveCount(0);
  await hex.fill("#1234567");
  await hex.press("Enter");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await hex.fill("#gggggg");
  await hex.press("Enter");
  await expect(popup.getByRole("alert")).toBeVisible();
  expect(requests).toEqual([]);
  await hex.fill("#aBc");
  await save(page, () => hex.press("Enter"));
  expect((await stored(page)).backgroundColor).toBe("#aabbcc");
  popup = await open(page, "배경색");
  hex = popup.getByRole("textbox", { name: "배경색 HEX", exact: true });
  await expect(hex).toHaveValue("#aabbcc");
  await hex.fill("123ABC");
  await save(page, () => hex.press("Enter"));
  expect((await stored(page)).backgroundColor).toBe("#123abc");
  const count = requests.length;
  popup = await open(page, "배경색");
  await popup
    .getByRole("textbox", { name: "배경색 HEX", exact: true })
    .fill("#ffffff");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  expect(requests).toHaveLength(count);
  expect((await stored(page)).backgroundColor).toBe("#123abc");
});

test("스포이드로 고른 색은 바로 한 번 적용하고 지원하지 않는 브라우저에서는 숨긴다", async ({
  page,
}) => {
  // EyeDropper is native UI; replace it with one that returns a fixed color.
  await page.addInitScript(() => {
    (window as any).EyeDropper = class {
      open() {
        return Promise.resolve({ sRGBHex: "#3a7bd5" });
      }
    };
  });
  await page.reload();
  await target(page).click();
  const requests = writes(page);
  const popup = await open(page, "배경색");
  await save(page, () =>
    popup.getByRole("button", { name: "스포이드", exact: true }).click(),
  );
  await expect(popup).toHaveCount(0);
  expect(requests).toEqual(["/api/cells/batch"]);
  expect((await stored(page)).backgroundColor).toBe("#3a7bd5");
  await expect(
    (await open(page, "배경색")).getByRole("button", {
      name: "최근 색 #3a7bd5",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.addInitScript(() => delete (window as any).EyeDropper);
  await page.reload();
  await target(page).click();
  await expect(
    (await open(page, "배경색")).getByRole("button", {
      name: "스포이드",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("기본 선택기를 끄다가 Esc·바깥 클릭으로 닫으면 저장·최근 색 없이 취소한다", async ({
  page,
}) => {
  const requests = writes(page);
  for (const cancel of ["Escape", "outside"]) {
    const popup = await open(page, "배경색");
    await drag(popup, "배경색", sweep, false);
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else await target(page).click();
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
  let popup = await open(page, "테두리 선 색상");
  const color = await drag(popup, "테두리 선 색상", sweep, false);
  expect(requests).toEqual([]);
  await drag(popup, "테두리 선 색상", [color]);
  await expect(popup).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "선택 영역 테두리", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  popup = await open(page, "테두리 선 색상");
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

test("기본 서식 모달 안 중첩 테두리 색은 기본 선택기 확정 후 한 번 적용하고 실행취소한다", async ({
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
  const popup = await open(page, "테두리 선 색상");
  const color = await drag(popup, "테두리 선 색상", sweep);
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
    const popup = await open(page, label);
    await drag(popup, label, sweep);
    await expect(popup).toHaveCount(0);
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
    const popup = await open(page, label);
    await drag(popup, label, sweep);
    await expect(popup).toHaveCount(0);
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
  const popup = await open(page, "아바타 배경색");
  await drag(popup, "아바타 배경색", sweep);
  await expect(popup).toHaveCount(0);
  expect(requests).toEqual([]);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/profile") && r.ok(),
    ),
    page.getByRole("button", { name: "프로필 저장", exact: true }).click(),
  ]);
  expect(requests).toEqual(["/api/auth/profile"]);
});

test("390px·데스크톱 폭에서 팔레트·최근 색·HEX 칸이 화면 안에 위치한다", async ({
  page,
}, info) => {
  await save(page, () => pickColor(page, "배경색", "#112233"));
  // Phones (700px and below) hide the sheet's cell formatting tools, so the
  // toolbar popups are checked at the narrowest width that still shows them.
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "배경색", exact: true }).click();
    const popup = page.getByRole("dialog", { name: "배경색", exact: true });
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
    await expect(
      popup.getByRole("textbox", { name: "배경색 HEX", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`color-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  let width = 720;
  await page.getByRole("button", { name: "테두리", exact: true }).click();
  let popup = await open(page, "테두리 선 색상");
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
  popup = await open(page, "주차 머리글 배경색");
  await expect.poll(inside).toBe(true);
  await page.screenshot({ path: info.outputPath("color-390-settings.png") });
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
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
