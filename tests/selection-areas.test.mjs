import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeSelection,
  changedRules,
  copyLayout,
  coversAll,
  nearbyRows,
  sheetChanges,
  subtractRange,
  toSelectionArea,
} from "../src/sheet/selection-areas.js";

const tasks = ["a", "b", "c", "d", "e"].map((id, i) => ({
  id,
  position: (i + 1) * 100,
  cells: { title: { value: id, style: {}, version: 1 } },
}));
const columns = ["title", "owner", "status", "w1", "w2"].map((key) => ({
  key,
}));
const area = (r1, r2, c1, c2, kind) => ({ r1, r2, c1, c2, kind });

test("떨어진 영역은 같은 행 또는 같은 열을 공유할 때만 한 표로 복사한다", () => {
  // 같은 행의 서로 다른 열: 사이 열은 건너뛴다.
  assert.deepEqual(copyLayout([area(1, 2, 0, 0), area(1, 2, 3, 4)]), {
    rows: [1, 2],
    columns: [0, 3, 4],
  });
  // 같은 열의 서로 다른 행과 겹친 영역.
  assert.deepEqual(copyLayout([area(3, 3, 1, 2), area(0, 1, 1, 2)]), {
    rows: [0, 1, 3],
    columns: [1, 2],
  });
  assert.deepEqual(copyLayout([area(0, 1, 0, 1), area(1, 2, 1, 2)]), null);
  assert.deepEqual(copyLayout([area(0, 1, 0, 2), area(0, 1, 1, 3)]), {
    rows: [0, 1],
    columns: [0, 1, 2, 3],
  });
  // 행 전체·열 전체 선택도 같은 규칙이다.
  assert.deepEqual(
    copyLayout([area(0, 4, 1, 1, "columns"), area(0, 4, 3, 3, "columns")]),
    { rows: [0, 1, 2, 3, 4], columns: [1, 3] },
  );
  assert.deepEqual(
    copyLayout([area(0, 0, 0, 4, "rows"), area(2, 2, 0, 4, "rows")]),
    { rows: [0, 2], columns: [0, 1, 2, 3, 4] },
  );
  // 엇갈린 영역과 한쪽만 겹친 세 영역은 행렬이 맞지 않는다.
  assert.equal(copyLayout([area(0, 0, 0, 0), area(1, 1, 1, 1)]), null);
  assert.equal(
    copyLayout([area(0, 1, 0, 1), area(3, 4, 0, 1), area(0, 1, 3, 4)]),
    null,
  );
  assert.deepEqual(copyLayout([area(2, 3, 1, 2)]), {
    rows: [2, 3],
    columns: [1, 2],
  });
  assert.deepEqual(copyLayout([area(0, -1, 0, 1)]), {
    rows: [],
    columns: [0, 1],
  });
});

test("바뀐 셀이 사각형이면 한 영역, 아니면 여러 영역을 선택하고 첫 영역으로 이동한다", () => {
  const cells = (...points) => points.map(([taskId, key]) => ({ taskId, key }));
  const block = changeSelection(
    { cells: cells(["c", "w2"], ["b", "w1"], ["b", "w2"], ["c", "w1"]) },
    tasks,
    columns,
  );
  assert.deepEqual(block.selection, {
    anchor: { taskId: "b", key: "w1" },
    focus: { taskId: "c", key: "w2" },
  });
  assert.deepEqual(block.jump, { taskId: "b", key: "w1" });
  const scattered = changeSelection(
    {
      cells: cells(["d", "title"], ["a", "status"], ["e", "title"]),
    },
    tasks,
    columns,
  );
  assert.deepEqual(scattered.selection, {
    anchor: { taskId: "a", key: "status" },
    focus: { taskId: "a", key: "status" },
    areas: [
      {
        anchor: { taskId: "d", key: "title" },
        focus: { taskId: "e", key: "title" },
      },
    ],
  });
  assert.deepEqual(scattered.jump, { taskId: "a", key: "status" });
  // 숨긴 행·열의 대상은 빼고, 보이는 대상이 없으면 선택하지 않는다.
  const visible = tasks.filter((t) => t.id !== "b");
  assert.deepEqual(
    changeSelection(
      { cells: cells(["b", "w1"], ["c", "hidden"], ["c", "w1"]) },
      visible,
      columns,
    ).selection,
    {
      anchor: { taskId: "c", key: "w1" },
      focus: { taskId: "c", key: "w1" },
    },
  );
  assert.equal(
    changeSelection({ cells: cells(["b", "w1"]) }, visible, columns),
    null,
  );
  // 영역이 너무 많으면 바뀐 셀을 감싸는 범위 하나로 보여 준다.
  const many = Array.from({ length: 101 }, (_, i) => ({
    id: `t${i}`,
    position: i,
  }));
  const wide = changeSelection(
    {
      cells: many.map((t, i) => ({
        taskId: t.id,
        key: columns[i % 2 ? 0 : 2].key,
      })),
    },
    many,
    columns,
  );
  assert.deepEqual(wide.selection, {
    anchor: { taskId: "t0", key: "title" },
    focus: { taskId: "t100", key: "status" },
  });
});

