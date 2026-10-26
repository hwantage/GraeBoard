// Actual document/cell HTTP isolation with a separate server process.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";

const script = fileURLToPath(import.meta.url),
  args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sourceRoot = resolve(flag("--source-root", process.cwd()));
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const epoch = () => performance.timeOrigin + performance.now();
const moduleAt = (file) => import(pathToFileURL(join(sourceRoot, file)).href);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
};
async function markdown(teamId, imageDirectory, kb, salt) {
  let text = "",
    i = 0;
  const images = [];
  while (text.length < kb * 1024) {
    text +=
      "## 제목 " +
      salt +
      "-" +
      i +
      "\n\n본문 " +
      "lorem ipsum dolor sit amet ".repeat(8) +
      "\n\n- 항목 **강조**\n";
    if (i % 10 === 0) {
      const color = createHash("sha256")
        .update(salt + i)
        .digest();
      const bytes = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: { r: color[0], g: color[1], b: color[2] },
        },
      })
        .webp({ lossless: true })
        .toBuffer();
      const sha256 = hash(bytes),
        url = "/api/document-images/" + teamId + "/" + sha256 + ".webp";
      writeFileSync(join(imageDirectory, teamId, sha256 + ".webp"), bytes);
      images.push({ url, sha256 });
      text += "![i](" + url + ")\n";
    }
    i++;
  }
  text = text.slice(0, kb * 1024 - 200);
  return {
    markdown: text,
    images: images.filter((image) => text.includes("![i](" + image.url + ")")),
  };
}

