import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  canonical,
  digest,
  emptyState,
  entityId,
  stateHash,
} from "../server/sync/protocol.mjs";
import { encodeSnapshot } from "../server/sync/snapshot.mjs";
async function fixture(rows) {
  const state = emptyState(),
    teamId = randomUUID(),
    repoId = randomUUID();
  const add = (entity, key, payload) => {
    state.entities[entityId(entity, key)] = {
      entity,
      key,
      payload,
      generation: randomUUID(),
      version: randomUUID(),
      deleted: false,
    };
  };
  add("team", [], { name: "Runtime capacity", settings: {} });
  add("person", ["actor"], { name: "Actor" });
  for (let i = 0; i < rows; i++) {
    const id = randomUUID();
    add("task", [id], {
      years: [2026],
      position: i,
      defaultStyle: {},
      rowStyle: {},
      createdBy: "actor",
      createdAt: "2026-10-26T00:00:00.000Z",
      deletedAt: null,
    });
    for (const key of [
      "title",
      "description",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ])
      add("cell", [id, key], {
        value: "대표 업무 " + i + " 일정·검토 ".repeat(12),
        style: { backgroundColor: "#d1eee6" },
      });
  }
  const image = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#345678" },
    })
      .webp()
      .toBuffer(),
    first = Object.values(state.entities).find((e) => e.entity === "task"),
    cell = state.entities[entityId("cell", [first.key[0], "title"])];
  add("document", ["task", first.key[0], "main"], {
    title: "Image",
    position: 0,
    markdown: `![image](/api/document-images/${teamId}/${digest(image)}.webp)`,
  });
  for (let i = 0; i < 20; i++) {
    add("task", ["deleted-" + i], {
      years: [2025],
      position: rows + i,
      defaultStyle: {},
      rowStyle: {},
      createdBy: "actor",
      createdAt: "2026-10-26T00:00:00.000Z",
      deletedAt: null,
    });
    state.entities[entityId("task", ["deleted-" + i])].deleted = true;
    const id = "receipt-" + i;
    state.receipts[id] = {
      opId: id,
      payloadHash: digest(id),
      result: "noop",
      outputTokens: {},
      conflictId: null,
    };
  }
  const op = (id, base, version, value, depends = []) => ({
    protocol: 1,
    reducer: 1,
    teamId,
    repoId,
    opId: id,
    writerEpoch: "local",
    actorRef: "actor",
    createdAt: "2026-10-26T00:00:00.000Z",
    dependsOn: depends,
    objects: [],
    changes: [
      {
        entity: "cell",
        key: cell.key,
        generation: cell.generation,
        baseVersion: version,
        action: "edit",
        base,
        desired: { ...base, value },
        fields: ["value"],
      },
    ],
  });
  const firstOp = op("pending-one", cell.payload, cell.version, "Local one"),
    secondOp = op(
      "pending-two",
      firstOp.changes[0].desired,
      "pending-one:0",
      "Local two",
      ["pending-one"],
    ),
    conflict = op(
      "old-conflict",
      cell.payload,
      cell.version,
      "Conflict preserved",
    );
  state.conflicts[conflict.opId] = {
    conflictId: conflict.opId,
    opId: conflict.opId,
    operation: conflict,
    reason: "Concurrent field change",
    current: { [entityId("cell", cell.key)]: cell },
    resolution: null,
  };
  state.receipts[conflict.opId] = {
    opId: conflict.opId,
    payloadHash: digest(conflict),
    result: "conflict",
    outputTokens: {},
    conflictId: conflict.opId,
  };
  const bundle = { state, hash: stateHash(state) };
  return {
    teamId,
    repoId,
    bootstrapId: randomUUID(),
    snapshot: encodeSnapshot(bundle).toString("base64"),
    image: image.toString("base64"),
    pending: [firstOp, secondOp],
    decodedBytes: Buffer.byteLength(canonical(bundle)),
  };
}

