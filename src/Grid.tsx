import {
  Fragment,
  useLayoutEffect,
  useEffect,
  useState,
  useRef,
  useMemo,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer, defaultRangeExtractor } from "@tanstack/react-virtual";
import {
  MoreHorizontal,
  Plus,
  ArrowUp,
  ArrowDown,
  GripVertical,
  EyeOff,
  RotateCcw,
  Filter,
} from "lucide-react";
import type {
  Task,
  User,
  View,
  Selection,
  Point,
  Settings,
  Cell,
  Property,
  SelectionArea,
} from "./types";
import {
  canEdit,
  cell,
  displayValue,
  value,
  textLinks,
  todayKey,
  propertiesFor,
  propertyFiltersFor,
  groupValue,
  textMode,
  fontFamilyCSS,
} from "../shared/domain.js";
import { Avatar, Button, Empty } from "./components";
import InlineCellEditor, {
  type EditorState,
  type EditMove,
} from "./InlineCellEditor";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import GridHeaderMenu, { type HeaderMenuAction } from "./GridHeaderMenu";
import PropertyFilter from "./PropertyFilter";
import { bordersCSS, weekBorderStyle } from "../shared/borders.js";
import {
  createClipboard,
  copyToEvent,
  readClipboard,
  type ClipboardMatrix,
} from "./clipboard";

const ROW_HEADER_WIDTH = 48;