async function serverMain() {
  const kb = Number(flag("--kb", "64"));
  const artifactDirectory = resolve(flag("--case-directory", ""));
  mkdirSync(artifactDirectory, { recursive: true });
  const requestScope = new AsyncLocalStorage(),
    parseEvents = [],
    preparations = [];
  let measured = false,
    activeDocument = null;
  channel("graeboard.document-images.parse").subscribe((value) =>
    parseEvents.push({
      ...value,
      measured,
      activeDocument,
      request: requestScope.getStore() || null,
      atEpochMs: epoch(),
    }),
  );
  const [
    { openDatabase, json },
    { createApp },
    { DEFAULT_SETTINGS },
    { storeDocumentVersion },
    { SqliteDatabase },
    { allEntities },
    { emptyState },
  ] = await Promise.all([
    moduleAt("server/db.mjs"),
    moduleAt("server/app.mjs"),
    moduleAt("shared/domain.js"),
    moduleAt("server/document-storage.mjs"),
    moduleAt("server/storage/sqlite.mjs"),
    moduleAt("server/sync/entities.mjs"),
    moduleAt("server/sync/protocol.mjs"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "graeboard-doc-isolation-")),
    imageDirectory = join(dir, "images");
  const teamId = id(kb),
    userId = id(1),
    token = "doc-isolation-session",
    stamp = "2026-10-27T00:00:00.000Z";
  mkdirSync(join(imageDirectory, teamId), { recursive: true });
  const db = openDatabase(join(dir, "site.sqlite"));
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Document isolation",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "isolation@example.test", "Isolation", stamp);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    hash(token),
    userId,
    Date.now() + 3600000,
  );
  const task = db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  );
  const cell = db.prepare(
    "INSERT INTO cells(task_id,key,value,style_id,version) VALUES(?,'title',?,0,1)",
  );
  for (let i = 0; i < 15; i++) {
    task.run(id(1000 + i), teamId, "[2026]", i, userId, stamp, stamp);
    cell.run(id(1000 + i), JSON.stringify("Task " + i));
  }
  const documents = [];
  for (let i = 0; i < 11; i++) {
    const payload = await markdown(teamId, imageDirectory, kb, "base-" + i);
    const taskId = id(1000 + i),
      documentId = id(2000 + i);
    const versionId = storeDocumentVersion(db, {
      teamId,
      documentId: taskId + ":" + documentId,
      markdown: payload.markdown,
      actorId: userId,
    });
    db.prepare(
      "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,0,?,1,1,?,?)",
    ).run(taskId, documentId, "Document " + i, versionId, stamp, userId);
    const file = join(artifactDirectory, "seed-" + i + ".md");
    writeFileSync(file, payload.markdown);
    documents.push({
      index: i,
      taskId,
      documentId,
      path: "/api/tasks/" + taskId + "/documents/" + documentId,
      revision: 1,
      initialFile: file,
      initialSha256: hash(payload.markdown),
      initialBytes: Buffer.byteLength(payload.markdown),
    });
  }
  const requests = [];
  for (const [position, index] of [
    ...Array.from({ length: 11 }, (_, i) => i),
    0,
  ].entries()) {
    const payload = await markdown(
      teamId,
      imageDirectory,
      kb,
      "save-" + position,
    );
    const file = join(artifactDirectory, "request-" + position + ".md");
    writeFileSync(file, payload.markdown);
    requests.push({
      position,
      index,
      phase:
        position === 0
          ? "cold-persisted"
          : position === 11
            ? "working-set-revisit"
            : "working-set-fill",
      file,
      sha256: hash(payload.markdown),
      characters: payload.markdown.length,
      bytes: Buffer.byteLength(payload.markdown),
      images: payload.images,
    });
  }
  const link = {
    team_id: teamId,
    repo_id: id(10),
    bootstrap_id: id(11),
    installation_id: id(12),
    writer_epoch: id(13),
    profile_id: "isolation",
    mode: "paused",
    canonical_head: "a".repeat(40),
    updated_at: stamp,
  };
  new SqliteDatabase(db).withTeamTransaction(teamId, (tx) => {
    const { team_id, ...fields } = link;
    tx.sync.writeLink(fields);
    tx.sync.writeState(
      { ...emptyState(), entities: allEntities(db, link) },
      link.canonical_head,
    );
  });
  assert.equal(
    parseEvents.length,
    0,
    "Persisted document setup must not prime the image parser",
  );
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: imageDirectory,
    syncOptions: {
      installationId: link.installation_id,
      schedule: false,
      onDocumentPrepared: (value) =>
        preparations.push({ activeDocument, ...value }),
    },
  });
  assert.equal(
    parseEvents.length,
    0,
    "Application construction must not prime seeded image documents",
  );
  const writes = [],
    publications = [];
  const originalExec = db.exec.bind(db);
  let writeStarted;
  db.exec = (sql) => {
    if (measured && /^BEGIN IMMEDIATE\b/.test(sql))
      writeStarted = {
        atEpochMs: epoch(),
        request: requestScope.getStore() || null,
        activeDocument,
      };
    try {
      return originalExec(sql);
    } finally {
      if (measured && writeStarted && /^(COMMIT|ROLLBACK)\b/.test(sql)) {
        writes.push({
          ...writeStarted,
          durationMs: epoch() - writeStarted.atEpochMs,
          outcome: sql,
        });
        writeStarted = null;
      }
    }
  };
  const publish = app.locals.cellEvents.publish;
  app.locals.cellEvents.publish = function (result, tasks) {
    if (measured)
      publications.push({
        operationId: result.operationId,
        atEpochMs: epoch(),
      });
    return publish.call(this, result, tasks);
  };
  const server = createServer((req, res) =>
    requestScope.run({ method: req.method, path: req.url.split("?")[0] }, () =>
      app(req, res),
    ),
  );
  server.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const lag = monitorEventLoopDelay({ resolution: 5 });
  let documentLag;
  process.send({
    type: "ready",
    kb,
    token,
    teamId,
    port: server.address().port,
    documents,
    requests,
    seedParserCalls: parseEvents.length,
    workingSetBytes: documents.reduce(
      (sum, document) => sum + document.initialBytes,
      0,
    ),
    cells: Array.from({ length: 4 }, (_, i) => ({
      taskId: id(1011 + i),
      version: 1,
      saves: 0,
    })),
  });
  process.on(
    "message",
    async ({ requestId, kind, position, expectedCells, expectedDocuments }) => {
      try {
        if (kind === "start") {
          measured = true;
          lag.enable();
          process.send({ requestId, value: { startedAtEpochMs: epoch() } });
        } else if (kind === "document-start") {
          activeDocument = position;
          documentLag = monitorEventLoopDelay({ resolution: 5 });
          documentLag.enable();
          await delay(10);
          process.send({ requestId, value: { startedAtEpochMs: epoch() } });
        } else if (kind === "document-end") {
          await delay(10);
          documentLag.disable();
          process.send({
            requestId,
            value: {
              eventLoopMaxMs: documentLag.max / 1e6,
              eventLoopP95Ms: documentLag.percentile(95) / 1e6,
            },
          });
          activeDocument = null;
        } else if (kind === "finish") {
          await delay(20);
          measured = false;
          lag.disable();
          for (const value of expectedCells)
            assert.equal(
              db
                .prepare(
                  "SELECT value FROM cells WHERE task_id=? AND key='title'",
                )
                .get(value.taskId).value,
              JSON.stringify(value.value),
            );
          for (const value of expectedDocuments) {
            const body = db
              .prepare(
                "SELECT v.markdown,d.revision FROM task_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.task_id=? AND d.id=?",
              )
              .get(value.taskId, value.documentId);
            assert.equal(hash(body.markdown), value.sha256);
            assert.equal(body.revision, value.revision);
          }
          const pending = app.locals.sync.store(teamId).readPending();
          assert.equal(
            pending.length,
            expectedCells.reduce((sum, value) => sum + value.saves, 0) + 12,
          );
          assert.equal(
            app.locals.sync.store(teamId).readLink().canonical_head,
            link.canonical_head,
          );
          for (const input of requests)
            for (const image of input.images) {
              const bytes = readFileSync(
                join(imageDirectory, teamId, image.sha256 + ".webp"),
              );
              assert.equal(hash(bytes), image.sha256);
              assert.equal((await sharp(bytes).metadata()).format, "webp");
            }
          process.send({
            requestId,
            value: {
              writes,
              publications,
              parseEvents,
              preparations,
              eventLoop: {
                p95Ms: lag.percentile(95) / 1e6,
                maxMs: lag.max / 1e6,
              },
              pendingCount: pending.length,
              correctness: {
                cellValuesPreserved: true,
                allDocumentValuesAndRevisionsMatch: true,
                allOperationsPending: true,
                canonicalHeadUnchanged: true,
                allImagesValidAndHashMatched: true,
              },
            },
          });
        } else if (kind === "stop") {
          await app.locals.documentPreparation?.close?.();
          await app.locals.sync.close();
          app.locals.cellEvents.close();
          app.locals.documentEvents.close();
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
          db.close();
          rmSync(dir, { recursive: true, force: true });
          process.send({ requestId, value: { stopped: true } }, () =>
            process.disconnect(),
          );
        }
      } catch (error) {
        process.send({ requestId, error: error.stack });
      }
    },
  );
}

