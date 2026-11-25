import { ErrorNote } from "../ui/ErrorNote";
import LoadingState from "../ui/LoadingState";
import "./slide-loading-state.css";

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

// The slides screen before it is ready: its code or the team's files are
// loading, or `error` says why they could not be.
export function SlidesLoadingBoard({ error }: { error: string }) {
  return (
    <section className="board slides-board">
      <ErrorNote error={error} />
      {!error && <SlideLoadingState label="CanvaSlide를 불러오는 중입니다." />}
    </section>
  );
}
