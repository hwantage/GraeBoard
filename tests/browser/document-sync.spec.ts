import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { restartableServer } from "./restart-server";
import { unpack } from "../../shared/compact.js";
import { defaultView } from "../../shared/domain.js";
const headers = { "X-Requested-With": "WeeklyPlan" };
async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers,
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
for (const kind of ["task", "report-task", "memo", "report-memo"]) {
  test(`${kind}: 두 사용자의 문서 수정·동시 병합·다시 연결`, async ({
    page,
    browser,
  }) => {
    await request(page, "/auth/login", "POST", {
      username: "test@somansa.com",
      password: "1234",
    });
    const boot = await request(page, "/bootstrap");
    const team = await request(page, "/admin/teams", "POST", {
      name: `동기화 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    });
    const task = (
      await request(page, "/tasks", "POST", {
        teamId: team.id,
        year: 2026,
        fields: { title: "문서 동기화" },
      })
    ).task;
    const username = `sync-${randomUUID()}@example.com`;
    await request(page, "/admin/users", "POST", {
      username,
      name: "동시 편집자",
      password: "local-peer-password",
      memberships: [{ teamId: team.id, role: "lead" }],
    });
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    try {
      const peer = await context.newPage();
      await request(peer, "/auth/login", "POST", {
        username,
        password: "local-peer-password",
      });
      let reportId = "";
      if (kind.startsWith("report"))
        reportId = (
          await request(page, "/reports", "POST", {
            teamId: team.id,
            year: 2026,
            name: "동기화 사본",
            referenceDate: "2026-10-21",
            view: defaultView(2026),
            taskIds: [task.id],
          })
        ).id;
      const memo = kind.endsWith("memo");
      const id = memo ? randomUUID() : "main";
      const collection = memo
        ? reportId
          ? `/reports/${reportId}/memos`
          : `/teams/${team.id}/years/2026/memos`
        : reportId
          ? `/reports/${reportId}/tasks/${task.id}/documents`
          : `/tasks/${task.id}/documents`;
      if (memo) await request(page, collection, "POST", { id });
      const path = `${collection}/${id}`;
      const initial = await request(page, path);
      await request(page, path, "PUT", {
        markdown: "첫 문단\n\n둘째 문단\n",
        expectedRevision: initial.revision,
        operationId: randomUUID(),
      });
      const label = memo ? "연간 업무 메모" : "업무 문서";
      const source = (p: Page) =>
        p.getByRole("textbox", { name: `${label} Markdown 원문`, exact: true });
      async function selectReport(p: Page) {
        const tab = p.getByRole("tab", { name: "동기화 사본", exact: true });
        await tab.click();
        // Selection follows report loading and its task-dialog reset.
        await expect(tab).toHaveAttribute("aria-selected", "true");
      }
      async function open(p: Page) {
        await p.goto("/");
        await p.getByLabel("팀 선택").selectOption(team.id);
        if (reportId) await selectReport(p);
        if (memo)
          await p
            .getByRole("button", {
              name: "꼬리 메모",
              expanded: false,
              exact: true,
            })
            .click();
        else
          await p
            .locator(`[data-cell="${task.id}:title"]`)
            .click({ button: "right" });
        await expect(
          p.getByRole("textbox", { name: `${label} 리치 편집`, exact: true }),
        ).toBeVisible();
        await p
          .getByRole("button", { name: "Markdown 원문", exact: true })
          .click();
        await expect(source(p)).toHaveValue("첫 문단\n\n둘째 문단\n");
      }
      await open(page);
      await open(peer);
      // Hold local autosave during IME; the remote change must wait, then merge.
      await source(peer).fill("첫 문단\n\n둘째 문단 상대 수정\n");
      // Start after fill: Firefox's synthetic fill ends an active composition.
      await source(peer).dispatchEvent("compositionstart");
      await source(page).fill("첫 문단 내 수정\n\n둘째 문단\n");
      await expect
        .poll(async () => (await request(page, path)).markdown)
        .toBe("첫 문단 내 수정\n\n둘째 문단\n");
      await expect(source(peer)).toHaveValue(
        "첫 문단\n\n둘째 문단 상대 수정\n",
      );
      await source(peer).dispatchEvent("compositionend");
      let merged = "첫 문단 내 수정\n\n둘째 문단 상대 수정\n";
      await expect(source(peer)).toHaveValue(merged);
      await expect(source(page)).toHaveValue(merged);
      await expect
        .poll(async () => (await request(page, path)).markdown)
        .toBe(merged);
      if (!memo) {
        let writes = 0;
        let releaseFirst!: () => void, releaseRetry!: () => void;
        const first = new Promise<void>((resolve) => (releaseFirst = resolve));
        const retry = new Promise<void>((resolve) => (releaseRetry = resolve));
        await page.route(`**/api${path}`, async (route) => {
          if (route.request().method() !== "PUT") return route.continue();
          const attempt = ++writes;
          if (attempt === 1) {
            await first;
            const response = await route.fetch();
            expect(response.status()).toBe(409);
            await route.fulfill({ response });
          } else {
            if (attempt === 2) await retry;
            await route.continue();
          }
        });
        try {
          await source(page).fill(merged.replace("내 수정", "내 후속 수정"));
          await expect.poll(() => writes).toBe(1);
          await source(peer).fill(
            merged.replace("상대 수정", "상대 후속 수정"),
          );
          await expect
            .poll(async () => (await request(page, path)).markdown)
            .toContain("상대 후속 수정");
          releaseFirst();
          await expect.poll(() => writes).toBe(2);
          merged = merged
            .replace("내 수정", "내 후속 수정")
            .replace("상대 수정", "상대 후속 수정");
          await expect(source(page)).toHaveValue(merged);
          // A 409 body has no task summary; keep the existing document marker.
          await expect(
            page.locator(
              `[data-cell="${task.id}:title"] .task-document-indicator`,
            ),
          ).toHaveCount(1);
        } finally {
          releaseFirst();
          releaseRetry();
        }
        await expect(source(peer)).toHaveValue(merged);
        await expect
          .poll(async () => (await request(page, path)).markdown)
          .toBe(merged);
      }
      await peer
        .getByRole("button", { name: "리치 문서", exact: true })
        .click();
      await source(page).fill(merged + "\n추가 문단\n");
      await expect(
        peer.getByRole("textbox", { name: `${label} 리치 편집`, exact: true }),
      ).toContainText("추가 문단");
      await context.setOffline(true);
      try {
        await source(page).fill(merged + "\n연결 단절 중 수정\n");
        await expect
          .poll(async () => (await request(page, path)).markdown)
          .toContain("연결 단절 중 수정");
      } finally {
        await context.setOffline(false);
      }
      await expect(
        peer.getByRole("textbox", { name: `${label} 리치 편집`, exact: true }),
      ).toContainText("연결 단절 중 수정");
      // Keep the existing reload checks on the same latest saved body.
      await source(page).fill(merged + "\n추가 문단\n");
      await expect(
        peer.getByRole("textbox", { name: `${label} 리치 편집`, exact: true }),
      ).toContainText("추가 문단");
      await peer.reload();
      if (reportId) await selectReport(peer);
      if (memo)
        await expect(
          peer.getByRole("button", {
            name: "꼬리 메모",
            expanded: true,
            exact: true,
          }),
        ).toHaveAttribute("aria-expanded", "true");
      else
        await peer
          .locator(`[data-cell="${task.id}:title"]`)
          .click({ button: "right" });
      await expect(
        peer.getByRole("textbox", { name: `${label} 리치 편집`, exact: true }),
      ).toContainText("추가 문단");
    } finally {
      await context.close();
    }
  });
}

test("SIGTERM 재시작 뒤 두 탭의 셀·시트·문서 목록·본문·사본 탭 동기화를 새로고침 없이 복구한다", async ({
  browser,
}, info) => {
  test.setTimeout(60000);
  const server = await restartableServer();
  const context = await browser.newContext({ baseURL: server.baseURL });
  try {
    await server.start();
    // Exclude the independent safety poll; every observed update must use SSE.
    await context.addInitScript(() => {
      const interval = window.setInterval.bind(window);
      window.setInterval = (handler, timeout, ...args) =>
        interval(timeout === 7000 ? () => {} : handler, timeout, ...args);
      (window as any).__restartIdentity = crypto.randomUUID();
    });
    const page = await context.newPage();
    await request(page, "/auth/setup", "POST", {
      username: "restart@example.com",
      password: "restart-test-password",
      name: "재시작 검증",
      teamName: "재시작 팀",
      sample: false,
    });
    const boot = await request(page, "/bootstrap");
    const teamId = boot.teams[0].id;
    const task = (
      await request(page, "/tasks", "POST", {
        teamId,
        year: 2026,
        fields: { title: "재시작 문서 업무" },
      })
    ).task;
    const other = (
      await request(page, "/tasks", "POST", {
        teamId,
        year: 2026,
        fields: { title: "셀 복구 대상" },
      })
    ).task;
    const path = `/tasks/${task.id}/documents/main`;
    await request(page, path, "PUT", {
      markdown: "재시작 전 본문",
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    const peer = await context.newPage();
    const pages = [page, peer];
    const editor = (p: Page) =>
      p.getByRole("textbox", { name: "업무 문서 Markdown 원문", exact: true });
    for (const p of pages) {
      await p.goto("/");
      await p.getByLabel("팀 선택").selectOption(teamId);
      await p
        .locator(`[data-cell="${task.id}:title"]`)
        .click({ button: "right" });
      await p
        .getByRole("button", { name: "Markdown 원문", exact: true })
        .click();
      await expect(editor(p)).toHaveValue("재시작 전 본문");
    }
    const identities = await Promise.all(
      pages.map((p) => p.evaluate(() => (window as any).__restartIdentity)),
    );
    await server.stop(); // Actual SIGTERM and normal exit from server/index.mjs.
    await server.start(); // Same private DB and port, new process and SSE generation.
    expect(server.pids[1]).not.toBe(server.pids[0]);
    const snapshot = await request(page, `/tasks?teamId=${teamId}&year=2026`);
    const current = snapshot.tasks.find((item: any) => item.id === other.id)
      .cells.title;
    await request(page, "/cells/batch", "POST", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: other.id,
          key: "title",
          value: "재시작 뒤 셀",
          expectedVersion: current.version,
        },
      ],
    });
    const document = await request(page, path);
    await request(page, path, "PUT", {
      markdown: "재시작 뒤 본문",
      expectedRevision: document.revision,
      operationId: randomUUID(),
    });
    await request(page, `/tasks/${task.id}/documents`, "POST", {
      id: randomUUID(),
      title: "재시작 뒤 문서",
    });
    const added = (
      await request(page, "/tasks", "POST", {
        teamId,
        year: 2026,
        fields: { title: "재시작 뒤 추가 업무" },
      })
    ).task;
    await request(page, "/reports", "POST", {
      teamId,
      year: 2026,
      name: "재시작 뒤 사본",
      referenceDate: "2026-10-26",
      view: defaultView(2026),
      taskIds: [task.id],
    });
    for (const [index, p] of pages.entries()) {
      await expect(p.locator(`[data-cell="${other.id}:title"]`)).toHaveText(
        "재시작 뒤 셀",
        { timeout: 15000 },
      );
      await expect(p.locator(`[data-cell="${added.id}:title"]`)).toHaveText(
        "재시작 뒤 추가 업무",
      );
      await expect(editor(p)).toHaveValue("재시작 뒤 본문");
      await expect(
        p.getByRole("tab", { name: "재시작 뒤 문서", exact: true }),
      ).toBeVisible();
      await expect(
        p.locator(".sheet-tabs").getByRole("tab", {
          name: "재시작 뒤 사본",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveCount(1);
      expect(await p.evaluate(() => (window as any).__restartIdentity)).toBe(
        identities[index],
      );
    }
    await info.attach("restart-recovery.json", {
      contentType: "application/json",
      body: JSON.stringify(
        {
          signal: "SIGTERM",
          normalExit: true,
          pids: server.pids,
          pages: 2,
          reloads: 0,
          safetyPollDisabled: true,
          recovered: [
            "cells",
            "team-sheet",
            "document-list",
            "document-body",
            "report-tabs",
          ],
        },
        null,
        2,
      ),
    });
  } finally {
    await context.close();
    await server.dispose();
  }
});
