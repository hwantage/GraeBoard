import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { PALETTE } from "../shared/domain.js";
import { usePopover } from "./usePopover";

// 글자 색상·배경색 도구. 브라우저 색상 선택기는 이미 고른 색을 다시 고르면
// 변경을 알리지 않으므로(macOS는 색상 창이 마지막 색으로 열려 있다), 팔레트의
// 색은 누를 때마다 지금 선택한 셀에 적용한다. 팔레트에 없는 색만 브라우저
// 선택기로 고른다.
export default function ColorMenu({
  label,
  icon,
  value,
  disabled,
  onApply,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  disabled: boolean;
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
        className={`color-tool ${disabled ? "disabled" : ""}`}
        data-tooltip={label}
        aria-label={label}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="color-tool-icon" aria-hidden="true">
          {icon}
        </span>
        <span
          className="color-tool-swatch"
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
          >
            <div
              className="color-palette"
              role="group"
              aria-label={`${label} 팔레트`}
              // WebKit otherwise focuses the parent dialog before the click,
              // which dismisses this popup before its action can run.
              onMouseDown={(e) => e.preventDefault()}
            >
              {PALETTE.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="color-option"
                  style={{ backgroundColor: color }}
                  aria-label={color}
                  aria-pressed={color === value.toLowerCase()}
                  onClick={() => {
                    onApply(color);
                    close();
                  }}
                />
              ))}
            </div>
            <label className="color-custom">
              다른 색
              <input
                type="color"
                aria-label={`${label} 직접 선택`}
                value={value}
                onChange={(e) => onApply(e.target.value)}
              />
            </label>
          </div>,
          container(),
        )}
    </>
  );
}
