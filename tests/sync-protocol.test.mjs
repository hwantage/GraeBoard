import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonical,
  digest,
  equal,
  emptyState,
  entityId,
  stateHash,
  validateOperation,
} from "../server/sync/protocol.mjs";
import {
  reduce,
  reduceMany,
  mergeMarkdown,
  project,
} from "../server/sync/reducer.mjs";
import { operationBatch } from "../server/sync/service.mjs";
const identity = { repoId: "repo", teamId: "team" };
const operation = (id, changes, dependsOn = []) => ({
  protocol: 1,
  reducer: 1,
  ...identity,
  opId: id,
  writerEpoch: "writer",
  actorRef: "person",
  createdAt: "2026-01-01T00:00:00.000Z",
  dependsOn,
  changes,
  objects: [],
});
const change = (desired, base = null, action = base ? "edit" : "create") => ({
  entity: "person",
  key: ["p"],
  generation: "g",
  baseVersion: null,
  action,
  base,
  desired,
  fields: ["name"],
});
test("streamed hashes preserve canonical wire bytes including Unicode, escaping and numeric boundaries", () => {
  const values = [
    null,
    true,
    false,
    0,
    -0,
    0.00001,
    Number.MAX_SAFE_INTEGER,
    [null, '한글🙂\ud800\udfff\n\t"\\', false],
    { z: [], a: { 0: 0, 10: 10, 2: 2, "🙂": "𝌆" } },
    Array.from({ length: 300 }, (_, i) => ({
      z: "한글🙂".repeat(50),
      a: i,
      escaped: '\b\r\t\\"\u0000',
    })),
  ];
  for (const value of values)
    assert.equal(
      digest(value),
      createHash("sha256").update(canonical(value)).digest("hex"),
    );
  for (const value of [
    undefined,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    new Date(),
    { a: undefined },
  ])
    assert.throws(() => digest(value), /Unsupported/);
  assert.equal(
    digest("raw🙂"),
    createHash("sha256").update("raw🙂").digest("hex"),
  );
  assert.equal(
    digest(new Uint8Array([0, 255, 32])),
    createHash("sha256")
      .update(new Uint8Array([0, 255, 32]))
      .digest("hex"),
  );
  assert.equal(equal(undefined, undefined), true);
  assert.equal(equal(undefined, null), false);
});
test("immutable state and operations survive replay, conflict rollback and empty projection", () => {
  const freeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) freeze(item);
    }
    return value;
  };
  const state = freeze(
      reduce(
        emptyState(),
        operation("frozen-create", [change({ name: "original" })]),
      ).state,
    ),
    before = canonical(state);
  const ops = freeze([
    operation("frozen-edit", [change({ name: "first" }, { name: "original" })]),
    operation("frozen-loser", [
      change({ name: "second" }, { name: "original" }),
    ]),
    operation(
      "frozen-child",
      [change({ name: "latest" }, { name: "second" })],
      ["frozen-loser"],
    ),
  ]);
  const encoded = canonical(ops),
    result = reduceMany(state, ops);
  assert.equal(canonical(state), before);
  assert.equal(canonical(ops), encoded);
  assert.equal(result.receipts["frozen-child"].result, "dependency-blocked");
  assert.deepEqual(project(state, []), { entities: state.entities, held: [] });
  assert.equal(project(state, ops).held.length, 2);
  assert.equal(canonical(state), before);
});
test("large user commands remain atomic and batch envelopes stay within receiver limits", () => {
  const first = operation("large-one", [change({ name: "한".repeat(1000) })]),
    second = operation("large-two", [change({ name: "two".repeat(1000) })]);
  const batch = operationBatch([first, second], 50, 5000);
  assert.deepEqual(batch, [first]);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        protocol: 1,
        kind: "operations",
        parent: "a".repeat(40),
        operations: batch,
        resultHash: "b".repeat(64),
      }),
    ) < 5000,
  );
  assert.throws(
    () => operationBatch([first], 50, 2000),
    /envelope byte budget/,
  );
  assert.equal(first.changes[0].desired.name, "한".repeat(1000));
});
test("operation limits reject an oversized whole command without mutating the caller's draft", () => {
  const op = operation("oversized", [
    {
      entity: "cell",
      key: ["task", "description"],
      generation: "g",
      action: "create",
      baseVersion: null,
      base: null,
      desired: { value: "한".repeat(1400000), style: {} },
      fields: ["value", "style"],
    },
  ]);
  const before = digest(op);
  assert.throws(
    () => validateOperation(op, identity),
    (error) =>
      error.status === 400 &&
      error.code === "SYNC_OPERATION_CAPACITY" &&
      /4MiB/.test(error.message),
  );
  assert.equal(digest(op), before);
});
test("validated serialization is exactly the unchanged canonical command and is never exposed on validation failure", () => {
  const op = operation("serialized", [change({ name: '한글🙂\nquoted"' })]);
  const before = structuredClone(op),
    emitted = [];
  assert.strictEqual(
    validateOperation(op, identity, undefined, {
      onSerialized: (value) => emitted.push(value),
    }),
    op,
  );
  assert.deepEqual(emitted, [canonical(op)]);
  assert.deepEqual(op, before);
  const oversized = operation("oversized-serialized", [
    change({ name: "x".repeat(4 * 1024 * 1024) }),
  ]);
  for (const invalid of [{ ...op, protocol: 99 }, oversized])
    assert.throws(() =>
      validateOperation(invalid, identity, undefined, {
        onSerialized: (value) => emitted.push(value),
      }),
    );
  assert.equal(emitted.length, 1);
});

