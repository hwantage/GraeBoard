import { measureBrowserMetadata } from "./sync-browser-performance.mjs";
import { runMergePerformance } from "./sync-merge-performance.mjs";
// Review scenarios use the production Node HTTP routes, capture and real Git.
// Fixture preparation and diagnostic SQL are outside every timed interval.
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase, json, transaction } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { stateHash, protocolVersion } from "../server/sync/protocol.mjs";
import {
  DEFAULT_SETTINGS,
  defaultView,
  weeksForYear,
} from "../shared/domain.js";
import { unpack } from "../shared/compact.js";

async function drainCommands(site, teamId) {
  const store = site.app.locals.sync.store(teamId);
  let pending = store.readPending().length;
  while (pending) {
    await site.app.locals.sync.get(teamId).run();
    const remaining = store.readPending().length;
    if (remaining >= pending)
      throw new Error(
        `Benchmark publication made no progress: ${pending} -> ${remaining} commands`,
      );
    pending = remaining;
  }
}

async function joinPeer(fixture) {
  const db = openDatabase(join(fixture.dir, "review-peer.sqlite")),
    user = fixture.db
      .prepare("SELECT * FROM users ORDER BY rowid LIMIT 1")
      .get(),
    installationId = randomUUID(),
    token = randomUUID(),
    transport = new GitCliTransport({
      directory: join(fixture.dir, "review-peer.git"),
      repository: fixture.remote,
      allowLocal: true,
    });
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    fixture.teamId,
    "Review peer",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(user.id, user.username, user.name, user.created_at);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
    user.id,
    fixture.teamId,
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    user.id,
    Date.now() + 3600000,
  );
  const app = createApp({
      db,
      rateLimits: false,
      documentImagesDir: join(fixture.dir, "review-peer-images"),
      syncOptions: {
        installationId,
        schedule: false,
        profiles: [
          {
            profileId: "review-peer",
            teamId: fixture.teamId,
            repository: "local/benchmark",
          },
        ],
        transports: { "review-peer": transport },
      },
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const peer = {
    db,
    app,
    transport,
    async api(path, body, method = body ? "POST" : "GET") {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method,
          headers: {
            cookie: "weekly_session=" + token,
            "Content-Type": "application/json",
            "X-Requested-With": "WeeklyPlan",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const data = unpack(await response.json());
      if (!response.ok)
        throw new Error(JSON.stringify({ status: response.status, data }));
      return data;
    },
    async close() {
      await app.locals.sync.close();
      app.locals.cellEvents.close();
      app.locals.documentEvents.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
  try {
    const original = fixture.app.locals.sync.store(fixture.teamId).readLink();
    app.locals.sync.store(fixture.teamId).writeLink({
      ...Object.fromEntries(
        ["repo_id", "bootstrap_id", "writer_epoch", "updated_at"].map((key) => [
          key,
          original[key],
        ]),
      ),
      profile_id: "review-peer",
      installation_id: installationId,
      mode: "importing",
    });
    app.locals.sync.capture.refresh();
    let received = app.locals.sync
      .store(fixture.teamId)
      .readLink().canonical_head;
    while (received !== original.canonical_head) {
      await app.locals.sync.get(fixture.teamId).run({ receiveOnly: true });
      const next = app.locals.sync
        .store(fixture.teamId)
        .readLink().canonical_head;
      if (next === received)
        throw new Error("Benchmark peer receive made no progress");
      received = next;
    }
    if (
      stateHash(app.locals.sync.store(fixture.teamId).readState()) !==
      stateHash(fixture.app.locals.sync.store(fixture.teamId).readState())
    )
      throw new Error("Review peer did not import the same canonical state");
    return peer;
  } catch (error) {
    await peer.close();
    throw error;
  }
}

export async function measureReviewScenarios({
  performanceFixture,
  percentile,
  rounds = 30,
  clients = 30,
  rows = 1000,
  documents = 100,
  users = 1000,
  acknowledgedRows = 50000,
  includeBrowser = false,
  includeMerge = false,
  log = () => {},
}) {
  const workload = {
    basicFields: ["title", "owner", "status"],
    scheduleColumns: 0,
  };
  const f = await performanceFixture({
    ...workload,
    rows,
    secondaryRows: rows,
    clients,
    users,
    documents,
  });
  let peer, idleBaseline;
  const summarize = (samples) => ({
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples),
    maxMs: Math.max(...samples),
    rawMs: samples,
  });
  const measure = async (work, count = rounds) => {
    const samples = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await work(i);
      samples.push(performance.now() - start);
    }
    return summarize(samples);
  };
  const bulk = async (target = f) => {
    const week = weeksForYear(2026)[0].key,
      changes = target.taskIds.slice(0, 1000).flatMap((taskId, index) =>
        ["title", week].map((key) => ({
          taskId,
          key,
          expectedVersion:
            target.db
              .prepare("SELECT version FROM cells WHERE task_id=? AND key=?")
              .get(taskId, key)?.version || 0,
          value: "Review batch " + index + " " + randomUUID(),
        })),
      ),
      operationId = randomUUID(),
      start = performance.now();
    const result = await target.api("/cells/batch", {
      operationId,
      createdAt: new Date().toISOString(),
      changes,
    });
    if (result.cells.length !== changes.length)
      throw new Error("Bulk save omitted cells");
    return performance.now() - start;
  };
  try {
    log("C11: 1000-user unlinked baseline and 2000-cell batches");
    await f.measure(3);
    const initialUnlinked = await f.measure(rounds),
      baselineBulk = [];
    for (let i = 0; i < 5; i++) baselineBulk.push(await bulk());
    const secondaryBefore = await f.measure(rounds, {
      targetIds: f.secondary.taskIds,
    });
    f.setLink("initializing");
    await f.app.locals.sync.get(f.teamId).run({ initialize: true });
    log(
      "C11: linked idle, linked bulk and unlinked team in the linked database",
    );
    idleBaseline = await performanceFixture({
      ...workload,
      rows,
      secondaryRows: rows,
      clients,
      users,
      documents,
    });
    await idleBaseline.measure(3);
    await idleBaseline.measure(rounds);
    for (let i = 0; i < 5; i++) await bulk(idleBaseline);
    await idleBaseline.measure(rounds, {
      targetIds: idleBaseline.secondary.taskIds,
    });
    const pairedRuns = [],
      pairRounds = Math.max(1, Math.ceil(rounds / 3));
    for (let pair = 0; pair < 3; pair++) {
      const result = {
        order: pair % 2 ? "linked then unlinked" : "unlinked then linked",
      };
      for (const linked of pair % 2 ? [true, false] : [false, true]) {
        const target = linked ? f : idleBaseline;
        await target.measure(3);
        result[linked ? "linked" : "unlinked"] =
          await target.measure(pairRounds);
      }
      pairedRuns.push(result);
    }
    await idleBaseline.close();
    idleBaseline = null;
    const aggregate = (mode) => {
      const runs = pairedRuns.map((pair) => pair[mode]),
        saves = runs.flatMap((run) => run.timings.saves),
        sse = runs.flatMap((run) => run.timings.sse);
      return {
        samples: saves.length,
        saveP50Ms: percentile(saves, 0.5),
        saveP95Ms: percentile(saves),
        saveMaxMs: Math.max(...saves),
        commitToAllSseP95Ms: percentile(sse),
        eventLoopWorstRunP95Ms: Math.max(
          ...runs.map((run) => run.eventLoopP95Ms),
        ),
        rawSaveMs: saves,
      };
    };
    const unlinked = aggregate("unlinked"),
      linkedIdle = aggregate("linked"),
      linkedBulk = [];
    for (let i = 0; i < 5; i++) linkedBulk.push(await bulk());
    const secondaryAfter = await f.measure(rounds, {
      targetIds: f.secondary.taskIds,
    });
    const otherPending = f.db
      .prepare("SELECT COUNT(*) n FROM sync_outbox WHERE team_id=?")
      .get(f.secondary.teamId).n;
    if (otherPending)
      throw new Error("Unlinked team unexpectedly captured operations");
    await drainCommands(f, f.teamId);
    peer = await joinPeer(f);
    const path = `/teams/${f.teamId}/sync`,
      oldLink = f.app.locals.sync.store(f.teamId).readLink(),
      upgrade = {
        expectedHead: oldLink.canonical_head,
        expectedHash: stateHash(f.app.locals.sync.store(f.teamId).readState()),
        peersStopped: true,
      };
    await f.api(path + "/pause", {});
    await peer.api(path + "/pause", {});
    await f.api(path + "/upgrade", upgrade);
    await peer.api(path + "/upgrade", upgrade);
    const upgraded = f.app.locals.sync.store(f.teamId).readState();
    if (
      protocolVersion(upgraded) !== 2 ||
      stateHash(upgraded) !==
        stateHash(peer.app.locals.sync.store(f.teamId).readState())
    )
      throw new Error("Both paused sites must complete the same v2 upgrade");
    await f.api(path + "/resume", {});
    log(
      "C11: linked protocol-v2 report create and edit with 1000 tasks and 100 documents",
    );
    const reportIds = [],
      reportCreate = await measure(async (i) => {
        const result = await f.api("/reports", {
          teamId: f.teamId,
          year: 2026,
          name: "Review " + i,
          referenceDate: "2026-10-01",
          view: defaultView(2026),
          taskIds: f.taskIds,
        });
        reportIds.push(result.id);
      }, 3);
    let report = await f.api("/reports/" + reportIds[0]);
    const reportDocumentCount = f.db
      .prepare("SELECT COUNT(*) n FROM report_documents WHERE report_id=?")
      .get(reportIds[0]).n;
    if (report.tasks.length !== rows || reportDocumentCount !== documents)
      throw new Error("Report workload size did not match requested fixture");
    const reportEdit = await measure(async (i) => {
      const task = report.tasks[i % report.tasks.length];
      report = await f.api(
        "/reports/" + reportIds[0],
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
                  value: "Review report edit " + i,
                  expectedVersion: task.cells.title.version,
                },
              ],
            },
          ],
        },
        0,
        "PATCH",
      );
      if (
        report.tasks.find((row) => row.id === task.id).cells.title.value !==
        "Review report edit " + i
      )
        throw new Error("Report edit did not persist");
    });
    log("C11: retention-active task queries");
    const queryPath = `/tasks?teamId=${f.teamId}&year=2026`,
      queryBaseline = await measure(() => f.api(queryPath));
    f.db
      .prepare("INSERT INTO site_retention VALUES(?,?,?,?,?,?,?)")
      .run(
        f.teamId,
        f.app.locals.sync.installationId,
        "year",
        '["2025"]',
        "",
        1,
        new Date().toISOString(),
      );
    const retentionQuery = await measure(async () => {
      const data = await f.api(queryPath);
      if (data.tasks.length !== rows)
        throw new Error("Retention incorrectly hid retained-year tasks");
    });
    log("C11: remote metadata delta delivery to all subscribed clients");
    await drainCommands(f, f.teamId);
    await peer.api(path + "/resume", {});
    await peer.app.locals.sync.get(f.teamId).run();
    const target = (await peer.api(queryPath)).tasks[0],
      position = target.position + 0.25;
    const resetBefore = f.clientObservations.resets,
      requestsBefore = f.clientObservations.refetches;
    await peer.api(
      "/tasks/" + target.id,
      { updatedAt: target.updatedAt, position },
      "PATCH",
    );
    await peer.app.locals.sync.get(f.teamId).run();
    const receivedAt = performance.now();
    await f.app.locals.sync.get(f.teamId).run({ receiveOnly: true });
    const key = JSON.stringify([target.id, position]),
      deadline = Date.now() + 5000;
    while (
      (f.clientObservations.metadata.get(key) || 0) < clients &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const remoteMetadata = {
      clients,
      deliveredClients: f.clientObservations.metadata.get(key) || 0,
      snapshotResets: f.clientObservations.resets - resetBefore,
      snapshotRefetches: f.clientObservations.refetches - requestsBefore,
      receiveToAllClientsMs: performance.now() - receivedAt,
    };
    if (
      remoteMetadata.deliveredClients !== clients ||
      remoteMetadata.snapshotRefetches ||
      f.clientObservations.errors.length
    )
      throw new Error(
        "Remote task metadata caused a missing delta or snapshot storm: " +
          JSON.stringify(remoteMetadata),
      );
    let remoteBrowsers = null;
    if (includeBrowser) {
      log(
        "C11: remote metadata through 30 real Chromium app contexts and event brokers",
      );
      remoteBrowsers = await measureBrowserMetadata(f, peer, { clients });
    }
    if (includeMerge) log("A6: protocol-v2 bounded Markdown merge CPU");
    const mergeCpu = includeMerge ? runMergePerformance() : null;
    log("C11: status polling over large acknowledged outbox history");
    const statusBefore = await measure(() => f.api(path)),
      stamp = new Date().toISOString(),
      padding = "x".repeat(2048);
    transaction(f.db, () => {
      const insert = f.db.prepare(
        "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES(?,?,?,'acknowledged',?)",
      );
      for (let i = 0; i < acknowledgedRows; i++)
        insert.run(
          randomUUID(),
          f.teamId,
          JSON.stringify({ benchmark: padding }),
          stamp,
        );
    });
    const statusAfter = await measure(async () => {
      const status = await f.api(path);
      if (status.pending !== 0 || status.lastLocalSavedAt !== stamp)
        throw new Error("Status query returned incorrect outbox summary");
    });
    const degradationPercent =
      (linkedIdle.saveP95Ms / unlinked.saveP95Ms - 1) * 100;
    return {
      measuredAt: new Date().toISOString(),
      dataset: {
        tasks: rows,
        documents,
        users,
        clients,
        rounds,
        acknowledgedRows,
        initialPropertyCellsPerTask: workload.basicFields.length,
        initialScheduleCellsPerTask: 0,
        addedScheduleCellsPerTaskAfterBulk: 1,
      },
      linkedIdle: {
        initialUnlinked,
        pairedRuns,
        unlinked,
        linked: linkedIdle,
        degradationPercent,
      },
      bulk2000: {
        cells: Math.min(rows, 1000) * 2,
        unlinked: summarize(baselineBulk),
        linked: summarize(linkedBulk),
      },
      unlinkedTeamInLinkedDatabase: {
        before: secondaryBefore,
        after: secondaryAfter,
        capturedOperations: otherPending,
      },
      users1000: { users, unlinked, linked: linkedIdle },
      reportCreate: {
        ...reportCreate,
        tasks: rows,
        documents: reportDocumentCount,
        protocol: 2,
        upgradeHead: upgrade.expectedHead,
      },
      reportEdit: {
        ...reportEdit,
        tasks: rows,
        documents: reportDocumentCount,
      },
      retentionQuery: {
        baseline: queryBaseline,
        active: retentionQuery,
        retainedYear: 2026,
        excludedYear: 2025,
      },
      acknowledgedOutboxStatus: {
        addedRows: acknowledgedRows,
        payloadBytesPerRow: padding.length,
        before: statusBefore,
        after: statusAfter,
      },
      remoteTask30Clients: remoteMetadata,
      remoteTask30Browsers: remoteBrowsers,
      mergeCpu,
      acceptance: {
        linkedIdleSaveP95Within10Percent: degradationPercent <= 10,
        report1000Tasks100DocumentsEditUnder100Ms: reportEdit.maxMs < 100,
        browserMetadataWithoutSnapshotRefetch:
          !includeBrowser ||
          (remoteBrowsers.renderedClients === clients &&
            remoteBrowsers.taskSnapshotRequests === 0),
        metadataDeltaWithoutSnapshotRefetch:
          remoteMetadata.deliveredClients === clients &&
          remoteMetadata.snapshotRefetches === 0,
      },
      limitations: [
        includeBrowser
          ? "Thirty actual Chromium contexts verify application row order and broker delivery; unrelated periodic polling is paused during the metadata observation."
          : "Real browser measurement was not requested for this functional fixture run; HTTP SSE clients only.",
        "The acknowledged-history workload seeds diagnostic rows after all canonical synchronization work; it does not publish synthetic operations.",
        "Each latency includes loopback HTTP and response parsing. Preparation and diagnostic SQL are outside timed intervals.",
        "Idle save acceptance pools three alternating-order pairs of separate linked/unlinked SQLite fixtures with equal data sizes and the same API preparation sequence; individual requests arrive in concurrent client bursts, not independent repeats.",
      ],
    };
  } finally {
    await peer?.close();
    await idleBaseline?.close();
    await f.close();
  }
}
