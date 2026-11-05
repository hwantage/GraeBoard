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
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  disabled?: boolean;
  compact?: boolean;
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
              // WebKit can focus the surrounding modal before a button click.
              if ((event.target as Element).closest("button"))
                event.preventDefault();
            }}
          >
            <ColorPicker
              label={label}
              value={value}
              onApply={(color) => {
                onApply(color);
                close();
              }}
              onCancel={close}
            />
          </div>,
          container(),
        )}
    </>
  );
}
