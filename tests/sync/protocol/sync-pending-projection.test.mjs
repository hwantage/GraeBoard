import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  canonical,
  digest,
  entityId,
  emptyState,
  protocolMarker,
} from "../../../server/sync/core/protocol.mjs";
import { makeOperation } from "../../../server/sync/core/operations.mjs";
import { project, reduceMany } from "../../../server/sync/core/reducer.mjs";
import { pendingNeedsProjection } from "../../../server/sync/core/projection.mjs";
import { imageSync } from "../../../worker/sync/sync-images.mjs";

const identity = {
  teamId: "11111111-1111-4111-8111-111111111111",
  repoId: "repo",
};
const record = (entity, key, payload, deleted = false) => ({
  entity,
  key,
  payload,
  deleted,
  generation: "seed",
  version: "seed",
});
const task = (id) =>
  record("task", [id], {
    years: [2026],
    position: 0,
    defaultStyle: {},
    rowStyle: {},
    createdBy: "actor",
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });
const copy = (id, name, version = 3) =>
  record("sheetClone", [id], {
    year: 2026,
    name,
    referenceDate: "2026-11-08",
    createdBy: "actor",
    createdAt: "2026-01-01T00:00:00.000Z",
    data: {
      ...(version === 3
        ? {
            tasks: [
              {
                id: "source",
                teamId: identity.teamId,
                cells: { title: { value: "snapshot", style: {} } },
              },
            ],
          }
        : {}),
      users: [],
      settings: {},
      view: {},
    },
  });
const calendar = (id, tags = []) =>
  record("calendar", [id], {
    userId: null,
    date: "2026-11-08",
    endDate: "2026-11-08",
    lane: 0,
    title: id,
    deletedAt: null,
    tags,
  });
const tag = (id, name) =>
  record("tag", [id], { userId: null, name, kind: "label", color: "green" });
const seeded = (...records) => {
  const state = emptyState();
  state.entities[entityId("protocol", [])] = protocolMarker(3, "marker");
  for (const item of records)
    state.entities[entityId(item.entity, item.key)] = item;
  return state;
};
const operation = (base, id, ...after) =>
  makeOperation({
    link: {
      ...identity,
      bootstrapId: "bootstrap",
      writerEpoch: "writer",
      protocol: base.entities[entityId("protocol", [])].payload.version,
    },
    actorRef: "actor",
    opId: id,
    before: base.entities,
    after: Object.fromEntries(after.map((r) => [entityId(r.entity, r.key), r])),
  });
const applied = (base, op) => reduceMany(base, [op], identity);

test("an immutable clone snapshot is independent of source-cell, source deletion, person and unrelated names", () => {
  const base = seeded(
    task("source"),
    record("cell", ["source", "title"], { value: "before", style: {} }),
    record("person", ["actor"], { name: "Before" }),
  );
  const pending = [operation(base, "copy", copy("local", "Local copy"))];
  const variants = [
    record("cell", ["source", "title"], { value: "after", style: {} }),
    { ...base.entities[entityId("task", ["source"])], deleted: true },
    record("person", ["actor"], { name: "Renamed author" }),
    copy("other", "Other name"),
    tag("new-tag", "Other tag"),
    calendar("other-calendar"),
  ];
  for (const [index, changed] of variants.entries()) {
    const state = applied(base, operation(base, `remote-${index}`, changed));
    assert.equal(
      pendingNeedsProjection(base, state, pending),
      false,
      changed.entity,
    );
    assert.equal(
      canonical(
        project(base, pending).entities[entityId("sheetClone", ["local"])],
      ),
      canonical(
        project(state, pending).entities[entityId("sheetClone", ["local"])],
      ),
    );
  }
});

test("same-key and normalized-name collisions, released names, parent deletes and protocol 4 children require replay", () => {
  const base = seeded(copy("remote", "Before"));
  const pending = [operation(base, "copy", copy("local", "Café"))];
  const collision = applied(
    base,
    operation(base, "rename", copy("remote", "Cafe\u0301")),
  );
  assert.equal(pendingNeedsProjection(base, collision, pending), true);
  assert.deepEqual(project(collision, pending).held, [pending[0].opId]);
  const released = applied(
    collision,
    operation(collision, "release-name", copy("remote", "Free")),
  );
  assert.equal(pendingNeedsProjection(collision, released, pending), true);
  assert.deepEqual(project(released, pending).held, []);
  const sameKey = applied(
    base,
    operation(base, "same-key", copy("local", "Different")),
  );
  assert.equal(pendingNeedsProjection(base, sameKey, pending), true);
  const parent = seeded(task("parent"));
  const cell = operation(
    parent,
    "cell",
    record("cell", ["parent", "title"], { value: "local", style: {} }),
  );
  const deleted = applied(
    parent,
    operation(parent, "delete-parent", {
      ...parent.entities[entityId("task", ["parent"])],
      deleted: true,
    }),
  );
  assert.equal(pendingNeedsProjection(parent, deleted, [cell]), true);
  assert.deepEqual(project(deleted, [cell]).held, [cell.opId]);
  const split = seeded(
    copy("split", "Before", 4),
    record("sheetCloneTask", ["split", "row"], {
      index: 0,
      data: { id: "row", teamId: identity.teamId },
    }),
    record("sheetCloneCell", ["split", "row", "title"], {
      data: { value: "before", style: {} },
    }),
  );
  split.entities[entityId("protocol", [])] = protocolMarker(4, "v4");
  const rename = operation(split, "rename-split", copy("split", "Local", 4));
  const child = applied(
    split,
    operation(
      split,
      "child",
      record("sheetCloneCell", ["split", "row", "title"], {
        data: { value: "after", style: {} },
      }),
    ),
  );
  assert.equal(pendingNeedsProjection(split, child, [rename]), true);
});

