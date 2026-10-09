import {
  useLayoutEffect,
  useEffect,
  useState,
  useRef,
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
  ArrowUpDown,
  GripVertical,
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
} from "./types";
import {
  canEdit,
  cell,
  displayValue,
  value,
  textLinks,
  todayKey,
  propertiesFor,
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
import {
  createClipboard,
  copyToEvent,
  readClipboard,
  type ClipboardMatrix,
} from "./clipboard";

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
export function rangeOf(
  selection: Selection | null,
  tasks: Task[],
  columns: Column[],
) {
  if (!selection) return null;
  const r1 = tasks.findIndex((t) => t.id === selection.anchor.taskId),
    r2 = tasks.findIndex((t) => t.id === selection.focus.taskId),
    c1 = columns.findIndex((c) => c.key === selection.anchor.key),
    c2 = columns.findIndex((c) => c.key === selection.focus.key);
  if ([r1, r2, c1, c2].some((v) => v < 0)) return null;
  return {
    r1: Math.min(r1, r2),
    r2: Math.max(r1, r2),
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
  const r = rangeOf(selection, tasks, columns);
  if (!r) return [];
  if ((r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1) > limit)
    throw new Error(
      `한 번에 ${limit.toLocaleString()}개 셀까지 편집할 수 있습니다. 선택 범위를 줄여주세요.`,
    );
  const points: Point[] = [];
  for (let i = r.r1; i <= r.r2; i++)
    for (let j = r.c1; j <= r.c2; j++)
      points.push({ taskId: tasks[i].id, key: columns[j].key });
  return points;
}
export default function Grid({
  tasks,
  columns,
  view,
  user,
  users,
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
  columns: Column[];
  view: View;
  user: User;
  users: User[];
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
    taskId: string,
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
    targetId: string;
    placement: "before" | "after";
    valid: boolean;
  } | null>(null);
  const stopRowDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRowDrag.current?.(), []);
  function positionRowDragPreview() {
    const preview = rowDragPreview.current;
    if (!preview) return;
    const { x, y } = rowDragPointer.current;
    preview.style.transform = `translate3d(${Math.max(8, Math.min(x + 18, window.innerWidth - preview.offsetWidth - 8))}px, ${Math.max(8, Math.min(y + 18, window.innerHeight - preview.offsetHeight - 8))}px, 0)`;
  }
  useLayoutEffect(positionRowDragPreview, [rowDrag]);
  const today = todayKey();
  const totalWidth = 48 + columns.reduce((s, c) => s + c.width, 0);
  let offset = 48;
  const positions = columns.map((c) => {
    const p = offset;
    offset += c.width;
    return p;
  });
  const range = rangeOf(selection, tasks, columns);
  const properties = propertiesFor(settings) as Property[];
  const group = properties.find((p) => p.id === view.groupBy);
  const groupKey = group?.id || "";
  const sorted = !!view.sortKey && view.sortDirection !== "default";
  function startRowDrag(e: React.PointerEvent, task: Task) {
    if (e.button !== 0 || readOnly || sorted || editor || !canEdit(user, task))
      return;
    e.preventDefault();
    e.stopPropagation();
    stopRowDrag.current?.();
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
      if (!item || item.id === task.id || !element) {
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
      window.removeEventListener("keydown", escape);
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
        cancel();
      }
    };
    const finishDrag = () => {
      clean();
      setRowDrag(null);
      if (dragging && drop) {
        if (drop.valid) onReorder(task.id, drop.targetId, drop.placement);
        else onError("묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.");
      }
    };
    stopRowDrag.current = clean;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", escape);
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
          48 + columns.filter((c) => c.fixed).reduce((s, c) => s + c.width, 0);
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
  function sortColumn(key: string) {
    const current = view.sortKey === key ? view.sortDirection : "default";
    const direction =
      current === "asc" ? "desc" : current === "desc" ? "default" : "asc";
    onView({
      sortKey: direction === "default" ? "" : key,
      sortDirection: direction,
      sort: "position",
    });
  }
  function pick(point: Point, extend = false) {
    if (!extend || !selection) onSelect({ anchor: point, focus: point });
    else onSelect({ ...selection, focus: point });
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
    <div className="grid-area">
      <div
        ref={ref}
        tabIndex={0}
        role="grid"
        aria-label="연간 업무 일정"
        aria-rowcount={tasks.length + 1}
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
            #
          </div>
          {columns.map((c, ci) => (
            <div
              key={c.key}
              role="columnheader"
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
              {c.month || presentation ? (
                <span
                  className="week-label"
                  title={c.month ? `${c.key} ~ ${c.end}` : c.label}
                >
                  {c.label}
                </span>
              ) : (
                <button
                  className="column-sort"
                  aria-label={`${c.label} 정렬`}
                  onClick={() => sortColumn(c.key)}
                  title="오름차순 → 내림차순 → 기본 순서"
                >
                  {c.label}
                  {view.sortKey === c.key ? (
                    view.sortDirection === "asc" ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    )
                  ) : (
                    <ArrowUpDown className="sort-idle" size={12} />
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
                      (w) => onView({ widths: { ...view.widths, [c.key]: w } }),
                      c.month ? 40 : 45,
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
        <div
          className="virtual-body"
          style={{ height: virtual.getTotalSize(), width: totalWidth }}
        >
          {virtual.getVirtualItems().map((row) => {
            const task = tasks[row.index];
            return (
              <div
                key={task.id}
                role="row"
                aria-rowindex={row.index + 2}
                data-row-id={task.id}
                className={`sheet-row ${rowDrag?.taskId === task.id ? "row-dragging" : ""} ${rowDrag?.targetId === task.id ? (rowDrag.valid ? `row-drop-${rowDrag.placement}` : "row-drop-invalid") : ""}`}
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
                <div className="row-number">
                  {presentation ? (
                    <span>{row.index + 1}</span>
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
                            ? "컬럼 정렬을 해제하면 순서를 이동할 수 있습니다."
                            : "번호를 드래그하여 순서 이동 · Alt+위/아래 방향키"
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
                          const same = tasks.filter(
                            (t) =>
                              !groupKey ||
                              groupValue(t, groupKey) ===
                                groupValue(task, groupKey),
                          );
                          const index = same.findIndex((t) => t.id === task.id),
                            direction = e.key === "ArrowUp" ? -1 : 1,
                            neighbor = same[index + direction];
                          if (neighbor)
                            onReorder(
                              task.id,
                              neighbor.id,
                              direction < 0 ? "before" : "after",
                            );
                        }}
                      >
                        {row.index + 1}
                      </button>
                      <button
                        className="row-menu-trigger"
                        aria-label={`${value(task, "title")} 업무 메뉴`}
                        onClick={() => onRowMenu(task)}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      <span
                        className="row-resizer"
                        title="행 높이 조절"
                        onPointerDown={(e) => {
                          e.preventDefault();
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
                </div>
                {columns.map((c, ci) => {
                  const current = cell(task, c.key),
                    s = current.style;
                  const selected =
                    range &&
                    row.index >= range.r1 &&
                    row.index <= range.r2 &&
                    ci >= range.c1 &&
                    ci <= range.c2;
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
                      if (
                        !!neighbor.fixed !== !!c.fixed ||
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
                  const renderedText = (
                    <span className="cell-text">
                      {textLinks(text).map((part, index) =>
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
                          part.text
                        ),
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
                    ...(c.fixed ? { left: positions[ci] } : {}),
                    color: s.color,
                    backgroundColor: s.backgroundColor,
                    fontFamily: fontFamilyCSS(s.fontFamily),
                    fontSize: s.fontSize ? `${s.fontSize}pt` : undefined,
                    fontWeight:
                      s.bold === undefined ? undefined : s.bold ? 700 : 400,
                    fontStyle: s.italic ? "italic" : undefined,
                    textDecoration: [
                      s.underline ? "underline" : "",
                      s.strike ? "line-through" : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
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
                          pick({ taskId: task.id, key: c.key }, e.shiftKey);
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
        {!!tasks.length && !readOnly && user.role !== "viewer" && (
          <Button className="primary add-row" onClick={onAdd}>
            <Plus size={17} />
            업무 추가
          </Button>
        )}
      </div>
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
