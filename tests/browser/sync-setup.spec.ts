import { test, expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { createApp } from "../../server/app.mjs";
import { openDatabase } from "../../server/db.mjs";
import { unpack } from "../../shared/compact.js";

let app: ReturnType<typeof createApp>, db: ReturnType<typeof openDatabase>;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base: string, teamId: string, otherTeamId: string, directory: string;
let port = 0;
let originalKey: string | undefined, originalKeyId: string | undefined;
// Start (or restart, keeping the port so the session cookie stays valid) the
// internal server with the given sync options.
async function start(options: Record<string, unknown> = {}) {
  if (server) {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    syncOptions: {
      installationId: randomUUID(),
      profiles: [],
      schedule: false,
      setupConfigPath: join(directory, ".env"),
      ...options,
    },
  });
  server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
}
const wizard = (page: Page) =>
  page.getByRole("region", { name: "설정팀 외부 동기화 설정", exact: true });
async function post(page: Page, path: string, data: unknown, method = "POST") {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
async function open(page: Page) {
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    page.getByText("GitHub 연동을 통해 외부에서 동기화 운영이 가능합니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "외부 동기화 설정", exact: true })
    .click();
  await expect(
    wizard(page).getByRole("button", { name: /^(다음|외부 서비스 설정으로)$/ }),
  ).toBeEnabled();
}
test.beforeEach(async ({ page }) => {
  originalKey = process.env.GRAEBOARD_SYNC_KEY;
  originalKeyId = process.env.GRAEBOARD_SYNC_KEY_ID;
  directory = mkdtempSync(join(tmpdir(), "graeboard-setup-ui-"));
  db = openDatabase(join(directory, "test.sqlite"));
  port = 0;
  await start();
  const { user } = await post(page, "/auth/setup", {
    username: "wizard@example.com",
    password: "wizard-test-password",
    name: "관리자",
    teamName: "설정팀",
  });
  teamId = user.teamIds[0];
  otherTeamId = (await post(page, "/admin/teams", { name: "다른 팀" })).id;
  await page.goto(base);
});
test.afterEach(async ({ page }) => {
  await page.close();
  await app.locals.sync.close();
  app.locals.cellEvents.close();
  app.locals.documentEvents.close();
  server!.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  db.close();
  rmSync(directory, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.GRAEBOARD_SYNC_KEY;
  else process.env.GRAEBOARD_SYNC_KEY = originalKey;
  if (originalKeyId === undefined) delete process.env.GRAEBOARD_SYNC_KEY_ID;
  else process.env.GRAEBOARD_SYNC_KEY_ID = originalKeyId;
});

test("내부 프로필·토큰 저장과 초기 게시 후 외부 서비스 설정으로 이동하고 재진입한다", async ({
  page,
}, testInfo) => {
  await open(page);
  const w = wizard(page);
  await expect(
    w.getByRole("button", { name: "설정 다시 확인", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "서버 적용 확인", exact: true }),
  ).toHaveCount(0);
  const phases = w.getByRole("list", { name: "설정 과정", exact: true });
  await expect(phases.locator('[aria-current="true"]')).toContainText(
    "1. 내부 프로필 설정",
  );
  await expect(w.locator('[aria-current="step"]')).toHaveText(
    "1. GitHub 저장소",
  );
  await expect(
    w.getByText("아직 생성되지 않음", { exact: true }),
  ).toBeVisible();
  await expect(
    phases.getByRole("button", { name: /^2\. 외부 서비스 설정/ }),
  ).toBeDisabled();
  // The repository and token are entered together and saved by one button.
  const tokenInput = w.getByLabel("내부 GitHub 토큰", { exact: true });
  const save = w.getByRole("button", { name: "저장소·토큰 저장", exact: true });
  await expect(tokenInput).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(
    w.getByRole("button", { name: "토큰 저장", exact: true }),
  ).toHaveCount(0);
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.getByText(/GitHub 저장소 주소를/)).toBeVisible();
  await w
    .getByLabel("GitHub 데이터 저장소", { exact: true })
    .fill("https://github.com/example/team-data");
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.getByText(/저장소·토큰 저장을 누르세요/)).toBeVisible();
  // A repository without its token is refused before anything is written.
  await save.click();
  await expect(w.getByText(/토큰도 함께 입력하세요/)).toBeVisible();
  expect(existsSync(join(directory, ".env"))).toBe(false);
  await tokenInput.fill("fixture token");
  await save.click();
  await expect(w.getByText(/GitHub 토큰 형식을 확인하세요/)).toBeVisible();
  expect(existsSync(join(directory, ".env"))).toBe(false);
  await tokenInput.fill("fixture_token");
  await page.route(
    `**/api/admin/teams/${teamId}/sync-setup`,
    (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 409,
            json: {
              error: "프로필 생성 요청을 저장하지 못했습니다. 다시 시도하세요.",
            },
          })
        : route.fallback(),
    { times: 1 },
  );
  await save.click();
  await expect(
    w.getByText(/프로필 생성 요청을 저장하지 못했습니다/),
  ).toBeVisible();
  expect(existsSync(join(directory, ".env"))).toBe(false);
  await expect(
    w.getByText("아직 생성되지 않음", { exact: true }),
  ).toBeVisible();
  await expect(tokenInput).toHaveValue("fixture_token");
  await expect(w.getByLabel("프로필 ID", { exact: true })).toHaveCount(0);
  // Enter submits the pair; the server already carries an installation
  // identity, so the profile applies and the token is stored at once.
  await tokenInput.press("Enter");
  await expect(page.getByText(/저장소와 토큰을 저장했습니다/)).toBeVisible();
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await expect(w.getByText(/재시작을 요청하세요/)).toHaveCount(0);
  const env = parseEnv(readFileSync(join(directory, ".env"), "utf8"));
  const profile = JSON.parse(env.GRAEBOARD_SYNC_PROFILES)[0];
  expect(app.locals.sync.profiles).toEqual([profile]);
  expect(process.env.GRAEBOARD_SYNC_KEY).toBe(env.GRAEBOARD_SYNC_KEY);
  await expect(
    w.getByRole("button", {
      name: /^(프로필 ID|팀 UUID|내부 설치 UUID|외부 설치 UUID) 복사$/,
    }),
  ).toHaveCount(0);
  await expect(w.getByText(profile.profileId, { exact: true })).toHaveCount(0);
  await expect(
    w.getByText(profile.peerInstallationId, { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("internal-profile.png"),
    fullPage: true,
  });
  // Only the token's beginning is shown, with delete instead of the input.
  await expect(w.getByText("fixtur…", { exact: true })).toBeVisible();
  await expect(tokenInput).toHaveCount(0);
  await expect(w.getByText(/암호화된 토큰이 등록/)).toHaveCount(0);
  await save.click();
  await expect(w.getByText(/바뀐 내용이 없습니다/)).toBeVisible();
  await w.getByRole("button", { name: "토큰 삭제", exact: true }).click();
  await expect(tokenInput).toHaveValue("");
  await expect(w.getByText("fixtur…", { exact: true })).toHaveCount(0);
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByText(/내부 GitHub 토큰을 입력해 저장한 뒤 진행하세요/),
  ).toBeVisible();
  await tokenInput.fill("fixture_token");
  await save.click();
  await expect(page.getByText(/토큰을 암호화해 저장했습니다/)).toBeVisible();
  await expect(w.getByText("fixtur…", { exact: true })).toBeVisible();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByRole("heading", { name: "GitHub 연결", exact: true }),
  ).toBeFocused();
  await expect(
    w.getByRole("button", { name: "이 팀에 연결", exact: true }),
  ).toBeEnabled();
  await expect(
    w.getByRole("region", { name: "팀장 연결 키", exact: true }),
  ).toHaveCount(0);
  await w
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
  await expect(w.getByText(/초기 게시를 완료한 뒤/)).toBeVisible();
  // Once GitHub holds the initial publication, the external services open.
  await page.route("**/api/teams/*/sync", (route) =>
    route.fulfill({
      json: {
        mode: "active",
        canonicalHead: "head",
        pending: 0,
        conflicts: 0,
        profileId: profile.profileId,
      },
    }),
  );
  await w
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
  await expect(phases.locator('[aria-current="true"]')).toContainText(
    "2. 외부 서비스 설정",
  );
  // The external services start by forking the app source for Pages.
  const fork = w.getByRole("heading", { name: "GitHub Fork", exact: true });
  await expect(fork).toBeFocused();
  await w
    .getByRole("button", { name: "내부 프로필 설정으로", exact: true })
    .click();
  await expect(
    w.getByRole("heading", { name: "GitHub 연결", exact: true }),
  ).toBeFocused();
  await phases.getByRole("button", { name: /^2\. 외부 서비스 설정/ }).click();
  await expect(fork).toBeFocused();
  await expect(
    w.getByRole("link", { name: "원본 저장소의 Fork 화면", exact: true }),
  ).toHaveAttribute("href", "https://github.com/hwantage/GraeBoard/fork");
  await expect(w.getByText(/Copy the main branch only/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("fork.png"),
    fullPage: true,
  });
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.getByText(/완료한 뒤 체크하세요/)).toBeVisible();
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByRole("heading", { name: "Cloudflare", exact: true }),
  ).toBeFocused();
  await expect(w.getByText(/Fork한 저장소/).first()).toBeVisible();
  await w.getByLabel("외부 접속 주소").fill("https://team.pages.dev");
  // The Google OAuth values appear once the Access team domain is known.
  const redirect = w.getByLabel(
    "승인된 리디렉션 URI(Authorized redirect URIs)",
    {
      exact: true,
    },
  );
  await expect(redirect).toHaveCount(0);
  await expect(w.getByText(/Zero Trust 무료 가입/)).toBeVisible();
  await w
    .getByLabel("Access 발급자")
    .fill("https://company.cloudflareaccess.com");
  await expect(redirect).toHaveValue(
    "https://company.cloudflareaccess.com/cdn-cgi/access/callback",
  );
  await expect(
    w.getByLabel("승인된 JavaScript 원본(Authorized JavaScript origins)", {
      exact: true,
    }),
  ).toHaveValue("https://company.cloudflareaccess.com");
  await redirect.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("access.png"),
    fullPage: true,
  });
  await w.getByLabel("Application Audience").fill("a".repeat(64));
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await w.getByRole("button", { name: "이전", exact: true }).click();
  await expect(w.getByLabel("외부 접속 주소")).toHaveValue(
    "https://team.pages.dev",
  );
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.getByText(/Reference ID 20자리/)).toBeVisible();
  await w.getByLabel("Supabase Reference ID").fill("a".repeat(20));
  // The database is initialized from the Supabase SQL Editor, not a PC.
  const databaseSql = w.getByLabel("외부 DB 초기화 SQL", { exact: true });
  await expect(databaseSql).toHaveValue(
    new RegExp(`INSERT INTO graeboard\\.team_meta VALUES\\(1,'${teamId}'\\)`),
  );
  await expect(databaseSql).toHaveValue(/^-- GraeBoard 외부 DB 초기화/);
  await expect(w.getByText(/npm run migrate/)).toHaveCount(0);
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.locator('[aria-current="step"]')).toHaveText("4. 배포");
  // Nothing about the Worker is typed by hand. The earlier steps' values are
  // remembered here, and one button builds the two values the fork needs.
  await expect(w.getByLabel("gateway 자원 주소")).toHaveCount(0);
  await expect(w.getByLabel("gateway Worker 이름")).toHaveCount(0);
  const earlier = w.locator('[aria-label="앞 단계에서 입력한 값"]');
  await expect(earlier).toContainText("https://team.pages.dev");
  await expect(earlier).toContainText("a".repeat(20));
  const make = w.getByRole("button", { name: "배포 설정 만들기", exact: true });
  await make.click();
  await expect(w.getByText(/Account ID 32자리/)).toBeVisible();
  await w.getByLabel("Cloudflare Account ID").fill("c".repeat(32));
  await make.click();
  await expect(
    w.getByText(
      /Cloudflare API 토큰, Supabase 액세스 토큰, 외부용 GitHub 토큰을 입력하세요/,
    ),
  ).toBeVisible();
  await expect(w.getByLabel("TEAM_SITE_CONFIG", { exact: true })).toHaveCount(
    0,
  );
  await w.getByLabel("Cloudflare API 토큰").fill("cf-token");
  await w.getByLabel("Supabase 액세스 토큰").fill("sbp_token");
  await w.getByLabel("외부용 GitHub 토큰").fill("github_pat_external");
  await make.click();
  const site = JSON.parse(
    await w.getByLabel("TEAM_SITE_CONFIG", { exact: true }).inputValue(),
  );
  expect(site).toMatchObject({
    cloudflareAccountId: "c".repeat(32),
    supabaseProjectRef: "a".repeat(20),
    gateway: {
      name: `graeboard-${teamId.slice(0, 8)}`,
      vars: { SITE_TEAM_ID: teamId, APP_ORIGIN: "https://team.pages.dev" },
    },
    edge: {
      SITE_TEAM_ID: teamId,
      INSTALLATION_ID: profile.peerInstallationId,
      PEER_INSTALLATION_ID: env.GRAEBOARD_INSTALLATION_ID,
    },
  });
  expect(JSON.parse(site.edge.SYNC_PROFILES)[0].teamId).toBe(teamId);
  expect(site.edge.RESOURCE_ORIGIN).toBeUndefined();
  // Tokens and freshly generated keys go to the fork as one secret.
  const secrets = JSON.parse(
    await w.getByLabel("TEAM_SITE_SECRETS", { exact: true }).inputValue(),
  );
  expect(secrets).toMatchObject({
    CLOUDFLARE_API_TOKEN: "cf-token",
    SUPABASE_ACCESS_TOKEN: "sbp_token",
    GIT_TEAM: "github_pat_external",
  });
  const keys = [
    secrets.GRAEBOARD_GATEWAY_SECRET,
    secrets.GRAEBOARD_RESOURCE_SECRET,
    secrets.GRAEBOARD_ACCESS_TOKEN_KEY,
  ];
  for (const key of keys) expect(Buffer.from(key, "base64")).toHaveLength(32);
  expect(new Set(keys).size).toBe(3);
  // A changed value hides the stale output until it is built again.
  await w.getByLabel("Supabase 액세스 토큰").fill("sbp_other");
  await expect(w.getByLabel("TEAM_SITE_SECRETS", { exact: true })).toHaveCount(
    0,
  );
  await make.click();
  // Only non-secret console values are remembered in this browser.
  const remembered = await page.evaluate(
    (key) => localStorage.getItem(key) || "",
    `graeboard:sync-setup:${teamId}`,
  );
  expect(JSON.parse(remembered)).toMatchObject({
    appOrigin: "https://team.pages.dev",
    accountId: "c".repeat(32),
  });
  expect(remembered).not.toMatch(/cf-token|sbp_|github_pat/);
  await expect(w.getByText(/openssl/)).toHaveCount(0);
  await expect(w.getByLabel("빌드·배포 명령", { exact: true })).toBeHidden();
  await expect(
    w.getByRole("button", { name: "4. 배포", exact: true }),
  ).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    w.getByRole("button", { name: "서버 적용 확인", exact: true }),
  ).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: testInfo.outputPath("deployment.png"),
    fullPage: true,
  });
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByRole("heading", { name: "외부 계정", exact: true }),
  ).toBeFocused();
  // The lead key is issued here, after the publication it unlocks.
  await expect(
    w
      .getByRole("region", { name: "팀장 연결 키", exact: true })
      .getByRole("button", { name: "팀장 연결 키 발급", exact: true }),
  ).toBeEnabled();
  await w.getByRole("button", { name: "설정 안내 닫기" }).click();
  const details = page.locator(".team-sync-settings .sync-connection-details");
  await expect(
    details.getByText(profile.profileId, { exact: true }),
  ).toHaveCount(0);
  await page.route(
    `**/api/admin/teams/${teamId}/sync-setup`,
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: "식별 정보를 조회하지 못했습니다. 다시 확인하세요." },
      }),
    { times: 1 },
  );
  await details.getByText("연결 식별 정보", { exact: true }).click();
  await expect(
    details.getByText(/식별 정보를 조회하지 못했습니다/),
  ).toBeVisible();
  await details.getByRole("button", { name: "다시 확인", exact: true }).click();
  await expect(
    details.getByText(profile.profileId, { exact: true }),
  ).toBeVisible();
  await expect(details.getByText(teamId, { exact: true })).toBeVisible();
  await expect(
    details.getByText(env.GRAEBOARD_INSTALLATION_ID, { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText(profile.peerInstallationId, { exact: true }),
  ).toBeVisible();
  await expect(details.getByRole("button", { name: /복사/ })).toHaveCount(0);
  await details.getByText("연결 식별 정보", { exact: true }).click();
  await expect(
    details.getByText(profile.profileId, { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "외부 동기화 설정", exact: true })
    .click();
  await expect(
    w.getByRole("button", {
      name: /^(프로필 ID|팀 UUID|내부 설치 UUID|외부 설치 UUID) 복사$/,
    }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  expect(
    JSON.parse(
      parseEnv(readFileSync(join(directory, ".env"), "utf8"))
        .GRAEBOARD_SYNC_PROFILES,
    ),
  ).toHaveLength(1);
  expect(
    parseEnv(readFileSync(join(directory, ".env"), "utf8")).GRAEBOARD_SYNC_KEY,
  ).toBe(env.GRAEBOARD_SYNC_KEY);
});

test("최초 설정 조회 실패는 오류 위치에서 다시 불러올 수 있다", async ({
  page,
}) => {
  await page.route(
    `**/api/admin/teams/${teamId}/sync-setup`,
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: "설정을 불러오지 못했습니다. 다시 시도하세요." },
      }),
    { times: 1 },
  );
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await page
    .getByRole("button", { name: "외부 동기화 설정", exact: true })
    .click();
  const w = wizard(page);
  await expect(w.getByText(/설정을 불러오지 못했습니다/)).toBeVisible();
  await expect(
    w.getByRole("button", { name: "다음", exact: true }),
  ).toBeDisabled();
  await w.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(
    w.getByRole("button", { name: "다음", exact: true }),
  ).toBeEnabled();
  await expect(
    w.getByRole("button", { name: "다시 불러오기", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "설정 다시 확인", exact: true }),
  ).toHaveCount(0);
});

