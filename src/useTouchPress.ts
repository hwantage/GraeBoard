import { useEffect, useRef, type PointerEvent, type MouseEvent } from "react";

// Share the same touch thresholds across the sheet and calendar menus.
export function useTouchPress() {
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const isTouch = useRef(false);
  useEffect(() => {
    const pointer = (event: globalThis.PointerEvent) => {
      isTouch.current = event.pointerType === "touch";
      cleanup.current?.();
      if (event.isPrimary) suppressClick.current = false;
    };
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      cleanup.current?.();
    };
  }, []);

  function start(
    event: PointerEvent,
    actions: { onTap?: () => void; onLongPress: () => void },
  ) {
    if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0)
      return;
    cleanup.current?.();
    const { pointerId, clientX, clientY, timeStamp } = event;
    const positions = new Map<Element, [number, number]>();
    for (
      let node: Element | null = event.currentTarget;
      node;
      node = node.parentElement
    )
      positions.set(node, [node.scrollLeft, node.scrollTop]);
    const scrollX = window.scrollX,
      scrollY = window.scrollY;
    const stationary = () =>
      window.scrollX === scrollX &&
      window.scrollY === scrollY &&
      [...positions].every(
        ([node, [left, top]]) =>
          node.scrollLeft === left && node.scrollTop === top,
      );
    let held = false;
    const timer = window.setTimeout(() => {
      if (!stationary()) return cancel();
      held = true;
      suppressClick.current = true;
      actions.onLongPress();
    }, 500);
    function stop() {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", cancel);
      cleanup.current = null;
    }
    function cancel() {
      suppressClick.current = true;
      stop();
    }
    function move(next: globalThis.PointerEvent) {
      if (
        next.pointerId !== pointerId ||
        Math.hypot(next.clientX - clientX, next.clientY - clientY) > 8 ||
        !stationary()
      )
        cancel();
    }
    function scroll() {
      if (!stationary()) cancel();
    }
    function up(next: globalThis.PointerEvent) {
      if (next.pointerId !== pointerId) return cancel();
      const tap =
        !held &&
        next.timeStamp - timeStamp < 350 &&
        Math.hypot(next.clientX - clientX, next.clientY - clientY) <= 8 &&
        stationary();
      stop();
      if (tap) actions.onTap?.();
      else suppressClick.current = true;
    }
    cleanup.current = cancel;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", cancel);
  }
  function onClickCapture(event: MouseEvent) {
    if (!suppressClick.current || !event.detail) return;
    event.preventDefault();
    event.stopPropagation();
  }
  return { start, isTouch, onClickCapture };
}
