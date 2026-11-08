export type PointerPosition = Pick<PointerEvent, "clientX" | "clientY">;

/**
 * Shared pointer lifecycle for drags started with the primary button.
 * The caller owns the activation threshold, hit testing and capture timing;
 * this tracker releases capture and calls onEnd exactly once.
 * Return value cancels the gesture, including on unmount or scope changes.
 */
export function trackPointerDrag(
  start: PointerPosition & Pick<PointerEvent, "pointerId">,
  {
    captureTarget,
    onMove,
    onEnd,
  }: {
    captureTarget?: Element;
    onMove: (event: PointerEvent) => void;
    onEnd: (position: PointerPosition, cancelled: boolean) => void;
  },
) {
  const pointerId = start.pointerId;
  let pressed: PointerPosition = {
    clientX: start.clientX,
    clientY: start.clientY,
  };
  let ended = false;
  const end = (position: PointerPosition, cancelled: boolean) => {
    if (ended) return;
    ended = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", cancelPointer, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", escape, true);
    if (captureTarget?.hasPointerCapture(pointerId))
      captureTarget.releasePointerCapture(pointerId);
    onEnd(position, cancelled);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) {
      // Brave can lose capture and report a released-button move before up.
      // Commit the last pressed position: this move may already be a hover.
      // Also handles primary release while a secondary button remains held.
      end(pressed, false);
      return;
    }
    pressed = { clientX: event.clientX, clientY: event.clientY };
    onMove(event);
  };
  const finish = (event: PointerEvent) => {
    if (event.pointerId === pointerId)
      // A quick release can arrive without a final pointermove.
      end({ clientX: event.clientX, clientY: event.clientY }, false);
  };
  const cancel = () => end(pressed, true);
  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  // Capture loss (including transfer between elements) is not cancellation.
  // Window listeners keep tracking until release or an actual interruption.
  window.addEventListener("pointermove", move, {
    capture: true,
    passive: false,
  });
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", cancelPointer, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", escape, true);
  return cancel;
}
