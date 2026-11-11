import useGridSelection from "./useGridSelection";
import type { GridActions } from "./grid-types";
import useGridResize from "./useGridResize";
import useGridViewport, { GROUP_HEADING_HEIGHT } from "./useGridViewport";
import useGridRowDrag from "./useGridRowDrag";
import type { Column, ColumnReference, RowCommand } from "./grid-types";
import { rangeOf, rangesOf } from "./grid-selection";

import { useMobileLayout } from "../ui/useMobileLayout";
import SheetHorizontalScroll from "./SheetHorizontalScroll";
import useSheetPresence, { type PresenceStore } from "./useSheetPresence";
import { useTodayKey } from "./useTodayKey";
import { FileText } from "lucide-react";
import { explicitStyle } from "../../shared/formatting/formatting.js";
import {
  Fragment,
  memo,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { type VirtualItem } from "@tanstack/react-virtual";
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
} from "../types";
import {
  canEdit,
  cell,
  displayValue,
  displayValueFor,
  value,
  textLinks,
  mondayOf,
  propertiesFor,
  groupValue,
  textMode,
  fontFamilyCSS,
} from "../../shared/domain.js";
import { Button } from "../ui/Button";
import { inkFor } from "../ui/color";
import { Empty } from "../ui/Empty";
import InlineCellEditor, { type EditorState } from "./InlineCellEditor";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import GridHeaderMenu, { type HeaderMenuAction } from "../ui/GridHeaderMenu";
import PropertyFilter from "./PropertyFilter";
import {
  gridBordersCSS,
  bordersCSS,
  weekBoundaryStyles,
  withWeekBoundaries,
} from "../../shared/formatting/borders.js";
import {
  createClipboard,
  copyToEvent,
  readClipboard,
  type ClipboardMatrix,
} from "./clipboard";
import { copyLayout } from "./selection-areas.js";

const ROW_HEADER_WIDTH = 48;