test("공통 서식 규칙은 행·열 전체 선택으로, 사라진 행은 이어받은 행으로 선택한다", () => {
  const rule = (id, rows, keys, style = { bold: true }) => ({
    id,
    rows,
    keys,
    excludeKeys: [],
    style,
    orders: { bold: 3 },
  });
  const before = [rule("same", ["a"], null), rule("old", ["c"], ["w1"])];
  const after = [
    { ...rule("same", ["a"], null), orders: { bold: 3 } },
    rule("old", ["c"], ["w1"], { bold: false }),
    rule("added", ["a", "b", "c", "d", "e", "deleted"], ["owner", "status"]),
    rule("rows", ["d", "b"], null),
  ];
  const changed = changedRules(before, after);
  assert.deepEqual(
    changed.map((r) => r.id),
    ["old", "added", "rows"],
  );
  const result = changeSelection({ rules: changed }, tasks, columns);
  // 열 서식 규칙은 보이는 행을 모두 담아 열 선택이 되고, 시트 순서상 첫 영역이다.
  assert.deepEqual(result.selection, {
    kind: "columns",
    anchor: { taskId: "a", key: "owner" },
    focus: { taskId: "a", key: "status" },
    areas: [
      {
        kind: "rows",
        anchor: { taskId: "b", key: "title" },
        focus: { taskId: "b", key: "title" },
      },
      {
        anchor: { taskId: "c", key: "w1" },
        focus: { taskId: "c", key: "w1" },
      },
      {
        kind: "rows",
        anchor: { taskId: "d", key: "title" },
        focus: { taskId: "d", key: "title" },
      },
    ],
  });
  assert.deepEqual(result.jump, { key: "owner" });
  assert.deepEqual(
    changeSelection({ rules: [rule("rows", ["d", "b"], null)] }, tasks, columns)
      .jump,
    { taskId: "b", key: "title", preserveHorizontalScroll: true },
  );
  assert.equal(
    changeSelection({ rules: [rule("all", null, null)] }, tasks, columns)
      .selection.kind,
    "all",
  );
  assert.deepEqual(nearbyRows(new Set(["b", "c"]), tasks), ["d", "a"]);
  assert.deepEqual(nearbyRows(new Set(["e"]), tasks), ["d"]);
  assert.deepEqual(nearbyRows(new Set(["x"]), tasks), []);
  assert.deepEqual(
    changeSelection(
      { near: ["gone", "d"], key: "status" },
      tasks.filter((t) => t.id !== "c"),
      columns,
    ).selection,
    {
      anchor: { taskId: "d", key: "status" },
      focus: { taskId: "d", key: "status" },
    },
  );
});

test("사본 시트 전후 비교는 바뀐 셀·서식·추가·이동 행과 삭제한 행의 자리를 찾는다", () => {
  const edited = tasks.map((t) =>
    t.id === "b"
      ? {
          ...t,
          cells: {
            ...t.cells,
            w1: { value: "새 값", style: {}, version: 1 },
          },
        }
      : t,
  );
  assert.deepEqual(sheetChanges(tasks, edited, tasks), {
    cells: [{ taskId: "b", key: "w1" }],
    rows: [],
    rules: [],
  });
  // 버전만 바뀐 셀은 바뀐 셀이 아니다.
  const touched = tasks.map((t) =>
    t.id === "a"
      ? { ...t, cells: { title: { ...t.cells.title, version: 2 } } }
      : t,
  );
  assert.deepEqual(sheetChanges(tasks, touched, tasks).cells, []);
  const added = [...tasks, { id: "f", position: 600, cells: {} }];
  assert.deepEqual(sheetChanges(tasks, added, tasks).rows, ["f"]);
  assert.deepEqual(sheetChanges(added, tasks, added), {
    near: ["e"],
    key: undefined,
  });
  assert.deepEqual(
    sheetChanges(
      tasks,
      tasks.filter((t) => t.id !== "b"),
      tasks,
      "status",
    ),
    { near: ["c", "a"], key: "status" },
  );
  // 순서 이동은 옮긴 행만, 위치 번호를 새로 매긴 다른 행은 제외한다.
  const order = ["a", "c", "d", "b", "e"];
  const moved = order.map((id, i) => ({
    ...tasks.find((t) => t.id === id),
    position: (i + 1) * 10,
  }));
  assert.deepEqual(sheetChanges(tasks, moved, tasks).rows, ["b"]);
  const formatted = tasks.map((t) => ({
    ...t,
    formatting: {
      revision: 1,
      rules: [
        {
          id: "r",
          rows: tasks.map((x) => x.id),
          keys: ["status"],
          excludeKeys: [],
          style: { bold: true },
          orders: { bold: 1 },
        },
      ],
    },
  }));
  const reverted = sheetChanges(formatted, tasks, formatted);
  assert.deepEqual(
    reverted.rules.map((r) => r.id),
    ["r"],
  );
  assert.equal(
    changeSelection(reverted, tasks, columns).selection.kind,
    "columns",
  );
});

