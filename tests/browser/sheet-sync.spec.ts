import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";
import { defaultView } from "../../shared/domain.js";
const headers = { "X-Requested-With": "WeeklyPlan" };
async function api(p: Page, path: string, method = "GET", data?: unknown) {
  const response = await p.request.fetch(`/api${path}`, {
    method,
    headers,
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return unpack(await response.json());
}
async function edit(p: Page, id: string, value: string) {
  await p.locator(`[data-cell="${id}:title"]`).dblclick();
  const input = p
    .locator(".inline-editor textarea,.inline-editor input")
    .first();
  await input.fill(value);
  await input.press("Enter");
}
for (const copy of [false, true]) {
  test(`${copy ? "사본" : "연간 원본"} 시트의 두 사용자 수정·행 추가·삭제가 실시간 반영된다`, async ({
    page,
    browser,
  }) => {
    await api(page, "/auth/login", "POST", {
      username: "test@somansa.com",
      password: "1234",
    });
    const boot = await api(page, "/bootstrap");
    const team = await api(page, "/admin/teams", "POST", {
      name: `시트 동기화 ${randomUUID().slice(0, 8)}`,
      members: [{ userId: boot.user.id, role: "lead" }],
    });
    const tasks = [];
    for (const title of ["첫 업무", "둘째 업무"])
      tasks.push(
        (
          await api(page, "/tasks", "POST", {
            teamId: team.id,
            year: 2026,
            fields: { title },
          })
        ).task,
      );
    const report = copy
      ? await api(page, "/reports", "POST", {
          teamId: team.id,
          year: 2026,
          name: "공동 사본",
          referenceDate: "2026-10-21",
          taskIds: tasks.map((t) => t.id),
          view: defaultView(2026),
        })
      : null;
    const username = `sheet-${randomUUID()}@example.com`;
    await api(page, "/admin/users", "POST", {
      username,
      name: "시트 편집자",
      password: "local-peer-password",
      memberships: [{ teamId: team.id, role: "lead" }],
    });
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    try {
      const peer = await context.newPage();
      await api(peer, "/auth/login", "POST", {
        username,
        password: "local-peer-password",
      });
      for (const p of [page, peer]) {
        await p.goto("/");
        await p.getByLabel("팀 선택").selectOption(team.id);
        if (copy)
          await p.getByRole("tab", { name: "공동 사본", exact: true }).click();
        await expect(
          p.locator(`[data-cell="${tasks[0].id}:title"]`),
        ).toHaveText("첫 업무");
      }
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      if (copy)
        await page.route(`**/api/reports/${report.id}`, async (route) => {
          if (route.request().method() === "PATCH" && !held) {
            held = true;
            await gate;
          }
          await route.continue();
        });
      await edit(page, tasks[0].id, "내가 수정한 업무");
      if (copy) await expect.poll(() => held).toBeTruthy();
      await edit(peer, tasks[1].id, "상대가 수정한 업무");
      if (copy) {
        await expect(peer.locator(".sheet-save-status")).toHaveText("저장됨");
        release();
      }
      for (const p of [page, peer]) {
        await expect(
          p.locator(`[data-cell="${tasks[0].id}:title"]`),
        ).toHaveText("내가 수정한 업무", { timeout: 4000 });
        await expect(
          p.locator(`[data-cell="${tasks[1].id}:title"]`),
        ).toHaveText("상대가 수정한 업무", { timeout: 4000 });
      }
      const documentPath = copy
        ? `/reports/${report.id}/tasks/${tasks[0].id}/documents/main`
        : `/tasks/${tasks[0].id}/documents/main`;
      const sheetRevision = copy
        ? (await api(page, `/reports/${report.id}`)).revision
        : null;
      const marker = peer.locator(
        `[data-cell="${tasks[0].id}:title"] .task-document-indicator`,
      );
      for (const markdown of ["상대 브라우저에 표시할 문서", ""]) {
        const document = await api(page, documentPath);
        await api(page, documentPath, "PUT", {
          markdown,
          expectedRevision: document.revision,
          operationId: randomUUID(),
        });
        await expect(marker).toHaveCount(markdown ? 1 : 0, { timeout: 3000 });
      }
      if (copy)
        expect((await api(page, `/reports/${report.id}`)).revision).toBe(
          sheetRevision,
        );
      let addedId = randomUUID();
      if (copy) {
        const latest = await api(page, `/reports/${report.id}`);
        await api(page, `/reports/${report.id}`, "PATCH", {
          operationId: randomUUID(),
          revision: latest.revision,
          operations: [
            {
              kind: "create",
              at: new Date().toISOString(),
              taskId: addedId,
              fields: { title: "새 행" },
            },
          ],
        });
      } else
        addedId = (
          await api(page, "/tasks", "POST", {
            teamId: team.id,
            year: 2026,
            fields: { title: "새 행" },
          })
        ).task.id;
      await expect(peer.locator(`[data-cell="${addedId}:title"]`)).toHaveText(
        "새 행",
        { timeout: 3000 },
      );
      if (copy) {
        const latest = await api(page, `/reports/${report.id}`);
        await api(page, `/reports/${report.id}`, "PATCH", {
          operationId: randomUUID(),
          revision: latest.revision,
          operations: [
            {
              kind: "delete",
              at: new Date().toISOString(),
              taskIds: [addedId],
            },
          ],
        });
      } else {
        const latest = (
          await api(page, `/tasks?teamId=${team.id}&year=2026`)
        ).tasks.find((t: any) => t.id === addedId);
        await api(page, `/tasks/${addedId}`, "DELETE", {
          updatedAt: latest.updatedAt,
        });
      }
      await expect(peer.locator(`[data-cell="${addedId}:title"]`)).toHaveCount(
        0,
        { timeout: 3000 },
      );
    } finally {
      await context.close();
    }
  });
}