test("tag users, receipt/dependency changes, resolutions and team overlays retain the ordered replay", () => {
  const base = seeded(tag("tag", "Tag"), calendar("calendar"));
  const removal = operation(base, "remove-tag", {
    ...base.entities[entityId("tag", ["tag"])],
    deleted: true,
  });
  const linked = applied(
    base,
    operation(
      base,
      "link-tag",
      calendar("calendar", [{ id: "tag", checked: false }]),
    ),
  );
  assert.equal(pendingNeedsProjection(base, linked, [removal]), true);
  assert.deepEqual(project(base, [removal]).held, []);
  assert.deepEqual(project(linked, [removal]).held, [removal.opId]);
  const editCalendar = operation(linked, "edit-calendar", {
    ...linked.entities[entityId("calendar", ["calendar"])],
    payload: {
      ...linked.entities[entityId("calendar", ["calendar"])].payload,
      title: "Local title",
    },
  });
  const tagRenamed = applied(
    linked,
    operation(linked, "tag-renamed", tag("tag", "Remote name")),
  );
  assert.equal(
    pendingNeedsProjection(linked, tagRenamed, [editCalendar]),
    true,
  );
  const first = operation(base, "first", copy("local", "Local"));
  const received = applied(base, first);
  assert.equal(pendingNeedsProjection(base, received, [first]), true);
  const depends = {
    ...operation(base, "dependent", copy("next", "Next")),
    dependsOn: [first.opId],
  };
  assert.equal(pendingNeedsProjection(base, received, [depends]), true);
  const resolving = { ...first, resolves: ["conflict"] };
  const conflictBase = {
    ...base,
    conflicts: { conflict: { operation: identity, resolution: null } },
  };
  const conflictAfter = {
    ...conflictBase,
    conflicts: { conflict: { operation: identity, resolution: "remote" } },
  };
  assert.equal(
    pendingNeedsProjection(conflictBase, conflictAfter, [resolving]),
    true,
  );
  const teamBase = seeded(record("team", [], { name: "Before", settings: {} }));
  const teamEdit = operation(
    teamBase,
    "team",
    record("team", [], { name: "Local", settings: {} }),
  );
  assert.equal(pendingNeedsProjection(teamBase, teamBase, [teamEdit]), true);
});

test("independent image receive still installs image references retained only by pending data", async () => {
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "red" },
  })
    .webp()
    .toBuffer();
  const hash = digest(bytes),
    url = `/api/document-images/${identity.teamId}/${hash}.webp`;
  const base = seeded(task("source"));
  const pending = [
    operation(
      base,
      "copy",
      copy("local", "Local"),
      record("document", ["sheetClone", "local", "source", "doc"], {
        title: "Body",
        position: 0,
        markdown: `![pending](${url})`,
      }),
    ),
  ];
  const state = applied(
    base,
    operation(
      base,
      "remote",
      record("cell", ["source", "title"], { value: "remote", style: {} }),
    ),
  );
  assert.equal(pendingNeedsProjection(base, state, pending), false);
  const installed = [];
  const database = {
    withTeamTransaction: (_, work) =>
      work({
        sync: {
          readLink: async () => ({ installation_id: "site" }),
          readPending: async () => pending,
          readExclusions: async () => [],
        },
      }),
  };
  const r2 = {
    key: () => `images/${identity.teamId}/${hash}.webp`,
    has: async () => false,
    install: async (image, data) => installed.push({ image, data }),
  };
  await imageSync(database, identity, r2).receive(
    state,
    "head",
    { readFile: async () => bytes },
    {
      previousState: base,
      onPendingProjection: () => assert.fail("unrelated C must not replay P"),
    },
  );
  assert.equal(installed.length, 1);
  assert.equal(installed[0].image, url);
  assert.deepEqual(installed[0].data, bytes);
});
