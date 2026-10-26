import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { createWorker } from "../worker/entry.mjs";
import { materialize, boundStore } from "../worker/sync.mjs";
import { emptyState, entityId, digest } from "../server/sync/protocol.mjs";
import {
  normalizeSettings,
  DEFAULT_SETTINGS,
  defaultView,
} from "../shared/domain.js";
import { THEME_IDS } from "../shared/themes.js";
import { unpack } from "../shared/compact.js";
const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
test(
  "Worker real PostgreSQL API: setup, invitation, all shared domains, atomic retries, tenant isolation and events",
  { skip: !existsSync(join(pgBin, "initdb")), timeout: 120000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "gb-worker-")),
      data = join(directory, "db"),
      socket = join(directory, "socket");
    mkdirSync(socket);
    let started = false;
    const command = (bin, args) => {
      const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    };
    const pools = [];
    const dbname = (name) =>
      `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=55444`;
    try {
      command("initdb", [
        "-D",
        data,
        "-A",
        "trust",
        "-U",
        "postgres",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      command("pg_ctl", [
        "-D",
        data,
        "-l",
        join(directory, "postgres.log"),
        "-o",
        `-k ${socket} -p 55444 -c listen_addresses=''`,
        "-w",
        "start",
      ]);
      started = true;
      const root = new Pool({ connectionString: dbname("postgres") });
      pools.push(root);
      for (const db of ["control", "team", "replacement"])
        await root.query("CREATE DATABASE " + db);
      const control = new Pool({ connectionString: dbname("control") }),
        team = new Pool({ connectionString: dbname("team") });
      pools.push(control, team);
      const teamId = randomUUID(),
        repoId = randomUUID(),
        installationId = randomUUID();
      await migratePostgres(control, { scope: "control", initialize: true });
      await migratePostgres(team, { scope: "team", initialize: true, teamId });
      const env = {
        APP_ORIGIN: "https://board.example.com",
        ACCESS_ISSUER: "https://test.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud",
        SETUP_TOKEN: "a-secure-random-setup-token-for-test",
        PG_CONTROL: { connectionString: dbname("control") },
        PG_TEAM_A: { connectionString: dbname("team") },
        R2_TEAM_A: {},
        GIT_TEAM_A: "test-token",
        INSTALLATION_ID: installationId,
        SYNC_PROFILES: JSON.stringify([
          {
            profileId: "a",
            teamId,
            repository: "example/private-data",
            databaseBinding: "PG_TEAM_A",
            bucketBinding: "R2_TEAM_A",
            githubSecret: "GIT_TEAM_A",
          },
        ]),
        ASSETS: { fetch: async () => new Response("<html>app</html>") },
      };
      const errors = [],
        work = [];
      const worker = createWorker({
        verify: async (request) => ({
          issuer: env.ACCESS_ISSUER,
          subject: request.headers.get("test-subject") || "admin-sub",
          email: request.headers.get("test-email") || "admin@example.com",
          expiresAt: Date.now() + 3600000,
        }),
        onError: (e) => errors.push(e),
      });
      const request = async (
        path,
        body,
        method = body ? "POST" : "GET",
        identity = {},
      ) => {
        const response = await worker.fetch(
          new Request(env.APP_ORIGIN + "/api" + path, {
            method,
            headers: {
              "X-Requested-With": "WeeklyPlan",
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...identity,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          env,
          { waitUntil: (p) => work.push(p) },
        );
        const json = unpack(await response.json());
        if (response.status >= 500 && response.status !== 503)
          throw errors.at(-1);
        return { status: response.status, body: json, response };
      };
      assert.equal((await request("/setup")).body.authMode, "access");
      assert.equal(
        (await request("/auth/setup", { name: "Admin", setupToken: "wrong" }))
          .status,
        403,
      );
      const setup = await request("/auth/setup", {
        name: "Admin",
        setupToken: env.SETUP_TOKEN,
      });
      assert.equal(setup.status, 201);
      assert.deepEqual((await request("/admin/users")).body.teams, []);
      const adminId = setup.body.user.id;
      assert.equal(
        (
          await request("/auth/setup", {
            name: "Other",
            setupToken: env.SETUP_TOKEN,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/bootstrap", undefined, "GET", {
            "test-subject": "stranger",
            "test-email": "stranger@example.com",
          })
        ).status,
        403,
      );
      await control.query(
        "INSERT INTO graeboard.teams(id,name,profile_id,status) VALUES($1,'Team','a','active')",
        [teamId],
      );
      await control.query(
        "INSERT INTO graeboard.memberships(user_id,team_id,role) VALUES($1,$2,'lead')",
        [adminId, teamId],
      );
      const adapter = new PostgresDatabase(team, { teamId });
      const state = emptyState();
      for (const [entity, key, payload] of [
        [
          "team",
          [],
          { name: "Team", settings: normalizeSettings(DEFAULT_SETTINGS) },
        ],
        ["person", [adminId], { name: "Admin" }],
      ])
        state.entities[entityId(entity, key)] = {
          entity,
          key,
          payload,
          generation: randomUUID(),
          version: randomUUID(),
          deleted: false,
        };
      await adapter.withTeamTransaction(teamId, async (tx) => {
        await tx.sync.writeLink({
          repo_id: repoId,
          bootstrap_id: randomUUID(),
          installation_id: installationId,
          writer_epoch: randomUUID(),
          profile_id: "a",
          mode: "paused",
          canonical_head: "a".repeat(40),
          updated_at: new Date().toISOString(),
        });
        await tx.sync.writeState(state, "a".repeat(40));
        await materialize(tx, teamId, { state, pending: [], exclusions: [] });
      });
      assert.equal(
        (await request("/auth/logout", {})).body.logoutUrl,
        "/cdn-cgi/access/logout",
      );
      const guardedStore = boundStore(adapter, teamId);
      assert.equal(await guardedStore.acquire("stale-head-check"), true);
      const beforeCursor = Number(
        (
          await team.query(
            "SELECT MAX(cursor) cursor FROM graeboard.site_events",
          )
        ).rows[0].cursor,
      );
      await assert.rejects(
        guardedStore.commitCanonical("wrong-head", "b".repeat(40), state, [], {
          previousState: state,
        }),
      );
      assert.equal(
        (await adapter.readLink(teamId)).canonical_head,
        "a".repeat(40),
      );
      assert.equal(
        Number(
          (
            await team.query(
              "SELECT MAX(cursor) cursor FROM graeboard.site_events",
            )
          ).rows[0].cursor,
        ),
        beforeCursor,
      );
      await guardedStore.release("stale-head-check");
      const bootstrap = (await request("/bootstrap")).body;
      assert.equal((await request("/admin/users")).body.teams[0].id, teamId);
      assert.equal(bootstrap.teams[0].id, teamId);
      const task = (
        await request("/tasks", {
          teamId,
          year: 2026,
          fields: { title: "Worker task" },
        })
      ).body.task;
      assert.equal(task.cells.title.value, "Worker task");
      const op = {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: task.id,
            key: "title",
            expectedVersion: task.cells.title.version,
            value: "Saved outside",
          },
        ],
      };
      const saved = await request("/cells/batch", op);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.cells[0].value, "Saved outside");
      assert.deepEqual((await request("/cells/batch", op)).body, saved.body);
      assert.equal(
        (await request("/cells/batch", { ...op, operationId: randomUUID() }))
          .status,
        409,
      );
      const pending = await adapter.readPending(teamId);
      assert.equal(pending.length, 2);
      assert.equal(pending[1].dependsOn.includes(pending[0].opId), true);
      const doc = (await request(`/tasks/${task.id}/document`)).body;
      const docSaved = await request(
        `/tasks/${task.id}/document`,
        {
          operationId: randomUUID(),
          expectedRevision: doc.revision,
          markdown: "Worker document",
        },
        "PUT",
      );
      assert.equal(docSaved.body.markdown, "Worker document");
      const memoId = randomUUID();
      assert.equal(
        (await request(`/teams/${teamId}/years/2026/memos`, { id: memoId }))
          .status,
        200,
      );
      assert.equal(
        (await request(`/teams/${teamId}/years/2026/memos`)).body.documents
          .length,
        1,
      );
      const tagId = randomUUID();
      assert.equal(
        (
          await request(`/calendar/teams/${teamId}/tags`, {
            id: tagId,
            userId: adminId,
            name: "Check",
            color: "blue",
            kind: "check",
          })
        ).status,
        200,
      );
      const entryId = randomUUID();
      const entry = await request("/calendar/entries", {
        teamId,
        id: entryId,
        userId: adminId,
        date: "2026-10-27",
        title: "Outside calendar",
        tagIds: [tagId],
        checkedTagIds: [],
      });
      assert.equal(entry.status, 200);
      assert.equal(
        (
          await request(
            `/calendar/entries/${entryId}/tags/${tagId}`,
            { checked: true, expectedChecked: false },
            "PATCH",
          )
        ).body.checked,
        true,
      );
      assert.equal(
        (
          await request("/calendar/weekly", {
            teamId,
            userId: adminId,
            weekStart: "2026-10-25",
            taskIds: [task.id],
          })
        ).body.added,
        1,
      );
      assert.equal(
        (
          await request(
            `/calendar?teamId=${teamId}&userId=${adminId}&from=2026-10-25&to=2026-10-31`,
          )
        ).body.entries[0].title,
        "Outside calendar",
      );
      const reportId = randomUUID();
      assert.equal(
        (
          await request("/reports", {
            id: reportId,
            teamId,
            year: 2026,
            name: "Copy",
            referenceDate: "2026-10-27",
            view: defaultView(2026),
            taskIds: [task.id],
          })
        ).status,
        200,
      );
      const reportOperation = (await adapter.readPending(teamId))
        .flatMap((op) => op.changes)
        .find((c) => c.entity === "report" && c.key[0] === reportId);
      assert.deepEqual(
        Object.keys(reportOperation.desired.data.users[0]).sort(),
        ["id", "name"],
      );
      assert.doesNotMatch(
        JSON.stringify(reportOperation.desired),
        /admin@example\.com|admin-sub|systemRole|teamRoles|username|sessionToken/,
      );
      const report = (await request("/reports/" + reportId)).body;
      assert.equal(report.tasks.length, 1);
      assert.equal(
        (
          await request(`/reports/${reportId}/documents/batch`, {
            taskIds: [task.id],
          })
        ).body.tasks[0].documents[0].markdown,
        "Worker document",
      );
      assert.equal(
        (await request(`/reports/${reportId}/tasks/${task.id}/document`)).body
          .markdown,
        "Worker document",
      );
      assert.equal(
        (
          await request(
            "/reports/" + reportId,
            {
              operationId: randomUUID(),
              revision: report.revision,
              operations: [
                {
                  kind: "cells",
                  at: new Date().toISOString(),
                  changes: [
                    {
                      taskId: task.id,
                      key: "title",
                      expectedVersion: report.tasks[0].cells.title.version,
                      value: "Copy changed",
                    },
                  ],
                },
              ],
            },
            "PATCH",
          )
        ).body.tasks[0].cells.title.value,
        "Copy changed",
      );
      assert.equal(
        (
          await request(
            "/filters",
            { teamId, scope: "team", name: "Shared", data: {} },
            "PUT",
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/filters?teamId=" + teamId)).body.filters.length,
        1,
      );
      assert.equal(
        (
          await request(
            "/calendar/preferences",
            { weekdays: [1, 2, 3, 4, 5] },
            "PUT",
          )
        ).body.weekdays.length,
        5,
      );
      const otherId = randomUUID();
      assert.equal(
        (await request("/tasks?teamId=" + otherId + "&year=2026")).status,
        404,
      );
      const invite = await request("/admin/users", {
        username: "viewer@example.com",
        name: "Viewer",
        systemRole: "user",
        memberships: [{ teamId, role: "viewer" }],
      });
      assert.equal(invite.status, 200);
      const viewer = {
        "test-email": "viewer@example.com",
        "test-subject": "viewer-sub",
      };
      assert.equal(
        (await request("/bootstrap", undefined, "GET", viewer)).status,
        200,
      );
      assert.equal(
        (await request("/tasks", { teamId, year: 2026 }, "POST", viewer))
          .status,
        403,
      );
      assert.equal(
        (await request("/admin/service-connections", undefined, "GET", viewer))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            "/calendar/entries",
            {
              id: randomUUID(),
              teamId,
              userId: null,
              date: "2026-10-27",
              title: "Shared viewer entry",
            },
            "POST",
            viewer,
          )
        ).status,
        200,
      );
      const streamResponse = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/events", {
          method: "POST",
          headers: {
            "X-Requested-With": "WeeklyPlan",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            streams: [{ id: 0, path: `/api/tasks/${task.id}/document/events` }],
          }),
        }),
        env,
        { waitUntil: (p) => work.push(p) },
      );
      assert.equal(streamResponse.status, 200);
      const reader = streamResponse.body.getReader();
      const chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), /Worker document/);
      await reader.cancel();
      await Promise.allSettled(work);
      assert.equal((await adapter.readPending(teamId)).length > 10, true);
      const latestTasks = (
        await request("/tasks?teamId=" + teamId + "&year=2026")
      ).body;
      assert.equal(latestTasks.cellEventId.startsWith("pg:"), true);
      const formatting = await request("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        format: {
          teamId,
          expectedRevision: 0,
          expectedTasks: { [task.id]: latestTasks.tasks[0].updatedAt },
          scopes: [{ rows: [task.id], keys: ["title"], style: { bold: true } }],
        },
      });
      assert.equal(formatting.status, 200, JSON.stringify(formatting.body));
      assert.ok(formatting.body.formatOperation);
      assert.equal(formatting.body.formatting.rules[0].style.bold, true);
      const undone = await request("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        format: {
          teamId,
          expectedRevision: formatting.body.formatRevision,
          restore: formatting.body.formatOperation,
          expectedCells: {},
        },
      });
      assert.equal(undone.status, 200, JSON.stringify(undone.body));
      assert.deepEqual(undone.body.formatting.rules, []);
      const history = (
        await request("/audit?teamId=" + teamId + "&sheetId=original")
      ).body;
      assert.equal(
        history.entries.some(
          (e) => e.action === "cells" && Array.isArray(e.before),
        ),
        true,
      );
      assert.equal(
        history.entries.some(
          (e) => e.action === "format" && e.before.formatting,
        ),
        true,
      );
      const cellHistory = history.entries.find((e) => e.action === "cells"),
        currentTask = (await request("/tasks?teamId=" + teamId + "&year=2026"))
          .body.tasks[0];
      assert.equal(
        (
          await request("/audit/" + cellHistory.id + "/restore", {
            versions: { [task.id + ":title"]: currentTask.cells.title.version },
          })
        ).status,
        200,
      );
      let restoredTask = (
        await request("/tasks?teamId=" + teamId + "&year=2026")
      ).body.tasks[0];
      assert.equal(restoredTask.cells.title.value, "Worker task");
      assert.equal(
        (
          await request("/cells/batch", {
            operationId: randomUUID(),
            createdAt: new Date().toISOString(),
            changes: [
              {
                taskId: task.id,
                key: "title",
                expectedVersion: restoredTask.cells.title.version,
                value: "Saved outside",
              },
            ],
          })
        ).status,
        200,
      );
      restoredTask = (await request("/tasks?teamId=" + teamId + "&year=2026"))
        .body.tasks[0];
      assert.equal(
        (
          await request(
            "/tasks/" + task.id,
            { updatedAt: restoredTask.updatedAt },
            "DELETE",
          )
        ).status,
        200,
      );
      const deletion = (
        await request("/audit?teamId=" + teamId + "&sheetId=original")
      ).body.entries.find((e) => e.action === "delete");
      assert.equal(deletion.restorableTaskIds[0], task.id);
      assert.equal(
        (await request("/audit/" + deletion.id + "/restore", {})).status,
        200,
      );
      const calendarCurrent = (
        await request(
          `/calendar?teamId=${teamId}&userId=${adminId}&from=2026-10-25&to=2026-10-31`,
        )
      ).body.entries[0];
      assert.equal(calendarCurrent.id, entryId);
      const exported = await request("/export", {
        teamId,
        year: 2026,
        format: "json",
        scope: "all",
      });
      assert.equal(exported.body.schemaVersion, 6);
      assert.equal(
        exported.body.tasks[0].documents[0].markdown,
        "Worker document",
      );
      assert.ok(Array.isArray(exported.body.documentImages));
      assert.equal(
        (await request("/admin/history-cleanup/storage")).body.scopes.length,
        2,
      );
      const preview = (
        await request(
          "/admin/history-cleanup?scopeId=" + teamId + "&beforeDate=2026-10-20",
        )
      ).body;
      assert.ok(preview.token);
      assert.equal(
        (
          await request("/admin/history-cleanup", {
            token: preview.token,
            confirmed: true,
          })
        ).body.completed,
        true,
      );
      const previousBinding = env.PG_TEAM_A;
      env.PG_TEAM_A = {
        connectionString: "postgresql://unavailable@127.0.0.1:1/unavailable",
      };
      assert.equal((await request("/admin/users")).status, 200);
      assert.equal(
        (await request("/bootstrap")).body.teams[0].connectionError.includes(
          "DB",
        ),
        true,
      );
      env.PG_TEAM_A = previousBinding;
      await Promise.allSettled(work);
      const countBefore = (
          await request("/tasks?teamId=" + teamId + "&year=2026")
        ).body.tasks.length,
        pendingBefore = (await adapter.readPending(teamId)).length;
      const invalidImage = await request("/tasks", {
        teamId,
        year: 2026,
        copiedRow: {
          cells: { title: { value: "Invalid reference", style: {} } },
          defaultStyle: {},
          rowStyle: {},
          documents: [
            {
              id: "main",
              title: "Private",
              markdown:
                "![private](/api/document-images/" +
                randomUUID() +
                "/" +
                "a".repeat(64) +
                ".webp)",
            },
          ],
        },
      });
      assert.equal(invalidImage.status, 400);
      assert.equal(
        (await request("/tasks?teamId=" + teamId + "&year=2026")).body.tasks
          .length,
        countBefore,
      );
      assert.equal((await adapter.readPending(teamId)).length, pendingBefore);
      const cached = await request("/tasks?teamId=" + teamId + "&year=2026"),
        unchanged = await worker.fetch(
          new Request(
            env.APP_ORIGIN + "/api/tasks?teamId=" + teamId + "&year=2026",
            {
              headers: { "If-None-Match": cached.response.headers.get("etag") },
            },
          ),
          env,
          { waitUntil: (p) => work.push(p) },
        );
      assert.equal(unchanged.status, 304);
      assert.equal(
        unchanged.headers.get("x-cell-event-id"),
        cached.response.headers.get("x-cell-event-id"),
      );
      await team.query("UPDATE graeboard.schema_migrations SET version=999");
      assert.equal(
        (await request("/tasks?teamId=" + teamId + "&year=2026")).status,
        503,
      );
      assert.equal((await request("/admin/users")).status, 200);
      await team.query("UPDATE graeboard.schema_migrations SET version=1");
      await Promise.allSettled(work);
      const teamSettings = (await request("/bootstrap")).body.teams[0].settings,
        newTheme = THEME_IDS.find((t) => t !== teamSettings.theme);
      assert.equal(
        (
          await request(
            "/teams/" + teamId,
            {
              name: "Team",
              theme: newTheme,
              settingsRevision: teamSettings.revision,
            },
            "PATCH",
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/bootstrap")).body.teams[0].settings.theme,
        newTheme,
      );
      assert.equal(
        (
          await request(
            "/teams/" + teamId,
            {
              name: "Team",
              theme: teamSettings.theme,
              settingsRevision: teamSettings.revision,
            },
            "PATCH",
          )
        ).status,
        409,
      );
      await Promise.allSettled(work);
      // Resume after every bounded migration chunk, preserving all local pending data.
      const replacement = new Pool({ connectionString: dbname("replacement") });
      pools.push(replacement);
      await migratePostgres(replacement, {
        scope: "team",
        initialize: true,
        teamId,
      });
      const bucket = () => {
        const objects = new Map();
        return {
          list: async () => ({
            objects: [...objects.entries()].map(([key, value]) => ({
              key,
              size: value.length,
              uploaded: new Date(),
            })),
            truncated: false,
          }),
          get: async (key) =>
            objects.has(key)
              ? {
                  arrayBuffer: async () =>
                    objects
                      .get(key)
                      .buffer.slice(
                        objects.get(key).byteOffset,
                        objects.get(key).byteOffset +
                          objects.get(key).byteLength,
                      ),
                }
              : null,
          put: async (key, bytes) => objects.set(key, Buffer.from(bytes)),
          delete: async (key) => objects.delete(key),
        };
      };
      env.R2_TEAM_A = bucket();
      env.R2_TEAM_B = bucket();
      env.PG_TEAM_B = { connectionString: dbname("replacement") };
      env.SYNC_PROFILES = JSON.stringify([
        ...JSON.parse(env.SYNC_PROFILES),
        {
          profileId: "b",
          replaces: "a",
          teamId,
          repository: "example/private-data",
          databaseBinding: "PG_TEAM_B",
          bucketBinding: "R2_TEAM_B",
          githubSecret: "GIT_TEAM_A",
        },
      ]);
      const beforePending = (await adapter.readPending(teamId)).map(digest),
        beforeState = await adapter.readState(teamId);
      let migration = await request(
        `/admin/teams/${teamId}/connection/switch`,
        { profileId: "b", expectedRevision: 0 },
      );
      assert.equal(migration.status, 200);
      assert.equal(migration.body.hasMore, true);
      assert.equal(
        (
          await request("/tasks", {
            teamId,
            year: 2026,
            fields: { title: "Blocked" },
          })
        ).status,
        409,
      );
      for (let count = 0; migration.body.hasMore && count < 50; count++) {
        migration = await request(
          `/admin/teams/${teamId}/connection/switch/${migration.body.jobId}/resume`,
          {},
        );
        assert.equal(migration.status, 200, JSON.stringify(migration.body));
      }
      assert.equal(migration.body.phase, "complete");
      const destination = new PostgresDatabase(replacement, { teamId });
      assert.deepEqual(
        (await destination.readPending(teamId)).map(digest),
        beforePending,
      );
      assert.deepEqual(await destination.readState(teamId), beforeState);
      assert.equal((await destination.readLink(teamId)).profile_id, "b");
      assert.equal((await adapter.readLink(teamId)).mode, "recovery");
      assert.equal(
        (await request(`/admin/teams/${teamId}/connection`)).body.profileId,
        "b",
      );
      assert.equal(
        (await request("/tasks?teamId=" + teamId + "&year=2026")).body.tasks[0]
          .cells.title.value,
        "Saved outside",
      );
      // A persisted old maintenance owner is never cleared by expiry alone.
      const jobId = randomUUID();
      await destination.withTeamTransaction(teamId, (tx) =>
        tx.query(
          "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'images','deleting','{}',$3,$4)",
          [
            jobId,
            teamId,
            JSON.stringify({ owner: "abandoned", until: 1 }),
            new Date().toISOString(),
          ],
        ),
      );
      assert.equal(
        (await request(`/admin/teams/${teamId}/maintenance/recover`, { jobId }))
          .status,
        400,
      );
      assert.equal(
        (
          await request(`/admin/teams/${teamId}/maintenance/recover`, {
            jobId,
            dryRun: true,
          })
        ).body.ownerPresent,
        true,
      );
      assert.equal(
        (
          await request(`/admin/teams/${teamId}/maintenance/recover`, {
            jobId,
            confirmedDrained: true,
          })
        ).body.phase,
        "failed",
      );
      assert.equal(
        (await request("/tasks", { teamId, year: 2026 })).status,
        409,
      );
      await Promise.allSettled(work);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      if (started)
        spawnSync(
          join(pgBin, "pg_ctl"),
          ["-D", data, "-m", "immediate", "-w", "stop"],
          { stdio: "ignore" },
        );
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
