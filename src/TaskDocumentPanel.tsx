import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useId,
} from "react";
import { Plus, MoreHorizontal, Pencil, Trash2, FileText } from "lucide-react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import { Grae } from "./Brand";
import DocumentLoading from "./DocumentLoading";
import TaskDocumentEditor, {
  documentDraftKey,
  readDocumentDraft,
  type DocumentEditorProps,
  type DocumentHandle,
} from "./TaskDocumentEditor";
import type { DocumentInfo, DocumentSaveResult } from "./types";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_TASK_DOCUMENTS,
  MAX_DOCUMENT_TITLE_LENGTH,
} from "../shared/task-documents.js";
import "./task-document.css";
export type { DocumentHandle } from "./TaskDocumentEditor";
export type DocumentPanelHandle = DocumentHandle & {
  selectDocument: (id: string) => Promise<boolean>;
};
type Props = Omit<DocumentEditorProps, "documentId" | "controlsTarget"> & {
  initialDocumentId?: string;
  onDocumentSelected?: (id: string) => void;
};
type RenameDraft = { document: DocumentInfo; title: string };
type ListResult = {
  documents: DocumentInfo[];
  hasDocument: boolean;
  documentCount: number;
  taskUpdatedAt: string;
};
const initialDocument: DocumentInfo = {
  id: DEFAULT_DOCUMENT_ID,
  title: DEFAULT_DOCUMENT_TITLE,
  revision: 0,
  hasContent: false,
  updatedAt: null,
};
function tabTitle(title: string) {
  const letters = Array.from(title);
  return letters.length >= 10 ? `${letters.slice(0, 9).join("")}…` : title;
}

