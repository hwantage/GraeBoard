import { test, expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../../server/sync/git-cli.mjs";
import { createApp } from "../../server/app.mjs";
import { openDatabase } from "../../server/db.mjs";
import { unpack } from "../../shared/compact.js";

let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string, teamId: string, otherTeamId: string, temporary: string;
let transports: Record<string, GitCliTransport>;
const panel = (page: Page) =>
  page.getByRole("dialog", { name: "설정", exact: true });
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`${base}/api${path}`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
test.beforeEach(async ({ page }) => {
  temporary = mkdtempSync(join(tmpdir(), "graeboard-sync-ui-"));
  db = openDatabase(join(temporary, "app.sqlite"));
  transports = {};
  app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(temporary, "images"),
    syncOptions: {
      installationId: randomUUID(),
      profiles: [],
      transports,
      schedule: false,
    },
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { user } = await post(page, "/auth/setup", {
    username: "sync-ui@example.com",
    password: "local-sync-test-password",
    name: "동기화 관리자",
    teamName: "동기화 검증팀",
  });
  teamId = user.teamIds[0];
  otherTeamId = (await post(page, "/admin/teams", { name: "다른 동기화팀" }))
    .id;
  await page.goto(base);
  await page.getByLabel("팀 선택").selectOption(teamId);
  await page.getByRole("button", { name: "설정", exact: true }).click();
});

test("설정에서 실제 Git 초기 게시·일시정지·재개와 연도 정리·복원을 끝까지 실행한다", async ({
  page,
}) => {
  const remote = join(temporary, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  transports.local = new GitCliTransport({
    directory: join(temporary, "local.git"),
    repository: remote,
    allowLocal: true,
  });
  app.locals.sync.profiles.push({
    profileId: "local",
    name: "로컬 검증 프로필",
    teamId,
    repository: "test/local",
  });
  const memoId = randomUUID();
  await post(page, `/teams/${teamId}/years/2025/memos`, {
    id: memoId,
    title: "보관할 연도 메모",
  });
  const settings = panel(page);
  await settings.getByRole("tab", { name: "동기화", exact: true }).click();
  await settings.getByLabel("연결 프로필").selectOption("local");
  await settings
    .getByRole("button", { name: "연결 저장", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "초기 게시", exact: true }),
  ).toBeDisabled();
  await settings
    .getByRole("button", { name: "연결 검사", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "초기 게시", exact: true }),
  ).toBeEnabled();
  await settings
    .getByRole("button", { name: "초기 게시", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "일시정지", exact: true }),
  ).toBeEnabled();
  const head = await transports.local.readHead();
  expect(head).toBeTruthy();
  await settings.getByRole("button", { name: "일시정지", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "재개", exact: true }),
  ).toBeEnabled();
  await settings.getByRole("button", { name: "재개", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "일시정지", exact: true }),
  ).toBeEnabled();
  await settings
    .getByRole("button", { name: "변경 이력 정리", exact: true })
    .click();
  await settings
    .getByRole("tab", { name: "연도·문서·이미지", exact: true })
    .click();
  await settings.getByLabel("정리할 연도").selectOption("2025");
  await settings
    .getByRole("button", { name: "정리 대상 확인", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "사이트 정리 미리보기" }),
  ).toContainText("문서");
  page.once("dialog", (dialog) => dialog.accept());
  await settings
    .getByRole("button", { name: "이 서버에서 정리", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "정리한 자료 복원" }),
  ).toContainText("2025년");
  const hidden = await page.request.get(
    `${base}/api/teams/${teamId}/years/2025/memos`,
  );
  expect(unpack(await hidden.json()).documents).toEqual([]);
  await settings
    .getByRole("button", { name: "보관본에서 복원", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "정리한 자료 복원" }),
  ).toHaveCount(0);
  const restored = await page.request.get(
    `${base}/api/teams/${teamId}/years/2025/memos`,
  );
  expect(unpack(await restored.json()).documents[0].id).toBe(memoId);
  expect(await transports.local.readHead()).toBe(head);
});
test.afterEach(async () => {
  app.locals.sync?.close?.();
  app.locals.cellEvents.close();
  app.locals.documentEvents?.close?.();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(temporary, { recursive: true, force: true });
});

