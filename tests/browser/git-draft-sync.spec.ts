import { test, expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { GitCliTransport } from "../../server/sync/git-cli.mjs";
import { createApp } from "../../server/app.mjs";
import { openDatabase, getTask } from "../../server/db.mjs";
import { unpack } from "../../shared/compact.js";
import { todayKey } from "../../shared/domain.js";

test("실제 Git 수신은 미저장 셀·문서·캘린더 입력을 보존한다", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const temporary = mkdtempSync(join(tmpdir(), "graeboard-git-drafts-"));
  const sites: Array<{
    db: ReturnType<typeof openDatabase>;
    app: ReturnType<typeof createApp>;
    server: ReturnType<ReturnType<typeof createApp>["listen"]>;
    base: string;
  }> = [];
  const pages: Page[] = [page];
  async function request(
    base: string,
    path: string,
    method = "GET",
    data?: unknown,
  ) {
    const response = await page.request.fetch(`${base}/api${path}`, {
      method,
      headers: { "X-Requested-With": "WeeklyPlan" },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return unpack(await response.json());
  }
  async function start(
    db: ReturnType<typeof openDatabase>,
    syncOptions: object,
  ) {
    const app = createApp({
      db,
      rateLimits: false,
      documentImagesDir: join(temporary, `images-${sites.length}`),
      syncOptions: { ...syncOptions, schedule: false },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const site = {
      db,
      app,
      server,
      base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    };
    sites.push(site);
    return site;
  }
  try {
    const remote = join(temporary, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const localTransport = new GitCliTransport({
      directory: join(temporary, "local.git"),
      repository: remote,
      allowLocal: true,
    });
    const local = await start(openDatabase(join(temporary, "local.sqlite")), {
      installationId: randomUUID(),
      profiles: [],
      transports: { local: localTransport },
    });
    const { user } = await request(local.base, "/auth/setup", "POST", {
      username: "git-drafts@example.com",
      password: "local-git-drafts-password",
      name: "동기화 관리자",
      teamName: "Git 입력 보존팀",
      sample: false,
    });
    const teamId = user.teamIds[0],
      year = Number(todayKey().slice(0, 4));
    const task = (
      await request(local.base, "/tasks", "POST", {
        teamId,
        year,
        fields: { title: "입력 보존 업무" },
      })
    ).task;
    const proof = (
      await request(local.base, "/tasks", "POST", {
        teamId,
        year,
        fields: { title: "수신 확인 업무" },
      })
    ).task;
    const documentPath = `/tasks/${task.id}/documents/main`;
    await request(local.base, documentPath, "PUT", {
      markdown: "첫 문단\n\n둘째 문단\n",
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    const entryId = randomUUID();
    await request(local.base, "/calendar/entries", "POST", {
      id: entryId,
      teamId,
      userId: user.id,
      title: "기존 일정",
      date: todayKey(),
      tagIds: [],
    });
    local.app.locals.sync.profiles.push({
      profileId: "local",
      teamId,
      repository: "test/data",
    });
    await request(local.base, `/admin/teams/${teamId}/connection`, "PUT", {
      profileId: "local",
      expectedRevision: 0,
    });
    await request(local.base, `/teams/${teamId}/sync/enable`, "POST", {});
    const beforeHead = await localTransport.readHead();

    // A coherent initial clone gives both real servers identical canonical IDs
    // and login sessions. Distinct installation/writer identities keep new ops independent.
    const peerPath = join(temporary, "peer.sqlite");
    local.db.prepare("VACUUM INTO ?").run(peerPath);
    const peerDb = openDatabase(peerPath),
      peerInstallation = randomUUID();
    peerDb
      .prepare(
        "UPDATE team_sync_links SET installation_id=?,profile_id='peer',writer_epoch=? WHERE team_id=?",
      )
      .run(peerInstallation, randomUUID(), teamId);
    const peerTransport = new GitCliTransport({
      directory: join(temporary, "peer.git"),
      repository: remote,
      allowLocal: true,
    });
    const peer = await start(peerDb, {
      installationId: peerInstallation,
      profiles: [{ profileId: "peer", teamId, repository: "test/data" }],
      transports: { peer: peerTransport },
    });
    async function open(p: Page) {
      await p.goto(local.base);
      await p.getByLabel("팀 선택").selectOption(teamId);
    }
    await open(page);
    await page.locator(`[data-cell="${task.id}:title"]`).dblclick();
    const cellDraft = page.locator(".inline-editor textarea");
    await cellDraft.fill("미저장 셀 입력");

    const documentPage = await page.context().newPage();
    pages.push(documentPage);
    await open(documentPage);
    await documentPage
      .locator(`[data-cell="${task.id}:title"]`)
      .click({ button: "right" });
    await documentPage
      .getByRole("button", { name: "Markdown 원문", exact: true })
      .click();
    const documentDraft = documentPage.getByRole("textbox", {
      name: "업무 문서 Markdown 원문",
      exact: true,
    });
    await documentDraft.fill("첫 문단\n\n둘째 문단 미저장 입력\n");
    // Actual IME handling defers autosave; no API response or event is mocked.
    await documentDraft.dispatchEvent("compositionstart");

    const calendarPage = await page.context().newPage();
    pages.push(calendarPage);
    await open(calendarPage);
    await calendarPage
      .getByRole("button", { name: "캘린더", exact: true })
      .click();
    await calendarPage
      .locator(`[data-entry-id="${entryId}"] .calendar-entry-card`)
      .click();
    const calendarDraft = calendarPage
      .getByRole("dialog", { name: "캘린더 일정", exact: true })
      .getByLabel("일정 제목", { exact: true });
    await calendarDraft.fill("미저장 일정 제목");
    await calendarDraft.dispatchEvent("compositionstart");

    await request(peer.base, "/cells/batch", "POST", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [task, proof].map((row, index) => ({
        taskId: row.id,
        key: "title",
        value: index ? "Git 수신 확인" : "Git 원격 셀",
        expectedVersion: getTask(peerDb, row.id).cells.title.version,
      })),
    });
    await request(peer.base, documentPath, "PUT", {
      markdown: "첫 문단 Git 수신\n\n둘째 문단\n",
      expectedRevision: (await request(peer.base, documentPath)).revision,
      operationId: randomUUID(),
    });
    await request(peer.base, `/calendar/entries/${entryId}`, "PATCH", {
      title: "Git 원격 일정",
      expectedTitle: "기존 일정",
    });
    expect(
      peerDb
        .prepare(
          "SELECT payload FROM sync_outbox WHERE team_id=? AND status='pending'",
        )
        .all(teamId)
        .some((row: { payload: string }) =>
          JSON.parse(row.payload).changes.some(
            (change: { entity: string; key: string[] }) =>
              change.entity === "calendar" && change.key[0] === entryId,
          ),
        ),
      "The real calendar API must atomically capture its title mutation for Git publication",
    ).toBeTruthy();
    await peer.app.locals.sync.get(teamId).run();
    const receivedHead = await peerTransport.readHead();
    expect(receivedHead).not.toBe(beforeHead);
    await local.app.locals.sync.get(teamId).run({ receiveOnly: true });

    expect(local.app.locals.sync.store(teamId).readLink().canonical_head).toBe(
      receivedHead,
    );
    expect(getTask(local.db, task.id).cells.title.value).toBe("Git 원격 셀");
    expect((await request(local.base, documentPath)).markdown).toBe(
      "첫 문단 Git 수신\n\n둘째 문단\n",
    );
    expect(
      (await request(local.base, `/calendar/entries/${entryId}`)).title,
    ).toBe("Git 원격 일정");
    await expect(page.locator(`[data-cell="${proof.id}:title"]`)).toContainText(
      "Git 수신 확인",
    );
    await expect(cellDraft).toHaveValue("미저장 셀 입력");
    await expect(documentDraft).toHaveValue(
      "첫 문단\n\n둘째 문단 미저장 입력\n",
    );
    await expect(calendarDraft).toHaveValue("미저장 일정 제목");

    // Ending composition also proves that the actual receive event reached the
    // document editor: it merges the queued remote paragraph with the local draft.
    await documentDraft.dispatchEvent("compositionend");
    await expect(documentDraft).toHaveValue(
      "첫 문단 Git 수신\n\n둘째 문단 미저장 입력\n",
    );
    await info.attach("actual-git-draft-preservation", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          beforeHead,
          receivedHead,
          draftsPreserved: ["cell", "document", "calendar"],
        }),
      ),
    });
  } finally {
    await Promise.all(pages.map((p) => p.close()));
    for (const { app, server, db } of sites.reverse()) {
      await app.locals.sync?.close?.();
      app.locals.cellEvents.shutdown();
      app.locals.documentEvents.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});