test("resolution references and version tokens reject invalid types, lengths and foreign membership before reduction", () => {
  const valid = operation("validation", [change({ name: "Name" })]);
  for (const resolves of [
    "other",
    null,
    {},
    [1],
    [""],
    ["x".repeat(201)],
    ["same", "same"],
    ["validation"],
  ])
    assert.throws(
      () => validateOperation({ ...valid, resolves }, identity),
      /resolution references/,
    );
  for (const baseVersion of [undefined, false, 1, {}, [], "", "x".repeat(513)])
    assert.throws(
      () =>
        validateOperation(
          { ...valid, changes: [{ ...valid.changes[0], baseVersion }] },
          identity,
        ),
      /Invalid entity change/,
    );
  for (const baseVersion of [null, "previous:0"])
    assert.equal(
      validateOperation(
        { ...valid, changes: [{ ...valid.changes[0], baseVersion }] },
        identity,
      ).changes[0].baseVersion,
      baseVersion,
    );
  const first = reduce(
    emptyState(),
    operation("original", [change({ name: "original" })]),
  ).state;
  const state = reduce(
    first,
    operation("loser", [change({ name: "conflict" })]),
  ).state;
  const before = stateHash(state);
  assert.throws(
    () => reduce(state, { ...valid, resolves: ["missing"] }),
    /missing or foreign conflict/,
  );
  assert.throws(
    () =>
      validateOperation({ ...valid, resolves: ["loser"] }, identity, {
        ...state,
        conflicts: {
          loser: {
            ...state.conflicts.loser,
            operation: {
              ...state.conflicts.loser.operation,
              teamId: "foreign",
            },
          },
        },
      }),
    /missing or foreign conflict/,
  );
  assert.equal(stateHash(state), before);
  const resolution = operation("resolution", []);
  resolution.resolves = ["loser"];
  const resolved = reduce(state, resolution).state;
  assert.equal(resolved.conflicts.loser.resolution, "resolution");
  assert.equal(
    stateHash(reduce(resolved, resolution).state),
    stateHash(resolved),
    "already resolved receipt replay remains idempotent",
  );
});
test("T2/T3/T5 immutable receipts preserve conflicts and dependent final drafts", () => {
  let state = reduce(
    emptyState(),
    operation("create", [change({ name: "original" })]),
  ).state;
  state = reduce(
    state,
    operation("first", [change({ name: "first" }, { name: "original" })]),
  ).state;
  const loser = operation("loser", [
    change({ name: "second" }, { name: "original" }),
  ]);
  state = reduce(state, loser).state;
  assert.equal(state.receipts.loser.result, "conflict");
  const hash = stateHash(state);
  assert.equal(stateHash(reduce(state, loser).state), hash);
  assert.throws(
    () => reduce(state, { ...loser, actorRef: "changed" }),
    /Immutable/,
  );
  state = reduce(
    state,
    operation(
      "third",
      [change({ name: "last draft" }, { name: "second" })],
      ["loser"],
    ),
  ).state;
  assert.equal(state.receipts.third.result, "dependency-blocked");
  assert.equal(
    state.conflicts.third.operation.changes[0].desired.name,
    "last draft",
  );
  assert.equal(state.entities[entityId("person", ["p"])].payload.name, "first");
});
test("T4 deterministic markdown merges only independent ranges", () => {
  assert.equal(
    mergeMarkdown("one\ntwo\nthree", "ONE\ntwo\nthree", "one\ntwo\nTHREE"),
    "ONE\ntwo\nTHREE",
  );
  assert.equal(mergeMarkdown("ab", "aXb", "aYb"), null);
  assert.equal(mergeMarkdown("hello", "bye", "hola"), null);
  assert.equal(
    mergeMarkdown("한글🙂 끝", "한글🙂 마지막", "처음 한글🙂 끝"),
    "처음 한글🙂 마지막",
  );
});
test("T6 generation prevents late edits after explicit restore", () => {
  let state = reduce(
    emptyState(),
    operation("create", [change({ name: "a" })]),
  ).state;
  state = reduce(
    state,
    operation("delete", [change(null, { name: "a" }, "delete")]),
  ).state;
  const current = state.entities[entityId("person", ["p"])];
  state = reduce(
    state,
    operation("restore", [
      {
        ...change({ name: "restored" }, null, "restore"),
        generation: "new",
        baseVersion: current.version,
      },
    ]),
  ).state;
  assert.equal(
    reduce(state, operation("late", [change({ name: "late" }, { name: "a" })]))
      .receipt.result,
    "conflict",
  );
});
test("T7 operation atomicity and T14 unsupported tenant/privilege payload rejection", () => {
  let state = reduce(
    emptyState(),
    operation("create", [change({ name: "a" })]),
  ).state;
  const bulk = operation("bulk", [
    { ...change({ name: "new" }), key: ["new"] },
    change({ name: "wrong" }, { name: "stale" }),
  ]);
  state = reduce(state, bulk).state;
  assert.equal(state.entities[entityId("person", ["new"])], undefined);
  assert.throws(
    () => reduce(state, { ...bulk, teamId: "foreign" }, identity),
    /foreign/,
  );
  assert.throws(
    () =>
      reduce(
        state,
        operation("role", [change({ name: "a", systemRole: "admin" })]),
      ),
    /privileges/,
  );
  assert.equal(
    project(state, [
      operation("draft", [change({ name: "draft" }, { name: "a" })]),
    ]).entities[entityId("person", ["p"])].payload.name,
    "draft",
  );
});

