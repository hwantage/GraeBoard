import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictOpIds,
  conflictOrigin,
  conflictPeople,
  pendingResolutions,
  resolvesAny,
  writerOpId,
} from "../../../shared/sync/conflict-origin.js";
import {
  conflictChanges,
  conflictEditors,
  describeOrigin,
  describeWriters,
  originLabel,
} from "../../../shared/sync/conflict-diff.js";

const id = (entity, key) => JSON.stringify([entity, key]);
const record = (key, version) => ({
  entity: "cell",
  key,
  generation: "g".repeat(64),
  version,
  deleted: false,
  payload: { value: "x" },
});
const conflict = {
  conflictId: "held-op",
  opId: "held-op",
  operation: {
    opId: "held-op",
    actorRef: "person-held",
    createdAt: "2026-11-03T23:29:04.995Z",
    writerEpoch: "epoch-internal",
  },
  current: {
    [id("cell", ["t1", "score"])]: record(["t1", "score"], "peer-op:3"),
    [id("cell", ["t2", "score"])]: record(["t2", "score"], "own-op:0"),
    [id("cell", ["t3", "score"])]: record(["t3", "score"], "a".repeat(64)),
    [id("cell", ["t4", "score"])]: null,
  },
};

test("operations are looked up by the held ID and each current writer", () => {
  assert.equal(writerOpId({ version: "op-1:12" }), "op-1");
  assert.equal(writerOpId({ version: "a".repeat(64) }), null);
  assert.equal(writerOpId(null), null);
  assert.deepEqual(conflictOpIds([conflict]), ["held-op", "peer-op", "own-op"]);
  const local = new Map([
    ["own-op", { actorRef: "person-own", createdAt: "2026-11-03T07:16:46Z" }],
  ]);
  assert.deepEqual(conflictPeople([conflict], local), [
    "person-held",
    "person-own",
  ]);
});

test("an operation in this site's outbox is this site's, any other the peer's", () => {
  const names = new Map([
    ["person-held", "김바다"],
    ["person-own", "최형근"],
  ]);
  const internal = conflictOrigin(conflict, {
    site: "internal",
    local: new Map([
      ["held-op", { actorRef: "person-held", createdAt: "x" }],
      ["own-op", { actorRef: "person-own", createdAt: "2026-11-03T07:16:46Z" }],
    ]),
    names,
  });
  assert.deepEqual(internal.held, {
    site: "internal",
    actorId: "person-held",
    actor: "김바다",
    createdAt: "2026-11-03T23:29:04.995Z",
  });
  assert.deepEqual(Object.values(internal.writers), [
    { site: "external", actorId: null, actor: null, createdAt: null },
    {
      site: "internal",
      actorId: "person-own",
      actor: "최형근",
      createdAt: "2026-11-03T07:16:46Z",
    },
    { site: null, initial: true, actorId: null, actor: null, createdAt: null },
    null,
  ]);
  // The external site sees the same edits from its side; its writer epoch
  // still marks its own held operation if the outbox row is gone.
  const external = conflictOrigin(
    {
      ...conflict,
      operation: { ...conflict.operation, writerEpoch: "epoch-external" },
    },
    {
      site: "external",
      local: new Map(),
      names,
      writerEpoch: "epoch-external",
    },
  );
  assert.equal(external.held.site, "external");
  assert.deepEqual(
    Object.values(external.writers).map((writer) => writer?.site ?? null),
    ["internal", "internal", null, null],
  );
});

test("the diff names each change's writer and summarizes them", () => {
  const origin = conflictOrigin(conflict, {
    site: "internal",
    local: new Map([
      ["own-op", { actorRef: "person-own", createdAt: "2026-11-03T07:16:46Z" }],
    ]),
    names: new Map([["person-own", "최형근"]]),
  });
  const changes = conflictChanges({
    target: "cell t1/score, cell t2/score",
    base: [{ value: "a" }, { value: "a" }],
    desired: [{ value: "b" }, { value: "b" }],
    current: conflict.current,
    origin,
  });
  assert.deepEqual(
    changes.map((change) => change.writer.site),
    ["external", "internal"],
  );
  assert.equal(
    describeOrigin(origin.held),
    "(외부) · 2026-11-03T23:29:04.995Z",
  );
  assert.equal(
    describeOrigin(changes[1].writer, () => "11월 3일"),
    "최형근 (사내) · 11월 3일",
  );
  assert.equal(describeOrigin({ initial: true }), "처음 게시본");
  assert.equal(describeWriters([changes[0]]), "(외부)");
  assert.equal(describeWriters(changes), "여러 명 (외부·사내)");
  assert.equal(describeWriters([]), "");
});

test("a saved resolution is found per conflict with the choice it made", () => {
  const conflictOf = (id, desired) => ({
    conflictId: id,
    operation: {
      changes: [
        { entity: "cell", key: [id, "title"], desired: { value: desired } },
      ],
    },
  });
  const conflicts = [
    conflictOf("c1", "later"),
    conflictOf("c2", "later"),
    conflictOf("c3", "later"),
    conflictOf("c4", "later"),
  ];
  const resolution = (opId, resolves, changes) => ({
    opId,
    createdAt: "2026-11-04T02:00:00Z",
    resolves,
    changes,
  });
  const pending = [
    resolution("r1", ["c1"], []),
    resolution(
      "r2",
      ["c2"],
      [{ entity: "cell", key: ["c2", "title"], desired: { value: "later" } }],
    ),
    resolution(
      "r3",
      ["c3"],
      [{ entity: "cell", key: ["c3", "title"], desired: { value: "merged" } }],
    ),
  ];
  const saved = pendingResolutions(conflicts, pending);
  assert.deepEqual(
    [...saved].map(([id, value]) => [id, value.opId, value.choice]),
    [
      ["c1", "r1", "current"],
      ["c2", "r2", "submitted"],
      ["c3", "r3", "edited"],
    ],
  );
  assert.equal(resolvesAny(pending, ["c4", "c2"]), true);
  assert.equal(resolvesAny(pending, ["c4"]), false);
});

test("titles name the first and the later editor", () => {
  assert.equal(
    originLabel({ site: "external", actor: "김정환" }),
    "(외부) 김정환",
  );
  assert.equal(originLabel({ site: "external", actor: null }), "(외부)");
  assert.equal(originLabel({ initial: true }), "처음 게시본");
  const current = {
    [id("cell", ["t1", "score"])]: record(["t1", "score"], "peer-op:0"),
  };
  const titled = (writer) =>
    conflictEditors({
      target: "cell t1/score",
      base: [{ value: "a" }],
      desired: [{ value: "b" }],
      current,
      origin: {
        held: { site: "internal", actor: "김바다" },
        writers: { [id("cell", ["t1", "score"])]: writer },
      },
    });
  assert.equal(
    titled({ site: "external", actor: "김정환" }),
    "(외부) 김정환 → (사내) 김바다",
  );
  assert.equal(
    titled({ site: "external", actor: null }),
    "(외부) → (사내) 김바다",
  );
  assert.equal(conflictEditors({ target: "cell t1/score" }), "");
});
