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
import { validateSnapshot } from "../../../server/sync/core/reducer.mjs";
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
