import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCellUpdates, mergeSnapshotCells } from "../src/cell-updates.js";

const task = (id, version = 1, value = "기존 값") => ({
  id,
  teamId: "team",
  years: [2026],
  position: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  cells: { title: { value, version, style: { bold: true } } },
});
const update = (id, version, value) => ({
  taskId: id,
  key: "title",
  value,
  version,
  style: { bold: true },
});

test("새 셀 알림 뒤 늦게 도착한 저장 응답·중복 알림은 최신 값을 되돌리지 않는다", () => {
  const original = [task("a"), task("b")];
  const latest = mergeCellUpdates(original, {
    cells: [update("a", 3, "다른 사용자의 후속 변경")],
  });
  const stale = {
    cells: [update("a", 2, "내 이전 저장"), update("a", 3, "중복")],
  };
  assert.strictEqual(mergeCellUpdates(latest, stale), latest);
  assert.strictEqual(latest[1], original[1]);
  assert.equal(original[0].cells.title.value, "기존 값");
  assert.equal(latest[0].cells.title.value, "다른 사용자의 후속 변경");
});

test("모아 받은 알림은 셀별 최신 버전만 반영하며 행 순서와 나머지 셀을 보존한다", () => {
  const original = [task("a"), task("b")];
  original[0].cells.status = { value: "open", version: 1, style: {} };
  const next = mergeCellUpdates(original, {
    cells: [
      update("a", 5, "최신"),
      update("a", 4, "이전"),
      update("unknown", 9, "다른 행"),
    ],
    updatedAt: { a: "2026-02-01" },
  });
  assert.deepEqual(
    next.map((t) => t.id),
    ["a", "b"],
  );
  assert.strictEqual(next[0].cells.status, original[0].cells.status);
  assert.equal(next[0].cells.title.value, "최신");
  assert.equal(next[0].updatedAt, "2026-02-01");
});

test("재접속 스냅샷은 셀만 갱신하고 더 늦게 저장된 값·현재 행 배치를 보존한다", () => {
  const local = [task("a", 3, "이미 받은 최신 값"), task("b")];
  const remote = [
    task("b", 2, "누락됐던 변경"),
    task("a", 2, "늦은 스냅샷"),
    task("c"),
  ];
  remote[0].position = 99;
  const merged = mergeSnapshotCells(local, remote);
  assert.deepEqual(
    merged.map((t) => t.id),
    ["a", "b"],
  );
  assert.strictEqual(merged[0], local[0]);
  assert.equal(merged[1].position, 1);
  assert.equal(merged[1].cells.title.value, "누락됐던 변경");
  assert.strictEqual(mergeSnapshotCells(merged, remote), merged);
});

test("셀을 추가하지 않은 공통 서식 응답·스냅샷도 적용하며 이전 응답은 되돌리지 않는다", () => {
  const original = [task("a"), task("b"), { ...task("c"), teamId: "other" }];
  const formatting = {
    revision: 2,
    rules: [
      {
        id: "row",
        rows: ["a"],
        keys: null,
        style: { bold: true },
        orders: { bold: 2 },
      },
    ],
  };
  const merged = mergeCellUpdates(original, {
    cells: [],
    formatTeamId: "team",
    formatting,
    updatedAt: { a: "2026-02-01" },
  });
  assert.equal(merged[0].formatting, formatting);
  assert.equal(merged[1].formatting, formatting);
  assert.equal(merged[0].cells, original[0].cells);
  assert.equal(merged[2], original[2]);
  assert.equal(merged[0].updatedAt, "2026-02-01");
  assert.equal(
    mergeCellUpdates(merged, {
      cells: [],
      formatTeamId: "team",
      formatting: { revision: 1, rules: [] },
    }),
    merged,
  );
  const snapshot = mergeSnapshotCells(original, merged);
  assert.equal(snapshot[0].formatting, formatting);
  assert.equal(mergeSnapshotCells(snapshot, original), snapshot);
});
