import test from "node:test";
import assert from "node:assert/strict";
import {
  withSyncOperationCache,
  parseSyncOperation,
  preparedSyncOperation,
} from "../../../server/sync/core/sync-operation-cache.mjs";
import {
  canonical,
  digest,
  emptyState,
  entityId,
  protocolMarker,
  validateOperation,
} from "../../../server/sync/core/protocol.mjs";
import { makeOperation } from "../../../server/sync/core/operations.mjs";
import { reduce } from "../../../server/sync/core/reducer.mjs";
import { SYNC_OPERATION_MAX_BYTES } from "../../../shared/sync/sync-limits.js";

const identity = { teamId: "cache-team", repoId: "cache-repo" };
const state = () => ({
  ...emptyState(),
  entities: { [entityId("protocol", [])]: protocolMarker(3, "marker") },
});
const operation = () =>
  makeOperation({
    link: { ...identity, bootstrapId: "bootstrap", writerEpoch: "writer" },
    actorRef: "actor",
    opId: "create",
    before: {},
    after: {
      [entityId("person", ["person"])]: {
        entity: "person",
        key: ["person"],
        payload: { name: "Original" },
      },
    },
  });

test("sync memo freezes exact JSON, reuses its canonical bytes and releases success, failure and inherited async scopes", async () => {
  const op = operation(),
    text = canonical(op);
  let previous;
  await withSyncOperationCache(async () => {
    previous = parseSyncOperation(text);
    assert.ok(Object.isFrozen(previous.changes[0].desired));
    assert.throws(() => {
      previous.changes[0].desired.name = "mutated";
    }, TypeError);
    await Promise.resolve();
    assert.strictEqual(parseSyncOperation(text), previous);
    assert.equal(canonical(previous), text);
    const result = reduce(state(), previous, identity);
    assert.equal(result.receipt.payloadHash, digest(text));
    assert.equal(result.receipt.result, "applied");
    assert.equal(
      canonical({ embedded: previous.changes[0].desired }),
      '{"embedded":{"name":"Original"}}',
    );
    assert.ok(preparedSyncOperation(previous).validated);
  });
  assert.notStrictEqual(parseSyncOperation(text), previous);
  assert.equal(preparedSyncOperation(previous), undefined);
  withSyncOperationCache(() =>
    assert.notStrictEqual(parseSyncOperation(text), previous),
  );
  assert.throws(
    () =>
      withSyncOperationCache(() => {
        previous = parseSyncOperation(text);
        throw new Error("rollback");
      }),
    /rollback/,
  );
  withSyncOperationCache(() =>
    assert.notStrictEqual(parseSyncOperation(text), previous),
  );
  const late = await new Promise((resolve) =>
    withSyncOperationCache(() => {
      previous = parseSyncOperation(text);
      setImmediate(() =>
        resolve([parseSyncOperation(text), parseSyncOperation(text)]),
      );
    }),
  );
  assert.notStrictEqual(late[0], previous);
  assert.notStrictEqual(late[0], late[1]);
});

