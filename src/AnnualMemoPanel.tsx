import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { FileText } from "lucide-react";
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
  const [opened, setOpened] = useState(false);
  const [closing, setClosing] = useState(false);
  const panel = useRef<DocumentPanelHandle>(null);
  useImperativeHandle(ref, () => ({
    flush: async () => (await panel.current?.flush()) ?? true,
    persistDraft: () => panel.current?.persistDraft() ?? true,
    selectDocument: async (id) =>
      (await panel.current?.selectDocument(id)) ?? false,
  }));
  async function toggle() {
    if (closing) return;
    if (!opened) {
      setOpened(true);
      return;
    }
    setClosing(true);
    try {
      if (await panel.current?.flush()) setOpened(false);
    } finally {
      setClosing(false);
    }
  }
  const controls = (
    <Button
      className="toggle-memos"
      aria-expanded={opened}
      disabled={closing}
      onClick={() => void toggle()}
    >
      <FileText size={17} />
      {opened ? "꼬리 메모 닫기" : "꼬리 메모 열기"}
    </Button>
  );
  return opened ? (
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
      leading={controls}
      readOnly={readOnly}
      onSaved={() => {}}
      onListChanged={() => {}}
      onLoadingChange={() => {}}
    />
  ) : (
    <section
      className="annual-memos annual-memos-collapsed"
      aria-label="연간 업무 메모 목록"
    >
      <div className="document-tabs">{controls}</div>
    </section>
  );
});
