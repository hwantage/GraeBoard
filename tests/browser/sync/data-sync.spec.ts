import {
  test,
  expect,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";
import { createApp } from "../../../server/app.mjs";
import { openDatabase } from "../../../server/db.mjs";
import { unpack } from "../../../shared/formatting/compact.js";

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
async function configuredBootstrap(page: Page) {
  const configured = (data: any) => ({
    ...data,
    teams: data.teams.map((team: any) =>
      team.id === teamId
        ? { ...team, sync: { available: true, configured: true } }
        : team,
    ),
  });
  const admin = unpack(
    await (await page.request.get(`${base}/api/admin/users`)).json(),
  );
  await page.route("**/api/admin/users", (route) =>
    route.fulfill({ json: configured(admin) }),
  );
  return configured(
    unpack(await (await page.request.get(`${base}/api/bootstrap`)).json()),
  );
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
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const memoId = randomUUID();
  await post(page, `/teams/${teamId}/years/2025/memos`, {
    id: memoId,
    title: "보관할 연도 메모",
  });
  const settings = panel(page);
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("로컬 검증 프로필");
  await expect(
    settings.getByRole("combobox", { name: "연결 프로필", exact: true }),
  ).toHaveCount(0);
  const oldBootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  expect(
    oldBootstrap.teams.find((team: any) => team.id === teamId).sync.configured,
  ).toBe(false);
  let heldRequest!: Request;
  let captured!: () => void;
  let releaseOld!: () => void;
  let releaseFollowing!: () => void;
  let blockFollowing = false;
  let followingActive = 0;
  const capturedFocus = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const followingGate = new Promise<void>((resolve) => {
    releaseFollowing = resolve;
  });
  const bootstrapWork = async (route: Route) => {
    if (!heldRequest) {
      heldRequest = route.request();
      captured();
      await oldGate;
      await route.fulfill({ json: oldBootstrap });
      return;
    }
    if (blockFollowing) await followingGate;
    followingActive++;
    try {
      await route.fulfill({ response: await route.fetch() });
    } finally {
      followingActive--;
    }
  };
  const activeRoutes = new Set<Promise<void>>();
  const bootstrapRoute = (route: Route) => {
    const work = bootstrapWork(route);
    activeRoutes.add(work);
    return work.finally(() => activeRoutes.delete(work));
  };
  await page.route("**/api/bootstrap", bootstrapRoute);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await capturedFocus;
    const configuredBootstrapResponse = page.waitForResponse(
      async (response) =>
        response.url() === `${base}/api/bootstrap` &&
        response.request() !== heldRequest &&
        response.ok() &&
        unpack(await response.json()).teams.some(
          (team: any) => team.id === teamId && team.sync?.configured,
        ),
    );
    await settings
      .getByRole("button", { name: "이 팀에 연결", exact: true })
      .click();
    await configuredBootstrapResponse;
    await expect(
      settings.getByRole("button", { name: "초기 게시", exact: true }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("button", { name: "연결 검사", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => followingActive).toBe(0);
    blockFollowing = true;
    const indicator = page.getByRole("status", {
      name: "팀 동기화 상태",
      exact: true,
    });
    await expect(indicator).toHaveText("동기화 일시정지");
    const lateResponse = page.waitForResponse(
      (response) => response.request() === heldRequest,
    );
    releaseOld();
    await (await lateResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    // App only mounts this indicator for a configured team. A late pre-save
    // bootstrap must not remove it, even while its status response is retained.
    await expect(indicator).toHaveText("동기화 일시정지");
  } finally {
    releaseOld();
    releaseFollowing();
    await Promise.allSettled([...activeRoutes]);
    await page.unroute("**/api/bootstrap", bootstrapRoute);
  }
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
  // The result stays under the buttons and names what reached Git.
  await expect(
    settings.getByRole("status").filter({
      hasText: /^초기 게시를 완료했습니다\. Git 반영 .+ · 공유 대기 \d+건$/,
    }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "팀장 연결 키 발급", exact: true })
    .click();
  const keyInput = settings.getByLabel("발급된 연결 키");
  await expect(keyInput).toHaveValue(/^gbk_/);
  const firstKey = await keyInput.inputValue();
  await settings
    .getByRole("button", { name: "연결 키 재발급", exact: true })
    .click();
  await expect(keyInput).not.toHaveValue(firstKey);
  await settings.getByRole("button", { name: "키 폐기", exact: true }).click();
  await expect(keyInput).toHaveCount(0);
  await expect(
    settings.getByRole("region", { name: "팀장 연결 키", exact: true }),
  ).toContainText("폐기됨");
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
  await settings
    .locator(".settings-nav")
    .getByRole("button", { name: "동기화 검증팀" })
    .click();
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await settings
    .getByRole("button", { name: "연결 해제", exact: true })
    .click();
  await expect(settings.getByRole("note")).toContainText(
    "동기화 연결이 해제되어 있습니다.",
  );
  await expect(
    settings.getByRole("button", { name: "이 팀에 연결", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "재개", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("로컬 검증 프로필");
  await expect(
    settings.getByRole("combobox", { name: "연결 프로필", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "연결 검사", exact: true })
    .click();
  await expect(
    settings.getByRole("table", { name: "연결 검사 결과" }),
  ).toContainText("정상");
  expect(app.locals.sync.store(teamId).readLink().mode).toBe("disconnected");
  const offlineMemo = randomUUID();
  await post(page, `/teams/${teamId}/years/2026/memos`, {
    id: offlineMemo,
    title: "연결 해제 중 작성한 메모",
  });
  await settings
    .getByRole("button", { name: "다시 연결", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "일시정지", exact: true }),
  ).toBeEnabled();
  await expect(settings.getByRole("note")).toHaveCount(0);
  await settings
    .getByRole("button", { name: "지금 동기화", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "지금 동기화", exact: true }),
  ).toBeEnabled();
  await expect(
    settings.getByRole("status").filter({
      hasText: /^동기화를 완료했습니다\. Git 반영 .+ · 공유 대기 \d+건$/,
    }),
  ).toBeVisible();
  // A run that met another run's lease did nothing; it must not read as done.
  await page.route(`**/api/teams/${teamId}/sync/run`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), busy: true },
    });
  });
  await settings
    .getByRole("button", { name: "지금 동기화", exact: true })
    .click();
  await expect(
    settings.getByRole("status").filter({
      hasText:
        /^다른 동기화 실행이 아직 끝나지 않아 이번 요청은 처리하지 않았습니다\. 잠시 후 다시 누르세요\. Git 반영 .+ · 공유 대기 \d+건$/,
    }),
  ).toBeVisible();
  await page.unroute(`**/api/teams/${teamId}/sync/run`);
  const shared = app.locals.sync.store(teamId).readState();
  expect(
    Object.values(shared.entities).some(
      (record: any) =>
        record.entity === "document" &&
        record.key.at(-1) === offlineMemo &&
        record.payload.title === "연결 해제 중 작성한 메모",
    ),
  ).toBeTruthy();
  expect(app.locals.sync.store(teamId).readPending()).toHaveLength(0);
});
test.afterEach(async () => {
  await app.locals.sync?.close?.();
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
    panel(page).getByRole("region", { name: "외부 동기화" }),
  ).toBeVisible();
});

