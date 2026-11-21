import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unpack } from "../../../shared/formatting/compact.js";

// These checks drive the real CanvaSlide editor that `npm run build` installed.
const distRoot = "dist/tools/canvaslide";
const current = existsSync(join(distRoot, "current.json"))
  ? JSON.parse(readFileSync(join(distRoot, "current.json"), "utf8"))
  : null;
const example = (name: string) =>
  readFileSync(join(distRoot, current.buildId, "examples", name));

const headers = { "X-Requested-With": "WeeklyPlan" };
const json = async (response: any) => unpack(await response.json());
async function login(
  request: APIRequestContext,
  username: string,
  password: string,
) {
  expect(
    (
      await request.post("/api/auth/login", {
        headers,
        data: { username, password },
      })
    ).ok(),
  ).toBe(true);
}
async function upload(
  request: APIRequestContext,
  teamId: string,
  title: string,
  bytes: Buffer,
) {
  const response = await request.post(`/api/teams/${teamId}/slides`, {
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "X-Slide-Title": encodeURIComponent(title),
      "X-Slide-Request-Id": randomUUID(),
    },
    data: bytes,
  });
  expect(response.status()).toBe(201);
  return json(response);
}
const content = (request: APIRequestContext, teamId: string, fileId: string) =>
  request.get(`/api/teams/${teamId}/slides/${fileId}/content`);
const meta = async (
  request: APIRequestContext,
  teamId: string,
  fileId: string,
) => json(await request.get(`/api/teams/${teamId}/slides/${fileId}`));

let teamId = "";
test.beforeAll(() => {
  expect(
    current,
    "CanvaSlide 편집기 배포본이 없습니다. npm run build 를 먼저 실행하세요.",
  ).not.toBeNull();
});
test.beforeEach(async ({ page }) => {
  await login(page.request, "test@somansa.com", "1234");
  teamId = (await json(await page.request.get("/api/bootstrap"))).teams[0].id;
});

const editor = (page: Page) => page.frameLocator("iframe.slide-editor-frame");
const saveButton = (page: Page) =>
  page.getByRole("button", { name: "저장 (Ctrl/Cmd+S)" });
const idleSave = (page: Page) =>
  saveButton(page).and(page.locator('[aria-busy="false"]'));
const titleInput = (page: Page) =>
  page.getByRole("textbox", { name: "자료 제목" });
