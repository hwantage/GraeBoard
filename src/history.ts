import type { BatchResult, SavedCell, Style } from "./types";

// Only advance a prior operation when it touches the exact version we restored.
// A version gap belongs to another operation and must keep blocking undo.
export function rebaseHistory(
  entries: BatchResult[],
  restored: SavedCell[],
  current: SavedCell[],
) {
  const versions = new Map(
    restored.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  const latest = new Map(
    current.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  return entries.map((entry) => ({
    ...entry,
    cells: entry.cells.map((c) =>
      versions.get(`${c.taskId}:${c.key}`) === c.version
        ? { ...c, version: latest.get(`${c.taskId}:${c.key}`) ?? c.version }
        : c,
    ),
  }));
}
export function describeStyle(style: Style) {
  const names: Record<string, string> = {
    color: "글자색",
    backgroundColor: "배경색",
    fontFamily: "글꼴",
    fontSize: "크기",
    bold: "굵게",
    italic: "기울임",
    underline: "밑줄",
    strike: "취소선",
    wrap: "줄바꿈",
    textAlign: "가로 정렬",
    verticalAlign: "세로 정렬",
  };
  const values: Record<string, string> = {
    left: "왼쪽",
    center: "가운데",
    right: "오른쪽",
    top: "위",
    middle: "중간",
    bottom: "아래",
  };
  return (
    Object.entries(style)
      .map(
        ([k, v]) =>
          `${names[k] || k}: ${typeof v === "boolean" ? (v ? "사용" : "해제") : k === "fontSize" ? `${v}pt` : values[String(v)] || v}`,
      )
      .join(" · ") || "기본 서식"
  );
}
