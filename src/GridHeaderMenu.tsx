import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type HeaderMenuAction = {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
};

export default function GridHeaderMenu({
  x,
  y,
  title,
  actions,
  children,
  onClose,
  scrollContainer,
}: {
  x: number;
  y: number;
  title: string;
  actions: HeaderMenuAction[];
  children?: ReactNode;
  onClose: (restoreFocus?: boolean) => void;
  scrollContainer?: HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const positionMenu = () => {
      const box = root.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
      });
    };
    positionMenu();
    const resize = new ResizeObserver(positionMenu);
    resize.observe(root.current!);
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
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      resize.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [x, y, scrollContainer]);
  return createPortal(
    <div
      ref={root}
      role={children ? "dialog" : undefined}
      aria-label={title}
      className={`grid-header-menu ${children ? "has-filter" : ""}`}
      style={position}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Tab" && !children)) {
          e.preventDefault();
          onClose(true);
        }
        if (
          e.target instanceof HTMLElement &&
          e.target.getAttribute("role") === "menuitem" &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
        ) {
          e.preventDefault();
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
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
      <div role="menu" aria-label={title} className="grid-header-menu-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            className={action.danger ? "menu-danger" : undefined}
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
      </div>
      {children}
    </div>,
    document.body,
  );
}
