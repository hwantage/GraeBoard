import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { trackPointerDrag } from "./trackPointerDrag";

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
  axis: "vertical" | "horizontal" = "vertical",
) {
  const root = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  const horizontal = axis === "horizontal";
  const [drag, setDrag] = useState<{
    id: string;
    targetId: string;
    placement: Placement;
  } | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    cleanup.current?.();
  }, [disabled, ids.join(":")]);
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled || event.button !== 0) return;
    if (!horizontal) event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    cleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = horizontal ? event.clientX : event.clientY;
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
      const row = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest<HTMLElement>("[data-reorder-id]");
      drop = null;
      if (row && root.current?.contains(row) && row.dataset.reorderId !== id) {
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
      };
      setDrag((current) =>
        current?.id === next.id &&
        current.targetId === next.targetId &&
        current.placement === next.placement
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
      if (!moved && Math.abs((horizontal ? e.clientX : e.clientY) - origin) < 4)
        return;
      if (horizontal) e.preventDefault();
      moved = true;
      pointer = { x: e.clientX, y: e.clientY };
      locate();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    cleanup.current = trackPointerDrag(event, {
      captureTarget: handle,
      onMove: move,
      onEnd: (position, cancelled) => {
        if (moved && !cancelled) {
          pointer = { x: position.clientX, y: position.clientY };
          locate();
        }
        if (horizontal && moved) suppressClickUntil.current = Date.now() + 250;
        cancelAnimationFrame(frame);
        cleanup.current = null;
        setDrag(null);
        if (!cancelled && moved && drop)
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
        if (horizontal && Date.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => start(e, id),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => keyboard(e, id),
    }),
  };
}
