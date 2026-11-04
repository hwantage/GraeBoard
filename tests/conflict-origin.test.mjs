import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictOpIds,
  conflictOrigin,
  conflictPeople,
  writerOpId,
} from "../shared/conflict-origin.js";
import {
  conflictChanges,
  describeOrigin,
  describeWriters,
} from "../shared/conflict-diff.js";

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
    actor: "김바다",
    createdAt: "2026-11-03T23:29:04.995Z",
  });
  assert.deepEqual(Object.values(internal.writers), [
    { site: "external", actor: null, createdAt: null },
    { site: "internal", actor: "최형근", createdAt: "2026-11-03T07:16:46Z" },
    { site: null, initial: true, actor: null, createdAt: null },
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
  assert.equal(describeOrigin(origin.held), "외부 · 2026-11-03T23:29:04.995Z");
  assert.equal(
    describeOrigin(changes[1].writer, () => "11월 3일"),
    "사내 · 최형근 · 11월 3일",
  );
  assert.equal(describeOrigin({ initial: true }), "처음 게시된 값");
  assert.equal(describeWriters([changes[0]]), "외부");
  assert.equal(describeWriters(changes), "외부·사내 (항목마다 다름)");
  assert.equal(describeWriters([]), "");
});
