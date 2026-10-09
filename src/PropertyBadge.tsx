import type { Property } from "./types";
import { propertyOption } from "../shared/domain.js";
function ink(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 155
    ? "#243642"
    : "#ffffff";
}
export default function PropertyBadge({
  property,
  value,
}: {
  property: Property;
  value: string;
}) {
  if (!value) return null;
  const option = propertyOption(property, value);
  const label = option?.label || value;
  const background = option?.backgroundColor || "#edf6f4";
  const display = property.display;
  return (
    <span
      className={`property-badge property-${display}`}
      style={
        display === "emoji"
          ? undefined
          : { backgroundColor: background, color: ink(background) }
      }
    >
      {display === "dot" && (
        <i
          style={{ backgroundColor: option?.dotColor || "#177b70" }}
          aria-hidden="true"
        />
      )}
      {display === "emoji" && (
        <span className="property-emoji" aria-hidden="true">
          {option?.emoji || "📌"}
        </span>
      )}
      <span>{label}</span>
    </span>
  );
}
