import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type HeaderMenuAction = {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  run: () => void;
};

export default function GridHeaderMenu({
  x,
  y,
  title,
  actions,
  onClose,
  scrollContainer,
}: {
  x: number;
  y: number;
  title: string;
  actions: HeaderMenuAction[];
  onClose: (restoreFocus?: boolean) => void;
  scrollContainer?: HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const box = root.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    });
    root.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close.current();
    };
    const dismiss = () => close.current();
    // Ignore a scroll event queued before opening; only a new movement closes it.
    const scrollPositions = new Map<EventTarget, [number, number]>([
      [document, [window.scrollX, window.scrollY]],
      [window, [window.scrollX, window.scrollY]],
    ]);
    for (
      let element = scrollContainer;
      element;
      element = element.parentElement
    )
      scrollPositions.set(element, [element.scrollLeft, element.scrollTop]);
    const scroll = (event: Event) => {
      const target = event.target;
      if (!target) return;
      const current =
        target instanceof Element
          ? [target.scrollLeft, target.scrollTop]
          : [window.scrollX, window.scrollY];
      const previous = scrollPositions.get(target);
      if (previous && previous[0] === current[0] && previous[1] === current[1])
        return;
      outside(event);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [x, y, scrollContainer]);
  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={title}
      className="grid-header-menu"
      style={position}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose(true);
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      <div className="grid-header-menu-title">{title}</div>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={() => {
            action.run();
            onClose(true);
          }}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
