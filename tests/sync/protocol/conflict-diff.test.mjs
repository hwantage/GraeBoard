import test from "node:test";
import assert from "node:assert/strict";
import {
  changedFields,
  conflictChanges,
  conflictReason,
  conflictKinds,
  diffSides,
  fieldLabel,
  payloadLines,
  sideLines,
  splitContested,
} from "../../../shared/sync/conflict-diff.js";

const record = (entity, key, payload, deleted = false) => ({
  entity,
  key,
  generation: "g".repeat(64),
  version: "v".repeat(64),
  deleted,
  payload,
});
const id = (entity, key) => JSON.stringify([entity, key]);
const lines = (rows) =>
  rows.map((row) =>
    row.type === "fold"
      ? `…${row.count}`
      : { same: " ", removed: "-", added: "+" }[row.type] + row.text,
  );

test("large created and deleted payloads keep every comparison line without argument spreading", () => {
  const text = Array.from({ length: 160000 }, (_, i) => `line-${i}`).join("\n");
  const present = { state: "present", payload: { markdown: text } };
  const absent = { state: "absent", payload: null };
  const expected = [
    "markdown: |",
    ...text.split("\n").map((line) => "  " + line),
  ];
  assert.deepEqual(sideLines(present), expected);
  for (const [from, to, type] of [
    [absent, present, "added"],
    [present, absent, "removed"],
  ]) {
    const result = diffSides(from, to);
    assert.equal(result.equal, false);
    const changed = result.rows.filter((row) => row.type === type);
    assert.deepEqual(
      changed.map((row) => row.text),
      expected,
    );
    assert.equal(
      changed.at(-1)[type === "added" ? "to" : "from"],
      expected.length,
    );
  }
});

test("a large unchanged payload can be unfolded without losing its lines", () => {
  const payload = { markdown: "unchanged\n".repeat(160000) };
  const side = { state: "present", payload };
  const result = diffSides(side, side);
  assert.equal(result.equal, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].type, "fold");
  assert.equal(result.rows[0].count, 160002);
  assert.deepEqual(
    result.rows[0].rows.map((row) => row.text),
    payloadLines(payload),
  );
});

test("pairs each change with its current record by entity key, not by order", () => {
  const changes = conflictChanges({
    target: "cell t1/title, document annual/2026/m1",
    base: [{ value: "a" }, { markdown: "x", position: 0, title: "메모" }],
    desired: [{ value: "b" }, { markdown: "y", position: 0, title: "메모" }],
    current: {
      // PostgreSQL may return the map in another key order and a year as a number.
      [id("document", ["annual", 2026, "m1"])]: record(
        "document",
        ["annual", 2026, "m1"],
        { markdown: "z", position: 0, title: "메모" },
      ),
      [id("cell", ["t1", "title"])]: record("cell", ["t1", "title"], {
        value: "c",
      }),
    },
  });
  assert.deepEqual(
    changes.map((change) => [change.name, change.key]),
    [
      ["셀", "t1/title"],
      ["문서", "annual/2026/m1"],
    ],
  );
  assert.deepEqual(changes[0].current, {
    state: "present",
    payload: { value: "c" },
  });
  assert.equal(changes[1].current.payload.markdown, "z");
});

test("a document body is compared line by line with changed characters and folded context", () => {
  const body = Array.from({ length: 30 }, (_, i) => `문장 ${i}`);
  const changed = [...body];
  changed[1] = "문장 1 추가";
  const [change] = conflictChanges({
    target: "document calendar/e1/main",
    base: [{ markdown: body.join("\n"), position: 0, title: "문서 1" }],
    desired: [{ markdown: changed.join("\n"), position: 0, title: "문서 1" }],
    current: {
      [id("document", ["calendar", "e1", "main"])]: record(
        "document",
        ["calendar", "e1", "main"],
        { markdown: body.join("\n"), position: 0, title: "문서 1" },
      ),
    },
  });
  assert.deepEqual(changedFields(change.base, change.desired), ["markdown"]);
  assert.deepEqual(changedFields(change.base, change.current), []);
  const diff = diffSides(change.current, change.desired);
  assert.equal(diff.equal, false);
  assert.deepEqual(lines(diff.rows), [
    " markdown: |",
    "   문장 0",
    "-  문장 1",
    "+  문장 1 추가",
    "   문장 2",
    "   문장 3",
    "   문장 4",
    "…27",
  ]);
  const added = diff.rows.find((row) => row.type === "added");
  assert.deepEqual(
    added.segments.filter((segment) => segment.changed).map((s) => s.text),
    [" 추가"],
  );
  const fold = diff.rows.at(-1);
  assert.equal(fold.rows.length, 27);
  assert.equal(fold.rows[0].text, "  문장 5");
});

