import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { imageSync } from "../worker/sync-images.mjs";
import { R2ImageStore } from "../worker/images.mjs";
import { digest, emptyState, entityId } from "../server/sync/protocol.mjs";

test("Worker image adapter transfers only missing content across 30 inherited image references", async () => {
  const teamId = randomUUID(),
    taskId = randomUUID(),
    state = emptyState();
  const objects = new Map(),
    archive = new Map(),
    counts = { reads: 0, puts: 0, gitReads: 0 };
  const bucket = {
    head: async (key) => (objects.has(key) ? {} : null),
    get: async (key) => {
      counts.reads++;
      return objects.has(key)
        ? { arrayBuffer: async () => Uint8Array.from(objects.get(key)).buffer }
        : null;
    },
    put: async (key, bytes) => {
      counts.puts++;
      objects.set(key, bytes);
    },
  };
  const r2 = new R2ImageStore(bucket, teamId),
    urls = [];
  for (let i = 0; i < 30; i++) {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: i * 8, g: 80, b: 120, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();
    const url = `/api/document-images/${teamId}/${digest(bytes)}.webp`,
      key = r2.key(url);
    assert.equal(archive.has(key), false);
    archive.set(key, bytes);
    objects.set(key, bytes);
    urls.push(url);
  }
  state.entities[entityId("task", [taskId])] = {
    entity: "task",
    key: [taskId],
    generation: randomUUID(),
    version: randomUUID(),
    payload: { years: [2026] },
    deleted: false,
  };
  state.entities[entityId("document", ["task", taskId, "main"])] = {
    entity: "document",
    key: ["task", taskId, "main"],
    generation: randomUUID(),
    version: randomUUID(),
    payload: {
      title: "Images",
      position: 0,
      markdown: urls.map((url) => `![image](${url})`).join("\n"),
    },
    deleted: false,
  };
  let files = [...archive.keys()].map((path) => ({ path }));
  const transport = {
    readCommit: async () => ({ files }),
    readFile: async (_head, path) => {
      counts.gitReads++;
      assert.ok(archive.has(path));
      return archive.get(path);
    },
  };
  const database = {
    withTeamTransaction: async (_team, work) =>
      work({
        sync: {
          readLink: async () => ({ installation_id: "outside" }),
          readPending: async () => [],
          readExclusions: async () => [],
        },
      }),
  };
  const adapter = imageSync(database, { teamId }, r2);
  const collect = async (entries) => {
    const result = {};
    for await (const [path, bytes] of entries) result[path] = bytes;
    return result;
  };
  assert.deepEqual(
    await collect(adapter.publish(state, { parent: "parent", transport })),
    {},
  );
  assert.equal(
    counts.reads,
    0,
    "cell-only publish never rereads existing R2 bytes",
  );
  files = files.slice(0, -1);
  assert.deepEqual(
    Object.keys(
      await collect(adapter.publish(state, { parent: "parent", transport })),
    ),
    [r2.key(urls.at(-1))],
  );
  assert.equal(counts.reads, 1);
  await adapter.receive(state, "head", transport);
  assert.equal(
    counts.gitReads,
    0,
    "ordinary receive does not redownload existing images",
  );
  assert.equal(counts.puts, 0);
  objects.delete(r2.key(urls[0]));
  await adapter.receive(state, "head", transport);
  assert.equal(counts.gitReads, 1);
  assert.equal(counts.puts, 1);
  const key = r2.key(urls[1]);
  objects.delete(key);
  await adapter.receive(state, "head", transport, {
    verifiedImages: new Map([[key, archive.get(key)]]),
  });
  assert.equal(
    counts.gitReads,
    1,
    "new image already verified by SyncService is not fetched twice",
  );
  assert.equal(counts.puts, 2);
  files = [];
  counts.reads = 0;
  const lazy = adapter.publish(state, { parent: "parent", transport });
  assert.equal(counts.reads, 0);
  const first = await lazy.next();
  assert.equal(first.done, false);
  assert.equal(counts.reads, 1, "new images are read one at a time, not aggregated in memory");
  await lazy.return();
  assert.equal(counts.reads, 1);
});
