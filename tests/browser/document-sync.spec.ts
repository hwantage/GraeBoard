import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
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
      async function open(p: Page) {
        await p.goto("/");
        await p.getByLabel("팀 선택").selectOption(team.id);
        if (reportId)
          await p
            .getByRole("tab", { name: "동기화 사본", exact: true })
            .click();
        if (memo)
          await p
            .getByRole("button", { name: "꼬리 메모 열기", exact: true })
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
      await peer.reload();
      if (reportId)
        await peer
          .getByRole("tab", { name: "동기화 사본", exact: true })
          .click();
      if (memo)
        await peer
          .getByRole("button", { name: "꼬리 메모 열기", exact: true })
          .click();
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
