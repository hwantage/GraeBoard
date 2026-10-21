import useResourceSync from "./useResourceSync";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  Plus,
  MoreHorizontal,
  ChevronDown,
  Pencil,
  Trash2,
  FileText,
} from "lucide-react";
import { api, send, ApiError } from "./api";
import { reorderItems, useListReorder, type Placement } from "./useListReorder";
import { Button, ErrorNote } from "./components";
import { Grae } from "./Brand";
import DocumentLoading from "./DocumentLoading";
import DocumentEditor, {
  readDocumentDraft,
  type DocumentHandle,
  type SharedDocumentEditorProps,
} from "./DocumentEditor";
import type { DocumentInfo, DocumentSaveResult, TaskDocument } from "./types";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_TASK_DOCUMENTS,
  MAX_DOCUMENT_TITLE_LENGTH,
} from "../shared/task-documents.js";
import "./task-document.css";
export type { DocumentHandle } from "./DocumentEditor";
export type DocumentPanelHandle = DocumentHandle & {
  selectDocument: (id: string) => Promise<boolean>;
};
export type DocumentListResult = { documents: DocumentInfo[] } & Partial<
  Pick<DocumentSaveResult, "hasDocument" | "documentCount" | "taskUpdatedAt">
>;
export type DocumentResult = TaskDocument & Partial<DocumentSaveResult>;
type Props = Pick<
  SharedDocumentEditorProps,
  "readOnly" | "emptyUntilSaved" | "onCloseWithDraft" | "onLoadingChange"