test("fields changed by both sides and creation, deletion and absence are named", () => {
  const [cell] = conflictChanges({
    target: "cell t1/owner",
    base: [{ value: "김", style: { bold: false } }],
    desired: [{ value: "이", style: { bold: true } }],
    current: {
      [id("cell", ["t1", "owner"])]: record("cell", ["t1", "owner"], {
        value: "박",
        style: { bold: false },
      }),
    },
  });
  assert.deepEqual(changedFields(cell.base, cell.current), ["value"]);
  assert.deepEqual(changedFields(cell.base, cell.desired), ["style", "value"]);

  const [task] = conflictChanges({
    target: "task t2",
    base: [null],
    desired: [{ years: [2026], deletedAt: null }],
    current: {
      [id("task", ["t2"])]: record(
        "task",
        ["t2"],
        { years: [2026], deletedAt: "2026-11-03T04:32:18.197Z" },
        true,
      ),
    },
  });
  assert.equal(task.base.state, "absent");
  assert.equal(task.current.state, "deleted");
  assert.deepEqual(changedFields(task.base, task.desired), ["(새로 생김)"]);
  assert.deepEqual(changedFields(task.current, task.desired), [
    "(복원됨)",
    "deletedAt",
  ]);
  assert.deepEqual(lines(diffSides(task.current, task.desired).rows), [
    "-(삭제된 항목)",
    '-deletedAt: "2026-11-03T04:32:18.197Z"',
    "+deletedAt: null",
    " years:",
    "   - 2026",
  ]);

  const [missing] = conflictChanges({
    target: "tag g1",
    base: [{ name: "회의" }],
    desired: [null],
    current: { [id("tag", ["g1"])]: null },
  });
  assert.equal(missing.current.state, "absent");
  assert.deepEqual(changedFields(missing.current, missing.desired), []);
  assert.equal(diffSides(missing.current, missing.desired).equal, true);
  assert.deepEqual(changedFields(missing.base, missing.desired), ["(없어짐)"]);
});

test("payloads render with sorted keys, nested lists and visible string quotes", () => {
  assert.deepEqual(
    payloadLines({
      title: "일정",
      tags: [
        { id: "a", checked: false },
        { id: "b", checked: true },
      ],
      rowStyle: {},
      years: [],
      memo: "첫 줄\n둘째 줄",
    }),
    [
      "memo: |",
      "  첫 줄",
      "  둘째 줄",
      "rowStyle: {}",
      "tags:",
      "  - checked: false",
      '    id: "a"',
      "  - checked: true",
      '    id: "b"',
      'title: "일정"',
      "years: []",
    ],
  );
});

test("equal current and submitted sides report no difference", () => {
  const payload = { value: "same", style: {} };
  const [change] = conflictChanges({
    target: "cell t1/title",
    base: [{ value: "old", style: {} }],
    desired: [payload],
    current: {
      [id("cell", ["t1", "title"])]: record("cell", ["t1", "title"], payload),
    },
  });
  const diff = diffSides(change.current, change.desired);
  assert.equal(diff.equal, true);
  assert.deepEqual(changedFields(change.current, change.desired), []);
});

test("a large command lists the changes the other side also touched first", () => {
  // Shaped like the 2026-11-04 production conflict: a new alignment rule plus
  // hundreds of cells losing their own alignment, two of which the other side
  // had repainted in the meantime.
  const cells = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const cellStyle = (backgroundColor, textAlign) => ({
    value: "1",
    style: textAlign ? { backgroundColor, textAlign } : { backgroundColor },
  });
  const contested = new Set(["t7", "t31"]);
  const conflict = {
    target: ["formats ", ...cells.map((task) => `cell ${task}/score`)].join(
      ", ",
    ),
    result: "Concurrent field change",
    base: [{ rules: [] }, ...cells.map(() => cellStyle("#d1eee6", "right"))],
    desired: [
      {
        rules: [{ id: "r1", selector: "score", style: { textAlign: "right" } }],
      },
      ...cells.map(() => cellStyle("#d1eee6")),
    ],
    current: Object.fromEntries([
      [id("formats", []), record("formats", [], { rules: [] })],
      ...cells.map((task) => [
        id("cell", [task, "score"]),
        record(
          "cell",
          [task, "score"],
          cellStyle(contested.has(task) ? "#ffffff" : "#d1eee6", "right"),
        ),
      ]),
    ]),
  };
  const changes = conflictChanges(conflict);
  assert.equal(changes.length, 41);
  assert.equal(changes[0].name, "공통 서식");
  const split = splitContested(changes);
  assert.deepEqual(
    split.contested.map((change) => change.key),
    ["t7/score", "t31/score"],
  );
  assert.equal(split.clean.length, 39);
  assert.deepEqual(
    lines(
      diffSides(split.contested[0].current, split.contested[0].desired).rows,
    ),
    [
      " style:",
      '-  backgroundColor: "#ffffff"',
      '-  textAlign: "right"',
      '+  backgroundColor: "#d1eee6"',
      ' value: "1"',
    ],
  );
  assert.equal(conflictKinds(conflict.target), "공통 서식, 셀 40개");
  assert.equal(conflictKinds("document task/t1/main"), "문서");
  assert.equal(
    conflictReason("Concurrent field change"),
    "같은 항목을 두 곳에서 고쳐, 나중에 수정을 반영하지 않고 보관했습니다.",
  );
  assert.equal(conflictReason("Unknown reason"), "Unknown reason");
  assert.equal(fieldLabel("style"), "서식(style)");
  assert.equal(fieldLabel("source_category"), "source_category");
});
