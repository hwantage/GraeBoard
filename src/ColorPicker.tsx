import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PALETTE } from "../shared/domain.js";
import { hexToHSV, hsvToHex, normalizeHex, type HSV } from "./color";
import { useRecentColors } from "./recent-colors";
import { trackPointerDrag, type PointerPosition } from "./trackPointerDrag";

const clamp = (value: number) => Math.max(0, Math.min(1, value));

// Dragging only changes this picker's draft. All callers commit through apply.
export default function ColorPicker({
  label,
  value,
  onApply,
  onCancel,
}: {
  label: string;
  value: string;
  onApply: (color: string) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState(false);
  const [hex, setHex] = useState(value);
  const [hsv, setHSV] = useState(() => hexToHSV(value));
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<(() => void) | null>(null);
  const recent = useRecentColors();
  const color = normalizeHex(hex);
  useLayoutEffect(() => {
    if (custom) {
      input.current?.focus();
      input.current?.select();
    }
  }, [custom]);
  useEffect(() => () => drag.current?.(), []);
  function preview(next: HSV) {
    setHSV(next);
    setHex(hsvToHex(next));
  }
  function apply(color: string) {
    recent.add(color);
    onApply(color);
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>, hue = false) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    const rect = target.getBoundingClientRect();
    const next = (position: PointerPosition) => {
      const x = clamp((position.clientX - rect.left) / rect.width);
      preview(
        hue
          ? { ...hsv, h: x * 359 }
          : {
              ...hsv,
              s: x,
              v: 1 - clamp((position.clientY - rect.top) / rect.height),
            },
      );
    };
    next(event);
    target.setPointerCapture(event.pointerId);
    drag.current = trackPointerDrag(event, {
      captureTarget: target,
      onMove: next,
      onEnd: (position, cancelled) => {
        drag.current = null;
        if (cancelled) onCancel();
        else next(position);
      },
    });
  }
  if (!custom)
    return (
      <>
        <div
          className="color-palette"
          role="group"
          aria-label={`${label} 팔레트`}
          onMouseDown={(event) => event.preventDefault()}
        >
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className="color-option"
              style={{ backgroundColor: color }}
              aria-label={color}
              aria-pressed={color === value.toLowerCase()}
              onClick={() => apply(color)}
            />
          ))}
        </div>
        {recent.colors.length > 0 && (
          <div className="color-recent" role="group" aria-label="최근 사용">
            <span>최근 사용</span>
            <div
              className="color-palette"
              onMouseDown={(event) => event.preventDefault()}
            >
              {recent.colors.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="color-option"
                  style={{ backgroundColor: color }}
                  aria-label={`최근 색 ${color}`}
                  aria-pressed={color === value.toLowerCase()}
                  onClick={() => apply(color)}
                />
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          className="button color-custom"
          onClick={() => setCustom(true)}
        >
          다른 색
        </button>
      </>
    );
  return (
    <div
      className="color-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (color) apply(color);
        }
      }}
    >
      <div
        className="color-saturation"
        role="slider"
        tabIndex={0}
        aria-label="채도와 명도"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`채도 ${Math.round(hsv.s * 100)}%, 명도 ${Math.round(hsv.v * 100)}%`}
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        onPointerDown={(event) => startDrag(event)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.01;
          const changes: Record<string, Partial<HSV>> = {
            ArrowLeft: { s: clamp(hsv.s - step) },
            ArrowRight: { s: clamp(hsv.s + step) },
            ArrowUp: { v: clamp(hsv.v + step) },
            ArrowDown: { v: clamp(hsv.v - step) },
            Home: { s: 0 },
            End: { s: 1 },
          };
          if (changes[event.key]) {
            event.preventDefault();
            preview({ ...hsv, ...changes[event.key] });
          }
        }}
      >
        <span
          className="color-picker-thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div
        className="color-hue"
        role="slider"
        tabIndex={0}
        aria-label="색상"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        onPointerDown={(event) => startDrag(event, true)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          const values: Record<string, number> = {
            ArrowLeft: hsv.h - step,
            ArrowDown: hsv.h - step,
            ArrowRight: hsv.h + step,
            ArrowUp: hsv.h + step,
            Home: 0,
            End: 359,
          };
          if (event.key in values) {
            event.preventDefault();
            preview({
              ...hsv,
              h: Math.max(0, Math.min(359, values[event.key])),
            });
          }
        }}
      >
        <span
          className="color-picker-thumb"
          style={{ left: `${(hsv.h / 359) * 100}%` }}
        />
      </div>
      <label className="color-hex">
        HEX
        <input
          ref={input}
          aria-label="HEX"
          value={hex}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!color}
          aria-describedby={!color ? errorId : undefined}
          onChange={(event) => {
            setHex(event.target.value);
            const next = normalizeHex(event.target.value);
            if (next) setHSV(hexToHSV(next));
          }}
        />
        <span
          className="color-preview"
          aria-label="색상 미리보기"
          style={{ backgroundColor: color || hsvToHex(hsv) }}
        />
      </label>
      {!color && (
        <small id={errorId} role="alert">
          올바른 HEX 색상을 입력하세요.
        </small>
      )}
      <div className="color-picker-actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!color}
          onClick={() => color && apply(color)}
        >
          확인
        </button>
      </div>
    </div>
  );
}
