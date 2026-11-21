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

// These checks drive the real assembled CanvaSlide editor. Build it first:
//   npm run build:canvaslide
const distRoot = process.env.CANVASLIDE_DIST_DIR || "dist-canvaslide";
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
    "CanvaSlide 편집기 배포본이 없습니다. npm run build:canvaslide 를 먼저 실행하세요.",
  ).not.toBeNull();
});
test.beforeEach(async ({ page }) => {
  await login(page.request, "test@somansa.com", "1234");
  teamId = (await json(await page.request.get("/api/bootstrap"))).teams[0].id;
});

const editor = (page: Page) => page.frameLocator("iframe.slide-editor-frame");
const dirtyTag = (page: Page) => page.locator("[data-slide-dirty]");
async function openTeamFile(page: Page, fileId: string) {
  await page.goto(`/slides?file=${fileId}`);
  await expect(editor(page).locator("[data-element-id]").first()).toBeVisible();
  await expect(page.locator('[data-slide-target="team"]')).toHaveText(
    "팀 자료",
  );
  await expect(dirtyTag(page)).toHaveText("저장됨");
}
// A real edit through the editor's own canvas and keyboard handling.
async function nudge(page: Page) {
  // The editor's interaction layer sits above the drawn elements, as for a person's pointer.
  await editor(page)
    .getByText("Order received", { exact: true })
    .click({ force: true });
  await page.keyboard.press("ArrowRight");
  await expect(dirtyTag(page)).toHaveText("저장 안 됨");
}
async function saveShortcut(page: Page) {
  const mod = await page.evaluate(() =>
    /Mac/.test(navigator.userAgent) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${mod}+s`);
}
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

test("팀 자료를 열어 편집하고 Ctrl/Cmd+S로 저장하면 다른 팀원이 같은 내용을 열고 내려받는다", async ({
  page,
  context,
}) => {
  const original = example("flowchart.canvaslide");
  await page.goto("/slides");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /팀 자료로 가져오기/ }).click();
  await (
    await chooser
  ).setFiles({
    name: "주간회의.canvaslide",
    mimeType: "application/json",
    buffer: original,
  });
  await page.getByRole("button", { name: "주간회의", exact: true }).click();
  await expect(editor(page).locator("[data-element-id]").first()).toBeVisible();
  const fileId = new URL(page.url()).searchParams.get("file")!;
  expect((await meta(page.request, teamId, fileId)).revision).toBe(1);

  await nudge(page);
  await saveShortcut(page);
  await expect(dirtyTag(page)).toHaveText("저장됨");
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
  await peerPage.getByRole("button", { name: "팀 자료 목록" }).click();
  await peerPage.getByRole("button", { name: "내려받기" }).first().click();
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
  await expect(dirtyTag(page)).toHaveText("저장 안 됨");
  expect(failures).toBe(2);
  expect((await meta(page.request, teamId, file.id)).revision).toBe(1);

  await page.unroute("**/api/teams/*/slides/*/content");
  await page.getByRole("button", { name: "저장 (Ctrl/Cmd+S)" }).click();
  await expect(dirtyTag(page)).toHaveText("저장됨");
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
  await expect(dirtyTag(page)).toHaveText("저장됨");

  // The team file still holds the other member's bytes; my edit is a new file.
  expect(
    (await (await content(page.request, teamId, file.id)).body()).equals(other),
  ).toBe(true);
  const copyId = new URL(page.url()).searchParams.get("file")!;
  expect(copyId).not.toBe(file.id);
  const copy = await meta(page.request, teamId, copyId);
  expect(copy.title).toBe("충돌 자료 (내 변경)");
  expect(copy.revision).toBe(1);
});

test("새 자료는 첫 저장에서 팀 파일이 되고, 편집기의 새 문서는 팀 파일을 덮어쓰지 않는다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Every engine then saves a local document as a download.
    delete (window as any).showSaveFilePicker;
    delete (window as any).showOpenFilePicker;
  });
  await page.goto("/slides");
  await page.getByRole("button", { name: "새 팀 자료" }).click();
  const prompt = page.getByRole("dialog", { name: "새 자료" });
  await prompt.getByRole("textbox").fill("분기 계획");
  await prompt.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator('[data-slide-target="team"]')).toHaveText(
    "팀 자료 · 첫 저장 전",
  );
  await expect(editor(page).getByTestId("canvas-viewport")).toBeVisible();
  await editor(page).getByTestId("canvas-viewport").click();
  await saveShortcut(page);
  await expect(page.locator('[data-slide-target="team"]')).toHaveText(
    "팀 자료",
  );
  const fileId = new URL(page.url()).searchParams.get("file")!;
  const created = await meta(page.request, teamId, fileId);
  expect(created).toMatchObject({ title: "분기 계획", revision: 1 });

  // The editor's own New command replaces the document: it is no longer the team file.
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/slides") &&
      ["PUT", "POST"].includes(request.method())
    )
      writes++;
  });
  await editor(page).getByRole("button", { name: /^New/ }).click();
  await expect(page.locator('[data-slide-target="device"]')).toBeVisible();
  const download = page.waitForEvent("download");
  await editor(page).getByTestId("canvas-viewport").click();
  await saveShortcut(page);
  expect((await download).suggestedFilename()).toMatch(/\.canvaslide$/);
  expect(writes).toBe(0);
  expect((await meta(page.request, teamId, fileId)).revision).toBe(1);
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
  await expect(dirtyTag(page)).toHaveText("저장 안 됨");

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
  await nudge(viewerPage);
  await saveShortcut(viewerPage);
  await expect(viewerPage.locator(".slide-editor .error-note")).toContainText(
    "권한",
  );
  await expect(dirtyTag(viewerPage)).toHaveText("저장 안 됨");
  await viewer.close();

  const outsider = await peerSession(page, context, null);
  expect((await content(outsider.request, teamId, file.id)).status()).toBe(403);
  expect(
    (await outsider.request.get(`/api/teams/${teamId}/slides`)).status(),
  ).toBe(403);
  await outsider.close();
  expect((await meta(page.request, teamId, file.id)).revision).toBe(1);
});
