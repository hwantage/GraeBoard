import type { Task, Selection, Point, SelectionArea } from "../types";
import type { Column } from "./grid-types";
export function elementBelowPinnedHeading(x: number, y: number) {
  return document
    .elementsFromPoint(x, y)
    .find((element) => !element.closest(".group-heading-pin"));
}

export function rangeOf(
  selection: Selection | null,
  tasks: Task[],
  columns: Pick<Column, "key">[],
) {
  if (!selection) return null;
  const allRows = selection.kind === "columns" || selection.kind === "all";
  const allColumns = selection.kind === "rows" || selection.kind === "all";
  const r1 = allRows
      ? 0
      : tasks.findIndex((t) => t.id === selection.anchor.taskId),
    r2 = allRows
      ? tasks.length - 1
      : tasks.findIndex((t) => t.id === selection.focus.taskId),
    c1 = allColumns
      ? 0
      : columns.findIndex((c) => c.key === selection.anchor.key),
    c2 = allColumns
      ? columns.length - 1
      : columns.findIndex((c) => c.key === selection.focus.key);
  if (c1 < 0 || c2 < 0 || (!allRows && (r1 < 0 || r2 < 0))) return null;
  return {
    r1: tasks.length ? Math.min(r1, r2) : 0,
    r2: tasks.length ? Math.max(r1, r2) : -1,
    c1: Math.min(c1, c2),
    c2: Math.max(c1, c2),
  };
}

export function selectedPoints(
  selection: Selection | null,
  tasks: Task[],
  columns: Pick<Column, "key">[],
  limit = 2000,
) {
  const points = new Map<string, Point>();
  for (const r of rangesOf(selection, tasks, columns))
    for (let i = r.r1; i <= r.r2; i++)
      for (let j = r.c1; j <= r.c2; j++) {
        const p = { taskId: tasks[i].id, key: columns[j].key };
        points.set(`${p.taskId}:${p.key}`, p);
        if (points.size > limit)
          throw new Error(
            `한 번에 ${limit.toLocaleString()}개 셀까지 편집할 수 있습니다. 선택 범위를 줄여주세요.`,
          );
      }
  return [...points.values()];
}

export function rangesOf(
  selection: Selection | null,
  tasks: Task[],
  columns: Pick<Column, "key">[],
) {
  return selection
    ? [...(selection.areas || []), selection]
        .map((area) => {
          const range = rangeOf(area, tasks, columns);
          return range ? { ...range, kind: area.kind } : null;
        })
        .filter((range): range is NonNullable<typeof range> => !!range)
    : [];
}

export function savedAreas(selection: Selection | null): SelectionArea[] {
  return selection
    ? [
        ...(selection.areas || []),
        {
          anchor: selection.anchor,
          focus: selection.focus,
          kind: selection.kind,
        },
      ]
    : [];
}
