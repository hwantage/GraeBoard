import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { trackPointerDrag } from "./trackPointerDrag";
import {
  gridDropAt,
  reorderGridSlots,
  type ReorderGridPreview,
} from "./list-reorder-grid";

export type Placement = "before" | "after";
export function reorderItems<T extends { id: string }>(
  items: T[],
  id: string,
  targetId: string,
  placement: Placement,
) {
  const item = items.find((entry) => entry.id === id);
  if (!item || id === targetId) return items;
  const next = items.filter((entry) => entry.id !== id);
  const index = next.findIndex((entry) => entry.id === targetId);
  if (index < 0) return items;
  next.splice(index + Number(placement === "after"), 0, item);
  return next;
}

export function useListReorder<T extends HTMLElement>(
  ids: string[],
  onMove: (id: string, targetId: string, placement: Placement) => void,
  disabled: boolean,
  axis: "vertical" | "horizontal" | "grid" = "vertical",
) {
  const root = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
  // The release that ends a drag is no click on the dragged item.
  const suppressClick = useRef({ id: "", until: 0 });
  const horizontal = axis === "horizontal";
  const grid = axis === "grid";
  const [drag, setDrag] = useState<{
    id: string;
    targetId: string;
    placement: Placement;
    preview?: ReorderGridPreview;
  } | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    cleanup.current?.();
  }, [disabled, ids.join(":")]);
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (
      disabled ||
      event.button !== 0 ||
      (horizontal && event.pointerType === "touch")
    )
      return;
    if (!horizontal) event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    cleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = horizontal ? event.clientX : event.clientY;
    const originX = event.clientX,
      originY = event.clientY;
    let pointer = { x: event.clientX, y: event.clientY };
    let frame = 0;
    let scroll: HTMLElement | null = root.current;
    // Horizontal tabs own their scroll area; never scroll the surrounding sheet.
    while (
      scroll &&
      !horizontal &&
      !(
        scroll.scrollHeight > scroll.clientHeight &&
        /auto|scroll/.test(getComputedStyle(scroll).overflowY)
      )
    )
      scroll = scroll.parentElement;
    let moved = false;
    let drop: { targetId: string; placement: Placement } | null = null;
    const locate = () => {
      let preview: ReorderGridPreview | undefined;
      const row = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest<HTMLElement>("[data-reorder-id]");
      drop = null;
      const container = root.current;
      if (grid && container) {
        const bounds = container.getBoundingClientRect();
        const hit = document.elementFromPoint(pointer.x, pointer.y);
        if (
          pointer.x >= bounds.left &&
          pointer.x <= bounds.right &&
          pointer.y >= bounds.top &&
          pointer.y <= bounds.bottom &&
          hit &&
          container.contains(hit)
        ) {
          const style = getComputedStyle(container);
          const columns = style.gridTemplateColumns
            .split(" ")
            .map(Number.parseFloat)
            .filter((n) => Number.isFinite(n) && n > 0);
          const columnGap = Number.parseFloat(style.columnGap) || 0,
            rowGap = Number.parseFloat(style.rowGap) || 0;
          if (columns.length) {
            const elements = new Map(
              Array.from(
                container.querySelectorAll<HTMLElement>("[data-reorder-id]"),
              ).map((element) => [element.dataset.reorderId, element]),
            );
            const boxes = ids.flatMap((itemId) => {
              const item = elements.get(itemId);
              if (!item) return [];
              const box = item.getBoundingClientRect();
              return [
                {
                  id: itemId,
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  span: Math.max(
                    1,
                    Math.round(
                      (box.width + columnGap) / (columns[0] + columnGap),
                    ),
                  ),
                },
              ];
            });
            const target =
              boxes.length === ids.length
                ? gridDropAt(boxes, id, pointer)
                : null;
            if (target) {
              const ordered = reorderItems(
                boxes,
                id,
                target.targetId,
                target.placement,
              );
              if (ordered.some((box, index) => box.id !== ids[index])) {
                const slots = reorderGridSlots(
                  ordered,
                  columns,
                  columnGap,
                  rowGap,
                );
                const slot = slots.find((entry) => entry.id === id)!;
                drop = target;
                preview = {
                  ...slot,
                  id,
                  index: ordered.findIndex((entry) => entry.id === id),
                  order: ordered.map((entry) => entry.id),
                  left: slot.left + (Number.parseFloat(style.paddingLeft) || 0),
                  top: slot.top + (Number.parseFloat(style.paddingTop) || 0),
                };
              }
            }
          }
        }
      } else if (
        row &&
        container?.contains(row) &&
        row.dataset.reorderId !== id
      ) {
        const box = row.getBoundingClientRect();
        const before = horizontal
          ? pointer.x < box.left + box.width / 2
          : pointer.y < box.top + box.height / 2;
        drop = {
          targetId: row.dataset.reorderId!,
          placement: before ? "before" : "after",
        };
      }
      const next = {
        id,
        targetId: drop?.targetId || "",
        placement: drop?.placement || ("before" as Placement),
        preview,
      };
      setDrag((current) =>
        current?.id === next.id &&
        current.targetId === next.targetId &&
        current.placement === next.placement &&
        JSON.stringify(current.preview) === JSON.stringify(next.preview)
          ? current
          : next,
      );
    };
    const autoScroll = () => {
      if (scroll) {
        const box = scroll.getBoundingClientRect();
        const inside = horizontal
          ? pointer.y >= box.top && pointer.y <= box.bottom
          : pointer.x >= box.left && pointer.x <= box.right;
        if (inside) {
          const position = horizontal ? pointer.x : pointer.y;
          const near = horizontal ? box.left : box.top;
          const far = horizontal ? box.right : box.bottom;
          const delta = position < near + 24 ? -8 : position > far - 24 ? 8 : 0;
          if (delta) {
            if (horizontal) scroll.scrollLeft += delta;
            else scroll.scrollTop += delta;
            locate();
          }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (
        !moved &&
        (grid
          ? Math.hypot(e.clientX - originX, e.clientY - originY)
          : Math.abs((horizontal ? e.clientX : e.clientY) - origin)) < 4
      )
        return;
      if (horizontal || grid) e.preventDefault();
      moved = true;
      pointer = { x: e.clientX, y: e.clientY };
      locate();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    const geometryChanged = () => {
      if (moved) locate();
    };
    const geometryObserver = grid ? new ResizeObserver(geometryChanged) : null;
    if (geometryObserver && root.current) {
      geometryObserver.observe(root.current);
      root.current
        .querySelectorAll<HTMLElement>("[data-reorder-id]")
        .forEach((item) => geometryObserver.observe(item));
      window.addEventListener("scroll", geometryChanged, true);
      window.addEventListener("resize", geometryChanged);
    }
    cleanup.current = trackPointerDrag(event, {
      captureTarget: handle,
      onMove: move,
      onEnd: (position, cancelled) => {
        if (moved && !cancelled) {
          pointer = { x: position.clientX, y: position.clientY };
          locate();
        }
        const didMove = moved;
        moved = false;
        if (didMove) suppressClick.current = { id, until: Date.now() + 250 };
        cancelAnimationFrame(frame);
        geometryObserver?.disconnect();
        if (grid) {
          window.removeEventListener("scroll", geometryChanged, true);
          window.removeEventListener("resize", geometryChanged);
        }
        cleanup.current = null;
        setDrag(null);
        if (!cancelled && didMove && drop)
          onMove(id, drop.targetId, drop.placement);
      },
    });
    handle.setPointerCapture(pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (
      disabled ||
      !event.altKey ||
      !(
        horizontal ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
      ).includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.key === (horizontal ? "ArrowRight" : "ArrowDown");
    const target = ids[ids.indexOf(id) + (after ? 1 : -1)];
    if (target) onMove(id, target, after ? "after" : "before");
  }
  return {
    root,
    rootProps: {
      "data-reorder-grid-active": (grid && !disabled && !!drag) || undefined,
    },
    gridPreview: !disabled ? drag?.preview : undefined,
    itemProps: (id: string) => ({
      "data-reorder-id": id,
      "data-reorder-enabled": !disabled || undefined,
      "data-reordering": drag?.id === id || undefined,
      "data-reorder-drop": drag?.targetId === id ? drag.placement : undefined,
    }),
    handleProps: (id: string) => ({
      type: "button" as const,
      className: "list-drag-handle",
      disabled,
      title: horizontal
        ? "드래그하여 순서 이동 · Alt+왼쪽/오른쪽 방향키"
        : "드래그하여 순서 이동 · Alt+위/아래 방향키",
      onClickCapture: (event: MouseEvent<HTMLButtonElement>) => {
        if (
          suppressClick.current.id === id &&
          Date.now() < suppressClick.current.until
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => start(e, id),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => keyboard(e, id),
    }),
  };
}
