import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { Cell, Property } from "./types";
import type { EditMove } from "./InlineCellEditor";
import PropertyBadge from "./PropertyBadge";

export default function CellOptionPicker({
  label,
  options,
  property,
  value,
  multiple,
  selectedLabels,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string;
  options: { value: string; label: string }[];
  property?: Property;
  value: Cell["value"];
  multiple: boolean;
  selectedLabels?: Record<string, string>;
  onChange: (value: Cell["value"]) => void;
  onCommit: (move?: EditMove) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 240,
    maxHeight: 280,
  });
  const actions = useRef({ onCommit, onCancel, multiple });
  actions.current = { onCommit, onCancel, multiple };
  const selected = Array.isArray(value)
    ? value
    : value === ""
      ? []
      : [String(value)];
  const entries = multiple
    ? options
    : [{ value: "", label: "선택 안 함" }, ...options];
  const text = selected
    .map(
      (v) =>
        options.find((o) => o.value === v)?.label || selectedLabels?.[v] || v,
    )
    .join(", ");
  function close() {
    const current = actions.current;
    if (current.multiple) current.onCommit();
    else current.onCancel();
  }
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current
        ?.closest(".sheet-cell")
        ?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(
        Math.max(rect.width, 240),
        360,
        window.innerWidth - 16,
      );
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const flipped = below < 120 && above > below;
      const maxHeight = Math.min(280, Math.max(80, flipped ? above : below));
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flipped ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
        width,
        maxHeight,
      });
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        close();
    };
    place();
    const frame = requestAnimationFrame(place);
    const selectedOption = popup.current?.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]',
    );
    (
      selectedOption ||
      popup.current?.querySelector<HTMLButtonElement>('[role="option"]')
    )?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, []);
  return (
    <>
      <button
        ref={anchor}
        className="cell-choice-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded="true"
        aria-controls={id}
        onClick={close}
      >
        {property && value ? (
          <PropertyBadge property={property} value={String(value)} />
        ) : (
          <span>{text}</span>
        )}
      </button>
      {createPortal(
        <div
          ref={popup}
          id={id}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple || undefined}
          className="cell-option-popup"
          style={position}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onBlur={(e) => {
            if (
              e.relatedTarget instanceof Node &&
              !e.currentTarget.contains(e.relatedTarget) &&
              !anchor.current?.contains(e.relatedTarget)
            )
              close();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Tab") {
              e.preventDefault();
              onCommit(e.shiftKey ? "previous" : "next");
            } else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
            ) {
              e.preventDefault();
              const buttons = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="option"]',
                ),
              ];
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? buttons.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          buttons.length - 1,
                          current + (e.key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              buttons[next]?.focus({ preventScroll: true });
              buttons[next]?.scrollIntoView({ block: "nearest" });
            }
          }}
        >
          {multiple &&
            selected
              .filter((v) => !options.some((o) => o.value === v))
              .map((v) => (
                <div className="former-member-selection" key={v}>
                  <span>
                    {selectedLabels?.[v] || v}
                    <small>이전 팀원</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`${selectedLabels?.[v] || v} 선택 해제`}
                    onClick={() => onChange(selected.filter((id) => id !== v))}
                  >
                    해제
                  </button>
                </div>
              ))}
          {entries.map((option) => {
            const checked =
              option.value === ""
                ? !selected.length
                : selected.includes(option.value);
            return (
              <button
                key={option.value}
                role="option"
                aria-selected={checked}
                className="cell-option"
                tabIndex={-1}
                onClick={() => {
                  onChange(
                    multiple
                      ? checked
                        ? selected.filter((v) => v !== option.value)
                        : [...selected, option.value]
                      : option.value,
                  );
                  if (!multiple) onCommit();
                }}
              >
                {property && option.value ? (
                  <PropertyBadge property={property} value={option.value} />
                ) : (
                  <span>{option.label}</span>
                )}
                {checked && <Check size={15} aria-hidden="true" />}
              </button>
            );
          })}
          {!entries.length && (
            <p className="cell-options-empty">선택할 항목이 없습니다.</p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
