import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultView, filteredTasks, normalizeView } from "../shared/domain.js";

const rows = [
  { status: "완료", owner: "a", supporters: ["a", "b"], score: 0 },
  { status: "진행 중", owner: "b", supporters: ["b"], score: 1 },
  { status: "예정", owner: "a", supporters: [], score: 0 },
  { status: "", owner: "", supporters: [] },
].map((fields, i) => ({
  id: String(i + 1),
  position: i,
  cells: Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, { value }]),
  ),
}));
const matchingIds = (propertyFilters, propertyFilterModes) =>
  filteredTasks(rows, {
    ...defaultView(2026),
    propertyFilters,
    propertyFilterModes,
  }).map((task) => task.id);

test("컬럼 필터는 기존 일치 조건을 유지하며 제외 값 사이 OR·컬럼 사이 AND를 적용한다", () => {
  assert.deepEqual(matchingIds({ status: ["완료"] }), ["1"]);
  assert.deepEqual(matchingIds({ status: ["완료"] }, { status: "exclude" }), [
    "2",
    "3",
    "4",
  ]);
  assert.deepEqual(
    matchingIds({ status: ["완료", "예정"] }, { status: "exclude" }),
    ["2", "4"],
  );
  assert.deepEqual(
    matchingIds(
      { status: ["완료"], owner: ["a"] },
      { status: "exclude", owner: "include" },
    ),
    ["3"],
  );
  assert.deepEqual(matchingIds({ status: [] }, { status: "exclude" }), [
    "1",
    "2",
    "3",
    "4",
  ]);
});

test("제외 필터는 미지정·숫자 0·복수 팀원 중 하나의 일치를 처리한다", () => {
  assert.deepEqual(matchingIds({ status: [""] }, { status: "exclude" }), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(matchingIds({ score: ["0"] }, { score: "exclude" }), [
    "2",
    "4",
  ]);
  assert.deepEqual(
    matchingIds({ supporters: ["b"] }, { supporters: "exclude" }),
    ["3", "4"],
  );
  assert.deepEqual(
    matchingIds({ supporters: [""] }, { supporters: "exclude" }),
    ["1", "2"],
  );
  assert.deepEqual(
    matchingIds({ supporters: ["a", ""] }, { supporters: "exclude" }),
    ["2"],
  );
});

test("필터 모드가 없는 보기는 일치로 읽고 제거된 컬럼의 필터 모드는 정리한다", () => {
  const saved = { ...defaultView(2026), propertyFilters: { status: ["완료"] } };
  delete saved.propertyFilterModes;
  const view = normalizeView(saved);
  assert.deepEqual(view.propertyFilterModes, {});
  assert.deepEqual(
    filteredTasks(rows, view).map((task) => task.id),
    ["1"],
  );
  const excluded = normalizeView({
    ...view,
    propertyFilterModes: { status: "exclude", prop_removed: "exclude" },
  });
  assert.deepEqual(excluded.propertyFilterModes, { status: "exclude" });
  assert.deepEqual(
    filteredTasks(rows, excluded).map((task) => task.id),
    ["2", "3", "4"],
  );
});
