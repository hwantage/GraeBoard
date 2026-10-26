import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  openDatabase,
  transaction,
  json,
  upsertCellStatement,
} from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import {
  DEFAULT_SETTINGS,
  sampleProperties,
  weeksForYear,
} from "../shared/domain.js";
import { unpack } from "../shared/compact.js";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

export const percentile = (samples, fraction = 0.95) =>
  samples.toSorted((a, b) => a - b)[
    Math.max(0, Math.ceil(samples.length * fraction) - 1)
  ] || 0;

export async function performanceFixture({
  rows = 10000,
  clients = 30,
  users = 100,
  secondaryRows = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-sync-perf-")),
    databasePath = join(dir, "data.sqlite"),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(databasePath),
    teamId = randomUUID(),
    documentId = randomUUID(),
    tokens = [],
    taskIds = [],
    stamp = new Date().toISOString();
  const secondary = secondaryRows
    ? {
        teamId: randomUUID(),
        taskIds: [],
        rows: secondaryRows,
        profileId: "benchmark-secondary",
        remote: join(dir, "secondary.git"),
      }
    : null;
  if (secondary)
    execFileSync("git", ["init", "--bare", secondary.remote], {
      stdio: "ignore",
    });
  const targets = [
    { teamId, taskIds, rows, profileId: "benchmark", remote },
    ...(secondary ? [secondary] : []),
  ];
  transaction(db, () => {
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      teamId,
      "Sync performance",
      json({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
    );
    if (secondary)
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        secondary.teamId,
        "Secondary performance",
        json({ ...DEFAULT_SETTINGS, properties: sampleProperties() }),
      );
    const ids = [];
    for (let i = 0; i < Math.max(users, clients); i++) {
      const id = randomUUID(),
        token = randomUUID();
      ids.push(id);
      tokens.push(token);
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
      ).run(id, "perf" + i, "검증" + i, stamp);
      for (const target of targets)
        db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
          id,
          target.teamId,
        );
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        id,
        Date.now() + 3600000,
      );
    }
    const add = db.prepare(
        "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ),
      cell = upsertCellStatement(db),
      weeks = weeksForYear(2026);
    for (const target of targets)
      for (let i = 0; i < target.rows; i++) {
        const id = randomUUID();
        target.taskIds.push(id);
        add.run(
          id,
          target.teamId,
          "[2026]",
          i,
          ids[i % ids.length],
          stamp,
          stamp,
        );
        for (const [key, value] of Object.entries({
          title: "업무 " + i,
          description: "한글 일정 성능 검증",
          owner: ids[i % ids.length],
          supporters: [],
          status: "status-progress",
          category: "category-ux",
        }))
          cell.run(id, key, value, {}, 1);
        for (let w = 0; w < 60; w++)
          if ((i * 7 + w) % 10 < 3)
            cell.run(
              id,
              weeks[w % weeks.length].key,
              "진행 · 검토",
              { backgroundColor: "#d1eee6" },
              1,
            );
      }
  });
  const documentTaskId = taskIds.at(-1),
    documentActor = db.prepare("SELECT id FROM users LIMIT 1").get().id;
  const versionId = storeDocumentVersion(db, {
    teamId,
    documentId: JSON.stringify(["task", documentTaskId, documentId]),
    markdown: "Baseline document",
    actorId: documentActor,
  });
  db.prepare(
    "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,0,?,1,1,?,?)",
  ).run(
    documentTaskId,
    documentId,
    "Baseline document",
    versionId,
    stamp,
    documentActor,
  );
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  if (secondary)
    secondary.transport = new GitCliTransport({
      directory: join(dir, "secondary-cache.git"),
      repository: secondary.remote,
      allowLocal: true,
    });
  const runtimeOptions = {
    installationId: randomUUID(),
    profiles: targets.map((target) => ({
      profileId: target.profileId,
      teamId: target.teamId,
      repository: "local/" + target.profileId,
    })),
    transports: {
      benchmark: transport,
      ...(secondary ? { "benchmark-secondary": secondary.transport } : {}),
    },
    schedule: false,
  };
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: runtimeOptions,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`,
    committed = new Map(),
    deliveries = new Map(),
    observedCells = new Map(),
    documentCommitted = new Map(),
    snapshotExpectations = new Map(),
    snapshotClients = new Map(),
    snapshotFailures = new Map(),
    controllers = [];
  const notify = app.locals.documentEvents.notify;
  app.locals.documentEvents.notify = (key) => {
    documentCommitted.set(key, performance.now());
    return notify.call(app.locals.documentEvents, key);
  };
  const publish = app.locals.cellEvents.publish;
  app.locals.cellEvents.publish = (result, tasks) => {
    committed.set(result.operationId, performance.now());
    return publish(result, tasks);
  };
  for (const target of targets)
    for (let i = 0; i < clients; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(
        `${origin}/api/cells/events?teamId=${target.teamId}&year=2026`,
        {
          headers: { cookie: "weekly_session=" + tokens[i] },
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error("SSE connection failed " + response.status);
      let buffer = "";
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (frame.includes("event: reset")) {
                for (const [operationId, expected] of snapshotExpectations) {
                  if (expected.teamId !== target.teamId) continue;
                  if (!snapshotClients.has(operationId))
                    snapshotClients.set(operationId, new Set());
                  const received = snapshotClients.get(operationId);
                  if (received.has(i)) continue;
                  received.add(i);
                  void fetch(
                    `${origin}/api/tasks?teamId=${target.teamId}&year=2026`,
                    { headers: { cookie: "weekly_session=" + tokens[i] } },
                  )
                    .then(async (response) => {
                      if (!response.ok)
                        throw new Error(
                          "Reset snapshot request failed " + response.status,
                        );
                      const snapshot = unpack(await response.json()),
                        tasks = new Map(
                          snapshot.tasks.map((task) => [task.id, task]),
                        );
                      if (
                        !expected.changes.every(
                          (change) =>
                            tasks.get(change.taskId)?.cells[change.key]
                              ?.value === change.value &&
                            tasks.get(change.taskId)?.cells[change.key]
                              ?.version >=
                              change.expectedVersion + 1,
                        )
                      )
                        throw new Error(
                          "Reset snapshot did not contain the committed bulk paste",
                        );
                      if (!deliveries.has(operationId))
                        deliveries.set(operationId, []);
                      deliveries
                        .get(operationId)
                        .push(performance.now() - committed.get(operationId));
                    })
                    .catch((error) =>
                      snapshotFailures.set(operationId, error.message),
                    );
                }
                continue;
              }
              if (!frame.includes("event: cells")) continue;
              const line = frame
                .split("\n")
                .find((v) => v.startsWith("data: "));
              const payload = unpack(JSON.parse(line.slice(6))),
                start = committed.get(payload.operationId);
              for (const cell of payload.cells || []) {
                const key = JSON.stringify([cell.taskId, cell.key, cell.value]);
                observedCells.set(key, (observedCells.get(key) || 0) + 1);
              }
              if (start !== undefined) {
                const times = deliveries.get(payload.operationId) || [];
                times.push(performance.now() - start);
                deliveries.set(payload.operationId, times);
              }
            }
          }
        } catch (error) {
          if (error.name !== "AbortError") throw error;
        }
      })();
    }
  const api = async (path, body, client = 0) => {
    const response = await fetch(origin + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: "weekly_session=" + tokens[client],
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = unpack(await response.json());
    if (!response.ok)
      throw new Error(JSON.stringify({ status: response.status, data }));
    return data;
  };
  let round = 0;
  async function measure(rounds = 10, { until, pauseMs = 0 } = {}) {
    const saves = [],
      operationIds = [];
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    for (let r = 0; r < rounds || (until && !until()); r++) {
      await Promise.all(
        Array.from({ length: clients }, async (_, i) => {
          const operationId = randomUUID(),
            taskId = taskIds[i % taskIds.length],
            expectedVersion = db
              .prepare(
                "SELECT version FROM cells WHERE task_id=? AND key='title'",
              )
              .get(taskId).version;
          const started = performance.now();
          await api(
            "/cells/batch",
            {
              operationId,
              createdAt: new Date().toISOString(),
              changes: [
                {
                  taskId,
                  key: "title",
                  value: `저장 ${round}-${i}`,
                  expectedVersion,
                },
              ],
            },
            i,
          );
          saves.push(performance.now() - started);
          operationIds.push(operationId);
        }),
      );
      round++;
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    const deadline = Date.now() + 5000;
    while (
      operationIds.some((id) => (deliveries.get(id)?.length || 0) < clients) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 5));
    lag.disable();
    if (operationIds.some((id) => (deliveries.get(id)?.length || 0) < clients))
      throw new Error("SSE delivery missing after committed save");
    const sse = operationIds.map((id) => Math.max(...deliveries.get(id)));
    const result = {
      samples: saves.length,
      saveP50Ms: percentile(saves, 0.5),
      saveP95Ms: percentile(saves),
      saveMaxMs: Math.max(...saves),
      commitToAllSseP95Ms: percentile(sse),
      commitToAllSseMaxMs: Math.max(...sse),
      eventLoopP95Ms: lag.percentile(95) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
    };
    Object.defineProperty(result, "timings", { value: { saves, sse } });
    return result;
  }
  const setLink = (mode, targetId = teamId) => {
    const target = targets.find((value) => value.teamId === targetId);
    const store = app.locals.sync.store(targetId),
      old = store.readLink();
    store.writeLink(
      old
        ? { mode }
        : {
            repo_id: randomUUID(),
            bootstrap_id: randomUUID(),
            installation_id: app.locals.sync.installationId,
            writer_epoch: randomUUID(),
            profile_id: target.profileId,
            mode,
            updated_at: stamp,
          },
    );
    app.locals.sync.capture.refresh();
  };
  async function close() {
    for (const c of controllers) c.abort();
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    dir,
    databasePath,
    secondary,
    runtimeOptions,
    deliveries,
    committed,
    remote,
    db,
    teamId,
    taskIds,
    documentId,
    documentTaskId,
    origin,
    tokens,
    controllers,
    observedCells,
    documentCommitted,
    snapshotExpectations,
    snapshotClients,
    snapshotFailures,
    app,
    transport,
    api,
    measure,
    setLink,
    close,
  };
}

export async function runTwoTeamPerformance({
  rows = 10000,
  secondaryRows = 1000,
  clients = 30,
  users = 100,
  rounds = 30,
  bulkValueBytes = 0,
  includeScheduled = true,
  log = () => {},
} = {}) {
  const fixture = await performanceFixture({
      rows,
      secondaryRows,
      clients,
      users,
    }),
    secondary = fixture.secondary;
  try {
    for (const teamId of [fixture.teamId, secondary.teamId])
      fixture.setLink("initializing", teamId);
    await Promise.all(
      [fixture.teamId, secondary.teamId].map((teamId) =>
        fixture.app.locals.sync.get(teamId).run({ initialize: true }),
      ),
    );
    let done = false,
      failure,
      bulkPaste;
    const start = performance.now(),
      operationId = randomUUID(),
      count = Math.min(2000, secondary.taskIds.length * 2),
      week = weeksForYear(2026)[0].key;
    const changes = Array.from({ length: count }, (_, index) => {
      const taskId = secondary.taskIds[Math.floor(index / 2)],
        key = index % 2 ? week : "title";
      return {
        taskId,
        key,
        expectedVersion:
          fixture.db
            .prepare("SELECT version FROM cells WHERE task_id=? AND key=?")
            .get(taskId, key)?.version || 0,
        value: "Two-team bulk " + index + "x".repeat(bulkValueBytes),
      };
    });
    const running = (async () => {
      const started = performance.now();
      fixture.snapshotExpectations.set(operationId, {
        teamId: secondary.teamId,
        changes,
      });
      const response = await fixture.api("/cells/batch", {
        operationId,
        createdAt: new Date().toISOString(),
        changes,
      });
      const deadline = Date.now() + 5000;
      while (
        (fixture.deliveries.get(operationId)?.length || 0) < clients &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (
        response.cells.length !== count ||
        (fixture.deliveries.get(operationId)?.length || 0) < clients
      )
        throw new Error(
          "Two-team bulk paste did not persist and reach all clients: " +
            (fixture.snapshotFailures.get(operationId) ||
              "missing delta or reset snapshot"),
        );
      fixture.snapshotExpectations.delete(operationId);
      bulkPaste = {
        cells: count,
        requestToResponseAndDeliveryMs: performance.now() - started,
        commitToAllClientsMs: Math.max(...fixture.deliveries.get(operationId)),
        deliveredClients: clients,
        resetRefetchClients:
          fixture.snapshotClients.get(operationId)?.size || 0,
        delivery:
          "cell SSE delta or size-limit reset followed by verified HTTP snapshot refetch",
      };
      await Promise.all(
        [fixture.teamId, secondary.teamId].map((teamId) =>
          fixture.app.locals.sync.get(teamId).run(),
        ),
      );
      if (fixture.app.locals.sync.store(secondary.teamId).readPending().length)
        throw new Error(
          "Secondary bulk paste was not acknowledged by the simultaneous sync run",
        );
      for (const [teamId, transport] of [
        [fixture.teamId, fixture.transport],
        [secondary.teamId, secondary.transport],
      ]) {
        if (
          fixture.app.locals.sync.store(teamId).readLink().canonical_head !==
          (await transport.readHead())
        )
          throw new Error("Two-team canonical and Git heads did not converge");
      }
    })()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        done = true;
      });
    const simultaneous = await fixture.measure(rounds, {
      until: () => done,
      pauseMs: 30,
    });
    await running;
    if (failure) throw failure;
    simultaneous.jobMs = performance.now() - start;
    simultaneous.bothTeamHeadsVerified = true;
    log({ twoTeamSimultaneous: simultaneous, bulkPaste });
    let scheduled = null;
    if (includeScheduled) {
      const started = performance.now(),
        cycles = { primary: [], secondary: [] };
      let runningCount = 0;
      for (const [name, teamId] of [
        ["primary", fixture.teamId],
        ["secondary", secondary.teamId],
      ]) {
        const service = fixture.app.locals.sync.get(teamId),
          run = service.run;
        service.run = async (options) => {
          const record = { startMs: performance.now() - started };
          runningCount++;
          try {
            const result = await run(options);
            record.busy = !!result?.busy;
            return result;
          } catch (error) {
            record.error = error.message;
            throw error;
          } finally {
            record.finishMs = performance.now() - started;
            runningCount--;
            cycles[name].push(record);
          }
        };
      }
      fixture.runtimeOptions.schedule = true;
      // No further writes target the secondary team, so its actual default
      // 60-second timer cannot be replaced by a save-debounce timer. Primary
      // team edits exercise the real 1.5-second debounce concurrently.
      fixture.app.locals.sync.schedule(fixture.teamId);
      fixture.app.locals.sync.schedule(secondary.teamId);
      scheduled = await fixture.measure(rounds, {
        pauseMs: 30,
        until: () => {
          const elapsed = performance.now() - started;
          if (elapsed > 180000)
            throw new Error(
              "Scheduled two-team performance exceeded its bounded observation period",
            );
          return (
            elapsed >= 65000 &&
            !runningCount &&
            cycles.primary.some((c) => !c.error && !c.busy) &&
            cycles.secondary.some((c) => !c.error && !c.busy)
          );
        },
      });
      Object.assign(scheduled, {
        durationMs: performance.now() - started,
        idleIntervalMs: 60000,
        saveDebounceMs: 1500,
        cycles,
        secondaryFirstStartMs: cycles.secondary[0]?.startMs,
      });
      if (
        scheduled.secondaryFirstStartMs < 59000 ||
        !cycles.secondary.length ||
        cycles.primary.some((c) => c.error) ||
        cycles.secondary.some((c) => c.error)
      )
        throw new Error(
          "Scheduled cycle timing or completion was not verified",
        );
      log({ scheduledTwoTeams: scheduled });
      fixture.runtimeOptions.schedule = false;
      fixture.setLink("paused");
      fixture.setLink("paused", secondary.teamId);
    }
    return {
      primaryTasks: rows,
      secondaryTasks: secondaryRows,
      sharedUsers: users,
      clientsPerTeam: clients,
      simultaneous,
      bulkPaste,
      scheduled,
    };
  } finally {
    await fixture.close();
  }
}

export async function runSyncPerformance({
  rows = 10000,
  clients = 30,
  rounds = 30,
  users = 100,
  log = () => {},
} = {}) {
  const fixture = await performanceFixture({ rows, clients, users });
  try {
    await fixture.measure(3);
    log("Measuring unlinked baseline");
    const baseline = await fixture.measure(rounds);
    log({ baseline });
    fixture.setLink("initializing");
    log("Measuring initial publication with concurrent internal saves");
    const started = performance.now();
    let initializationDone = false,
      initializationError;
    const initializing = fixture.app.locals.sync
      .get(fixture.teamId)
      .run({ initialize: true })
      .catch((error) => {
        initializationError = error;
      })
      .finally(() => (initializationDone = true));
    const bootstrap = await fixture.measure(rounds, {
      until: () => initializationDone,
      pauseMs: 30,
    });
    await initializing;
    if (initializationError) throw initializationError;
    bootstrap.jobMs = performance.now() - started;
    log({ bootstrap });
    async function duringJob(job, { allowFailure = false } = {}) {
      let done = false,
        failure;
      const started = performance.now(),
        running = Promise.resolve()
          .then(job)
          .catch((error) => {
            failure = error;
          })
          .finally(() => (done = true));
      const result = await fixture.measure(rounds, {
        until: () => done,
        pauseMs: 30,
      });
      await running;
      result.jobMs = performance.now() - started;
      if (failure && !allowFailure) throw failure;
      if (failure) result.error = failure.message;
      return result;
    }
    log("Measuring active synchronization through job completion");
    const active = await duringJob(() =>
      fixture.app.locals.sync.get(fixture.teamId).run(),
    );
    log({ active });
    log("Measuring Git failure through job completion");
    const { renameSync } = await import("node:fs");
    renameSync(fixture.remote, fixture.remote + ".offline");
    const offline = await duringJob(
      () => fixture.app.locals.sync.get(fixture.teamId).run(),
      { allowFailure: true },
    );
    renameSync(fixture.remote + ".offline", fixture.remote);
    if (!offline.error) throw new Error("Git failure scenario did not fail");
    log({ offline });
    log(
      "Measuring a delayed real Git upload-pack while internal saves continue",
    );
    const delayedScript = join(fixture.dir, "delayed-upload-pack"),
      delayedCalls = join(fixture.dir, "upload-pack-calls"),
      uploadPack = join(
        execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
        "git-upload-pack",
      ),
      quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(
      delayedScript,
      "#!/bin/sh\nprintf x >> " +
        quote(delayedCalls) +
        "\n/bin/sleep 3\nexec " +
        quote(uploadPack) +
        ' "$@"\n',
      { mode: 0o700 },
    );
    await fixture.transport.git([
      "config",
      "remote.origin.uploadpack",
      delayedScript,
    ]);
    let delayedGit;
    try {
      delayedGit = await duringJob(() =>
        fixture.app.locals.sync.get(fixture.teamId).run(),
      );
    } finally {
      await fixture.transport.git([
        "config",
        "--unset",
        "remote.origin.uploadpack",
      ]);
    }
    delayedGit.uploadPackInvocations = readFileSync(
      delayedCalls,
      "utf8",
    ).length;
    if (!delayedGit.uploadPackInvocations)
      throw new Error("Delayed real Git upload-pack was not exercised");
    delayedGit.delayPerInvocationMs = 3000;
    delayedGit.transport =
      "real local Git upload-pack with explicit 3s server-process delay; not a remote bandwidth measurement";
    log({ delayedGit });
    log(
      "Measuring actual Worker fault/retry scenario alongside independent internal availability",
    );
    let faultResult;
    const externalFaults = await duringJob(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["scripts/sync-fault-performance.mjs"],
            {
              cwd: process.cwd(),
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "",
            errors = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (errors += chunk));
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0)
              return reject(
                new Error("External fault fixture failed: " + errors),
              );
            try {
              faultResult = JSON.parse(output.trim());
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        }),
    );
    if (
      !faultResult?.verified ||
      !faultResult.pgUnavailable ||
      !faultResult.r2Unavailable ||
      faultResult.internalPerformanceCoupled !== false
    )
      throw new Error("External dependency faults were not verified");
    Object.assign(externalFaults, faultResult);
    log({ externalFaults });
    log("Measuring backup and synchronization through both completions");
    const backupConcurrent = await duringJob(async () => {
      const backup = new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["scripts/backup.mjs", join(fixture.dir, "backup.sqlite")],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DB_PATH: fixture.databasePath,
              DOCUMENT_IMAGES_DIR: join(fixture.dir, "images"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stderr.on("data", (b) => (output += b));
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Backup failed: " + output)),
        );
      });
      await Promise.all([
        backup,
        fixture.app.locals.sync.get(fixture.teamId).run(),
      ]);
    });
    log({ backupConcurrent });
    log(
      "Publishing an independent peer cell, document and 1000-document import",
    );
    const peer = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./sync-peer-performance.mjs", import.meta.url),
        {
          workerData: {
            databasePath: fixture.databasePath,
            teamId: fixture.teamId,
            taskId:
              fixture.taskIds[Math.min(clients, fixture.taskIds.length - 1)],
            documentTaskId: fixture.documentTaskId,
            documentId: fixture.documentId,
            documents: 1000,
            remote: fixture.remote,
            directory: join(fixture.dir, "peer.git"),
          },
        },
      );
      worker.once("message", (value) =>
        value.error ? reject(new Error(value.error)) : resolve(value),
      );
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code) reject(new Error("Independent peer exited " + code));
      });
    });
    const documentController = new AbortController();
    fixture.controllers.push(documentController);
    const response = await fetch(
      `${fixture.origin}/api/tasks/${peer.documentTaskId}/documents/${peer.documentId}/events`,
      {
        headers: { cookie: "weekly_session=" + fixture.tokens[0] },
        signal: documentController.signal,
      },
    );
    if (!response.ok) throw new Error("Peer document SSE subscription failed");
    let documentSeen = false,
      documentAt,
      buffer = "";
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = frame
              .split("\n")
              .find((value) => value.startsWith("data: "));
            if (line && frame.includes("event: document")) {
              const value = JSON.parse(line.slice(6));
              if (value.markdown === peer.documentValue) {
                documentSeen = true;
                documentAt = performance.now();
              }
            }
          }
        }
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    })();
    const inboundStarted = performance.now(),
      inbound = await duringJob(() =>
        fixture.app.locals.sync.get(fixture.teamId).run({ receiveOnly: true }),
      );
    const deadline = Date.now() + 5000;
    while (
      (!documentSeen ||
        (fixture.observedCells.get(
          JSON.stringify([peer.cellTaskId, "title", peer.cellValue]),
        ) || 0) < clients) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 5));
    const document = fixture.db
      .prepare(
        "SELECT v.markdown FROM task_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.task_id=? AND d.id=?",
      )
      .get(peer.documentTaskId, peer.documentId);
    if (
      fixture.app.locals.sync.store(fixture.teamId).readLink()
        .canonical_head !== peer.oid ||
      document?.markdown !== peer.documentValue ||
      !documentSeen ||
      (fixture.observedCells.get(
        JSON.stringify([peer.cellTaskId, "title", peer.cellValue]),
      ) || 0) < clients
    )
      throw new Error(
        "Independent peer head, DB, cell SSE or document SSE marker did not converge",
      );
    Object.assign(inbound, {
      peerHeadVerified: true,
      peerCellDeliveredToClients: clients,
      peerDocumentDelivered: true,
      peerDocumentSubscribers: 1,
      importedDocuments: peer.documents,
      commitToPeerDocumentSseMs:
        documentAt -
        fixture.documentCommitted.get(
          "task:" + peer.documentTaskId + ":" + peer.documentId,
        ),
      requestToPeerDocumentSseMs: documentAt - inboundStarted,
    });
    log({ inbound });
    log(
      "Measuring production capacity rejection and separate Node-only bulk PostgreSQL import through completion",
    );
    let imported;
    const initialImport = await duringJob(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["scripts/sync-import-performance.mjs"],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                SYNC_IMPORT_PERF_CONFIG: JSON.stringify({
                  teamId: fixture.teamId,
                  remote: fixture.remote,
                  rows,
                }),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "",
            errors = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (errors += chunk));
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0)
              return reject(
                new Error("External initial import failed: " + errors),
              );
            try {
              imported = JSON.parse(output.trim());
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        }),
    );
    if (
      !imported?.verified ||
      !imported.head ||
      imported.tasks !== rows ||
      imported.documents < 1001
    )
      throw new Error("External initial import completion was not verified");
    Object.assign(initialImport, imported);
    log({ initialImport });
    // Interleaved steady-state pair controls for warmup and accumulated audit
    // history instead of comparing only the first and last run of the process.
    const steadyPairs = [],
      unlinkedRuns = [],
      linkedRuns = [];
    for (let pair = 0; pair < 3; pair++) {
      const result = {
        order: pair % 2 ? "linked then unlinked" : "unlinked then linked",
      };
      for (const linked of pair % 2 ? [true, false] : [false, true]) {
        fixture.setLink(linked ? "active" : "disconnected");
        await fixture.measure(3);
        const measured = await fixture.measure(rounds);
        // Diagnostic reads occur after the segment's save/SSE/lag measurement.
        measured.afterSegment = {
          pendingCount: fixture.db
            .prepare(
              "SELECT COUNT(*) AS count FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
            )
            .get(fixture.teamId).count,
          databaseBytes: statSync(fixture.databasePath).size,
          walBytes:
            statSync(fixture.databasePath + "-wal", { throwIfNoEntry: false })
              ?.size || 0,
        };
        result[linked ? "linked" : "unlinked"] = measured;
        (linked ? linkedRuns : unlinkedRuns).push(measured);
      }
      steadyPairs.push(result);
    }
    const aggregate = (runs) => {
      const saves = runs.flatMap((run) => run.timings.saves),
        sse = runs.flatMap((run) => run.timings.sse);
      return {
        samples: saves.length,
        saveP50Ms: percentile(saves, 0.5),
        saveP95Ms: percentile(saves),
        saveMaxMs: Math.max(...saves),
        commitToAllSseP95Ms: percentile(sse),
        commitToAllSseMaxMs: Math.max(...sse),
        eventLoopWorstRunP95Ms: Math.max(
          ...runs.map((run) => run.eventLoopP95Ms),
        ),
        eventLoopMaxMs: Math.max(...runs.map((run) => run.eventLoopMaxMs)),
      };
    };
    const warmBaseline = aggregate(unlinkedRuns),
      linkedSteady = aggregate(linkedRuns);
    const degradationPercent =
      (linkedSteady.saveP95Ms / warmBaseline.saveP95Ms - 1) * 100;
    log({ steadyPairs, warmBaseline, linkedSteady, degradationPercent });
    log("Measuring two teams, a 2000-cell paste and actual scheduled cycles");
    const twoTeams = await runTwoTeamPerformance({
      rows,
      clients,
      users,
      rounds,
      log,
    });
    return {
      measuredAt: new Date().toISOString(),
      provenance: {
        sourceCommit:
          process.env.SYNC_PERF_SOURCE_COMMIT ||
          execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
        harnessCommit: process.env.SYNC_PERF_HARNESS_COMMIT || null,
        isolatedSnapshot: process.env.SYNC_PERF_ISOLATED === "1",
        harnessSha256: Object.fromEntries(
          [
            "scripts/sync-performance.mjs",
            "scripts/sync-fault-performance.mjs",
            "scripts/sync-peer-performance.mjs",
            "scripts/sync-import-performance.mjs",
            "tests/sync-performance.test.mjs",
          ].map((path) => [
            path,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
          ]),
        ),
      },
      environment: {
        node: process.version,
        cpu: cpus()[0].model,
        cores: cpus().length,
        memoryGB: Math.round(totalmem() / 1024 ** 3),
        transport:
          "loopback HTTP + SSE; local bare Git; separate SQLite reader worker",
      },
      dataset: {
        tasks: rows,
        users,
        concurrent: clients,
        scheduleColumns: 60,
        fillPercent: 30,
        initialDocuments: 1,
        rounds,
      },
      baseline,
      bootstrap,
      active,
      offline,
      delayedGit,
      externalFaults,
      backupConcurrent,
      inbound,
      initialImport,
      steadyPairs,
      // Expose the existing samples only after every timed phase has finished.
      // measure() keeps them non-enumerable so intermediate logging is unchanged.
      rawPairedTimings: steadyPairs.map((pair) => ({
        order: pair.order,
        burstSize: clients,
        sampleOrder:
          "HTTP completion order within each sequential Promise.all burst; save/SSE indices align",
        burstRanges: Array.from(
          { length: pair.unlinked.timings.saves.length / clients },
          (_, index) => ({
            burst: index + 1,
            startInclusive: index * clients,
            endExclusive: (index + 1) * clients,
          }),
        ),
        unlinked: {
          saveMs: pair.unlinked.timings.saves,
          commitToAllSseMs: pair.unlinked.timings.sse,
        },
        linked: {
          saveMs: pair.linked.timings.saves,
          commitToAllSseMs: pair.linked.timings.sse,
        },
      })),
      warmBaseline,
      linkedSteady,
      twoTeams,
      degradationPercent,
      acceptance: {
        saveP95DegradationWithin10Percent: degradationPercent <= 10,
        allCommitToSseP95Under1000Ms: [
          baseline,
          bootstrap,
          active,
          offline,
          delayedGit,
          externalFaults,
          backupConcurrent,
          inbound,
          initialImport,
          linkedSteady,
          twoTeams.simultaneous,
          twoTeams.scheduled,
        ].every((x) => x.commitToAllSseP95Ms < 1000),
        bulkPasteAllClientsUnder1000Ms:
          twoTeams.bulkPaste.commitToAllClientsMs < 1000,
      },
      limitations: [
        "Steady acceptance aggregates raw samples from three alternating-order paired runs; event-loop p95 is the worst constituent run.",
        "Paired requests are clustered in sequential client bursts, not independent repeats; default runs have 90 bursts of 30 requests per mode. afterSegment pending/database/WAL metadata is read outside the timed segment.",
        "Paired steady runs disable scheduling and measure capture-only overhead; separate two-team scheduled measurement uses actual 60s idle timers and 1.5s save debounce.",
        "Worker PG/R2 faults use a separate supported-size actual API/Cron fixture in parallel with the independent 10k internal server; they are not a coupled 10k remote outage.",
        "The 10k PostgreSQL import is explicitly Node-only adapter stress with raised internal test limits; production Worker capacity rejects this dataset before advancing its cursor.",
        "SSE arrival is measured at real HTTP clients; browser DOM paint is verified separately.",
        "This is a synthetic temporary database; no production database, remote or deployment is used.",
      ],
    };
  } finally {
    await fixture.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const rows = Number(process.env.SYNC_PERF_ROWS || 10000),
    rounds = Number(process.env.SYNC_PERF_ROUNDS || 30);
  const report = await runSyncPerformance({ rows, rounds, log: console.log });
  const path = resolve(
    process.env.SYNC_PERF_OUTPUT || "docs/validation/sync-performance.json",
  );
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
