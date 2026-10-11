import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";

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
) {
  const root = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
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
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    cleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let pointer = { x: event.clientX, y: event.clientY };
    let frame = 0;
    let scroll: HTMLElement | null = root.current;
    while (
      scroll &&
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
      drop =
        row && root.current?.contains(row) && row.dataset.reorderId !== id
          ? {
              targetId: row.dataset.reorderId!,
              placement:
                pointer.y <
                row.getBoundingClientRect().top +
                  row.getBoundingClientRect().height / 2
                  ? "before"
                  : "after",
            }
          : null;
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
        if (pointer.x >= box.left && pointer.x <= box.right) {
          const delta =
            pointer.y < box.top + 24 ? -8 : pointer.y > box.bottom - 24 ? 8 : 0;
          if (delta) {
            scroll.scrollTop += delta;
            locate();
          }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!moved && Math.abs(e.clientY - startY) < 4) return;
      moved = true;
      pointer = { x: e.clientX, y: e.clientY };
      locate();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    const cancel = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
      cleanup.current = null;
      setDrag(null);
    };
    const finish = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (moved) {
        pointer = { x: e.clientX, y: e.clientY };
        locate();
      }
      cancel();
      if (moved && drop) onMove(id, drop.targetId, drop.placement);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    cleanup.current = cancel;
    handle.setPointerCapture(pointerId);
    handle.addEventListener("lostpointercapture", cancel);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (
      disabled ||
      !event.altKey ||
      !["ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.key === "ArrowDown";
    const target = ids[ids.indexOf(id) + (after ? 1 : -1)];
    if (target) onMove(id, target, after ? "after" : "before");
  }
  return {
    root,
    itemProps: (id: string) => ({
      "data-reorder-id": id,
      "data-reordering": drag?.id === id || undefined,
      "data-reorder-drop": drag?.targetId === id ? drag.placement : undefined,
    }),
    handleProps: (id: string) => ({
      type: "button" as const,
      className: "list-drag-handle",
      disabled,
      title: "드래그하여 순서 이동 · Alt+위/아래 방향키",
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => start(e, id),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => keyboard(e, id),
    }),
  };
}
