import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChevronDown, ChevronUp, FileText } from "lucide-react";
import { Button } from "./components";
import DocumentPanel, { type DocumentPanelHandle } from "./DocumentPanel";

// The open accordion is a panel pinned under the table. A height the user
// sets is kept per user and sheet; otherwise CSS gives it about a memo card's
// height. Either way the table keeps its header and a few rows (styles in
// task-document.css use the same limits).
const MIN_HEIGHT = 200;
const TABLE_ROOM = 120;
const panelLimit = (grid: HTMLElement) =>
  Math.max(MIN_HEIGHT, grid.clientHeight - TABLE_ROOM);

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
  const heightKey = `weekly-plan:memo-height:${userId}:${teamId}:${reportId || year}`;
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(heightKey));
      return saved >= MIN_HEIGHT ? saved : null;
    } catch {
      return null;
    }
  });
  const currentHeight = useRef(height);
  // The rendered height and its limit, for the separator's value only.
  const [measured, setMeasured] = useState({ height: 0, max: MIN_HEIGHT });
  const resize = useRef<{
    y: number;
    height: number;
    previous: number | null;
    scale: number;
  } | null>(null);
  const [closing, setClosing] = useState(false);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const draggingScroll = useRef(false);
  const panel = useRef<DocumentPanelHandle>(null);
  const section = useRef<HTMLElement>(null);
  const contentId = useId();
  const ToggleIcon = opened ? ChevronUp : ChevronDown;
  useImperativeHandle(ref, () => ({
    flush: async () => (await panel.current?.flush()) ?? true,
    persistDraft: () => panel.current?.persistDraft() ?? true,
    selectDocument: async (id) =>
      (await panel.current?.selectDocument(id)) ?? false,
    scrollToRatio: (ratio) => panel.current?.scrollToRatio(ratio),
  }));
  useLayoutEffect(() => {
    const element = section.current;
    const grid = element?.parentElement;
    if (!opened || !element || !grid) return;
    const update = () =>
      setMeasured({ height: element.offsetHeight, max: panelLimit(grid) });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(grid);
    update();
    return () => observer.disconnect();
  }, [opened]);
  function updateHeight(value: number | null, save = false) {
    const grid = section.current?.parentElement;
    const next =
      value === null || !grid
        ? null
        : Math.max(MIN_HEIGHT, Math.min(panelLimit(grid), Math.round(value)));
    currentHeight.current = next;
    setHeight(next);
    if (save && next !== null) {
      try {
        localStorage.setItem(heightKey, String(next));
      } catch {
        /* retain this session's height */
      }
    }
  }
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
    <section
      ref={section}
      className="annual-memos"
      aria-label="연간 업무 메모 목록"
      data-collapsed={!opened || undefined}
      style={
        opened && height !== null
          ? ({ "--memo-panel-height": `${height}px` } as CSSProperties)
          : undefined
      }
    >
      {opened && (
        <div
          className="memo-height-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="꼬리 메모 높이"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={measured.max}
          aria-valuenow={measured.height}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            const panelBox = section.current!;
            const box = panelBox.getBoundingClientRect();
            resize.current = {
              y: event.clientY,
              height: panelBox.offsetHeight,
              previous: height,
              scale: box.height / panelBox.offsetHeight || 1,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = resize.current;
            if (drag)
              updateHeight(drag.height - (event.clientY - drag.y) / drag.scale);
          }}
          onPointerUp={(event) => {
            if (!resize.current) return;
            resize.current = null;
            updateHeight(currentHeight.current, true);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            if (resize.current) updateHeight(resize.current.previous);
            resize.current = null;
          }}
          onPointerCancel={() => {
            if (resize.current) updateHeight(resize.current.previous);
            resize.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && resize.current) {
              event.preventDefault();
              event.stopPropagation();
              updateHeight(resize.current.previous);
              resize.current = null;
              return;
            }
            const delta = event.shiftKey ? 100 : 20;
            const shown = section.current!.offsetHeight;
            const value =
              event.key === "ArrowUp"
                ? shown + delta
                : event.key === "ArrowDown"
                  ? shown - delta
                  : event.key === "Home"
                    ? MIN_HEIGHT
                    : event.key === "End"
                      ? Infinity
                      : null;
            if (value === null) return;
            event.preventDefault();
            event.stopPropagation();
            updateHeight(value, true);
          }}
        />
      )}
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
      <div id={contentId} className="memo-panel-content" hidden={!opened}>
        {opened && (
          <DocumentPanel
            ref={panel}
            inline
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
