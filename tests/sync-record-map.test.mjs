import test from "node:test";
import assert from "node:assert/strict";
import { forkRecordMap } from "../shared/record-map.mjs";
import { canonical, emptyState, stateHash } from "../server/sync/protocol.mjs";
import { reduceMany } from "../server/sync/reducer.mjs";

test("receipt workspaces share old records without copying their keys on creation and preserve canonical own fields", () => {
  const base = { a: { value: 1 }, b: { value: 2 } };
  let enumerations = 0;
  const monitored = new Proxy(base, {
    ownKeys(t) {
      enumerations++;
      return Reflect.ownKeys(t);
    },
  });
  const first = forkRecordMap(monitored);
  assert.equal(enumerations, 0);
  first.c = { value: 3 };
  const second = forkRecordMap(first);
  second.d = { value: 4 };
  assert.equal(enumerations, 0);
  assert.deepEqual(base, { a: { value: 1 }, b: { value: 2 } });
  assert.equal(Object.hasOwn(second, "a"), true);
  assert.equal(second.a, base.a);
  assert.equal(
    canonical(second),
    canonical({ ...base, c: { value: 3 }, d: { value: 4 } }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(second)), {
    ...base,
    c: { value: 3 },
    d: { value: 4 },
  });
  assert.equal(Object.hasOwn(first, "d"), false);
  assert.throws(
    () => structuredClone(second),
    { name: "DataCloneError" },
    "internal proxy transport contract is JSON only",
  );
  Object.freeze(second);
  assert.equal(
    canonical(second),
    canonical({ ...base, c: { value: 3 }, d: { value: 4 } }),
  );
  assert.throws(() => {
    second.a = { value: 0 };
  }, TypeError);
});
test("receipt compaction preserves every field through 100 immutable forks, including keys with prototype names", () => {
  const original = Object.fromEntries([
    ["__proto__", { id: 1 }],
    ["constructor", { id: 2 }],
  ]);
  let map = original;
  const expected = { ...original };
  for (let i = 0; i < 100; i++) {
    const before = map;
    map = forkRecordMap(map);
    map[`r${i}`] = { i };
    expected[`r${i}`] = { i };
    assert.equal(Object.hasOwn(before, `r${i}`), false);
  }
  assert.equal(canonical(map), canonical(expected));
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  delete map.r1;
  delete expected.r1;
  assert.equal(canonical(map), canonical(expected));
});
test("reduceMany public result remains structured-cloneable while internal receipt ownership matches the same canonical state", () => {
  const base = emptyState(),
    identity = { teamId: "team", repoId: "repo" };
  const op = {
    protocol: 1,
    reducer: 1,
    ...identity,
    opId: "op",
    writerEpoch: "epoch",
    actorRef: "actor",
    createdAt: "2026-10-01T00:00:00.000Z",
    dependsOn: [],
    objects: [],
    changes: [],
  };
  const plain = reduceMany(base, [op], identity);
  assert.deepEqual(structuredClone(plain), plain);
  const internal = reduceMany(base, [op], identity, {
    persistentReceipts: true,
  });
  assert.throws(() => structuredClone(internal), { name: "DataCloneError" });
  assert.equal(stateHash(internal), stateHash(plain));
  assert.deepEqual(base.receipts, {});
  assert.equal(
    stateHash(
      reduceMany(internal, [op], identity, { persistentReceipts: true }),
    ),
    stateHash(plain),
  );
});
