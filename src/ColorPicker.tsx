import { useEffect, useId, useRef, useState } from "react";
import { PALETTE } from "../shared/domain.js";
import { normalizeHex } from "./color";
import { useRecentColors } from "./recent-colors";

// "Other color" keeps the browser's own picker. It only previews while open
// and applies once on its native change event, so a drag no longer saves
// every color it passes. The HEX field beside it is visible from the start.
export default function ColorPicker({
  label,
  value,
  onApply,
}: {
  label: string;
  value: string;
  onApply: (color: string) => void;
}) {
  const [hex, setHex] = useState(() => normalizeHex(value) || "");
  const errorId = useId();
  const native = useRef<HTMLInputElement>(null);
  const recent = useRecentColors();
  const color = normalizeHex(hex);
  const invalid = !!hex.trim() && !color;
  function apply(color: string) {
    recent.add(color);
    onApply(color);
  }
  const latestApply = useRef(apply);
  latestApply.current = apply;
  useEffect(() => {
    const input = native.current!;
    // React's onChange follows "input"; the native "change" fires once when
    // the browser picker confirms the color.
    const changed = () => {
      const next = normalizeHex(input.value);
      if (next) latestApply.current(next);
    };
    input.addEventListener("change", changed);
    return () => input.removeEventListener("change", changed);
  }, []);
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
      <div className="color-custom">
        <span>다른 색</span>
        <input
          className="color-hex-input"
          aria-label={`${label} HEX`}
          value={hex}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setHex(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (color) apply(color);
          }}
        />
        <input
          ref={native}
          type="color"
          aria-label={`${label} 직접 선택`}
          value={color || normalizeHex(value) || "#000000"}
          onChange={(event) => setHex(event.target.value)}
        />
      </div>
      {invalid && (
        <small id={errorId} className="color-error" role="alert">
          올바른 HEX 색상을 입력하세요.
        </small>
      )}
    </>
  );
}
