import type { HistoryEntry, SavedCell, Style, Border, Task } from "./types";
import { rowFormatSignature } from "../shared/formatting.js";

export const HISTORY_LIMIT = 50;

export function appendHistory<T>(entries: T[], entry: T): T[] {
  return [...entries.slice(-(HISTORY_LIMIT - 1)), entry];
}

// Only advance a prior operation when it touches the exact version we restored.
// A version gap belongs to another operation and must keep blocking undo.
export function rebaseHistory(
  entries: HistoryEntry[],
  restored: SavedCell[],
  current: SavedCell[],
  undone?: HistoryEntry,
  result?: import("./types").BatchResult,
) {
  const versions = new Map(
    restored.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  const latest = new Map(
    current.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  return entries.map((entry) => {
    if ("kind" in entry) {
      if (entry.kind === "delete") return entry;
      const cells = { ...entry.task.cells };
      // Undoing our own edits advances versions even when a formerly empty
      // cell is restored. Keep creation undo tied to those exact versions.
      for (const c of current) {
        if (
          c.taskId === entry.task.id &&
          versions.get(`${c.taskId}:${c.key}`) === (cells[c.key]?.version ?? 0)
        )
          cells[c.key] = { value: c.value, style: c.style, version: c.version };
      }
      return { ...entry, task: { ...entry.task, cells } };
    }
    return {
      ...entry,
      ...(!("kind" in (undone || {})) &&
      (undone as import("./types").BatchResult | undefined)?.formatOperation &&
      entry.formatRevision ===
        (undone as import("./types").BatchResult).previousFormatRevision
        ? { formatRevision: result?.formatRevision }
        : {}),
      cells: entry.cells.map((c) =>
        versions.get(`${c.taskId}:${c.key}`) === c.version
          ? {
              ...c,
              version: latest.get(`${c.taskId}:${c.key}`) ?? c.version,
            }
          : c,
      ),
    };
  });
}
export function canUndoCreation(expected: Task, current: Task) {
  return (
    expected.position === current.position &&
    JSON.stringify(expected.years) === JSON.stringify(current.years) &&
    JSON.stringify(expected.defaultStyle) ===
      JSON.stringify(current.defaultStyle) &&
    rowFormatSignature(expected) === rowFormatSignature(current) &&
    [
      ...new Set([
        ...Object.keys(expected.cells),
        ...Object.keys(current.cells),
      ]),
    ].every(
      (key) =>
        (expected.cells[key]?.version ?? 0) ===
        (current.cells[key]?.version ?? 0),
    )
  );
}
export function cellsBefore(entry?: HistoryEntry): SavedCell[] {
  return entry && !("kind" in entry) ? entry.before : [];
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
    textMode: "텍스트 표시",
    textAlign: "가로 정렬",
    verticalAlign: "세로 정렬",
    borderTop: "위 테두리",
    borderRight: "오른쪽 테두리",
    borderBottom: "아래 테두리",
    borderLeft: "왼쪽 테두리",
  };
  const values: Record<string, string> = {
    left: "왼쪽",
    center: "가운데",
    right: "오른쪽",
    top: "위",
    middle: "중간",
    bottom: "아래",
    overflow: "오버플로우",
    clip: "자르기",
  };
  const describe = (k: string, v: unknown) => {
    if (typeof v === "boolean") return v ? "사용" : "해제";
    if (k === "fontSize") return `${v}pt`;
    if (v === null) return "없음";
    if (typeof v === "object" && v && "style" in v)
      return `${(v as Border).style} ${(v as Border).color}`;
    return values[String(v)] || String(v);
  };
  return (
    Object.entries(style)
      .map(([k, v]) => `${names[k] || k}: ${describe(k, v)}`)
      .join(" · ") || "기본 서식"
  );
}