test("외부 최초 관리자는 Google 계정과 설치 키로 등록하고 팀 없이 서비스 연결을 연다", async ({
  page,
}) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  let registered = false;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: registered ? 200 : 401,
      json: registered
        ? { ...bootstrap, teams: [], authMode: "access", site: "external" }
        : { error: "초기 등록 필요" },
    }),
  );
  await page.route("**/api/setup", (route) =>
    route.fulfill({
      json: {
        needsSetup: true,
        required: true,
        tokenRequired: true,
        authMode: "access",
        email: "admin@example.com",
      },
    }),
  );
  await page.route("**/api/auth/setup", async (route) => {
    const body = unpack(route.request().postDataJSON());
    expect(body).toEqual({
      name: "외부 관리자",
      email: "admin@example.com",
      setupToken: "local-test-setup-token-value",
    });
    registered = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "외부 공간 관리자 등록" }),
  ).toBeVisible();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("팀 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("아이디(이메일)")).toHaveValue(
    "admin@example.com",
  );
  await page.getByLabel("이름", { exact: true }).fill("외부 관리자");
  await page.getByLabel("초기 설정 키").fill("local-test-setup-token-value");
  await page.getByRole("button", { name: "관리자 등록", exact: true }).click();
  await expect(
    page.getByText("참여한 팀이 없습니다", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    panel(page).getByRole("region", { name: "서비스 연결" }),
  ).toBeVisible();
});

// The PG migration is exercised separately by Worker integration tests; this
// test controls interrupted responses to verify the browser's durable resume UI.
test("외부 연결 이관 실패 후 기존 프로필을 유지하고 저장된 작업을 이어서 실행한다", async ({
  page,
}) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  let active = "old",
    started = false,
    resumed = 0;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: { ...bootstrap, authMode: "access", site: "external" },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill({
      json: {
        mode: "paused",
        profileId: active,
        canonicalHead: "head",
        pending: 0,
        conflicts: 0,
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({ json: { conflicts: [] } }),
  );
  await page.route(`**/api/teams/${teamId}/sync/refresh`, (route) =>
    route.fulfill({ json: { mode: "paused" } }),
  );
  await page.route(`**/api/admin/teams/${teamId}/connection`, (route) =>
    route.fulfill({
      json: {
        profileId: active,
        revision: 7,
        profiles: [
          {
            profileId: "old",
            name: "기존 자원",
            teamId,
            repository: "test/repository",
          },
          {
            profileId: "replacement",
            name: "새 자원",
            teamId,
            repository: "test/repository",
            replaces: "old",
          },
        ],
        switchJob:
          started && active === "old"
            ? { jobId: "switch-job", phase: "copying", hasMore: true }
            : null,
      },
    }),
  );
  await page.route(
    `**/api/admin/teams/${teamId}/connection/switch`,
    async (route) => {
      expect(unpack(route.request().postDataJSON())).toEqual({
        profileId: "replacement",
        expectedRevision: 7,
      });
      expect(started).toBe(false);
      started = true;
      await route.fulfill({
        json: { jobId: "switch-job", phase: "copying", hasMore: true },
      });
    },
  );
  await page.route(
    `**/api/admin/teams/${teamId}/connection/switch/switch-job/resume`,
    async (route) => {
      resumed++;
      if (resumed === 1)
        return route.fulfill({
          status: 503,
          json: { error: "연결 확인 후 다시 시도하세요." },
        });
      active = "replacement";
      await route.fulfill({
        json: { jobId: "switch-job", phase: "complete", hasMore: false },
      });
    },
  );
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "동기화", exact: true }).click();
  await settings.getByLabel("연결 프로필").selectOption("replacement");
  await settings
    .getByRole("button", { name: "자료 이관 후 연결 변경", exact: true })
    .click();
  await expect(settings.getByRole("alert")).toContainText(
    "연결 확인 후 다시 시도하세요.",
  );
  await expect(settings.getByLabel("연결 프로필")).toHaveValue("old");
  await settings
    .getByRole("button", { name: "이어서 연결 이관", exact: true })
    .click();
  await expect(settings.getByLabel("연결 프로필")).toHaveValue("replacement");
  await expect(
    settings.getByRole("button", { name: "이어서 연결 이관", exact: true }),
  ).toHaveCount(0);
  expect(resumed).toBe(2);
});

test("미연결 팀은 기존 설정과 함께 동기화 상태·서비스 설치 안내를 조회한다", async ({
  page,
}) => {
  const settings = panel(page);
  await settings.getByRole("tab", { name: "동기화", exact: true }).click();
  await expect(
    settings.getByRole("region", { name: "동기화 검증팀 동기화" }),
  ).toContainText("미연결");
  await expect(
    settings.getByRole("button", { name: "초기 게시", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "연결 검사", exact: true }),
  ).toBeDisabled();
  await settings
    .getByRole("button", { name: "서비스 연결", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "서비스 연결" }),
  ).toContainText("설치된 팀 연결 프로필");
  await expect(
    settings.getByRole("link", { name: "설치 안내" }),
  ).toHaveAttribute("href", /service-connections\/guide/);
  const guide = await page.request.get(
    `${base}/api/admin/service-connections/guide`,
  );
  expect(guide.ok()).toBeTruthy();
  await settings.getByRole("button", { name: "공통 연결 검사" }).click();
  await expect(
    settings.getByRole("table", { name: "연결 검사 결과" }),
  ).toBeVisible();
});

