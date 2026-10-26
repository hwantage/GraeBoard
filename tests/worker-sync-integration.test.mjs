import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { openDatabase, json, getTask } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { stateHash, digest, entityId } from "../server/sync/protocol.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { createWorker } from "../worker/entry.mjs";
import { runTeam, scheduled } from "../worker/sync.mjs";
import { profileFor } from "../worker/config.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};
test(
  "SQLite app ↔ real PostgreSQL Worker through CLI and GitHub API on one bare Git: domains, images, racing writers and lost acknowledgements",
  { skip: !existsSync(join(pgBin, "initdb")), timeout: 120000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-worker-bridge-")),
      remote = join(dir, "remote.git"),
      socket = join(dir, "socket"),
      pgData = join(dir, "pg"),
      teamId = randomUUID(),
      internalUser = randomUUID(),
      externalInstallation = randomUUID(),
      internalInstallation = randomUUID(),
      nativeFetch = globalThis.fetch,
      pools = [],
      work = [];
    mkdirSync(socket);
    let pgStarted = false,
      db,
      server,
      app;
    const command = (bin, args) => {
        const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
      },
      url = (name) =>
        `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=55445`;
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      const github = githubEmulator(remote),
        readme = github.text(["hash-object", "-w", "--stdin"], {
          input: "fixture",
        }),
        tree = github.text(["mktree"], {
          input: `100644 blob ${readme}\tREADME.md\n`,
        }),
        main = github.text(["commit-tree", tree, "-m", "init"]);
      github.text(["update-ref", "refs/heads/main", main]);
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.origin === "https://api.github.com")
          return github.fetch(url.href, init);
        assert.equal(
          url.hostname,
          "127.0.0.1",
          "unexpected live HTTP in integration fixture",
        );
        return nativeFetch(input, init);
      };
      command("initdb", [
        "-D",
        pgData,
        "-A",
        "trust",
        "-U",
        "postgres",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      command("pg_ctl", [
        "-D",
        pgData,
        "-l",
        join(dir, "pg.log"),
        "-o",
        `-k ${socket} -p 55445 -c listen_addresses=''`,
        "-w",
        "start",
      ]);
      pgStarted = true;
      const root = new Pool({ connectionString: url("postgres") });
      pools.push(root);
      await root.query("CREATE DATABASE control");
      await root.query("CREATE DATABASE team");
      const control = new Pool({ connectionString: url("control") }),
        team = new Pool({ connectionString: url("team") });
      pools.push(control, team);
      await migratePostgres(control, { scope: "control", initialize: true });
      await migratePostgres(team, { scope: "team", initialize: true, teamId });
      const pgStore = new PostgresDatabase(team, { teamId });
      db = openDatabase(join(dir, "inside.sqlite"));
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        "Bridge",
        json(DEFAULT_SETTINGS),
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'private-password-hash','admin',?)",
      ).run(
        internalUser,
        "inside@example.com",
        "Inside",
        new Date().toISOString(),
      );
      db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
        internalUser,
        teamId,
      );
      const token = randomUUID();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        internalUser,
        Date.now() + 86400000,
      );
      const transport = new GitCliTransport({
        directory: join(dir, "inside.git"),
        repository: remote,
        allowLocal: true,
      });
      app = createApp({
        db,
        rateLimits: false,
        documentImagesDir: join(dir, "images"),
        syncOptions: {
          installationId: internalInstallation,
          profiles: [
            {
              profileId: "inside",
              teamId,
              repository: "fixture/team",
              peerInstallationId: externalInstallation,
            },
          ],
          transports: { inside: transport },
          schedule: false,
        },
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const inside = async (path, body, method = body ? "POST" : "GET") => {
        const response = await nativeFetch(
          `http://127.0.0.1:${server.address().port}/api${path}`,
          {
            method,
            headers: {
              cookie: "weekly_session=" + token,
              "X-Requested-With": "WeeklyPlan",
              "Content-Type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
        return { status: response.status, data: unpack(await response.json()) };
      };
      const images = bucket(),
        env = {
          APP_ORIGIN: "https://bridge.example.com",
          ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          ACCESS_AUDIENCE: "fixture",
          SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
          INSTALLATION_ID: externalInstallation,
          PEER_INSTALLATION_ID: internalInstallation,
          PG_CONTROL: { connectionString: url("control") },
          PG_TEAM: { connectionString: url("team") },
          R2_TEAM: images,
          GIT_TOKEN: "fixture-secret",
          SYNC_PROFILES: JSON.stringify([
            {
              profileId: "outside",
              teamId,
              repository: "fixture/team",
              databaseBinding: "PG_TEAM",
              bucketBinding: "R2_TEAM",
              githubSecret: "GIT_TOKEN",
            },
          ]),
        },
        worker = createWorker({
          verify: async () => ({
            issuer: env.ACCESS_ISSUER,
            subject: "external-subject",
            email: "outside@example.com",
            expiresAt: Date.now() + 3600000,
          }),
        });
      const outside = async (path, body, method = body ? "POST" : "GET") => {
        const response = await worker.fetch(
          new Request(env.APP_ORIGIN + "/api" + path, {
            method,
            headers: {
              "X-Requested-With": "WeeklyPlan",
              ...(body instanceof FormData
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body
              ? { body: body instanceof FormData ? body : JSON.stringify(body) }
              : {}),
          }),
          env,
          { waitUntil: (p) => work.push(p) },
        );
        return { status: response.status, data: unpack(await response.json()) };
      };
      const drain = async () => {
        for (let i = 0; i < work.length; i++) await work[i];
        const link = await pgStore.readLink(teamId);
        if (link?.mode === "active")
          await runTeam(env, profileFor(env, "outside", teamId));
      };
      ok(
        await outside("/auth/setup", {
          name: "Outside",
          setupToken: env.SETUP_TOKEN,
        }),
      );
      ok(
        await inside(
          `/admin/teams/${teamId}/connection`,
          { profileId: "inside", expectedRevision: 0 },
          "PUT",
        ),
      );
      const task = ok(
        await inside("/tasks", {
          teamId,
          year: 2026,
          fields: { title: "From SQLite" },
        }),
      ).task;
      ok(
        await inside(
          `/tasks/${task.id}/document`,
          {
            operationId: randomUUID(),
            expectedRevision: 0,
            markdown: "Original body",
          },
          "PUT",
        ),
      );
      ok(await inside(`/teams/${teamId}/sync/enable`, {}));
      const genesisBlob = github.text([
        "rev-parse",
        "refs/heads/sync-v1:snapshots/genesis.json.gz",
      ]);
      ok(
        await inside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "2026-10-19",
              expectedVersion: 0,
              value: "Checkpoint prefix",
            },
          ],
        }),
      );
      await app.locals.sync.get(teamId).run();
      ok(await inside(`/teams/${teamId}/sync/checkpoint`, {}));
      const beforeImportCalls = github.calls.length;
      let imported = ok(
        await outside("/admin/sync/import", { teamId, profileId: "outside" }),
      );
      await drain();
      assert.equal(imported.phase, "complete");
      assert.equal(
        github.calls
          .slice(beforeImportCalls)
          .some((call) => call.path === "/git/blobs/" + genesisBlob),
        false,
        "new PG site loads verified checkpoint instead of replaying genesis",
      );
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2026")).tasks[0]
          .cells.title.value,
        "From SQLite",
      );
      assert.equal(
        ok(await outside(`/tasks/${task.id}/document`)).markdown,
        "Original body",
      );
      assert.equal(
        (await control.query("SELECT COUNT(*) count FROM graeboard.users"))
          .rows[0].count,
        "1",
      );
      assert.equal(
        (
          await control.query(
            "SELECT COUNT(*) count FROM graeboard.access_identities",
          )
        ).rows[0].count,
        "1",
      );
      const p = profileFor(env, "outside", teamId);
      let current = ok(await outside("/tasks?teamId=" + teamId + "&year=2026"))
        .tasks[0];
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "From PostgreSQL",
            },
          ],
        }),
      );
      await drain();
      await runTeam(env, p);
      await app.locals.sync.get(teamId).run();
      assert.equal(getTask(db, task.id).cells.title.value, "From PostgreSQL");
      const png = await sharp({
          create: { width: 10, height: 8, channels: 4, background: "#345678" },
        })
          .png()
          .toBuffer(),
        webp = await sharp(png).webp({ quality: 90 }).toBuffer();
      env.IMAGES = {
        info: async () => ({ format: "image/png", width: 10, height: 8 }),
        input: () => ({
          transform: () => ({
            output: async () => ({ response: () => new Response(webp) }),
          }),
        }),
      };
      const form = new FormData();
      form.set("image", new File([png], "fixture.png"));
      const uploaded = ok(
        await outside(`/tasks/${task.id}/document/images`, form),
      ).url;
      assert.equal(
        uploaded,
        `/api/document-images/${teamId}/${digest(webp)}.webp`,
      );
      const externalImage = await worker.fetch(
        new Request(env.APP_ORIGIN + uploaded),
        env,
        { waitUntil: (p) => work.push(p) },
      );
      assert.equal(externalImage.status, 200);
      assert.equal(externalImage.headers.get("content-type"), "image/webp");
      assert.equal(
        digest(new Uint8Array(await externalImage.arrayBuffer())),
        digest(webp),
      );
      const document = ok(await outside(`/tasks/${task.id}/document`));
      ok(
        await outside(
          `/tasks/${task.id}/document`,
          {
            operationId: randomUUID(),
            expectedRevision: document.revision,
            markdown: "Outside image\n\n![fixture](" + uploaded + ")",
          },
          "PUT",
        ),
      );
      await drain();
      await app.locals.sync.get(teamId).run();
      assert.match(
        ok(await inside(`/tasks/${task.id}/document`)).markdown,
        /Outside image/,
      );
      const imageResponse = await nativeFetch(
        `http://127.0.0.1:${server.address().port}` + uploaded,
        { headers: { cookie: "weekly_session=" + token } },
      );
      assert.equal(imageResponse.status, 200);
      assert.equal(
        digest(new Uint8Array(await imageResponse.arrayBuffer())),
        digest(webp),
      );
      const report = ok(
        await outside("/reports", {
          teamId,
          year: 2026,
          name: "Outside report",
          referenceDate: "2026-10-27",
          taskIds: [task.id],
          view: defaultView(2026),
        }),
      );
      await drain();
      await app.locals.sync.get(teamId).run();
      assert.equal(ok(await inside("/reports/" + report.id)).tasks.length, 1);
      assert.match(
        ok(await inside(`/reports/${report.id}/tasks/${task.id}/document`))
          .markdown,
        /Outside image/,
      );
      const sharedReport = (await pgStore.readState(teamId)).entities[
        entityId("report", [report.id])
      ];
      assert.doesNotMatch(
        JSON.stringify(sharedReport),
        /outside@example|inside@example|password|systemRole|teamRoles|external-subject/,
      );
      // Two independently saved changes race through Git CLI and the Data API.
      ok(await inside(`/teams/${teamId}/sync/pause`, {}));
      ok(await outside(`/teams/${teamId}/sync/pause`, {}));
      await drain();
      current = getTask(db, task.id);
      ok(
        await inside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "Concurrent inside",
            },
          ],
        }),
      );
      const outsideTask = ok(
        await outside("/tasks?teamId=" + teamId + "&year=2026"),
      ).tasks[0];
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "2026-10-26",
              expectedVersion: outsideTask.cells["2026-10-26"]?.version || 0,
              value: "Concurrent outside",
            },
          ],
        }),
      );
      await drain();
      app.locals.sync.store(teamId).writeLink({ mode: "active" });
      app.locals.sync.capture.refresh();
      await pgStore.withTeamTransaction(teamId, (tx) =>
        tx.query("UPDATE team_sync_links SET mode='active' WHERE team_id=$1", [
          teamId,
        ]),
      );
      await Promise.all([app.locals.sync.get(teamId).run(), runTeam(env, p)]);
      await app.locals.sync.get(teamId).run();
      await runTeam(env, p);
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        stateHash(await pgStore.readState(teamId)),
      );
      assert.equal(
        getTask(db, task.id).cells["2026-10-26"].value,
        "Concurrent outside",
      );
      // Ref accepted but response lost: retained immutable outbox is acknowledged on replay.
      ok(await outside(`/teams/${teamId}/sync/pause`, {}));
      await drain();
      current = ok(await outside("/tasks?teamId=" + teamId + "&year=2026"))
        .tasks[0];
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "Lost response retained",
            },
          ],
        }),
      );
      await drain();
      await pgStore.withTeamTransaction(teamId, (tx) =>
        tx.query("UPDATE team_sync_links SET mode='active' WHERE team_id=$1", [
          teamId,
        ]),
      );
      const lostOperation = (await pgStore.readPending(teamId))[0];
      github.loseNext();
      await assert.rejects(runTeam(env, p), /lost response/);
      const afterLoss = await pgStore.readState(teamId);
      assert.equal(afterLoss.receipts[lostOperation.opId]?.result, "applied");
      await runTeam(env, p);
      await app.locals.sync.get(teamId).run();
      assert.equal((await pgStore.readPending(teamId)).length, 0);
      assert.equal(
        getTask(db, task.id).cells.title.value,
        "Lost response retained",
      );
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        stateHash(await pgStore.readState(teamId)),
      );
      assert.ok(
        github.calls.some(
          (c) => c.method === "PATCH" && c.path === "/git/refs/heads/sync-v1",
        ),
      );
      // Real PostgreSQL local exclusion archives every byte before R2 deletion and
      // survives a new inbound Git commit until explicit restore retrieves bytes.
      await drain();
      const maintenance = `/admin/teams/${teamId}/maintenance`,
        preview = ok(
          await outside(maintenance + "/preview", { kind: "year", year: 2026 }),
        );
      let cleanup = ok(
        await outside(maintenance + "/execute", {
          token: preview.token,
          confirmed: true,
        }),
      );
      for (let i = 0; cleanup.hasMore && i < 50; i++)
        cleanup = ok(
          await outside(maintenance + "/resume", { jobId: cleanup.jobId }),
        );
      assert.equal(cleanup.phase, "complete");
      await drain();
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2026")).tasks
          .length,
        0,
      );
      assert.equal(
        images.objects.size,
        1,
        "restorable local audit still protects the image",
      );
      // Expire synthetic audit records through the actual history-cleanup API,
      // then reclaim the image which is now referenced only by excluded data.
      await team.query(
        "UPDATE graeboard.site_audit SET created_at='2026-01-01T00:00:00.000Z'",
      );
      const historyPreview = ok(
        await outside(
          `/admin/history-cleanup?scopeId=${teamId}&beforeDate=2026-10-20`,
        ),
      );
      ok(
        await outside("/admin/history-cleanup", {
          token: historyPreview.token,
          confirmed: true,
        }),
      );
      const unused = ok(
        await outside(maintenance + "/preview", { kind: "images" }),
      );
      let imagesCleanup = ok(
        await outside(maintenance + "/execute", {
          token: unused.token,
          confirmed: true,
        }),
      );
      while (imagesCleanup.hasMore)
        imagesCleanup = ok(
          await outside(maintenance + "/resume", {
            jobId: imagesCleanup.jobId,
          }),
        );
      assert.equal(images.objects.size, 0);
      assert.equal(
        ok(await inside("/tasks?teamId=" + teamId + "&year=2026")).tasks.length,
        1,
      );
      current = getTask(db, task.id);
      ok(
        await inside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "While excluded",
            },
          ],
        }),
      );
      await app.locals.sync.get(teamId).run();
      await runTeam(env, p);
      assert.equal(images.objects.size, 0);
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2026")).tasks
          .length,
        0,
      );
      const retention = ok(await outside(maintenance)).retention[0];
      let restored = ok(
        await outside(maintenance + "/restore", {
          retentionId: retention.id,
          expectedRevision: retention.revision,
        }),
      );
      for (let i = 0; restored.hasMore && i < 50; i++)
        restored = ok(
          await outside(maintenance + "/resume", { jobId: restored.jobId }),
        );
      assert.equal(restored.phase, "complete");
      await drain();
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2026")).tasks[0]
          .cells.title.value,
        "While excluded",
      );
      assert.equal(
        digest(images.objects.get(`images/${teamId}/${digest(webp)}.webp`)),
        digest(webp),
      );
      const maintain = async (body) => {
        await drain();
        const preview = ok(await outside(maintenance + "/preview", body));
        let job = ok(
          await outside(maintenance + "/execute", {
            token: preview.token,
            confirmed: true,
          }),
        );
        while (job.hasMore)
          job = ok(
            await outside(maintenance + "/resume", { jobId: job.jobId }),
          );
        await drain();
        return job;
      };
      const restoreRetention = async (retention) => {
        let job = ok(
          await outside(maintenance + "/restore", {
            retentionId: retention.id,
            expectedRevision: retention.revision,
          }),
        );
        while (job.hasMore)
          job = ok(
            await outside(maintenance + "/resume", { jobId: job.jobId }),
          );
        await drain();
      };
      const multi = ok(
        await outside("/tasks", {
          teamId,
          year: 2026,
          fields: { title: "Multiple years" },
        }),
      ).task;
      ok(
        await outside(
          "/tasks/" + multi.id,
          { updatedAt: multi.updatedAt, years: [2025, 2026] },
          "PATCH",
        ),
      );
      await drain();
      await maintain({ kind: "year", year: 2025 });
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2025")).tasks
          .length,
        0,
      );
      const multiVisible = ok(
        await outside("/tasks?teamId=" + teamId + "&year=2026"),
      ).tasks.find((t) => t.id === multi.id);
      assert.deepEqual(multiVisible.years, [2026]);
      ok(
        await outside(
          "/tasks/" + multi.id,
          { updatedAt: multiVisible.updatedAt, years: [2026, 2027] },
          "PATCH",
        ),
      );
      await drain();
      assert.deepEqual(
        (await pgStore.readState(teamId)).entities[
          entityId("task", [multi.id])
        ].payload.years.toSorted(),
        [2025, 2026, 2027],
      );
      assert.equal(
        (await outside("/tasks", { teamId, year: 2025 })).status,
        409,
      );
      assert.equal(
        (
          await outside(`/teams/${teamId}/years/2025/memos`, {
            id: randomUUID(),
          })
        ).status,
        409,
      );
      const originalRecord = (await pgStore.readState(teamId)).entities[
        entityId("document", ["task", task.id, "main"])
      ];
      await maintain({
        kind: "document",
        entity: "document",
        key: originalRecord.key,
        generation: originalRecord.generation,
      });
      const hiddenUpload = new FormData();
      hiddenUpload.set("image", new File([png], "hidden.png"));
      assert.equal(
        (await outside(`/tasks/${task.id}/document/images`, hiddenUpload))
          .status,
        404,
      );
      ok(
        await outside(`/tasks/${task.id}/documents`, {
          id: randomUUID(),
          title: "Visible new tab",
        }),
      );
      await drain();
      assert.equal(
        (await pgStore.readState(teamId)).entities[
          entityId("document", ["task", task.id, "main"])
        ].payload.markdown,
        originalRecord.payload.markdown,
      );
      assert.equal(
        ok(await outside(`/tasks/${task.id}/documents`)).documents.length,
        1,
      );
      await restoreRetention(
        ok(await outside(maintenance)).retention.find(
          (r) => r.kind === "document" && r.key[0] === "task",
        ),
      );
      const calendar = ok(
        await outside("/calendar/entries", {
          id: randomUUID(),
          teamId,
          userId: null,
          date: "2026-10-27",
          title: "Calendar document privacy",
        }),
      );
      ok(
        await outside(
          `/calendar/entries/${calendar.id}/document`,
          {
            operationId: randomUUID(),
            expectedRevision: 0,
            markdown: "Calendar secret body",
          },
          "PUT",
        ),
      );
      await drain();
      const calRecord = (await pgStore.readState(teamId)).entities[
        entityId("document", ["calendar", calendar.id, "main"])
      ];
      await maintain({
        kind: "document",
        entity: "document",
        key: calRecord.key,
        generation: calRecord.generation,
      });
      assert.equal(
        ok(await outside("/calendar/entries/" + calendar.id)).preview,
        "",
      );
      await restoreRetention(
        ok(await outside(maintenance)).retention.find(
          (r) => r.kind === "document" && r.key[0] === "calendar",
        ),
      );
      assert.equal(
        ok(await outside("/calendar/entries/" + calendar.id)).preview,
        "Calendar secret body",
      );
      await app.locals.sync.get(teamId).run();
      // A restored installation keeps immutable pending commands, captures edits
      // made while disconnected, and remains paused until explicit publication.
      ok(await outside(`/teams/${teamId}/sync/pause`, {}));
      await drain();
      current = ok(await outside("/tasks?teamId=" + teamId + "&year=2026"))
        .tasks[0];
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "Pending before disconnection",
            },
          ],
        }),
      );
      await drain();
      const immutable = (await pgStore.readPending(teamId))[0];
      ok(await outside(`/teams/${teamId}/sync/disconnect`, {}));
      current = ok(await outside("/tasks?teamId=" + teamId + "&year=2026"))
        .tasks[0];
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "Disconnected edit preserved",
            },
          ],
        }),
      );
      await drain();
      const oldLink = await pgStore.readLink(teamId);
      env.INSTALLATION_ID = randomUUID();
      assert.equal(
        (
          await outside(`/admin/teams/${teamId}/sync/recover`, {
            confirmedDrained: true,
            installationId: env.INSTALLATION_ID,
            expectedProfileId: "wrong",
            expectedHead: oldLink.canonical_head,
          })
        ).status,
        400,
      );
      let recovery = ok(
        await outside(`/admin/teams/${teamId}/sync/recover`, {
          confirmedDrained: true,
          installationId: env.INSTALLATION_ID,
          expectedProfileId: "outside",
          expectedHead: oldLink.canonical_head,
        }),
      );
      while (recovery.hasMore)
        recovery = ok(
          await outside(
            `/admin/teams/${teamId}/sync/recover/${recovery.jobId}/resume`,
            {},
          ),
        );
      assert.equal(recovery.mode, "paused");
      const recoveredLink = await pgStore.readLink(teamId),
        retained = await pgStore.readPending(teamId);
      assert.equal(recoveredLink.installation_id, env.INSTALLATION_ID);
      assert.notEqual(recoveredLink.writer_epoch, oldLink.writer_epoch);
      assert.equal(
        digest(retained.find((op) => op.opId === immutable.opId)),
        digest(immutable),
      );
      assert.equal(retained.length, 2);
      assert.equal(recoveredLink.remote_status, null);
      assert.equal(getTask(db, task.id).cells.title.value, "While excluded");
      ok(await outside(`/teams/${teamId}/sync/resume`, {}));
      await drain();
      await app.locals.sync.get(teamId).run();
      assert.equal(
        getTask(db, task.id).cells.title.value,
        "Disconnected edit preserved",
      );
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        stateHash(await pgStore.readState(teamId)),
      );
      // Real production Worker routes + real PG state, with failing bound storage.
      // Unlike the old isolated fault subprocess, these failures are on this
      // application's actual save / scheduled-sync path.
      ok(await outside(`/teams/${teamId}/sync/pause`, {}));
      current = ok(
        await outside("/tasks?teamId=" + teamId + "&year=2026"),
      ).tasks.find((r) => r.id === task.id);
      ok(
        await outside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "title",
              expectedVersion: current.cells.title.version,
              value: "Pending across external faults",
            },
          ],
        }),
      );
      await Promise.allSettled(work);
      const preservedPending = (await pgStore.readPending(teamId)).map(digest),
        preservedHead = (await pgStore.readLink(teamId)).canonical_head;
      assert.equal(preservedPending.length, 1);
      const faultStartedAt = new Date().toISOString();
      const healthyPG = env.PG_TEAM;
      env.PG_TEAM = {
        connectionString: "postgresql://unavailable@127.0.0.1:1/unavailable",
      };
      assert.equal(
        (
          await outside("/tasks", {
            teamId,
            year: 2026,
            fields: { title: "Failed PG save" },
          })
        ).status,
        500,
      );
      assert.equal(
        (await outside("/admin/users")).status,
        200,
        "control store stays accessible during team PG outage",
      );
      await assert.rejects(runTeam(env, p));
      await scheduled(env);
      assert.equal(
        (await pgStore.readLink(teamId)).canonical_head,
        preservedHead,
      );
      assert.deepEqual(
        (await pgStore.readPending(teamId)).map(digest),
        preservedPending,
      );
      env.PG_TEAM = healthyPG;
      const healthyHead = images.head;
      let failedR2Calls = 0;
      images.head = async () => {
        failedR2Calls++;
        throw Object.assign(new Error("fixture R2 unavailable"), {
          status: 503,
        });
      };
      const originalDocument = ok(await outside(`/tasks/${task.id}/document`));
      const failedSave = await outside(
        `/tasks/${task.id}/document`,
        {
          operationId: randomUUID(),
          expectedRevision: originalDocument.revision,
          markdown: originalDocument.markdown + "\nR2 failure must roll back",
        },
        "PUT",
      );
      assert.equal(failedSave.status, 503);
      assert.equal(
        ok(await outside(`/tasks/${task.id}/document`)).revision,
        originalDocument.revision,
      );
      assert.deepEqual(
        (await pgStore.readPending(teamId)).map(digest),
        preservedPending,
      );
      const internalCurrent = getTask(db, task.id);
      ok(
        await inside("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: task.id,
              key: "2026-11-02",
              expectedVersion:
                internalCurrent.cells["2026-11-02"]?.version || 0,
              value: "Inbound during R2 outage",
            },
          ],
        }),
      );
      await app.locals.sync.get(teamId).run();
      ok(await outside(`/teams/${teamId}/sync/resume`, {}));
      await assert.rejects(runTeam(env, p), /R2 unavailable/);
      await scheduled(env);
      assert.ok(
        failedR2Calls >= 3,
        "save and scheduled receiver actually reached failed R2 binding",
      );
      assert.equal(
        (await pgStore.readLink(teamId)).canonical_head,
        preservedHead,
      );
      assert.deepEqual(
        (await pgStore.readPending(teamId)).map(digest),
        preservedPending,
      );
      images.head = healthyHead;
      await scheduled(env);
      await app.locals.sync.get(teamId).run();
      assert.equal((await pgStore.readPending(teamId)).length, 0);
      assert.equal(
        getTask(db, task.id).cells.title.value,
        "Pending across external faults",
      );
      assert.equal(
        ok(await outside("/tasks?teamId=" + teamId + "&year=2026")).tasks.find(
          (r) => r.id === task.id,
        ).cells["2026-11-02"].value,
        "Inbound during R2 outage",
      );
      assert.equal(
        stateHash(await pgStore.readState(teamId)),
        stateHash(app.locals.sync.store(teamId).readState()),
      );
      assert.deepEqual(
        github.unexpectedCalls,
        [],
        "swallowed unexpected GitHub API calls also fail the fixture",
      );
      if (process.env.WORKER_FAULT_REPORT)
        writeFileSync(
          process.env.WORKER_FAULT_REPORT,
          JSON.stringify(
            {
              scenario: "worker-pg-r2-faults",
              verified: true,
              runtime:
                "Production Worker modules invoked in Node; temporary real PostgreSQL; Git CLI/Data API on one local bare repository",
              faultInjection:
                "Unavailable team PG connection binding and R2 binding HEAD throwing 503; no live cloud services",
              internalPerformanceCoupled: false,
              scope:
                "This small SQLite/Worker peer fixture is separate from a concurrently measured 10k internal app; it does not prove a coupled 10k external outage",
              faultStartedAt,
              completedAt: new Date().toISOString(),
              failedR2Calls,
              checks: {
                pgSaveRejected: true,
                teamPgCronFailed: true,
                controlAccessible: true,
                r2SaveRolledBack: true,
                r2CronFailed: true,
                pendingBytesPreserved: true,
                canonicalCursorPreserved: true,
                recoveredCronConverged: true,
              },
            },
            null,
            2,
          ) + "\n",
        );
    } finally {
      await Promise.allSettled(work);
      globalThis.fetch = nativeFetch;
      if (app) {
        await app.locals.sync.close();
        app.locals.cellEvents.close();
        app.locals.documentEvents.close();
      }
      if (server) await new Promise((r) => server.close(r));
      db?.close();
      await Promise.all(pools.map((p) => p.end()));
      if (pgStarted)
        spawnSync(
          join(pgBin, "pg_ctl"),
          ["-D", pgData, "-m", "immediate", "-w", "stop"],
          { stdio: "ignore" },
        );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
