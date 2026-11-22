import LoadingState from "../ui/LoadingState";

export default function SlideLoadingState({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <LoadingState label={label} className={className}>
      <span className="slide-loading-ray" aria-hidden="true">
        <span />
      </span>
    </LoadingState>
  );
}
