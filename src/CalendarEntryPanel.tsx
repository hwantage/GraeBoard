import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Trash2 } from "lucide-react";
import { Button, ErrorNote, Modal } from "./components";
import { api, ApiError, send } from "./api";
import {
  deleteCalendarEntry,
  saveCalendarEntryTags,
} from "./calendar-entry-actions";
import DocumentEditor, { type DocumentHandle } from "./DocumentEditor";
import DocumentLoading from "./DocumentLoading";
import CalendarRangeEditor, {
  type CalendarRangeHandle,
} from "./CalendarRangeEditor";
import type {
  CalendarDocument,
  CalendarEntry,
  CalendarEntryDeletion,
  CalendarEntryUpdate,
  CalendarTag,
} from "./calendar-types";
import { CalendarTagPicker } from "./CalendarTags";
import {
  applyCalendarTagCheck,
  saveCalendarTagCheck,
} from "./calendar-tag-checks";

export default function CalendarEntryPanel({
  entry,
  tags,
  onManageTags,
  userId,
  readOnly,
  onSaved,
  onDeleted,
  onClose,
}: {
  entry: CalendarEntry;
  tags: CalendarTag[];
  onManageTags: () => void;
  userId: string;
  readOnly: boolean;
  onSaved: (entry: CalendarEntryUpdate) => void;
  onDeleted: (entry: CalendarEntry, result: CalendarEntryDeletion) => void;
  onClose: () => void;
}) {
  const path = `/calendar/entries/${entry.id}`;
  const titleKey = `weekly-plan:calendar-title:${userId}:${entry.teamId}:${entry.id}`;
  const [title, setTitle] = useState(entry.title);
  const [tagIds, setTagIds] = useState(entry.tagIds);
  const [checkedTagIds, setCheckedTagIds] = useState(entry.checkedTagIds);
  const [tagError, setTagError] = useState("");
  const savingTags = useRef(false);
  const [error, setError] = useState("");
  const [titleConflict, setTitleConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [documentFullPage, setDocumentFullPage] = useState(false);
  const deletionId = useRef(crypto.randomUUID());
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const editor = useRef<DocumentHandle>(null);
  const rangeEditor = useRef<CalendarRangeHandle>(null);
  const current = useRef(entry);
  const draft = useRef(entry.title);
  const composing = useRef(false);
  const titleSave = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaving = useRef(false);
  const alive = useRef(true);
  function titleChanged() {
    return draft.current.trim() !== current.current.title;
  }
  function persist() {
    try {
      if (!titleChanged()) sessionStorage.removeItem(titleKey);
      else
        sessionStorage.setItem(
          titleKey,
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
  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    setError("");
    void api<CalendarEntry>(path, { signal: controller.signal })
      .then((latest) => {
        if (controller.signal.aborted) return;
        current.current = latest;
        setTagIds(latest.tagIds);
        setCheckedTagIds(latest.checkedTagIds);
        let restored: { title: string; base: string } | null = null;
        try {
          restored = JSON.parse(sessionStorage.getItem(titleKey) || "null");
        } catch {
          /* storage may be unavailable */
        }
        draft.current =
          typeof restored?.title === "string" ? restored.title : latest.title;
        setTitle(draft.current);
        if (readOnly && titleChanged())
          setError(
            "현재는 읽기 전용입니다. 보관된 제목을 복사하거나 초안을 보관하고 닫아 주세요.",
          );
        if (restored && restored.base !== latest.title && titleChanged()) {
          blocked.current = true;
          setTitleConflict(latest.title);
          setError(
            `서버 제목이 ‘${latest.title}’로 변경되었습니다. 보관된 제목을 확인하고 제목 저장을 눌러 주세요.`,
          );
        }
        setReady(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    const unload = (event: BeforeUnloadEvent) => {
      if (titleChanged()) {
        persist();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      alive.current = false;
      controller.abort();
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("beforeunload", unload);
    };
  }, [path, loadAttempt]);
  useEffect(() => {
    const available = new Set(tags.map((tag) => tag.id));
    const checkable = new Set(
      tags.filter((tag) => tag.kind === "check").map((tag) => tag.id),
    );
    current.current = {
      ...current.current,
      tagIds: current.current.tagIds.filter((id) => available.has(id)),
      checkedTagIds: current.current.checkedTagIds.filter((id) =>
        checkable.has(id),
      ),
    };
    setTagIds((ids) => ids.filter((id) => available.has(id)));
    setCheckedTagIds((ids) => ids.filter((id) => checkable.has(id)));
  }, [tags]);
  async function saveTags(next: string[]) {
    if (savingTags.current || busy || !ready || readOnly) return;
    if (
      next.length === current.current.tagIds.length &&
      next.every((id, index) => id === current.current.tagIds[index])
    )
      return;
    savingTags.current = true;
    setBusy(true);
    setTagError("");
    setTagIds(next);
    try {
      const saved = await saveCalendarEntryTags(current.current, next);
      current.current = {
        ...current.current,
        tagIds: saved.tagIds,
        checkedTagIds: saved.checkedTagIds,
        updatedAt:
          saved.updatedAt > current.current.updatedAt
            ? saved.updatedAt
            : current.current.updatedAt,
      };
      if (alive.current) {
        setTagIds(saved.tagIds);
        setCheckedTagIds(saved.checkedTagIds);
        onSaved(current.current);
      }
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details?.currentTagIds)) {
        current.current = {
          ...current.current,
          tagIds: e.details.currentTagIds as string[],
          checkedTagIds: Array.isArray(e.details.currentCheckedTagIds)
            ? (e.details.currentCheckedTagIds as string[])
            : current.current.checkedTagIds,
        };
        if (alive.current) onSaved(current.current);
      }
      if (alive.current) {
        setTagIds(current.current.tagIds);
        setCheckedTagIds(current.current.checkedTagIds);
        setTagError((e as Error).message);
      }
    } finally {
      savingTags.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function saveTitle(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    if (composing.current || blocked.current) return false;
    if (titleSave.current)
      return (await titleSave.current) ? saveTitle() : false;
    if (!ready || !titleChanged()) return true;
    if (readOnly) return false;
    const submitted = draft.current.trim();
    if (!submitted) {
      setError("일정 제목을 입력해 주세요.");
      return false;
    }
    const previous = current.current.title;
    titleSave.current = (async () => {
      try {
        const saved = await send<CalendarEntry>(
          path,
          { title: submitted, expectedTitle: previous },
          "PATCH",
        );
        // Title, range and document requests can finish in any order.
        current.current = {
          ...current.current,
          title: saved.title,
          ...(saved.revision > current.current.revision
            ? { revision: saved.revision, preview: saved.preview }
            : {}),
          updatedAt:
            saved.updatedAt > current.current.updatedAt
              ? saved.updatedAt
              : current.current.updatedAt,
        };
        // Normalize only the saved title. Replacing the live draft here
        // erases spaces typed during the request and interrupts the caret/IME.
        persist();
        onSaved(current.current);
        if (alive.current) setError("");
        if (alive.current) setTitleConflict(null);
        return true;
      } catch (e) {
        blocked.current = true;
        if (alive.current) setError((e as Error).message);
        if (
          alive.current &&
          e instanceof ApiError &&
          typeof e.details?.currentTitle === "string"
        )
          setTitleConflict(e.details.currentTitle);
        return false;
      } finally {
        titleSave.current = null;
      }
    })();
    return (await titleSave.current) ? saveTitle() : false;
  }
  async function saveCheck(tagId: string, checked: boolean) {
    if (savingTags.current || busy || !ready || readOnly) return;
    savingTags.current = true;
    setBusy(true);
    setTagError("");
    setCheckedTagIds(
      applyCalendarTagCheck(current.current, {
        tagId,
        checked,
        updatedAt: current.current.updatedAt,
      }).checkedTagIds,
    );
    try {
      const change = await saveCalendarTagCheck(
        current.current,
        tagId,
        checked,
      );
      current.current = applyCalendarTagCheck(current.current, change);
      if (alive.current) {
        setCheckedTagIds(current.current.checkedTagIds);
        onSaved(current.current);
      }
    } catch (e) {
      if (alive.current) {
        setCheckedTagIds(current.current.checkedTagIds);
        setTagError((e as Error).message);
      }
    } finally {
      savingTags.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function close(keepDraft = false) {
    if (leaving.current || busy || savingTags.current) return;
    leaving.current = true;
    try {
      if (keepDraft) {
        if (
          persist() &&
          (!rangeEditor.current || rangeEditor.current.persistDraft()) &&
          (!editor.current || editor.current.persistDraft())
        )
          onClose();
        return;
      }
      if (!(await saveTitle())) return;
      if (rangeEditor.current && !(await rangeEditor.current.flush())) return;
      if (editor.current && !(await editor.current.flush())) return;
      onClose();
    } finally {
      leaving.current = false;
    }
  }
  async function remove() {
    if (busy || leaving.current || savingTags.current || !ready || readOnly)
      return;
    leaving.current = true;
    setBusy(true);
    try {
      if (
        !(await saveTitle()) ||
        (rangeEditor.current && !(await rangeEditor.current.flush())) ||
        (editor.current && !(await editor.current.flush()))
      )
        return;
      const result = await deleteCalendarEntry(
        current.current,
        deletionId.current,
      );
      try {
        sessionStorage.removeItem(titleKey);
      } catch {
        /* The server deletion succeeded. */
      }
      onDeleted(current.current, result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      leaving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="캘린더 일정"
      className={`task-detail-modal calendar-entry-modal${documentFullPage ? " document-full-page" : ""}`}
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
        <span className="calendar-entry-title-editor">
          <span className="calendar-entry-title-measure" aria-hidden="true">
            {title || "일정 제목"}
          </span>
          <input
            className="calendar-entry-title"
            aria-label="일정 제목"
            placeholder="일정 제목"
            maxLength={120}
            value={title}
            readOnly={readOnly || !ready || (busy && leaving.current)}
            onChange={(e) => {
              draft.current = e.target.value;
              setTitle(e.target.value);
              persist();
              if (timer.current) clearTimeout(timer.current);
              if (!composing.current && !blocked.current)
                timer.current = setTimeout(() => void saveTitle(), 700);
            }}
            onCompositionStart={() => {
              composing.current = true;
              if (timer.current) clearTimeout(timer.current);
            }}
            onCompositionEnd={() => {
              composing.current = false;
              if (!blocked.current) void saveTitle();
            }}
          />
        </span>
      }
    >
      <div className="calendar-entry-heading" inert={busy && leaving.current}>
        {ready && (
          <CalendarRangeEditor
            ref={rangeEditor}
            entry={current.current}
            userId={userId}
            readOnly={readOnly}
            onCloseWithDraft={() => void close(true)}
            onSaved={(saved) => {
              current.current = {
                ...current.current,
                date: saved.date,
                endDate: saved.endDate,
                lane: saved.lane,
                updatedAt:
                  saved.updatedAt > current.current.updatedAt
                    ? saved.updatedAt
                    : current.current.updatedAt,
              };
              onSaved({
                ...current.current,
                placements: saved.placements,
                layout: saved.layout,
              });
            }}
          />
        )}
        <div className="calendar-entry-tools">
          <CalendarTagPicker
            userId={entry.userId}
            tags={tags}
            value={tagIds}
            checkedIds={checkedTagIds}
            disabled={!ready || busy}
            readOnly={readOnly}
            onChange={(ids) => void saveTags(ids)}
            onCheckChange={(id, checked) => void saveCheck(id, checked)}
            onManage={onManageTags}
          />
          <div className="calendar-document-controls" ref={setControls} />
        </div>
        <ErrorNote error={tagError} />
        <ErrorNote error={error} />
        {error && !ready && (
          <Button onClick={() => setLoadAttempt((n) => n + 1)}>
            일정 다시 불러오기
          </Button>
        )}
        {titleConflict !== null && (
          <div className="document-conflict">
            <p>최신 서버 제목: {titleConflict}</p>
            <Button
              onClick={() => {
                current.current.title = titleConflict;
                blocked.current = false;
                void saveTitle();
              }}
            >
              내 제목으로 최신 제목 교체
            </Button>
          </div>
        )}
        {error && ready && (
          <div className="calendar-actions">
            {!readOnly && titleConflict === null && (
              <Button
                onClick={() => {
                  blocked.current = false;
                  void saveTitle();
                }}
              >
                제목 저장 다시 시도
              </Button>
            )}
            <Button onClick={() => void close(true)}>초안 보관하고 닫기</Button>
          </div>
        )}
      </div>
      {ready && (
        <div
          className="task-document-shell"
          data-loading={loading || undefined}
        >
          {loading && <DocumentLoading />}
          <div
            className="task-document-surface"
            aria-hidden={loading || undefined}
            inert={loading || (busy && leaving.current)}
          >
            <DocumentEditor
              ref={editor}
              path={`${path}/document`}
              draftKey={`weekly-plan:calendar-document:${userId}:${entry.teamId}:${entry.userId}:${entry.id}`}
              label="일정 문서"
              live
              onRemoteDocument={(data) => {
                const remote = data as CalendarDocument;
                if (Number(remote.revision) < current.current.revision) return;
                current.current = {
                  ...current.current,
                  revision: Number(remote.revision),
                  preview: remote.entry?.preview ?? current.current.preview,
                  updatedAt:
                    remote.updatedAt &&
                    remote.updatedAt > current.current.updatedAt
                      ? remote.updatedAt
                      : current.current.updatedAt,
                };
                onSaved(current.current);
              }}
              controlsTarget={controls}
              readOnly={readOnly}
              onLoadingChange={setLoading}
              onCloseWithDraft={() => void close(true)}
              saveDocument={async (input) => {
                const result = await send<CalendarDocument>(
                  `${path}/document`,
                  input,
                  "PUT",
                );
                current.current = {
                  ...result.entry,
                  title: current.current.title,
                  date: current.current.date,
                  endDate: current.current.endDate,
                  lane: current.current.lane,
                  tagIds: current.current.tagIds,
                  checkedTagIds: current.current.checkedTagIds,
                  updatedAt:
                    result.entry.updatedAt > current.current.updatedAt
                      ? result.entry.updatedAt
                      : current.current.updatedAt,
                };
                onSaved(current.current);
                return result;
              }}
            />
          </div>
        </div>
      )}
      {!readOnly && (
        <footer className="task-detail-footer calendar-entry-footer">
          <Button
            className="danger"
            disabled={!ready || busy}
            onClick={() => void remove()}
          >
            <Trash2 size={14} aria-hidden="true" />
            일정 삭제
          </Button>
        </footer>
      )}
    </Modal>
  );
}
