import { GraeLoading } from "./Brand";

export default function LoadingState({
  label,
  showLabel = true,
  className = "",
}: {
  label: string;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`loading-state ${className}`}
      role="status"
      aria-label={label}
    >
      <GraeLoading />
      {showLabel && <span aria-hidden="true">{label}</span>}
    </span>
  );
}
