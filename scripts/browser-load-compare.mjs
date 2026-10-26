// Run only after building both isolated roots and stopping other benchmarks:
// node scripts/browser-load-compare.mjs --baseline-root /tmp/baseline \
//   --final-root /tmp/final --output /private/browser-load-comparison.json
// Each backend opens its own schema, serves its own dist, and uses the exact
// legacy load-test seed/preparation. This script neither builds nor migrates it.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";

const { values } = parseArgs({
  options: {
    "baseline-root": { type: "string" },
    "final-root": { type: "string" },
    output: { type: "string" },
    "baseline-revision": {
      type: "string",
      default: "8f3e407abebf2ff379fe0cadb2b152f4021649e0",
    },
    "final-revision": {
      type: "string",
      default: "d2ddba7f85bb3fe4f57199d69b1f14b2de0a5b2b",
    },
    blocks: { type: "string", default: "3" },
  },
});
for (const key of ["baseline-root", "final-root", "output"])
  assert(values[key], `--${key} is required`);
const blocks = Number(values.blocks);
assert(Number.isInteger(blocks) && blocks >= 1 && blocks <= 10);
const output = resolve(values.output);
assert(
  !existsSync(output),
  "Use a new output path; existing evidence is preserved",
);
mkdirSync(dirname(output), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "graeboard-browser-compare-"));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const legacyHash =
  "94516bd87219b4cd332a443508c684e1616f9ac6c6548657cafcf7b947c4821e";
const fixtureSeed = randomBytes(32).toString("hex");
const fixtureTimestamp = new Date().toISOString();
const order = ["baseline", "final", "final", "baseline"];
const report = {
  status: "running",
  startedAt: fixtureTimestamp,
  environment: {
    node: process.version,
    nodeExecutable: process.execPath,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGB: totalmem() / 1024 ** 3,
    chromiumExecutable: chromium.executablePath(),
    network: "loopback; unthrottled Chromium; separate backend processes",
  },
  method: {
    rows: 10000,
    fill: 30,
    users: 100,
    expectedStoredCells: 269000,
    viewport: { width: 1366, height: 768 },
    orderPerBlock: order,
    blocksPerMode: blocks,
    samplesPerBackendPerMode: blocks * 2,
    modeOrder: ["browser-cold", "browser-warm", "server-cold"],
    readiness:
      'page.goto(base); first [data-column="title"] visible; grid aria-rowcount="10001" (the unchanged legacy condition)',
    authentication:
      "The legacy seeded weekly_session cookie is installed before navigation; no POST login is measured. Bootstrap remains inside navigation.",
    backendCondition:
      "browser-cold/browser-warm use servers prewarmed by the complete legacy pre-browser read/write/format/conflict workload plus an untimed task GET verifying the fixture. server-cold restarts the backend before every sample. No mode claims a cold OS file cache.",
    cold: "Fresh Chromium process, context and page for every sample. Browser/context launch is recorded separately and excluded from the legacy navigation elapsed time.",
    warm: "One retained Chromium/context/page per backend, with an explicitly retained priming navigation. about:blank between samples stops application SSE/polling while preserving cookies and browser caches. No resource cache is disabled.",
    serverCold:
      "After legacy preparation, close the selected HTTP server, hubs, sync service and server DB connection, await exit0, and start a new own-root createApp process/DB connection against the same fixture file. Check counts directly through the fixture DB only. No HTTP request is sent to the new server before the fresh Chromium/context navigation; its initial ready IPC reports the observed HTTP request count. OS filesystem caches and the fixture-control DB connection remain warm. Restart duration is recorded separately from navigation.",
    legacyDifference:
      "The old five-sample summary mixed the first browser load with four same-context loads and searches between them. This narrow comparison separates cold/warm navigation and does not run interleaved searches; it does not replace that evidence.",
    samplePolicy:
      "Every priming, measured, and failed sample is retained. Failed runs are not silently retried. Small-sample p95 is descriptive and may equal the maximum.",
    resourceBoundary:
      "Navigation/resource/CDP timing is captured at the grid readiness boundary. Long-lived SSE and unfinished requests remain marked incomplete; response bodies and authentication headers are not recorded.",
  },
  fixture: {
    legacySourceSha256: legacyHash,
    seedSha256: digest(fixtureSeed),
    timestamp: fixtureTimestamp,
    substitutions: [
      "Import each backend's own db/domain/app modules by absolute URL and use that backend's cwd/dist.",
      "Identical deterministic UUID/token streams and initial timestamp in the two synthetic fixtures; password hashing remains the backend implementation.",
      "Redirect legacy report directory into temporary fixture storage; stop just before legacy Chromium launch.",
    ],
  },
  backends: {},
  serverRestarts: [],
  samples: [],
};
const save = () =>
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const backends = [];
const browsers = new Set();
save();

