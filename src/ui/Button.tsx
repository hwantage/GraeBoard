import type { ReactNode, RefObject } from "react";

export function Button({
  children,
  onClick,
  title,
  tooltip,
  disabled = false,
  active = false,
  className = "",
  type = "button",
  ...attributes
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  tooltip?: string;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  type?: "button" | "submit";
  ref?: RefObject<HTMLButtonElement | null>;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
}) {
  return (
    <button
      {...attributes}
      type={type}
      title={tooltip ? undefined : title}
      data-tooltip={tooltip}
      aria-label={tooltip || title}
      disabled={disabled}
      onClick={onClick}
      className={`button ${active ? "active" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