test("팀장은 자기 팀 연결을 설정하며 공통 자원과 다른 팀은 볼 수 없다", async ({
  page,
}) => {
  await post(page, "/admin/users", {
    username: "sync-lead@example.com",
    password: "local-sync-test-password",
    name: "동기화 팀장",
    memberships: [{ teamId, role: "lead" }],
  });
  await post(page, "/auth/logout", {});
  await post(page, "/auth/login", {
    username: "sync-lead@example.com",
    password: "local-sync-test-password",
  });
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "동기화", exact: true }).click();
  await expect(
    settings.getByRole("region", { name: "동기화 검증팀 동기화" }),
  ).toContainText("미연결");
  await expect(settings.getByLabel("연결 프로필", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    settings.getByRole("button", { name: "서비스 연결", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "변경 이력 정리", exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`${base}/api/admin/service-connections`)).status(),
  ).toBe(403);
  expect(
    (
      await page.request.get(`${base}/api/admin/teams/${teamId}/connection`)
    ).status(),
  ).toBe(200);
  expect(
    (await page.request.get(`${base}/api/teams/${otherTeamId}/sync`)).status(),
  ).toBe(403);
});

// These route fixtures exercise client status semantics; transport/reducer tests exercise real propagation.
test("Git 게시와 검증되지 않은 상대 상태를 실제 내부 반영으로 표시하지 않는다", async ({
  page,
}) => {
  await page.route(`${base}/api/teams/${teamId}/sync`, async (route) => {
    await route.fulfill({
      json: {
        mode: "active",
        siteName: "외부 검증 서버",
        profileId: "test-profile",
        pending: 2,
        conflicts: 0,
        lastLocalSavedAt: "2026-10-27T00:00:00Z",
        lastPublishedAt: "2026-10-27T00:01:00Z",
        remoteStatus: {
          mode: "recovery",
          observedAt: "2026-10-26T01:00:00Z",
          appliedCanonicalHead: "old",
          verified: false,
        },
      },
    });
  });
  await page.route(`${base}/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({ json: { conflicts: [] } }),
  );
  await panel(page).getByRole("tab", { name: "동기화", exact: true }).click();
  const status = panel(page).getByLabel("동기화 상태", { exact: true });
  await expect(status).toContainText("로컬 저장");
  await expect(status).toContainText("Git 반영");
  await expect(status).toContainText("공유 대기 2건");
  await expect(status).toContainText("현재 확인 불가");
  await expect(status).not.toContainText("반영 완료");
});

test("사이트 정리 미리보기는 팀 전환 때 폐기하고 늦은 이전 응답을 표시하지 않는다", async ({
  page,
}) => {
  const settings = panel(page);
  await page.route(`${base}/api/admin/teams/*/maintenance`, (route) =>
    route.fulfill({
      json: {
        siteId: "site-a",
        siteName: "현재 검증 서버",
        years: [2025, 2026],
        documents: [],
        retention: [],
        job: null,
      },
    }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(
    `${base}/api/admin/teams/*/maintenance/preview`,
    async (route) => {
      const firstTeam = route.request().url().includes(teamId);
      if (firstTeam) {
        reached();
        await held;
      }
      await route.fulfill({
        json: {
          token: firstTeam ? "old-token" : "new-token",
          revision: 1,
          siteName: "현재 검증 서버",
          teamName: firstTeam ? "동기화 검증팀" : "다른 동기화팀",
          items: [{ label: "연도", count: 1 }],
          images: { count: 0, bytes: 0 },
          protected: [],
        },
      });
    },
  );
  await settings
    .getByRole("button", { name: "변경 이력 정리", exact: true })
    .click();
  await settings
    .getByRole("tab", { name: "연도·문서·이미지", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "정리 대상 확인", exact: true })
    .click();
  await requested;
  await settings
    .getByLabel("정리할 팀", { exact: true })
    .selectOption(otherTeamId);
  await settings
    .getByRole("button", { name: "정리 대상 확인", exact: true })
    .click();
  const preview = settings.getByRole("region", {
    name: "사이트 정리 미리보기",
  });
  await expect(preview).toContainText("다른 동기화팀");
  release();
  await expect(preview).not.toContainText("동기화 검증팀");
  await settings
    .getByLabel("정리할 연도", { exact: true })
    .selectOption("2026");
  await expect(preview).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "이 서버에서 정리", exact: true }),
  ).toHaveCount(0);
});

test("팀 사이트에서 사내 계정을 선택하고 승인 대기 후 접속한다", async ({
  page,
}, info) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  let selected = false,
    status = "unlinked";
  const accounts = () => ({
    required: false,
    tokenRequired: false,
    authMode: "access",
    accountLinking: true,
    email: "personal@gmail.test",
    accounts: [
      {
        id: bootstrap.user.id,
        name: "사내 계정",
        username: "internal@example.test",
        role: "member",
        status,
      },
    ],
  });
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: selected ? 200 : 401,
      json: selected
        ? { ...bootstrap, authMode: "access", accountLinking: true }
        : { error: "계정 선택 필요" },
    }),
  );
  await page.route("**/api/setup", (route) =>
    route.fulfill({ json: accounts() }),
  );
  await page.route("**/api/auth/accounts", (route) =>
    route.fulfill({ json: accounts() }),
  );
  await page.route("**/api/auth/link-request", async (route) => {
    expect(unpack(route.request().postDataJSON())).toEqual({
      userId: bootstrap.user.id,
    });
    status = "pending";
    await route.fulfill({ json: { status } });
  });
  await page.route("**/api/auth/select-account", async (route) => {
    expect(status).toBe("approved");
    expect(unpack(route.request().postDataJSON())).toEqual({
      userId: bootstrap.user.id,
    });
    selected = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await expect(page.getByLabel("Google 계정", { exact: true })).toHaveValue(
    "personal@gmail.test",
  );
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("연결할 사내 계정", { exact: true })
    .selectOption(bootstrap.user.id);
  await page
    .getByRole("button", { name: "연결 승인 요청", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "팀장의 연결 승인을 기다리고 있습니다.",
  );
  await expect(
    page.getByRole("button", { name: "연결 승인 요청", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("account-pending.png"),
    fullPage: true,
  });
  status = "approved";
  await page
    .getByRole("button", { name: "선택한 계정으로 접속", exact: true })
    .click({ timeout: 10000 });
  await expect(page.getByLabel("팀 선택")).toBeVisible();
});

test("외부 팀장은 연결 신청을 승인하고 구성원 정보는 읽기만 한다", async ({
  page,
}, info) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  let state = "pending";
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: { ...bootstrap, authMode: "access", accountLinking: true },
    }),
  );
  await page.route(`**/api/teams/${teamId}/access-requests`, (route) =>
    route.fulfill({
      json: {
        requests: [
          {
            id: "request-1",
            userId: bootstrap.user.id,
            email: "member@gmail.test",
            name: "연결할 사내 계정",
            username: "internal@example.test",
            status: state,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/teams/${teamId}/access-requests/request-1/approve`,
    async (route) => {
      state = "approved";
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "구성원", exact: true }).click();
  const section = settings.getByRole("region", {
    name: "Google 계정 연결",
    exact: true,
  });
  await expect(section).toContainText("member@gmail.test");
  await expect(
    settings.getByRole("button", { name: "구성원 추가", exact: true }),
  ).toHaveCount(0);
  await section.getByRole("button", { name: "승인", exact: true }).click();
  await expect(section).toContainText("연결됨");
  await expect(
    section.getByRole("button", { name: "연결 해제", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("account-approved.png"),
    fullPage: true,
  });
});

test("팀 사이트 최초 팀장은 사내 계정과 설정 키로 연결한다", async ({
  page,
}) => {
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  let connected = false;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: connected ? 200 : 401,
      json: connected
        ? { ...bootstrap, authMode: "access", accountLinking: true }
        : { error: "최초 연결 필요" },
    }),
  );
  await page.route("**/api/setup", (route) =>
    route.fulfill({
      json: {
        required: true,
        tokenRequired: true,
        authMode: "access",
        accountLinking: true,
        email: "lead@gmail.test",
        accounts: [
          {
            id: bootstrap.user.id,
            name: "사내 팀장",
            username: "lead@internal.test",
            role: "lead",
            status: "unlinked",
          },
        ],
      },
    }),
  );
  await page.route("**/api/auth/setup", async (route) => {
    expect(unpack(route.request().postDataJSON())).toEqual({
      userId: bootstrap.user.id,
      setupToken: "installation-test-key",
    });
    connected = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "팀장 계정 연결", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("연결할 사내 팀장 계정", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "팀장 계정 연결", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("연결할 사내 팀장 계정", { exact: true })
    .selectOption(bootstrap.user.id);
  await page
    .getByLabel("초기 설정 키", { exact: true })
    .fill("installation-test-key");
  await page
    .getByRole("button", { name: "팀장 계정 연결", exact: true })
    .click();
  await expect(page.getByLabel("팀 선택")).toBeVisible();
});
