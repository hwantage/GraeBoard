import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// One delegated tooltip for period controls and formatting toolbars, including dialogs.
export default function Tooltip() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const text = target?.dataset.tooltip;
  useEffect(() => {
    const find = (node: EventTarget | null) =>
      node instanceof Element
        ? node.closest<HTMLElement>("[data-tooltip]")
        : null;
    const show = (event: Event) => {
      if (
        event instanceof PointerEvent &&
        (event.pointerType === "touch" || event.buttons)
      )
        return;
      const next = find(event.target);
      setTarget(next?.dataset.tooltip ? next : null);
    };
    const leave = (event: Event) => {
      const next = find((event as FocusEvent).relatedTarget);
      setTarget(next?.dataset.tooltip ? next : null);
    };
    const hide = () => setTarget(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerover", show, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", show, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", show, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", show, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  useLayoutEffect(() => {
    if (!target || !text || !popup.current) return;
    const box = target.getBoundingClientRect();
    const tip = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(
          box.left + (box.width - tip.width) / 2,
          window.innerWidth - tip.width - 8,
        ),
      ),
      top:
        box.bottom + tip.height + 16 <= window.innerHeight
          ? box.bottom + 6
          : Math.max(8, box.top - tip.height - 6),
    });
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute(
      "aria-describedby",
      [previous, id].filter(Boolean).join(" "),
    );
    return () => {
      if (previous) target.setAttribute("aria-describedby", previous);
      else target.removeAttribute("aria-describedby");
    };
  }, [target, text, id]);
  if (!target?.isConnected || !text) return null;
  return createPortal(
    <div
      ref={popup}
      id={id}
      role="tooltip"
      className="instant-tooltip"
      style={position}
    >
      {text}
    </div>,
    target.closest("dialog[open]") || document.body,
  );
}
