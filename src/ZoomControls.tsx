import { useEffect, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

export default function ZoomControls({
  value,
  onChange,
  presentation = false,
}: {
  value: number;
  onChange: (value: number) => void;
  presentation?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function apply(next: number) {
    const zoom = Number.isFinite(next)
      ? Math.max(50, Math.min(200, Math.round(next)))
      : value;
    setText(String(zoom));
    onChange(zoom);
  }
  const buttonClass = presentation ? "presentation-tool" : "button";
  return (
    <div
      className={`zoom-controls ${presentation ? "presentation-tool-group presentation-zoom" : "toolbar-group"}`}
      role="group"
      aria-label="확대와 축소"
    >
      <button
        type="button"
        className={buttonClass}
        title="축소"
        aria-label="축소"
        disabled={value <= 50}
        onClick={() => apply(value - 25)}
      >
        <ZoomOut size={16} />
      </button>
      <label className="zoom-value">
        <input
          type="number"
          aria-label="확대율"
          title="확대율 (50~200%)"
          min={50}
          max={200}
          step={1}
          value={text}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) =>
            apply(
              event.target.value === "" ? value : Number(event.target.value),
            )
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape")
              event.currentTarget.value = String(value);
            event.currentTarget.blur();
          }}
        />
        <span aria-hidden="true">%</span>
      </label>
      <button
        type="button"
        className={buttonClass}
        title="확대"
        aria-label="확대"
        disabled={value >= 200}
        onClick={() => apply(value + 25)}
      >
        <ZoomIn size={16} />
      </button>
      <button
        type="button"
        className={buttonClass}
        title="원래대로 (100%)"
        aria-label="원래대로"
        disabled={value === 100}
        onClick={() => apply(100)}
      >
        <RotateCcw size={16} />
        {presentation && <span>원래대로</span>}
      </button>
    </div>
  );
}
