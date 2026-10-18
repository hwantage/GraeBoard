import {
  Component,
  forwardRef,
  lazy,
  Suspense,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "./api";
import DocumentModeToggle, { type DocumentMode } from "./DocumentModeToggle";
import { MAX_IMAGE_BYTES } from "../shared/document-images.js";
import { MAX_DOCUMENT_BYTES, documentBytes } from "../shared/task-documents.js";
import type { TaskDocument } from "./types";
import "./task-document.css";

const RichMarkdownEditor = lazy(() => import("./RichMarkdownEditor"));
class EditorBoundary extends Component<
  { children: ReactNode; onSource: () => void; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        리치 편집기를 불러오지 못했습니다.{" "}
        <button onClick={this.props.onSource}>Markdown 원문 열기</button>
      </p>
    ) : (
      this.props.children
    );
  }
}
export type DocumentHandle = {
  flush: () => Promise<boolean>;
  persistDraft: () => boolean;
};
export type DocumentWrite = {
  markdown: string;
  expectedRevision: number | string;
  operationId: string;
};
export type SharedDocumentEditorProps = {
  path: string;
  draftKey: string;
  label?: string;
  controlsTarget: HTMLDivElement | null;
  readOnly: boolean;
  emptyUntilSaved?: boolean;
  saveDocument: (input: DocumentWrite) => Promise<TaskDocument>;
  onCloseWithDraft: () => void;
  onLoadingChange: (loading: boolean) => void;
};
type LocalDraft = {
  markdown: string;
  base: TaskDocument;
  operationId?: string;
  submitted?: string;
};
const blank: TaskDocument = { markdown: "", revision: 0, updatedAt: null };
export function readDocumentDraft(key: string): LocalDraft | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      typeof saved?.markdown === "string" &&
      typeof saved.base?.markdown === "string" &&
      (Number.isSafeInteger(saved.base.revision) ||
        typeof saved.base.revision === "string")
    )
      return saved;
  } catch {
    // Invalid or unavailable local storage must not prevent server loading.
  }
  return null;
}

