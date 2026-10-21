import { test } from "node:test";
import assert from "node:assert/strict";
import { rebaseReportCells } from "../shared/report-sync.js";
const row = {
  id: "a",
  cells: {
    title: { value: "제목", style: {}, version: 1 },
    note: { value: "메모", style: {}, version: 1 },
  },
};
const edit = {
  kind: "cells",
  at: "now",
  changes: [{ taskId: "a", key: "title", value: "내 제목" }],
};
test("사본의 독립 셀 수정과 실행취소 기준에는 상대방 변경을 보존한다", () => {
  const remote = structuredClone(row);
  remote.cells.note = { value: "상대 메모", style: {}, version: 2 };
  const result = rebaseReportCells([row], [remote], [edit], {});
  assert.equal(result.tasks[0].cells.title.value, "내 제목");
  assert.equal(result.tasks[0].cells.note.value, "상대 메모");
  assert.equal(result.history[0][0].cells.note.value, "상대 메모");
});
test("사본 동일 셀 충돌·행 삭제·미저장 구조 변경은 자동 덮어쓰지 않는다", () => {
  const remote = structuredClone(row);
  remote.cells.title = { value: "상대 제목", style: {}, version: 2 };
  assert.equal(rebaseReportCells([row], [remote], [edit], {}), null);
  assert.equal(rebaseReportCells([row], [], [edit], {}), null);
  assert.equal(
    rebaseReportCells([row], [row], [{ kind: "delete", taskIds: ["a"] }], {}),
    null,
  );
});