// The PG migration is exercised separately by Worker integration tests; this
// test controls interrupted responses to verify the browser's durable resume UI.
test("초기 게시 오류는 실행 버튼 아래에 붉게 표시하고 성공 재시도 후 지운다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 640 });
  const bootstrap = await configuredBootstrap(page);
  let failed = false,
    attempts = 0,
    initialized = false;
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: bootstrap }),
  );
  await page.route(`**/api/admin/teams/${teamId}/connection`, (route) =>
    route.fulfill({
      json: {
        profileId: "local",
        revision: 1,
        profiles: [
          {
            profileId: "local",
            teamId,
            name: "동기화 연결",
            repository: "test/local",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill({
      json: {
        mode: initialized ? "active" : failed ? "initializing" : "paused",
        profileId: "local",
        pending: initialized ? 0 : 2,
        conflicts: 0,
        canonicalHead: initialized ? "published" : null,
        lastError: failed ? "Snapshot exceeds uncompressed byte budget" : null,
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({ json: { conflicts: [] } }),
  );
  await page.route(`**/api/teams/${teamId}/sync/check`, (route) =>
    route.fulfill({ json: { ready: true, checks: [] } }),
  );
  await page.route(`**/api/teams/${teamId}/sync/enable`, (route) => {
    attempts++;
    failed = attempts === 1;
    initialized = !failed;
    return route.fulfill(
      failed
        ? {
            status: 500,
            json: { error: "Snapshot exceeds uncompressed byte budget" },
          }
        : { json: {} },
    );
  });
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await settings
    .getByRole("button", { name: "연결 검사", exact: true })
    .click();
  const action = settings.getByRole("button", {
    name: "초기 게시",
    exact: true,
  });
  await action.click();
  const alert = settings
    .locator(".team-sync-actions-section")
    .getByRole("alert");
  await expect(alert).toContainText("초기 게시 실패");
  await expect(alert).toContainText("스냅샷 용량 한도");
  await expect(alert).toContainText("기존 자료와 미전송 변경은 보존");
  await expect(alert).toBeInViewport({ ratio: 1 });
  await expect(settings.getByRole("alert")).toHaveCount(1);
  await expect(
    settings.locator(".team-sync-overview").getByRole("alert"),
  ).toHaveCount(0);
  await expect(alert).toHaveCSS("color", "rgb(137, 60, 82)");
  await expect(alert).toHaveCSS("background-color", "rgb(255, 242, 245)");
  await expect(settings.locator(".team-sync-mode")).toHaveText(
    "초기 게시 실패",
  );
  const buttonBounds = await action.boundingBox(),
    errorBounds = await alert.boundingBox();
  expect(errorBounds!.y).toBeGreaterThanOrEqual(
    buttonBounds!.y + buttonBounds!.height,
  );
  expect(errorBounds!.y - buttonBounds!.y - buttonBounds!.height).toBeLessThan(
    40,
  );
  await page.screenshot({ path: testInfo.outputPath("sync-error.png") });

  // Opening this tab again must place the persisted old English diagnostic at
  // the same action area, without creating a second alert in the status card.
  await settings.getByRole("tab", { name: "일반", exact: true }).click();
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(alert).toContainText("스냅샷 용량 한도");
  await expect(settings.getByRole("alert")).toHaveCount(1);
  await settings
    .getByRole("button", { name: "연결 검사", exact: true })
    .click();
  await action.click();
  await expect(
    settings.getByRole("button", { name: "지금 동기화", exact: true }),
  ).toBeEnabled();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);

  // A committed action followed by a failed status refresh must not be labelled
  // as a failed publication, which would encourage an unnecessary repeat.
  let failRefresh = false,
    runs = 0;
  await page.route(`**/api/teams/${teamId}/sync/run`, (route) => {
    failRefresh = ++runs === 1;
    return route.fulfill({ json: {} });
  });
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill(
      failRefresh
        ? {
            status: 503,
            json: { error: "상태 조회 서버가 응답하지 않습니다." },
          }
        : {
            json: {
              mode: "active",
              profileId: "local",
              canonicalHead: "published",
              pending: 0,
              conflicts: 0,
            },
          },
    ),
  );
  const run = settings.getByRole("button", {
    name: "지금 동기화",
    exact: true,
  });
  await run.click();
  await expect(alert).toContainText("동기화 실행 후 상태 조회 실패");
  await expect(alert).not.toContainText("동기화 실행 실패");
  await expect(run).toBeEnabled();
  failRefresh = false;
  await run.click();
  await expect(settings.getByRole("alert")).toHaveCount(0);
});

test("충돌 보관함은 먼저 수정과 나중에 수정을 줄 단위로 비교해 보여 준다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 900 });
  const bootstrap = await configuredBootstrap(page);
  const body = Array.from({ length: 24 }, (_, i) => `* 회의 메모 ${i + 1}`);
  const theirs = [...body],
    mine = [...body];
  theirs[2] = "* 회의 메모 3 (외부에서 수정)";
  mine[2] = "* 회의 메모 3 (사내에서 수정)";
  const document = (lines: string[]) => ({
    markdown: lines.join("\n"),
    position: 0,
    title: "문서 1",
  });
  const key = ["calendar", "entry-1", "main"];
  const conflict = {
    conflictId: "conflict-1",
    opId: "conflict-1",
    createdAt: "2026-11-04T00:14:00.000Z",
    target: "document " + key.join("/"),
    result: "Concurrent field change",
    base: [document(body)],
    current: {
      [JSON.stringify(["document", key])]: {
        entity: "document",
        key,
        generation: "g".repeat(64),
        version: "v".repeat(64),
        deleted: false,
        payload: document(theirs),
      },
    },
    desired: [document(mine)],
    expectedHead: "head-1",
    frontier: ["conflict-1"],
    resolved: false,
    origin: {
      held: {
        site: "internal",
        actor: "김바다",
        createdAt: "2026-11-03T23:29:04.995Z",
      },
      writers: {
        [JSON.stringify(["document", key])]: {
          site: "external",
          actor: null,
          createdAt: null,
        },
      },
    },
  };
  // Shaped like the 2026-11-04 production conflict: one command with a rule
  // and many cells, of which only two were also changed on the other side.
  const cellKeys = Array.from({ length: 40 }, (_, i) => [`task-${i}`, "score"]);
  const cell = (backgroundColor: string, textAlign?: string) => ({
    value: "1",
    style: textAlign ? { backgroundColor, textAlign } : { backgroundColor },
  });
  const large = {
    ...conflict,
    conflictId: "conflict-2",
    opId: "conflict-2",
    target: [
      "formats ",
      ...cellKeys.map((cellKey) => "cell " + cellKey.join("/")),
    ].join(", "),
    base: [{ rules: [] }, ...cellKeys.map(() => cell("#d1eee6", "right"))],
    current: Object.fromEntries([
      [
        JSON.stringify(["formats", []]),
        {
          ...conflict.current[JSON.stringify(["document", key])],
          entity: "formats",
          key: [],
          payload: { rules: [] },
        },
      ],
      ...cellKeys.map((cellKey, i) => [
        JSON.stringify(["cell", cellKey]),
        {
          entity: "cell",
          key: cellKey,
          generation: "g".repeat(64),
          version: "v".repeat(64),
          deleted: false,
          payload: cell([7, 31].includes(i) ? "#ffffff" : "#d1eee6", "right"),
        },
      ]),
    ]),
    desired: [
      { rules: [{ id: "rule-1", style: { textAlign: "right" } }] },
      ...cellKeys.map(() => cell("#d1eee6")),
    ],
    frontier: ["conflict-2"],
  };
  const resolutions: unknown[] = [];
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: bootstrap }),
  );
  await page.route(`**/api/admin/teams/${teamId}/connection`, (route) =>
    route.fulfill({
      json: {
        profileId: "local",
        revision: 1,
        profiles: [
          {
            profileId: "local",
            teamId,
            name: "동기화 연결",
            repository: "test/local",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill({
      json: {
        mode: "active",
        profileId: "local",
        pending: 0,
        conflicts: 2,
        canonicalHead: "head-1",
      },
    }),
  );
  // After a resolution the server lists it as saved until the next sync.
  const saved = () =>
    resolutions.length
      ? {
          ...conflict,
          pendingResolution: {
            opId: "resolution-1",
            createdAt: "2026-11-04T01:00:00.000Z",
            choice: "submitted",
          },
        }
      : conflict;
  await page.route(`**/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({ json: { conflicts: [saved(), large] } }),
  );
  await page.route(
    `**/api/teams/${teamId}/sync/conflicts/conflict-1/resolve`,
    (route) => {
      resolutions.push(route.request().postDataJSON());
      return route.fulfill({ json: { opId: "resolution-1" } });
    },
  );
  await page.reload();
  // Leads open the box from the warning in the top bar as well.
  await page
    .locator(".topbar")
    .getByRole("button", { name: "충돌 보관함" })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "충돌 보관함" })
      .locator(".team-sync-conflict"),
  ).toHaveCount(2);
  await page
    .getByRole("dialog", { name: "충돌 보관함" })
    .getByRole("button", { name: "닫기" })
    .click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  // The settings show the count with a button, not the list itself.
  await expect(settings.locator(".team-sync-conflict")).toHaveCount(0);
  await expect(settings.locator(".team-sync-conflict-count")).toContainText(
    "2건",
  );
  await settings.getByRole("button", { name: "충돌 보관함" }).click();
  const box = page.getByRole("dialog", { name: "충돌 보관함" });
  const [first, second] = [0, 1].map((n) =>
    box.locator(".team-sync-conflict").nth(n),
  );
  // Titles name the kind, the first and the later editor and the time.
  await expect(first.locator(":scope > summary")).toContainText(
    "문서(외부) → (사내) 김바다",
  );
  await expect(first.locator(":scope > summary")).not.toContainText("entry-1");
  const title = first.locator(":scope > summary");
  await title.hover();
  await expect(title).toHaveCSS("background-color", "rgb(241, 245, 244)");
  await title.click();
  const compare = first.getByRole("region", { name: "변경 비교" });
  await expect(compare.locator(".sync-diff-summary")).toHaveText(
    "같은 항목을 두 곳에서 고쳐, 나중에 수정을 반영하지 않고 보관했습니다.",
  );
  // Where each edit came from, also in the comparison and action names.
  // Avatar, name and site, then the time when known.
  await expect(compare.locator(".sync-diff-origin li")).toHaveText([
    "먼저 수정외(외부)",
    /^나중에 수정김김바다 \(사내\)2026\. 11\. 4\./,
  ]);
  await expect(compare.locator(".sync-diff-origin .avatar")).toHaveCount(2);
  await expect(
    compare.getByRole("button", { name: "먼저 수정 (외부)" }),
  ).toBeVisible();
  await expect(
    compare.getByRole("button", { name: "나중에 수정 (사내)" }),
  ).toBeVisible();
  await expect(compare.locator(".sync-diff-fields")).toContainText(
    "먼저 수정(외부)이 바꾼 항목: 본문(markdown)",
  );
  await expect(
    first.getByRole("button", {
      name: "먼저 수정으로 유지",
    }),
  ).toBeVisible();
  await expect(
    compare.getByRole("button", { name: "덮어쓰면 바뀌는 부분" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(compare.locator(".sync-diff-fields")).toContainText(
    "두 수정이 함께 바꾼 항목: 본문(markdown)",
  );
  const removed = compare.locator(".sync-diff-line.is-removed"),
    added = compare.locator(".sync-diff-line.is-added");
  await expect(removed).toHaveCount(1);
  await expect(removed).toContainText("회의 메모 3 (외부에서 수정)");
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("회의 메모 3 (사내에서 수정)");
  await expect(added.locator("mark")).toHaveText("사내");
  await expect(added).toHaveCSS("background-color", "rgb(231, 246, 236)");
  // The unchanged rest of the body is folded and expands on request.
  await expect(compare.locator(".sync-diff-line")).toHaveCount(8);
  await compare.getByRole("button", { name: /20줄 같음/ }).click();
  await expect(compare.locator(".sync-diff-line")).toHaveCount(28);
  await page.screenshot({ path: testInfo.outputPath("conflict-diff.png") });

  await compare.getByRole("button", { name: "먼저 수정 (외부)" }).click();
  await expect(removed).toContainText("* 회의 메모 3");
  await expect(added).toContainText("회의 메모 3 (외부에서 수정)");
  await expect(compare.getByRole("button", { name: /줄 같음/ })).toBeVisible();

  // A large command shows the two contested cells first and draws the rest
  // only when asked.
  await second.locator(":scope > summary").click();
  await expect(second.locator(":scope > summary")).toContainText(
    "공통 서식, 셀 40개",
  );
  const largeCompare = second.getByRole("region", { name: "변경 비교" });
  await expect(largeCompare.locator(".sync-diff-summary")).toContainText(
    "나중에 수정 41개 항목 중 먼저 수정과 겹친 항목은 2개입니다.",
  );
  await expect(largeCompare.locator(".sync-diff-change")).toHaveCount(2);
  await expect(largeCompare.locator(".sync-diff-change h5")).toHaveText([
    "셀task-7/score",
    "셀task-31/score",
  ]);
  await expect(
    largeCompare.locator(".sync-diff-line.is-removed").first(),
  ).toContainText('backgroundColor: "#ffffff"');
  await largeCompare.getByText("겹치지 않은 항목 39개").click();
  await expect(largeCompare.locator(".sync-diff-change")).toHaveCount(41);
  await second.locator(":scope > summary").click();

  // Raw JSON stays available, folded, for direct editing reference.
  const raw = first.locator(".sync-conflict-raw");
  await expect(raw.getByText("원래 내용")).toBeHidden();
  await raw.getByText("원본 JSON 보기").click();
  await expect(raw.getByText("지금 내용(먼저 수정 반영)")).toBeVisible();

  // Editing can be cancelled; meanwhile only cancel and apply are offered.
  const actions = first.locator(".form-actions button");
  await first.getByRole("button", { name: "직접 고치기" }).click();
  await expect(actions).toHaveText(["편집 취소", "고친 내용 적용"]);
  await first.getByRole("button", { name: "편집 취소" }).click();
  await expect(actions).toHaveText([
    "먼저 수정으로 유지",
    "나중에 수정으로 덮어쓰기",
    "직접 고치기",
  ]);

  await first.getByRole("button", { name: "나중에 수정으로 덮어쓰기" }).click();
  await expect.poll(() => resolutions.length).toBe(1);
  expect(resolutions[0]).toMatchObject({
    choice: "submitted",
    expectedHead: "head-1",
  });
  // A saved resolution shows what was chosen and offers no second choice.
  await expect(first.locator(":scope > summary")).toContainText("해결 저장됨");
  await expect(first.locator(".team-sync-conflict-notice")).toContainText(
    "해결 방법을 저장했습니다: 나중에 수정으로 덮어쓰기",
  );
  await expect(actions).toHaveCount(0);
});

test("외부 충돌 보관함에서 큰 사본을 포함한 겹치지 않은 항목 12개를 펼쳐도 화면이 유지된다", async ({
  page,
}, testInfo) => {
  const bootstrap = await configuredBootstrap(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const documents = Array.from({ length: 11 }, (_, i) => ({
    markdown: `문서 ${i + 1}`,
    title: `문서 ${i + 1}`,
    position: i,
  }));
  const documentKey = ["sheetClone", "clone-1", "task-0", "doc-0"];
  const originalDocument = {
    ...documents[0],
    markdown: Array.from({ length: 1000 }, (_, i) => `기존 메모 ${i + 1}`).join(
      "\n",
    ),
  };
  documents[0] = {
    ...originalDocument,
    markdown:
      originalDocument.markdown +
      "\n" +
      Array.from(
        { length: 300 },
        (_, i) =>
          `추가 메모 ${i + 1} ` + "여러 줄에 걸쳐 표시되는 내용 ".repeat(30),
      ).join("\n"),
  };
  const clone = {
    name: "대형 사본",
    year: 2026,
    data: {
      tasks: Array.from({ length: 900 }, (_, i) => ({
        id: `task-${i}`,
        cells: Object.fromEntries(
          Array.from({ length: 30 }, (_, j) => [
            `week-${j}`,
            {
              value: `task-${i}-week-${j}`,
              style: { backgroundColor: "#abcdef", bold: false },
            },
          ]),
        ),
      })),
    },
  };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: { ...bootstrap, authMode: "access", site: "external" },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill({
      json: {
        mode: "active",
        profileId: "local",
        pending: 0,
        conflicts: 1,
        canonicalHead: "head-1",
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({
      json: {
        conflicts: [
          {
            conflictId: "large-clone",
            opId: "large-clone",
            createdAt: "2026-11-08T00:00:00.000Z",
            target: [
              ...documents.map(
                (_, i) => `document sheetClone/clone-1/task-${i}/doc-${i}`,
              ),
              "sheetClone clone-1",
            ].join(", "),
            result: "Failed dependency",
            base: [originalDocument, ...Array(11).fill(null)],
            current: {
              [JSON.stringify(["document", documentKey])]: {
                entity: "document",
                key: documentKey,
                generation: "g".repeat(64),
                version: "v".repeat(64),
                deleted: false,
                payload: originalDocument,
              },
            },
            desired: [...documents, clone],
            expectedHead: "head-1",
            frontier: ["large-clone"],
            resolved: false,
          },
        ],
      },
    }),
  );
  await page.reload();
  await page
    .locator(".topbar")
    .getByRole("button", { name: "충돌 보관함" })
    .click();
  const box = page.getByRole("dialog", { name: "충돌 보관함" });
  await box.locator(".team-sync-conflict > summary").click();
  await box.getByText("겹치지 않은 항목 12개", { exact: true }).click();
  await expect(box.locator(".sync-diff-change")).toHaveCount(12);
  expect(errors).toEqual([]);
  // Measure wrapped rows at both ends before unfolding. Their cached heights
  // must stay with those rows when the unchanged lines shift their indices.
  const documentTable = box
    .locator(".sync-diff-change")
    .first()
    .getByRole("table", { name: "줄 비교" });
  await expect(documentTable).toHaveClass(/sync-diff-virtual/);
  await documentTable.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      await documentTable.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return documentTable.locator(".is-added").last().textContent();
    })
    .toContain("추가 메모 300");
  await documentTable.evaluate((element) => {
    element.scrollTop = 0;
  });
  const fold = documentTable.getByRole("button", { name: /줄 같음/ });
  await expect(fold).toBeVisible();
  const hiddenCount = Number((await fold.innerText()).match(/(\d+)줄/)![1]);
  const foldHeight = (await fold.boundingBox())!.height;
  const beforeHeight = await documentTable.evaluate(
    (element) => element.scrollHeight,
  );
  await fold.click();
  await expect(documentTable.locator(".sync-diff-line").first()).toContainText(
    "markdown: |",
  );
  await expect
    .poll(() => documentTable.locator(".sync-diff-line").count())
    .toBeGreaterThan(30);
  // Only the unfolded lines should add height; measured wrapped rows retain
  // their height even while outside the rendered window (rounding tolerance).
  await expect
    .poll(async () => {
      const height = await documentTable.evaluate(
        (element) => element.scrollHeight,
      );
      return Math.abs(height - beforeHeight - hiddenCount * 19.2 + foldHeight);
    })
    .toBeLessThan(30);
  expect(await documentTable.locator(".sync-diff-line").count()).toBeLessThan(
    100,
  );
  await documentTable.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(documentTable.locator(".is-added").last()).toContainText(
    "추가 메모",
  );
  const table = box
    .locator(".sync-diff-change")
    .last()
    .getByRole("table", { name: "줄 비교" });
  await expect(table).toBeVisible();
  // All lines remain reachable, while only the visible window becomes DOM.
  expect(await table.locator(".sync-diff-line").count()).toBeLessThan(100);
  await table.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(table.locator(".sync-diff-line").last()).toContainText(
    "year: 2026",
  );
  await table.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("large-conflict.png") });
  await box.getByRole("button", { name: "먼저 수정", exact: true }).click();
  await expect(box.locator(".sync-diff-change .sync-diff-equal")).toHaveCount(
    12,
  );
  await box.getByRole("button", { name: "나중에 수정", exact: true }).click();
  await expect(table).toBeVisible();
  await box.getByText("겹치지 않은 항목 12개", { exact: true }).click();
  await expect(box.locator(".sync-diff-change")).toHaveCount(0);
  await box.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
  expect(errors).toEqual([]);
});

test("충돌 보관함은 체크박스로 고른 충돌을 한꺼번에 해결하고 실패한 항목은 따로 알린다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 900 });
  const bootstrap = await configuredBootstrap(page);
  const saved = new Map<string, string>([["c3", "current"]]);
  const requests: [string, string][] = [];
  const cellConflict = (id: string) => {
    const key = [`${id}-task`, "title"];
    return {
      conflictId: id,
      opId: id,
      createdAt: "2026-11-04T00:14:00.000Z",
      target: "cell " + key.join("/"),
      result: "Concurrent field change",
      base: [{ value: "원래 값" }],
      current: {
        [JSON.stringify(["cell", key])]: {
          entity: "cell",
          key,
          generation: "g".repeat(64),
          version: "v".repeat(64),
          deleted: false,
          payload: { value: `먼저 ${id}` },
        },
      },
      desired: [{ value: `나중 ${id}` }],
      expectedHead: "head-1",
      frontier: [id],
      resolved: false,
      origin: {
        held: { site: "internal", actor: "김바다", createdAt: null },
        writers: {},
      },
      pendingResolution: saved.has(id)
        ? {
            opId: "resolution-" + id,
            createdAt: "2026-11-04T01:00:00.000Z",
            choice: saved.get(id),
          }
        : null,
    };
  };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: bootstrap }),
  );
  await page.route(`**/api/teams/${teamId}/sync`, (route) =>
    route.fulfill({
      json: {
        mode: "active",
        profileId: "local",
        pending: 0,
        conflicts: 3,
        canonicalHead: "head-1",
      },
    }),
  );
  await page.route(`**/api/teams/${teamId}/sync/conflicts`, (route) =>
    route.fulfill({
      json: { conflicts: ["c1", "c2", "c3"].map(cellConflict) },
    }),
  );
  await page.route(
    `**/api/teams/${teamId}/sync/conflicts/*/resolve`,
    (route) => {
      const id = route.request().url().split("/").at(-2)!,
        { choice } = route.request().postDataJSON();
      requests.push([id, choice]);
      // Another tab already saved c2's resolution.
      if (id === "c2")
        return route.fulfill({
          status: 409,
          json: {
            error:
              "이 충돌은 이미 해결 방법을 저장했습니다. 다음 동기화 때 공유됩니다.",
          },
        });
      saved.set(id, choice);
      return route.fulfill({ json: { opId: "resolution-" + id } });
    },
  );
  await page.reload();
  await page
    .locator(".topbar")
    .getByRole("button", { name: "충돌 보관함" })
    .click();
  const box = page.getByRole("dialog", { name: "충돌 보관함" });
  const items = box.locator(".team-sync-conflict");
  await expect(items).toHaveCount(3);
  const check = (n: number) =>
    items.nth(n).locator(".team-sync-conflict-check");
  const count = box.locator(".team-sync-conflict-batch-count");
  // A saved resolution cannot be chosen again; ticking does not expand.
  await expect(check(2)).toBeDisabled();
  await check(0).click();
  await expect(check(0)).toBeChecked();
  await expect(items.nth(0)).not.toHaveAttribute("open", "");
  await expect(count).toHaveText("1개 선택");
  const all = box.getByLabel("전체 선택");
  await all.click();
  await expect(count).toHaveText("2개 선택");
  await expect(check(1)).toBeChecked();
  // The batch buttons carry the same names as the buttons on each card.
  const overwrite = box
    .getByRole("group", { name: "선택한 충돌 일괄 해결" })
    .getByRole("button", { name: "나중에 수정으로 덮어쓰기", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await overwrite.click();
  expect(requests).toEqual([]);
  let question = "";
  page.once("dialog", (dialog) => {
    question = dialog.message();
    void dialog.accept();
  });
  await overwrite.click();
  await expect(box.locator(".team-sync-conflict-batch-status")).toHaveText(
    "1개 저장, 1개 실패했습니다. 실패한 항목을 펼쳐 이유를 확인하세요.",
  );
  expect(question).toContain(
    "선택한 충돌 2개를 모두 나중에 수정으로 덮어씁니다.",
  );
  expect(requests).toEqual([
    ["c1", "submitted"],
    ["c2", "submitted"],
  ]);
  await expect(items.nth(0).locator(":scope > summary")).toContainText(
    "해결 저장됨",
  );
  await expect(check(0)).toBeDisabled();
  // The failed one stays selected with its reason on its card.
  await expect(count).toHaveText("1개 선택");
  await items.nth(1).locator(":scope > summary").click();
  await expect(items.nth(1).getByRole("alert")).toContainText(
    "이미 해결 방법을 저장했습니다",
  );
});

test("외부 연결 이관 실패 후 기존 프로필을 유지하고 저장된 작업을 이어서 실행한다", async ({
  page,
}) => {
  const bootstrap = await configuredBootstrap(page);
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
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("기존 자원");
  await expect(
    settings.getByLabel("교체용 프로필", { exact: true }),
  ).not.toBeVisible();
  await settings.getByText("연결 이전·복구", { exact: true }).click();
  await settings
    .getByLabel("교체용 프로필", { exact: true })
    .selectOption("replacement");
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("기존 자원");
  await settings
    .getByRole("button", { name: "자료 이관 후 연결 변경", exact: true })
    .click();
  await expect(settings.getByRole("alert")).toContainText(
    "연결 확인 후 다시 시도하세요.",
  );
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("기존 자원");
  await settings
    .getByRole("button", { name: "이어서 연결 이관", exact: true })
    .click();
  await expect(
    settings.getByLabel("연결 프로필", { exact: true }),
  ).toContainText("새 자원");
  await expect(
    settings.getByRole("button", { name: "이어서 연결 이관", exact: true }),
  ).toHaveCount(0);
  expect(resumed).toBe(2);
});

test("외부 배포 환경은 localhost에서도 초기 게시와 키 발급을 숨기고 팀 가져오기를 제공한다", async ({
  page,
}) => {
  app.locals.sync.profiles.push({
    profileId: "outside",
    teamId,
    name: "외부 자원",
    repository: "test/outside",
  });
  const bootstrap = unpack(
    await (await page.request.get(`${base}/api/bootstrap`)).json(),
  );
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: { ...bootstrap, site: "external" } }),
  );
  await page.route("**/api/admin/service-connections", (route) =>
    route.fulfill({
      json: {
        site: "external",
        siteName: "외부 팀",
        database: { provider: "postgres", version: 2, status: "ok" },
        profiles: [
          { profileId: "outside", teamId, name: "외부 자원", ready: true },
        ],
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    settings.getByRole("region", { name: "동기화 검증팀 외부 동기화" }),
  ).toContainText("연결 설정");
  await expect(
    settings.getByRole("button", { name: "초기 게시", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("region", { name: "팀장 연결 키", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "외부 동기화", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "팀 가져오기", exact: true }),
  ).toBeEnabled();
});

test("프로필 없는 팀은 상태 요청 없이 설정 진입점과 서비스 설치 안내를 제공한다", async ({
  page,
}) => {
  let syncReads = 0;
  page.on("request", (request) => {
    if (/\/api\/teams\/[^/]+\/sync(?:\/conflicts)?$/.test(request.url()))
      syncReads++;
  });
  await page.clock.install();
  const settings = panel(page);
  await expect(
    settings.getByRole("tab", { name: "외부 동기화", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("tab", { name: "일반", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(20000);
  expect(syncReads).toBe(0);
  await settings
    .getByRole("button", { name: "외부 동기화", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "외부 동기화" }),
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

test("프로필만 있는 팀은 연결 폼만 읽고 다른 팀으로 전환하면 일반 탭으로 돌아간다", async ({
  page,
}) => {
  app.locals.sync.profiles.push({
    profileId: "ready",
    teamId,
    name: "설정할 자원",
    repository: "test/ready",
  });
  let syncReads = 0;
  page.on("request", (request) => {
    if (/\/api\/teams\/[^/]+\/sync(?:\/conflicts)?$/.test(request.url()))
      syncReads++;
  });
  await page.clock.install();
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settings = panel(page);
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(settings.getByLabel("연결 프로필")).toBeVisible();
  await expect(settings.getByLabel("동기화 상태", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings.getByRole("button", { name: "연결 검사", exact: true }),
  ).toHaveCount(0);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.clock.runFor(20000);
  expect(syncReads).toBe(0);
  await settings
    .locator(".settings-nav")
    .getByRole("button", { name: "다른 동기화팀" })
    .click();
  await expect(
    settings.getByRole("tab", { name: "외부 동기화", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("tab", { name: "일반", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(syncReads).toBe(0);
});

test("팀장은 자기 팀 연결을 설정하며 공통 자원과 다른 팀은 볼 수 없다", async ({
  page,
}) => {
  app.locals.sync.profiles.push({
    profileId: "lead",
    teamId,
    repository: "test/lead",
  });
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
  await settings.getByRole("tab", { name: "외부 동기화", exact: true }).click();
  await expect(
    settings.getByRole("region", { name: "동기화 검증팀 외부 동기화" }),
  ).toContainText("연결 설정");
  await expect(settings.getByLabel("연결 프로필", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    settings.getByRole("button", { name: "외부 동기화", exact: true }),
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
  const bootstrap = await configuredBootstrap(page);
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: bootstrap }),
  );
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
  await page.reload();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await panel(page)
    .getByRole("tab", { name: "외부 동기화", exact: true })
    .click();
  const status = panel(page).getByLabel("동기화 상태", { exact: true });
  await expect(status).toContainText("내부 서버 저장");
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
        ? {
            ...bootstrap,
            site: "external",
            authMode: "access",
            accountLinking: true,
          }
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
  const bootstrap = await configuredBootstrap(page);
  let state = "pending";
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        site: "external",
        authMode: "access",
        accountLinking: true,
      },
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
        ? {
            ...bootstrap,
            site: "external",
            authMode: "access",
            accountLinking: true,
          }
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
    .getByLabel("팀장 연결 키", { exact: true })
    .fill("installation-test-key");
  await page
    .getByRole("button", { name: "팀장 계정 연결", exact: true })
    .click();
  await expect(page.getByLabel("팀 선택")).toBeVisible();
});