function assetManifest(root) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else {
        const data = readFileSync(path);
        files.push({
          path: relative(root, path),
          bytes: data.length,
          sha256: digest(data),
        });
      }
    }
  }
  visit(join(root, "dist"));
  return files;
}

function dependencies(root) {
  const require = createRequire(join(root, "package.json"));
  return Object.fromEntries(
    [
      "@playwright/test",
      "playwright-core",
      "react",
      "react-dom",
      "@tanstack/react-virtual",
      "vite",
    ].map((name) => [name, require(`${name}/package.json`).version]),
  );
}

function fixtureCode(root, label) {
  const source = readFileSync(join(root, "scripts/load-test.mjs"), "utf8");
  assert.equal(
    digest(source),
    legacyHash,
    `${label}: legacy fixture source changed`,
  );
  const marker = "    browser = await chromium.launch();";
  assert.equal(
    source.split(marker).length,
    2,
    "Legacy browser boundary must be unique",
  );
  const originalPrefix = source.slice(0, source.indexOf(marker));
  let prefix = originalPrefix
    .replace('import { chromium, expect } from "@playwright/test";\n', "")
    .replace(
      'from "../server/db.mjs"',
      `from ${JSON.stringify(pathToFileURL(join(root, "server/db.mjs")).href)}`,
    )
    .replace(
      'from "../shared/domain.js"',
      `from ${JSON.stringify(pathToFileURL(join(root, "shared/domain.js")).href)}`,
    )
    .replace(
      'new URL("../server/app.mjs", import.meta.url).href',
      JSON.stringify(pathToFileURL(join(root, "server/app.mjs")).href),
    )
    .replace(
      'new URL("../docs/validation/", import.meta.url)',
      `new URL(${JSON.stringify(pathToFileURL(join(scratch, label) + "/").href)})`,
    )
    .replace(
      "randomBytes, createHash",
      "randomBytes as unusedRandomBytes, createHash",
    )
    .replace(
      "  id,\n  now,",
      "  id as unusedDatabaseId,\n  now as unusedDatabaseNow,",
    )
    .replace(
      "process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{app.locals.db.close();process.exit(0)});});",
      "process.once('SIGTERM',()=>{void(async()=>{const closed=new Promise(resolve=>server.close(resolve));for(const hub of [app.locals.cellEvents,app.locals.documentEvents]){if(hub)(hub.shutdown||hub.close).call(hub);}server.closeAllConnections();await Promise.all([closed,app.locals.sync?.close?.()]);app.locals.db.close();if(process.connected)process.disconnect();})().catch(error=>{console.error(error);process.exitCode=1;if(process.connected)process.disconnect();});});",
    );
  const seeded = `
const fixtureSeed=${JSON.stringify(fixtureSeed)};
let uuidSequence=0,tokenSequence=0;
const id=()=>{const b=createHash('sha256').update(fixtureSeed+'/uuid/'+uuidSequence++).digest().subarray(0,16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
const randomBytes=(size)=>{assert.equal(size,32);return createHash('sha256').update(fixtureSeed+'/token/'+tokenSequence++).digest();};
const now=()=>${JSON.stringify(fixtureTimestamp)};
const fixtureCommands=[];
let commandWake;
const enqueueCommand=command=>{fixtureCommands.push(command);commandWake?.();commandWake=undefined;};
process.on('message',enqueueCommand);
process.once('disconnect',()=>enqueueCommand('stop'));
process.once('SIGTERM',()=>enqueueCommand('stop'));
const nextFixtureCommand=async()=>{while(!fixtureCommands.length)await new Promise(resolve=>{commandWake=resolve;});return fixtureCommands.shift();};
`;
  prefix = prefix.replace("const scenarios =", seeded + "\nconst scenarios =");
  return {
    originalPrefixSha256: digest(originalPrefix),
    code:
      prefix +
      `
    const finalRead=await request(path);
    assert.equal(finalRead.response.status,200);
    const finalTasks=parse(Buffer.from(finalRead.body)).tasks;
    const lastTask=finalTasks.find(t=>t.id===taskIds.at(-1));
    process.send({type:'ready',base,token:tokens[0],metadata:{
      root:${JSON.stringify(root)},schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
      teamId:team,userIdsSha256:createHash('sha256').update(JSON.stringify(userIds)).digest('hex'),
      taskIdsSha256:createHash('sha256').update(JSON.stringify(taskIds)).digest('hex'),
      settingsSha256:createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
      conflictWinnerValue:lastTask.cells.description.value,rows:finalTasks.length,
      storedCells:result.storedCells,scheduleColumns:weeks.length,legacyPreparation:result,
      fixtureProcess:process.pid,serverProcess:server.pid
    }});
    let restartCount=0;
    for(;;){
      const command=await nextFixtureCommand();
      if(command==='stop')break;
      assert.equal(command.type,'restart');
      const previousServerProcess=server.pid;
      const ended=once(server,'exit');
      server.kill('SIGTERM');
      const [code,signal]=await ended;
      assert.equal(code,0,'Server restart shutdown failed: '+signal);
      const resetServerCode=serverCode
        .replace('const server=app.listen','let observedHttpRequests=0;const server=app.listen')
        .replace('port:server.address().port','port:server.address().port,observedHttpRequests')
        .replace("process.on('message'","server.on('request',()=>observedHttpRequests++);process.on('message'");
      server=spawn(process.execPath,['--input-type=module','-e',resetServerCode],{
        cwd:process.cwd(),
        env:{...process.env,DB_PATH:join(dir,'test.sqlite'),NODE_ENV:'development'},
        stdio:['ignore','ignore','pipe','ipc']
      });
      server.stderr.on('data',chunk=>{serverErrors+=chunk;});
      const ready=await Promise.race([
        once(server,'message'),
        once(server,'exit').then(()=>{throw Error('Restarted server exited: '+serverErrors);})
      ]);
      assert.equal(ready[0].observedHttpRequests,0);
      assert.notEqual(server.pid,previousServerProcess);
      // This connection is the fixture's existing control connection, not the
      // new app connection. No fetch/request() call may be added here.
      process.send({type:'restarted',requestId:command.requestId,base:'http://127.0.0.1:'+ready[0].port,metadata:{
        restartCount:++restartCount,previousServerProcess,serverProcess:server.pid,
        observedHttpRequestsAtListen:ready[0].observedHttpRequests,
        rows:db.prepare('SELECT COUNT(*) n FROM tasks').get().n,
        storedCells:db.prepare('SELECT COUNT(*) n FROM cells').get().n,
        schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
        fixtureDatabaseReused:true,newServerDatabaseConnection:true
      }});
    }
  } catch(error) {
    process.send?.({type:'failure',error:error.stack,serverErrors});
    process.exitCode=1;
  } finally {
    if(server&&server.exitCode===null){const ended=once(server,'exit');server.kill('SIGTERM');const [code,signal]=await ended;assert.equal(code,0,'Server shutdown failed: '+signal);}
    db.close();
    rmSync(dir,{recursive:true,force:true});
    if(process.connected)process.disconnect();
  }
}
`,
  };
}