test("현재 선택이 바뀐 셀을 모두 담으면 그대로 두고, 셀이 너무 많으면 담지 않은 것으로 본다", () => {
  const current = [area(0, 1, 0, 0), area(3, 3, 2, 4)];
  assert.equal(coversAll(current, [area(1, 1, 0, 0), area(3, 3, 3, 4)]), true);
  assert.equal(coversAll(current, [area(1, 2, 0, 0)]), false);
  assert.equal(coversAll([], [area(0, 0, 0, 0)]), false);
  assert.equal(coversAll([area(0, 99, 0, 99)], [area(0, 99, 0, 99)]), true);
  assert.equal(
    coversAll([area(0, 99, 0, 99)], [area(0, 99, 0, 99)], 9999),
    false,
  );
});

test("선택에서 범위를 빼면 남은 사각형으로 나누고 행·열 전체 선택은 그대로 남긴다", () => {
  // 겹치지 않으면 그대로 둔다.
  assert.equal(subtractRange(area(0, 1, 0, 1), area(3, 3, 3, 3), 4, 4), null);
  // 한 셀만 있는 영역은 사라진다.
  assert.deepEqual(subtractRange(area(2, 2, 3, 3), area(2, 2, 3, 3), 4, 4), []);
  // 가운데 셀을 빼면 위·왼쪽·오른쪽·아래로 나뉜다.
  assert.deepEqual(
    subtractRange(area(0, 2, 0, 2), area(1, 1, 1, 1), 4, 4).map(
      ({ r1, r2, c1, c2 }) => [r1, r2, c1, c2],
    ),
    [
      [0, 0, 0, 2],
      [1, 1, 0, 0],
      [1, 1, 2, 2],
      [2, 2, 0, 2],
    ],
  );
  // 행 전체 선택에서 한 행을 빼면 위·아래가 행 선택으로 남고, 한 셀을 빼면
  // 같은 행의 나머지는 셀 영역이 된다.
  assert.deepEqual(
    subtractRange(area(0, 3, 0, 4, "rows"), area(1, 1, 0, 4), 4, 4),
    [area(0, 0, 0, 4, "rows"), area(2, 3, 0, 4, "rows")].map(
      ({ kind, ...r }) => ({ ...r, kind }),
    ),
  );
  assert.deepEqual(
    subtractRange(area(1, 1, 0, 4, "rows"), area(1, 1, 2, 2), 4, 4),
    [
      { r1: 1, r2: 1, c1: 0, c2: 1 },
      { r1: 1, r2: 1, c1: 3, c2: 4 },
    ],
  );
  assert.deepEqual(
    subtractRange(area(0, 4, 1, 3, "columns"), area(0, 4, 2, 2), 4, 4),
    [
      { r1: 0, r2: 4, c1: 1, c2: 1, kind: "columns" },
      { r1: 0, r2: 4, c1: 3, c2: 3, kind: "columns" },
    ],
  );
  assert.deepEqual(
    subtractRange(area(0, 4, 0, 4, "all"), area(0, 4, 0, 0), 4, 4),
    [{ r1: 0, r2: 4, c1: 1, c2: 4, kind: "columns" }],
  );
  assert.deepEqual(toSelectionArea(area(1, 2, 0, 4, "rows"), tasks, columns), {
    kind: "rows",
    anchor: { taskId: "b", key: "title" },
    focus: { taskId: "c", key: "title" },
  });
});
