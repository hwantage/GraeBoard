import test from "node:test";
import assert from "node:assert/strict";
import { sqliteFixture } from "../../support/business-storage-fixture.mjs";
import {
  applicationEntities,
  splitSheetCloneRows,
  upgradeState,
} from "../../../server/sync/core/versions.mjs";
import {
  canonical,
  entityId,
  protocolVersion,
  sheetCloneFormatId,
  stateHash,
  validateEntityPayload,
  ROW_PROTOCOL,
} from "../../../server/sync/core/protocol.mjs";
import {
  reduce,
  reduceMany,
  validateSnapshot,
} from "../../../server/sync/core/reducer.mjs";
import { makeOperation } from "../../../server/sync/core/operations.mjs";
import {
  encodeSnapshot,
  decodeSnapshot,
} from "../../../server/sync/core/snapshot.mjs";
import {
  packSheetCloneData,
  unpackSheetCloneData,
} from "../../../shared/sheet-clones/sheet-clone-sync-data.js";

const fixedTeam = "11111111-1111-4111-8111-111111111111";
const rules = (color) => ({
  revision: 3,
  rules: [
    {
      id: "rule",
      rows: ["a", "b", "c"],
      keys: ["title"],
      excludeKeys: [],
      style: { backgroundColor: color },
      orders: { backgroundColor: 1 },
    },
  ],
});
const cell = (value) => ({ value, style: {}, version: 1 });
// Rows as both sites make them: the same formatting on two rows, another one
// on a third and a row made inside the copy without any.
const copy = (deleted = false, teamId = fixedTeam) => ({
  entity: "sheetClone",
  key: ["copy"],
  generation: "g",
  version: "v:0",
  deleted,
  payload: {
    year: 2026,
    name: "사본",
    referenceDate: "2026-11-13",
    createdBy: "u",
    createdAt: "2026-11-13T00:00:00.000Z",
    data: packSheetCloneData({
      users: [{ id: "u", name: "사용자" }],
      view: {},
      settings: {},
      tasks: [
        {
          id: "c",
          teamId,
          formatting: rules("#fff"),
          cells: { title: cell("셋째"), note: cell("메모") },
        },
        {
          id: "a",
          teamId,
          formatting: rules("#fff"),
          cells: { title: cell("첫째") },
        },
        { id: "b", teamId, formatting: rules("#000"), cells: {} },
        { id: "d", teamId, cells: { title: cell("넷째") } },
      ],
    }),
  },
});

test("protocol 5 splits a copy into its order, one record per distinct formatting and one record per row", () => {
  const records = splitSheetCloneRows(copy()),
    [parent, ...children] = records,
    formats = children.filter((r) => r.entity === "sheetCloneFormat"),
    rows = children.filter((r) => r.entity === "sheetCloneTask");
  assert.equal(records.length, 1 + 2 + 4);
  assert.deepEqual(parent.payload.order, ["c", "a", "b", "d"]);
  assert.deepEqual(Object.keys(parent.payload.data).sort(), [
    "settings",
    "users",
    "view",
  ]);
  assert.deepEqual(
    formats.map((r) => r.key),
    [
      ["copy", sheetCloneFormatId(rules("#fff"))],
      ["copy", sheetCloneFormatId(rules("#000"))],
    ],
  );
  assert.deepEqual(
    rows.map((r) => [
      r.key[1],
      r.payload.format,
      Object.keys(r.payload.cells).sort(),
    ]),
    [
      ["c", sheetCloneFormatId(rules("#fff")), ["note", "title"]],
      ["a", sheetCloneFormatId(rules("#fff")), ["title"]],
      ["b", sheetCloneFormatId(rules("#000")), []],
      ["d", null, ["title"]],
    ],
  );
  for (const record of records)
    validateEntityPayload(
      record.entity,
      record.key,
      record.payload,
      fixedTeam,
      ROW_PROTOCOL,
    );
  // The formatting is stored once, not in the rows.
  assert.ok(rows.every((r) => !("formatting" in r.payload.data)));
  // A format record is named by its value.
  assert.throws(
    () =>
      validateEntityPayload(
        "sheetCloneFormat",
        ["copy", "0".repeat(32)],
        { data: rules("#fff") },
        fixedTeam,
        ROW_PROTOCOL,
      ),
    /Invalid sheetClone format/,
  );
  // Protocol 3 does not know these records, and its copy has no order.
  assert.throws(
    () =>
      validateEntityPayload(
        "sheetCloneFormat",
        formats[0].key,
        formats[0].payload,
        fixedTeam,
      ),
    /Invalid entity key/,
  );
  assert.throws(
    () =>
      validateEntityPayload(
        "sheetClone",
        parent.key,
        { ...copy().payload, order: [] },
        fixedTeam,
      ),
    /Unsupported entity payload/,
  );
  assert.throws(
    () =>
      splitSheetCloneRows({
        ...copy(),
        payload: {
          ...copy().payload,
          data: {
            users: [],
            view: {},
            settings: {},
            tasks: [
              { id: "a", teamId: fixedTeam, cells: {} },
              { id: "a", teamId: fixedTeam, cells: {} },
            ],
          },
        },
      }),
    /Duplicate sheet clone task identity/,
  );
});

