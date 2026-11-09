import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const code = stripTypeScriptTypes(
  readFileSync(
    new URL("../../src/ui/list-reorder-grid.ts", import.meta.url),
    "utf8",
  ),
  { mode: "transform" },
);
const { gridDropAt, reorderGridSlots } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const boxes = [
  { id: "a", left: 0, top: 0, width: 500, height: 100, span: 1 },
  { id: "b", left: 520, top: 0, width: 500, height: 300, span: 1 },
  { id: "c", left: 0, top: 316, width: 1020, height: 200, span: 2 },
  { id: "d", left: 0, top: 532, width: 500, height: 100, span: 1 },
  { id: "e", left: 520, top: 532, width: 500, height: 400, span: 1 },
  { id: "f", left: 0, top: 948, width: 1020, height: 50, span: 2 },
];
const layout = (ids) =>
  reorderGridSlots(
    ids.map((id) => boxes.find((box) => box.id === id)),
    [500, 500],
    20,
    16,
  );
test("grid placement uses horizontal halves of a neighbor and vertical halves of full rows, including gaps", () => {
  assert.deepEqual(gridDropAt(boxes, "a", { x: 900, y: 30 }), {
    targetId: "b",
    placement: "after",
  });
  assert.deepEqual(gridDropAt(boxes, "d", { x: 700, y: 30 }), {
    targetId: "b",
    placement: "before",
  });
  assert.deepEqual(gridDropAt(boxes, "d", { x: 800, y: 320 }), {
    targetId: "c",
    placement: "before",
  });
  assert.deepEqual(gridDropAt(boxes, "d", { x: 200, y: 512 }), {
    targetId: "c",
    placement: "after",
  });
  assert.deepEqual(gridDropAt(boxes, "a", { x: 20, y: 524 }), {
    targetId: "c",
    placement: "after",
  });
  assert.equal(gridDropAt(boxes, "a", { x: 50, y: 40 }), null);
  assert.equal(gridDropAt([boxes[0]], "a", { x: 600, y: 40 }), null);
});
test("grid preview starts wide cards on their own row and uses tallest heights and actual gaps", () => {
  assert.deepEqual(
    layout(["b", "c", "a", "d", "e", "f"]).map(({ id, left, top, width }) => [
      id,
      left,
      top,
      width,
    ]),
    [
      ["b", 0, 0, 500],
      ["c", 0, 316, 1020],
      ["a", 0, 532, 500],
      ["d", 520, 532, 500],
      ["e", 0, 648, 500],
      ["f", 0, 1064, 1020],
    ],
  );
  assert.deepEqual(
    layout(["c", "a", "b", "d", "e", "f"]).map(({ id, left, top, width }) => [
      id,
      left,
      top,
      width,
    ]),
    [
      ["c", 0, 0, 1020],
      ["a", 0, 216, 500],
      ["b", 520, 216, 500],
      ["d", 0, 532, 500],
      ["e", 520, 532, 500],
      ["f", 0, 948, 1020],
    ],
  );
  assert.deepEqual(
    layout(["a", "b", "c", "d", "e", "f"]).map(({ top }) => top),
    [0, 0, 316, 532, 532, 948],
  );
});