async function heap(runtime) {
  const inspector = await runtime.getInspectorURL();
  inspector.protocol = "http:";
  const list = await (await fetch(new URL("/json", inspector))).json();
  const target = list.find((t) => t.webSocketDebuggerUrl);
  if (!target) return null;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Inspector timeout")),
        5000,
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) {
          clearTimeout(timer);
          resolve(message.result);
        }
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
    });
    return result;
  } finally {
    socket.close();
  }
}
test(
  "real workerd sync capacity: 1000-row bootstrap plus inbound fits; 2000/5000-row snapshots refuse before cursor advances",
  { timeout: 120000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "gb-workerd-capacity-")),
      outfile = join(directory, "worker.mjs");
    await build({
      entryPoints: [resolve("tests/worker-capacity-fixture.mjs")],
      outfile,
      bundle: true,
      platform: "browser",
      format: "esm",
      external: ["node:*"],
      conditions: ["workerd", "worker", "browser"],
      logLevel: "silent",
    });
    const samples = [];
    let runtime;
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: "capacity",
        modules: true,
        script: readFileSync(outfile, "utf8"),
        compatibilityDate: "2026-10-23",
        compatibilityFlags: ["nodejs_compat"],
        inspectorPort: 0,
        outboundService: async (request) => {
          assert.equal(new URL(request.url).hostname, "capacity-probe.local");
          samples.push({
            phase: new URL(request.url).pathname,
            ...(await heap(runtime)),
          });
          return new Response("sampled");
        },
      }),
    );
    try {
      const results = [];
      for (const rows of [1000, 2000, 5000]) {
        const sampleStart = samples.length,
          input = await fixture(rows),
          started = performance.now(),
          response = await runtime.dispatchFetch(
            "https://capacity.example.com/",
            { method: "POST", body: JSON.stringify(input) },
          ),
          result = await response.json(),
          memory = await heap(runtime);
        results.push({
          rows,
          decodedBytes: input.decodedBytes,
          compressedBytes: Buffer.byteLength(input.snapshot, "base64"),
          wallMs: Math.round(performance.now() - started),
          ...result,
          heap: memory,
          samples: samples.slice(sampleStart),
          sampledMaxTotalSize: Math.max(
            ...samples.slice(sampleStart).map((s) => s.totalSize),
            memory.totalSize,
          ),
          sampledMaxTotalAndBacking: Math.max(
            ...samples
              .slice(sampleStart)
              .map((s) => s.totalSize + (s.backingStorageSize || 0)),
            memory.totalSize + (memory.backingStorageSize || 0),
          ),
          sampledMaxUsedAndBacking: Math.max(
            ...samples
              .slice(sampleStart)
              .map((s) => s.usedSize + (s.backingStorageSize || 0)),
            memory.usedSize + (memory.backingStorageSize || 0),
          ),
        });
        if (rows === 1000) {
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.commits, 2);
          assert.equal(result.changed, true);
          assert.equal(result.pending, 2);
          assert.equal(result.images, 1);
          assert.equal(result.materialized, result.entities);
          assert.equal(result.usedPreparedPrevious, true);
          if (memory)
            assert.ok(
              results.at(-1).sampledMaxUsedAndBacking < 128 * 1024 * 1024,
              JSON.stringify(results.at(-1)),
            );
        } else {
          assert.equal(response.status, 413, JSON.stringify(result));
          assert.equal(result.code, "EXTERNAL_SYNC_CAPACITY");
          assert.equal(result.commits, 0);
          assert.equal(result.cursor, null);
          assert.equal(result.entities, 0);
        }
      }
      const report = {
        createdAt: new Date().toISOString(),
        runtime:
          "workerd " +
          JSON.parse(readFileSync("node_modules/workerd/package.json", "utf8"))
            .version,
        productionDeploymentTested: false,
        heapMeasurement:
          "Inspector samples at canonical writes, image projection and materialization batches plus after invocation; sampled maximum is not continuous peak or resident memory; totalSize is V8 allocated heap capacity (distinct from live usedSize); excludes production bundle/PG driver; wall time includes sampling overhead",
        scope:
          "Real workerd SyncService, boundStore, materialize and imageSync with explicit SQL row-allocation model and R2 byte store, pending/receipts/conflicts/tombstones; excludes actual cloud/network latency",
        officialLimits:
          "https://developers.cloudflare.com/workers/platform/limits/",
        limits: { decodedBytes: 4194304, entities: 12000 },
        results,
      };
      t.diagnostic(JSON.stringify(report));
      if (process.env.WORKER_CAPACITY_REPORT)
        writeFileSync(
          process.env.WORKER_CAPACITY_REPORT,
          JSON.stringify(report, null, 2) + "\n",
        );
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