test("immutable validation reuse still checks identity, protocol, receipts, dependencies, parents, names and resolution state", () =>
  withSyncOperationCache(() => {
    const op = parseSyncOperation(canonical(operation())),
      initial = state();
    const result = reduce(initial, op, identity);
    assert.equal(reduce(result.state, op, identity).duplicate, true);
    assert.throws(
      () =>
        validateOperation(op, identity, initial, {
          serialized: "x".repeat(SYNC_OPERATION_MAX_BYTES + 1),
        }),
      { code: "SYNC_OPERATION_CAPACITY" },
    );
    assert.throws(
      () => validateOperation(op, { ...identity, teamId: "foreign" }, initial),
      /foreign/,
    );
    const v4 = state();
    v4.entities[entityId("protocol", [])] = protocolMarker(4, "v4");
    assert.throws(() => reduce(v4, op, identity), /protocol/);
    const changed = parseSyncOperation(
      canonical({
        ...op,
        changes: [
          { ...op.changes[0], desired: { name: "Same ID, different bytes" } },
        ],
      }),
    );
    assert.notStrictEqual(changed, op);
    assert.throws(
      () => reduce(result.state, changed, identity),
      /Immutable opId/,
    );
    const invalid = parseSyncOperation(
      canonical({
        ...op,
        changes: [
          { ...op.changes[0], desired: { name: "Bad", password: "forbidden" } },
        ],
      }),
    );
    assert.throws(() => reduce(initial, invalid, identity), /credentials/);
    // Validation success is input-only. Resolution targets can disappear or be
    // foreign when the same immutable input is projected on another state.
    const resolving = parseSyncOperation(
      canonical({ ...operation(), opId: "resolution", resolves: ["conflict"] }),
    );
    const conflicted = state();
    conflicted.conflicts.conflict = { operation: identity };
    validateOperation(resolving, identity, conflicted);
    assert.throws(
      () => validateOperation(resolving, identity, state()),
      /missing or foreign conflict/,
    );
    const dependent = parseSyncOperation(
      canonical({ ...operation(), dependsOn: ["missing"] }),
    );
    validateOperation(dependent, identity, initial);
    assert.throws(
      () => reduce(initial, dependent, identity),
      /Unordered dependency/,
    );
    const tag = parseSyncOperation(
      canonical({
        ...operation(),
        opId: "tag",
        changes: [
          {
            ...op.changes[0],
            entity: "tag",
            key: ["new-tag"],
            desired: {
              name: "Taken",
              userId: null,
              color: "green",
              kind: "label",
            },
            fields: ["name", "userId", "color", "kind"],
          },
        ],
      }),
    );
    assert.equal(reduce(initial, tag, identity).receipt.result, "applied");
    const named = state();
    named.entities[entityId("tag", ["other"])] = {
      entity: "tag",
      key: ["other"],
      generation: "g",
      version: "v",
      payload: tag.changes[0].desired,
      deleted: false,
    };
    assert.equal(reduce(named, tag, identity).receipt.result, "conflict");
    const cell = parseSyncOperation(
      canonical({
        ...operation(),
        opId: "cell",
        changes: [
          {
            ...op.changes[0],
            entity: "cell",
            key: ["task", "title"],
            desired: { value: "value", style: {} },
            fields: ["value", "style"],
          },
        ],
      }),
    );
    const parent = state();
    parent.entities[entityId("task", ["task"])] = {
      entity: "task",
      key: ["task"],
      generation: "g",
      version: "v",
      payload: {},
      deleted: false,
    };
    assert.equal(reduce(parent, cell, identity).receipt.result, "applied");
    parent.entities[entityId("task", ["task"])].deleted = true;
    assert.equal(reduce(parent, cell, identity).receipt.result, "conflict");
  }));

test("mutable callers, invalid packed data and memo capacity overflow never inherit validation success", () =>
  withSyncOperationCache(() => {
    const mutable = operation();
    validateOperation(mutable, identity, state());
    mutable.changes[0].desired.password = "forbidden";
    assert.throws(
      () => validateOperation(mutable, identity, state()),
      /credentials/,
    );
    const packed = {
      year: 2026,
      name: "Copy",
      data: {
        $styles: [{ b: true }],
        $data: {
          tasks: [
            {
              teamId: identity.teamId,
              cells: { title: { value: "Title", style: { $s: 0 } } },
            },
          ],
          users: [],
          settings: {},
          view: {},
        },
      },
    };
    const copy = {
      ...operation(),
      opId: "copy",
      changes: [
        {
          ...operation().changes[0],
          entity: "sheetClone",
          key: ["copy"],
          desired: packed,
          fields: ["name", "year", "data"],
        },
      ],
    };
    validateOperation(parseSyncOperation(canonical(copy)), identity, state());
    packed.data.$data.tasks[0].cells.title.style.$s = 9;
    assert.throws(
      () =>
        validateOperation(
          parseSyncOperation(canonical(copy)),
          identity,
          state(),
        ),
      /Invalid sheetClone payload/,
    );
    const oversized = JSON.stringify({ text: "x".repeat(8 * 1024 * 1024 + 1) });
    assert.notStrictEqual(
      parseSyncOperation(oversized),
      parseSyncOperation(oversized),
      "byte bound applies before the entry bound is full",
    );
    for (let i = 0; i < 130; i++)
      parseSyncOperation(JSON.stringify({ index: i }));
    const text = canonical(operation());
    assert.notStrictEqual(
      parseSyncOperation(text),
      parseSyncOperation(text),
      "entry bound falls back to normal parsing",
    );
  }));
