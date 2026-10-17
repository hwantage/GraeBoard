import LoadingState from "./LoadingState";

export default function DocumentLoading({
  className = "",
}: {
  className?: string;
}) {
  return (
    <LoadingState
      className={`document-loading ${className}`}
      label="문서 불러오는 중"
      showLabel={false}
    />
  );
}
