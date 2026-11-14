import test from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  digest,
  equal,
} from "../../../server/sync/core/protocol.mjs";
import {
  parseSyncOperation,
  withSyncOperationCache,
} from "../../../server/sync/core/sync-operation-cache.mjs";

// The definition canonical() must keep byte for byte: keys sorted by UTF-16
// code unit at every level, JSON.stringify for every scalar and key.
function reference(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(reference).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + reference(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("Unsupported canonical JSON value");
}
// A small deterministic generator, so a failure can be reproduced.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const pick = (items) => items[Math.floor(next() * items.length)];
  const keys = [
    "a",
    "b",
    "A",
    "aa",
    "$data",
    "$formats",
    "_",
    "",
    "0",
    "9",
    "10",
    "2",
    "01",
    "-1",
    "1.5",
    "한글",
    "가",
    "z\u0000",
    "😀",
    "\ud800",
    "__proto__x",
    "constructor",
    'quote"',
    "back\\slash",
    " ",
  ];
  const scalars = [
    null,
    true,
    false,
    0,
    -0,
    1,
    -1,
    1.5,
    123456789012,
    1e-7,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    "",
    "text",
    "줄\n바꿈",
    "😀",
    "\udc00 lone",
    "  ",
    '"quoted"',
  ];
  const value = (depth) => {
    const roll = next();
    if (depth > 4 || roll < 0.35) return pick(scalars);
    if (roll < 0.55)
      return Array.from({ length: Math.floor(next() * 5) }, () =>
        value(depth + 1),
      );
    const object = {};
    for (let i = Math.floor(next() * 7); i > 0; i--)
      object[pick(keys)] = value(depth + 1);
    return object;
  };
  return { next, value };
}

test("canonical() equals the sorted-key definition for parsed, built and mixed values", () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const { value } = generator(seed),
      built = value(0),
      expected = reference(built);
    assert.equal(canonical(built), expected, "built, seed " + seed);
    // Parsed canonical text: keys arrive sorted, except integer-like keys,
    // which the engine orders numerically ("9" before "10").
    const parsed = JSON.parse(expected);
    assert.equal(canonical(parsed), expected, "parsed, seed " + seed);
    // An unsorted wrapper around parsed JSON, like a record around a payload.
    const record = { payload: parsed, key: ["k"], entity: "e", deleted: false };
    assert.equal(canonical(record), reference(record), "record, seed " + seed);
    // digest() hashes a string as it is and anything else as canonical text.
    if (typeof parsed !== "string")
      assert.equal(digest(parsed), digest(expected), "digest, seed " + seed);
    assert.equal(equal(built, parsed), true, "equal, seed " + seed);
  }
});

test("canonical() keeps integer-like keys in code unit order", () => {
  const value = JSON.parse('{"10":1,"9":2,"a":{"2":true,"11":false,"b":[]}}');
  assert.deepEqual(Object.keys(value), ["9", "10", "a"]);
  assert.equal(
    canonical(value),
    '{"10":1,"9":2,"a":{"11":false,"2":true,"b":[]}}',
  );
});

test("canonical() rejects what canonical JSON cannot hold, at any depth", () => {
  class Custom {}
  const invalid = [
    undefined,
    NaN,
    Infinity,
    2 ** 53,
    () => {},
    Symbol("s"),
    1n,
    new Date(0),
    new Map(),
    new Custom(),
    Object.create(null),
    Object.create({ inherited: 1 }),
  ];
  for (const bad of invalid)
    for (const wrap of [
      (x) => x,
      (x) => [x],
      (x) => ({ a: x }),
      (x) => ({ b: 1, a: { c: [x] } }),
      (x) => ({ a: { b: { c: { d: { e: { f: x } } } } } }),
    ]) {
      let expected;
      try {
        reference(wrap(bad));
      } catch (error) {
        expected = error.message;
      }
      assert.ok(expected, "the definition rejects it");
      assert.throws(() => canonical(wrap(bad)), { message: expected });
    }
  // An object with a toJSON function is rejected, not serialized through it.
  assert.throws(() => canonical({ a: 1, toJSON: () => "x" }));
  // A sparse array keeps the definition's (odd) text instead of nulls.
  const sparse = [1, , 3];
  assert.equal(canonical(sparse), reference(sparse));
  assert.equal(canonical({ a: sparse }), reference({ a: sparse }));
});

test("canonical() inside a synchronization run still reuses the run's operation text", () => {
  const { value } = generator(77),
    operation = {
      opId: "op",
      changes: [{ base: value(1), desired: value(1), entity: "e" }],
    },
    text = reference(operation);
  withSyncOperationCache(() => {
    const parsed = parseSyncOperation(text);
    assert.equal(canonical(parsed), text);
    assert.equal(canonical(parsed), text);
    assert.equal(
      canonical(parsed.changes[0].desired),
      reference(operation.changes[0].desired),
    );
    assert.equal(canonical({ wrap: parsed }), reference({ wrap: operation }));
  });
});

test("equal() answers exactly whether the canonical texts are the same", () => {
  const { value, next } = generator(4242),
    values = Array.from({ length: 400 }, () => value(0));
  // Scalars that differ only in type or sign, which the texts tell apart or not.
  values.push(0, -0, 1, "1", "", null, false, true, "true", "null", 1.5, "1.5");
  for (let i = 0; i < 6000; i++) {
    const a = values[Math.floor(next() * values.length)],
      b =
        next() < 0.3
          ? JSON.parse(reference(a))
          : values[Math.floor(next() * values.length)];
    assert.equal(
      equal(a, b),
      reference(a) === reference(b),
      reference(a) + " vs " + reference(b),
    );
  }
  for (const bad of [NaN, Infinity, 2 ** 53, undefined]) {
    assert.throws(() => equal({ a: bad }, { a: bad }));
    assert.throws(() => equal([bad], [1]));
  }
});
