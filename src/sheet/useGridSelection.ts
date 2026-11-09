import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
  type HTMLAttributes,
} from "react";
import type React from "react";
import { flushSync } from "react-dom";
import { useTouchPress } from "../ui/useTouchPress";
import { trackPointerDrag } from "../ui/trackPointerDrag";
import { subtractRange, toSelectionArea } from "./selection-areas.js";
import {
  rangeOf,
  rangesOf,
  savedAreas,
  elementBelowPinnedHeading,
} from "./grid-selection";
import type { Task, Selection, SelectionArea, Point, Cell } from "../types";
import type { Column, GridActions } from "./grid-types";
import type { EditorState, EditMove } from "./InlineCellEditor";
// Remember touch across screen changes so a prepared IME input stays unfocused.
let lastPointerWasTouch = false;
export default function useGridSelection({
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
}: {
  scopeKey: string;
  ref: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  columns: Column[];
  taskIndexes: Map<string, number>;
  selection: Selection | null;
  ranges: ReturnType<typeof rangesOf>;
  editor: EditorState | null;
  zoom: number;
  rowHeaderWidth: number;
  readOnly: boolean;
  presentation: boolean;
  formatPainting: boolean;
  onSelectionChange: (selection: Selection | null) => void;
  onPaintFormat: ((selection: Selection | null) => void) | undefined;
  onEdit: (point: Point, initial?: string) => boolean;
  onCommit: (point: Point, value: Cell["value"]) => boolean;
  onCancelEdit: () => void;
  onClear: () => void;
  scrollToRow: (index: number) => void;
}) {
  const [touchInput, setTouchInput] = useState(lastPointerWasTouch);
  const touchInputRef = useRef(lastPointerWasTouch);
  const touchPress = useTouchPress();
  const focusTarget = useRef(selection?.focus);
  const latestSelection = useRef(selection);
  const paint = useRef(onPaintFormat);
  const stopFormatDrag = useRef<(() => void) | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const removing = useRef<{
    base: Selection | null;
    start: Point;
    last: Point;
  } | null>(null);
  const stopHeaderDrag = useRef<(() => void) | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{
    kind: "columns" | "rows";
    taskId?: string;
    index: number;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    const rememberPointer = (event: PointerEvent) => {
      lastPointerWasTouch = event.pointerType === "touch";
    };
    window.addEventListener("pointerdown", rememberPointer, true);
    return () =>
      window.removeEventListener("pointerdown", rememberPointer, true);
  }, []);
  latestSelection.current = selection;
  paint.current = onPaintFormat;
  useEffect(() => {
    if (!formatPainting) stopFormatDrag.current?.();
    return () => stopFormatDrag.current?.();
  }, [formatPainting, scopeKey]);
  focusTarget.current = selection?.focus;
  useEffect(() => () => stopHeaderDrag.current?.(), [tasks, columns, scopeKey]);
  const liveEdit = useRef(onEdit);
  liveEdit.current = (point, initial) =>
    !formatPainting && onEdit(point, initial);
  function startFormatDrag(event: React.PointerEvent) {
    if (!formatPainting) return;
    stopFormatDrag.current?.();
    stopFormatDrag.current = trackPointerDrag(event, {
      onMove: () => {},
      onEnd: (_, cancelled) => {
        stopFormatDrag.current = null;
        if (!cancelled) paint.current?.(latestSelection.current);
      },
    });
  }

  function onSelect(next: Selection | null) {
    // 포커스 이벤트는 선택 변경의 렌더보다 먼저 발생할 수 있다.
    // 곧 제거될 이전 셀의 입력창으로 포커스가 돌아가지 않게 한다.
    focusTarget.current = next?.focus;
    latestSelection.current = next;
    onSelectionChange(next);
  }

  function finish(value: Cell["value"], move?: EditMove) {
    if (!editor) return;
    const point = editor.point;
    if (!onCommit(point, value)) return false;
    if (move === "stay") pick(point);
    else if (move) {
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
      scrollToRow(nextR);
    }
    return true;
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
    if (e.pointerType === "touch") {
      e.preventDefault();
      touchPress.start(e, {
        onTap: () => selectHeader(kind, index),
        onLongPress: () => showHeaderMenu(kind, index, e.clientX, e.clientY),
      });
      return;
    }
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
    // ⌘/Ctrl로 이미 선택한 행·열 머리글을 누르거나 끌면 그 행·열을 뺀다.
    const remove =
      additive &&
      !e.shiftKey &&
      !formatPainting &&
      (kind === "rows"
        ? selectedAt(index, 0, kind)
        : selectedAt(0, index, kind));
    const band = (from: number, to: number) =>
      kind === "rows"
        ? {
            r1: Math.min(from, to),
            r2: Math.max(from, to),
            c1: 0,
            c2: columns.length - 1,
          }
        : {
            r1: 0,
            r2: tasks.length - 1,
            c1: Math.min(from, to),
            c2: Math.max(from, to),
          };
    let anchor = index;
    if (remove) {
      onSelect(without(previousSelection, band(index, index)));
      focusGrid();
    } else anchor = selectHeader(kind, index, e.shiftKey, additive);
    startFormatDrag(e);
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
      const element = elementBelowPinnedHeading(
        Math.max(box.left + 2, Math.min(x, box.right - 14)),
        kind === "columns"
          ? box.top + 16 * zoom
          : Math.max(box.top + 34 * zoom, Math.min(y, box.bottom - 14)),
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
        onSelect(
          remove
            ? without(previousSelection, band(anchor, next))
            : { ...headerSelection(kind, anchor, next), areas },
        );
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
            (rowHeaderWidth +
              columns.filter((c) => c.fixed).reduce((n, c) => n + c.width, 0)) *
            zoom;
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
    if (e.ctrlKey || touchInputRef.current) return;
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
    focusGrid();
  }

  function without(
    base: Selection | null,
    remove: { r1: number; r2: number; c1: number; c2: number },
  ): Selection | null {
    const kept: SelectionArea[] = [];
    for (const area of savedAreas(base)) {
      const range = rangeOf(area, tasks, columns);
      const pieces =
        range &&
        subtractRange(
          { ...range, kind: area.kind },
          remove,
          tasks.length - 1,
          columns.length - 1,
        );
      if (!pieces) kept.push(area);
      else
        kept.push(
          ...pieces.map((piece) => toSelectionArea(piece, tasks, columns)),
        );
    }
    const active = kept.pop();
    return active
      ? { ...active, ...(kept.length ? { areas: kept } : {}) }
      : null;
  }

  function selectedAt(r: number, c: number, kind?: "columns" | "rows") {
    return ranges.some(
      (range) =>
        (!kind || range.kind === kind || range.kind === "all") &&
        r >= range.r1 &&
        r <= range.r2 &&
        c >= range.c1 &&
        c <= range.c2,
    );
  }

  function removeCells(from: Point, to: Point) {
    const r1 = taskIndexes.get(from.taskId) ?? -1,
      r2 = taskIndexes.get(to.taskId) ?? -1,
      c1 = columns.findIndex((c) => c.key === from.key),
      c2 = columns.findIndex((c) => c.key === to.key);
    if (!removing.current || r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return;
    removing.current.last = to;
    onSelect(
      without(removing.current.base, {
        r1: Math.min(r1, r2),
        r2: Math.max(r1, r2),
        c1: Math.min(c1, c2),
        c2: Math.max(c1, c2),
      }),
    );
  }

  function focusGrid() {
    ref.current?.focus({ preventScroll: true });
    // Firefox can clear focus when the blurred textarea unmounts. Restore the
    // grid after that commit, unless a new editor has already taken focus.
    requestAnimationFrame(() => {
      if (!ref.current?.querySelector(".inline-editor"))
        (
          (!touchInputRef.current &&
            ref.current?.querySelector<HTMLTextAreaElement>(
              ".cell-input-ready textarea",
            )) ||
          ref.current
        )?.focus({ preventScroll: true });
    });
  }

  function keyboard(e: KeyboardEvent) {
    if (e.target instanceof Element && e.target.closest(".annual-memos"))
      return;
    const prepared =
      e.target instanceof Element && !!e.target.closest(".cell-input-ready");
    if (
      (e.target instanceof Element &&
        e.target.closest("input,textarea,select,button,a") &&
        !prepared) ||
      editor ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229
    )
      return;
    if (e.key === "Escape") {
      // App can render brush cancellation before this handler runs. Respect
      // its prevented Escape without blocking the menu's document listener.
      if (e.defaultPrevented || formatPainting) return;
      onSelect(null);
      ref.current?.focus({ preventScroll: true });
      return;
    }
    if (!selection || !tasks.length) return;
    if (formatPainting && e.key === "Enter") {
      e.preventDefault();
      onPaintFormat?.(selection);
      return;
    }
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
        scrollToRow(r);
        return;
      }
      pick(
        { taskId: tasks[r].id, key: columns[c].key },
        e.shiftKey && e.key !== "Tab",
      );
      scrollToRow(r);
      const el = ref.current?.querySelector(
        `[data-cell="${tasks[r].id}:${columns[c].key}"]`,
      );
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (readOnly || formatPainting) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      onEdit(selection.focus);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClear();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 준비된 textarea가 첫 글자와 IME 조합을 직접 받는다.
      if (prepared) return;
      e.preventDefault();
      onEdit(selection.focus, e.key);
    }
  }
  const handlers: Pick<
    GridActions,
    | "cellPointerDown"
    | "doubleClick"
    | "dragSelect"
    | "edit"
    | "finish"
    | "cancelEdit"
    | "startHeaderSelection"
    | "selectHeader"
    | "openHeaderMenu"
    | "showHeaderMenu"
  > = {
    cellPointerDown(e, point) {
      if (e.button !== 0) return;
      if (e.pointerType === "touch") {
        // Suppress compatibility mouse focus/clicks; native touch panning stays enabled.
        e.preventDefault();
        touchPress.start(e, {
          onTap: () => {
            const current = latestSelection.current;
            const same =
              current &&
              !current.kind &&
              !current.areas?.length &&
              current.anchor.taskId === point.taskId &&
              current.anchor.key === point.key &&
              current.focus.taskId === point.taskId &&
              current.focus.key === point.key;
            // iOS requires the layout-effect focus inside this pointerup event.
            flushSync(() => {
              if (same) liveEdit.current(point);
              else pick(point);
            });
          },
          onLongPress: () => {
            const index = taskIndexes.get(point.taskId);
            if (index !== undefined)
              showHeaderMenu("rows", index, e.clientX, e.clientY);
          },
        });
        return;
      }
      dragOrigin.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      const r = taskIndexes.get(point.taskId) ?? -1,
        c = columns.findIndex((column) => column.key === point.key);
      removing.current =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !formatPainting &&
        selectedAt(r, c)
          ? { base: selection, start: point, last: point }
          : null;
      if (removing.current) {
        removeCells(point, point);
        focusGrid();
      } else pick(point, e.shiftKey, e.metaKey || e.ctrlKey);
      startFormatDrag(e);
    },
    doubleClick(point) {
      if (!touchInputRef.current && !formatPainting) onEdit(point);
    },
    dragSelect(e, point) {
      if (e.pointerType === "touch") return;
      const start = dragOrigin.current;
      const remove = removing.current;
      if (
        remove &&
        e.buttons === 1 &&
        (remove.last.taskId !== point.taskId || remove.last.key !== point.key)
      ) {
        removeCells(remove.start, point);
        return;
      }
      if (
        remove ||
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
    edit: (point, initial) => !formatPainting && onEdit(point, initial),
    finish,
    cancelEdit() {
      onCancelEdit();
      ref.current?.focus();
    },
    startHeaderSelection,
    selectHeader,
    openHeaderMenu,
    showHeaderMenu,
  };
  const gridEvents: Pick<
    HTMLAttributes<HTMLDivElement>,
    | "onPointerDownCapture"
    | "onClickCapture"
    | "onFocus"
    | "onKeyDown"
    | "onPointerUp"
    | "onPointerCancel"
  > = {
    onPointerDownCapture: (e) => {
      const touch = e.pointerType === "touch";
      touchInputRef.current = touch;
      setTouchInput(touch);
      if (touch) {
        dragOrigin.current = null;
        removing.current = null;
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest(".cell-input-ready")
        )
          active.blur();
      }
    },
    onClickCapture: touchPress.onClickCapture,
    onFocus: (e) => {
      if (touchInputRef.current || e.target !== e.currentTarget || editor)
        return;
      const input = e.currentTarget.querySelector<HTMLTextAreaElement>(
        ".cell-input-ready textarea",
      );
      const point = focusTarget.current;
      if (
        point &&
        input?.closest<HTMLElement>("[data-cell]")?.dataset.cell ===
          `${point.taskId}:${point.key}`
      )
        input.focus({ preventScroll: true });
    },
    onKeyDown: keyboard,
    onPointerUp: () => {
      dragOrigin.current = null;
      removing.current = null;
    },
    onPointerCancel: () => {
      dragOrigin.current = null;
      removing.current = null;
    },
  };
  return {
    handlers,
    gridEvents,
    onSelect,
    headerMenu,
    touchInput,
    closeHeaderMenu: () => setHeaderMenu(null),
    clearPointerOrigin: () => {
      dragOrigin.current = null;
    },
    cancelPointerSelection() {
      stopHeaderDrag.current?.();
      setHeaderMenu(null);
      dragOrigin.current = null;
    },
  };
}