async function startBackend(label) {
  const root = resolve(values[`${label}-root`]);
  assert(
    existsSync(join(root, "dist/index.html")),
    `${label}: build dist first`,
  );
  const source = fixtureCode(root, label);
  const childFile = join(scratch, `${label}-fixture.mjs`);
  writeFileSync(childFile, source.code, { mode: 0o600 });
  const env = {
    ...process.env,
    NODE_ENV: "development",
    GRAEBOARD_SYNC_PROFILES: "[]",
  };
  delete env.GRAEBOARD_INSTALLATION_ID;
  const child = spawn(process.execPath, [childFile, "10000:30"], {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const backend = { label, root, child, stderr: "", stdout: "" };
  backends.push(backend);
  child.stdout.on("data", (data) => {
    backend.stdout += data;
  });
  child.stderr.on("data", (data) => {
    backend.stderr += data;
  });
  backend.exit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const ready = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(Error(`${label}: fixture startup exceeded 240s`)),
      240000,
    );
    const finish = (fn, value) => {
      clearTimeout(timeout);
      fn(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) =>
      finish(
        reject,
        Error(`${label}: fixture exited ${code}: ${backend.stderr}`),
      ),
    );
    child.on("message", (message) => {
      if (message.type === "ready") finish(resolveReady, message);
      if (message.type === "failure")
        finish(reject, Error(message.error + "\n" + message.serverErrors));
    });
  });
  backend.base = ready.base;
  backend.token = ready.token;
  report.backends[label] = {
    ...ready.metadata,
    declaredRevision: values[`${label}-revision`],
    originalLegacyPrefixSha256: source.originalPrefixSha256,
    generatedFixtureSha256: digest(source.code),
    installedDependencies: dependencies(root),
    sourceHashes: Object.fromEntries(
      ["server/app.mjs", "server/db.mjs", "package-lock.json"].map((path) => [
        path,
        digest(readFileSync(join(root, path))),
      ]),
    ),
    builtAssets: assetManifest(root),
  };
  save();
  return backend;
}

