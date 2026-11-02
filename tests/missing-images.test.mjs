import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { imageSync } from "../worker/sync-images.mjs";
import { R2ImageStore } from "../worker/images.mjs";
import { emptyState, entityId } from "../server/sync/protocol.mjs";
import { bucket } from "./worker-github-fixture.mjs";

// A document may point at an image a site never received or no longer holds.
// It is shown as missing; publishing and receiving go on without it instead of
// stopping the team's synchronization.
function fixture(t) {
  const teamId = randomUUID(),
    taskId = randomUUID(),
    url = `/api/document-images/${teamId}/${"b".repeat(64)}.webp`,
    record = (entity, key, payload) => ({
      entity,
      key,
      payload,
      generation: "g",
      version: "v",
      deleted: false,
    }),
    task = record("task", [taskId], {
      years: [2026],
      position: 1,
      deletedAt: null,
    }),
    document = record("document", ["task", taskId, "main"], {
      title: "그림 문서",
      position: 0,
      markdown: `![그림](${url})`,
    }),
    state = {
      ...emptyState(),
      entities: {
        [entityId("task", task.key)]: task,
        [entityId("document", document.key)]: document,
      },
    },
    store = bucket(),
    r2 = new R2ImageStore(store, teamId),
    database = {
      withTeamTransaction: async (_teamId, work) =>
        work({
          sync: {
            readLink: async () => ({ installation_id: randomUUID() }),
            readPending: async () => [],
            readExclusions: async () => [],
          },
        }),
    },
    skipped = [];
  t.mock.method(console, "warn", (label, detail) => {
    if (label === "GraeBoard image skipped") skipped.push(JSON.parse(detail));
  });
  return {
    teamId,
    url,
    document,
    state,
    store,
    skipped,
    sync: imageSync(database, { teamId }, r2),
  };
}

test("publishing goes on without an image R2 lacks", async (t) => {
  const f = fixture(t),
    operation = {
      changes: [
        {
          entity: "document",
          key: f.document.key,
          desired: f.document.payload,
        },
      ],
    },
    files = [];
  for await (const file of f.sync.publish(f.state, {
    parent: "parent",
    transport: { readCommit: async () => ({ files: [] }) },
    operations: [operation],
  }))
    files.push(file);
  assert.deepEqual(files, []);
  assert.deepEqual(
    f.skipped.map((entry) => entry.reason),
    ["missing from R2"],
  );
});

test("receiving goes on without an image Git lacks or holds damaged", async (t) => {
  for (const [bytes, reason] of [
    [null, "missing from Git"],
    [new Uint8Array([1, 2, 3]), "damaged in Git"],
  ]) {
    const f = fixture(t);
    await f.sync.receive(f.state, "head", {
      readFile: async () => bytes,
    });
    assert.equal(f.store.objects.size, 0);
    assert.deepEqual(
      f.skipped.map((entry) => entry.reason),
      [reason],
    );
  }
});

test("an R2 outage still stops a publication to retry later", async (t) => {
  const f = fixture(t);
  f.store.get = async () => {
    throw new Error("fixture R2 unavailable");
  };
  const run = async () => {
    for await (const file of f.sync.publish(f.state, {
      parent: "parent",
      transport: { readCommit: async () => ({ files: [] }) },
      operations: [
        {
          changes: [
            {
              entity: "document",
              key: f.document.key,
              desired: f.document.payload,
            },
          ],
        },
      ],
    }))
      void file;
  };
  await assert.rejects(run(), /R2 unavailable/);
});
