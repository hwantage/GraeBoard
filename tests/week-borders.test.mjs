import { test } from "node:test";
import assert from "node:assert/strict";
import { weekBoundaryStyles, withWeekBoundaries } from "../shared/borders.js";
import { cell } from "../shared/domain.js";
import { explicitStyle } from "../shared/formatting.js";

test("이번 주는 좌우를 독립적으로 지정하고 없는 쪽은 표시 구간 경계선을 유지한다", () => {
  const left = { style: "solid", color: "#112233" };
  const right = { style: "double", color: "#445566" };
  const keys = ["title", "2026-03-09", "status"];
  assert.deepEqual(
    weekBoundaryStyles(
      keys,
      { left, right },
      { right: left },
      "2026-03-09",
    ).get("2026-03-09"),
    {
      borderLeft: left,
      borderRight: left,
    },
  );
  assert.deepEqual(
    weekBoundaryStyles(
      keys,
      { left, right },
      { left: right, right: { ...right, style: "none" } },
      "2026-03-09",
    ).get("2026-03-09"),
    {
      borderLeft: right,
      borderRight: right,
    },
  );
  for (const hidden of [[], ["title"], ["title", "2026-03-02", "status"]]) {
    assert.equal(
      weekBoundaryStyles(hidden, {}, { left, right }, "2026-03-09").size,
      0,
    );
  }
});

test("이번 주 기본선보다 행·열 공통선과 이웃 셀의 직접 지정선이 우선하며 저장 서식은 바뀌지 않는다", () => {
  const defaultLine = { style: "thick", color: "#112233" };
  const current = { style: "double", color: "#445566" };
  const manual = { style: "solid", color: "#778899" };
  const keys = ["2026-03-02", "2026-03-09", "2026-03-16"];
  const boundaries = weekBoundaryStyles(
    keys,
    {},
    { left: current, right: current },
    "2026-03-09",
  );
  for (const scope of [null, ["2026-03-09"]]) {
    const task = {
      id: "task",
      cells: {},
      defaultStyle: { borderLeft: defaultLine, borderRight: defaultLine },
      formatting: {
        revision: 1,
        rules: [
          {
            id: "rule",
            rows: ["task"],
            keys: scope,
            style: { borderRight: manual },
            orders: { borderRight: 1 },
          },
        ],
      },
    };
    const before = structuredClone(task);
    const styles = withWeekBoundaries(
      keys,
      keys.map((key) => cell(task, key).style),
      boundaries,
      keys.map((key) => explicitStyle(task, key)),
    );
    assert.deepEqual(styles[1].borderRight, manual);
    if (scope) assert.deepEqual(styles[1].borderLeft, current);
    else {
      assert.equal(styles[1].borderLeft.style, "none");
      assert.deepEqual(styles[0].borderRight, manual);
    }
    assert.deepEqual(task, before);
  }
});