async function restartBackend(backend) {
  const requestId = `${backend.label}-${report.serverRestarts.length + 1}`;
  const reset = {
    requestId,
    backend: backend.label,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  report.serverRestarts.push(reset);
  const start = performance.now();
  try {
    const restarted = await new Promise((resolveRestart, reject) => {
      const finish = (error, message) => {
        clearTimeout(timeout);
        backend.child.off("message", onMessage);
        backend.child.off("exit", onExit);
        if (error) reject(error);
        else resolveRestart(message);
      };
      const onMessage = (message) => {
        if (message.type === "restarted" && message.requestId === requestId)
          finish(null, message);
        if (message.type === "failure") finish(Error(message.error));
      };
      const onExit = (code, signal) =>
        finish(Error(`Fixture exited during restart: ${code}/${signal}`));
      const timeout = setTimeout(
        () => finish(Error(`${backend.label}: restart exceeded 30s`)),
        30000,
      );
      backend.child.on("message", onMessage);
      backend.child.once("exit", onExit);
      backend.child.send({ type: "restart", requestId });
    });
    backend.base = restarted.base;
    Object.assign(reset, restarted.metadata);
    for (const key of ["rows", "storedCells", "schemaVersion"])
      assert.equal(reset[key], report.backends[backend.label][key]);
    assert.equal(reset.observedHttpRequestsAtListen, 0);
    reset.status = "passed";
    return requestId;
  } catch (error) {
    reset.status = "failed";
    reset.error = error.stack;
    throw error;
  } finally {
    reset.elapsedMs = performance.now() - start;
    save();
  }
}

async function openBrowser(backend) {
  const start = performance.now();
  const browser = await chromium.launch();
  browsers.add(browser);
  const version = browser.version();
  report.environment.chromiumVersion ??= version;
  assert.equal(report.environment.chromiumVersion, version);
  const context = await browser.newContext({
    viewport: report.method.viewport,
  });
  await context.addCookies([
    { name: "weekly_session", value: backend.token, url: backend.base },
  ]);
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(4096);
    window.__browserComparisonLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__browserComparisonLongTasks.push(entry.toJSON());
    }).observe({ type: "longtask", buffered: true });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  const state = {
    browser,
    context,
    page,
    allocationMs: performance.now() - start,
    errors: [],
    requests: new Map(),
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event) =>
    state.requests.set(event.requestId, {
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      type: event.type,
      timestamp: event.timestamp,
      wallTime: event.wallTime,
    }),
  );
  cdp.on("Network.requestServedFromCache", (event) => {
    const request = state.requests.get(event.requestId);
    if (request) request.servedFromCache = true;
  });
  cdp.on("Network.responseReceived", ({ requestId, response, timestamp }) => {
    const request = state.requests.get(requestId);
    if (request)
      Object.assign(request, {
        responseTimestamp: timestamp,
        status: response.status,
        mimeType: response.mimeType,
        protocol: response.protocol,
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        timing: response.timing,
      });
  });
  cdp.on("Network.loadingFinished", (event) => {
    const request = state.requests.get(event.requestId);
    if (request)
      Object.assign(request, {
        completed: true,
        finishedTimestamp: event.timestamp,
        encodedDataLength: event.encodedDataLength,
      });
  });
  cdp.on("Network.loadingFailed", (event) => {
    const request = state.requests.get(event.requestId);
    if (request)
      Object.assign(request, { failed: true, errorText: event.errorText });
  });
  return state;
}

async function navigate(
  backend,
  state,
  { mode, role, block, position, serverRestartId },
) {
  const sample = {
    sequence: report.samples.length + 1,
    backend: backend.label,
    mode,
    role,
    block,
    position,
    startedAt: new Date().toISOString(),
    browserAllocationMs: state.allocationMs,
    ...(serverRestartId ? { serverRestartId } : {}),
  };
  report.samples.push(sample);
  state.errors = [];
  state.requests.clear();
  const start = performance.now();
  try {
    await state.page.goto(backend.base);
    sample.gotoMs = performance.now() - start;
    await expect(
      state.page.locator('[data-column="title"]').first(),
    ).toBeVisible();
    sample.firstTitleMs = performance.now() - start;
    await expect(state.page.getByRole("grid")).toHaveAttribute(
      "aria-rowcount",
      "10001",
    );
    sample.readyMs = performance.now() - start;
    sample.performance = await state.page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      capturedAt: performance.now(),
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => entry.toJSON()),
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.toJSON()),
      paint: performance
        .getEntriesByType("paint")
        .map((entry) => entry.toJSON()),
      longTasks: window.__browserComparisonLongTasks,
    }));
    sample.network = [...state.requests.values()].map((request) => ({
      ...request,
      completed: !!request.completed,
    }));
    sample.pageErrors = [...state.errors];
    assert.deepEqual(sample.pageErrors, []);
    sample.status = "passed";
  } catch (error) {
    sample.status = "failed";
    sample.elapsedMs = performance.now() - start;
    sample.error = error.stack;
    sample.pageErrors = [...state.errors];
    sample.network = [...state.requests.values()];
    throw error;
  } finally {
    save();
  }
  // Idle pages must not issue 7-second polling or retain SSE during the other arm.
  await state.page.goto("about:blank");
}

