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
  const panel = useRef<DocumentPanelHandle>(null);
  const contentId = useId();
  const ToggleIcon = opened ? ChevronUp : ChevronDown;
  useImperativeHandle(ref, () => ({
    flush: async () => (await panel.current?.flush()) ?? true,
    persistDraft: () => panel.current?.persistDraft() ?? true,
    selectDocument: async (id) =>
      (await panel.current?.selectDocument(id)) ?? false,
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
      <h3 className="memo-accordion-heading">
        <Button
          className="toggle-memos"
          aria-expanded={opened}
          aria-controls={contentId}
          disabled={closing}
          onClick={() => void toggle()}
        >
          <FileText size={17} aria-hidden="true" />
          꼬리 메모
          <ToggleIcon
            size={18}
            strokeWidth={2.5}
            className="memo-accordion-icon"
            aria-hidden="true"
          />
        </Button>
      </h3>
      <div id={contentId} hidden={!opened}>
        {opened && (
          <DocumentPanel
            ref={panel}
            inline
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
