import {
  Fragment,
  memo,
  useCallback,
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
  Pin,
  PinOff,
  RotateCcw,
  Filter,
  ListTree,
  List,
  Copy,
  ClipboardPaste,
  Trash2,
} from "lucide-react";
import type {
  Task,
  User,
  View,
  Selection,
  Point,
  Settings,
  Cell,
  Style,
  Property,
  SelectionArea,
} from "./types";
import {
  canEdit,
  cell,
  displayValue,
  displayValueFor,
  value,
  textLinks,
  todayKey,
  propertiesFor,
  groupValue,
  textMode,
  fontFamilyCSS,
} from "../shared/domain.js";
import { Button, Empty } from "./components";
import InlineCellEditor, {
  type EditorState,
  type EditMove,
} from "./InlineCellEditor";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import GridHeaderMenu, { type HeaderMenuAction } from "./GridHeaderMenu";
import PropertyFilter from "./PropertyFilter";
import { gridBordersCSS } from "../shared/borders.js";
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
export type RowCommand =
  "insertBefore" | "insertAfter" | "copy" | "paste" | "delete";
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
  matchingTasks,
  allTasks,
  columns: baseColumns,
  columnOrder,
  view,
  user,
  users,
  assignableUsers,
  canAdd,
  canEditPeople,
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
  onRowCommand,
  canPasteRow,
  rowActionsDisabled,
  onReorder,
  onView,
  onAdd,
  onError,
  readOnly = false,
  presentation = false,
  jump,
}: {
  tasks: Task[];
  // tasks: 화면에 보이는 행, matchingTasks: 필터 통과(숨긴 행 포함), allTasks: 전체.
  matchingTasks: Task[];
  allTasks: Task[];
  columns: Column[];
  columnOrder: ColumnReference[];
  view: View;
  user: User;
  users: User[];
  assignableUsers: User[];
  canAdd: boolean;
  canEditPeople: boolean;
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
  onRowCommand: (command: RowCommand, task: Task) => void;
  canPasteRow: boolean;
  rowActionsDisabled: boolean;
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
  jump: { key: string | null; taskId?: string; id: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const appliedJump = useRef<number | null>(null);
  // 크기 조절 드래그 중에는 표만 미리 바꾸고, 놓을 때 한 번 보기 설정에 저장한다.
  const [columnResize, setColumnResize] = useState<{
    key: string;
    width: number;
  } | null>(null);
  const [rowResize, setRowResize] = useState<{
    taskId: string;
    height: number;
  } | null>(null);
  const columns = useMemo(
    () =>
      columnResize
        ? baseColumns.map((c) =>
            c.key === columnResize.key
              ? { ...c, width: columnResize.width }
              : c,
          )
        : baseColumns,
    [baseColumns, columnResize],
  );
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
    taskId?: string;
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
    30 + String(matchingTasks.length).length * 6,
  );
  const { positions, totalWidth } = useMemo(() => {
    let left = rowHeaderWidth;
    const positions = columns.map((c) => {
      const p = left;
      left += c.width;
      return p;
    });
    return { positions, totalWidth: left };
  }, [columns, rowHeaderWidth]);
  function revealColumns(hidden: ColumnReference[]) {
    const keys = new Set(hidden.map((c) => c.key));
    const visible = new Set(columns.map((c) => c.key));
    onView({
      visibleFields: [
        ...new Set([
          ...view.visibleFields,
          ...hidden.filter((c) => !c.month).map((c) => c.key),
        ]),
      ],
      // 기간 밖·접힌 월도 같은 숨김 구간이다. 이 구간만 펼치고 나머지는
      // 숨긴 주차로 남겨 비연속적인 표시 상태도 보존한다.
      ...(hidden.some((c) => c.month)
        ? {
            fromMonth: 1,
            toMonth: 12,
            fromWeek: "",
            toWeek: "",
            collapsedMonths: [],
            hiddenWeeks: columnOrder
              .filter((c) => c.month && !visible.has(c.key) && !keys.has(c.key))
              .map((c) => c.key),
          }
        : {}),
    });
    ref.current?.focus({ preventScroll: true });
  }
  function columnMarker(hidden: ColumnReference[] | undefined, index: number) {
    if (presentation || !hidden?.length) return null;
    const next = columns[index];
    const fixed = next?.fixed || columns[index - 1]?.fixed;
    const left = next ? positions[index] : totalWidth;
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
  const range = useMemo(
    () => rangeOf(selection, tasks, columns),
    [selection, tasks, columns],
  );
  const ranges = useMemo(
    () => rangesOf(selection, tasks, columns),
    [selection, tasks, columns],
  );
  const rowMarkers = useMemo(() => {
    const map = new Map<
      string,
      { number: number; before?: RowGap; after?: RowGap }
    >();
    const hidden = new Set(view.hiddenRows);
    let previous: string | undefined;
    let gap: RowGap | undefined;
    matchingTasks.forEach((task, index) => {
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
  }, [matchingTasks, view.hiddenRows]);
  function revealRows(ids: string[]) {
    const reveal = new Set(ids);
    onView({ hiddenRows: view.hiddenRows.filter((id) => !reveal.has(id)) });
  }
  const properties = useMemo(
    () => propertiesFor(settings) as Property[],
    [settings],
  );
  const propertyFilters = view.propertyFilters || {};
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
  const groupHeights = useMemo(
    () =>
      tasks.map((t, i) =>
        !!group &&
        (i === 0 ||
          groupValue(t, groupKey) !== groupValue(tasks[i - 1], groupKey))
          ? 28
          : 0,
      ),
    [tasks, group, groupKey],
  );
  const groupHeight = (i: number) => groupHeights[i] || 0;
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (group)
      for (const t of tasks) {
        const key = groupValue(t, groupKey);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    return counts;
  }, [tasks, group, groupKey]);
  // 셀 글자 크기에 맞춘 행 높이. 렌더·스크롤마다 전체 업무를 다시 계산하지 않도록
  // 업무 목록이나 높이 설정이 바뀔 때만 구한다.
  const density = settings.defaultDensity || "compact";
  const contentHeights = useMemo(
    () =>
      tasks.map((task) => {
        const fitted = Math.max(
          density === "comfortable" ? 48 : 38,
          ...Object.values(task.cells).map((c) =>
            Math.ceil(
              (c.style.fontSize || task.defaultStyle?.fontSize || 9) *
                (4 / 3) *
                1.55 +
                16,
            ),
          ),
        );
        return (
          view.rowHeights[task.id] ||
          (density === "dense"
            ? Math.max(26, Math.round((fitted * 2) / 3))
            : fitted)
        );
      }),
    [tasks, density, view.rowHeights],
  );
  const estimateSize = useCallback(
    (i: number) =>
      groupHeights[i] +
      (rowResize?.taskId === tasks[i].id
        ? rowResize.height
        : contentHeights[i]),
    [tasks, groupHeights, contentHeights, rowResize],
  );
  // 함수가 렌더마다 바뀌면 가상 스크롤이 모든 행의 위치를 다시 계산한다.
  const getItemKey = useCallback((i: number) => tasks[i].id, [tasks]);
  const taskIndexes = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index])),
    [tasks],
  );
  const editingIndex = useMemo(
    () => (editor ? tasks.findIndex((t) => t.id === editor.point.taskId) : -1),
    [tasks, editor?.point.taskId],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = defaultRangeExtractor(range);
      return editingIndex >= 0
        ? [...new Set([...indices, editingIndex])].sort((a, b) => a - b)
        : indices;
    },
    [editingIndex],
  );
  const virtual = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => ref.current,
    estimateSize,
    overscan: 12,
    getItemKey,
    scrollMargin: 32,
    rangeExtractor,
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [estimateSize]);
  useLayoutEffect(() => {
    if (jump && ref.current && appliedJump.current !== jump.id) {
      if (jump.key === null) {
        ref.current.scrollLeft = 0;
        appliedJump.current = jump.id;
        return;
      }
      const index = columns.findIndex((c) => c.key === jump.key);
      if (index >= 0) {
        if (jump.taskId) {
          const row = taskIndexes.get(jump.taskId);
          if (row === undefined) return;
          virtual.scrollToIndex(row, { align: "center" });
        }
        const pinned =
          rowHeaderWidth +
          columns.filter((c) => c.fixed).reduce((s, c) => s + c.width, 0);
        if (!columns[index].fixed)
          ref.current.scrollLeft = Math.max(0, positions[index] - pinned - 16);
        appliedJump.current = jump.id;
      }
    }
  }, [jump, columns, taskIndexes]);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!editor || !grid) return;
    const ri = tasks.findIndex((t) => t.id === editor.point.taskId);
    if (ri >= 0) virtual.scrollToIndex(ri, { align: "auto" });
    const ci = columns.findIndex((c) => c.key === editor.point.key);
    if (ci < 0 || columns[ci].fixed) return;
    const pinned =
      rowHeaderWidth +
      columns.filter((c) => c.fixed).reduce((sum, c) => sum + c.width, 0);
    const left = positions[ci];
    const right = left + columns[ci].width;
    // 이미 보이는 편집 셀은 가로 위치를 유지한다. 고정 열에 가리거나
    // 화면 밖에 있을 때만 그리드 안에서 필요한 만큼 이동한다.
    if (left < grid.scrollLeft + pinned)
      grid.scrollLeft = Math.max(0, left - pinned);
    else if (right > grid.scrollLeft + grid.clientWidth)
      grid.scrollLeft = Math.max(
        0,
        Math.min(left - pinned, right - grid.clientWidth),
      );
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
    setHeaderMenu({
      kind,
      index,
      x,
      y,
      taskId: kind === "rows" ? tasks[index]?.id : undefined,
    });
  }
  const menuColumn =
    headerMenu?.kind === "columns" ? columns[headerMenu.index] : undefined;
  const menuColumns = menuColumn
    ? range
      ? columns.filter((_, i) => ranges.some((r) => i >= r.c1 && i <= r.c2))
      : [menuColumn]
    : [];
  const menuProperty = properties.find((p) => p.id === menuColumn?.key);
  const menuTask =
    headerMenu?.kind === "rows"
      ? tasks.find((task) => task.id === headerMenu.taskId)
      : undefined;
  const selectedRowCount = menuTask
    ? tasks.filter((_, i) => ranges.some((r) => i >= r.r1 && i <= r.r2)).length
    : 0;
  const rowActionDisabled =
    !menuTask || selectedRowCount !== 1 || readOnly || rowActionsDisabled;
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
            label: "여기까지 열 고정",
            icon: <Pin size={15} />,
            disabled:
              !menuColumn ||
              !!menuColumn.month ||
              menuProperty?.placement === "afterWeeks",
            run: () => onView({ frozenColumns: headerMenu.index + 1 }),
          },
          {
            label: "열 고정 해제",
            icon: <PinOff size={15} />,
            disabled: !view.frozenColumns,
            run: () => onView({ frozenColumns: 0 }),
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
          {
            label: "이 열로 묶음 보기",
            icon: <ListTree size={15} />,
            disabled: !menuProperty || view.groupBy === menuProperty.id,
            run: () => onView({ groupBy: menuProperty!.id }),
          },
          {
            label: "묶음 해제",
            icon: <List size={15} />,
            disabled: !view.groupBy,
            run: () => onView({ groupBy: "" }),
          },
        ]
      : [
          {
            label: "위에 삽입",
            icon: <ArrowUp size={15} />,
            disabled: rowActionDisabled || !canAdd,
            run: () => menuTask && onRowCommand("insertBefore", menuTask),
          },
          {
            label: "아래에 삽입",
            icon: <ArrowDown size={15} />,
            disabled: rowActionDisabled || !canAdd,
            run: () => menuTask && onRowCommand("insertAfter", menuTask),
          },
          {
            label: "복사",
            icon: <Copy size={15} />,
            disabled: rowActionDisabled,
            run: () => menuTask && onRowCommand("copy", menuTask),
          },
          {
            label: "복사한 행 붙여넣기",
            icon: <ClipboardPaste size={15} />,
            disabled: rowActionDisabled || !canAdd || !canPasteRow,
            run: () => menuTask && onRowCommand("paste", menuTask),
          },
          {
            label: "행 삭제",
            icon: <Trash2 size={15} />,
            danger: true,
            disabled:
              rowActionDisabled || !menuTask || !canEdit(user, menuTask),
            run: () => menuTask && onRowCommand("delete", menuTask),
          },
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
              if (menuTask) onRowMenu(menuTask);
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
        kind: "all",
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
  function startColumnResize(e: React.PointerEvent, column: Column) {
    e.preventDefault();
    e.stopPropagation();
    dragOrigin.current = null;
    const origin = e.clientX,
      start = column.width,
      min = column.month ? 40 : 45;
    let width = start;
    const handle = (ev: PointerEvent) => {
      width = Math.min(850, Math.max(min, start + ev.clientX - origin));
      setColumnResize({ key: column.key, width });
    };
    const stop = () => {
      window.removeEventListener("pointermove", handle);
      window.removeEventListener("pointerup", stop);
      setColumnResize(null);
      if (width !== start)
        onView({ widths: { ...view.widths, [column.key]: width } });
    };
    window.addEventListener("pointermove", handle);
    window.addEventListener("pointerup", stop, { once: true });
  }
  // 경계선 양쪽에 걸친 손잡이. 뒤 머리글이 앞 머리글 위에 그려지므로
  // 손잡이는 경계 오른쪽 머리글의 왼쪽 끝에 둔다. 고정 열과 일반 열의
  // 경계나 마지막 열처럼 오른쪽 머리글이 위에 오지 않으면 자기 오른쪽 끝에 둔다.
  function columnResizer(column: Column, side: "start" | "end") {
    return (
      <span
        className={`column-resizer ${side}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`${column.label} 너비 조절`}
        data-resize-key={column.key}
        onPointerDown={(e) => startColumnResize(e, column)}
      />
    );
  }
  function startRowResize(e: React.PointerEvent, index: number) {
    const task = tasks[index];
    e.preventDefault();
    e.stopPropagation();
    dragOrigin.current = null;
    const y = e.clientY,
      start = contentHeights[index];
    let height = start;
    const drag = (ev: PointerEvent) => {
      height = Math.min(500, Math.max(26, start + ev.clientY - y));
      setRowResize({ taskId: task.id, height });
    };
    const stop = () => {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", stop);
      setRowResize(null);
      if (height !== start)
        onView({ rowHeights: { ...view.rowHeights, [task.id]: height } });
    };
    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", stop, { once: true });
  }
  function keyboardMoveRow(e: KeyboardEvent, task: Task) {
    if (!e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = rowsToMove(task);
    if (!canMoveRows(moving)) return;
    const movingIds = new Set(moving.map((t) => t.id));
    const same = tasks.filter(
      (t) =>
        !groupKey || groupValue(t, groupKey) === groupValue(task, groupKey),
    );
    const direction = e.key === "ArrowUp" ? -1 : 1;
    const index =
      direction < 0
        ? same.findIndex((t) => movingIds.has(t.id))
        : same.findLastIndex((t) => movingIds.has(t.id));
    const neighbor = same[index + direction];
    if (neighbor)
      moveRows(moving, neighbor.id, direction < 0 ? "before" : "after");
  }
  // 행은 메모된 컴포넌트라 이벤트 처리기를 항상 같은 객체로 넘기고,
  // 실제 동작은 마지막 렌더의 함수를 호출한다.
  const handlers: GridActions = {
    cellPointerDown(e, point) {
      if (e.button !== 0) return;
      dragOrigin.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      pick(point, e.shiftKey, e.metaKey || e.ctrlKey);
    },
    dragSelect(e, point) {
      const start = dragOrigin.current;
      if (
        e.buttons !== 1 ||
        !selection ||
        !start ||
        Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 3 ||
        (selection.focus.taskId === point.taskId &&
          selection.focus.key === point.key)
      )
        return;
      onSelect({ ...selection, focus: point });
    },
    edit: (point) => onEdit(point),
    rowMenu: (task) => onRowMenu(task),
    finish,
    cancelEdit() {
      onCancelEdit();
      ref.current?.focus();
    },
    startRowDrag,
    keyboardMoveRow,
    startHeaderSelection,
    selectHeader,
    openHeaderMenu,
    showHeaderMenu,
    startRowResize,
    revealRows,
  };
  const live = useRef(handlers);
  live.current = handlers;
  const [actions] = useState(
    () =>
      new Proxy({} as GridActions, {
        get:
          (_, key) =>
          (...args: unknown[]) =>
            (
              live.current[key as keyof GridActions] as (
                ...a: unknown[]
              ) => unknown
            )(...args),
      }),
  );
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
        aria-rowcount={matchingTasks.length + 1}
        aria-colcount={columns.length + 1}
        aria-readonly={readOnly}
        className="sheet-scroll"
        data-density={density}
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
        <div
          className="sheet-header"
          role="row"
          style={
            {
              width: totalWidth,
              "--week-header-bg": settings.weekHeader?.backgroundColor,
              "--week-header-color": settings.weekHeader?.color,
            } as CSSProperties
          }
        >
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
                    kind: "all",
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
                }}
              >
                {view.groupBy === c.key && (
                  <span
                    className="column-group-indicator"
                    role="img"
                    aria-label={`${c.label} 묶음 보기 적용`}
                    title="묶음 기준 열"
                  >
                    <ListTree size={13} aria-hidden="true" />
                  </span>
                )}
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
                {!presentation &&
                  ci > 0 &&
                  !!columns[ci - 1].fixed === !!c.fixed &&
                  columnResizer(columns[ci - 1], "start")}
                {!presentation &&
                  (ci === columns.length - 1 ||
                    !!columns[ci + 1].fixed !== !!c.fixed) &&
                  columnResizer(c, "end")}
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
            const rowGroupHeight = groupHeight(row.index);
            // 행마다 바뀐 선택만 문자열로 넘겨 선택과 무관한 행은 다시 그리지 않는다.
            // 영역의 첫·마지막 행인지도 함께 넘겨 영역 외곽선을 그린다.
            let spans = "",
              rowSelected = false;
            for (const r of ranges)
              if (row.index >= r.r1 && row.index <= r.r2) {
                spans += `${r.c1}-${r.c2}-${+(row.index === r.r1)}-${+(row.index === r.r2)},`;
                if (r.kind === "rows") rowSelected = true;
              }
            return (
              <div
                key={task.id}
                role="row"
                aria-rowindex={rowNumber + 1}
                data-row-id={task.id}
                className={`sheet-row ${draggedIds.has(task.id) ? "row-dragging" : ""} ${rowDrag?.targetId === task.id ? (rowDrag.valid ? `row-drop-${rowDrag.placement}` : "row-drop-invalid") : ""}`}
                style={
                  {
                    "--row-group-height": `${rowGroupHeight}px`,
                    height: row.size,
                    paddingTop: rowGroupHeight,
                    width: totalWidth,
                    transform: `translateY(${row.start - virtual.options.scrollMargin}px)`,
                  } as CSSProperties
                }
              >
                <RowBody
                  task={task}
                  nextTask={
                    groupHeight(row.index + 1)
                      ? undefined
                      : tasks[row.index + 1]
                  }
                  previousTask={
                    rowGroupHeight ? undefined : tasks[row.index - 1]
                  }
                  index={row.index}
                  rowNumber={rowNumber}
                  marker={marker}
                  groupHeight={rowGroupHeight}
                  group={group}
                  groupCount={
                    rowGroupHeight
                      ? groupCounts.get(groupValue(task, groupKey))
                      : undefined
                  }
                  columns={columns}
                  positions={positions}
                  properties={properties}
                  users={users}
                  settings={settings}
                  user={user}
                  canEditPeople={canEditPeople}
                  readOnly={readOnly}
                  presentation={presentation}
                  sorted={sorted}
                  spans={spans}
                  rowSelected={rowSelected}
                  focusKey={
                    selection?.focus.taskId === task.id
                      ? selection.focus.key
                      : null
                  }
                  editor={editor?.point.taskId === task.id ? editor : null}
                  editorActive={!!editor}
                  resizeEnd={
                    row.index === tasks.length - 1
                      ? "edge"
                      : groupHeight(row.index + 1)
                        ? "inside"
                        : ""
                  }
                  actions={actions}
                />
              </div>
            );
          })}
        </div>
        {!tasks.length && (
          <Empty
            title="표시할 업무가 없습니다"
            description="필터와 숨김 설정을 확인하거나 첫 업무를 등록하세요."
            action={
              !readOnly && canAdd ? (
                <Button className="primary" onClick={onAdd}>
                  <Plus size={16} />
                  업무 추가
                </Button>
              ) : undefined
            }
          />
        )}
        {!tasks.length && matchingTasks.length > 0 && !presentation && (
          <Button
            className="reveal-all-rows"
            onClick={() => revealRows(matchingTasks.map((t) => t.id))}
          >
            숨긴 {matchingTasks.length}개 행 펼치기
          </Button>
        )}
        {!!tasks.length && !readOnly && canAdd && (
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
              tasks={allTasks}
              users={assignableUsers}
              selected={propertyFilters[menuProperty.id] || []}
              mode={view.propertyFilterModes?.[menuProperty.id] || "include"}
              onChange={(values) =>
                onView({
                  propertyFilters: {
                    ...propertyFilters,
                    [menuProperty.id]: values,
                  },
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
type GridActions = {
  cellPointerDown(e: React.PointerEvent, point: Point): void;
  dragSelect(e: React.PointerEvent, point: Point): void;
  edit(point: Point): void;
  rowMenu(task: Task): void;
  finish(value: Cell["value"], move?: EditMove): boolean | undefined;
  cancelEdit(): void;
  startRowDrag(e: React.PointerEvent, task: Task): void;
  keyboardMoveRow(e: KeyboardEvent, task: Task): void;
  startHeaderSelection(
    e: React.PointerEvent,
    kind: "columns" | "rows",
    index: number,
  ): void;
  selectHeader(
    kind: "columns" | "rows",
    index: number,
    extend?: boolean,
    add?: boolean,
  ): number;
  openHeaderMenu(
    e: React.MouseEvent,
    kind: "columns" | "rows",
    index: number,
  ): void;
  showHeaderMenu(
    kind: "columns" | "rows",
    index: number,
    x: number,
    y: number,
  ): void;
  startRowResize(e: React.PointerEvent, index: number): void;
  revealRows(ids: string[]): void;
};
type RowGap = { ids: string[]; start: number; end: number };

// 한 행의 머리글과 셀. 스크롤·다른 행 선택처럼 이 행과 무관한 변경에서는 다시 그리지 않는다.
const RowBody = memo(function RowBody({
  task,
  nextTask,
  previousTask,
  index,
  rowNumber,
  marker,
  groupHeight,
  group,
  groupCount,
  columns,
  positions,
  properties,
  users,
  settings,
  user,
  canEditPeople,
  readOnly,
  presentation,
  sorted,
  spans,
  rowSelected,
  focusKey,
  editor,
  editorActive,
  resizeEnd,
  actions,
}: {
  task: Task;
  nextTask: Task | undefined;
  previousTask: Task | undefined;
  index: number;
  rowNumber: number;
  marker: { number: number; before?: RowGap; after?: RowGap } | undefined;
  groupHeight: number;
  group: Property | undefined;
  groupCount: number | undefined;
  columns: Column[];
  positions: number[];
  properties: Property[];
  users: User[];
  settings: Settings;
  user: User;
  canEditPeople: boolean;
  readOnly: boolean;
  presentation: boolean;
  sorted: boolean;
  spans: string;
  rowSelected: boolean;
  focusKey: string | null;
  editor: EditorState | null;
  editorActive: boolean;
  // 이 행 아래쪽 끝에 높이 손잡이를 둘지. 마지막 행은 경계에 걸치고,
  // 묶음 제목 바로 위 행은 제목에 가려지지 않게 행 안쪽에 둔다.
  resizeEnd: "" | "edge" | "inside";
  actions: GridActions;
}) {
  const groupKey = group?.id || "";
  const selectedSpans = spans
    ? spans
        .slice(0, -1)
        .split(",")
        .map((span) => span.split("-").map(Number))
    : [];
  const editable = !readOnly && canEdit(user, task);
  return (
    <>
      {!!groupHeight && (
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
            <small>{groupCount}개 업무</small>
          </span>
        </div>
      )}
      <div
        className="row-number"
        role="rowheader"
        aria-selected={rowSelected}
        onContextMenu={(e) => actions.openHeaderMenu(e, "rows", index)}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            e.stopPropagation();
            const box = e.currentTarget.getBoundingClientRect();
            actions.showHeaderMenu("rows", index, box.right, box.top);
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
                readOnly || sorted || editorActive || !canEdit(user, task)
              }
              title={
                sorted
                  ? "컬럼 머리글 우클릭 → 정렬 해제 후 이동할 수 있습니다."
                  : "손잡이를 드래그하여 행 이동 · 여러 행 선택 시 함께 이동 · Alt+위/아래 방향키"
              }
              onPointerDown={(e) => actions.startRowDrag(e, task)}
              onKeyDown={(e) => actions.keyboardMoveRow(e, task)}
            >
              <GripVertical size={15} aria-hidden="true" />
            </button>
            <button
              className="row-select"
              aria-label={`${rowNumber}행 전체 선택`}
              title="행 선택 · 드래그하여 여러 행 선택 · ⌘/Ctrl로 영역 추가"
              onPointerDown={(e) =>
                actions.startHeaderSelection(e, "rows", index)
              }
              onClick={(e) => {
                if (e.detail === 0)
                  actions.selectHeader(
                    "rows",
                    index,
                    e.shiftKey,
                    e.metaKey || e.ctrlKey,
                  );
              }}
            >
              <span className="row-index">{rowNumber}</span>
            </button>
            {/* 아래 행이 위 행 위에 그려지므로 경계 손잡이는 아래 행의 위쪽 끝에
                둔다. 마지막 행과 묶음 제목 바로 위 행은 자기 아래쪽 끝에 둔다. */}
            {index > 0 && !groupHeight && (
              <span
                className="row-resizer start"
                title="행 높이 조절"
                data-resize-row={index - 1}
                onPointerDown={(e) => actions.startRowResize(e, index - 1)}
              />
            )}
            {resizeEnd && (
              <span
                className={`row-resizer end ${resizeEnd}`}
                title="행 높이 조절"
                data-resize-row={index}
                onPointerDown={(e) => actions.startRowResize(e, index)}
              />
            )}
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
              onClick={() => actions.revealRows(gap.ids)}
            >
              <span className="hidden-row-arrow" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {columns.map((c, ci) => {
        const property = properties.find((p) => p.id === c.key);
        const choice =
          property?.kind === "option" || property?.kind === "member";
        const editing = editor?.point.key === c.key;
        // 넘치는 글자가 오른쪽 빈 셀로 이어지는 너비. 이웃 셀을 봐야 하므로 행에서 구한다.
        let overflowWidth = c.width;
        const own = value(task, c.key);
        if (
          !choice &&
          !editing &&
          textMode(cell(task, c.key).style) === "overflow" &&
          (Array.isArray(own) ? own.length > 0 : own !== "" && own != null)
        ) {
          for (let next = ci + 1; next < columns.length; next++) {
            const neighbor = columns[next];
            const v = value(task, neighbor.key);
            const right = cell(task, columns[next - 1].key).style.borderRight;
            const left = cell(task, neighbor.key).style.borderLeft;
            if (
              !!neighbor.fixed !== !!c.fixed ||
              (right && right.style !== "none") ||
              (left && left.style !== "none") ||
              editor?.point.key === neighbor.key ||
              (Array.isArray(v) ? v.length > 0 : v !== "" && v != null)
            )
              break;
            overflowWidth += neighbor.width;
          }
        }
        return (
          <GridCell
            key={c.key}
            task={task}
            column={c}
            left={c.fixed ? positions[ci] : undefined}
            overflowWidth={overflowWidth}
            topBorder={
              previousTask
                ? cell(previousTask, c.key).style.borderBottom
                : undefined
            }
            leftBorder={
              columns[ci - 1]
                ? cell(task, columns[ci - 1].key).style.borderRight
                : undefined
            }
            rightBorder={
              columns[ci + 1]
                ? cell(task, columns[ci + 1].key).style.borderLeft
                : undefined
            }
            bottomBorder={
              nextTask ? cell(nextTask, c.key).style.borderTop : undefined
            }
            property={property}
            selection={selectionEdges(selectedSpans, ci)}
            focused={focusKey === c.key}
            editor={editing ? editor : null}
            editable={editable}
            canEditPeople={canEditPeople}
            users={users}
            settings={settings}
            presentation={presentation}
            actions={actions}
          />
        );
      })}
    </>
  );
});

function selectionEdges(spans: number[][], ci: number) {
  let hit = false,
    edges = "";
  for (const [c1, c2, top, bottom] of spans) {
    if (ci < c1 || ci > c2) continue;
    hit = true;
    if (top) edges += "t";
    if (ci === c2) edges += "r";
    if (bottom) edges += "b";
    if (ci === c1) edges += "l";
  }
  return hit ? edges : null;
}

// 셀 하나. 열 너비·선택이 바뀌어도 해당 셀만 다시 그린다.
const GridCell = memo(function GridCell({
  task,
  column: c,
  left,
  overflowWidth,
  topBorder,
  leftBorder,
  rightBorder,
  bottomBorder,
  property,
  selection,
  focused,
  editor,
  editable,
  canEditPeople,
  users,
  settings,
  presentation,
  actions,
}: {
  task: Task;
  column: Column;
  left: number | undefined;
  overflowWidth: number;
  topBorder: Style["borderBottom"];
  leftBorder: Style["borderRight"];
  rightBorder: Style["borderLeft"];
  bottomBorder: Style["borderTop"];
  property: Property | undefined;
  // 선택되지 않았으면 null, 선택됐으면 영역 외곽에 닿은 변(t·r·b·l).
  selection: string | null;
  focused: boolean;
  editor: EditorState | null;
  editable: boolean;
  canEditPeople: boolean;
  users: User[];
  settings: Settings;
  presentation: boolean;
  actions: GridActions;
}) {
  const current = cell(task, c.key),
    s = current.style;
  const text = displayValueFor(property, current.value, users);
  const choice = property?.kind === "option" || property?.kind === "member";
  const editableChoice =
    choice &&
    !!text &&
    editable &&
    (!["owner", "supporters"].includes(c.key) || canEditPeople);
  const editing = !!editor;
  const mode = textMode(s);
  const textDecoration = [
    s.underline ? "underline" : "",
    s.strike ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // 빈 셀은 안쪽 요소를 만들지 않는다 (일정 열 대부분이 빈 셀).
  const textParts = text ? textLinks(text) : [];
  const renderedText = text ? (
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
  ) : null;
  const content =
    property?.kind === "option" ? (
      <PropertyBadge property={property} value={String(current.value)} />
    ) : property?.kind === "member" ? (
      <MemberValue property={property} value={current.value} users={users} />
    ) : (
      renderedText
    );
  // 기본값(왼쪽·가운데 정렬, 한 줄 표시)은 .sheet-cell CSS에 두고
  // 셀마다 다른 값만 인라인으로 지정해 스타일 쓰기를 줄인다.
  const style: CSSProperties = {
    width: c.width,
    ...gridBordersCSS(s, {
      top: topBorder,
      left: leftBorder,
      right: rightBorder,
      bottom: bottomBorder,
    }),
  };
  if (left !== undefined) style.left = left;
  if (s.color) style.color = s.color;
  if (s.backgroundColor) style.backgroundColor = s.backgroundColor;
  const fontFamily = fontFamilyCSS(s.fontFamily);
  if (fontFamily) style.fontFamily = fontFamily;
  if (s.fontSize) style.fontSize = `${s.fontSize}pt`;
  if (s.bold !== undefined) style.fontWeight = s.bold ? 700 : 400;
  if (s.italic) style.fontStyle = "italic";
  if (textDecoration) style.textDecoration = textDecoration;
  if (s.textAlign && s.textAlign !== "left") {
    style.textAlign = s.textAlign;
    // Keep the chosen alignment when content fits; overflowing
    // content must start at its first line, even when centered.
    style.justifyContent =
      s.textAlign === "center" ? "safe center" : "safe flex-end";
  }
  if (s.verticalAlign === "top") style.alignItems = "flex-start";
  else if (s.verticalAlign === "bottom") style.alignItems = "safe flex-end";
  if (mode === "wrap") style.whiteSpace = "pre-wrap";
  const point = { taskId: task.id, key: c.key };
  return (
    <div
      role="gridcell"
      aria-selected={selection !== null}
      data-selection-edges={selection || undefined}
      data-cell={`${task.id}:${c.key}`}
      data-task-id={task.id}
      data-column={c.key}
      data-text-mode={mode}
      className={`sheet-cell ${c.fixed ? "fixed" : ""} ${selection !== null ? "selected" : ""} ${focused ? "focused" : ""} ${c.key === "title" ? "task-title" : ""} ${c.month ? "week-cell" : ""} ${editing ? "editing" : ""} ${!choice && mode === "overflow" && text && !editing ? "text-overflow-cell" : ""}`}
      style={style}
      title={text || undefined}
      onPointerDown={(e) => actions.cellPointerDown(e, point)}
      onPointerMove={(e) => actions.dragSelect(e, point)}
      onDoubleClick={() => editable && actions.edit(point)}
      onContextMenu={(e) => {
        e.preventDefault();
        // macOS emits a context menu for Ctrl+click as well.
        if (e.ctrlKey) return;
        if (!presentation) actions.rowMenu(task);
      }}
    >
      {editing && editor ? (
        <InlineCellEditor
          key={`${task.id}:${c.key}`}
          editor={editor}
          task={task}
          users={users}
          settings={settings}
          onCommit={actions.finish}
          onCancel={actions.cancelEdit}
        />
      ) : editableChoice ? (
        <button
          className="cell-choice-trigger"
          aria-label={`${c.label} 선택`}
          aria-haspopup="listbox"
          aria-expanded="false"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={() => actions.edit(point)}
        >
          {content}
        </button>
      ) : !choice && mode === "overflow" && text ? (
        <div className="cell-overflow-clip" style={{ width: overflowWidth }}>
          <div className="cell-overflow-content" style={{ width: c.width }}>
            {content}
          </div>
        </div>
      ) : (
        content
      )}
    </div>
  );
});
