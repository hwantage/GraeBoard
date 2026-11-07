import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { usePopover } from "./usePopover";

export type DocumentToolMenuItem = {
  label: string;
  icon: ReactNode;
  tooltip?: string;
  disabled?: boolean;
  run: () => void;
};

// A toolbar button with a small arrow beside it. The button runs the main
// action; the arrow opens related actions. Picking one returns to the text.
// A click keeps the caret in the document; the keyboard moves into the menu.
// Without a main action the button itself opens the menu, and a pick from
// the keyboard returns to it.
export default function DocumentToolMenu({
  label,
  menuLabel,
  icon,
  className,
  disabled,
  onClick,
  items,
}: {
  label: string;
  menuLabel: string;
  icon: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  items: DocumentToolMenuItem[];
}) {
  const { open, setOpen, position, popup, trigger, onKeyDown, container } =
    usePopover(180, false);
  const fromKeyboard = useRef(false);
  useLayoutEffect(() => {
    if (open && fromKeyboard.current)
      popup.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
        ?.focus();
  }, [open]);
  // Esc in the document closes the menu first, as for other editing menus.
  useEffect(() => {
    if (!open) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        popup.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);
  function move(event: KeyboardEvent) {
    const enabled = [
      ...(popup.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      ) ?? []),
    ];
    if (!enabled.length) return;
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % enabled.length
            : event.key === "ArrowUp"
              ? (index - 1 + enabled.length) % enabled.length
              : -1;
    if (next < 0) return;
    event.preventDefault();
    enabled[next].focus();
  }
  const menu = (
    <>
      <button
        ref={trigger}
        type="button"
        className={onClick ? "document-split-arrow" : className}
        disabled={disabled}
        aria-label={onClick ? menuLabel : label}
        data-tooltip={onClick ? menuLabel : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          fromKeyboard.current = event.detail === 0;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (open || event.key !== "ArrowDown") return;
          event.preventDefault();
          fromKeyboard.current = true;
          setOpen(true);
        }}
      >
        {onClick ? <ChevronDown size={12} aria-hidden="true" /> : icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="document-tool-menu"
            role="menu"
            aria-label={menuLabel}
            style={position}
            onKeyDown={(event) => {
              onKeyDown(event);
              move(event);
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                data-tooltip={item.tooltip}
                onClick={() => {
                  if (
                    !onClick &&
                    popup.current?.contains(document.activeElement)
                  )
                    trigger.current?.focus();
                  setOpen(false);
                  item.run();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          container(),
        )}
    </>
  );
  if (!onClick) return menu;
  return (
    <span className="document-split-tool">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        data-tooltip={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {icon}
      </button>
      {menu}
    </span>
  );
}
