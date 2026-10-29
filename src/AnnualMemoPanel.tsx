import {
  forwardRef,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, FileText } from "lucide-react";
import { Button } from "./components";
import DocumentPanel, { type DocumentPanelHandle } from "./DocumentPanel";

export default forwardRef<
  DocumentPanelHandle,
  {
    teamId: string;
    year: number;
    userId: string;
    readOnly: boolean;
    reportId?: string;
  }
>(function AnnualMemoPanel({ teamId, year, userId, readOnly, reportId }, ref) {
  const storageKey = `weekly-plan:memo-open:${userId}:${teamId}:${reportId || year}`;
  const [opened, setOpened] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });
  const [closing, setClosing] = useState(false);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const draggingScroll = useRef(false);
  const panel = useRef<DocumentPanelHandle>(null);
  const scrollOnOpen = useRef(false);
  const contentId = useId();
  const ToggleIcon = opened ? ChevronUp : ChevronDown;
  useImperativeHandle(ref, () => ({
    flush: async () => (await panel.current?.flush()) ?? true,
    persistDraft: () => panel.current?.persistDraft() ?? true,
    selectDocument: async (id) =>
      (await panel.current?.selectDocument(id)) ?? false,
    scrollToRatio: (ratio) => panel.current?.scrollToRatio(ratio),
  }));
  function rememberOpened(next: boolean) {
    setOpened(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Keep the accordion usable when browser storage is unavailable.
    }
  }
  async function toggle() {
    if (closing) return;
    if (!opened) {
      scrollOnOpen.current = true;
      rememberOpened(true);
      return;
    }
    setClosing(true);
    try {
      if (await panel.current?.flush()) rememberOpened(false);
    } finally {
      setClosing(false);
    }
  }
  return (
    <section className="annual-memos" aria-label="연간 업무 메모 목록">
      <div
        className="memo-accordion-heading"
        onClick={(event) => {
          if (event.target === event.currentTarget) void toggle();
        }}
      >
        <Button
          className="toggle-memos"
          aria-expanded={opened}
          aria-controls={contentId}
          disabled={closing}
          onClick={() => void toggle()}
        >
          <FileText size={14} aria-hidden="true" />
          꼬리 메모
          <ToggleIcon
            size={16}
            strokeWidth={2.5}
            className="memo-accordion-icon"
            aria-hidden="true"
          />
        </Button>
        {opened && (
          <div
            className="memo-scroll-slider"
            role="scrollbar"
            aria-label="꼬리 메모 좌우 스크롤"
            aria-controls={contentId}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(scrollRatio * 100)}
            aria-disabled={!scrollable}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0 || !scrollable) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingScroll.current = true;
              const box = event.currentTarget.getBoundingClientRect();
              panel.current?.scrollToRatio(
                (event.clientX - box.left) / box.width,
              );
            }}
            onPointerMove={(event) => {
              if (!draggingScroll.current) return;
              const box = event.currentTarget.getBoundingClientRect();
              panel.current?.scrollToRatio(
                (event.clientX - box.left) / box.width,
              );
            }}
            onPointerUp={(event) => {
              draggingScroll.current = false;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
              draggingScroll.current = false;
            }}
            onKeyDown={(event) => {
              const ratio =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? scrollRatio - 0.1
                      : event.key === "ArrowRight"
                        ? scrollRatio + 0.1
                        : null;
              if (ratio === null) return;
              event.preventDefault();
              event.stopPropagation();
              panel.current?.scrollToRatio(ratio);
            }}
          >
            <span
              className="memo-scroll-thumb"
              style={{ left: `${scrollRatio * 80}%` }}
            />
            <span>드래그하여 좌우 스크롤</span>
          </div>
        )}
      </div>
      <div id={contentId} hidden={!opened}>
        {opened && (
          <DocumentPanel
            ref={panel}
            inline
            scrollOnOpen={scrollOnOpen.current}
            onScrollRatioChange={(ratio, available) => {
              setScrollRatio(ratio);
              setScrollable(available);
            }}
            label="연간 업무 메모"
            path={
              reportId
                ? `/reports/${reportId}/memos`
                : `/teams/${teamId}/years/${year}/memos`
            }
            draftKey={(id) =>
              `weekly-plan:memo:${userId}:${teamId}:${reportId || year}:${id}`
            }
            readOnly={readOnly}
            onSaved={() => {}}
            onListChanged={() => {}}
            onLoadingChange={() => {}}
          />
        )}
      </div>
    </section>
  );
});