function stats(samples) {
  const sorted = samples.map((sample) => sample.readyMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: sorted[Math.ceil(sorted.length / 2) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    sampleSequences: samples.map((sample) => sample.sequence),
  };
}

try {
  const baseline = await startBackend("baseline");
  const final = await startBackend("final");
  for (const key of [
    "teamId",
    "userIdsSha256",
    "taskIdsSha256",
    "settingsSha256",
    "rows",
    "storedCells",
    "scheduleColumns",
    "conflictWinnerValue",
  ])
    assert.deepEqual(
      report.backends.baseline[key],
      report.backends.final[key],
      `Fixture mismatch: ${key}`,
    );
  assert.equal(
    report.backends.baseline.storedCells,
    report.method.expectedStoredCells,
  );
  assert.deepEqual(
    report.backends.baseline.installedDependencies,
    report.backends.final.installedDependencies,
    "Use the same installed browser/frontend dependencies",
  );
  const byName = { baseline, final };
  for (const mode of report.method.modeOrder) {
    const warm = {};
    if (mode === "browser-warm") {
      for (const backend of [baseline, final]) {
        warm[backend.label] = await openBrowser(backend);
        await navigate(backend, warm[backend.label], {
          mode,
          role: "priming",
          block: 0,
          position: backend.label,
        });
      }
    }
    try {
      for (let block = 1; block <= blocks; block++) {
        for (const [position, label] of order.entries()) {
          const serverRestartId =
            mode === "server-cold"
              ? await restartBackend(byName[label])
              : undefined;
          const state = warm[label] || (await openBrowser(byName[label]));
          try {
            await navigate(byName[label], state, {
              mode,
              role: "measured",
              block,
              position: position + 1,
              serverRestartId,
            });
          } finally {
            if (mode !== "browser-warm") {
              await state.browser.close();
              browsers.delete(state.browser);
            }
          }
        }
      }
    } finally {
      for (const state of Object.values(warm)) {
        await state.browser.close();
        browsers.delete(state.browser);
      }
    }
  }
  report.summary = Object.fromEntries(
    report.method.modeOrder.map((mode) => {
      const arms = Object.fromEntries(
        ["baseline", "final"].map((backend) => [
          backend,
          stats(
            report.samples.filter(
              (sample) =>
                sample.mode === mode &&
                sample.backend === backend &&
                sample.role === "measured" &&
                sample.status === "passed",
            ),
          ),
        ]),
      );
      return [
        mode,
        {
          ...arms,
          medianChangePercent:
            (arms.final.medianMs / arms.baseline.medianMs - 1) * 100,
          p95ChangePercent: (arms.final.p95Ms / arms.baseline.p95Ms - 1) * 100,
        },
      ];
    }),
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const backend of backends) {
    if (backend.child.exitCode === null && backend.child.signalCode === null) {
      if (backend.child.connected) backend.child.send("stop");
      else backend.child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        // A failed fixture may still own its HTTP-server child. Drain the whole
        // isolated process group rather than leaving a background benchmark.
        try {
          if (process.platform !== "win32")
            process.kill(-backend.child.pid, "SIGKILL");
          else backend.child.kill("SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }, 15000);
      backend.termination = await backend.exit;
      clearTimeout(killTimer);
      if (backend.termination.code !== 0) {
        report.status = "failed";
        process.exitCode = 1;
      }
    }
    report.backends[backend.label] ||= { root: backend.root };
    report.backends[backend.label].fixtureStderr = backend.stderr;
    report.backends[backend.label].fixtureStdout = backend.stdout;
    report.backends[backend.label].termination = backend.termination || {
      code: backend.child.exitCode,
      signal: backend.child.signalCode,
    };
  }
  report.finishedAt = new Date().toISOString();
  save();
  rmSync(scratch, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      { output, status: report.status, summary: report.summary },
      null,
      2,
    ),
  );
}
