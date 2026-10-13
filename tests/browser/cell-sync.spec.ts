import { unpack } from "../../shared/compact.js";
import { readPreferences, writePreferences } from "./preferences";
import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { defaultView, normalizeView } from "../../shared/domain.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
async function post(request: APIRequestContext, path: string, data: unknown) {
  const res = await request.post(`/api${path}`, { headers, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json().then(unpack);
}
let peerContext: BrowserContext,
  peer: Page,
  teamId: string,
  ids: string[],
  peerId: string,
  settings: any;
test.beforeEach(async ({ page, browser }) => {
  await post(page.request, "/auth/login", {
    username: "browser-test@example.com",
    password: "local-test-only-password",
  });
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  teamId = (
    await post(page.request, "/admin/teams", {
      name: "SSE " + randomUUID().slice(0, 8),
      templateTeamId: boot.teams.find((t: any) => t.name === "UX기획팀 · 예시")
        .id,
      members: [{ userId: boot.user.id, role: "lead" }],
    })
  ).id;
  settings = (
    await (await page.request.get("/api/bootstrap")).json().then(unpack)
  ).teams.find((t: any) => t.id === teamId).settings;
  const username = `sse-${randomUUID()}@example.com`;
  peerId = (
    await post(page.request, "/admin/users", {
      username,
      password: "local-peer-password",
      name: "다른 사용자",
      memberships: [{ teamId, role: "lead" }],
    })
  ).user.id;
  peerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4311",
    viewport: { width: 1366, height: 900 },
  });
  peer = await peerContext.newPage();
  await post(peer.request, "/auth/login", {
    username,
    password: "local-peer-password",
  });
  ids = [];
  for (const title of ["첫 업무", "숨길 업무", "셋째 업무"]) {
    ids.push(
      (
        await post(page.request, "/tasks", {
          teamId,
          year: 2026,
          fields: { title, owner: peerId, status: "status-progress" },
        })
      ).task.id,
    );
  }
  for (const p of [page, peer]) {
    await p.addInitScript(
      ({ teamId }) => {
        // Inspect the real EventSource events, independently of the React UI.
        (window as any).__sseEvents = [];
        const Native = window.EventSource;
        window.EventSource = class extends Native {
          constructor(url: string | URL, options?: EventSourceInit) {
            super(url, options);
            for (const name of ["ready", "cells", "reset"])
              this.addEventListener(name, (e) =>
                (window as any).__sseEvents.push({
                  type: name,
                  data: JSON.parse((e as MessageEvent).data),
                  teamId,
                }),
              );
          }
        };
      },
      { teamId },
    );
  }
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(teamId);
  await expect(cell(page, ids[0])).toHaveText("첫 업무");
  await waitReady(page);
  await expect.poll(() => currentView(page)).toBeDefined();
});
test.afterEach(async () => {
  await peerContext?.close();
});

const cell = (p: Page, id: string, key = "title") =>
  p.locator(`[data-cell="${id}:${key}"]`);
