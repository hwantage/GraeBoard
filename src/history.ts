import type { HistoryEntry, SavedCell, Style, Border } from "./types";

// Only advance a prior operation when it touches the exact version we restored.
// A version gap belongs to another operation and must keep blocking undo.
export function rebaseHistory(
  entries: HistoryEntry[],
  restored: SavedCell[],
  current: SavedCell[],
) {
  const versions = new Map(
    restored.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  const latest = new Map(
    current.map((c) => [`${c.taskId}:${c.key}`, c.version]),
  );
  return entries.map((entry) =>
    "kind" in entry
      ? entry
      : {
          ...entry,
          cells: entry.cells.map((c) =>
            versions.get(`${c.taskId}:${c.key}`) === c.version
              ? {
                  ...c,
                  version: latest.get(`${c.taskId}:${c.key}`) ?? c.version,
                }
              : c,
          ),
        },
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