async function openTeamFile(page: Page, fileId: string) {
  await page.goto(`/slides?file=${fileId}`);
  await expect(editor(page).locator("[data-element-id]").first()).toBeVisible();
  await expect(idleSave(page)).toBeDisabled();
}
// A real edit through the editor's own canvas and keyboard handling.
async function nudge(page: Page, canWrite = true) {
  // The editor's interaction layer sits above the drawn elements, as for a person's pointer.
  await editor(page)
    .getByText("Order received", { exact: true })
    .click({ force: true });
  await page.keyboard.press("ArrowRight");
  await expect(saveButton(page)).toBeEnabled({ enabled: canWrite });
}
async function fileShortcut(page: Page, key: string) {
  const mod = await page.evaluate(() =>
    /Mac/.test(navigator.userAgent) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${mod}+${key}`);
}
const saveShortcut = (page: Page) => fileShortcut(page, "s");
async function peerSession(
  page: Page,
  context: BrowserContext,
  role: "lead" | "member" | "viewer" | null,
) {
  const username = `slides-${randomUUID()}@example.com`;
  const created = await page.request.post("/api/admin/users", {
    headers,
    data: {
      username,
      password: "local-peer-password",
      name: role === "viewer" ? "열람자" : "다른 팀원",
      memberships: role ? [{ teamId, role }] : [],
    },
  });
  expect(created.ok()).toBe(true);
  const peer = await context.browser()!.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 1366, height: 900 },
  });
  await login(peer.request, username, "local-peer-password");
  return peer;
}

const fileCard = (page: Page, title: string) =>
  page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: title, exact: true }),
  });

test("CanvaSlide 제목 옆에서 새 자료를 만들고 카드의 두 줄 제목과 썸네일 바깥 툴팁을 표시한다", async ({
  page,
  browserName,
}) => {
  const title = `팀 발표자료 ${"여러 부서의 분기별 진행 상황과 향후 일정 ".repeat(3)}${randomUUID().slice(0, 8)}`;
  const shortTitle = `요약 ${randomUUID().slice(0, 8)}`;
  await upload(
    page.request,
    teamId,
    shortTitle,
    example("flowchart.canvaslide"),
  );
  const file = await upload(
    page.request,
    teamId,
    title,
    example("freefall.canvaslide"),
  );
  await page.goto("/slides");
  const card = fileCard(page, title);
  const other = fileCard(page, shortTitle);
  const titleButton = card.getByRole("button", { name: title, exact: true });
  const newButton = page.getByRole("button", { name: "새 팀 자료" });
  await page.getByRole("heading", { name: "CanvaSlide" }).hover();
  const tooltip = page.getByRole("tooltip");
  const image = card.locator(".slide-card-thumbnail img");
  const caption = card.locator(".slide-card-title");
  const band = card.locator(".slide-card-heading");
  const newBadge = card.getByRole("img", { name: "새 자료" });
  await expect(tooltip).toHaveCount(0);
  await expect(image).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(
    page.getByRole("list").getByRole("button", { name: "새 팀 자료" }),
  ).toHaveCount(0);
  await expect(newButton).toHaveClass(/primary/);
  const format = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  });
  const preview = await image.getAttribute("src");
  for (const width of [1280, 768, 540, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("heading", { name: "CanvaSlide" }).hover();
    const idle = (await card.boundingBox())!;
    expect(idle.height).toBe(168);
    expect((await other.boundingBox())!.height).toBe(idle.height);
    await expect(newBadge).toHaveText("NEW");
    await expect(newBadge).toBeVisible();
    const badge = (await newBadge.boundingBox())!;
    const strip = (await band.boundingBox())!;
    const previewBox = (await image.boundingBox())!;
    const topGap = badge.y - idle.y;
    const rightGap = idle.x + idle.width - badge.x - badge.width;
    expect(topGap).toBeGreaterThanOrEqual(0);
    expect(topGap).toBeLessThanOrEqual(12);
    expect(rightGap).toBeGreaterThanOrEqual(0);
    expect(rightGap).toBeLessThanOrEqual(12);
    expect(badge.y + badge.height).toBeLessThan(strip.y);
    expect(strip.y).toBeGreaterThan(previewBox.y);
    expect(strip.y + strip.height).toBeCloseTo(
      previewBox.y + previewBox.height,
      0,
    );
    expect(strip.width).toBeCloseTo(previewBox.width, 0);
    await expect(caption).toHaveCSS("-webkit-line-clamp", "2");
    expect(
      await caption.evaluate((el) => ({
        lines: el.clientHeight / parseFloat(getComputedStyle(el).lineHeight),
        clipped: el.scrollHeight > el.clientHeight,
      })),
    ).toEqual({ lines: 2, clipped: true });
    await card.hover();
    await expect(tooltip).toContainText(title);
    await expect(tooltip).toContainText(/생성/);
    await expect(tooltip).toContainText(
      format.format(new Date(file.createdAt)),
    );
    await expect(tooltip).toContainText(
      format.format(new Date(file.updatedAt)),
    );
    await expect(tooltip).toContainText(
      `${(file.byteLength / 1024 ** 2).toFixed(1)}MB`,
    );
    await expect(card.getByRole("img", { name: "새 자료" })).toBeVisible();
    await expect(image).toHaveAttribute("src", preview!);
    await expect(card.getByRole("button")).toHaveCount(1);
    const rect = (await tooltip.boundingBox())!;
    expect(
      rect.y >= idle.y + idle.height || rect.y + rect.height <= idle.y,
    ).toBe(true);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    expect((await card.boundingBox())!.height).toBe(idle.height);
    await expect(newButton).toBeInViewport();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "연간 업무", exact: true }).click();
  const annual = page.getByRole("heading", { name: "연간 업무", exact: true });
  const annualBox = (await annual.boundingBox())!;
  const titleFont = await annual.evaluate(
    (el) => getComputedStyle(el).fontSize,
  );
  const presentationHeight = (await page
    .getByRole("button", { name: "발표 모드", exact: true })
    .boundingBox())!.height;
  const launcher = page.getByRole("button", {
    name: "CanvaSlide",
    exact: true,
  });
  const calendar = page.getByRole("button", { name: "캘린더", exact: true });
  const calendarBox = (await calendar.boundingBox())!;
  const launchBox = (await launcher.boundingBox())!;
  expect([launchBox.width, launchBox.height]).toEqual([
    calendarBox.width,
    calendarBox.height,
  ]);
  await expect(launcher).toHaveCSS("border-radius", "50%");
  await expect
    .poll(() =>
      launcher
        .locator("img")
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveTitle(/CanvaSlide/);
  const heading = page.getByRole("heading", {
    name: "CanvaSlide",
    exact: true,
  });
  const headingBox = (await heading.boundingBox())!;
  expect([headingBox.x, headingBox.y]).toEqual([annualBox.x, annualBox.y]);
  await expect(heading).toHaveCSS("font-size", titleFont);
  const createBox = (await newButton.boundingBox())!;
  expect(createBox.x - (headingBox.x + headingBox.width)).toBeCloseTo(10, 0);
  expect(
    Math.abs(
      createBox.y + createBox.height / 2 - headingBox.y - headingBox.height / 2,
    ),
  ).toBeLessThan(2);
  await heading.hover();
  // Option+Tab includes buttons in the default macOS WebKit focus order.
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const titles = page
    .getByRole("list", { name: "팀 자료" })
    .getByRole("button");
  await titles.first().focus();
  await page.keyboard.press(tab);
  const next = titles.nth(1);
  await expect(next).toBeFocused();
  await expect(tooltip).toContainText((await next.getAttribute("aria-label"))!);
  await page.keyboard.press("Escape");
  await expect(next).toBeFocused();
  await expect(tooltip).toHaveCount(0);
  await card.hover();
  for (const button of [
    newButton,
    page.getByRole("button", { name: /팀 자료로 가져오기/ }),
  ])
    expect((await button.boundingBox())!.height).toBe(presentationHeight);
  await expect(
    page.getByRole("button", {
      name: /편집기만 열기|팀에 저장하지 않고 편집기 열기/,
    }),
  ).toHaveCount(0);
});

test("터치로 카드를 길게 누르면 툴팁이 보이고 짧게 누르면 해당 자료가 열린다", async ({
  page,
  browser,
}) => {
  const title = `터치 자료 ${randomUUID().slice(0, 8)}`;
  const file = await upload(
    page.request,
    teamId,
    title,
    example("flowchart.canvaslide"),
  );
  const touch = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    storageState: await page.context().storageState(),
  });
  try {
    const view = await touch.newPage();
    await view.goto("/slides");
    const card = fileCard(view, title);
    const open = card.getByRole("button", { name: title });
    const tip = view.getByRole("tooltip");
    await expect(open).toBeVisible();
    await expect(tip).toHaveCount(0);
    const press = {
      pointerType: "touch",
      pointerId: 3,
      isPrimary: true,
      button: 0,
    };
    await open.dispatchEvent("pointerdown", press);
    await expect(tip).toContainText(title);
    await open.dispatchEvent("pointerup", press);
    await open.dispatchEvent("pointerout", press);
    await open.dispatchEvent("click", { detail: 1 });
    await expect(tip).toContainText("생성");
    await expect(view).toHaveURL(/\/slides$/);
    await view.getByRole("heading", { name: "CanvaSlide" }).tap();
    await expect(tip).toHaveCount(0);
    await open.tap();
    await expect(view).toHaveURL(new RegExp(file.id));
  } finally {
    await touch.close();
  }
});

test("첫 프레임 사진을 썸네일에 그리고 다음 열람자는 원본을 내려받지 않는다", async ({
  page,
  context,
}) => {
  // Each browser must render its own cold first image rather than reusing
  // the JPEG another engine already put in the shared cache.
  const deck = JSON.parse(example("freefall.canvaslide").toString());
  deck.name = `썸네일 ${randomUUID()}`;
  const file = await upload(
    page.request,
    teamId,
    deck.name,
    Buffer.from(JSON.stringify(deck)),
  );
  const card = (p: Page) =>
    p.getByRole("listitem").filter({
      has: p.getByRole("button", { name: file.title, exact: true }),
    });
  await page.goto("/slides");
  await card(page).scrollIntoViewIfNeeded();
  const img = card(page).locator(".slide-card-thumbnail img");
  await expect(img).toBeVisible();
  const picture = (await img.boundingBox())!;
  const slot = (await card(page)
    .locator(".slide-card-thumbnail")
    .boundingBox())!;
  expect(picture.height).toBeLessThanOrEqual(slot.height);
  expect(picture.width).toBeLessThanOrEqual(slot.width);
  await expect(img).toHaveCSS("object-fit", "contain");
  const pixels = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(el, 0, 0, 32, 18);
    // Freefall's illuminated earth crosses the upper part of its first frame.
    const pixel = ctx.getImageData(17, 0, 9, 4).data;
    let colored = 0;
    for (let i = 0; i < pixel.length; i += 4) {
      if (
        Math.max(pixel[i], pixel[i + 1], pixel[i + 2]) -
          Math.min(pixel[i], pixel[i + 1], pixel[i + 2]) >
        6
      )
        colored++;
    }
    return [el.naturalWidth, el.naturalHeight, colored];
  });
  expect(pixels.slice(0, 2)).toEqual([384, 216]);
  expect(pixels[2]).toBeGreaterThan(3);
  const remote = await json(
    await page.request.get(`/api/teams/${teamId}/slides/${file.id}/thumbnail`),
  );
  expect(remote.image).toBe(await img.getAttribute("src"));
  const viewer = await peerSession(page, context, "viewer");
  try {
    const view = await viewer.newPage();
    const reads: string[] = [];
    view.on("request", (r) => {
      if (r.url().endsWith("/" + file.id + "/content")) reads.push(r.url());
    });
    await view.goto("/slides");
    await card(view).scrollIntoViewIfNeeded();
    await expect(
      card(view).locator(".slide-card-thumbnail img"),
    ).toHaveAttribute("src", remote.image);
    await expect(view.getByRole("button", { name: "새 팀 자료" })).toHaveCount(
      0,
    );
    await card(view).hover();
    await expect(view.getByRole("tooltip")).toContainText("크기");
    await expect(card(view).getByRole("button")).toHaveCount(1);
    expect(reads).toEqual([]);
  } finally {
    await viewer.close();
  }
});

test("카드의 new 표시는 생성 시각을 기준으로 12시간이 지나면 열린 목록에서도 사라진다", async ({
  page,
}) => {
  const now = Date.now();
  const stamp = (offset: number) => new Date(now + offset).toISOString();
  const period = 12 * 60 * 60 * 1000;
  await page.clock.install({ time: new Date(now) });
  await page.route("**/api/teams/*/slides", async (route) => {
    const files = [
      { title: "만료 직전", createdAt: stamp(-period + 60_000) },
      { title: "생성 12시간 경과", createdAt: stamp(-period) },
    ].map((file) => ({
      ...file,
      id: randomUUID(),
      updatedAt: stamp(0),
      byteLength: 123,
    }));
    await route.fulfill({
      json: { canWrite: true, files },
      headers: { "X-Server-Time": stamp(0) },
    });
  });
  await page.goto("/slides");
  const badge = (title: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: title, exact: true }) })
      .getByRole("img", { name: "새 자료" });
  await page.getByRole("heading", { name: "CanvaSlide" }).hover();
  await expect(badge("생성 12시간 경과")).toHaveCount(0);
  await expect(badge("만료 직전")).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(badge("만료 직전")).toHaveCount(0);
});

test("상세 제목을 고쳐 본문과 함께 저장하고 목록과 다시 연 파일에서 확인한다", async ({
  page,
}) => {
  const file = await upload(
    page.request,
    teamId,
    "상세 제목 원본",
    example("flowchart.canvaslide"),
  );
  await openTeamFile(page, file.id);
  const input = titleInput(page);
  await expect(input).toHaveValue(file.title);
  await expect(page.locator(".slide-editor-bar .tag")).toHaveCount(0);
  for (const button of [
    page.getByRole("button", { name: "팀 자료 목록" }),
    saveButton(page),
  ])
    await expect(button).toHaveCSS("height", "26px");
  await input.fill("회의 자료");
  await expect(saveButton(page)).toBeEnabled();
  await input.fill(file.title);
  await expect(idleSave(page)).toBeDisabled();
  const title = `분기 회의 ${randomUUID().slice(0, 8)}`;
  await input.fill(title);
  await saveButton(page).click();
  await expect(idleSave(page)).toBeDisabled();
  await expect(input).toHaveValue(title);
  expect(await meta(page.request, teamId, file.id)).toMatchObject({
    title,
    revision: 2,
  });
  const bytes = await (await content(page.request, teamId, file.id)).body();
  expect(JSON.parse(bytes.toString()).name).toBe(title);
  await page.getByRole("button", { name: "팀 자료 목록" }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(input).toHaveValue(title);
  await expect(idleSave(page)).toBeDisabled();
  const editorTitle = editor(page).getByRole("textbox", {
    name: /^(Document name|문서 이름)$/,
  });
  await expect(editorTitle).toHaveCount(0);
  await input.fill("상단에서 바로 저장");
  await saveShortcut(page);
  await expect
    .poll(async () => (await meta(page.request, teamId, file.id)).title)
    .toBe("상단에서 바로 저장");
  await expect(idleSave(page)).toBeDisabled();
  await expect(input).toHaveValue("상단에서 바로 저장");
});

test("팀 자료를 열어 편집하고 Ctrl/Cmd+S로 저장하면 다른 팀원이 같은 내용을 열고 내려받는다", async ({
  page,
  context,
}) => {
  const original = example("flowchart.canvaslide");
  // The test server keeps files across browser projects.
  const title = `주간회의 ${randomUUID().slice(0, 8)}`;
  await page.goto("/slides");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /팀 자료로 가져오기/ }).click();
  await (
    await chooser
  ).setFiles({
    name: `${title}.canvaslide`,
    mimeType: "application/json",
    buffer: original,
  });
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(editor(page).locator("[data-element-id]").first()).toBeVisible();
  const fileId = new URL(page.url()).searchParams.get("file")!;
  expect((await meta(page.request, teamId, fileId)).revision).toBe(1);

  await nudge(page);
  await saveShortcut(page);
  await expect(idleSave(page)).toBeDisabled();
  const saved = await meta(page.request, teamId, fileId);
  expect(saved.revision).toBe(2);

  // The stored bytes are a standard file the server did not reinterpret.
  const stored = await (await content(page.request, teamId, fileId)).body();
  expect(createHash("sha256").update(stored).digest("hex")).toBe(
    saved.contentHash,
  );
  expect(stored.equals(original)).toBe(false);
  expect(JSON.parse(stored.toString("utf8")).version).toBe(
    JSON.parse(original.toString("utf8")).version,
  );

  // Another member, another session: same file, same revision, same content.
  const peer = await peerSession(page, context, "member");
  const peerPage = await peer.newPage();
  await openTeamFile(peerPage, fileId);
  const download = peerPage.waitForEvent("download");
  await peerPage
    .getByRole("button", { name: "서버에 저장된 파일 내려받기" })
    .click();
  const path = await (await download).path();
  expect(readFileSync(path).equals(stored)).toBe(true);
  await peer.close();
});

test("저장이 실패하면 편집 내용이 미저장으로 남고 다시 저장할 수 있다", async ({
  page,
}) => {
  const file = await upload(
    page.request,
    teamId,
    "실패 복구",
    example("flowchart.canvaslide"),
  );
  await openTeamFile(page, file.id);
  await nudge(page);
  let failures = 0;
  await page.route("**/api/teams/*/slides/*/content", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    failures++;
    return route.fulfill({
      status: 500,
      json: { error: "저장소에 연결하지 못했습니다." },
    });
  });
  await saveShortcut(page);
  await expect(page.locator(".slide-editor .error-note")).toBeVisible();
  await expect(saveButton(page)).toBeEnabled();
  expect(failures).toBe(2);
  expect((await meta(page.request, teamId, file.id)).revision).toBe(1);

  await page.unroute("**/api/teams/*/slides/*/content");
  await page.getByRole("button", { name: "저장 (Ctrl/Cmd+S)" }).click();
  await expect(idleSave(page)).toBeDisabled();
  await expect(page.locator(".slide-editor .error-note")).toHaveCount(0);
  expect((await meta(page.request, teamId, file.id)).revision).toBe(2);
});

test("다른 팀원이 먼저 저장하면 두 내용을 모두 보존하고 사본으로 저장한다", async ({
  page,
}) => {
  const original = example("flowchart.canvaslide");
  const file = await upload(page.request, teamId, "충돌 자료", original);
  await openTeamFile(page, file.id);
  await nudge(page);
  const other = example("erd.canvaslide");
  const first = await page.request.put(
    `/api/teams/${teamId}/slides/${file.id}/content`,
    {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Slide-Base-Revision": "1",
        "X-Slide-Request-Id": randomUUID(),
      },
      data: other,
    },
  );
  expect(first.ok()).toBe(true);

  await saveShortcut(page);
  const dialog = page.getByRole("dialog", {
    name: "다른 팀원이 먼저 저장했습니다",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "내 변경을 사본으로 저장" }).click();
  await expect(idleSave(page)).toBeDisabled();

  // The team file still holds the other member's bytes; my edit is a new file.
  expect(
    (await (await content(page.request, teamId, file.id)).body()).equals(other),
  ).toBe(true);
  const copyId = new URL(page.url()).searchParams.get("file")!;
  expect(copyId).not.toBe(file.id);
  const copy = await meta(page.request, teamId, copyId);
  expect(copy.title).toBe("충돌 자료 (내 변경)");
  expect(copy.revision).toBe(1);
  await expect(titleInput(page)).toHaveValue(copy.title);
  await titleInput(page).fill(file.title);
  await saveButton(page).click();
  await expect(idleSave(page)).toBeDisabled();
  expect(await meta(page.request, teamId, copyId)).toMatchObject({
    title: file.title,
    revision: 2,
  });
  expect(await meta(page.request, teamId, file.id)).toMatchObject({
    title: file.title,
    revision: 2,
  });
});

test("새 자료는 이름 없이 편집하고 첫 저장 때만 팀 파일을 만든다", async ({
  page,
}) => {
  await page.goto("/slides");
  const newButton = page.getByRole("button", { name: "새 팀 자료" });
  const listButton = page.getByRole("button", { name: "팀 자료 목록" });
  const prompt = page.getByRole("dialog", { name: "자료 저장" });
  const title = `분기 계획 ${randomUUID().slice(0, 8)}`;
  let created = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/slides"))
      created++;
  });
  await newButton.click();
  await expect(titleInput(page)).toHaveValue("");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/file=/);
  await expect(
    page.getByRole("button", { name: /서버에 저장된 파일 내려받기|자료 삭제/ }),
  ).toHaveCount(0);
  const viewport = editor(page).getByTestId("canvas-viewport");
  await viewport.click();
  await page.keyboard.press("r");
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 270, box.y + 230, { steps: 4 });
  await page.mouse.up();
  const shape = editor(page).locator('[data-element-type="shape"]').first();
  await expect(shape).toBeVisible();
  await listButton.click();
  await page.getByRole("button", { name: "저장 후 이동" }).click();
  await prompt.getByRole("button", { name: "취소" }).click();
  await expect(shape).toBeVisible();
  await expect(titleInput(page)).toHaveValue("");
  expect(created).toBe(0);

  await listButton.click();
  await page.getByRole("button", { name: "저장 후 이동" }).click();
  await prompt.getByRole("textbox").fill(title);
  await prompt.getByRole("button", { name: "저장", exact: true }).click();
  const savedCard = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await savedCard.scrollIntoViewIfNeeded();
  await expect(savedCard.locator(".slide-card-thumbnail img")).toBeVisible();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(shape).toBeVisible();
  await expect(idleSave(page)).toBeDisabled();
  const fileId = new URL(page.url()).searchParams.get("file")!;
  expect(await meta(page.request, teamId, fileId)).toMatchObject({
    title,
    revision: 1,
  });
  expect(created).toBe(1);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(
      editor(page).getByRole("button", {
        name: width === 390 ? "Actions menu" : "Share",
        exact: true,
      }),
    ).toBeVisible();
    await expect(newButton).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "다른 이름으로 저장" }),
    ).toBeInViewport();
    await expect(
      editor(page).getByRole("button", {
        name: /^(?:(?:New|Open|Save)(?: \(.*\))?|Save as(?:…|\.\.\.)?|File menu)$/i,
      }),
    ).toHaveCount(0);
    await expect(
      editor(page).getByRole("textbox", { name: "Document name" }),
    ).toHaveCount(0);
    await expect(
      editor(page).getByRole("button", { name: /^Undo/ }),
    ).toBeVisible();
  }
  await newButton.click();
  await expect(titleInput(page)).toHaveValue("");
  await expect(saveButton(page)).toBeDisabled();
  await listButton.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "팀 자료" })).toBeVisible();
  expect(created).toBe(1);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(titleInput(page)).toHaveValue(title);
  await viewport.click();
  await fileShortcut(page, "n");
  await expect(titleInput(page)).toHaveValue("");
  await titleInput(page).fill(title);
  await saveShortcut(page);
  await expect(page).toHaveURL(/file=/);
  await expect(idleSave(page)).toBeDisabled();
  const second = new URL(page.url()).searchParams.get("file")!;
  expect(second).not.toBe(fileId);
  expect(await meta(page.request, teamId, second)).toMatchObject({
    title,
    revision: 1,
  });
  expect(created).toBe(2);
  await viewport.click();
  await fileShortcut(page, "o");
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toHaveCount(2);
});

test("다른 이름으로 저장은 미저장 본문을 팀 사본으로 저장하고 후속 저장을 사본에 반영한다", async ({
  page,
}) => {
  const original = example("flowchart.canvaslide");
  // The suffix would otherwise split the emoji at the 120-character limit.
  const stem = "가".repeat(116);
  const file = await upload(page.request, teamId, stem + "🎞️x", original);
  await openTeamFile(page, file.id);
  const copy = page.getByRole("button", {
    name: "다른 이름으로 저장",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "다른 이름으로 저장" });
  await copy.click();
  await expect(dialog.getByRole("textbox")).toHaveValue(stem + " 사본");
  await expect(
    dialog.getByRole("button", { name: "이 기기에 저장" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(new RegExp(file.id));
  await nudge(page);
  await fileShortcut(page, "Shift+s");
  await dialog.getByRole("textbox").fill("팀 사본");
  await dialog.getByRole("button", { name: "팀 사본으로 저장" }).click();
  await expect(idleSave(page)).toBeDisabled();
  const copyId = new URL(page.url()).searchParams.get("file")!;
  expect(copyId).not.toBe(file.id);
  await expect(titleInput(page)).toHaveValue("팀 사본");
  const copyBytes = await (await content(page.request, teamId, copyId)).body();
  const saved = JSON.parse(copyBytes.toString());
  expect(saved.name).toBe("팀 사본");
  expect(saved.elements).not.toEqual(JSON.parse(original.toString()).elements);
  await titleInput(page).fill("사본 개명");
  await saveButton(page).click();
  await expect(idleSave(page)).toBeDisabled();
  expect(await meta(page.request, teamId, copyId)).toMatchObject({
    title: "사본 개명",
    revision: 2,
  });
  expect(await meta(page.request, teamId, file.id)).toMatchObject({
    title: file.title,
    revision: 1,
  });
  expect(await (await content(page.request, teamId, file.id)).body()).toEqual(
    original,
  );
});

test("상세에서 사본을 삭제할 때 취소와 실패는 편집을 유지하고 확인하면 사본과 복구본만 지운다", async ({
  page,
}) => {
  test.setTimeout(60000);
  const bytes = example("flowchart.canvaslide");
  const file = await upload(
    page.request,
    teamId,
    `원본 ${randomUUID()}`,
    bytes,
  );
  const user = (await json(await page.request.get("/api/bootstrap"))).user;
  const scope = `canvaslide-recovery.${user.id}.${teamId}`;
  await openTeamFile(page, file.id);
  await page.getByRole("button", { name: "다른 이름으로 저장" }).click();
  const saveAs = page.getByRole("dialog", { name: "다른 이름으로 저장" });
  const copyName = `삭제할 사본 ${randomUUID()}`;
  await saveAs.getByRole("textbox").fill(copyName);
  await saveAs.getByRole("button", { name: "팀 사본으로 저장" }).click();
  await expect(titleInput(page)).toHaveValue(copyName);
  const copy = new URL(page.url()).searchParams.get("file")!;
  expect(copy).not.toBe(file.id);
  const saved = await (await content(page.request, teamId, copy)).body();
  await nudge(page);
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "서버에 저장된 파일 내려받기" })
    .click();
  const downloaded = await exported;
  expect(downloaded.suggestedFilename().normalize("NFC")).toBe(
    copyName + ".canvaslide",
  );
  expect(readFileSync((await downloaded.path())!)).toEqual(saved);
  await expect
    .poll(() => snapshotCount(page, scope), { timeout: 40000 })
    .toBeGreaterThan(0);

  const remove = page.getByRole("button", { name: "자료 삭제", exact: true });
  await expect(
    page
      .getByRole("button", { name: "서버에 저장된 파일 내려받기" })
      .locator("svg.lucide-download"),
  ).toBeVisible();
  await expect(remove.locator("svg.lucide-trash-2")).toBeVisible();
  const confirm = page.getByRole("dialog", { name: "자료 삭제" });
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(remove).toBeInViewport();
    const box = (await remove.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await remove.click();
  await expect(confirm).toContainText(copyName);
  await expect(confirm).toContainText("저장하지 않은 변경");
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(saveButton(page)).toBeEnabled();
  expect((await content(page.request, teamId, copy)).status()).toBe(200);
  const route = `**/api/teams/${teamId}/slides/${copy}`;
  await page.route(
    route,
    (r) =>
      r.fulfill({ status: 503, json: { error: "잠시 후 다시 시도하세요." } }),
    { times: 1 },
  );
  await remove.click();
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(confirm.getByRole("alert")).toBeVisible();
  expect((await content(page.request, teamId, copy)).status()).toBe(200);
  // The server can commit a delete before its response reaches the editor.
  await page.route(
    route,
    async (r) => {
      await r.fetch();
      await r.abort("failed");
    },
    { times: 1 },
  );
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  await expect
    .poll(async () => (await content(page.request, teamId, copy)).status())
    .toBe(404);
  await expect(confirm.getByRole("alert")).toBeVisible();
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/slides$/);
  await expect(fileCard(page, copyName)).toHaveCount(0);
  await expect(fileCard(page, file.title)).toBeVisible();
  expect((await content(page.request, teamId, copy)).status()).toBe(404);
  expect(await (await content(page.request, teamId, file.id)).body()).toEqual(
    bytes,
  );
  await expect.poll(() => snapshotCount(page, scope)).toBe(0);
  await fileCard(page, file.title).getByRole("button").click();
  await expect(idleSave(page)).toBeDisabled();
  await expect(
    editor(page).getByRole("dialog", { name: "Recover unsaved work" }),
  ).toHaveCount(0);
});

test("편집기 배포본이 없는 서버에서도 자료 상세에서 저장된 파일을 내려받을 수 있다", async ({
  page,
}) => {
  const bytes = example("flowchart.canvaslide");
  const file = await upload(
    page.request,
    teamId,
    `독립 파일 ${randomUUID()}`,
    bytes,
  );
  await page.route("**/tools/canvaslide/current.json", (r) =>
    r.fulfill({ status: 404 }),
  );
  await page.goto("/slides");
  await fileCard(page, file.title).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(file.id));
  await expect(page.locator("iframe.slide-editor-frame")).toHaveCount(0);
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "서버에 저장된 파일 내려받기" })
    .click();
  expect(readFileSync((await (await exported).path())!)).toEqual(bytes);
  await page.getByRole("button", { name: "자료 삭제", exact: true }).click();
  await page
    .getByRole("dialog", { name: "자료 삭제" })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await expect(page).toHaveURL(/\/slides$/);
  await expect(fileCard(page, file.title)).toHaveCount(0);
});

test("새 자료 생성에 실패하면 같은 화면에서 다시 저장할 수 있다", async ({
  page,
}) => {
  await page.goto("/slides");
  const list = "**/api/teams/*/slides";
  const committedIds: string[] = [];
  await page.route(list, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    committedIds.push((await json(committed)).id);
    return route.fulfill({ status: 503, json: { error: "응답 유실" } });
  });
  await page.getByRole("button", { name: "새 팀 자료" }).click();
  const title = `다시 저장 ${randomUUID().slice(0, 8)}`;
  await titleInput(page).fill(title);
  await saveButton(page).click();
  await expect(page.locator(".slide-editor .error-note")).toBeVisible();
  await expect(saveButton(page)).toBeEnabled();
  await expect(titleInput(page)).toHaveValue(title);
  expect(new URL(page.url()).searchParams.get("file")).toBeNull();
  await page.getByRole("button", { name: "팀 자료 목록" }).click();
  await page.getByRole("button", { name: "계속 편집" }).click();
  await page.unroute(list);
  await saveButton(page).click();
  await expect(page).toHaveURL(/file=/);
  await expect(idleSave(page)).toBeDisabled();
  expect(committedIds).toHaveLength(2);
  expect(
    new Set([...committedIds, new URL(page.url()).searchParams.get("file")])
      .size,
  ).toBe(1);
  expect(
    await meta(
      page.request,
      teamId,
      new URL(page.url()).searchParams.get("file")!,
    ),
  ).toMatchObject({ title, revision: 1 });
});

test("미저장 변경이 있으면 화면 이동 전에 묻고, 계속 편집하면 그대로 남는다", async ({
  page,
}) => {
  const file = await upload(
    page.request,
    teamId,
    "이동 확인",
    example("flowchart.canvaslide"),
  );
  await openTeamFile(page, file.id);
  await nudge(page);
  await page.getByRole("button", { name: "연간 업무", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "저장하지 않은 변경" });
  await dialog.getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/slides\?file=/);
  await expect(saveButton(page)).toBeEnabled();

  await page.getByRole("button", { name: "연간 업무", exact: true }).click();
  await dialog.getByRole("button", { name: "저장 후 이동" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await meta(page.request, teamId, file.id)).revision).toBe(2);
});

test("열람자는 읽기만 하고, 팀 밖 사용자는 원본을 받을 수 없다", async ({
  page,
  context,
}) => {
  const bytes = example("flowchart.canvaslide");
  const file = await upload(page.request, teamId, "권한 자료", bytes);
  const viewer = await peerSession(page, context, "viewer");
  expect(
    (await (await content(viewer.request, teamId, file.id)).body()).equals(
      bytes,
    ),
  ).toBe(true);
  const refused = await viewer.request.put(
    `/api/teams/${teamId}/slides/${file.id}/content`,
    {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Slide-Base-Revision": "1",
        "X-Slide-Request-Id": randomUUID(),
      },
      data: bytes,
    },
  );
  expect(refused.status()).toBe(403);
  const viewerPage = await viewer.newPage();
  await openTeamFile(viewerPage, file.id);
  await expect(titleInput(viewerPage)).toHaveCount(0);
  await expect(
    viewerPage.getByRole("button", { name: "자료 삭제" }),
  ).toHaveCount(0);
  const download = viewerPage.waitForEvent("download");
  await viewerPage
    .getByRole("button", { name: "서버에 저장된 파일 내려받기" })
    .click();
  expect(readFileSync((await (await download).path())!)).toEqual(bytes);
  await nudge(viewerPage, false);
  await saveShortcut(viewerPage);
  await fileShortcut(viewerPage, "Shift+s");
  await expect(viewerPage.getByRole("dialog")).toHaveCount(0);
  await expect(
    viewerPage.getByRole("button", { name: "다른 이름으로 저장" }),
  ).toHaveCount(0);
  await expect(idleSave(viewerPage)).toBeDisabled();
  await viewer.close();

  const outsider = await peerSession(page, context, null);
  expect((await content(outsider.request, teamId, file.id)).status()).toBe(403);
  expect(
    (await outsider.request.get(`/api/teams/${teamId}/slides`)).status(),
  ).toBe(403);
  await outsider.close();
  expect((await meta(page.request, teamId, file.id)).revision).toBe(1);
});

async function selectAllAndNudge(page: Page) {
  const mod = await page.evaluate(() =>
    /Mac/.test(navigator.userAgent) ? "Meta" : "Control",
  );
  await editor(page).getByTestId("canvas-viewport").click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press("ArrowRight");
  await expect(saveButton(page)).toBeEnabled();
}

test("이미지가 든 대표 자료(5.9MB)를 저장하고 내려받아 독립 편집기에서 다시 연다", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    delete (window as any).showSaveFilePicker;
    delete (window as any).showOpenFilePicker;
  });
  const original = example("freefall.canvaslide");
  expect(original.byteLength).toBeGreaterThan(5 * 1024 * 1024);
  const file = await upload(page.request, teamId, "freefall", original);
  await page.goto(`/slides?file=${file.id}`);
  await expect(editor(page).locator("[data-element-id]").first()).toBeVisible();
  await expect(idleSave(page)).toBeDisabled();
  await selectAllAndNudge(page);
  await saveShortcut(page);
  await expect(idleSave(page)).toBeDisabled({ timeout: 30000 });
  const saved = await meta(page.request, teamId, file.id);
  expect(saved.revision).toBe(2);
  const stored = await (await content(page.request, teamId, file.id)).body();
  expect(stored.byteLength).toBe(saved.byteLength);

  // The downloaded file opens in the editor running on its own, outside GraeBoard's frame.
  await page.goto(`/tools/canvaslide/${current.buildId}/`);
  await expect(page).toHaveTitle(/ — CanvaSlide$/);
  const bar = page.locator("header.editor-top-bar");
  await expect(
    bar.getByRole("textbox", { name: "Document name" }),
  ).toBeVisible();
  for (const name of [/^New \(/, /^Open \(/, /^Save \(/, /^Save as/i])
    await expect(bar.getByRole("button", { name })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await bar.getByRole("button", { name: "File menu", exact: true }).click();
  await expect(bar.getByRole("menuitem")).toHaveText([
    "New",
    "Open",
    "Save",
    "Save as…",
  ]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 900 });
  const openFile = bar.getByRole("button", { name: /^Open \(/ });
  await expect(openFile).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await openFile.click();
  await (
    await chooser
  ).setFiles({
    name: "freefall.canvaslide",
    mimeType: "application/json",
    buffer: stored,
  });
  await expect(page.locator("[data-element-id]").first()).toBeVisible();
  await expect(page).toHaveTitle("freefall — CanvaSlide");
});

test("공유는 그래보드의 임시 스냅샷으로 만들어지고 팀원만 연다", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const file = await upload(
    page.request,
    teamId,
    "공유 자료",
    example("flowchart.canvaslide"),
  );
  const foreign: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) foreign.push(request.url());
  });
  await openTeamFile(page, file.id);
  const created = page.waitForResponse(
    (response) =>
      response.url().includes("/slide-shares") &&
      response.request().method() === "POST",
  );
  await editor(page)
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await editor(page)
    .getByRole("dialog")
    .getByRole("button", { name: /copy/i })
    .first()
    .click();
  expect((await created).status()).toBe(201);
  const link = await editor(page).locator("#cloud-share-url").inputValue();
  const url = new URL(link);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/slides");
  expect(url.searchParams.get("team")).toBe(teamId);
  // The team file never went to another origin.
  expect(foreign).toEqual([]);
  // Sharing is a snapshot: the team original keeps its revision.
  expect((await meta(page.request, teamId, file.id)).revision).toBe(1);

  const writerPage = await context.newPage();
  await writerPage.goto(url.pathname + url.search);
  await expect(
    editor(writerPage).getByTestId("presentation-stage"),
  ).toBeVisible();
  await expect(
    writerPage.getByRole("button", { name: "다른 이름으로 저장" }),
  ).toBeDisabled();
  await writerPage.close();

  const member = await peerSession(page, context, "viewer");
  const memberPage = await member.newPage();
  await memberPage.goto(url.pathname + url.search);
  await expect(
    editor(memberPage).getByTestId("presentation-stage"),
  ).toBeVisible();
  await expect(
    editor(memberPage).getByText("Order received").first(),
  ).toBeVisible();
  await member.close();

  const outsider = await peerSession(page, context, null);
  expect(
    (
      await outsider.request.get(
        `/api/teams/${teamId}/slide-shares/${url.searchParams.get("share")}`,
      )
    ).status(),
  ).toBe(403);
  await outsider.close();
});

test("편집 가능한 공유 링크는 팀 사본으로 저장하고 해당 파일에서 계속 작업한다", async ({
  page,
}) => {
  const doc = JSON.parse(example("flowchart.canvaslide").toString());
  const shared = await page.request.post(`/api/teams/${teamId}/slide-shares`, {
    headers: { ...headers, "Content-Type": "text/plain" },
    data: JSON.stringify({ access: "edit", document: doc }),
  });
  expect(shared.ok()).toBe(true);
  const { id } = await json(shared);
  await page.goto(`/slides?team=${teamId}&share=${id}`);
  await expect(editor(page).getByTestId("canvas-viewport")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /서버에 저장된 파일 내려받기|자료 삭제/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "다른 이름으로 저장" }).click();
  const prompt = page.getByRole("dialog", { name: "다른 이름으로 저장" });
  await prompt.getByRole("textbox").fill("공유에서 만든 팀 파일");
  await prompt.getByRole("button", { name: "팀 사본으로 저장" }).click();
  await expect(page).toHaveURL(/file=/);
  await expect(titleInput(page)).toHaveValue("공유에서 만든 팀 파일");
  const fileId = new URL(page.url()).searchParams.get("file")!;
  expect(await meta(page.request, teamId, fileId)).toMatchObject({
    revision: 1,
    title: "공유에서 만든 팀 파일",
  });
});

function snapshotCount(page: Page, database: string) {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      if (!db.objectStoreNames.contains("snapshots")) return 0;
      return await new Promise<number>((resolve, reject) => {
        const count = db
          .transaction("snapshots")
          .objectStore("snapshots")
          .count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
    } finally {
      db.close();
    }
  }, database);
}

test("초안의 복구 사본이 있어도 저장 후 이동이 끝나면 복구를 묻지 않는다", async ({
  page,
}) => {
  test.setTimeout(60000);
  const user = (await json(await page.request.get("/api/bootstrap"))).user;
  const scope = `canvaslide-recovery.${user.id}.${teamId}`;
  await page.goto("/slides");
  await page.getByRole("button", { name: "새 팀 자료", exact: true }).click();
  const viewport = editor(page).getByTestId("canvas-viewport");
  await expect(titleInput(page)).toHaveValue("");
  await viewport.click();
  await page.keyboard.press("r");
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 130, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 235, box.y + 205, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => snapshotCount(page, scope), { timeout: 40000 })
    .toBe(1);
  await page.getByRole("button", { name: "팀 자료 목록" }).click();
  await page.getByRole("button", { name: "저장 후 이동" }).click();
  const title = `저장 후 다시 열기 ${randomUUID()}`;
  const prompt = page.getByRole("dialog", { name: "자료 저장" });
  await prompt.getByRole("textbox").fill(title);
  // Hold a competing transaction until after the save response. Closing the
  // old iframe too early cancels its pending recovery-record deletion.
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("snapshots", "readwrite");
          const store = tx.objectStore("snapshots");
          let release = false;
          window.addEventListener(
            "release-test-recovery",
            () => {
              release = true;
            },
            { once: true },
          );
          const read = () => {
            if (!release) store.get("hold").onsuccess = read;
          };
          tx.oncomplete = () => db.close();
          read();
          resolve();
        };
      }),
    scope,
  );
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/slides") &&
      r.status() === 201,
  );
  await prompt.getByRole("button", { name: "저장", exact: true }).click();
  await posted;
  await page.evaluate(() =>
    setTimeout(
      () => window.dispatchEvent(new Event("release-test-recovery")),
      400,
    ),
  );
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(titleInput(page)).toHaveValue(title);
  await expect(
    editor(page).locator('[data-element-type="shape"]').first(),
  ).toBeVisible();
  await expect.poll(() => snapshotCount(page, scope)).toBe(0);
  await expect(
    editor(page).getByRole("dialog", { name: "Recover unsaved work" }),
  ).toHaveCount(0);
});

test("복구본은 계정과 팀 범위로 나뉘어 다른 계정에는 보이지 않는다", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const user = (await json(await page.request.get("/api/bootstrap"))).user;
  const file = await upload(
    page.request,
    teamId,
    `복구 자료 ${randomUUID()}`,
    example("flowchart.canvaslide"),
  );
  await openTeamFile(page, file.id);
  await nudge(page);
  const scope = `canvaslide-recovery.${user.id}.${teamId}`;
  await expect
    .poll(() => snapshotCount(page, scope), { timeout: 45000 })
    .toBe(1);
  await page.close();

  // Another account on the same browser profile gets no offer for that work.
  const peerName = `slides-${randomUUID()}@example.com`;
  const admin = await context.newPage();
  expect(
    (
      await admin.request.post("/api/admin/users", {
        headers,
        data: {
          username: peerName,
          password: "local-peer-password",
          name: "같은 브라우저의 다른 계정",
          memberships: [{ teamId, role: "member" }],
        },
      })
    ).ok(),
  ).toBe(true);
  await login(admin.request, peerName, "local-peer-password");
  await admin.goto("/slides");
  await admin.getByRole("button", { name: file.title, exact: true }).click();
  await expect(editor(admin).getByTestId("canvas-viewport")).toBeVisible();
  await admin.waitForTimeout(1500);
  await expect(
    editor(admin).getByRole("dialog", { name: "Recover unsaved work" }),
  ).toHaveCount(0);

  // The author gets it back, still bound to the team file and its revision.
  await login(admin.request, "test@somansa.com", "1234");
  await admin.goto("/slides");
  await admin.getByRole("button", { name: file.title, exact: true }).click();
  const offer = editor(admin).getByRole("dialog", {
    name: "Recover unsaved work",
  });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Restore" }).click();
  await expect(saveButton(admin)).toBeEnabled();
  await saveShortcut(admin);
  await expect(idleSave(admin)).toBeDisabled();
  expect((await meta(admin.request, teamId, file.id)).revision).toBe(2);
});