export type Column = {
  key: string;
  label: string;
  width: number;
  month?: number;
  fixed?: boolean;
  weekIndex?: number;
  date?: string;
  end?: string;
};
type ColumnReference = Pick<Column, "key" | "label" | "month">;
export function rangeOf(
  selection: Selection | null,
  tasks: Task[],
  columns: Column[],
) {
  if (!selection) return null;
  const r1 =
      selection.kind === "columns"
        ? 0
        : tasks.findIndex((t) => t.id === selection.anchor.taskId),
    r2 =
      selection.kind === "columns"
        ? tasks.length - 1
        : tasks.findIndex((t) => t.id === selection.focus.taskId),
    c1 =
      selection.kind === "rows"
        ? 0
        : columns.findIndex((c) => c.key === selection.anchor.key),
    c2 =
      selection.kind === "rows"
        ? columns.length - 1
        : columns.findIndex((c) => c.key === selection.focus.key);
  if (c1 < 0 || c2 < 0 || (selection.kind !== "columns" && (r1 < 0 || r2 < 0)))
    return null;
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
  columns: Column[],
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
  columns: Column[],
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
function savedAreas(selection: Selection | null): SelectionArea[] {
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
export default function Grid({
  tasks,
  allTasks,
  sourceTasks,
  columns,
  columnOrder,
  view,
  user,
  users,
  selectableUsers,
  selection,
  settings,
  editor,
  onCommit,
  onCancelEdit,
  onSelect,
  onEdit,
  onPaste,
  onClear,
  onRowMenu,
  onReorder,
  onView,
  onAdd,
  onError,
  readOnly = false,
  presentation = false,
  jump,
}: {
  tasks: Task[];
  allTasks: Task[];
  sourceTasks: Task[];
  columns: Column[];
  columnOrder: ColumnReference[];
  view: View;
  user: User;
  users: User[];
  selectableUsers: User[];
  selection: Selection | null;
  settings: Settings;
  editor: EditorState | null;
  onCommit: (point: Point, value: Cell["value"]) => boolean;
  onCancelEdit: () => void;
  onSelect: (s: Selection | null) => void;
  onEdit: (p: Point, initial?: string) => void;
  onPaste: (rows: ClipboardMatrix) => void;
  onClear: () => void;
  onRowMenu: (task: Task) => void;
  onReorder: (
    taskIds: string[],
    targetId: string,
    placement: "before" | "after",
  ) => void;
  onView: (v: Partial<View>) => void;
  onAdd: () => void;
  onError: (s: string) => void;
  readOnly?: boolean;
  presentation?: boolean;
  jump: { key: string | null; id: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const appliedJump = useRef<number | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const rowDragPointer = useRef({ x: 0, y: 0 });
  const rowDragPreview = useRef<HTMLDivElement>(null);
  const [rowDrag, setRowDrag] = useState<{
    taskId: string;
    taskIds: string[];
    targetId: string;
    placement: "before" | "after";
    valid: boolean;
  } | null>(null);
  const draggedIds = useMemo(
    () => new Set(rowDrag?.taskIds),
    [rowDrag?.taskIds],
  );
  const stopRowDrag = useRef<(() => void) | null>(null);
  const stopHeaderDrag = useRef<(() => void) | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{
    kind: "columns" | "rows";
    index: number;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => () => stopRowDrag.current?.(), []);
  useEffect(() => () => stopHeaderDrag.current?.(), [tasks, columns]);
  function positionRowDragPreview() {
    const preview = rowDragPreview.current;
    if (!preview) return;
    const { x, y } = rowDragPointer.current;
    preview.style.transform = `translate3d(${Math.max(8, Math.min(x + 18, window.innerWidth - preview.offsetWidth - 8))}px, ${Math.max(8, Math.min(y + 18, window.innerHeight - preview.offsetHeight - 8))}px, 0)`;
  }
  useLayoutEffect(positionRowDragPreview, [rowDrag]);
  const today = todayKey();
  const columnGaps = useMemo(() => {
    const visible = new Set(columns.map((c) => c.key));
    const before = new Map<string, ColumnReference[]>();
    let hidden: ColumnReference[] = [];
    for (const column of columnOrder) {
      if (!visible.has(column.key)) hidden.push(column);
      else if (hidden.length) {
        before.set(column.key, hidden);
        hidden = [];
      }
    }
    return { before, trailing: hidden };
  }, [columns, columnOrder]);
  const rowHeaderWidth = Math.max(
    ROW_HEADER_WIDTH,
    30 + String(allTasks.length).length * 6,
  );
  let offset = rowHeaderWidth;
  const positions = columns.map((c) => {
    const p = offset;
    offset += c.width;
    return p;
  });
  const totalWidth = offset;
  function revealColumns(hidden: ColumnReference[]) {
    const keys = new Set(hidden.map((c) => c.key));
    onView({
      visibleFields: [
        ...new Set([
          ...view.visibleFields,
          ...hidden.filter((c) => !c.month).map((c) => c.key),
        ]),
      ],
      hiddenWeeks: view.hiddenWeeks.filter((key) => !keys.has(key)),
    });
    ref.current?.focus({ preventScroll: true });
  }
  function columnMarker(hidden: ColumnReference[] | undefined, index: number) {
    if (presentation || !hidden?.length) return null;
    const next = columns[index];
    const fixed = next?.fixed || columns[index - 1]?.fixed;
    const left = next ? positions[index] : offset;
    const names =
      hidden.length === 1
        ? hidden[0].label
        : `${hidden[0].label} ~ ${hidden.at(-1)!.label}`;
    return (
      <div
        className={`hidden-column-marker ${fixed ? "fixed" : ""} ${next ? "" : "trailing"}`}
        role="presentation"
        style={fixed ? { left } : undefined}
      >
        <button
          type="button"
          className="hidden-column-reveal"
          data-hidden-columns={hidden.map((c) => c.key).join(" ")}
          aria-label={`숨긴 열 ${hidden.length}개 펼치기: ${names}`}
          title={`${names} · 숨긴 열 ${hidden.length}개 펼치기`}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => revealColumns(hidden)}
        >
          <span className="hidden-column-arrow left" aria-hidden="true" />
          <span className="hidden-column-arrow right" aria-hidden="true" />
        </button>
      </div>
    );
  }
  const range = rangeOf(selection, tasks, columns);
  const ranges = useMemo(
    () => rangesOf(selection, tasks, columns),
    [selection, tasks, columns],
  );
  const weekKeys = columns.filter((c) => c.month).map((c) => c.key);
  const rowMarkers = useMemo(() => {
    type Gap = { ids: string[]; start: number; end: number };
    const map = new Map<
      string,
      { number: number; before?: Gap; after?: Gap }
    >();
    const hidden = new Set(view.hiddenRows);
    let previous: string | undefined;
    let gap: Gap | undefined;
    allTasks.forEach((task, index) => {
      if (hidden.has(task.id)) {
        if (!gap) gap = { ids: [], start: index + 1, end: index + 1 };
        gap.ids.push(task.id);
        gap.end = index + 1;
      } else {
        map.set(task.id, { number: index + 1, before: gap });
        if (gap && previous) map.get(previous)!.after = gap;
        previous = task.id;
        gap = undefined;
      }
    });
    if (gap && previous) map.get(previous)!.after = gap;
    return map;
  }, [allTasks, view.hiddenRows]);
  function revealRows(ids: string[]) {
    const reveal = new Set(ids);
    onView({ hiddenRows: view.hiddenRows.filter((id) => !reveal.has(id)) });
  }
  const properties = propertiesFor(settings) as Property[];
  const propertyFilters = propertyFiltersFor(view);
  const group = properties.find((p) => p.id === view.groupBy);
  const groupKey = group?.id || "";
  const sorted = !!view.sortKey && view.sortDirection !== "default";
  function rowsToMove(task: Task) {
    if (
      selection?.kind === "rows" &&
      !(selection.areas || []).some((a) => a.kind !== "rows")
    ) {
      const index = tasks.findIndex((t) => t.id === task.id);
      if (ranges.some((r) => index >= r.r1 && index <= r.r2))
        return tasks.filter((_, i) =>
          ranges.some((r) => i >= r.r1 && i <= r.r2),
        );
    }
    return [task];
  }
  function canMoveRows(moving: Task[]) {
    if (moving.some((t) => !canEdit(user, t))) {
      onError("선택한 행에 이동 권한이 없는 업무가 포함되어 있습니다.");
      return false;
    }
    if (
      groupKey &&
      moving.some(
        (t) => groupValue(t, groupKey) !== groupValue(moving[0], groupKey),
      )
    ) {
      onError("묶음 보기에서는 같은 묶음의 행만 함께 이동할 수 있습니다.");
      return false;
    }
    return true;
  }
  function moveRows(
    moving: Task[],
    targetId: string,
    placement: "before" | "after",
  ) {
    onSelect({
      kind: "rows",
      anchor: { taskId: moving[0].id, key: columns[0].key },
      focus: { taskId: moving.at(-1)!.id, key: columns[0].key },
    });
    onReorder(
      moving.map((t) => t.id),
      targetId,
      placement,
    );
    ref.current?.focus({ preventScroll: true });
  }
  function startRowDrag(e: React.PointerEvent, task: Task) {
    if (e.button !== 0 || readOnly || sorted || editor || !canEdit(user, task))
      return;
    e.preventDefault();
    e.stopPropagation();
    const moving = rowsToMove(task);
    if (!canMoveRows(moving)) return;
    const movingTaskIds = moving.map((t) => t.id);
    const movingIds = new Set(movingTaskIds);
    stopRowDrag.current?.();
    stopHeaderDrag.current?.();
    setHeaderMenu(null);
    dragOrigin.current = null;
    const startX = e.clientX,
      startY = e.clientY;
    let x = startX,
      y = startY,
      dragging = false,
      frame = 0;
    let drop: {
      targetId: string;
      placement: "before" | "after";
      valid: boolean;
    } | null = null;
    const target = () => {
      rowDragPointer.current = { x, y };
      positionRowDragPreview();
      const element = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>(".sheet-row");
      const item = tasks.find((t) => t.id === element?.dataset.rowId);
      if (!item || movingIds.has(item.id) || !element) {
        drop = null;
      } else {
        const box = element.getBoundingClientRect();
        // A group heading is not part of the destination row's content.
        const heading =
          element.querySelector(".group-heading")?.getBoundingClientRect()
            .height || 0;
        drop = {
          targetId: item.id,
          placement:
            y < box.top + heading + (box.height - heading) / 2
              ? "before"
              : "after",
          valid:
            !groupKey ||
            groupValue(task, groupKey) === groupValue(item, groupKey),
        };
      }
      const next = {
        taskId: task.id,
        taskIds: movingTaskIds,
        ...(drop || {
          targetId: "",
          placement: "before" as const,
          valid: true,
        }),
      };
      setRowDrag((old) =>
        old?.taskId === next.taskId &&
        old.targetId === next.targetId &&
        old.placement === next.placement &&
        old.valid === next.valid
          ? old
          : next,
      );
    };
    const scroll = () => {
      const grid = ref.current;
      if (grid && dragging) {
        const box = grid.getBoundingClientRect();
        const delta = y < box.top + 64 ? -10 : y > box.bottom - 30 ? 10 : 0;
        if (delta) {
          grid.scrollTop += delta;
          target();
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!dragging && Math.hypot(x - startX, y - startY) > 4) {
        dragging = true;
        document.body.classList.add("row-reordering");
      }
      if (dragging) target();
    };
    const clean = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      document.body.classList.remove("row-reordering");
      cancelAnimationFrame(frame);
      stopRowDrag.current = null;
    };
    const cancel = () => {
      clean();
      setRowDrag(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const finishDrag = () => {
      clean();
      setRowDrag(null);
      if (dragging && drop) {
        if (drop.valid) moveRows(moving, drop.targetId, drop.placement);
        else onError("묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.");
      }
    };
    stopRowDrag.current = clean;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    frame = requestAnimationFrame(scroll);
  }
  const groupHeight = (i: number) =>
    !!group &&
    (i === 0 ||
      groupValue(tasks[i], groupKey) !== groupValue(tasks[i - 1], groupKey))
      ? 28
      : 0;
  const groupCounts = new Map<string, number>();
  if (group)
    for (const t of tasks) {
      const key = groupValue(t, groupKey);
      groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
    }
  const rowHeight = (i: number) => {
    const height = Math.max(
      view.density === "comfortable" ? 48 : 38,
      ...Object.values(tasks[i].cells).map((c) =>
        Math.ceil(
          (c.style.fontSize || tasks[i].defaultStyle?.fontSize || 9) *
            (4 / 3) *
            1.55 +
            16,
        ),
      ),
    );
    return (
      groupHeight(i) +
      (view.rowHeights[tasks[i].id] ||
        (view.density === "dense"
          ? Math.max(26, Math.round((height * 2) / 3))
          : height))
    );
  };
  const virtual = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => ref.current,
    estimateSize: rowHeight,
    overscan: 8,
    getItemKey: (i) => tasks[i].id,
    scrollMargin: 32,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range);
      const active = tasks.findIndex((t) => t.id === editor?.point.taskId);
      return active >= 0
        ? [...new Set([...indices, active])].sort((a, b) => a - b)
        : indices;
    },
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [view.rowHeights, view.density, view.groupBy, tasks]);
  useLayoutEffect(() => {
    if (jump && ref.current && appliedJump.current !== jump.id) {
      if (jump.key === null) {
        ref.current.scrollLeft = 0;
        appliedJump.current = jump.id;
        return;
      }
      const index = columns.findIndex((c) => c.key === jump.key);
      if (index >= 0) {
        const pinned =
          rowHeaderWidth +
          columns.filter((c) => c.fixed).reduce((s, c) => s + c.width, 0);
        ref.current.scrollLeft = Math.max(0, positions[index] - pinned - 80);
        appliedJump.current = jump.id;
      }
    }
  }, [jump?.id, columns.length]);
  useLayoutEffect(() => {
    if (!editor) return;
    const ri = tasks.findIndex((t) => t.id === editor.point.taskId);
    if (ri >= 0) virtual.scrollToIndex(ri, { align: "auto" });
    ref.current
      ?.querySelector(
        `[data-cell="${editor.point.taskId}:${editor.point.key}"]`,
      )
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [editor?.point.taskId, editor?.point.key]);
  function finish(value: Cell["value"], move?: EditMove) {
    if (!editor) return;
    const point = editor.point;
    if (!onCommit(point, value)) return false;
    if (move) {
      const r = tasks.findIndex((t) => t.id === point.taskId),
        c = columns.findIndex((c) => c.key === point.key);
      let nextR = r,
        nextC = c;
      if (move === "down") nextR = Math.min(tasks.length - 1, r + 1);
      else {
        nextC += move === "previous" ? -1 : 1;
        if (nextC >= columns.length && r < tasks.length - 1) {
          nextR++;
          nextC = 0;
        } else if (nextC < 0 && r > 0) {
          nextR--;
          nextC = columns.length - 1;
        }
        nextC = Math.max(0, Math.min(columns.length - 1, nextC));
      }
      pick({ taskId: tasks[nextR].id, key: columns[nextC].key });
      virtual.scrollToIndex(nextR, { align: "auto" });
    }
    return true;
  }
  function sortColumn(key: string, direction: "asc" | "desc" | "default") {
    onView({
      sortKey: direction === "default" ? "" : key,
      sortDirection: direction,
      sort: "position",
    });
  }
  function headerSelection(
    kind: "columns" | "rows",
    anchor: number,
    focus: number,
  ): Selection {
    return kind === "columns"
      ? {
          kind,
          anchor: { taskId: tasks[0]?.id || "", key: columns[anchor].key },
          focus: { taskId: tasks[0]?.id || "", key: columns[focus].key },
        }
      : {
          kind,
          anchor: { taskId: tasks[anchor].id, key: columns[0].key },
          focus: { taskId: tasks[focus].id, key: columns[0].key },
        };
  }
  function selectHeader(
    kind: "columns" | "rows",
    index: number,
    extend = false,
    add = false,
  ) {
    let anchor = index;
    if (extend && selection?.kind === kind) {
      const previous =
        kind === "columns"
          ? columns.findIndex((c) => c.key === selection.anchor.key)
          : tasks.findIndex((t) => t.id === selection.anchor.taskId);
      if (previous >= 0) anchor = previous;
    }
    onSelect({
      ...headerSelection(kind, anchor, index),
      areas: add
        ? savedAreas(selection)
        : extend
          ? selection?.areas
          : undefined,
    });
    ref.current?.focus({ preventScroll: true });
    return anchor;
  }
  function startHeaderSelection(
    e: React.PointerEvent,
    kind: "columns" | "rows",
    index: number,
  ) {
    if (e.button !== 0 || presentation) return;
    e.preventDefault();
    e.stopPropagation();
    setHeaderMenu(null);
    dragOrigin.current = null;
    stopHeaderDrag.current?.();
    const previousSelection = selection;
    const additive = e.metaKey || e.ctrlKey;
    const areas = additive
      ? savedAreas(selection)
      : e.shiftKey
        ? selection?.areas
        : undefined;
    const anchor = selectHeader(kind, index, e.shiftKey, additive);
    const origin = { x: e.clientX, y: e.clientY };
    let x = e.clientX,
      y = e.clientY,
      last = index,
      frame = 0,
      dragging = false;
    const update = () => {
      const grid = ref.current;
      if (!grid) return;
      const box = grid.getBoundingClientRect();
      const element = document.elementFromPoint(
        Math.max(box.left + 2, Math.min(x, box.right - 14)),
        kind === "columns"
          ? box.top + 16
          : Math.max(box.top + 34, Math.min(y, box.bottom - 14)),
      );
      const next =
        kind === "columns"
          ? columns.findIndex(
              (c) =>
                c.key ===
                element?.closest<HTMLElement>("[data-header-key]")?.dataset
                  .headerKey,
            )
          : tasks.findIndex(
              (t) =>
                t.id ===
                element?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId,
            );
      if (next >= 0 && next !== last) {
        last = next;
        onSelect({ ...headerSelection(kind, anchor, next), areas });
      }
    };
    const move = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      dragging ||= Math.hypot(x - origin.x, y - origin.y) > 3;
      if (dragging) update();
    };
    const scroll = () => {
      const grid = ref.current;
      if (grid && dragging) {
        const box = grid.getBoundingClientRect();
        if (kind === "columns") {
          const fixedWidth =
            rowHeaderWidth +
            columns.filter((c) => c.fixed).reduce((n, c) => n + c.width, 0);
          const delta =
            x > box.right - 28
              ? 12
              : x < box.left + fixedWidth + 10 && x > box.left + fixedWidth
                ? -12
                : 0;
          if (delta) {
            grid.scrollLeft += delta;
            update();
          }
        } else {
          const delta = y > box.bottom - 28 ? 10 : y < box.top + 48 ? -10 : 0;
          if (delta) {
            grid.scrollTop += delta;
            update();
          }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      stopHeaderDrag.current = null;
    };
    const cancel = () => {
      stop();
      onSelect(previousSelection);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    stopHeaderDrag.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    frame = requestAnimationFrame(scroll);
  }
  function openHeaderMenu(
    e: React.MouseEvent,
    kind: "columns" | "rows",
    index: number,
  ) {
    e.preventDefault();
    if (e.ctrlKey) return;
    showHeaderMenu(kind, index, e.clientX, e.clientY);
  }
  function showHeaderMenu(
    kind: "columns" | "rows",
    index: number,
    x: number,
    y: number,
  ) {
    if (presentation) return;
    const alreadySelected = ranges.some(
      (r) =>
        r.kind === kind &&
        (kind === "columns"
          ? index >= r.c1 && index <= r.c2
          : index >= r.r1 && index <= r.r2),
    );
    if (!alreadySelected) selectHeader(kind, index);
    setHeaderMenu({ kind, index, x, y });
  }
  const menuColumn =
    headerMenu?.kind === "columns" ? columns[headerMenu.index] : undefined;
  const menuColumns = menuColumn
    ? range
      ? columns.filter((_, i) => ranges.some((r) => i >= r.c1 && i <= r.c2))
      : [menuColumn]
    : [];
  const menuProperty = properties.find((p) => p.id === menuColumn?.key);
  const menuActions: HeaderMenuAction[] =
    headerMenu?.kind === "columns"
      ? [
          {
            label: "열 숨기기",
            icon: <EyeOff size={15} />,
            disabled: !menuColumns.some((c) => c.key !== "title"),
            run: () => {
              const keys = new Set(
                menuColumns.filter((c) => c.key !== "title").map((c) => c.key),
              );
              onView({
                visibleFields: view.visibleFields.filter(
                  (key) => !keys.has(key),
                ),
                hiddenWeeks: [
                  ...new Set([
                    ...view.hiddenWeeks,
                    ...menuColumns.filter((c) => c.month).map((c) => c.key),
                  ]),
                ],
              });
            },
          },
          {
            label: "오름차순 정렬",
            icon: <ArrowUp size={15} />,
            disabled: !menuColumn || !!menuColumn.month,
            run: () => sortColumn(menuColumn!.key, "asc"),
          },
          {
            label: "내림차순 정렬",
            icon: <ArrowDown size={15} />,
            disabled: !menuColumn || !!menuColumn.month,
            run: () => sortColumn(menuColumn!.key, "desc"),
          },
          {
            label: "정렬 해제",
            icon: <RotateCcw size={15} />,
            disabled: !sorted || menuColumn?.key !== view.sortKey,
            run: () => sortColumn("", "default"),
          },
        ]
      : [
          {
            label: "행 숨기기",
            icon: <EyeOff size={15} />,
            run: () => {
              if (range)
                onView({
                  hiddenRows: [
                    ...new Set([
                      ...view.hiddenRows,
                      ...tasks
                        .filter((_, i) =>
                          ranges.some((r) => i >= r.r1 && i <= r.r2),
                        )
                        .map((t) => t.id),
                    ]),
                  ],
                });
            },
          },
          {
            label: "업무 상세",
            icon: <MoreHorizontal size={15} />,
            disabled: !range || range.r1 !== range.r2,
            run: () => {
              if (headerMenu && tasks[headerMenu.index])
                onRowMenu(tasks[headerMenu.index]);
            },
          },
        ];
  function pick(point: Point, extend = false, add = false) {
    if (!extend || !selection)
      onSelect({
        anchor: point,
        focus: point,
        areas: add ? savedAreas(selection) : undefined,
      });
    else
      onSelect({
        anchor: selection.anchor,
        focus: point,
        areas: selection.areas,
      });
    ref.current?.focus({ preventScroll: true });
    // Firefox can clear focus when the blurred textarea unmounts. Restore the
    // grid after that commit, unless a new editor has already taken focus.
    requestAnimationFrame(() => {
      if (!ref.current?.querySelector(".inline-editor"))
        ref.current?.focus({ preventScroll: true });
    });
  }
  function keyboard(e: KeyboardEvent) {
    if (
      (e.target instanceof Element &&
        e.target.closest("input,textarea,select,button,a")) ||
      editor ||
      e.nativeEvent.isComposing
    )
      return;
    if (e.key === "Escape") {
      onSelect(null);
      return;
    }
    if (!selection || !tasks.length) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      onSelect({
        anchor: { taskId: tasks[0].id, key: columns[0].key },
        focus: { taskId: tasks.at(-1)!.id, key: columns.at(-1)!.key },
      });
      return;
    }
    const ri = tasks.findIndex((t) => t.id === selection.focus.taskId),
      ci = columns.findIndex((c) => c.key === selection.focus.key);
    if (ri < 0 || ci < 0) return;
    const delta: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    if (delta[e.key]) {
      e.preventDefault();
      const [dr, dc] = delta[e.key],
        r = Math.max(0, Math.min(tasks.length - 1, ri + dr)),
        c = Math.max(0, Math.min(columns.length - 1, ci + dc));
      if (
        e.shiftKey &&
        selection.kind === "columns" &&
        ["ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        selectHeader("columns", c, true);
        return;
      }
      if (
        e.shiftKey &&
        selection.kind === "rows" &&
        ["ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        selectHeader("rows", r, true);
        virtual.scrollToIndex(r, { align: "auto" });
        return;
      }
      pick(
        { taskId: tasks[r].id, key: columns[c].key },
        e.shiftKey && e.key !== "Tab",
      );
      virtual.scrollToIndex(r, { align: "auto" });
      const el = ref.current?.querySelector(
        `[data-cell="${tasks[r].id}:${columns[c].key}"]`,
      );
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (readOnly) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      onEdit(selection.focus);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClear();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onEdit(selection.focus, e.key);
    }
  }
  function resize(
    e: React.PointerEvent,
    start: number,
    commit: (n: number) => void,
    min = 45,
    max = 850,
  ) {
    e.preventDefault();
    e.stopPropagation();
    dragOrigin.current = null;
    const origin = e.clientX;
    const handle = (ev: PointerEvent) => {
      commit(Math.min(max, Math.max(min, start + ev.clientX - origin)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", handle);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handle);
    window.addEventListener("pointerup", stop, { once: true });
  }
  return (
    <div
      className="grid-area"
      style={{ "--row-header-width": `${rowHeaderWidth}px` } as CSSProperties}
    >
      <div
        ref={ref}
        tabIndex={0}
        role="grid"
        aria-label="연간 업무 일정"
        aria-rowcount={allTasks.length + 1}
        aria-colcount={columns.length + 1}
        aria-readonly={readOnly}
        className="sheet-scroll"
        data-density={view.density}
        onKeyDown={keyboard}
        onPointerUp={() => {
          dragOrigin.current = null;
        }}
        onPointerCancel={() => {
          dragOrigin.current = null;
        }}
        onCopy={(e) => {
          if (editor || !range) return;
          e.preventDefault();
          if (selection?.areas?.length) {
            onError("복사할 때는 하나의 연속된 영역을 선택하세요.");
            return;
          }
          try {
            copyToEvent(
              e.clipboardData,
              createClipboard(
                tasks.slice(range.r1, range.r2 + 1),
                columns.slice(range.c1, range.c2 + 1).map((c) => c.key),
                users,
                settings,
              ),
            );
          } catch (err) {
            onError((err as Error).message);
          }
        }}
        onPaste={(e) => {
          if (editor || readOnly || !selection) return;
          e.preventDefault();
          try {
            onPaste(readClipboard(e.clipboardData));
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      >
        <div className="sheet-header" role="row" style={{ width: totalWidth }}>
          <div className="row-number header-cell" role="columnheader">
            {presentation ? (
              "#"
            ) : (
              <button
                className="row-select"
                aria-label="모든 셀 선택"
                disabled={!tasks.length}
                onClick={() => {
                  onSelect({
                    anchor: { taskId: tasks[0].id, key: columns[0].key },
                    focus: {
                      taskId: tasks.at(-1)!.id,
                      key: columns.at(-1)!.key,
                    },
                  });
                  ref.current?.focus();
                }}
              >
                #
              </button>
            )}
          </div>
          {columns.map((c, ci) => (
            <Fragment key={c.key}>
              {columnMarker(columnGaps.before.get(c.key), ci)}
              <div
                key={c.key}
                role="columnheader"
                data-header-key={c.key}
                aria-selected={ranges.some(
                  (r) => r.kind === "columns" && ci >= r.c1 && ci <= r.c2,
                )}
                onPointerDown={(e) => startHeaderSelection(e, "columns", ci)}
                onContextMenu={(e) => openHeaderMenu(e, "columns", ci)}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    const box = e.currentTarget.getBoundingClientRect();
                    showHeaderMenu("columns", ci, box.left, box.bottom);
                  }
                }}
                aria-sort={
                  c.month
                    ? undefined
                    : view.sortKey === c.key
                      ? view.sortDirection === "asc"
                        ? "ascending"
                        : view.sortDirection === "desc"
                          ? "descending"
                          : "none"
                      : "none"
                }
                className={`header-cell ${c.fixed ? "fixed" : c.month ? "week-heading" : ""} ${c.key <= today && (c.end || "") >= today ? "this-week" : ""}`}
                style={{
                  width: c.width,
                  ...(c.fixed ? { left: positions[ci] } : {}),
                  ...bordersCSS(
                    weekBorderStyle(c.key, weekKeys, settings.weekBorders),
                  ),
                }}
              >
                {presentation ? (
                  <span
                    className="week-label"
                    title={c.month ? `${c.key} ~ ${c.end}` : c.label}
                  >
                    {c.label}
                  </span>
                ) : (
                  <button
                    className={`column-select ${c.month ? "week-label" : ""}`}
                    aria-label={`${c.label}${c.month ? " 주차" : ""} 열 선택`}
                    onClick={(e) => {
                      if (e.detail === 0)
                        selectHeader(
                          "columns",
                          ci,
                          e.shiftKey,
                          e.metaKey || e.ctrlKey,
                        );
                    }}
                    title="클릭하여 열 선택 · 드래그하여 여러 열 선택 · 우클릭하여 열 메뉴"
                  >
                    {c.label}
                    {view.sortKey === c.key ? (
                      view.sortDirection === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : null}
                    {!!propertyFilters[c.key]?.length && (
                      <span
                        className="column-filter-indicator"
                        role="img"
                        aria-label={`${c.label} 필터 적용`}
                        title={`${propertyFilters[c.key].length}개 ${view.propertyFilterModes?.[c.key] === "exclude" ? "제외" : "일치"}`}
                      >
                        <Filter size={12} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                )}
                {!presentation && (
                  <span
                    className="column-resizer"
                    role="separator"
                    aria-label={`${c.label} 너비 조절`}
                    onPointerDown={(e) =>
                      resize(
                        e,
                        c.width,
                        (w) =>
                          onView({ widths: { ...view.widths, [c.key]: w } }),
                        c.month ? 40 : 45,
                      )
                    }
                  />
                )}
              </div>
            </Fragment>
          ))}
          {columnMarker(columnGaps.trailing, columns.length)}
        </div>
        <div
          className="virtual-body"
          style={{ height: virtual.getTotalSize(), width: totalWidth }}
        >
          {virtual.getVirtualItems().map((row) => {
            const task = tasks[row.index];
            const marker = rowMarkers.get(task.id);
            const rowNumber = marker?.number || row.index + 1;
            return (
              <div
                key={task.id}
                role="row"
                aria-rowindex={rowNumber + 1}
                data-row-id={task.id}
                className={`sheet-row ${draggedIds.has(task.id) ? "row-dragging" : ""} ${rowDrag?.targetId === task.id ? (rowDrag.valid ? `row-drop-${rowDrag.placement}` : "row-drop-invalid") : ""}`}
                style={
                  {
                    "--row-group-height": `${groupHeight(row.index)}px`,
                    height: row.size,
                    paddingTop: groupHeight(row.index),
                    width: totalWidth,
                    transform: `translateY(${row.start - virtual.options.scrollMargin}px)`,
                  } as CSSProperties
                }
              >
                {!!groupHeight(row.index) && (
                  <div className="group-heading" role="presentation">
                    <span>
                      {group && value(task, groupKey) ? (
                        group.kind === "option" ? (
                          <PropertyBadge
                            property={group}
                            value={groupValue(task, groupKey)}
                          />
                        ) : (
                          displayValue(task, groupKey, users, settings)
                        )
                      ) : (
                        `${group?.name || "속성"} 미지정`
                      )}{" "}
                      <small>
                        {groupCounts.get(groupValue(task, groupKey))}개 업무
                      </small>
                    </span>
                  </div>
                )}
                <div
                  className="row-number"
                  role="rowheader"
                  aria-selected={ranges.some(
                    (r) =>
                      r.kind === "rows" &&
                      row.index >= r.r1 &&
                      row.index <= r.r2,
                  )}
                  onContextMenu={(e) => openHeaderMenu(e, "rows", row.index)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "ContextMenu" ||
                      (e.shiftKey && e.key === "F10")
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      const box = e.currentTarget.getBoundingClientRect();
                      showHeaderMenu("rows", row.index, box.right, box.top);
                    }
                  }}
                >
                  {presentation ? (
                    <span>{rowNumber}</span>
                  ) : (
                    <>
                      <button
                        className="row-drag-handle"
                        aria-label={`${value(task, "title")} 순서 이동`}
                        disabled={
                          readOnly || sorted || !!editor || !canEdit(user, task)
                        }
                        title={
                          sorted
                            ? "컬럼 머리글 우클릭 → 정렬 해제 후 이동할 수 있습니다."
                            : "손잡이를 드래그하여 행 이동 · 여러 행 선택 시 함께 이동 · Alt+위/아래 방향키"
                        }
                        onPointerDown={(e) => startRowDrag(e, task)}
                        onKeyDown={(e) => {
                          if (
                            !e.altKey ||
                            !["ArrowUp", "ArrowDown"].includes(e.key)
                          )
                            return;
                          e.preventDefault();
                          e.stopPropagation();
                          const moving = rowsToMove(task);
                          if (!canMoveRows(moving)) return;
                          const movingIds = new Set(moving.map((t) => t.id));
                          const same = tasks.filter(
                            (t) =>
                              !groupKey ||
                              groupValue(t, groupKey) ===
                                groupValue(task, groupKey),
                          );
                          const direction = e.key === "ArrowUp" ? -1 : 1;
                          const index =
                            direction < 0
                              ? same.findIndex((t) => movingIds.has(t.id))
                              : same.findLastIndex((t) => movingIds.has(t.id));
                          const neighbor = same[index + direction];
                          if (neighbor)
                            moveRows(
                              moving,
                              neighbor.id,
                              direction < 0 ? "before" : "after",
                            );
                        }}
                      >
                        <GripVertical size={15} aria-hidden="true" />
                      </button>
                      <button
                        className="row-select"
                        aria-label={`${rowNumber}행 전체 선택`}
                        title="행 선택 · 드래그하여 여러 행 선택 · ⌘/Ctrl로 영역 추가"
                        onPointerDown={(e) =>
                          startHeaderSelection(e, "rows", row.index)
                        }
                        onClick={(e) => {
                          if (e.detail === 0)
                            selectHeader(
                              "rows",
                              row.index,
                              e.shiftKey,
                              e.metaKey || e.ctrlKey,
                            );
                        }}
                      >
                        <span className="row-index">{rowNumber}</span>
                      </button>
                      <span
                        className="row-resizer"
                        title="행 높이 조절"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          dragOrigin.current = null;
                          const y = e.clientY;
                          const drag = (ev: PointerEvent) =>
                            onView({
                              rowHeights: {
                                ...view.rowHeights,
                                [task.id]: Math.min(
                                  500,
                                  Math.max(
                                    26,
                                    row.size -
                                      groupHeight(row.index) +
                                      ev.clientY -
                                      y,
                                  ),
                                ),
                              },
                            });
                          const stop = () => {
                            window.removeEventListener("pointermove", drag);
                            window.removeEventListener("pointerup", stop);
                          };
                          window.addEventListener("pointermove", drag);
                          window.addEventListener("pointerup", stop, {
                            once: true,
                          });
                        }}
                      />
                    </>
                  )}
                  {(["before", "after"] as const).map((side) => {
                    const gap = marker?.[side];
                    if (!gap || presentation) return null;
                    const label = `${gap.start === gap.end ? gap.start : `${gap.start}~${gap.end}`}행 숨김 해제`;
                    return (
                      <button
                        key={side}
                        className={`hidden-row-marker ${side}`}
                        aria-label={label}
                        title={`${label} (${gap.ids.length}개 행)`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => revealRows(gap.ids)}
                      >
                        <span className="hidden-row-arrow" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                {columns.map((c, ci) => {
                  const current = cell(task, c.key),
                    s = current.style;
                  const selected = ranges.some(
                    (r) =>
                      row.index >= r.r1 &&
                      row.index <= r.r2 &&
                      ci >= r.c1 &&
                      ci <= r.c2,
                  );
                  const focused =
                    selection?.focus.taskId === task.id &&
                    selection.focus.key === c.key;
                  const text = displayValue(task, c.key, users, settings);
                  const property = properties.find((p) => p.id === c.key);
                  const choice =
                    property?.kind === "option" || property?.kind === "member";
                  const editableChoice =
                    choice &&
                    !!text &&
                    !readOnly &&
                    canEdit(user, task) &&
                    (!["owner", "supporters"].includes(c.key) ||
                      ["admin", "manager"].includes(user.role));
                  const editing =
                    editor?.point.taskId === task.id &&
                    editor.point.key === c.key;
                  const mode = textMode(s);
                  let overflowWidth = c.width;
                  if (!choice && mode === "overflow" && text && !editing) {
                    for (let next = ci + 1; next < columns.length; next++) {
                      const neighbor = columns[next];
                      const v = value(task, neighbor.key);
                      const previousKey = columns[next - 1].key;
                      const right =
                        weekBorderStyle(
                          previousKey,
                          weekKeys,
                          settings.weekBorders,
                        ).borderRight ||
                        cell(task, previousKey).style.borderRight;
                      const left =
                        weekBorderStyle(
                          neighbor.key,
                          weekKeys,
                          settings.weekBorders,
                        ).borderLeft ||
                        cell(task, neighbor.key).style.borderLeft;
                      if (
                        !!neighbor.fixed !== !!c.fixed ||
                        (right && right.style !== "none") ||
                        (left && left.style !== "none") ||
                        (editor?.point.taskId === task.id &&
                          editor.point.key === neighbor.key) ||
                        (Array.isArray(v)
                          ? v.length > 0
                          : v !== "" && v != null)
                      )
                        break;
                      overflowWidth += neighbor.width;
                    }
                  }
                  const textDecoration = [
                    s.underline ? "underline" : "",
                    s.strike ? "line-through" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const textParts = textLinks(text);
                  const renderedText = (
                    <span className="cell-text">
                      {textParts.some((part) => part.href) ? (
                        <span className="cell-linked-text">
                          {textParts.map((part, index) =>
                            part.href ? (
                              <a
                                key={index}
                                href={part.href}
                                target="_blank"
                                rel="noreferrer"
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                {part.text}
                              </a>
                            ) : (
                              <span key={index} style={{ textDecoration }}>
                                {part.text}
                              </span>
                            ),
                          )}
                        </span>
                      ) : (
                        text
                      )}
                    </span>
                  );
                  const content =
                    property?.kind === "option" ? (
                      <PropertyBadge
                        property={property}
                        value={String(current.value)}
                      />
                    ) : property?.kind === "member" ? (
                      <MemberValue
                        property={property}
                        value={current.value}
                        users={users}
                      />
                    ) : (
                      renderedText
                    );
                  const style: CSSProperties = {
                    width: c.width,
                    ...bordersCSS({
                      ...s,
                      ...weekBorderStyle(c.key, weekKeys, settings.weekBorders),
                    }),
                    ...(c.fixed ? { left: positions[ci] } : {}),
                    color: s.color,
                    backgroundColor: s.backgroundColor,
                    fontFamily: fontFamilyCSS(s.fontFamily),
                    fontSize: s.fontSize ? `${s.fontSize}pt` : undefined,
                    fontWeight:
                      s.bold === undefined ? undefined : s.bold ? 700 : 400,
                    fontStyle: s.italic ? "italic" : undefined,
                    textDecoration,
                    textAlign: s.textAlign || "left",
                    // Keep the chosen alignment when content fits; overflowing
                    // content must start at its first line, even when centered.
                    alignItems:
                      s.verticalAlign === "top"
                        ? "flex-start"
                        : s.verticalAlign === "bottom"
                          ? "safe flex-end"
                          : "safe center",
                    justifyContent:
                      s.textAlign === "center"
                        ? "safe center"
                        : s.textAlign === "right"
                          ? "safe flex-end"
                          : "flex-start",
                    whiteSpace: mode === "wrap" ? "pre-wrap" : "nowrap",
                  };
                  return (
                    <div
                      key={c.key}
                      role="gridcell"
                      aria-selected={!!selected}
                      data-cell={`${task.id}:${c.key}`}
                      data-task-id={task.id}
                      data-column={c.key}
                      data-text-mode={mode}
                      className={`sheet-cell ${c.fixed ? "fixed" : ""} ${selected ? "selected" : ""} ${focused ? "focused" : ""} ${c.key === "title" ? "task-title" : ""} ${c.month ? "week-cell" : ""} ${editing ? "editing" : ""} ${!choice && mode === "overflow" && text && !editing ? "text-overflow-cell" : ""}`}
                      style={style}
                      title={text}
                      onPointerDown={(e) => {
                        if (e.button === 0) {
                          dragOrigin.current = { x: e.clientX, y: e.clientY };
                          e.preventDefault();
                          pick(
                            { taskId: task.id, key: c.key },
                            e.shiftKey,
                            e.metaKey || e.ctrlKey,
                          );
                        }
                      }}
                      onPointerMove={(e) => {
                        const start = dragOrigin.current;
                        if (
                          e.buttons === 1 &&
                          selection &&
                          start &&
                          Math.hypot(e.clientX - start.x, e.clientY - start.y) >
                            3
                        )
                          onSelect({
                            ...selection,
                            focus: { taskId: task.id, key: c.key },
                          });
                      }}
                      onDoubleClick={() =>
                        !readOnly &&
                        canEdit(user, task) &&
                        onEdit({ taskId: task.id, key: c.key })
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        // macOS emits a context menu for Ctrl+click as well.
                        if (e.ctrlKey) return;
                        if (!presentation) onRowMenu(task);
                      }}
                    >
                      {editing && editor ? (
                        <InlineCellEditor
                          key={`${task.id}:${c.key}`}
                          editor={editor}
                          task={task}
                          users={users}
                          settings={settings}
                          onCommit={finish}
                          onCancel={() => {
                            onCancelEdit();
                            ref.current?.focus();
                          }}
                        />
                      ) : editableChoice ? (
                        <button
                          className="cell-choice-trigger"
                          aria-label={`${c.label} 선택`}
                          aria-haspopup="listbox"
                          aria-expanded="false"
                          onPointerDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={() =>
                            onEdit({ taskId: task.id, key: c.key })
                          }
                        >
                          {content}
                        </button>
                      ) : !choice && mode === "overflow" && text ? (
                        <div
                          className="cell-overflow-clip"
                          style={{ width: overflowWidth }}
                        >
                          <div
                            className="cell-overflow-content"
                            style={{ width: c.width }}
                          >
                            {content}
                          </div>
                        </div>
                      ) : (
                        content
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!tasks.length && (
          <Empty
            title="표시할 업무가 없습니다"
            description="필터와 숨김 설정을 확인하거나 첫 업무를 등록하세요."
            action={
              !readOnly && user.role !== "viewer" ? (
                <Button className="primary" onClick={onAdd}>
                  <Plus size={16} />
                  업무 추가
                </Button>
              ) : undefined
            }
          />
        )}
        {!tasks.length && allTasks.length > 0 && !presentation && (
          <Button
            className="reveal-all-rows"
            onClick={() => revealRows(allTasks.map((t) => t.id))}
          >
            숨긴 {allTasks.length}개 행 펼치기
          </Button>
        )}
        {!!tasks.length && !readOnly && user.role !== "viewer" && (
          <Button className="primary add-row" onClick={onAdd}>
            <Plus size={17} />
            업무 추가
          </Button>
        )}
      </div>
      {headerMenu && (
        <GridHeaderMenu
          key={`${headerMenu.kind}:${headerMenu.index}`}
          x={headerMenu.x}
          y={headerMenu.y}
          title={
            headerMenu.kind === "columns"
              ? `${menuColumn?.label || "선택"} 열 메뉴`
              : "선택한 행 메뉴"
          }
          actions={menuActions}
          scrollContainer={ref.current}
          onClose={(restore) => {
            setHeaderMenu(null);
            if (restore) ref.current?.focus({ preventScroll: true });
          }}
        >
          {menuProperty && (
            <PropertyFilter
              key={menuProperty.id}
              property={menuProperty}
              tasks={sourceTasks}
              users={selectableUsers}
              selected={propertyFilters[menuProperty.id] || []}
              mode={view.propertyFilterModes?.[menuProperty.id] || "include"}
              onChange={(values) =>
                onView({
                  propertyFilters: {
                    ...propertyFilters,
                    [menuProperty.id]: values,
                  },
                  status: "",
                  category: "",
                })
              }
              onModeChange={(mode) =>
                onView({
                  propertyFilterModes: {
                    ...view.propertyFilterModes,
                    [menuProperty.id]: mode,
                  },
                })
              }
            />
          )}
        </GridHeaderMenu>
      )}
      {rowDrag &&
        createPortal(
          <div
            ref={rowDragPreview}
            className={`row-drag-preview ${rowDrag.valid ? "" : "invalid"}`}
            role="status"
          >
            <GripVertical size={18} aria-hidden="true" />
            <div>
              <strong>
                {rowDrag.taskIds.length > 1
                  ? `${rowDrag.taskIds.length}개 행 · `
                  : ""}
                {String(
                  tasks.find((t) => t.id === rowDrag.taskId)?.cells.title
                    ?.value || "제목 없는 업무",
                )}
              </strong>
              <span>
                {!rowDrag.valid
                  ? "같은 묶음 안에서만 이동할 수 있습니다"
                  : rowDrag.targetId
                    ? "표시된 선에 놓아 순서 이동"
                    : "이동할 위치로 드래그하세요"}{" "}
                · Esc 취소
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
