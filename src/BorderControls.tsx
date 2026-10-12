import Select from "./Select";
import type { Border } from "./types";
import { BORDER_OPTIONS, borderCSS } from "../shared/borders.js";

export default function BorderControls({
  label,
  value,
  onChange,
  allowNone = false,
  defaultSelected = false,
  onDefault,
}: {
  label: string;
  value?: Border;
  onChange: (border: Border) => void;
  allowNone?: boolean;
  defaultSelected?: boolean;
  onDefault?: () => void;
}) {
  const border: Border = value || {
    style: allowNone ? "none" : "solid",
    color: "#607984",
  };
  return (
    <fieldset className="border-controls">
      <legend>{label}</legend>
      <label>
        스타일
        <Select
          aria-label={`${label} 스타일`}
          value={defaultSelected ? "default" : border.style}
          onChange={(e) => {
            if (e.target.value === "default") onDefault?.();
            else
              onChange({ ...border, style: e.target.value as Border["style"] });
          }}
        >
          {onDefault && <option value="default">기본 테두리</option>}
          {BORDER_OPTIONS.filter((o) => allowNone || o.value !== "none").map(
            (option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </Select>
      </label>
      <label>
        색상
        <input
          type="color"
          aria-label={`${label} 색상`}
          value={defaultSelected ? "#e7eded" : border.color}
          disabled={defaultSelected}
          onChange={(e) => onChange({ ...border, color: e.target.value })}
        />
      </label>
      <span
        className="border-line-preview"
        aria-hidden="true"
        style={{
          borderBottom: defaultSelected
            ? "1px solid #e7eded"
            : borderCSS(border),
        }}
      />
    </fieldset>
  );
}