export default function Grid({
  scopeKey,
  zoom = 1,
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
  addTaskLabel = "업무 추가",
  footer,
  canEditPeople,
  selection,
  presence: presenceStore = null,
  settings,
  editor,
  onCommit,
  onCancelEdit,
  onSelect: onSelectionChange,
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
  onCopied,
  copyEditable = false,
  readOnly = false,
  presentation = false,
  formatPainting = false,
  onPaintFormat,
  jump,
}: {
  scopeKey: string;
  zoom?: number;
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
  addTaskLabel?: string;
  footer?: ReactNode;
  canEditPeople: boolean;
  selection: Selection | null;
  // 같은 사내 서버의 다른 사람과 선택·편집 셀을 주고받는 팀 스트림. 외부·사본·발표는 null.
  presence?: PresenceStore | null;
  settings: Settings;
  editor: EditorState | null;
  onCommit: (point: Point, value: Cell["value"]) => boolean;
  onCancelEdit: () => void;
  onSelect: (s: Selection | null) => void;
  onEdit: (p: Point, initial?: string) => boolean;
  onPaste: (rows: ClipboardMatrix) => void;
  onClear: () => void;
  onRowMenu: (task: Task) => void;
  onRowCommand: (
    command: RowCommand,
    task: Task,
    selectedRows?: Task[],
  ) => void;
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
  // 복사 결과. 성공하면 빈 문자열, 거절하면 안내 문구다.
  onCopied?: (error: string) => void;
  copyEditable?: boolean;
  readOnly?: boolean;
  presentation?: boolean;
  formatPainting?: boolean;
  onPaintFormat?: (selection: Selection | null) => void;
  jump: {
    key: string | null;
    taskId?: string;
    id: number;
    preserveHorizontalScroll?: boolean;
    scrollTop?: number;
    // 이미 보이는 셀이면 화면을 움직이지 않는다.
    nearest?: boolean;
  } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useMobileLayout();

  // 크기 조절 드래그 중에는 표만 미리 바꾸고, 놓을 때 한 번 보기 설정에 저장한다.

  const resize = useGridResize({
    scopeKey,
    zoom,
    view,
    onView,
    onStart: () => selectionControls.clearPointerOrigin(),
  });
  const { columnResize, rowResize, startColumnResize } = resize;
  const columns = useMemo(() => {
    const resized = columnResize
      ? baseColumns.map((column) =>
          column.key === columnResize.key
            ? { ...column, width: columnResize.width }
            : column,
        )
      : baseColumns;
    // A pinned title can cover the entire phone screen. Preserve the saved
    // layout, but let all data columns scroll in the compact view.
    return mobile
      ? resized.map((column) =>
          column.fixed ? { ...column, fixed: false } : column,
        )
      : resized;
  }, [baseColumns, columnResize, mobile]);

  const today = useTodayKey();
  const currentWeek = mondayOf(today);
  // Width previews change only the resized column, not the cell border layout.
  const columnKeys = useMemo(
    () => baseColumns.map((column) => column.key),
    [baseColumns],
  );
  const boundaryStyles = useMemo(
    () =>
      weekBoundaryStyles(
        columnKeys,
        settings.weekBorders,
        settings.currentWeekBorders,
        currentWeek,
      ),
    [
      columnKeys,
      settings.weekBorders,
      settings.currentWeekBorders,
      currentWeek,
    ],
  );
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
  // 다른 사람의 이동은 Grid만 다시 그리게 이 안에서 받는다.
  const presence = useSheetPresence(
    presenceStore,
    editor?.point || selection?.focus || null,
    !!editor,
  );
  const presenceRows = useMemo(() => {
    const rows = new Map<string, Map<string, CellPresence>>(),
      seen = new Set<string>();
    for (const p of presence) {
      const row = rows.get(p.taskId) || new Map<string, CellPresence>();
      rows.set(p.taskId, row);
      const current = row.get(p.key);
      // 한 사람이 여러 탭에서 같은 셀에 있어도 이름은 한 번만 표시하고,
      // 어느 탭이든 편집 중이면 편집 중으로 표시한다.
      const named = seen.has(`${p.taskId}:${p.key}:${p.userId}`);
      seen.add(`${p.taskId}:${p.key}:${p.userId}`);
      row.set(
        p.key,
        current
          ? {
              ...current,
              label: named ? current.label : `${current.label}, ${p.name}`,
              editing: current.editing || p.editing,
            }
          : { color: p.color, label: p.name, editing: p.editing },
      );
    }
    return new Map(
      [...rows].map(([taskId, row]) => [taskId, JSON.stringify([...row])]),
    );
  }, [presence]);
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

  const {
    groupHeight,
    groupCounts,
    groupStarts,
    density,
    contentHeights,
    taskIndexes,
    virtual,
    scrollToRow,
  } = useGridViewport({
    ref,
    tasks,
    columns,
    settings,
    view,
    group,
    groupKey,
    editor,
    selection,
    rowResize,
    footer,
    jump,
    rowHeaderWidth,
    positions,
  });
  const selectionControls = useGridSelection({
    scopeKey,
    ref,
    tasks,
    columns,
    taskIndexes,
    selection,
    ranges,
    editor,
    zoom,
    rowHeaderWidth,
    readOnly,
    presentation,
    formatPainting,
    onSelectionChange,
    onPaintFormat,
    onEdit,
    onCommit,
    onCancelEdit,
    onClear,
    scrollToRow,
  });
  const { onSelect, headerMenu, touchInput } = selectionControls;
  const { startHeaderSelection, openHeaderMenu, showHeaderMenu, selectHeader } =
    selectionControls.handlers;
  const { rowDrag, draggedIds, rowDragPreview, startRowDrag, keyboardMoveRow } =
    useGridRowDrag({
      scopeKey,
      ref,
      tasks,
      columns,
      selection,
      groupKey,
      sorted,
      readOnly,
      editor,
      copyEditable,
      user,
      onSelect,
      onReorder,
      onError,
      onStart: () => selectionControls.cancelPointerSelection(),
    });
  function startRowResize(e: React.PointerEvent, index: number) {
    resize.startRowResize(e, tasks[index], contentHeights[index]);
  }

  function sortColumn(key: string, direction: "asc" | "desc" | "default") {
    onView({
      sortKey: direction === "default" ? "" : key,
      sortDirection: direction,
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
  const selectedRows = menuTask
    ? tasks.filter((_, i) => ranges.some((r) => i >= r.r1 && i <= r.r2))
    : [];
  const rowActionDisabled =
    !menuTask || selectedRows.length !== 1 || readOnly || rowActionsDisabled;
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
              readOnly ||
              rowActionsDisabled ||
              !selectedRows.length ||
              !selectedRows.every(
                (task) => copyEditable || canEdit(user, task),
              ),
            run: () =>
              menuTask && onRowCommand("delete", menuTask, selectedRows),
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

  // Excel처럼 ⌘/Ctrl로 이미 선택한 셀·행·열을 누르거나 끌면 그 범위를 선택에서
  // 뺀다. 걸친 영역은 남은 사각형으로 나누고, 마지막 영역을 활성 영역으로 둔다.

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

  // 행은 메모된 컴포넌트라 이벤트 처리기를 항상 같은 객체로 넘기고,
  // 실제 동작은 마지막 렌더의 함수를 호출한다.
  const handlers: GridActions = {
    ...selectionControls.handlers,
    memberOptions: () => assignableUsers,
    rowMenu: (task) => onRowMenu(task),
    startRowDrag,
    keyboardMoveRow,
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
  // 행 위치(measurementsCache)도 함께 갱신한다.
  const virtualRows = virtual.getVirtualItems();
  return (
    <div
      className={`grid-area${footer ? " has-sheet-footer" : ""}`}
      style={
        {
          "--row-header-width": `${rowHeaderWidth}px`,
          "--grid-zoom": zoom,
        } as CSSProperties
      }
    >
      <div
        ref={ref}
        tabIndex={0}
        role="grid"
        aria-label="연간 업무 일정"
        aria-rowcount={matchingTasks.length + 1}
        aria-colcount={columns.length + 1}
        aria-readonly={readOnly}
        className={`sheet-scroll${footer ? " has-sheet-footer" : ""}`}
        data-density={density}
        data-format-painting={formatPainting || undefined}
        {...selectionControls.gridEvents}

        onCopy={(e) => {
          if (editor || !ranges.length) return;
          e.preventDefault();
          const layout = copyLayout(ranges);
          const failed = (message: string) =>
            onCopied ? onCopied(message) : onError(message);
          if (!layout) {
            failed(
              "여러 영역을 복사할 때는 같은 행 또는 같은 열의 영역을 선택하세요.",
            );
            return;
          }
          try {
            copyToEvent(
              e.clipboardData,
              createClipboard(
                layout.rows.map((i) => tasks[i]),
                layout.columns.map((i) => columns[i].key),
                users,
                settings,
              ),
            );
            onCopied?.("");
          } catch (err) {
            failed((err as Error).message);
          }
        }}
        onPaste={(e) => {
          if (editor || readOnly || formatPainting || !selection) return;
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
                  const next: Selection = {
                    kind: "all",
                    anchor: { taskId: tasks[0].id, key: columns[0].key },
                    focus: {
                      taskId: tasks.at(-1)!.id,
                      key: columns.at(-1)!.key,
                    },
                  };
                  onSelect(next);
                  if (formatPainting) onPaintFormat?.(next);
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
                className={`header-cell ${c.fixed ? "fixed" : c.month ? "week-heading" : ""} ${c.key <= today && (c.end || "") >= today ? "this-week" : ""} ${propertyFilters[c.key]?.length ? "is-filtered" : ""}`}
                style={{
                  width: c.width,
                  ...bordersCSS(boundaryStyles.get(c.key) || {}),
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
        {group && (
          <PinnedGroupHeading
            scroller={ref}
            starts={groupStarts}
            measurements={virtual.measurementsCache}
            scrollMargin={virtual.options.scrollMargin}
            tasks={tasks}
            group={group}
            counts={groupCounts}
            users={users}
            settings={settings}
            width={totalWidth}
          />
        )}
        <div
          className="virtual-body"
          style={{ height: virtual.getTotalSize(), width: totalWidth }}
        >
          {virtualRows.map((row) => {
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
                  columnKeys={columnKeys}
                  boundaryStyles={boundaryStyles}
                  positions={positions}
                  properties={properties}
                  users={users}
                  settings={settings}
                  user={user}
                  canEditPeople={canEditPeople}
                  copyEditable={copyEditable}
                  readOnly={readOnly || formatPainting}
                  presentation={presentation}
                  sorted={sorted}
                  spans={spans}
                  presence={presenceRows.get(task.id) || ""}
                  rowSelected={rowSelected}
                  focusKey={
                    selection?.focus.taskId === task.id
                      ? selection.focus.key
                      : null
                  }
                  editor={editor?.point.taskId === task.id ? editor : null}
                  editorActive={!!editor}
                  touchInput={touchInput}
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
              !footer && !readOnly && canAdd ? (
                <Button className="primary" onClick={onAdd}>
                  <Plus size={16} />
                  {addTaskLabel}
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
        {footer && <SheetHorizontalScroll width={totalWidth} />}
      </div>
      {footer}
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
            selectionControls.closeHeaderMenu();
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

type RowGap = { ids: string[]; start: number; end: number };

// 묶음의 첫 행 위에 그리는 묶음 제목. 표 위에 고정한 제목도 같은 모양을 쓴다.
function GroupHeading({
  task,
  group,
  count,
  users,
  settings,
  shift = 0,
}: {
  task: Task;
  group: Property | undefined;
  count: number | undefined;
  users: User[];
  settings: Settings;
  shift?: number;
}) {
  const groupKey = group?.id || "";
  return (
    <div
      className="group-heading"
      role="presentation"
      style={shift ? { transform: `translateY(${shift}px)` } : undefined}
    >
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
        <small>{count}개 업무</small>
      </span>
    </div>
  );
}

// 묶음 보기에서 스크롤해 지나간 묶음의 제목을 열 머리글 아래에 고정한다. 다음 묶음의
// 제목이 닿으면 위로 밀어내고 그 제목으로 바뀐다. 행은 가상 스크롤로 옮겨 그리므로
// 행 안의 제목에 sticky를 쓸 수 없어, 스크롤 위치와 행 위치로 고정할 묶음을 찾는다.
// 스크롤마다 표 전체가 아니라 이 제목만 다시 그린다.
function PinnedGroupHeading({
  scroller,
  starts,
  measurements,
  scrollMargin,
  tasks,
  group,
  counts,
  users,
  settings,
  width,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  // 묶음마다 첫 행의 순번
  starts: number[];
  measurements: VirtualItem[];
  scrollMargin: number;
  tasks: Task[];
  group: Property | undefined;
  counts: Map<string, number>;
  users: User[];
  settings: Settings;
  width: number;
}) {
  const [pinned, setPinned] = useState<{
    index: number;
    shift: number;
  } | null>(null);
  const current = useRef(pinned);
  useLayoutEffect(() => {
    const grid = scroller.current;
    if (!grid) return;
    // 행 영역에서 묶음 제목의 위치. 열 머리글 높이가 scrollMargin이다.
    const top = (i: number) => measurements[starts[i]].start - scrollMargin;
    const update = (sync: boolean) => {
      // 열 머리글 바로 아래에 보이는 행 영역의 위치
      const y = grid.scrollTop;
      let low = 0,
        high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (top(mid) <= y) low = mid;
        else high = mid - 1;
      }
      // 묶음 제목이 제자리에 보이면 겹쳐 그리지 않는다.
      const next =
        starts.length && top(low) < y
          ? {
              index: starts[low],
              shift:
                low + 1 < starts.length
                  ? Math.min(0, top(low + 1) - y - GROUP_HEADING_HEIGHT)
                  : 0,
            }
          : null;
      const old = current.current;
      if (old?.index === next?.index && old?.shift === next?.shift) return;
      current.current = next;
      // 스크롤과 같은 프레임에 제목을 옮겨 행과 어긋나 보이지 않게 한다.
      if (sync) flushSync(() => setPinned(next));
      else setPinned(next);
    };
    update(false);
    const scroll = () => update(true);
    grid.addEventListener("scroll", scroll, { passive: true });
    return () => grid.removeEventListener("scroll", scroll);
  }, [scroller, starts, measurements, scrollMargin]);
  const task = pinned && tasks[pinned.index];
  if (!pinned || !task) return null;
  return (
    <div className="group-heading-pin" aria-hidden="true" style={{ width }}>
      <GroupHeading
        task={task}
        group={group}
        count={counts.get(groupValue(task, group?.id || ""))}
        users={users}
        settings={settings}
        shift={pinned.shift}
      />
    </div>
  );
}

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
  columnKeys,
  boundaryStyles,
  positions,
  properties,
  users,
  settings,
  user,
  canEditPeople,
  copyEditable,
  readOnly,
  presentation,
  sorted,
  spans,
  presence,
  rowSelected,
  focusKey,
  editor,
  editorActive,
  touchInput,
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
  columnKeys: string[];
  boundaryStyles: Map<string, Style>;
  positions: number[];
  properties: Property[];
  users: User[];
  settings: Settings;
  user: User;
  canEditPeople: boolean;
  copyEditable: boolean;
  readOnly: boolean;
  presentation: boolean;
  sorted: boolean;
  spans: string;
  // 이 행에 있는 다른 사람의 셀. 문자열로 넘겨 다른 행은 다시 그리지 않는다.
  presence: string;
  rowSelected: boolean;
  focusKey: string | null;
  editor: EditorState | null;
  editorActive: boolean;
  touchInput: boolean;
  // 이 행 아래쪽 끝에 높이 손잡이를 둘지. 마지막 행은 경계에 걸치고,
  // 묶음 제목 바로 위 행은 제목에 가려지지 않게 행 안쪽에 둔다.
  resizeEnd: "" | "edge" | "inside";
  actions: GridActions;
}) {
  const selectedSpans = spans
    ? spans
        .slice(0, -1)
        .split(",")
        .map((span) => span.split("-").map(Number))
    : [];
  const editable = !readOnly && (copyEditable || canEdit(user, task));
  const presenceCells = useMemo(
    () => new Map<string, CellPresence>(presence ? JSON.parse(presence) : []),
    [presence],
  );
  const displayStyles = useMemo(
    () =>
      withWeekBoundaries(
        columnKeys,
        columnKeys.map((key) => cell(task, key).style),
        boundaryStyles,
        columnKeys.map((key) => explicitStyle(task, key)),
      ),
    [task, columnKeys, boundaryStyles],
  );
  return (
    <>
      {!!groupHeight && (
        <GroupHeading
          task={task}
          group={group}
          count={groupCount}
          users={users}
          settings={settings}
        />
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
                readOnly ||
                sorted ||
                editorActive ||
                !(copyEditable || canEdit(user, task))
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
          textMode(displayStyles[ci]) === "overflow" &&
          (Array.isArray(own) ? own.length > 0 : own !== "" && own != null)
        ) {
          for (let next = ci + 1; next < columns.length; next++) {
            const neighbor = columns[next];
            const v = value(task, neighbor.key);
            const right = displayStyles[next - 1].borderRight;
            const left = displayStyles[next].borderLeft;
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
            displayStyle={displayStyles[ci]}
            left={c.fixed ? positions[ci] : undefined}
            overflowWidth={overflowWidth}
            topBorder={
              previousTask
                ? cell(previousTask, c.key).style.borderBottom
                : undefined
            }
            leftBorder={displayStyles[ci - 1]?.borderRight}
            rightBorder={displayStyles[ci + 1]?.borderLeft}
            bottomBorder={
              nextTask ? cell(nextTask, c.key).style.borderTop : undefined
            }
            property={property}
            selection={selectionEdges(selectedSpans, ci)}
            presence={presenceCells.get(c.key)}
            focused={focusKey === c.key}
            touchInput={touchInput}
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

type CellPresence = { color: string; label: string; editing: boolean };

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
  displayStyle,
  left,
  overflowWidth,
  topBorder,
  leftBorder,
  rightBorder,
  bottomBorder,
  property,
  selection,
  presence,
  focused,
  touchInput,
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
  displayStyle: Style;
  left: number | undefined;
  overflowWidth: number;
  topBorder: Style["borderBottom"];
  leftBorder: Style["borderRight"];
  rightBorder: Style["borderLeft"];
  bottomBorder: Style["borderTop"];
  property: Property | undefined;
  // 선택되지 않았으면 null, 선택됐으면 영역 외곽에 닿은 변(t·r·b·l).
  selection: string | null;
  presence: CellPresence | undefined;
  focused: boolean;
  touchInput: boolean;
  editor: EditorState | null;
  editable: boolean;
  canEditPeople: boolean;
  users: User[];
  settings: Settings;
  presentation: boolean;
  actions: GridActions;
}) {
  const current = cell(task, c.key),
    s = displayStyle;
  const text = displayValueFor(property, current.value, users);
  const documentCount = task.documentCount ?? task.documents?.length ?? 0;
  const showDocumentCount = !!task.hasDocument && documentCount > 1;
  const documentLabel = !task.hasDocument
    ? "상세 열기"
    : showDocumentCount
      ? `문서 ${documentCount}개 열기`
      : "문서 열기";
  const choice = property?.kind === "option" || property?.kind === "member";
  const editableChoice =
    choice &&
    !!text &&
    editable &&
    (!["owner", "supporters"].includes(c.key) || canEditPeople);
  const editing = !!editor;
  const showDetailAction =
    c.key === "title" && !editing && (!presentation || task.hasDocument);
  const prepareText =
    !touchInput &&
    focused &&
    editable &&
    !choice &&
    property?.kind !== "date" &&
    property?.kind !== "number";
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
    // 오버플로우 표시 영역은 절대 위치여서 셀의 글자 장식이 전파되지 않는다.
    <span
      className="cell-text"
      style={textDecoration ? { textDecoration } : undefined}
    >
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
      aria-label={
        (prepareText || c.key === "title") && !editing
          ? text || undefined
          : undefined
      }
      aria-selected={selection !== null}
      data-selection-edges={selection || undefined}
      data-cell={`${task.id}:${c.key}`}
      data-task-id={task.id}
      data-column={c.key}
      data-text-mode={mode}
      className={`sheet-cell ${c.fixed ? "fixed" : ""} ${selection !== null ? "selected" : ""} ${focused ? "focused" : ""} ${c.key === "title" ? `task-title ${task.hasDocument ? `has-document ${showDocumentCount ? "has-document-count" : ""}` : ""}` : ""} ${showDetailAction ? "has-detail-action" : ""} ${c.month ? "week-cell" : ""} ${editing ? "editing" : ""} ${!choice && mode === "overflow" && text && !editing ? "text-overflow-cell" : ""}`}
      style={style}
      title={
        [
          text,
          presence &&
            `${presence.label} ${presence.editing ? "편집 중" : "선택 중"}`,
        ]
          .filter(Boolean)
          .join("\n") || undefined
      }
      aria-description={
        presence
          ? `${presence.label} ${presence.editing ? "편집 중" : "선택 중"}`
          : undefined
      }
      onPointerDown={(e) => actions.cellPointerDown(e, point)}
      onPointerMove={(e) => actions.dragSelect(e, point)}
      onDoubleClick={() => editable && actions.doubleClick(point)}
      onContextMenu={(e) => {
        // Touch text selection can emit contextmenu after opening the editor.
        if (touchInput) {
          if (!editing) e.preventDefault();
          return;
        }
        e.preventDefault();
        // macOS emits a context menu for Ctrl+click as well.
        if (e.ctrlKey) return;
        if (!presentation) actions.rowMenu(task);
      }}
    >
      {/* 이름표는 CSS가 data-name으로 그려 셀 글자(textContent)에 섞지 않는다. */}
      {presence && (
        <span
          className="sheet-presence"
          data-name={presence.label}
          data-editing={presence.editing || undefined}
          style={
            {
              "--presence-color": presence.color,
              "--presence-ink": inkFor(presence.color),
            } as CSSProperties
          }
          aria-hidden="true"
        />
      )}
      {showDetailAction && (
        <button
          type="button"
          className={`task-document-indicator${task.hasDocument ? "" : " is-empty"}`}
          aria-label={`${text || "제목 없는 업무"} ${documentLabel}`}
          data-tooltip={`업무 ${documentLabel}`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            actions.rowMenu(task);
          }}
        >
          {showDocumentCount && (
            <span className="task-document-count" aria-hidden="true">
              {documentCount}
            </span>
          )}
          <FileText size={11} aria-hidden="true" />
        </button>
      )}
      {(editing || prepareText) && (
        <InlineCellEditor
          key={`${task.id}:${c.key}`}
          editor={editor || { point }}
          prepared={!editing}
          onStart={() => actions.edit(point, "")}
          task={task}
          users={users}
          memberOptions={actions.memberOptions()}
          settings={settings}
          onCommit={actions.finish}
          onCancel={actions.cancelEdit}
        />
      )}
      {!editing &&
        (editableChoice ? (
          <button
            className="cell-choice-trigger"
            aria-label={`${c.label} 선택`}
            aria-haspopup="listbox"
            aria-expanded="false"
            onClick={(e) => {
              // 키보드·보조기기의 활성화는 유지하고 포인터 입력은 셀에서 처리한다.
              if (e.detail === 0) actions.edit(point);
            }}
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
        ))}
    </div>
  );
});
