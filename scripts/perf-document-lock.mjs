// Narrow document PUT/write-transaction benchmark. Synthetic temporary data only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const moduleAt = (path) => import(pathToFileURL(join(sourceRoot, path)).href);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs:
      sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    maxMs: sorted.at(-1),
  };
};
const relevantFiles = [
  "server/app.mjs",
  "server/db.mjs",
  "server/document-images.mjs",
  "server/document-storage.mjs",
  "server/document-events.mjs",
  "server/task-documents.mjs",
  "server/document-business-routes.mjs",
  "server/storage/document-service.mjs",
  "server/storage/sqlite-documents.mjs",
  "server/sync/capture.mjs",
  "server/sync/protocol.mjs",
  "server/sync/entities.mjs",
  "shared/document-image-references.js",
  "shared/document-images.js",
  "shared/task-documents.js",
  "package-lock.json",
];

// Same paragraph/image cadence and JS-length truncation as r3-doc-lock.test.mjs.
async function markdown(teamId, imageDirectory, kb, salt) {
  mkdirSync(join(imageDirectory, teamId), { recursive: true });
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
      images.push({ url, sha256, bytes: bytes.length });
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

async function caseMain() {
  const kb = Number(flag("--kb", "64")),
    linked = flag("--linked", "false") === "true",
    persistedBase = args.includes("--persisted-base");
  const outputDir = resolve(
    flag("--case-directory", "docs/validation/document-lock-case"),
  );
  mkdirSync(outputDir, { recursive: true });
  const [
    { openDatabase, json },
    { createApp },
    { DEFAULT_SETTINGS },
    { unpack },
    { GitCliTransport },
  ] = await Promise.all([
    moduleAt("server/db.mjs"),
    moduleAt("server/app.mjs"),
    moduleAt("shared/domain.js"),
    moduleAt("shared/compact.js"),
    moduleAt("server/sync/git-cli.mjs"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "graeboard-document-lock-")),
    imageDirectory = join(dir, "images"),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const teamId =
      "00000000-0000-4000-8000-" +
      String(kb * 10 + Number(linked)).padStart(12, "0"),
    userId = "00000000-0000-4000-8000-000000000001",
    token = "document-lock-session";
  const db = openDatabase(join(dir, "site.sqlite")),
    stamp = "2026-10-27T00:00:00.000Z";
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Document benchmark",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "benchmark@example.test", "Benchmark", stamp);
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    hash(token),
    userId,
    Date.now() + 3600000,
  );
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: imageDirectory,
    syncOptions: {
      installationId: "00000000-0000-4000-8000-000000000002",
      profiles: [
        { profileId: "benchmark", teamId, repository: "test/document-lock" },
      ],
      transports: {
        benchmark: new GitCliTransport({
          directory: join(dir, "cache.git"),
          repository: remote,
          allowLocal: true,
        }),
      },
      schedule: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const origin = "http://127.0.0.1:" + server.address().port;
  const api = async (path, body, method = body ? "POST" : "GET") => {
    const start = performance.now();
    const response = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Cookie: "weekly_session=" + token,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: unpack(await response.json()),
      durationMs: performance.now() - start,
    };
  };
  const report = {
    kbParameter: kb,
    linked,
    persistedBase,
    teamId,
    calls: [],
    status: "running",
    pid: process.pid,
    node: process.version,
  };
  try {
    if (linked) {
      const connection = await api(
        "/admin/teams/" + teamId + "/connection",
        { profileId: "benchmark", expectedRevision: 0 },
        "PUT",
      );
      assert.equal(connection.status, 200, JSON.stringify(connection));
      report.linkMode = app.locals.sync.store(teamId).readLink().mode;
      assert.equal(report.linkMode, "paused");
    } else report.linkMode = "unlinked";
    const created = await api("/tasks", {
      teamId,
      year: 2026,
      fields: { title: "document benchmark" },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const taskId = created.data.task.id,
      path = "/tasks/" + taskId + "/document";
    const originalExec = db.exec.bind(db);
    let measuring = false,
      writeStarted = null,
      transactions = [];
    db.exec = (sql) => {
      if (measuring && /^BEGIN IMMEDIATE\b/.test(sql))
        writeStarted = performance.now();
      try {
        return originalExec(sql);
      } finally {
        if (
          measuring &&
          writeStarted !== null &&
          /^(COMMIT|ROLLBACK)\b/.test(sql)
        ) {
          transactions.push({
            durationMs: performance.now() - writeStarted,
            outcome: sql,
          });
          writeStarted = null;
        }
      }
    };
    let revision = 0,
      basePayload;
    if (persistedBase) {
      basePayload = await markdown(teamId, imageDirectory, kb, "cold-base");
      writeFileSync(join(outputDir, "persisted-base.md"), basePayload.markdown);
      const { storeDocumentVersion } = await moduleAt(
        "server/document-storage.mjs",
      );
      app.locals.sync.capture.without(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const versionId = storeDocumentVersion(db, {
            teamId,
            documentId: taskId + ":main",
            markdown: basePayload.markdown,
            actorId: userId,
          });
          db.prepare(
            "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,'main','문서 1',0,?,1,1,?,?)",
          ).run(taskId, versionId, stamp, userId);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      revision = 1;
      report.persistedBaseInput = {
        seededWithoutImageParser: true,
        markdownFile: "persisted-base.md",
        markdownSha256: hash(basePayload.markdown),
        characters: basePayload.markdown.length,
        utf8Bytes: Buffer.byteLength(basePayload.markdown),
        imageCount: basePayload.images.length,
      };
    }
    const payloads = [];
    for (let round = 0; round < 6; round++) {
      const payload = await markdown(teamId, imageDirectory, kb, "r" + round);
      payloads.push(payload);
      const name = "body-" + (round + 1) + ".md";
      writeFileSync(join(outputDir, name), payload.markdown);
      transactions = [];
      const lag = monitorEventLoopDelay({ resolution: 5 });
      lag.enable();
      await delay(10);
      measuring = true;
      let saved;
      try {
        saved = await api(
          path,
          {
            markdown: payload.markdown,
            expectedRevision: revision,
            operationId: randomUUID(),
          },
          "PUT",
        );
      } finally {
        measuring = false;
      }
      await delay(10);
      lag.disable();
      assert.equal(saved.status, 200, JSON.stringify(saved).slice(0, 400));
      assert.ok(saved.data.revision > revision);
      revision = saved.data.revision;
      assert.ok(transactions.length > 0);
      assert.ok(transactions.every((tx) => tx.outcome === "COMMIT"));
      const read = await api(path);
      assert.equal(read.status, 200, JSON.stringify(read).slice(0, 400));
      assert.equal(read.data.markdown, payload.markdown);
      assert.equal(read.data.revision, revision);
      report.calls.push({
        round: round + 1,
        cold: round === 0,
        changedBody: true,
        markdownFile: name,
        characters: payload.markdown.length,
        utf8Bytes: Buffer.byteLength(payload.markdown),
        markdownSha256: hash(payload.markdown),
        imageCount: payload.images.length,
        images: payload.images,
        status: saved.status,
        revision,
        httpMs: saved.durationMs,
        transactions,
        maxWriteTransactionMs: Math.max(
          ...transactions.map((tx) => tx.durationMs),
        ),
        eventLoopP95Ms: lag.percentile(95) / 1e6,
        eventLoopMaxMs: lag.max / 1e6,
      });
    }
    assert.equal(
      new Set(report.calls.map((call) => call.markdownSha256)).size,
      6,
    );
    // Parse only after all six measured saves, avoiding extra parser warmup.
    const { documentImageUrls } = await moduleAt(
      "shared/document-image-references.js",
    );
    for (const payload of [
      ...(basePayload ? [basePayload] : []),
      ...payloads,
    ]) {
      assert.deepEqual(
        [...documentImageUrls(payload.markdown)].sort(),
        [...new Set(payload.images.map((image) => image.url))].sort(),
      );
      for (const image of payload.images) {
        const bytes = readFileSync(
          join(imageDirectory, teamId, image.sha256 + ".webp"),
        );
        assert.equal(hash(bytes), image.sha256);
        assert.equal((await sharp(bytes).metadata()).format, "webp");
      }
    }
    const image = payloads.at(-1).images[0];
    const response = await fetch(origin + image.url, {
      headers: { Cookie: "weekly_session=" + token },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/webp/);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), image.sha256);
    const pending = db
      .prepare("SELECT payload FROM sync_outbox ORDER BY local_seq")
      .all()
      .map((row) => JSON.parse(row.payload));
    const documentChanges = pending
      .flatMap((op) => op.changes)
      .filter((change) => change.entity === "document");
    assert.equal(documentChanges.length, linked ? 6 : 0);
    if (linked)
      for (let round = 0; round < 6; round++)
        assert.equal(
          documentChanges[round].desired.markdown,
          payloads[round].markdown,
        );
    report.pendingCount = pending.length;
    report.correctness = {
      everyPutReadbackMatches: true,
      sixDistinctChangedBodies: true,
      revisionIncreased: true,
      actualAstImageReferencesMatch: true,
      everyImageHashAndWebpValid: true,
      authorizedImageHttpReadMatches: true,
      documentPendingPayloadsMatch: true,
    };
    report.cold = {
      writeTransactionMs: report.calls[0].maxWriteTransactionMs,
      httpMs: report.calls[0].httpMs,
    };
    report.allSixWriteTransactions = stats(
      report.calls.map((call) => call.maxWriteTransactionMs),
    );
    report.changedBodyCallsTwoThroughSix = {
      writeTransaction: stats(
        report.calls.slice(1).map((call) => call.maxWriteTransactionMs),
      ),
      http: stats(report.calls.slice(1).map((call) => call.httpMs)),
    };
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    db.close();
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(
      join(outputDir, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}

async function main() {
  const output = resolve(
    flag("--output", "docs/validation/document-lock.json"),
  );
  assert.equal(
    existsSync(output),
    false,
    "Refusing to overwrite prior evidence",
  );
  mkdirSync(dirname(output), { recursive: true });
  const caseRoot = output.replace(/\.json$/, "") + "-cases";
  assert.equal(
    existsSync(caseRoot),
    false,
    "Refusing to reuse prior case outputs",
  );
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    declaredSourceCommit: flag("--source-commit", null),
    sourceRoot,
    node: process.version,
    harnessSha256: hash(readFileSync(script)),
    sourceHashes: Object.fromEntries(
      relevantFiles.map((file) => [
        file,
        hash(readFileSync(join(sourceRoot, file))),
      ]),
    ),
    cases: [],
    includeColdPersistedBase: args.includes("--with-cold-base"),
    scope: [
      "Optional --with-cold-base appends two fresh paused-site processes (64/240), each seeded with an existing document through parser-free DB storage before six changed-body PUTs. The first call has both unseen base and desired; original four cases remain unchanged.",
      "Four fresh processes:64/unlinked,64/paused,240/unlinked,240/paused; six actual changed-body PUTs each. First cold request remains in raw and separate summary, no discarded data.",
      "Same paragraph/image cadence and JS-length truncation as reviewer; kb parameter is not an exact UTF-8 size. Actual characters and bytes are recorded.",
      "Deterministic valid WebP bytes and SHA-matching URLs replace reviewer placeholder files, with identical Markdown structure/URL length. Payload images/content and operation capture are verified outside timings.",
      "BEGIN IMMEDIATE through COMMIT wall spans include commit execution; not SQLite internal lock telemetry. Event-loop probe includes local HTTP client and server in each child.",
      "Local bare Git configuration with schedule:false; no publication, cloud services or production data. One six-call sequence per condition, not a statistical guarantee.",
    ],
    status: "running",
  };
  try {
    const cases = [64, 240].flatMap((kb) =>
      [false, true].map((linked) => ({ kb, linked, persistedBase: false })),
    );
    if (args.includes("--with-cold-base"))
      cases.push(
        ...[64, 240].map((kb) => ({ kb, linked: true, persistedBase: true })),
      );
    for (const { kb, linked, persistedBase } of cases) {
      const directory = join(
        caseRoot,
        kb +
          "-" +
          (linked ? "paused" : "unlinked") +
          (persistedBase ? "-cold-base" : ""),
      );
      let failure;
      try {
        execFileSync(
          process.execPath,
          [
            script,
            "--case",
            ...(persistedBase ? ["--persisted-base"] : []),
            "--source-root",
            sourceRoot,
            "--kb",
            String(kb),
            "--linked",
            String(linked),
            "--case-directory",
            directory,
          ],
          {
            cwd: sourceRoot,
            stdio: ["ignore", "inherit", "inherit"],
            timeout: 120000,
          },
        );
      } catch (error) {
        failure = error;
      }
      const result = existsSync(join(directory, "result.json"))
        ? JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))
        : { status: "failed", error: String(failure) };
      report.cases.push({ ...result, directory });
      console.log(
        JSON.stringify({
          kb,
          linked,
          status: result.status,
          cold: result.cold,
          changedBodyCallsTwoThroughSix: result.changedBodyCallsTwoThroughSix,
          error: result.error,
        }),
      );
      if (failure || result.status !== "passed")
        throw failure || new Error(result.error);
    }
    report.ratios = [64, 240].map((kb) => {
      const unlinked = report.cases.find(
          (row) => row.kbParameter === kb && !row.linked,
        ),
        linked = report.cases.find(
          (row) => row.kbParameter === kb && row.linked,
        );
      return {
        kbParameter: kb,
        linkedToUnlinkedChangedBodyMedianRatio:
          linked.changedBodyCallsTwoThroughSix.writeTransaction.medianMs /
          unlinked.changedBodyCallsTwoThroughSix.writeTransaction.medianMs,
      };
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          output,
          status: report.status,
          ratios: report.ratios,
          error: report.error,
        },
        null,
        2,
      ),
    );
  }
}
if (args.includes("--case"))
  caseMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