export default forwardRef<DocumentPanelHandle, Props>(
  function TaskDocumentPanel(props, ref) {
    const [documents, setDocuments] = useState<DocumentInfo[]>([]);
    const [opened, setOpened] = useState(false);
    const [selected, setSelected] = useState(DEFAULT_DOCUMENT_ID);
    const [visited, setVisited] = useState<string[]>([]);
    const [loading, setLoading] = useState<Record<string, boolean>>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [menu, setMenu] = useState(false);
    const [renaming, setRenaming] = useState<RenameDraft | null>(null);
    const [renamePending, setRenamePending] = useState(false);
    const [tabToFocus, setTabToFocus] = useState<string | null>(null);
    const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(
      null,
    );
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [epochs, setEpochs] = useState<Record<string, number>>({});
    const handles = useRef(new Map<string, DocumentHandle>());
    const firstReady = useRef(false);
    const focusEditor = useRef(false);
    const createId = useRef<string | null>(null);
    const tablist = useRef<HTMLDivElement>(null);
    const tabScroll = useRef<HTMLDivElement>(null);
    const menuRoot = useRef<HTMLDivElement>(null);
    const menuTrigger = useRef<HTMLButtonElement>(null);
    const renameInput = useRef<HTMLInputElement>(null);
    const renameDraft = useRef<RenameDraft | null>(null);
    const renameSave = useRef<Promise<boolean> | null>(null);
    const composingTitle = useRef(false);
    const latest = useRef(props);
    latest.current = props;
    const id = useId();
    const path = props.report
      ? `/reports/${props.report.id}/tasks/${props.task.id}/documents`
      : `/tasks/${props.task.id}/documents`;
    const readOnly = props.readOnly || !!props.report?.isNew;
    const current = documents.find((doc) => doc.id === selected);
    useLayoutEffect(() => {
      if (!menu || readOnly) return;
      menuRoot.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
      const outside = (event: Event) => {
        if (
          event.target instanceof Node &&
          !menuRoot.current?.contains(event.target)
        )
          setMenu(false);
      };
      let focusFrame = 0;
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          focusFrame = requestAnimationFrame(() => {
            if (!menuRoot.current?.contains(document.activeElement))
              setMenu(false);
          });
          return;
        }
        if (event.key !== "Escape" || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(false);
        menuTrigger.current?.focus({ preventScroll: true });
      };
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", keydown, true);
      return () => {
        cancelAnimationFrame(focusFrame);
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", keydown, true);
      };
    }, [menu, readOnly]);
    useEffect(() => {
      const controller = new AbortController();
      setError("");
      const request = props.report?.isNew
        ? Promise.resolve({ documents: [initialDocument] })
        : api<{ documents: DocumentInfo[] }>(path, {
            signal: controller.signal,
          });
      void request
        .then((result) => {
          if (controller.signal.aborted) return;
          setDocuments(result.documents);
          const draft = result.documents.find((doc) =>
            readDocumentDraft(
              documentDraftKey({ ...latest.current, documentId: doc.id }),
            ),
          );
          const requested = result.documents.find(
            (doc) => doc.id === props.initialDocumentId,
          )?.id;
          if (props.initialDocumentId && !requested) {
            setSelected(props.initialDocumentId);
            setOpened(true);
            setError(
              "선택한 문서를 찾을 수 없습니다. 삭제되었는지 확인하고 다른 문서를 선택하세요.",
            );
            latest.current.onLoadingChange(false);
            return;
          }
          const shouldOpen =
            opened ||
            !!requested ||
            !!draft ||
            result.documents.some((doc) => doc.hasContent);
          setSelected(
            (previous) =>
              requested ||
              draft?.id ||
              (result.documents.some((doc) => doc.id === previous)
                ? previous
                : result.documents[0].id),
          );
          if (shouldOpen) {
            setOpened(true);
            setVisited((previous) => [
              ...new Set([
                ...previous,
                requested || draft?.id || result.documents[0].id,
              ]),
            ]);
          } else {
            latest.current.onLoadingChange(false);
          }
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setError(error.message);
          latest.current.onLoadingChange(false);
        });
      return () => controller.abort();
    }, [path, props.report?.isNew, attempt]);
    useEffect(() => {
      const element = tablist.current;
      if (!element) return;
      const observer = new ResizeObserver(() =>
        element.parentElement?.style.setProperty(
          "--document-tabs-height",
          `${element.offsetHeight}px`,
        ),
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [opened]);
    useEffect(() => {
      const element = tabScroll.current;
      if (!element) return;
      const wheel = (event: WheelEvent) => {
        if (event.ctrlKey) return;
        const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
        if (
          !delta ||
          (!event.shiftKey && Math.abs(delta) < Math.abs(event.deltaY))
        )
          return;
        // Consume horizontal gestures even at the ends to prevent history navigation.
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? element.clientWidth
              : 1;
        element.scrollLeft += delta * unit;
      };
      element.addEventListener("wheel", wheel, { passive: false });
      return () => element.removeEventListener("wheel", wheel);
    }, [opened]);
    useLayoutEffect(() => {
      document.getElementById(`${id}-${selected}-tab`)?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }, [opened, selected, documents.length]);
    useLayoutEffect(() => {
      if (!focusEditor.current || loading[selected] !== false) return;
      const editor = document
        .getElementById(`${id}-${selected}-page`)
        ?.querySelector<HTMLElement>(
          '[contenteditable="true"], textarea:not([readonly])',
        );
      if (editor) {
        editor.focus();
        focusEditor.current = false;
      }
    }, [selected, loading]);
    useLayoutEffect(() => {
      if (!renaming) return;
      renameInput.current?.focus();
      renameInput.current?.select();
      renameInput.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }, [renaming?.document.id]);
    useLayoutEffect(() => {
      if (!tabToFocus || renaming) return;
      if (tabToFocus === selected)
        document.getElementById(`${id}-${tabToFocus}-tab`)?.focus();
      setTabToFocus(null);
    }, [tabToFocus, selected, renaming]);
    useImperativeHandle(ref, () => ({
      persistDraft: () => {
        for (const handle of handles.current.values())
          if (!handle.persistDraft()) return false;
        return true;
      },
      selectDocument: select,
      flush: async () => {
        if (busy || !(await finishRename())) return false;
        for (const handle of handles.current.values())
          if (!(await handle.flush())) return false;
        return true;
      },
    }));
    useEffect(() => {
      if (opened && documents.some((doc) => doc.id === selected))
        props.onDocumentSelected?.(selected);
    }, [opened, selected, documents]);
    async function select(documentId: string) {
      if (busy || !(await finishRename())) return false;
      if (!documents.some((doc) => doc.id === documentId)) return false;
      if (documentId === selected) return true;
      const handle = handles.current.get(selected);
      if (handle && !(await handle.flush())) return false;
      setSelected(documentId);
      setVisited((previous) =>
        previous.includes(documentId) ? previous : [...previous, documentId],
      );
      setMenu(false);
      setConfirmDelete(false);
      setError("");
      return true;
    }
    function changed(result: ListResult) {
      setDocuments(result.documents);
      // Metadata changes do not replace an editor's unsaved body.
      props.onSaved({
        markdown: "",
        revision: 0,
        updatedAt: null,
        hasDocument: result.hasDocument,
        documentCount: result.documentCount,
        taskUpdatedAt: result.taskUpdatedAt,
      });
    }
    async function add() {
      if (readOnly || busy || !(await finishRename())) return;
      setBusy(true);
      setError("");
      try {
        const handle = handles.current.get(selected);
        if (handle && !(await handle.flush())) return;
        const documentId = (createId.current ||= crypto.randomUUID());
        const result = await send<ListResult>(path, { id: documentId });
        changed(result);
        setSelected(documentId);
        setVisited((previous) => [...new Set([...previous, documentId])]);
        createId.current = null;
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setBusy(false);
      }
    }
    function changeRename(draft: RenameDraft | null) {
      renameDraft.current = draft;
      setRenaming(draft);
    }
    function focusTab(documentId: string) {
      setTabToFocus(documentId);
    }
    async function startRename(doc: DocumentInfo) {
      if (readOnly || busy || !(await select(doc.id))) return;
      setMenu(false);
      setConfirmDelete(false);
      setError("");
      changeRename({ document: doc, title: doc.title });
    }
    function finishRename(): Promise<boolean> {
      if (renameSave.current) return renameSave.current;
      const draft = renameDraft.current;
      if (!draft) return Promise.resolve(true);
      if (readOnly || composingTitle.current) return Promise.resolve(false);
      const work = async () => {
        setRenamePending(true);
        setError("");
        try {
          const title = draft.title.trim();
          if (!title) throw new Error("문서 제목을 입력하세요.");
          if (title !== draft.document.title)
            changed(
              await send<ListResult>(
                `${path}/${draft.document.id}`,
                { title, expectedTitle: draft.document.title },
                "PATCH",
              ),
            );
          changeRename(null);
          return true;
        } catch (error) {
          setError((error as Error).message);
          requestAnimationFrame(() => renameInput.current?.focus());
          return false;
        } finally {
          setRenamePending(false);
        }
      };
      const promise = Promise.resolve()
        .then(work)
        .finally(() => {
          renameSave.current = null;
        });
      renameSave.current = promise;
      return promise;
    }
    async function remove() {
      if (readOnly || busy || !current || !(await finishRename())) return;
      setBusy(true);
      setError("");
      try {
        const handle = handles.current.get(selected);
        if (handle && !(await handle.flush())) return;
        const latestDocument = await api<DocumentInfo>(`${path}/${selected}`);
        const result = await send<ListResult>(
          `${path}/${selected}`,
          { expectedRevision: latestDocument.revision },
          "DELETE",
        );
        handles.current.delete(selected);
        setEpochs((previous) => ({
          ...previous,
          [selected]: (previous[selected] || 0) + 1,
        }));
        changed(result);
        setVisited((previous) => [
          ...new Set([
            ...previous.filter((docId) => docId !== selected),
            result.documents[0].id,
          ]),
        ]);
        setSelected(result.documents[0].id);
        setConfirmDelete(false);
        // Recreating the implicit first document must not reuse the deleted editor.
        setLoading((previous) => ({ ...previous, [selected]: true }));
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setBusy(false);
      }
    }
    if (!opened)
      return (
        <section
          className="task-documents"
          aria-label="업무 문서 목록"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ErrorNote error={error} />
          {error ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              문서 다시 불러오기
            </Button>
          ) : (
            !!documents.length && (
              <div className="document-empty">
                <Grae className="document-empty-character" />
                <h3>
                  {props.readOnly
                    ? "작성된 문서가 없습니다."
                    : "업무를 문서로 정리해 보세요"}
                </h3>
                <p>
                  {props.readOnly
                    ? "문서가 작성되면 이곳에서 내용을 확인할 수 있습니다."
                    : "Markdown 문서로 업무의 배경과 진행 내용, 결정 사항을 기록할 수 있습니다."}
                </p>
                {!props.readOnly && (
                  <Button
                    className="primary"
                    disabled={readOnly}
                    onClick={() => {
                      focusEditor.current = true;
                      firstReady.current = false;
                      props.onLoadingChange(true);
                      setVisited([selected]);
                      setOpened(true);
                    }}
                  >
                    <Pencil size={16} aria-hidden="true" />
                    문서 작성
                  </Button>
                )}
              </div>
            )
          )}
        </section>
      );
    return (
      <section
        className="task-documents"
        aria-label="업무 문서 목록"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="document-tabs" ref={tablist}>
          <div
            className="document-tablist"
            ref={tabScroll}
            role="tablist"
            aria-label="업무 문서"
          >
            {documents.map((doc, index) => (
              <div className="document-tab-item" key={doc.id}>
                {renaming?.document.id === doc.id ? (
                  <span
                    className="document-tab-title-editor"
                    id={`${id}-${doc.id}-tab`}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span
                      className="document-tab-title-measure"
                      aria-hidden="true"
                    >
                      {renaming.title || "\u00a0"}
                    </span>
                    <input
                      className="document-tab-title-input"
                      ref={renameInput}
                      aria-label="문서 제목"
                      aria-invalid={!!error}
                      maxLength={MAX_DOCUMENT_TITLE_LENGTH}
                      readOnly={renamePending}
                      value={renaming.title}
                      onChange={(event) =>
                        changeRename({ ...renaming, title: event.target.value })
                      }
                      onBlur={() => {
                        if (!composingTitle.current) void finishRename();
                      }}
                      onCompositionStart={() => {
                        composingTitle.current = true;
                      }}
                      onCompositionEnd={(event) => {
                        composingTitle.current = false;
                        changeRename({
                          ...renaming,
                          title: event.currentTarget.value,
                        });
                        if (document.activeElement !== event.currentTarget)
                          void finishRename();
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (
                          event.nativeEvent.isComposing ||
                          composingTitle.current ||
                          event.keyCode === 229
                        )
                          return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void finishRename().then((saved) => {
                            if (saved) focusTab(doc.id);
                          });
                        } else if (
                          event.key === "Escape" &&
                          !renameSave.current
                        ) {
                          event.preventDefault();
                          changeRename(null);
                          setError("");
                          focusTab(doc.id);
                        }
                      }}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    role="tab"
                    id={`${id}-${doc.id}-tab`}
                    aria-controls={`${id}-${doc.id}-page`}
                    aria-selected={selected === doc.id}
                    tabIndex={selected === doc.id ? 0 : -1}
                    title={doc.title}
                    aria-label={doc.title}
                    onClick={() => void select(doc.id)}
                    onDoubleClick={() => void startRename(doc)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        void startRename(doc);
                        return;
                      }
                      const next =
                        event.key === "ArrowRight"
                          ? (index + 1) % documents.length
                          : event.key === "ArrowLeft"
                            ? (index + documents.length - 1) % documents.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? documents.length - 1
                                : -1;
                      if (next >= 0) {
                        event.preventDefault();
                        void select(documents[next].id).then((selected) => {
                          if (selected) focusTab(documents[next].id);
                        });
                      }
                    }}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span className="document-tab-label">
                      {tabTitle(doc.title)}
                    </span>
                  </button>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <Button
              tooltip="문서 추가"
              disabled={busy || documents.length >= MAX_TASK_DOCUMENTS}
              onClick={() => void add()}
            >
              <Plus size={16} />
            </Button>
          )}
          <div className="document-tab-actions">
            <div ref={setControlsTarget} />
            {!readOnly && current && (
              <div className="document-tab-menu" ref={menuRoot}>
                <Button
                  ref={menuTrigger}
                  tooltip="문서 메뉴"
                  aria-haspopup="menu"
                  aria-controls={menu ? `${id}-menu` : undefined}
                  aria-expanded={menu}
                  disabled={busy}
                  onClick={() =>
                    void finishRename().then((saved) => {
                      if (saved) setMenu((value) => !value);
                    })
                  }
                >
                  <MoreHorizontal size={16} />
                </Button>
                {menu && (
                  <div id={`${id}-menu`} role="menu" aria-label="문서 메뉴">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void startRename(current)}
                    >
                      <Pencil size={14} />
                      문서 이름 변경
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setConfirmDelete(true);
                        setMenu(false);
                      }}
                    >
                      <Trash2 size={14} />
                      문서 삭제
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {confirmDelete && (
          <div className="document-delete-confirm" role="alert">
            <span>‘{current?.title}’ 문서를 삭제할까요?</span>
            <Button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              문서 삭제
            </Button>
            <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
              취소
            </Button>
          </div>
        )}
        <ErrorNote error={error} />
        {!documents.length && error && (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            문서 다시 불러오기
          </Button>
        )}
        {documents
          .filter((doc) => visited.includes(doc.id))
          .map((doc) => (
            <div
              key={`${doc.id}:${epochs[doc.id] || 0}`}
              className="document-page"
              id={`${id}-${doc.id}-page`}
              role="tabpanel"
              aria-labelledby={`${id}-${doc.id}-tab`}
              hidden={selected !== doc.id}
              data-loading={loading[doc.id] !== false || undefined}
            >
              {loading[doc.id] !== false && <DocumentLoading />}
              <TaskDocumentEditor
                {...props}
                documentId={doc.id}
                controlsTarget={selected === doc.id ? controlsTarget : null}
                onCloseWithDraft={() =>
                  void finishRename().then((saved) => {
                    if (saved) props.onCloseWithDraft();
                  })
                }
                ref={(handle) => {
                  if (handle) handles.current.set(doc.id, handle);
                  else handles.current.delete(doc.id);
                }}
                onSaved={(result: DocumentSaveResult) => {
                  setDocuments((previous) =>
                    previous.map((item) =>
                      item.id === doc.id
                        ? {
                            ...item,
                            revision: result.revision,
                            updatedAt: result.updatedAt,
                          }
                        : item,
                    ),
                  );
                  props.onSaved(result);
                }}
                onLoadingChange={(value) => {
                  setLoading((previous) =>
                    previous[doc.id] === value
                      ? previous
                      : { ...previous, [doc.id]: value },
                  );
                  if (!value && !firstReady.current) {
                    firstReady.current = true;
                    latest.current.onLoadingChange(false);
                  }
                }}
              />
            </div>
          ))}
      </section>
    );
  },
);
