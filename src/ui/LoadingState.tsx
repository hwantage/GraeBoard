import type { ReactNode } from "react";
import { GraeLoading } from "./Brand";

export default function LoadingState({
  label,
  children,
  showLabel = true,
  className = "",
}: {
  label: string;
  children?: ReactNode;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`loading-state ${className}`}
      role="status"
      aria-label={label}
    >
      {children ?? <GraeLoading />}
      {showLabel && <span aria-hidden="true">{label}</span>}
    </span>
  );
}
