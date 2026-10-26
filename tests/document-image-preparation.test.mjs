import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDocumentImagePreparation } from "../server/document-image-preparation.mjs";
import { MAX_DOCUMENT_BYTES } from "../shared/task-documents.js";

const marker = "/api/document-images/";
const unavailable = (error) => error.status === 503;
function workerFixture(t, body) {
  const directory = mkdtempSync(join(tmpdir(), "graeboard-image-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "worker.mjs");
  writeFileSync(
    file,
    `import { parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
const flag = ${JSON.stringify(join(directory, "once"))};
const reply = (request) => ({id:request.id, hashes:request.items.map(item=>item.hash), urls:request.items.map(()=>[])});
${body}`,
  );
  return pathToFileURL(file);
}
function preparation(t, options) {
  const service = createDocumentImagePreparation(options);
  t.after(() => service.close());
  return service;
}

test("document image preparation is lazy, preserves exact inputs and returns frozen shared-parser results", async (t) => {
  const service = preparation(t);
  assert.deepEqual(await service.prepare(["", "plain"]), [
    { markdown: "", urls: [] },
    { markdown: "plain", urls: [] },
  ]);
  assert.equal(service.stats.workerStarts, 0);
  const url = `${marker}${randomUUID()}/${"a".repeat(64)}.webp`;
  const source = [
    `![inline](${url}#width=200)\n![ref][pic]\n\n[pic]: ${url}`,
    `\`![not-an-image](${url})\`\n${url}`,
  ];
  const original = [...source];
  const pending = service.prepare(source);
  source[0] = "caller mutation";
  const result = await pending;
  assert.deepEqual(result, [
    { markdown: original[0], urls: [url] },
    { markdown: original[1], urls: [] },
  ]);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result[0]) &&
      Object.isFrozen(result[0].urls),
  );
  assert.throws(() => result[0].urls.push("wrong"), TypeError);
  assert.equal(service.stats.workerStarts, 1);
  const maximum = marker + "a".repeat(MAX_DOCUMENT_BYTES - marker.length);
  assert.deepEqual(await service.prepare([maximum]), [
    { markdown: maximum, urls: [] },
  ]);
  assert.equal(service.stats.pending, 0);
  assert.equal(service.stats.inputBytes, 0);
});

test("document image preparation bounds active plus queued jobs and aggregate UTF8 bytes", async (t) => {
  const workerUrl = workerFixture(
    t,
    `parentPort.on('message', request => setTimeout(()=>parentPort.postMessage(reply(request)), 50));`,
  );
  const service = preparation(t, { workerUrl, maxPending: 2, timeoutMs: 2000 });
  const first = service.prepare([marker]),
    second = service.prepare([marker]);
  await assert.rejects(
    service.prepare([marker]),
    (error) => unavailable(error) && error.code.endsWith("BUSY"),
  );
  assert.equal(service.stats.pending, 2);
  assert.equal(service.stats.queued, 1);
  assert.equal(service.stats.inputBytes, Buffer.byteLength(marker) * 2);
  await Promise.all([first, second]);
  assert.equal(service.stats.workerStarts, 1);
  const text = marker + "한글";
  const bytes = Buffer.byteLength(text);
  const bounded = preparation(t, {
    workerUrl,
    maxBytes: bytes,
    timeoutMs: 2000,
  });
  const one = bounded.prepare([text]);
  await assert.rejects(bounded.prepare([text]), (error) =>
    error.code.endsWith("BUSY"),
  );
  await one;
  assert.equal(bounded.stats.inputBytes, 0);
});

