import test from "node:test";
import assert from "node:assert/strict";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { canonicalHashes, sliceChanges } from "../worker/sync-partial.mjs";
import { digest, entityId, emptyState } from "../server/sync/protocol.mjs";

const record = (entity, key, payload, extra = {}) => ({
  entity,
  key,
  generation: "generation-" + key.join("/"),
  version: "version-" + key.join("/"),
  payload,
  deleted: false,
  ...extra,
});
const receipt = (opId, result = "applied") => ({
  opId,
  payloadHash: "a".repeat(64),
  result,
  conflictId: result === "conflict" ? opId : null,
  outputTokens: {},
});
const add = (state, records) => {
  for (const r of records) state.entities[entityId(r.entity, r.key)] = r;
  return state;
};

// The publish and receive slice paths trust PostgreSQL to rebuild canonical(C)
// from stored text: escaping, number and Unicode text, tombstones, receipts,
// conflicts and the code-unit key order must all match digest() exactly.
test("PostgreSQL hashes C and C with slice changes exactly as stateHash does", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const { teamId, adapter } = f,
    keys = ["a", "B", "z", "~", "é", "ÿ", "가", "힣", "￯", 'q"\\'];
  const before = await adapter.readState(teamId),
    extra = add(emptyState(), [
      ...keys.map((name, i) =>
        record("tag", ["tag-" + name], {
          name: `태그 ${name} "따옴표" \\ \u0001\n\t😀  `,
          userId: "user-" + i,
          rank: i / 3,
          flags: [true, null, -i, 0.1, 12345678901234],
          nested: { z: 1, a: { "": "", "\u0000": "nul" } },
        }),
      ),
      record("filter", ["gone"], null, { deleted: true }),
    ]);
  Object.assign(extra.receipts, {
    "op-1": receipt("op-1"),
    "op-2": receipt("op-2", "conflict"),
  });
  extra.conflicts["op-2"] = {
    conflictId: "op-2",
    opId: "op-2",
    operation: { opId: "op-2", changes: [] },
    reason: "Concurrent field change",
    current: {},
    resolution: null,
  };
  await adapter.withTeamTransaction(teamId, (tx) =>
    tx.sync.writeState(
      {
        entities: { ...before.entities, ...extra.entities },
        receipts: { ...before.receipts, ...extra.receipts },
        conflicts: { ...before.conflicts, ...extra.conflicts },
      },
      f.link.canonical_head,
      before,
    ),
  );
  const stored = await adapter.readState(teamId);
  assert.ok(Object.keys(stored.entities).length > keys.length);

  const changedTag = entityId("tag", ["tag-가"]),
    base = {
      entities: { [changedTag]: stored.entities[changedTag] },
      receipts: {},
      conflicts: { "op-2": stored.conflicts["op-2"] },
    },
    next = {
      entities: {
        ...base.entities,
        [changedTag]: {
          ...stored.entities[changedTag],
          version: "op-3:0",
          payload: { name: "바뀐 태그", userId: "user-6" },
        },
        [entityId("tag", ["tag-new 새"])]: record("tag", ["tag-new 새"], {
          name: "새",
          userId: "user-new",
        }),
      },
      receipts: { "op-3": receipt("op-3") },
      conflicts: {
        "op-2": { ...stored.conflicts["op-2"], resolution: "op-3" },
      },
    },
    whole = {
      entities: { ...stored.entities, ...next.entities },
      receipts: { ...stored.receipts, ...next.receipts },
      conflicts: { ...stored.conflicts, ...next.conflicts },
    };
  await adapter.withTeamTransaction(teamId, async (tx) => {
    const unchanged = await canonicalHashes(
      tx,
      teamId,
      sliceChanges(emptyState(), emptyState()),
    );
    assert.deepEqual(unchanged, {
      current: digest(stored),
      next: digest(stored),
    });
    assert.deepEqual(
      await canonicalHashes(tx, teamId, sliceChanges(base, next)),
      { current: digest(stored), next: digest(whole) },
    );
    // Keys outside the BMP sort differently by UTF-8 byte and UTF-16 unit.
    const astral = add(emptyState(), [
      record("tag", ["tag-😀"], { name: "x", userId: "u" }),
    ]);
    assert.equal(
      await canonicalHashes(tx, teamId, sliceChanges(emptyState(), astral)),
      null,
    );
  });
  assert.throws(
    () => sliceChanges(next, base),
    /cannot remove canonical records/,
  );
});
