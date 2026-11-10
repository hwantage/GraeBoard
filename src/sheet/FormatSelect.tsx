import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

// Formatting is an action: choosing the current value must also format mixed ranges.
export default function FormatSelect({
  label,
  value,
  options,
  disabled,
  onSelect,
  className = "",
  iconOnly = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; icon?: ReactNode }[];
  disabled?: boolean;
  onSelect: (value: string) => void;
  className?: string;
  iconOnly?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  function show() {
    trigger.current?.focus({ preventScroll: true });
    setActive(selected);
    setOpen(true);
  }
  function choose(index: number) {
    onSelect(options[index].value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(
        iconOnly ? options.length * 34 + 14 : Math.max(rect.width, 116),
        window.innerWidth - 16,
      );
      const height = iconOnly ? 46 : Math.min(options.length * 34 + 12, 280);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < height && above > below;
      const maxHeight = Math.min(height, upwards ? above : below);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? rect.top - maxHeight - 4 : rect.bottom + 4,
        width,
        maxHeight,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length, iconOnly]);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) {
      const target = event.target as Node;
      if (
        !trigger.current?.contains(target) &&
        !popup.current?.contains(target)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (open)
      popup.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select-control format-select ${iconOnly ? "format-select-icons" : ""} ${className}`.trim()}
        role="combobox"
        aria-label={label}
        data-tooltip={iconOnly ? `${label}: ${options[selected].label}` : label}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (
            [
              "ArrowDown",
              "ArrowUp",
              "Home",
              "End",
              ...(iconOnly ? ["ArrowLeft", "ArrowRight"] : []),
            ].includes(e.key)
          ) {
            e.preventDefault();
            if (!open) show();
            else
              setActive((current) =>
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? options.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          options.length - 1,
                          current +
                            (["ArrowDown", "ArrowRight"].includes(e.key)
                              ? 1
                              : -1),
                        ),
                      ),
              );
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) choose(active);
            else show();
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Tab") setOpen(false);
        }}
      >
        {iconOnly ? options[selected].icon : options[selected].label}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={label}
            aria-orientation={iconOnly ? "horizontal" : "vertical"}
            className={`cell-option-popup format-select-popup ${iconOnly ? "format-icon-popup" : ""}`}
            style={position}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${id}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                className={`cell-option ${index === active ? "format-option-active" : ""}`}
                aria-selected={value === option.value}
                aria-label={option.label}
                data-tooltip={option.label}
                data-value={option.value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(index)}
              >
                {iconOnly ? option.icon : <span>{option.label}</span>}
                {!iconOnly && value === option.value && <Check size={14} />}
              </button>
            ))}
          </div>,
          trigger.current?.closest("dialog") || document.body,
        )}
    </>
  );
}