async function waitReady(p: Page) {
  await expect
    .poll(() =>
      p.evaluate(() =>
        (window as any).__sseEvents.some((e: any) => e.type === "ready"),
      ),
    )
    .toBeTruthy();
}
async function openPeer(privateView = false) {
  if (privateView) {
    const data = {
      ...normalizeView(defaultView(2026), settings),
      visibleFields: ["title", "status"],
      hiddenRows: [ids[1]],
      widths: { title: 360 },
      frozenColumns: 1,
      fromMonth: 4,
      toMonth: 6,
      propertyFilters: { status: ["status-completed"] },
      propertyFilterModes: { status: "exclude" },
    };
    for (const [name, value] of [
      ["__current", data],
      [
        "내 미완료 필터",
        {
          year: 2026,
          propertyFilters: data.propertyFilters,
          propertyFilterModes: data.propertyFilterModes,
        },
      ],
    ]) {
      const res = await writePreferences(peer, {
        headers,
        data: { teamId, name, data: value },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
  }
  await peer.goto("/");
  await expect(cell(peer, ids[0])).toHaveText("첫 업무");
  await waitReady(peer);
  if (privateView) {
    await peer
      .getByRole("button", { name: "저장된 필터", exact: true })
      .click();
    await Promise.all([
      peer.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith("/api/filters/current") &&
          response.ok(),
      ),
      peer
        .locator(".saved-views")
        .getByRole("button", { name: "내 미완료 필터", exact: true })
        .click(),
    ]);
  }
  await expect.poll(() => currentView(peer)).toBeDefined();
}
async function save(
  p: Page,
  changes: { id: string; key?: string; value: unknown }[],
) {
  const tasks = (
    await (
      await p.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks;
  return post(p.request, "/cells/batch", {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    changes: changes.map(({ id, key = "title", value }) => ({
      taskId: id,
      key,
      value,
      expectedVersion:
        tasks.find((t: any) => t.id === id).cells[key]?.version ?? 0,
    })),
  });
}
async function currentView(p: Page) {
  return (await readPreferences(p, teamId)).views.find(
    (v: any) => v.name === "__current",
  )?.data;
}

test("SSE로 셀을 공유해도 다른 사용자의 숨김·필터·배치·스크롤을 유지한다", async ({
  page,
}) => {
  await openPeer(true);
  await expect(peer.locator(".active-filter-banner strong")).toHaveText(
    "내 미완료 필터",
  );
  const before = await currentView(peer);
  const ownBefore = await currentView(page);
  const viewWrites: string[] = [];
  peer.on("request", (req) => {
    if (req.method() === "PUT" && req.url().endsWith("/api/views"))
      viewWrites.push(req.url());
  });
  await peer.locator(".sheet-scroll").evaluate((el) => {
    el.scrollLeft = 180;
  });
  const scroll = await peer
    .locator(".sheet-scroll")
    .evaluate((el) => el.scrollLeft);
  // The receiver cannot obtain new data via periodic polling in this test.
  await peer.route("**/api/tasks?**", (route) => route.abort());
  await save(page, [
    { id: ids[0], value: "공유된 제목" },
    { id: ids[1], value: "숨긴 행의 새 값" },
    { id: ids[0], key: "description", value: "숨긴 열의 새 값" },
  ]);
  await expect(cell(peer, ids[0])).toHaveText("공유된 제목", { timeout: 3000 });
  await expect(peer.locator(`[data-row-id="${ids[1]}"]`)).toHaveCount(0);
  await expect(peer.locator('[data-header-key="description"]')).toHaveCount(0);
  await expect(peer.locator(".active-filter-banner strong")).toHaveText(
    "내 미완료 필터",
  );
  expect(await currentView(peer)).toEqual(before);
  expect(await currentView(page)).toEqual(ownBefore);
  expect(viewWrites).toHaveLength(0);
  expect(
    await peer.locator(".sheet-scroll").evaluate((el) => el.scrollLeft),
  ).toBe(scroll);
  await peer
    .getByRole("button", { name: "2행 숨김 해제", exact: true })
    .first()
    .click();
  await expect(cell(peer, ids[1])).toHaveText("숨긴 행의 새 값");
  // Existing hidden-column controls reveal the latest data without a GET.
  await peer
    .locator('.hidden-column-reveal[data-hidden-columns~="description"]')
    .first()
    .click();
  await expect(cell(peer, ids[0], "description")).toHaveText("숨긴 열의 새 값");
});

test("다른 셀은 편집 중에도 갱신하고 같은 셀 충돌은 내 입력·개인 필터를 보존한다", async ({
  page,
}) => {
  await openPeer(true);
  await cell(peer, ids[0]).dblclick();
  await peer.locator(".inline-editor textarea").fill("내가 작성하던 내용");
  await save(page, [
    { id: ids[0], value: "다른 사람이 저장한 내용" },
    { id: ids[0], key: "status", value: "status-completed" },
    { id: ids[2], value: "다른 셀은 즉시 반영" },
  ]);
  await expect(cell(peer, ids[2])).toHaveText("다른 셀은 즉시 반영", {
    timeout: 3000,
  });
  await expect(peer.locator(".inline-editor textarea")).toHaveValue(
    "내가 작성하던 내용",
  );
  await peer.locator(".inline-editor textarea").press("Enter");
  await peer.getByRole("button", { name: "입력 확인" }).click();
  await expect(peer.locator(".failed-input")).toContainText(
    "내가 작성하던 내용",
  );
  await expect(peer.locator("dialog")).toContainText("다른 사람이 저장한 내용");
  const stored = (
    await (
      await page.request.get(`/api/tasks?teamId=${teamId}&year=2026`)
    )
      .json()
      .then(unpack)
  ).tasks;
  expect(stored.find((t: any) => t.id === ids[0]).cells.title.value).toBe(
    "다른 사람이 저장한 내용",
  );
  await expect(peer.locator(".active-filter-banner strong")).toHaveText(
    "내 미완료 필터",
  );
});

test("수정 없이 편집을 닫으면 원격 변경을 이전 값으로 덮어쓰지 않는다", async ({
  page,
}) => {
  await openPeer();
  await cell(peer, ids[0]).dblclick();
  let writes = 0;
  peer.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/cells/batch"))
      writes++;
  });
  await save(page, [
    { id: ids[0], value: "최신 원격 값" },
    { id: ids[2], value: "수신 확인" },
  ]);
  await expect(cell(peer, ids[2])).toHaveText("수신 확인", { timeout: 3000 });
  await peer.locator(".inline-editor textarea").press("Enter");
  await expect(cell(peer, ids[0])).toHaveText("최신 원격 값");
  expect(writes).toBe(0);
});

test("담당자 변경으로 편집 권한을 잃어도 작성 중인 입력을 버리지 않는다", async ({
  page,
}) => {
  const changed = await page.request.patch(`/api/admin/users/${peerId}`, {
    headers,
    data: {
      name: "다른 사용자",
      active: true,
      memberships: [{ teamId, role: "member" }],
    },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await openPeer();
  await cell(peer, ids[0]).dblclick();
  await peer
    .locator(".inline-editor textarea")
    .fill("권한 변경 전 작성한 내용");
  const boot = await (
    await page.request.get("/api/bootstrap")
  )
    .json()
    .then(unpack);
  await save(page, [
    { id: ids[0], key: "owner", value: boot.user.id },
    { id: ids[2], value: "담당자 변경 수신 확인" },
  ]);
  await expect(cell(peer, ids[2])).toHaveText("담당자 변경 수신 확인", {
    timeout: 3000,
  });
  await peer.locator(".inline-editor textarea").press("Enter");
  await expect(peer.locator(".inline-editor textarea")).toHaveValue(
    "권한 변경 전 작성한 내용",
  );
  await expect(peer.getByRole("alert")).toContainText("편집 권한이 변경");
  await expect(cell(page, ids[0])).toHaveText("첫 업무");
});

test("이전 저장 응답이 늦게 도착해도 SSE로 받은 후속 변경을 되돌리지 않는다", async ({
  page,
}) => {
  await openPeer();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/cells/batch", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await cell(page, ids[0]).dblclick();
    await page.locator(".inline-editor textarea").fill("내 첫 저장");
    await page.locator(".inline-editor textarea").press("Enter");
    await expect(cell(peer, ids[0])).toHaveText("내 첫 저장", {
      timeout: 3000,
    });
    await save(peer, [
      { id: ids[0], value: "후속 원격 변경" },
      { id: ids[2], value: "후속 알림 수신 완료" },
    ]);
    await expect(cell(page, ids[2])).toHaveText("후속 알림 수신 완료", {
      timeout: 3000,
    });
    release();
    await expect(page.locator(".save-status")).toHaveCount(0);
    await expect(cell(page, ids[0])).toHaveText("후속 원격 변경");
  } finally {
    release();
  }
});

test("만료된 SSE 커서는 스냅샷으로 복구하면서 입력 중인 내용과 View를 유지한다", async ({
  page,
}) => {
  let release!: () => void, intercepted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connected = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  let first = true;
  await peer.route("**/api/cells/events?**", async (route) => {
    if (!first) return route.continue();
    first = false;
    intercepted();
    await gate;
    const url = new URL(route.request().url());
    url.searchParams.set("after", "previous-server:1");
    await route.continue({ url: url.toString() });
  });
  try {
    await peer.goto("/");
    await expect(cell(peer, ids[0])).toHaveText("첫 업무");
    await connected;
    await expect.poll(() => currentView(peer)).toBeDefined();
    await cell(peer, ids[0]).dblclick();
    await peer.locator(".inline-editor textarea").fill("연결 복구 중인 입력");
    const view = await currentView(peer);
    await save(page, [{ id: ids[2], value: "복구한 누락 변경" }]);
    release();
    await expect(cell(peer, ids[2])).toHaveText("복구한 누락 변경", {
      timeout: 3000,
    });
    await expect(peer.locator(".inline-editor textarea")).toHaveValue(
      "연결 복구 중인 입력",
    );
    expect(await currentView(peer)).toEqual(view);
    await waitReady(peer);
    await save(page, [{ id: ids[2], value: "복구 후 실시간 변경" }]);
    await expect(cell(peer, ids[2])).toHaveText("복구 후 실시간 변경", {
      timeout: 3000,
    });
    await peer.locator(".inline-editor textarea").press("Enter");
    await expect(cell(page, ids[0])).toHaveText("연결 복구 중인 입력", {
      timeout: 3000,
    });
  } finally {
    release();
  }
});