test("서비스 연결의 대상 팀 전환은 초안·식별자를 분리하고 작은 화면에서 조작된다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "외부 동기화", exact: true }).click();
  await page.getByLabel("설정할 팀").selectOption(teamId);
  const row = page.locator(".service-connections-setup");
  const layout = await row.evaluate((element) => ({
    centers: Array.from(element.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return rect.y + rect.height / 2;
    }),
    overflow: element.scrollWidth > element.clientWidth,
  }));
  expect(
    Math.max(...layout.centers) - Math.min(...layout.centers),
  ).toBeLessThan(2);
  expect(layout.overflow).toBe(false);
  await row.screenshot({ path: testInfo.outputPath("team-setup-row.png") });
  await page.getByRole("button", { name: "외부 동기화 설정" }).click();
  await wizard(page)
    .getByLabel("GitHub 데이터 저장소", { exact: true })
    .fill("https://github.com/example/team-a");
  await wizard(page).getByRole("button", { name: "설정 안내 닫기" }).click();
  await page.getByLabel("설정할 팀").selectOption(otherTeamId);
  await page.getByRole("button", { name: "외부 동기화 설정" }).click();
  const other = page.getByRole("region", {
    name: "다른 팀 외부 동기화 설정",
    exact: true,
  });
  await expect(other.getByLabel("팀 UUID", { exact: true })).toHaveCount(0);
  await expect(other).not.toContainText(teamId);
  await expect(
    other.getByLabel("GitHub 데이터 저장소", { exact: true }),
  ).toHaveValue("");
  await other.getByRole("button", { name: "다음", exact: true }).click();
  await expect(other.getByText(/GitHub 저장소 주소를/)).toBeVisible();
  const width = await other.evaluate((node) => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
});

