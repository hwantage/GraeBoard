import {
  useMemo,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  type RefObject,
  type KeyboardEvent,
} from "react";
import type React from "react";
import { canEdit, groupValue } from "../../shared/domain.js";
import { trackPointerDrag } from "../ui/trackPointerDrag";
import { rangesOf, elementBelowPinnedHeading } from "./grid-selection";
import type { Task, User, Selection } from "../types";
import type { Column } from "./grid-types";
import type { EditorState } from "./InlineCellEditor";
export default function useGridRowDrag({
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
  onStart,
}: {
  scopeKey: string;
  ref: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  columns: Column[];
  selection: Selection | null;
  groupKey: string;
  sorted: boolean;
  readOnly: boolean;
  editor: EditorState | null;
  copyEditable: boolean;
  user: User;
  onSelect: (selection: Selection | null) => void;
  onReorder: (
    taskIds: string[],
    targetId: string,
    placement: "before" | "after",
  ) => void;
  onError: (message: string) => void;
  onStart: () => void;
}) {
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
  const ranges = useMemo(
    () => rangesOf(selection, tasks, columns),
    [selection, tasks, columns],
  );
  useEffect(() => () => stopRowDrag.current?.(), [scopeKey]);
  useLayoutEffect(positionRowDragPreview, [rowDrag]);
  function positionRowDragPreview() {
    const preview = rowDragPreview.current;
    if (!preview) return;
    const { x, y } = rowDragPointer.current;
    preview.style.transform = `translate3d(${Math.max(8, Math.min(x + 18, window.innerWidth - preview.offsetWidth - 8))}px, ${Math.max(8, Math.min(y + 18, window.innerHeight - preview.offsetHeight - 8))}px, 0)`;
  }
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
    if (!copyEditable && moving.some((t) => !canEdit(user, t))) {
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
    if (
      e.button !== 0 ||
      readOnly ||
      sorted ||
      editor ||
      !(copyEditable || canEdit(user, task))
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    const moving = rowsToMove(task);
    if (!canMoveRows(moving)) return;
    const movingTaskIds = moving.map((t) => t.id);
    const movingIds = new Set(movingTaskIds);
    stopRowDrag.current?.();
    onStart();
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
      const element = elementBelowPinnedHeading(x, y)?.closest<HTMLElement>(
        ".sheet-row",
      );
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
    stopRowDrag.current = trackPointerDrag(e, {
      onMove: move,
      onEnd: (position, cancelled) => {
        if (dragging && !cancelled) {
          x = position.clientX;
          y = position.clientY;
          target();
        }
        document.body.classList.remove("row-reordering");
        cancelAnimationFrame(frame);
        stopRowDrag.current = null;
        setRowDrag(null);
        if (!cancelled && dragging && drop) {
          if (drop.valid) moveRows(moving, drop.targetId, drop.placement);
          else
            onError("묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.");
        }
      },
    });
    frame = requestAnimationFrame(scroll);
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
  return { rowDrag, draggedIds, rowDragPreview, startRowDrag, keyboardMoveRow };
}