for (const [name, fault] of [
  ["timeout", "return;"],
  ["crash", "throw new Error('fixture crash');"],
  ["exit", "process.exit(17);"],
  [
    "wrong ID",
    "parentPort.postMessage({...reply(request),id:'stale-id'}); return;",
  ],
  [
    "wrong hash order",
    "parentPort.postMessage({...reply(request),hashes:reply(request).hashes.reverse()}); return;",
  ],
  [
    "invalid URL result",
    "parentPort.postMessage({...reply(request),urls:[[42],[]]}); return;",
  ],
  [
    "oversized result",
    "parentPort.postMessage({...reply(request),urls:[['/api/document-images/'+ 'x'.repeat(200)],[]]}); return;",
  ],
]) {
  test(`document image worker ${name} rejects all pending work and a later request starts a fresh worker`, async (t) => {
    const workerUrl = workerFixture(
      t,
      `parentPort.on('message', request => {
      if (!existsSync(flag)) { writeFileSync(flag,'failed once'); ${fault} }
      parentPort.postMessage(reply(request));
    });`,
    );
    const service = preparation(t, {
      workerUrl,
      timeoutMs: name === "timeout" ? 300 : 2000,
    });
    const first = service.prepare([marker + "a", marker + "b"]),
      oldThread = service.stats.workerThreadId;
    const second = service.prepare([marker + "queued"]);
    const outcomes = await Promise.allSettled([first, second]);
    assert.ok(
      outcomes.every(
        (result) => result.status === "rejected" && unavailable(result.reason),
      ),
    );
    assert.equal(service.stats.pending, 0);
    assert.equal(service.stats.inputBytes, 0);
    if (name === "wrong ID")
      assert.equal(
        service.stats.terminating,
        true,
        "failure rejects jobs before the old worker exit is confirmed",
      );
    const retry = service.prepare([marker + "retry"]);
    if (name === "wrong ID")
      assert.equal(
        service.stats.workerStarts,
        1,
        "a request during termination cannot spawn an overlapping worker",
      );
    assert.deepEqual(await retry, [{ markdown: marker + "retry", urls: [] }]);
    assert.equal(service.stats.workerStarts, 2);
    assert.notEqual(service.stats.workerThreadId, oldThread);
  });
}

test("document preparation timeout includes queue wait instead of restarting the deadline when dispatched", async (t) => {
  const workerUrl = workerFixture(
    t,
    `parentPort.on('message', request => setTimeout(()=>parentPort.postMessage(reply(request)),500));`,
  );
  const service = preparation(t, { workerUrl, timeoutMs: 800 });
  const outcomes = await Promise.allSettled([
    service.prepare([marker]),
    service.prepare([marker]),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.code, "DOCUMENT_IMAGE_PREPARATION_TIMEOUT");
});

test("an unsolicited reply while idle retires the worker without automatic respawn", async (t) => {
  const workerUrl = workerFixture(
    t,
    `parentPort.on('message', request => {
    parentPort.postMessage(reply(request));
    setTimeout(()=>parentPort.postMessage(reply(request)),10);
  });`,
  );
  const service = preparation(t, { workerUrl, timeoutMs: 2000 });
  await service.prepare([marker]);
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const check = () => {
      if (service.stats.workerThreadId === null && !service.stats.terminating)
        resolve();
      else if (Date.now() > deadline)
        reject(new Error("Idle invalid reply did not retire worker"));
      else setTimeout(check, 5);
    };
    check();
  });
  assert.equal(service.stats.workerStarts, 1);
  assert.equal(service.stats.pending, 0);
  await service.prepare([marker + "new request"]);
  assert.equal(service.stats.workerStarts, 2);
});

test("a duplicate stale reply cannot settle the next active document job", async (t) => {
  const workerUrl = workerFixture(
    t,
    `let count=0; parentPort.on('message', request => {
    if (++count===1) { parentPort.postMessage(reply(request)); setTimeout(()=>parentPort.postMessage(reply(request)),20); }
    else setTimeout(()=>parentPort.postMessage(reply(request)),100);
  });`,
  );
  const service = preparation(t, { workerUrl, timeoutMs: 2000 });
  const outcomes = await Promise.allSettled([
    service.prepare([marker + "first"]),
    service.prepare([marker + "second"]),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(
    outcomes[1].reason.code,
    "DOCUMENT_IMAGE_PREPARATION_INVALID_REPLY",
  );
  assert.equal(service.stats.pending, 0);
});

test("document image preparation rejects oversized/invalid input without spawning and close rejects pending idempotently", async (t) => {
  const workerUrl = workerFixture(t, "parentPort.on('message', () => {});");
  const service = preparation(t, { workerUrl, timeoutMs: 2000 });
  for (const input of [
    [marker, marker, marker],
    ["a".repeat(MAX_DOCUMENT_BYTES + 1)],
    ["한".repeat(MAX_DOCUMENT_BYTES / 2)],
    [undefined],
    Array(1),
    null,
  ])
    await assert.rejects(service.prepare(input), unavailable);
  assert.equal(service.stats.workerStarts, 0);
  const outcomes = Promise.allSettled([
    service.prepare([marker]),
    service.prepare([marker]),
  ]);
  const closing = service.close();
  assert.strictEqual(service.close(), closing);
  await closing;
  assert.ok(
    (await outcomes).every(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "DOCUMENT_IMAGE_PREPARATION_CLOSED",
    ),
  );
  await assert.rejects(service.prepare([""]), unavailable);
  assert.equal(service.stats.closed, true);
  assert.equal(service.stats.pending, 0);
  assert.equal(service.stats.inputBytes, 0);
  assert.equal(service.stats.workerThreadId, null);
});