test("연결된 팀 재진입은 기존 관리로 시작하고 오래된 영수증으로 완료하지 않는다", async ({
  page,
}) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  bootstrap.teams = bootstrap.teams.map((team: any) => ({
    ...team,
    sync: { available: true, configured: true },
  }));
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: bootstrap }),
  );
  await page.route("**/api/admin/users", async (route) => {
    const data = unpack(await (await route.fetch()).json());
    data.teams = bootstrap.teams;
    await route.fulfill({ json: data });
  });
  let status = {
    mode: "active",
    canonicalHead: "head",
    pending: 0,
    conflicts: 0,
    profileId: "existing",
    remoteStatus: {
      verified: true,
      mode: "active",
      appliedCanonicalHead: "head",
      observedAt: new Date(Date.now() - 300000).toISOString(),
    },
  };
  await page.route("**/api/teams/*/sync", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/admin/teams/*/sync-setup", (route) =>
    route.fulfill({
      json: {
        revision: "revision",
        installationId: randomUUID(),
        profile: {
          profileId: "existing",
          repository: "https://github.com/example/data",
          peerInstallationId: randomUUID(),
        },
        installed: true,
        restartRequired: false,
        credentialReady: true,
        credentialStored: true,
        tokenEnvironment: false,
      },
    }),
  );
  await page.reload();
  await open(page);
  const w = wizard(page);
  await expect(
    w.getByRole("heading", { name: "GitHub 연결", exact: true }),
  ).toBeVisible();
  await expect(
    w.getByRole("button", { name: "일시정지", exact: true }),
  ).toBeVisible();
  // A published team reaches later steps without re-entering deployment values.
  await w
    .getByRole("list", { name: "설정 과정", exact: true })
    .getByRole("button", { name: /^2\. 외부 서비스 설정/ })
    .click();
  await expect(
    w.getByRole("heading", { name: "GitHub Fork", exact: true }),
  ).toBeFocused();
  await w.getByRole("button", { name: "5. 외부 계정", exact: true }).click();
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await w.getByLabel("내부에서 저장한 업무·이미지가 외부에 보입니다.").check();
  await w.getByLabel("외부에서 저장한 업무·이미지가 내부에 보입니다.").check();
  await w.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(w.getByText(/최신 공유본의 상대 적용을 아직/)).toBeVisible();
  status = {
    ...status,
    remoteStatus: {
      ...status.remoteStatus,
      observedAt: new Date().toISOString(),
    },
  };
  await w.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(w).toHaveCount(0);
});

test("토큰 저장 실패 후 재시도는 기존 연결을 보존하고 원문을 지운다", async ({
  page,
}) => {
  process.env.GRAEBOARD_SYNC_KEY = randomBytes(32).toString("base64");
  app.locals.sync.profiles.push({
    profileId: "existing",
    teamId,
    repository: "test/data",
    peerInstallationId: randomUUID(),
  });
  await post(
    page,
    `/admin/teams/${teamId}/connection`,
    { profileId: "existing", expectedRevision: 0 },
    "PUT",
  );
  await page.reload();
  await open(page);
  const w = wizard(page);
  // A connected team without a token opens at the token step.
  await expect(
    w.getByRole("heading", { name: "GitHub 저장소", exact: true }),
  ).toBeVisible();
  await expect(w.getByLabel("프로필 ID", { exact: true })).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "저장소·토큰 저장", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByLabel("GitHub 데이터 저장소", { exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await w
    .getByLabel("내부 GitHub 토큰", { exact: true })
    .fill("fixture_private_token");
  db.prepare(
    "UPDATE team_sync_links SET lease_owner='busy' WHERE team_id=?",
  ).run(teamId);
  await w.getByRole("button", { name: "토큰 저장", exact: true }).click();
  await expect(w.getByText(/작업이 끝난 뒤 토큰을 다시 저장/)).toBeVisible();
  await expect(w.getByLabel("내부 GitHub 토큰", { exact: true })).toHaveValue(
    "fixture_private_token",
  );
  db.prepare("UPDATE team_sync_links SET lease_owner=NULL WHERE team_id=?").run(
    teamId,
  );
  const link = { ...app.locals.sync.store(teamId).readLink() };
  await w.getByRole("button", { name: "토큰 저장", exact: true }).click();
  await expect(w.getByText("fixture_pr…", { exact: true })).toBeVisible();
  await expect(w.getByLabel("내부 GitHub 토큰", { exact: true })).toHaveCount(
    0,
  );
  expect(
    db
      .prepare(
        "SELECT ciphertext FROM sync_credentials WHERE profile_id='existing'",
      )
      .get().ciphertext,
  ).not.toContain("fixture_private_token");
  expect({ ...app.locals.sync.store(teamId).readLink() }).toEqual(link);
});

test("외부 검사 실패 후 재시도·가져오기·재진입에서 내부 설치 입력을 제공하지 않는다", async ({
  page,
}) => {
  const boot = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...boot,
        site: "external",
        authMode: "access",
        accountLinking: true,
      },
    }),
  );
  const profile = {
    profileId: "external",
    teamId,
    repository: "https://github.com/example/external",
    ready: true,
  };
  await page.route("**/api/admin/teams/*/connection", (route) =>
    route.fulfill({
      json: { profileId: "external", revision: 1, profiles: [profile] },
    }),
  );
  let ready = false,
    imported = false;
  await page.route("**/api/teams/*/sync", (route) =>
    route.fulfill({
      json: {
        mode: imported ? "active" : "unlinked",
        canonicalHead: imported ? "head" : null,
        pending: 0,
        conflicts: 0,
      },
    }),
  );
  await page.route("**/api/admin/service-connections/check", (route) =>
    route.fulfill({
      json: {
        profiles: [profile],
        checks: [
          {
            name: "PostgreSQL",
            status: ready ? "ok" : "error",
            message: ready ? "연결 확인" : "DB 연결 오류",
          },
        ],
      },
    }),
  );
  await page.route("**/api/admin/sync/import", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      profileId: "external",
      teamId,
    });
    imported = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await open(page);
  const w = wizard(page);
  await expect(
    w.getByRole("list", { name: "설정 과정", exact: true }),
  ).toHaveCount(0);
  await expect(w.getByLabel("내부 GitHub 토큰")).toHaveCount(0);
  await w.getByRole("button", { name: "공통 연결 검사", exact: true }).click();
  await expect(w.getByText(/오류 항목의 binding/)).toBeVisible();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByRole("heading", { name: "설치 확인", exact: true }),
  ).toBeVisible();
  ready = true;
  await w.getByRole("button", { name: "공통 연결 검사", exact: true }).click();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await w.getByRole("button", { name: "팀 가져오기", exact: true }).click();
  await expect(w.getByText(/이미 가져온 팀입니다/)).toBeVisible();
  await expect(
    w.getByRole("button", { name: "초기 게시", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "팀 가져오기", exact: true }),
  ).toHaveCount(0);
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    w.getByRole("heading", { name: "양방향 확인", exact: true }),
  ).toBeVisible();
});