async function measureCase(kb, directory) {
  const child = fork(
    script,
    [
      "--server",
      "--source-root",
      sourceRoot,
      "--kb",
      String(kb),
      "--case-directory",
      directory,
    ],
    { cwd: sourceRoot, stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  const waiters = new Map();
  let readyResolve,
    readyReject,
    sequence = 0,
    stopped = false;
  const ready = new Promise((done, reject) => {
    readyResolve = done;
    readyReject = reject;
  });
  child.on("message", (message) => {
    if (message.type === "ready") readyResolve(message);
    else if (waiters.has(message.requestId)) {
      const waiter = waiters.get(message.requestId);
      waiters.delete(message.requestId);
      message.error
        ? waiter.reject(new Error(message.error))
        : waiter.done(message.value);
    }
  });
  child.on("error", readyReject);
  const exit = new Promise((done) =>
    child.once("exit", (code, signal) => {
      if (!stopped) {
        const error = new Error("Server exited " + code + "/" + signal);
        readyReject(error);
        for (const waiter of waiters.values()) waiter.reject(error);
      }
      done({ code, signal });
    }),
  );
  const rpc = (kind, extra = {}) =>
    new Promise((done, reject) => {
      const requestId = ++sequence;
      waiters.set(requestId, { done, reject });
      child.send({ requestId, kind, ...extra });
    });
  const abort = new AbortController(),
    watchdog = setTimeout(() => child.kill("SIGKILL"), 180000);
  const report = { kbParameter: kb, status: "running" };
  let saving = false,
    writers = [],
    pumps = [];
  try {
    const fixture = await ready;
    report.fixture = fixture;
    const { unpack, parseCompact } = await moduleAt("shared/compact.js");
    const origin = "http://127.0.0.1:" + fixture.port;
    const api = async (path, body, method = "POST") => {
      const startEpochMs = epoch();
      const response = await fetch(origin + path, {
        method,
        headers: {
          Cookie: "weekly_session=" + fixture.token,
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = unpack(await response.json());
      return {
        status: response.status,
        data,
        startEpochMs,
        endEpochMs: epoch(),
        durationMs: epoch() - startEpochMs,
      };
    };
    const events = [];
    let streamReady = 0,
      streamFailure;
    for (let client = 0; client < 4; client++) {
      const response = await fetch(
        origin + "/api/cells/events?teamId=" + fixture.teamId + "&year=2026",
        {
          headers: { Cookie: "weekly_session=" + fixture.token },
          signal: abort.signal,
        },
      );
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      pumps.push(
        (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const value = await reader.read();
              if (value.done) break;
              buffer += decoder.decode(value.value, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const type = frame.match(/^event: (.+)$/m)?.[1];
                if (type === "ready") streamReady++;
                if (type === "cells")
                  events.push({
                    client,
                    atEpochMs: epoch(),
                    data: parseCompact(frame.match(/^data: (.+)$/m)[1]),
                  });
              }
            }
          } catch (error) {
            if (!abort.signal.aborted) streamFailure = error;
          }
        })(),
      );
    }
    for (let n = 0; streamReady < 4 && n < 300; n++) await delay(10);
    assert.equal(streamReady, 4);
    report.measurementStart = await rpc("start");
    const saves = [],
      expectedCells = fixture.cells,
      expectedDocuments = new Map();
    let writerFailure;
    saving = true;
    writers = expectedCells.map(async (cell, client) => {
      try {
        while (saving) {
          const operationId = randomUUID(),
            value = "cell-" + client + "-" + cell.saves;
          const result = await api("/api/cells/batch", {
            operationId,
            createdAt: new Date().toISOString(),
            changes: [
              {
                taskId: cell.taskId,
                key: "title",
                expectedVersion: cell.version,
                value,
              },
            ],
          });
          assert.equal(result.status, 200, JSON.stringify(result));
          cell.version = result.data.cells[0].version;
          cell.value = value;
          cell.saves++;
          saves.push({ client, operationId, ...result });
          await delay(10);
        }
      } catch (error) {
        writerFailure = error;
        saving = false;
      }
    });
    await delay(50);
    report.documents = [];
    for (const input of fixture.requests) {
      await rpc("document-start", { position: input.position });
      const document = fixture.documents[input.index],
        body = readFileSync(input.file, "utf8");
      const result = await api(
        document.path,
        {
          markdown: body,
          expectedRevision: document.revision,
          operationId: randomUUID(),
        },
        "PUT",
      );
      assert.equal(result.status, 200, JSON.stringify(result).slice(0, 500));
      document.revision = result.data.revision;
      const loop = await rpc("document-end");
      const read = await api(document.path, null, "GET");
      assert.equal(read.status, 200);
      assert.equal(read.data.markdown, body);
      assert.equal(read.data.revision, document.revision);
      expectedDocuments.set(input.index, {
        taskId: document.taskId,
        documentId: document.documentId,
        revision: document.revision,
        sha256: input.sha256,
      });
      report.documents.push({
        ...input,
        path: document.path,
        request: {
          startEpochMs: result.startEpochMs,
          endEpochMs: result.endEpochMs,
          durationMs: result.durationMs,
          status: result.status,
          revision: result.data.revision,
        },
        ...loop,
      });
      if (writerFailure) throw writerFailure;
    }
    await delay(100);
    saving = false;
    await Promise.all(writers);
    if (writerFailure) throw writerFailure;
    for (
      let n = 0;
      n < 300 &&
      !saves.every(
        (save) =>
          events.filter((event) => event.data.operationId === save.operationId)
            .length === 4,
      );
      n++
    )
      await delay(10);
    if (streamFailure) throw streamFailure;
    for (const save of saves) {
      const delivered = events.filter(
        (event) => event.data.operationId === save.operationId,
      );
      assert.equal(new Set(delivered.map((event) => event.client)).size, 4);
      for (const event of delivered)
        assert.deepEqual(event.data.cells, save.data.cells);
    }
    report.server = await rpc("finish", {
      expectedCells,
      expectedDocuments: [...expectedDocuments.values()],
    });
    report.saves = saves;
    report.sseEvents = events;
    report.cellHttp = stats(saves.map((save) => save.durationMs));
    const committed = new Map(
      report.server.publications.map((entry) => [
        entry.operationId,
        entry.atEpochMs,
      ]),
    );
    report.commitToAllSse = stats(
      saves.map(
        (save) =>
          Math.max(
            ...events
              .filter((event) => event.data.operationId === save.operationId)
              .map((event) => event.atEpochMs),
          ) - committed.get(save.operationId),
      ),
    );
    for (const document of report.documents) {
      const started = saves.filter(
        (save) =>
          save.startEpochMs >= document.request.startEpochMs &&
          save.startEpochMs <= document.request.endEpochMs,
      );
      const overlapping = saves.filter(
        (save) =>
          save.startEpochMs <= document.request.endEpochMs &&
          save.endEpochMs >= document.request.startEpochMs,
      );
      document.cellSavesStartedDuring = stats(
        started.map((save) => save.durationMs),
      );
      document.cellSavesOverlapping = stats(
        overlapping.map((save) => save.durationMs),
      );
      document.mainThreadAstParses = report.server.parseEvents.filter(
        (event) => event.measured && event.activeDocument === document.position,
      ).length;
      document.writerSpans = report.server.writes.filter(
        (entry) =>
          entry.request?.method === "PUT" &&
          entry.request.path === document.path &&
          entry.atEpochMs >= document.request.startEpochMs &&
          entry.atEpochMs <= document.request.endEpochMs,
      );
      assert.ok(
        document.writerSpans.length,
        "Document writer request context recorded",
      );
      document.maxDocumentWriteMs = Math.max(
        ...document.writerSpans.map((entry) => entry.durationMs),
      );
      assert.ok(
        overlapping.length >= 4,
        "Normal cell requests genuinely overlap each document request",
      );
    }
    report.mainThreadAstParses = report.server.parseEvents.filter(
      (event) => event.measured,
    ).length;
    report.correctness = {
      ...report.server.correctness,
      allOrdinarySavesDeliveredToAllClients: true,
      actualDocumentReadbacksMatch: true,
      allDocumentRequestsOverlapCellSaves: true,
    };
    if (args.includes("--expect-isolated"))
      assert.equal(
        report.mainThreadAstParses,
        0,
        "Cold/working-set image AST extraction must not run on the main thread",
      );
    abort.abort();
    await Promise.all(pumps);
    stopped = true;
    await rpc("stop");
    report.childExit = await exit;
    assert.equal(report.childExit.code, 0);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    saving = false;
    abort.abort();
    child.kill("SIGTERM");
    await exit;
    await Promise.allSettled(writers);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

function sourceHashes() {
  const files = ["package-lock.json"];
  const walk = (relative) => {
    for (const entry of readdirSync(join(sourceRoot, relative), {
      withFileTypes: true,
    })) {
      const file = join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(mjs|js)$/.test(file)) files.push(file);
    }
  };
  for (const folder of ["server", "shared", "worker"]) walk(folder);
  return Object.fromEntries(
    files
      .sort()
      .map((file) => [file, hash(readFileSync(join(sourceRoot, file)))]),
  );
}
async function main() {
  const output = resolve(
    flag("--output", "docs/validation/document-isolation.json"),
  );
  assert.equal(existsSync(output), false, "Refusing to overwrite evidence");
  mkdirSync(dirname(output), { recursive: true });
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    declaredSourceCommit: flag("--source-commit", null),
    sourceRoot,
    node: process.version,
    harnessSha256: hash(readFileSync(script)),
    sourceHashes: sourceHashes(),
    expectedMainThreadIsolation: args.includes("--expect-isolated"),
    scope: [
      "Separate HTTP server process and independent parent client, four ordinary cell writers and four dedicated SSE readers.",
      "Per size:11 parser-cold persisted documents, focal doc0 update,10 other distinct document updates, then doc0 revisit. All12 document requests and every normal save/SSE sample retained.",
      "11 documents exceed the default8-entry cache;240-size initial working set also exceeds2MiB UTF-8, with larger retained JS string storage. Revisit is a working-set stress case; worker diagnostics establish actual cache miss when available.",
      "Image Markdown matches earlier paragraph cadence/JS-length generator; actual bytes and hashes retained. Files are real deterministic WebP with matching hashes.",
      "Main-thread parser calls counted through existing diagnostics_channel; server loop and actual request-scoped BEGIN→COMMIT spans recorded. No production/cloud/Git publication.",
    ],
    cases: [],
    status: "running",
  };
  try {
    for (const kb of [64, 240]) {
      const directory = output.replace(/\.json$/, "") + "-" + kb;
      assert.equal(existsSync(directory), false);
      mkdirSync(directory, { recursive: true });
      const result = await measureCase(kb, directory);
      report.cases.push(result);
      console.log(
        JSON.stringify({
          kb,
          status: result.status,
          cellHttp: result.cellHttp,
          sse: result.commitToAllSse,
          eventLoop: result.server?.eventLoop,
          mainThreadAstParses: result.mainThreadAstParses,
          focal: result.documents?.filter(
            (document) => document.phase !== "working-set-fill",
          ),
          error: result.error,
        }),
      );
      if (result.status !== "passed") throw new Error(result.error);
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({ output, status: report.status, error: report.error }),
    );
  }
}
if (args.includes("--server"))
  serverMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  });
else
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
