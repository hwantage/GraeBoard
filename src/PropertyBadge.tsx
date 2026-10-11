import type { Property } from "./types";
import { propertyOption } from "../shared/domain.js";
import { inkFor } from "./color";
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
          : { backgroundColor: background, color: inkFor(background) }
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