test("최초 설치 식별자만 시스템 관리자 재시작을 요청하고 재시작 뒤에는 바로 적용한다", async ({
  page,
}) => {
  await start({ installationId: undefined });
  await page.reload();
  await open(page);
  const w = wizard(page);
  await w
    .getByLabel("GitHub 데이터 저장소", { exact: true })
    .fill("https://github.com/example/first-install");
  await w.getByLabel("내부 GitHub 토큰", { exact: true }).fill("fixture_token");
  await w
    .getByRole("button", { name: "저장소·토큰 저장", exact: true })
    .click();
  await expect(
    w.getByText(/시스템 관리자에게 Node 서비스 재시작을 요청하세요/),
  ).toBeVisible();
  await expect(
    page.getByText(/재시작한 뒤 다시 저장하면 토큰도 저장합니다/),
  ).toBeVisible();
  expect(db.prepare("SELECT 1 FROM sync_credentials").get()).toBeUndefined();
  await expect(
    w
      .getByRole("definition")
      .filter({ hasText: "생성됨 · 시스템 관리자 재시작 필요" }),
  ).toBeVisible();
  expect(app.locals.sync.profiles).toHaveLength(0);
  const env = parseEnv(readFileSync(join(directory, ".env"), "utf8"));
  // The operator restarts the service, which loads the file's identity.
  await start({
    installationId: env.GRAEBOARD_INSTALLATION_ID,
    profiles: JSON.parse(env.GRAEBOARD_SYNC_PROFILES),
  });
  process.env.GRAEBOARD_SYNC_KEY = env.GRAEBOARD_SYNC_KEY;
  await page.reload();
  await open(page);
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await expect(w.getByText(/재시작을 요청하세요/)).toHaveCount(0);
  await w.getByLabel("내부 GitHub 토큰", { exact: true }).fill("fixture_token");
  await w
    .getByRole("button", { name: "저장소·토큰 저장", exact: true })
    .click();
  await expect(w.getByText("fixtur…", { exact: true })).toBeVisible();
  await w.getByRole("button", { name: "설정 안내 닫기" }).click();
  // The next team applies without another restart.
  await page.getByRole("button", { name: "외부 동기화", exact: true }).click();
  await page.getByLabel("설정할 팀").selectOption(otherTeamId);
  await page.getByRole("button", { name: "외부 동기화 설정" }).click();
  const other = page.getByRole("region", {
    name: "다른 팀 외부 동기화 설정",
    exact: true,
  });
  await other
    .getByLabel("GitHub 데이터 저장소", { exact: true })
    .fill("https://github.com/example/second-team");
  await other
    .getByLabel("내부 GitHub 토큰", { exact: true })
    .fill("fixture_token");
  await other
    .getByRole("button", { name: "저장소·토큰 저장", exact: true })
    .click();
  await expect(page.getByText(/저장소와 토큰을 저장했습니다/)).toBeVisible();
  await expect(
    other.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await expect(other.getByText(/재시작을 요청하세요/)).toHaveCount(0);
  expect(
    app.locals.sync.profiles.map((p: { teamId: string }) => p.teamId),
  ).toEqual([teamId, otherTeamId]);
  expect(
    JSON.parse(
      parseEnv(readFileSync(join(directory, ".env"), "utf8"))
        .GRAEBOARD_SYNC_PROFILES,
    ),
  ).toHaveLength(2);
});

test("팀 탭에서 설정 안내를 여는 동안 기존 화면의 상태 조회는 멈춘다", async ({
  page,
}) => {
  process.env.GRAEBOARD_SYNC_KEY = randomBytes(32).toString("base64");
  app.locals.sync.profiles.push({
    profileId: "existing",
    teamId,
    repository: "test/data",
    peerInstallationId: randomUUID(),
  });
  await post(
    page,
    `/admin/teams/${teamId}/connection`,
    { profileId: "existing", expectedRevision: 0 },
    "PUT",
  );
  await post(
    page,
    `/admin/teams/${teamId}/sync-credential`,
    { profileId: "existing", token: "fixture_token" },
    "PUT",
  );
  await page.reload();
  const reads: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/teams\/[^/]+\/sync$/.test(request.url()))
      reads.push(request.url());
  });
  await page.clock.install();
  await open(page);
  const w = wizard(page);
  await expect(w.getByLabel("동기화 상태", { exact: true })).toBeVisible();
  reads.length = 0;
  // Only the embedded settings poll while the wizard is open: one read per
  // 5-second tick, not one from the screen behind it as well.
  for (let round = 0; round < 2; round++) {
    await Promise.all([
      page.waitForResponse((response) =>
        /\/api\/teams\/[^/]+\/sync$/.test(response.url()),
      ),
      page.clock.runFor(5000),
    ]);
    await page.waitForTimeout(250);
  }
  expect(reads).toHaveLength(2);
  await w.getByRole("button", { name: "설정 안내 닫기" }).click();
  await expect(w).toHaveCount(0);
  await expect(page.getByLabel("동기화 상태", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "외부 동기화 설정", exact: true }),
  ).toBeVisible();
});

