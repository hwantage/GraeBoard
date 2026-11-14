import { useEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole, Maximize2, Minimize2, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import CalendarRangeEditor, {
  type CalendarRangeHandle,
} from "./CalendarRangeEditor";
import {
  getSecretEntry,
  patchSecretEntry,
  setSecretEntryTags,
  setSecretTagChecked,
  secretCalendarChanged,
  secretCalendarKey,
  type SecretCalendarEntry,
} from "./secret-calendar";

import DocumentEditor, {
  type DocumentHandle,
} from "../documents/DocumentEditor";
import DocumentLoading from "../documents/DocumentLoading";
import DocumentFullWidthButton from "../documents/DocumentFullWidthButton";
import CopyEmojiButton from "../documents/CopyEmojiButton";
import { useDocumentFullPage } from "../documents/useDocumentFullPage";
import { CalendarTagPicker } from "./CalendarTags";
import type { CalendarTag } from "./calendar-types";
import { secretDocumentStorage } from "./secret-document-storage";
import { revealCaretOnSelection } from "../ui/revealInputCaret";

export default function SecretCalendarEntryPanel({
  entry,
  tags,
  onManageTags,
  onClose,
  onDeleted,
}: {
  entry: SecretCalendarEntry;
  tags: CalendarTag[];
  onManageTags: () => void;
  onClose: () => void;
  onDeleted: (entry: SecretCalendarEntry) => Promise<void>;
}) {
  const storage = useMemo(
    () => secretDocumentStorage(entry.userId, entry.teamId, entry.id),
    [entry.userId, entry.teamId, entry.id],
  );
  const editor = useRef<DocumentHandle>(null);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [preferredFullPage, setDocumentFullPage] = useState(false);
  const { fullPage: documentFullPage, fullWidth } =
    useDocumentFullPage(preferredFullPage);
  const [tagEntry, setTagEntry] = useState(entry);
  const current = useRef(entry);
  const draft = useRef(entry.title);
  const [title, setTitle] = useState(entry.title);
  const [error, setError] = useState("");
  const composing = useRef(false);
  const leaving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeEditor = useRef<CalendarRangeHandle>(null);
  const key = `weekly-plan:calendar-title:${entry.userId}:${entry.teamId}:${entry.id}`;
  function persist() {
    try {
      if (draft.current.trim() === current.current.title)
        sessionStorage.removeItem(key);
      else
        sessionStorage.setItem(
          key,
          JSON.stringify({ title: draft.current, base: current.current.title }),
        );
      return true;
    } catch {
      setError(
        "임시 보관 공간이 부족합니다. 입력을 복사하거나 저장 후 닫아 주세요.",
      );
      return false;
    }
  }
  function saveTitle() {
    if (timer.current) clearTimeout(timer.current);
    if (composing.current) return false;
    if (draft.current.trim() === current.current.title) return true;
    try {
      current.current = patchSecretEntry(current.current, {
        title: draft.current.trim(),
      });
      persist();
      setError("");
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  }
  useEffect(() => {
    try {
      const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
      current.current = latest;
      const restored = JSON.parse(sessionStorage.getItem(key) || "null");
      draft.current =
        typeof restored?.title === "string" ? restored.title : latest.title;
      if (restored && typeof restored.base === "string")
        current.current = { ...latest, title: restored.base };
      setTitle(draft.current);
    } catch (error) {
      setError((error as Error).message);
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (draft.current.trim() === current.current.title) return;
      persist();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("beforeunload", unload);
    };
  }, [key]);
  useEffect(() => {
    const refresh = () => {
      try {
        setTagEntry(getSecretEntry(entry.userId, entry.teamId, entry.id));
      } catch (error) {
        setError((error as Error).message);
      }
    };
    const local = (event: Event) => {
      if ((event as CustomEvent).detail === entry.userId) refresh();
    };
    const remote = (event: StorageEvent) => {
      if (event.key === secretCalendarKey(entry.userId)) refresh();
    };
    window.addEventListener(secretCalendarChanged, local);
    window.addEventListener("storage", remote);
    return () => {
      window.removeEventListener(secretCalendarChanged, local);
      window.removeEventListener("storage", remote);
    };
  }, [entry.userId, entry.teamId, entry.id]);
  function changeTags(save: () => SecretCalendarEntry) {
    try {
      setTagEntry(save());
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function close(keepDraft = false, remove = false) {
    if (leaving.current) return;
    leaving.current = true;
    try {
      if (keepDraft) {
        if (
          !persist() ||
          !rangeEditor.current?.persistDraft() ||
          (editor.current && !editor.current.persistDraft())
        )
          return;
      } else if (
        !saveTitle() ||
        !(await rangeEditor.current?.flush()) ||
        (editor.current && !(await editor.current.flush()))
      )
        return;
      if (remove) await onDeleted(current.current);
      else onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      leaving.current = false;
    }
  }
  return (
    <Modal
      title="시크릿 일정"
      className={`task-detail-modal calendar-entry-modal${documentFullPage ? ` document-full-page${fullWidth ? " document-full-width" : ""}` : ""}`}
      headerActions={
        <>
          {documentFullPage && <DocumentFullWidthButton />}
          <CopyEmojiButton userId={entry.userId} />
        </>
      }
      titleAction={
        <Button
          tooltip={
            documentFullPage ? "전체 페이지 닫기" : "문서 전체 페이지로 보기"
          }
          className="document-expand"
          aria-pressed={documentFullPage}
          onClick={() => setDocumentFullPage((value) => !value)}
        >
          {documentFullPage ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </Button>
      }
      onClose={() => void close()}
      titleContent={
        <>
          <LockKeyhole size={16} aria-hidden="true" />
          <span className="calendar-entry-title-editor">
            <span className="calendar-entry-title-measure" aria-hidden="true">
              {title || "일정 제목"}
            </span>
            <input
              className="calendar-entry-title"
              aria-label="일정 제목"
              // 편집을 마치면 긴 제목도 앞부터 보이게 한다(iOS는 커서 위치를 유지).
              onBlur={(event) => {
                event.currentTarget.scrollLeft = 0;
              }}
              // 손으로 옮긴 커서도 따라가도록 커서가 바뀔 때 가로 위치를 맞춘다.
              ref={revealCaretOnSelection}
              placeholder="일정 제목"
              maxLength={120}
              value={title}
              onChange={(event) => {
                draft.current = event.target.value;
                setTitle(draft.current);
                persist();
                if (timer.current) clearTimeout(timer.current);
                if (!composing.current)
                  timer.current = setTimeout(saveTitle, 700);
              }}
              onCompositionStart={() => {
                composing.current = true;
                if (timer.current) clearTimeout(timer.current);
              }}
              onCompositionEnd={() => {
                composing.current = false;
                saveTitle();
              }}
            />
          </span>
        </>
      }
    >
      <div className="calendar-entry-heading">
        <CalendarRangeEditor
          ref={rangeEditor}
          entry={current.current}
          userId={entry.userId}
          readOnly={false}
          storage={{
            label: "브라우저",
            read: async () =>
              getSecretEntry(entry.userId, entry.teamId, entry.id),
            save: async (range, expected) =>
              patchSecretEntry({ ...current.current, ...expected }, range),
          }}
          onSaved={(saved) => {
            current.current = {
              ...current.current,
              date: saved.date,
              endDate: saved.endDate,
              lane: saved.lane,
            };
          }}
          onCloseWithDraft={() => void close(true)}
        />
        <div className="calendar-entry-tools">
          <CalendarTagPicker
            userId={entry.userId}
            tags={tags}
            value={tagEntry.tagIds}
            checkedIds={tagEntry.checkedTagIds}
            onChange={(ids) =>
              changeTags(() => setSecretEntryTags(tagEntry, ids))
            }
            onCheckChange={(id, checked) =>
              changeTags(() => setSecretTagChecked(tagEntry, id, checked))
            }
            onManage={onManageTags}
          />
        </div>
        <ErrorNote error={error} />
        {error && (
          <div className="calendar-actions">
            <Button onClick={saveTitle}>제목 저장 다시 시도</Button>
            <Button onClick={() => void close(true)}>초안 보관하고 닫기</Button>
          </div>
        )}
      </div>
      <div className="task-document-shell" data-loading={loading || undefined}>
        {loading && <DocumentLoading />}
        <div
          className="task-document-surface"
          aria-hidden={loading || undefined}
          inert={loading}
        >
          <div className="document-mode-bar" ref={setControls} />
          <DocumentEditor
            ref={editor}
            path={`secret:${entry.id}`}
            storage={storage}
            draftKey={`weekly-plan:secret-document:${entry.userId}:${entry.teamId}:${entry.id}`}
            label="일정 문서"
            title={title}
            controlsTarget={controls}
            readOnly={false}
            onLoadingChange={setLoading}
            onCloseWithDraft={() => void close(true)}
          />
        </div>
      </div>
      <footer className="task-detail-footer calendar-entry-footer">
        <Button className="danger" onClick={() => void close(false, true)}>
          <Trash2 size={14} aria-hidden="true" />
          일정 삭제
        </Button>
      </footer>
    </Modal>
  );
}
