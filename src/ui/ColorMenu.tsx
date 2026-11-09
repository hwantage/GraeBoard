import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import ColorPicker from "./ColorPicker";
import { usePopover } from "./usePopover";

export default function ColorMenu({
  label,
  icon,
  value,
  disabled,
  onApply,
  compact = false,
  presets,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  disabled?: boolean;
  compact?: boolean;
  presets?: { color: string; name?: string }[];
  onApply: (color: string) => void;
}) {
  const {
    open,
    setOpen,
    position,
    popup,
    trigger,
    close,
    onKeyDown,
    container,
  } = usePopover(212);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={
          compact ? "color-input" : `color-tool ${disabled ? "disabled" : ""}`
        }
        data-tooltip={label}
        aria-label={label}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {!compact && (
          <span className="color-tool-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span
          className={compact ? "color-input-swatch" : "color-tool-swatch"}
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="color-popover"
            style={position}
            role="dialog"
            aria-label={label}
            onKeyDown={onKeyDown}
            onMouseDown={(event) => {
              // WebKit focuses the surrounding modal when a non-input part of
              // the popup is pressed, which reads as an outside focus.
              if (!(event.target instanceof HTMLInputElement))
                event.preventDefault();
            }}
          >
            <ColorPicker
              presets={presets}
              label={label}
              value={value}
              onApply={(color) => {
                onApply(color);
                close();
              }}
            />
          </div>,
          container(),
        )}
    </>
  );
}