test("외부 사이트의 팀장에게는 시스템 관리자용 설정 안내 진입점을 표시하지 않는다", async ({
  page,
}) => {
  const boot = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...boot,
        site: "external",
        authMode: "access",
        accountLinking: true,
        user: {
          ...boot.user,
          systemRole: "user",
          teamRoles: { [teamId]: "lead" },
        },
      },
    }),
  );
  await page.reload();
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "설정팀 외부 동기화", exact: true }),
  ).toContainText("연결 설정");
  await expect(
    page.getByRole("button", { name: "외부 동기화 설정", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("GitHub 연동을 통해 외부에서 동기화 운영이 가능합니다."),
  ).toHaveCount(0);
});

test("연결 해제한 팀은 연결 기록을 초기화한 뒤 저장소를 바꿀 수 있다", async ({
  page,
}) => {
  app.locals.sync.profiles.push({
    profileId: "existing",
    teamId,
    repository: "https://github.com/example/old-data",
    peerInstallationId: randomUUID(),
  });
  await post(
    page,
    `/admin/teams/${teamId}/connection`,
    { profileId: "existing", expectedRevision: 0 },
    "PUT",
  );
  db.prepare(
    "UPDATE team_sync_links SET mode='disconnected' WHERE team_id=?",
  ).run(teamId);
  await page.reload();
  await page
    .getByRole("combobox", { name: "팀 선택", exact: true })
    .selectOption(teamId);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  const reset = page.getByRole("button", {
    name: "연결 기록 초기화",
    exact: true,
  });
  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    return dialog.dismiss();
  });
  await reset.click();
  expect(confirmation).toMatch(/GitHub 토큰도 함께 지웁니다/);
  expect(
    db.prepare("SELECT 1 FROM team_sync_links WHERE team_id=?").get(teamId),
  ).toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept());
  await reset.click();
  await expect(
    page.getByText(/연결 기록과 토큰을 초기화했습니다/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이 팀에 연결", exact: true }),
  ).toBeVisible();
  expect(
    db.prepare("SELECT 1 FROM team_sync_links WHERE team_id=?").get(teamId),
  ).toBeUndefined();
  await page
    .getByRole("button", { name: "외부 동기화 설정", exact: true })
    .click();
  const w = wizard(page);
  await expect(
    w.getByLabel("GitHub 데이터 저장소", { exact: true }),
  ).toHaveValue("https://github.com/example/old-data");
  await expect(
    w.getByRole("button", { name: "저장소·토큰 저장", exact: true }),
  ).toBeEnabled();
});
