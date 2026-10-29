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

test("내부 프로필 생성·재시도 후 외부 서비스 설정으로 이동하고 재진입한다", async ({
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
    "1. 내부 프로필 생성",
  );
  await expect(
    w.getByText("아직 생성되지 않음", { exact: true }),
  ).toBeVisible();
  await expect(
    phases.getByRole("button", { name: /^2\. 외부 서비스 설정/ }),
  ).toBeDisabled();
  await w
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
  await expect(w.getByText(/GitHub 저장소 주소를/)).toBeVisible();
  await w
    .getByLabel("GitHub 데이터 저장소", { exact: true })
    .fill("https://github.com/example/team-data");
  await w.getByRole("checkbox").check();
  await w
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
  await expect(w.getByText(/프로필을 먼저 생성하세요/)).toBeVisible();
  await page.route(
    `**/api/admin/teams/${teamId}/sync-setup`,
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: "프로필 생성 요청을 저장하지 못했습니다. 다시 시도하세요.",
        },
      }),
    { times: 1 },
  );
  await w
    .getByRole("button", { name: "내부 프로필 생성", exact: true })
    .click();
  await expect(
    w.getByText(/프로필 생성 요청을 저장하지 못했습니다/),
  ).toBeVisible();
  expect(existsSync(join(directory, ".env"))).toBe(false);
  await expect(
    w.getByText("아직 생성되지 않음", { exact: true }),
  ).toBeVisible();
  await expect(w.getByLabel("프로필 ID", { exact: true })).toHaveCount(0);
  await w
    .getByRole("button", { name: "내부 프로필 생성", exact: true })
    .click();
  // The server already carries an installation identity, so the profile
  // applies on save without a restart.
  await expect(page.getByText(/서버에 바로 적용되었습니다/)).toBeVisible();
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
  await w
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
  await expect(phases.locator('[aria-current="true"]')).toContainText(
    "2. 외부 서비스 설정",
  );
  await expect(
    w.getByRole("heading", { name: "Cloudflare", exact: true }),
  ).toBeFocused();
  await w
    .getByRole("button", { name: "내부 프로필 생성으로", exact: true })
    .click();
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await phases.getByRole("button", { name: /^2\. 외부 서비스 설정/ }).click();
  await expect(
    w.getByRole("heading", { name: "Cloudflare", exact: true }),
  ).toBeFocused();
  await w.getByLabel("외부 접속 주소").fill("https://team.pages.dev");
  await w
    .getByLabel("Access 발급자")
    .fill("https://company.cloudflareaccess.com");
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
  await expect(
    w.getByLabel("외부 DB 초기화 명령", { exact: true }),
  ).toHaveValue(new RegExp(teamId));
  await w.getByRole("checkbox").check();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await w
    .getByLabel("gateway 자원 주소")
    .fill("https://team-gateway.company.workers.dev");
  await expect(w.getByLabel("SYNC_PROFILES", { exact: true })).toHaveValue(
    new RegExp(teamId),
  );
  await expect(w.getByLabel("INSTALLATION_ID", { exact: true })).toHaveValue(
    profile.peerInstallationId,
  );
  await expect(
    w.getByLabel("PEER_INSTALLATION_ID", { exact: true }),
  ).toHaveValue(env.GRAEBOARD_INSTALLATION_ID);
  await expect(w.locator('[aria-current="step"]')).toHaveText("3. 배포");
  await expect(
    w.getByRole("button", { name: "3. 배포", exact: true }),
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
  // The applied profile needs no restart confirmation here.
  await expect(
    w.getByRole("button", { name: "서버 적용 확인", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "토큰 저장", exact: true }),
  ).toBeDisabled();
  await w.getByRole("button", { name: "다음", exact: true }).click();
  await expect(w.getByText(/초기 게시를 완료한 뒤/)).toBeVisible();
  await w.getByLabel("내부 GitHub 토큰", { exact: true }).fill("fixture_token");
  await expect(
    w.getByRole("button", { name: "토큰 저장", exact: true }),
  ).toBeEnabled();
  await expect(
    w.getByRole("button", { name: "이 팀에 연결", exact: true }),
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
    w.getByRole("button", { name: "외부 서비스 설정으로", exact: true }),
  ).toBeDisabled();
  await w.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(
    w.getByRole("button", { name: "외부 서비스 설정으로", exact: true }),
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
  await other
    .getByRole("button", { name: "외부 서비스 설정으로", exact: true })
    .click();
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
  await page.reload();
  await open(page);
  const w = wizard(page);
  await expect(
    w.getByRole("heading", { name: "팀 연결", exact: true }),
  ).toBeVisible();
  await expect(
    w.getByRole("button", { name: "일시정지", exact: true }),
  ).toBeVisible();
  await w.getByRole("button", { name: "다음", exact: true }).click();
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
  const phases = w.getByRole("list", { name: "설정 과정", exact: true });
  await phases.getByRole("button", { name: /^1\. 내부 프로필 생성/ }).click();
  await expect(w.getByLabel("프로필 ID", { exact: true })).toHaveCount(0);
  await expect(
    w.getByRole("button", { name: "내부 프로필 생성", exact: true }),
  ).toHaveCount(0);
  await expect(
    w.getByRole("definition").filter({ hasText: "서버 적용됨" }),
  ).toBeVisible();
  await phases.getByRole("button", { name: /^2\. 외부 서비스 설정/ }).click();
  await w
    .getByLabel("내부 GitHub 토큰", { exact: true })
    .fill("fixture_private_token");
  db.prepare(
    "UPDATE team_sync_links SET lease_owner='busy' WHERE team_id=?",
  ).run(teamId);
  await w.getByRole("button", { name: "토큰 저장", exact: true }).click();
  await expect(w.getByText(/작업이 끝난 뒤 토큰 저장/)).toBeVisible();
  await expect(w.getByLabel("내부 GitHub 토큰", { exact: true })).toHaveValue(
    "fixture_private_token",
  );
  db.prepare("UPDATE team_sync_links SET lease_owner=NULL WHERE team_id=?").run(
    teamId,
  );
  const link = { ...app.locals.sync.store(teamId).readLink() };
  await w.getByRole("button", { name: "토큰 저장", exact: true }).click();
  await expect(w.getByLabel("내부 GitHub 토큰", { exact: true })).toHaveValue(
    "",
  );
  await expect(w.getByText(/암호화된 토큰이 등록/)).toBeVisible();
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
  await w
    .getByRole("button", { name: "내부 프로필 생성", exact: true })
    .click();
  await expect(
    w.getByText(/시스템 관리자에게 Node 서비스 재시작을 요청하세요/),
  ).toBeVisible();
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
    .getByRole("button", { name: "내부 프로필 생성", exact: true })
    .click();
  await expect(page.getByText(/서버에 바로 적용되었습니다/)).toBeVisible();
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
