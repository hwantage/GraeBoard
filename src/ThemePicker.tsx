import { useId, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { THEMES, themeVariables } from "../shared/themes.js";
import type { ThemeId } from "./types";

export default function ThemePicker({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: ThemeId;
  onChange: (value: ThemeId) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="theme-picker" aria-label={label} disabled={disabled}>
      {THEMES.map((theme) => (
        <label
          key={theme.id}
          className="theme-option"
          style={themeVariables(theme.id) as CSSProperties}
        >
          <input
            type="radio"
            name={name}
            value={theme.id}
            checked={value === theme.id}
            onChange={() => onChange(theme.id)}
          />
          <span className="theme-swatch" aria-hidden="true">
            <Check size={16} strokeWidth={2.5} />
          </span>
          <span>{theme.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