> & {
  path: string;
  draftKey: (documentId: string) => string;
  onSaved: (result: DocumentResult) => void;
  onListChanged: (result: DocumentListResult) => void;
  initialDocumentId?: string;
  onDocumentSelected?: (id: string) => void;
  inline?: boolean;
  leading?: ReactNode;
  label?: string;
};
type RenameDraft = { document: DocumentInfo; title: string };
type ListResult = DocumentListResult;
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
  function DocumentPanel(props, ref) {
    const [documents, setDocuments] = useState<DocumentInfo[]>([]);
    const [documentsLoaded, setDocumentsLoaded] = useState(false);
    const [opened, setOpened] = useState(false);
    const [selected, setSelected] = useState(DEFAULT_DOCUMENT_ID);
    const [visited, setVisited] = useState<string[]>([]);
    const [loading, setLoading] = useState<Record<string, boolean>>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [menu, setMenu] = useState<string | null>(null);
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
    const documentScroll = useRef<HTMLDivElement>(null);
    const navigateDocument = useRef(true);
    const menuRoot = useRef<HTMLDivElement>(null);
    const menuTrigger = useRef<HTMLButtonElement>(null);
    const renameInput = useRef<HTMLInputElement>(null);
    const renameDraft = useRef<RenameDraft | null>(null);
    const renameSave = useRef<Promise<boolean> | null>(null);
    const composingTitle = useRef(false);
    const latest = useRef(props);
    latest.current = props;
    const id = useId();
    const path = props.path;
    const readOnly = props.readOnly || !!props.emptyUntilSaved;
    const label = props.label || "업무 문서";
    const current = documents.find((doc) => doc.id === selected);
    const listState = useRef({
      busy,
      renaming,
      renamePending,
      confirmDelete,
      key: "",
    });
    listState.current = {
      busy,
      renaming,
      renamePending,
      confirmDelete,
      key: documents.map((doc) => `${doc.id}:${doc.title}`).join("|"),
    };
    useResourceSync(props.emptyUntilSaved ? null : path, async (signal) => {
      if (busy || renaming || renamePending || confirmDelete) return false;
      const before = listState.current.key;
      const result = await api<{ documents: DocumentInfo[] }>(path, { signal });
      if (signal.aborted) return true;
      const state = listState.current;
      if (
        state.key !== before ||
        state.busy ||
        state.renaming ||
        state.renamePending ||
        state.confirmDelete
      )
        return false;
      // Preserve an open removed page and its local draft until the user leaves;
      // its body stream shows the existing access/deletion error.
      setDocuments((previous) => {
        const removed = previous.filter(
          (item) =>
            visited.includes(item.id) &&
            !result.documents.some((doc) => doc.id === item.id),
        );
        return [...result.documents, ...removed];
      });
      if (!selected && result.documents.length) {
        setSelected(result.documents[0].id);
        setVisited((previous) => [
          ...new Set([...previous, result.documents[0].id]),
        ]);
      }
      if (
        result.documents.length &&
        (props.inline || result.documents.some((doc) => doc.hasContent))
      ) {
        setOpened(true);
        const target = result.documents.some((doc) => doc.id === selected)
          ? selected
          : result.documents[0].id;
        setVisited((previous) => [...new Set([...previous, target])]);
      }
      return true;
    });
    const documentOrder = documents.map((doc) => doc.id).join(":");
    const inlineDocumentsVisible =
      !!props.inline && documentsLoaded && documents.length > 0;
    const tabReorder = useListReorder<HTMLDivElement>(
      documents.map((doc) => doc.id),
      (documentId, targetId, placement) =>
        void moveDocument(documentId, targetId, placement),
      !props.inline || readOnly || busy || !!renaming || documents.length < 2,
      "horizontal",
    );
    const tabScroll = tabReorder.root;
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
          setMenu(null);
      };
      let focusFrame = 0;
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          focusFrame = requestAnimationFrame(() => {
            if (!menuRoot.current?.contains(document.activeElement))
              setMenu(null);
          });
          return;
        }
        if (event.key !== "Escape" || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
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
      setDocumentsLoaded(false);
      const request = props.emptyUntilSaved
        ? Promise.resolve({ documents: [initialDocument] })
        : api<{ documents: DocumentInfo[] }>(path, {
            signal: controller.signal,
          });
      void request
        .then((result) => {
          if (controller.signal.aborted) return;
          setDocuments(result.documents);
          setDocumentsLoaded(true);
          const draft = result.documents.find((doc) =>
            readDocumentDraft(latest.current.draftKey(doc.id)),
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
            result.documents.some((doc) => doc.hasContent) ||
            (!!props.inline && result.documents.length > 0);
          setSelected(
            (previous) =>
              requested ||
              draft?.id ||
              (result.documents.some((doc) => doc.id === previous)
                ? previous
                : result.documents[0]?.id || ""),
          );
          if (shouldOpen) {
            setOpened(true);
            setVisited((previous) => [
              ...new Set([
                ...previous,
                requested || draft?.id || result.documents[0]?.id || "",
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
    }, [path, props.emptyUntilSaved, attempt]);
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
    }, [opened, selected, documentOrder]);
    function scrollToDocument(documentId: string) {
      const rail = documentScroll.current;
      const page = document.getElementById(`${id}-${documentId}-page`);
      if (!rail || !page) return;
      rail.scrollTo({
        left:
          rail.scrollLeft +
          page.getBoundingClientRect().left -
          rail.getBoundingClientRect().left -
          12,
      });
    }
    useLayoutEffect(() => {
      if (props.inline && navigateDocument.current) scrollToDocument(selected);
    }, [selected, documentOrder, props.inline]);
    useLayoutEffect(() => {
      if (!inlineDocumentsVisible) return;
      const grid = documentScroll.current?.closest(".sheet-scroll");
      grid?.scrollTo({ top: grid.scrollHeight });
    }, [inlineDocumentsVisible]);
    useEffect(() => {
      const rail = documentScroll.current;
      if (!props.inline || !rail) return;
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .map((entry) => (entry.target as HTMLElement).dataset.documentId!);
          if (visible.length)
            setVisited((previous) => {
              const next = [...new Set([...previous, ...visible])];
              return next.length === previous.length ? previous : next;
            });
        },
        { root: rail, rootMargin: "0px 120px" },
      );
      rail
        .querySelectorAll("[data-document-id]")
        .forEach((page) => observer.observe(page));
      return () => observer.disconnect();
    }, [props.inline, documents.length]);
    useLayoutEffect(() => {
      if (!focusEditor.current || loading[selected] !== false) return;
      const editor = document
        .getElementById(`${id}-${selected}-page`)
        ?.querySelector<HTMLElement>(
          '[contenteditable="true"], textarea:not([readonly])',
        );
      if (editor) {
        editor.focus({ preventScroll: true });
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
    async function select(documentId: string, navigate = true) {
      if (busy || !(await finishRename())) return false;
      if (!documents.some((doc) => doc.id === documentId)) return false;
      if (documentId === selected) {
        if (props.inline && navigate) scrollToDocument(documentId);
        return true;
      }
      const handle = handles.current.get(selected);
      if (handle && !(await handle.flush())) return false;
      navigateDocument.current = navigate;
      setSelected(documentId);
      setVisited((previous) =>
        previous.includes(documentId) ? previous : [...previous, documentId],
      );
      setMenu(null);
      setConfirmDelete(false);
      setError("");
      return true;
    }
    function changed(result: ListResult) {
      setDocuments(result.documents);
      props.onListChanged(result);
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
        setOpened(true);
        focusEditor.current = !!props.inline;
        navigateDocument.current = true;
        setSelected(documentId);
        setVisited((previous) => [...new Set([...previous, documentId])]);
        createId.current = null;
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setBusy(false);
      }
    }
    async function moveDocument(
      documentId: string,
      targetId: string,
      placement: Placement,
    ) {
      if (!props.inline || readOnly || busy || !(await finishRename())) return;
      const next = reorderItems(documents, documentId, targetId, placement);
      if (next.every((doc, index) => doc.id === documents[index].id)) return;
      setBusy(true);
      setError("");
      try {
        for (const handle of handles.current.values())
          if (!(await handle.flush())) return;
        const result = await send<ListResult>(`${path}/reorder`, {
          ids: next.map((doc) => doc.id),
          expectedIds: documents.map((doc) => doc.id),
        });
        navigateDocument.current = true;
        changed(result);
        setSelected(documentId);
        setVisited((previous) => [...new Set([...previous, documentId])]);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.details?.documents
        )
          setDocuments(error.details.documents);
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
      setMenu(null);
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
        if (props.inline && !result.documents.length) setOpened(false);
        setVisited((previous) => [
          ...new Set([
            ...previous.filter((docId) => docId !== selected),
            result.documents[0]?.id || "",
          ]),
        ]);
        setSelected(result.documents[0]?.id || "");
        setConfirmDelete(false);
        // Recreating the implicit first document must not reuse the deleted editor.
        setLoading((previous) => ({ ...previous, [selected]: true }));
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setBusy(false);
      }
    }
    function documentMenu(doc: DocumentInfo) {
      if (readOnly) return null;
      const expanded = menu === doc.id;
      return (
        <div
          className="document-tab-menu"
          ref={expanded ? menuRoot : undefined}
        >
          <Button
            ref={expanded ? menuTrigger : undefined}
            tooltip={props.inline ? `${doc.title} 메뉴` : "문서 메뉴"}
            aria-haspopup="menu"
            aria-controls={expanded ? `${id}-menu` : undefined}
            aria-expanded={expanded}
            disabled={busy}
            onClick={() => {
              if (expanded) setMenu(null);
              else
                void select(doc.id, false).then((saved) => {
                  if (saved) setMenu(doc.id);
                });
            }}
          >
            {props.inline ? (
              <ChevronDown size={14} />
            ) : (
              <MoreHorizontal size={16} />
            )}
          </Button>
          {expanded && (
            <div id={`${id}-menu`} role="menu" aria-label="문서 메뉴">
              <button
                type="button"
                role="menuitem"
                onClick={() => void startRename(doc)}
              >
                <Pencil size={14} />
                문서 이름 변경
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setConfirmDelete(true);
                  setMenu(null);
                }}
              >
                <Trash2 size={14} />
                문서 삭제
              </button>
            </div>
          )}
        </div>
      );
    }
    if (!opened && !props.inline)
      return (
        <section
          className={`task-documents ${props.inline ? "annual-memos" : ""}`}
          aria-label={`${label} 목록`}
          onKeyDown={(event) => event.stopPropagation()}
          onCopy={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
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
        className={`task-documents ${props.inline ? "annual-memos" : ""}`}
        aria-label={`${label} 목록`}
        onKeyDown={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
      >
        <div className="document-tabs" ref={tablist}>
          {props.inline && props.leading}
          <div
            className="document-tablist"
            ref={tabScroll}
            role="tablist"
            aria-label={label}
          >
            {documents.map((doc, index) => (
              <div
                className="document-tab-item"
                key={doc.id}
                {...(props.inline ? tabReorder.itemProps(doc.id) : {})}
              >
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
                    onPointerDown={
                      props.inline
                        ? tabReorder.handleProps(doc.id).onPointerDown
                        : undefined
                    }
                    onClickCapture={
                      props.inline
                        ? tabReorder.handleProps(doc.id).onClickCapture
                        : undefined
                    }
                    onClick={() => void select(doc.id)}
                    onDoubleClick={() => void startRename(doc)}
                    onKeyDown={(event) => {
                      if (props.inline) {
                        tabReorder.handleProps(doc.id).onKeyDown(event);
                        if (event.defaultPrevented) return;
                      }
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
              tooltip={props.inline ? "메모 추가" : "문서 추가"}
              className={props.inline ? "memo-add-document" : undefined}
              disabled={
                busy ||
                (props.inline && !documentsLoaded) ||
                documents.length >= MAX_TASK_DOCUMENTS
              }
              onClick={() => void add()}
            >
              <Plus size={16} />
            </Button>
          )}
          <div className="document-tab-actions">
            {!props.inline && <div ref={setControlsTarget} />}
            {!props.inline && current && documentMenu(current)}
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
        {(!documentsLoaded || !documents.length) && error && (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            문서 다시 불러오기
          </Button>
        )}
        <div
          className={props.inline ? "memo-documents" : "document-pages"}
          ref={documentScroll}
        >
          {documents
            .filter((doc) => props.inline || visited.includes(doc.id))
            .map((doc) => (
              <DocumentPage
                key={`${doc.id}:${epochs[doc.id] || 0}`}
                pageId={`${id}-${doc.id}-page`}
                tabId={`${id}-${doc.id}-tab`}
                documentId={doc.id}
                title={doc.title}
                menu={props.inline ? documentMenu(doc) : null}
                widthKey={`${props.draftKey(doc.id)}:width`}
                inline={!!props.inline}
                selected={selected === doc.id}
                loading={loading[doc.id] !== false}
                controlsTarget={selected === doc.id ? controlsTarget : null}
                onSelect={() => void select(doc.id, false)}
              >
                {(pageControls) => (
                  <>
                    {loading[doc.id] !== false && <DocumentLoading />}
                    {visited.includes(doc.id) && (
                      <DocumentEditor
                        path={`${path}/${doc.id}`}
                        draftKey={props.draftKey(doc.id)}
                        label={label}
                        readOnly={readOnly}
                        live={selected === doc.id}
                        onRemoteDocument={(result) => {
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
                          const metadata = result as DocumentResult;
                          // Conflict responses contain the body but no task summary.
                          if (
                            typeof metadata.hasDocument === "boolean" &&
                            typeof metadata.documentCount === "number" &&
                            typeof metadata.taskUpdatedAt === "string"
                          )
                            props.onSaved(metadata);
                        }}
                        emptyUntilSaved={props.emptyUntilSaved}
                        saveDocument={async (input) => {
                          const result = await send<DocumentResult>(
                            `${path}/${doc.id}`,
                            input,
                            "PUT",
                          );
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
                          return result;
                        }}
                        controlsTarget={pageControls}
                        onCloseWithDraft={
                          props.onCloseWithDraft
                            ? () =>
                                void finishRename().then((saved) => {
                                  if (saved) props.onCloseWithDraft?.();
                                })
                            : undefined
                        }
                        ref={(handle) => {
                          if (handle) handles.current.set(doc.id, handle);
                          else handles.current.delete(doc.id);
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
                    )}
                  </>
                )}
              </DocumentPage>
            ))}
        </div>
      </section>
    );
  },
);

function DocumentPage({
  pageId,
  tabId,
  documentId,
  title,
  menu,
  widthKey,
  inline,
  selected,
  loading,
  controlsTarget,
  onSelect,
  children,
}: {
  pageId: string;
  tabId: string;
  documentId: string;
  title: string;
  menu: ReactNode;
  widthKey: string;
  inline: boolean;
  selected: boolean;
  loading: boolean;
  controlsTarget: HTMLDivElement | null;
  onSelect: () => void;
  children: (controls: HTMLDivElement | null) => ReactNode;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey));
      return saved >= 280 && saved <= 2400 ? saved : 800;
    } catch {
      return 800;
    }
  });
  const resize = useRef<{
    x: number;
    width: number;
    previous: number;
    scale: number;
  } | null>(null);
  const currentWidth = useRef(width);
  currentWidth.current = width;
  function updateWidth(value: number, save = false) {
    const next = Math.max(280, Math.min(2400, Math.round(value)));
    currentWidth.current = next;
    setWidth(next);
    if (save) {
      try {
        localStorage.setItem(widthKey, String(next));
      } catch {
        /* retain this session's width */
      }
    }
  }
  const [cardControls, setCardControls] = useState<HTMLDivElement | null>(null);
  return (
    <div
      className={`document-page ${inline ? "memo-document-card" : ""}`}
      id={pageId}
      style={
        inline ? ({ "--memo-width": `${width}px` } as CSSProperties) : undefined
      }
      role="tabpanel"
      aria-labelledby={tabId}
      hidden={!inline && !selected}
      data-document-id={documentId}
      data-selected={selected || undefined}
      data-loading={loading || undefined}
      onFocusCapture={inline ? onSelect : undefined}
      onPointerDownCapture={inline ? onSelect : undefined}
    >
      {inline && (
        <div className="memo-document-heading">
          <span className="memo-document-title" title={title}>
            {title}
          </span>
          {menu}
          <div className="memo-document-controls" ref={setCardControls} />
        </div>
      )}
      {inline ? (
        <div className="memo-document-body" data-loading={loading || undefined}>
          {children(cardControls)}
        </div>
      ) : (
        children(controlsTarget)
      )}
      {inline && (
        <div
          className="memo-width-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={`${title} 너비`}
          aria-valuemin={280}
          aria-valuemax={2400}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            const card = event.currentTarget.parentElement!;
            const box = card.getBoundingClientRect();
            const scale = box.width / card.offsetWidth || 1;
            resize.current = {
              x: event.clientX,
              width: box.width / scale,
              previous: width,
              scale,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = resize.current;
            if (drag)
              updateWidth(drag.width + (event.clientX - drag.x) / drag.scale);
          }}
          onPointerUp={(event) => {
            if (!resize.current) return;
            resize.current = null;
            updateWidth(currentWidth.current, true);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            if (resize.current) updateWidth(resize.current.previous);
            resize.current = null;
          }}
          onPointerCancel={() => {
            if (resize.current) updateWidth(resize.current.previous);
            resize.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && resize.current) {
              updateWidth(resize.current.previous);
              resize.current = null;
            }
            const delta = event.shiftKey ? 100 : 20;
            const value =
              event.key === "ArrowLeft"
                ? width - delta
                : event.key === "ArrowRight"
                  ? width + delta
                  : event.key === "Home"
                    ? 280
                    : event.key === "End"
                      ? 2400
                      : null;
            if (value === null) return;
            event.preventDefault();
            event.stopPropagation();
            updateWidth(value, true);
          }}
        />
      )}
    </div>
  );
}