test("protocol 3 to 5 keeps every copy exactly, deleted ones included, and old state untouched", (t) => {
  const f = sqliteFixture(t);
  for (const deleted of [false, true]) {
    const state = {
        ...f.state,
        entities: {
          ...f.state.entities,
          [entityId("sheetClone", ["copy"])]: copy(deleted, f.teamId),
        },
      },
      beforeHash = stateHash(state),
      next = upgradeState(state, ROW_PROTOCOL);
    validateSnapshot(next, { teamId: f.teamId, repoId: f.link.repo_id });
    assert.equal(protocolVersion(next), ROW_PROTOCOL);
    assert.equal(stateHash(state), beforeHash);
    assert.deepEqual(next.receipts, state.receipts);
    const restored = applicationEntities(next.entities);
    for (const [id, before] of Object.entries(state.entities)) {
      if (before.entity === "protocol") continue;
      assert.equal(restored[id].deleted, before.deleted, id);
      if (before.entity !== "sheetClone") {
        assert.deepEqual(restored[id].payload, before.payload, id);
        continue;
      }
      const { data, ...rest } = restored[id].payload,
        { data: original, ...expected } = before.payload;
      assert.deepEqual(rest, expected, id);
      assert.equal(
        canonical(unpackSheetCloneData(data)),
        canonical(unpackSheetCloneData(original)),
        id,
      );
    }
    assert.equal(
      Object.keys(restored).length,
      Object.keys(state.entities).length - 1,
    );
    // Children of a deleted copy are deleted with it.
    const children = Object.values(next.entities).filter(
      (r) => r.key[0] === "copy" && r.entity !== "sheetClone",
    );
    assert.equal(children.length, 6);
    assert.ok(children.every((r) => r.deleted === deleted));
    // The same state always upgrades to the same records.
    assert.equal(stateHash(upgradeState(state, ROW_PROTOCOL)), stateHash(next));
    const decoded = decodeSnapshot(
      encodeSnapshot({ atCommit: f.link.canonical_head, state: next }),
    ).state;
    assert.equal(stateHash(decoded), stateHash(next));
    assert.throws(() => upgradeState(next, ROW_PROTOCOL), /version 3/);
  }
});

test("protocol 5 merges different cells of one row, keeps a same-cell edit as a conflict and carries one row per edit", (t) => {
  const f = sqliteFixture(t),
    state = upgradeState(
      {
        ...f.state,
        entities: {
          ...f.state.entities,
          [entityId("sheetClone", ["copy"])]: copy(false, f.teamId),
        },
      },
      ROW_PROTOCOL,
    ),
    link = { ...f.link, protocol: ROW_PROTOCOL },
    rowId = entityId("sheetCloneTask", ["copy", "c"]),
    row = state.entities[rowId],
    edit = (change) =>
      makeOperation({
        link,
        actorRef: f.user.id,
        before: { [rowId]: row },
        after: { [rowId]: { ...row, payload: change(row.payload) } },
      }),
    setCell = (key, value) =>
      edit((payload) => ({
        ...payload,
        cells: { ...payload.cells, [key]: cell(value) },
      }));
  const title = setCell("title", "제목 수정"),
    note = setCell("note", "메모 수정"),
    added = setCell("owner", "담당"),
    renamed = edit((payload) => ({
      ...payload,
      data: { ...payload.data, updatedAt: "2026-11-14T00:00:00.000Z" },
    }));
  // The command depends on the row, its copy and its formatting record.
  assert.equal(title.protocol, ROW_PROTOCOL);
  assert.deepEqual(title.changes[0].fields, ["cells"]);
  assert.ok(Buffer.byteLength(canonical(title)) < 3000);
  const orders = [
      [title, note, added, renamed],
      [renamed, added, note, title],
    ].map((ops) => reduceMany(state, ops)),
    merged = orders[0].entities[rowId].payload;
  // Either order gives the same row; its version names the last command.
  assert.deepEqual(orders[1].entities[rowId].payload, merged);
  assert.deepEqual(Object.keys(orders[0].conflicts), []);
  assert.equal(merged.cells.title.value, "제목 수정");
  assert.equal(merged.cells.note.value, "메모 수정");
  assert.equal(merged.cells.owner.value, "담당");
  assert.equal(merged.data.updatedAt, "2026-11-14T00:00:00.000Z");
  assert.equal(merged.format, row.payload.format);
  // Nothing else of the copy changes.
  for (const [id, record] of Object.entries(state.entities))
    if (id !== rowId) assert.strictEqual(orders[0].entities[id], record, id);
  // The same cell changed twice from one base: the later one is kept aside.
  const again = setCell("title", "다른 제목"),
    contested = reduceMany(state, [title, again]);
  assert.equal(
    contested.entities[rowId].payload.cells.title.value,
    "제목 수정",
  );
  assert.deepEqual(
    Object.values(contested.conflicts).map((c) => [c.opId, c.reason]),
    [[again.opId, "Concurrent field change"]],
  );
  // Removing one cell and changing another merge as well.
  const removed = edit(({ cells: { note: _note, ...cells }, ...payload }) => ({
      ...payload,
      cells,
    })),
    without = reduceMany(state, [removed, title]);
  assert.deepEqual(Object.keys(without.entities[rowId].payload.cells), [
    "title",
  ]);
  assert.deepEqual(Object.keys(without.conflicts), []);
  // A row cannot name formatting the copy does not hold, and another
  // protocol's command is refused.
  const dangling = edit((payload) => ({ ...payload, format: "f".repeat(32) }));
  assert.deepEqual(
    Object.values(reduceMany(state, [dangling]).conflicts).map((c) => c.reason),
    ["Missing sheetClone format"],
  );
  assert.throws(
    () => reduce(state, { ...title, protocol: 4, reducer: 4 }),
    /Unsupported protocol/,
  );
  assert.throws(() => reduce(f.state, title), /Unsupported protocol/);
});