export default forwardRef<DocumentHandle, SharedDocumentEditorProps>(
  function DocumentEditor(props, ref) {
    const [markdown, setMarkdown] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [editorReady, setEditorReady] = useState(false);
    const [editorFailed, setEditorFailed] = useState(false);
    const [mode, setMode] = useState<"rich" | "source">("rich");
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [status, setStatus] = useState("문서를 불러오고 있습니다…");
    const [conflict, setConflict] = useState<TaskDocument | null>(null);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [uploadCount, setUploadCount] = useState(0);
    const loading = !loaded
      ? !error
      : mode === "rich" && !editorReady && !editorFailed;
    useLayoutEffect(() => {
      props.onLoadingChange(loading);
    }, [loading, props.onLoadingChange]);
    function changeMode(value: DocumentMode) {
      if (value === "rich" && mode !== value) {
        setEditorReady(false);
        setEditorFailed(false);
      }
      setMode(value);
    }
    const uploads = useRef(0);
    const docReadOnly = props.readOnly || !!props.emptyUntilSaved;
    const readOnlyRef = useRef(docReadOnly);
    readOnlyRef.current = docReadOnly;
    const latest = useRef(props);
    latest.current = props;
    const mounted = useRef(true);
    const composing = useRef(false);
    const current = useRef<LocalDraft>({ markdown: "", base: blank });
    const initialized = useRef(false);
    const blocked = useRef(false);
    const saving = useRef<Promise<boolean> | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const storageKey = props.draftKey;
    const path = props.path;
    const label = props.label || "업무 문서";
    function persist() {
      try {
        if (current.current.markdown === current.current.base.markdown)
          sessionStorage.removeItem(storageKey);
        else
          sessionStorage.setItem(storageKey, JSON.stringify(current.current));
        return true;
      } catch {
        if (mounted.current)
          setNotice(
            "브라우저에 임시 보관할 공간이 부족합니다. 저장 완료를 확인하거나 원문을 복사해 보관하세요.",
          );
        return false;
      }
    }
    function change(value: string) {
      if (!initialized.current || readOnlyRef.current) return;
      current.current.markdown = value;
      setMarkdown(value);
      persist();
      if (!blocked.current)
        setStatus(
          value === current.current.base.markdown ? "저장됨" : "저장 대기",
        );
      schedule();
    }
    function schedule() {
      if (timer.current) clearTimeout(timer.current);
      if (!composing.current && !blocked.current)
        timer.current = setTimeout(() => void flush(), 700);
    }
    async function flush(explicit = false): Promise<boolean> {
      if (timer.current) clearTimeout(timer.current);
      if (composing.current || uploads.current) return false;
      if (saving.current) {
        const success = await saving.current;
        return success ? flush(explicit) : false;
      }
      if (
        !initialized.current ||
        current.current.markdown === current.current.base.markdown
      )
        return true;
      if (latest.current.readOnly || blocked.current) return false;
      const state = current.current;
      if (documentBytes(state.markdown) > MAX_DOCUMENT_BYTES) {
        setError(
          "문서는 UTF-8 기준 256KiB까지 저장할 수 있습니다. 입력은 유지됩니다. 내용을 줄인 뒤 다시 저장하세요.",
        );
        setStatus("저장하지 못함");
        blocked.current = true;
        return false;
      }
      const submitted = state.markdown;
      const operationId =
        state.submitted === submitted && state.operationId
          ? state.operationId
          : crypto.randomUUID();
      state.submitted = submitted;
      state.operationId = operationId;
      persist();
      setStatus("저장 중…");
      const request = (async () => {
        try {
          const result = await latest.current.saveDocument({
            markdown: submitted,
            expectedRevision: state.base.revision,
            operationId,
          });
          // Keep edits typed during the request. Only the saved base advances.
          state.base = {
            markdown: result.markdown,
            revision: result.revision,
            updatedAt: result.updatedAt,
          };
          state.operationId = undefined;
          state.submitted = undefined;
          persist();
          if (mounted.current) {
            setStatus(state.markdown === submitted ? "저장됨" : "저장 대기");
            setError("");
            setConflict(null);
          }
          return true;
        } catch (e) {
          blocked.current = true;
          persist();
          if (mounted.current) {
            setError((e as Error).message);
            setStatus("저장하지 못함 · 입력 보존됨");
            if (e instanceof ApiError && e.status === 409 && e.details?.current)
              setConflict(e.details.current);
          }
          return false;
        } finally {
          saving.current = null;
        }
      })();
      saving.current = request;
      const success = await request;
      return success && mounted.current ? flush(explicit) : success;
    }
    useImperativeHandle(ref, () => ({
      flush: () => flush(),
      persistDraft: () => !composing.current && !uploads.current && persist(),
    }));
    useEffect(() => {
      mounted.current = true;
      initialized.current = false;
      setLoaded(false);
      setError("");
      setEditorReady(false);
      setEditorFailed(false);
      const controller = new AbortController();
      const local = props.emptyUntilSaved
        ? Promise.resolve(blank)
        : api<TaskDocument>(path, { signal: controller.signal });
      void local
        .then((data) => {
          if (controller.signal.aborted) return;
          const restored = readDocumentDraft(storageKey);
          current.current = restored || { markdown: data.markdown, base: data };
          if (
            restored &&
            restored.markdown !== data.markdown &&
            restored.base.markdown !== data.markdown
          ) {
            blocked.current = true;
            setConflict(data);
            setError(
              "보관된 입력과 서버 문서가 다릅니다. 최신 문서와 비교한 뒤 저장하세요.",
            );
          } else {
            current.current.base = data;
            blocked.current = false;
            setError("");
          }
          if (
            props.readOnly &&
            restored &&
            restored.markdown !== data.markdown
          ) {
            blocked.current = true;
            setError(
              "현재는 읽기 전용입니다. 보관된 입력을 복사하거나 초안을 보관하고 닫아 주세요.",
            );
          }
          initialized.current = true;
          setMarkdown(current.current.markdown);
          setLoaded(true);
          setStatus(
            restored && restored.markdown !== data.markdown
              ? "미저장 입력 복원됨"
              : "저장됨",
          );
          persist();
          if (restored && !blocked.current) schedule();
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError((e as Error).message);
            setStatus("문서를 불러오지 못함");
          }
        });
      return () => {
        mounted.current = false;
        controller.abort();
        if (timer.current) clearTimeout(timer.current);
      };
    }, [path, props.emptyUntilSaved, loadAttempt]);
    useEffect(() => {
      const beforeUnload = (event: BeforeUnloadEvent) => {
        if (
          initialized.current &&
          current.current.markdown !== current.current.base.markdown
        ) {
          persist();
          event.preventDefault();
          event.returnValue = "";
        }
      };
      window.addEventListener("beforeunload", beforeUnload);
      return () => window.removeEventListener("beforeunload", beforeUnload);
    }, []);
    async function retry() {
      blocked.current = false;
      setError("");
      await flush();
    }
    async function uploadImage(file: File, signal: AbortSignal) {
      if (readOnlyRef.current)
        throw new Error("문서 수정 상태에서 이미지를 붙여넣어 주세요.");
      if (file.size > MAX_IMAGE_BYTES)
        throw new Error("이미지는 파일당 10MiB까지 붙여넣을 수 있습니다.");
      const body = new FormData();
      body.append("image", file);
      const result = await api<{ url: string }>(path + "/images", {
        method: "POST",
        body,
        signal,
      });
      return result.url;
    }
    function uploading(count: number) {
      uploads.current = count;
      if (mounted.current) setUploadCount(count);
    }
    const saveState = uploadCount
      ? "이미지 업로드 중…"
      : docReadOnly
        ? "읽기 전용"
        : status;
    const saveStatus = (
      <span
        className="document-save-state"
        role="status"
        aria-live="polite"
        title={saveState}
      >
        {saveState}
      </span>
    );
    return (
      <section
        className="task-document"
        data-mode={mode}
        aria-label={label}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void flush();
          }
          e.stopPropagation();
        }}
        onCopy={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onCut={(e) => e.stopPropagation()}
        onCompositionStart={() => {
          composing.current = true;
          if (timer.current) clearTimeout(timer.current);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          schedule();
        }}
      >
        {props.controlsTarget &&
          createPortal(
            <div className="document-controls">
              {(mode === "source" || docReadOnly || editorFailed) && saveStatus}
              <DocumentModeToggle
                mode={mode}
                disabled={!!uploadCount}
                onChange={(value) => {
                  if (composing.current) return;
                  setNotice("");
                  changeMode(value);
                }}
              />
            </div>,
            props.controlsTarget,
          )}
        <div className="document-current">
          {props.emptyUntilSaved && (
            <p className="document-notice">
              업무를 저장하고 있습니다. 저장이 끝나면 문서를 작성할 수 있습니다.
            </p>
          )}
          {error && (
            <div className="document-error" role="alert">
              <p>{error}</p>
              {!loaded ? (
                <button
                  type="button"
                  onClick={() => setLoadAttempt((n) => n + 1)}
                >
                  문서 다시 불러오기
                </button>
              ) : (
                !conflict &&
                !docReadOnly && (
                  <button type="button" onClick={() => void retry()}>
                    저장 다시 시도
                  </button>
                )
              )}
              {loaded && (
                <button
                  type="button"
                  onClick={() => {
                    if (persist()) props.onCloseWithDraft();
                  }}
                >
                  초안 보관하고 닫기
                </button>
              )}
            </div>
          )}
          {conflict && (
            <div className="document-conflict">
              <details>
                <summary>최신 서버 문서 확인 (내 입력은 아래에 유지)</summary>
                <pre>{conflict.markdown || "빈 문서"}</pre>
              </details>
              {!docReadOnly && (
                <button
                  type="button"
                  onClick={() => {
                    current.current.base = conflict;
                    current.current.operationId = undefined;
                    current.current.submitted = undefined;
                    setConflict(null);
                    void retry();
                  }}
                >
                  내 입력으로 최신 문서 교체
                </button>
              )}
            </div>
          )}
          {notice && (
            <p className="document-notice" role="status">
              {notice}
            </p>
          )}
          {loaded &&
            (mode === "source" ? (
              <textarea
                className="document-source"
                aria-label={`${label} Markdown 원문`}
                spellCheck={false}
                readOnly={docReadOnly}
                value={markdown}
                onChange={(e) => change(e.target.value)}
                placeholder={`# ${label}\n\n배경, 결정 사항, 진행 내용을 남겨 보세요.`}
              />
            ) : (
              <EditorBoundary
                onSource={() => changeMode("source")}
                onError={() => setEditorFailed(true)}
              >
                <Suspense fallback={null}>
                  <RichMarkdownEditor
                    label={`${label} 리치 편집`}
                    initialMarkdown={current.current.markdown}
                    readOnly={docReadOnly}
                    saveStatus={saveStatus}
                    onChange={change}
                    onUpload={uploadImage}
                    onUploading={uploading}
                    onReady={() => setEditorReady(true)}
                    onUnsupported={(message) => {
                      setNotice(message);
                      setMode("source");
                    }}
                  />
                </Suspense>
              </EditorBoundary>
            ))}
        </div>
      </section>
    );
  },
);