test("batch replay matches isolated command reduction including dependent failure, name constraints and rollback", () => {
  const ops = [];
  for (let i = 0; i < 80; i++)
    ops.push(
      operation("create-" + i, [
        { ...change({ name: "person " + i }), key: ["p" + i] },
      ]),
    );
  for (let i = 0; i < 80; i++) {
    ops.push(
      operation("edit-" + i, [
        {
          ...change({ name: "edited " + i }, { name: "person " + i }),
          key: ["p" + i],
        },
      ]),
    );
    ops.push(
      operation("loser-" + i, [
        {
          ...change({ name: "lost " + i }, { name: "person " + i }),
          key: ["p" + i],
        },
      ]),
    );
    ops.push(
      operation(
        "draft-" + i,
        [
          {
            ...change({ name: "last " + i }, { name: "lost " + i }),
            key: ["p" + i],
          },
        ],
        ["loser-" + i],
      ),
    );
  }
  const tag = (id, name) => ({
    entity: "tag",
    key: [id],
    generation: "g",
    baseVersion: null,
    action: "create",
    base: null,
    desired: { userId: null, name, color: "green", kind: "check" },
    fields: ["userId", "name", "color", "kind"],
  });
  ops.push(operation("tags", [tag("one", "Same")]));
  ops.push(
    operation("tag-name-collision", [
      tag("two", "same"),
      { ...change({ name: "must roll back" }), key: ["extra"] },
    ]),
  );
  let isolated = emptyState();
  for (const op of ops) isolated = reduce(isolated, op).state;
  const batch = reduceMany(emptyState(), ops);
  assert.deepEqual(batch, isolated);
  assert.equal(batch.entities[entityId("person", ["extra"])], undefined);
  assert.equal(
    batch.conflicts["draft-79"].operation.changes[0].desired.name,
    "last 79",
  );
});

test("T14 snapshots reject authority metadata and foreign image/report rows before installation", async () => {
  const { validateSnapshot } = await import("../server/sync/reducer.mjs");
  const state = reduce(
    emptyState(),
    operation("create", [change({ name: "allowed" })]),
  ).state;
  state.entities[entityId("person", ["p"])].payload.email =
    "private@example.com";
  assert.throws(() => validateSnapshot(state, identity), /privileges/);
  const document = {
    entity: "document",
    key: ["annual", "2026", "doc"],
    generation: "g",
    action: "create",
    baseVersion: null,
    base: null,
    desired: {
      title: "doc",
      position: 0,
      markdown:
        "![x](/api/document-images/foreign/" + "0".repeat(64) + ".webp)",
    },
    fields: ["title", "position", "markdown"],
  };
  assert.throws(
    () => reduce(emptyState(), operation("image", [document])),
    /Foreign/,
  );
});
