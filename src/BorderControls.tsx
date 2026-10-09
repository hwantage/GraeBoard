import Select from "./Select";
import type { Border } from "./types";
import { BORDER_OPTIONS, borderCSS } from "../shared/borders.js";

export default function BorderControls({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value?: Border;
  onChange: (border: Border) => void;
  disabled?: boolean;
}) {
  const border = value || { style: "none", color: "#607984" };
  return (
    <fieldset className="border-controls" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        스타일
        <Select
          aria-label={`${label} 스타일`}
          value={border.style}
          onChange={(e) =>
            onChange({ ...border, style: e.target.value as Border["style"] })
          }
        >
          {BORDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      <label>
        색상
        <input
          type="color"
          aria-label={`${label} 색상`}
          value={border.color}
          onChange={(e) => onChange({ ...border, color: e.target.value })}
        />
      </label>
      <span
        className="border-line-preview"
        aria-hidden="true"
        style={{ borderBottom: borderCSS(border) }}
      />
    </fieldset>
  );
}
