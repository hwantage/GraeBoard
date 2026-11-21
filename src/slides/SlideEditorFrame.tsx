import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ArrowLeft, Save } from "lucide-react";
import { ApiError } from "../platform/api";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import LoadingState from "../ui/LoadingState";
import { Modal } from "../ui/Modal";
import {
  SLIDE_FRAME_SCOPE_PARAM,
  SLIDE_FRAME_SESSION_PARAM,
  slideRecoveryScope,
} from "../../shared/slides/slide-frame-protocol.js";
import {
  MAX_SLIDE_TITLE_LENGTH,
  slideTitleProblem,
} from "../../shared/slides/slide-file-rules.js";
import {
  createSlideFile,
  createSlideShare,
  readSlideFile,
  readSlideShare,
  saveSlideFile,
  slideRequestId,
  type SlideEditorBuild,
  type SlideFile,
} from "./slide-file-api";
import {
  SlideFrameBridge,
  SlideShownError,
  type SlideEditorState,
} from "./slide-frame-bridge";

export type SlideEditorStart =
  | { kind: "file"; fileId: string }
  | { kind: "new"; title: string }
  | { kind: "share"; shareId: string };
export type SlideEditorHandle = { leave: () => Promise<boolean> };

type SaveTarget = { kind: "team"; title: string } | { kind: "device" } | null;
type ConflictChoice =
  { kind: "copy"; title: string } | { kind: "reload" } | null;
type LeaveChoice = "save" | "discard" | null;
type Dialog =
  | {
      kind: "save-target";
      name: string;
      bound: boolean;
      resolve: (value: SaveTarget) => void;
    }
  | {
      kind: "conflict";
      title: string;
      resolve: (value: ConflictChoice) => void;
    }
  | { kind: "leave"; resolve: (value: LeaveChoice) => void };

const target = (file: SlideFile) => ({
  teamId: file.teamId,
  fileId: file.id,
  revision: file.revision,
  title: file.title,
});
const transient = (error: unknown) =>
  error instanceof ApiError && (error.status === 0 || error.status >= 500);
// The same request ID is sent again, so a save the server already stored is
// answered with that result instead of being applied twice.
async function withRetry<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (!transient(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return run();
  }
}
// The editor's share dialog shows its own text for these codes.
function shareCode(error: unknown) {
  const status = error instanceof ApiError ? error.status : -1;
  return status === 413
    ? "tooLarge"
    : status === 404
      ? "missing"
      : status === 400
        ? "invalid"
        : status === 429
          ? "quota"
          : status === 0
            ? "network"
            : "unavailable";
}

export default function SlideEditorFrame({
  ref,
  editor,
  teamId,
  userId,
  canWrite,
  start,
  onClose,
  onSaved,
}: {
  ref?: Ref<SlideEditorHandle>;
  editor: SlideEditorBuild;
  teamId: string;
  userId: string;
  canWrite: boolean;
  start: SlideEditorStart;
  onClose: () => void;
  onSaved: (file: SlideFile) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<SlideFrameBridge | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<SlideEditorState | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [writingTeamFile, setWritingTeamFile] = useState(false);
  const [titleDraft, setTitleDraft] = useState<{
    session: number;
    name: string;
  } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const live = useRef({ canWrite, onSaved, start });
  live.current = { canWrite, onSaved, start };
  const session = useMemo(() => crypto.randomUUID(), []);
  const source = useMemo(() => {
    const query = new URLSearchParams({
      [SLIDE_FRAME_SESSION_PARAM]: session,
      [SLIDE_FRAME_SCOPE_PARAM]: slideRecoveryScope([userId, teamId]),
    });
    if (start.kind === "share") query.set("share", start.shareId);
    return `${editor.path}?${query}`;
    // The frame is created once per editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.path, session, teamId, userId]);

  const ask = <T,>(make: (resolve: (value: T) => void) => Dialog) =>
    new Promise<T>((resolve) =>
      setDialog(
        make((value) => {
          setDialog(null);
          resolve(value);
        }),
      ),
    );
  const fail = (failure: unknown) => {
    const message = (failure as Error).message;
    setError(message);
    return new SlideShownError(message);
  };
  const stored = (file: SlideFile) => {
    setError("");
    live.current.onSaved(file);
    return target(file);
  };
  async function openFile(fileId: string, discard = false) {
    const file = await readSlideFile(teamId, fileId);
    const result = await bridge.current!.request<{ outcome: string }>("open", {
      teamId,
      fileId,
      ...file,
      discard,
    });
    return result.outcome;
  }
  async function begin() {
    const first = live.current.start;
    try {
      if (first.kind === "file") {
        const outcome = await openFile(first.fileId);
        if (outcome !== "replaced" && outcome !== "declined")
          throw new Error("자료를 열지 못했습니다. 다시 시도하세요.");
      } else if (first.kind === "new")
        await bridge.current!.request("new", { teamId, title: first.title });
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  useEffect(() => {
    const created = new SlideFrameBridge(
      () => frame.current?.contentWindow ?? null,
      session,
      {
        async save({
          fileId,
          baseRevision,
          baseTitle,
          title,
          requestId,
          bytes,
        }) {
          if (!live.current.canWrite)
            throw fail(
              new Error(
                "이 팀의 자료를 저장할 권한이 없습니다. 다른 이름으로 저장에서 이 기기에 내려받을 수 있습니다.",
              ),
            );
          setWritingTeamFile(true);
          try {
            return stored(
              await withRetry(() =>
                saveSlideFile(
                  teamId,
                  fileId,
                  baseRevision,
                  bytes,
                  requestId,
                  baseTitle === undefined ? undefined : { title, baseTitle },
                ),
              ),
            );
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.status !== 409)
              throw fail(failure);
            const current = failure.details?.current as SlideFile | undefined;
            const choice = await ask<ConflictChoice>((resolve) => ({
              kind: "conflict",
              title: current?.title || "",
              resolve,
            }));
            if (choice?.kind === "copy")
              try {
                return stored(
                  await createSlideFile(
                    teamId,
                    choice.title,
                    bytes,
                    slideRequestId(),
                  ),
                );
              } catch (copyFailure) {
                throw fail(copyFailure);
              }
            if (choice?.kind === "reload")
              // After this answer the editor still holds the unsaved work; the
              // author chose to replace it with the team's newer file.
              setTimeout(
                () =>
                  void openFile(fileId, true).catch((failure) =>
                    setError((failure as Error).message),
                  ),
              );
            return null;
          } finally {
            setWritingTeamFile(false);
          }
        },
        async create({ requestId, title, bytes }) {
          if (!live.current.canWrite)
            throw fail(new Error("이 팀에 자료를 만들 권한이 없습니다."));
          setWritingTeamFile(true);
          try {
            return stored(
              await withRetry(() =>
                createSlideFile(teamId, title, bytes, requestId),
              ),
            );
          } catch (failure) {
            throw fail(failure);
          } finally {
            setWritingTeamFile(false);
          }
        },
        "save-target": ({ name, bound }) =>
          ask<SaveTarget>((resolve) => ({
            kind: "save-target",
            name,
            bound,
            resolve,
          })),
        async "share-create"({ body }) {
          try {
            const { id } = await createSlideShare(teamId, body);
            const url = new URL("/slides", location.origin);
            url.searchParams.set("team", teamId);
            url.searchParams.set("share", id);
            return { id, url: url.href };
          } catch (failure) {
            throw new Error(shareCode(failure));
          }
        },
        async "share-read"({ id }) {
          try {
            return await readSlideShare(teamId, id);
          } catch (failure) {
            throw new Error(shareCode(failure));
          }
        },
      },
      {
        ready(next) {
          setState(next);
          void begin().finally(() => {
            if (bridge.current === created) setReady(true);
          });
        },
        state: setState,
      },
    );
    bridge.current = created;
    return () => {
      created.dispose();
      bridge.current = null;
    };
    // One bridge per frame; the handlers read current props through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, teamId]);

  async function save() {
    if (!bridge.current || saving) return false;
    setSaving(true);
    try {
      const result = await bridge.current.request<
        SlideEditorState & { saved: boolean }
      >("save");
      return result.saved && !result.dirty;
    } catch (failure) {
      // The save handlers already showed their own failures.
      if (!error) setError((failure as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function leave() {
    if (!bridge.current || !ready) return true;
    const current = await bridge.current
      .request<SlideEditorState>("state", {}, 3000)
      .catch(() => null);
    if (!current?.dirty) return true;
    const choice = await ask<LeaveChoice>((resolve) => ({
      kind: "leave",
      resolve,
    }));
    if (choice === "save") return save();
    if (choice !== "discard") return false;
    await bridge.current?.request("discard", {}, 3000).catch(() => {});
    return true;
  }
  useImperativeHandle(ref, () => ({ leave }));

  const dirty = !!state?.dirty;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const binding = state?.binding ?? null;
  function canSave(current: SlideEditorState | null) {
    return (
      ready &&
      !saving &&
      !writingTeamFile &&
      !!current &&
      (current.dirty || current.binding?.fileId === null) &&
      (!current.binding || (canWrite && !slideTitleProblem(current.name)))
    );
  }
  function rename(name: string) {
    if (!state || !binding || !canWrite) return;
    void bridge.current
      ?.request("rename", { name, documentSession: state.documentSession })
      .catch((failure) => setError((failure as Error).message));
  }
  // Ctrl/Cmd+S pressed on GraeBoard's own bar saves the open document too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        // A keystroke in the title can still be on its way to the frame.
        void bridge.current
          ?.request<SlideEditorState>("state")
          .then((current) => {
            if (canSave(current)) return save();
          })
          .catch((failure) => setError((failure as Error).message));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <section className="slide-editor" aria-label="CanvaSlide 편집기">
      <header className="slide-editor-bar">
        <Button title="팀 자료 목록" onClick={onClose}>
          <ArrowLeft size={15} />
          <span>목록</span>
        </Button>
        {ready && state && binding && canWrite ? (
          <input
            key={state.documentSession}
            className="slide-editor-title"
            aria-label="자료 제목"
            value={
              titleDraft?.session === state.documentSession
                ? titleDraft.name
                : state.name
            }
            onBlur={() => setTitleDraft(null)}
            maxLength={MAX_SLIDE_TITLE_LENGTH}
            onChange={(event) => {
              setTitleDraft({
                session: state.documentSession,
                name: event.currentTarget.value,
              });
              if (!(event.nativeEvent as InputEvent).isComposing)
                rename(event.currentTarget.value);
            }}
            onCompositionEnd={(event) => rename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                event.currentTarget.blur();
            }}
          />
        ) : (
          <strong className="slide-editor-title">
            {state?.name || "CanvaSlide"}
          </strong>
        )}
        {ready && state && !binding && (
          <span className="tag">이 기기의 문서</span>
        )}
        <Button
          title="저장 (Ctrl/Cmd+S)"
          aria-busy={!ready || saving || writingTeamFile}
          disabled={!canSave(state)}
          onClick={() => void save()}
        >
          <Save size={15} />
          <span>저장</span>
        </Button>
      </header>
      <ErrorNote error={error} />
      <div className="slide-editor-stage">
        {!ready && <LoadingState label="편집기를 불러오는 중입니다." />}
        <iframe
          ref={frame}
          className="slide-editor-frame"
          title="CanvaSlide 편집기"
          src={source}
          allow="fullscreen; clipboard-read; clipboard-write"
          allowFullScreen
        />
      </div>
      {dialog?.kind === "save-target" && (
        <SaveTargetDialog
          name={dialog.name}
          canWrite={canWrite}
          onChoose={dialog.resolve}
        />
      )}
      {dialog?.kind === "conflict" && (
        <ConflictDialog title={dialog.title} onChoose={dialog.resolve} />
      )}
      {dialog?.kind === "leave" && (
        <Modal title="저장하지 않은 변경" onClose={() => dialog.resolve(null)}>
          <p>저장하지 않은 변경이 있습니다. 이동하기 전에 저장할까요?</p>
          <div className="form-actions">
            <Button onClick={() => dialog.resolve(null)}>계속 편집</Button>
            <Button
              className="danger"
              onClick={() => dialog.resolve("discard")}
            >
              저장하지 않고 이동
            </Button>
            <Button className="primary" onClick={() => dialog.resolve("save")}>
              저장 후 이동
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SaveTargetDialog({
  name,
  canWrite,
  onChoose,
}: {
  name: string;
  canWrite: boolean;
  onChoose: (value: SaveTarget) => void;
}) {
  const [title, setTitle] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const problem = slideTitleProblem(title);
  return (
    <Modal
      title="다른 이름으로 저장"
      onClose={() => onChoose(null)}
      initialFocus={input}
    >
      <form
        className="slide-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canWrite && !problem) onChoose({ kind: "team", title });
        }}
      >
        <label>
          <span>팀 자료 이름</span>
          <input
            ref={input}
            value={title}
            disabled={!canWrite}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {!canWrite && (
          <p className="field-help">
            이 팀에는 저장 권한이 없어 이 기기에만 저장할 수 있습니다.
          </p>
        )}
        <div className="form-actions">
          <Button onClick={() => onChoose(null)}>취소</Button>
          <Button onClick={() => onChoose({ kind: "device" })}>
            이 기기에 저장
          </Button>
          <Button
            className="primary"
            type="submit"
            disabled={!canWrite || !!problem}
          >
            팀 사본으로 저장
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ConflictDialog({
  title,
  onChoose,
}: {
  title: string;
  onChoose: (value: ConflictChoice) => void;
}) {
  const [copyTitle, setCopyTitle] = useState(`${title} (내 변경)`.trim());
  const problem = slideTitleProblem(copyTitle);
  return (
    <Modal title="다른 팀원이 먼저 저장했습니다" onClose={() => onChoose(null)}>
      <form
        className="slide-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) onChoose({ kind: "copy", title: copyTitle });
        }}
      >
        <p>
          이 자료를 연 뒤 다른 팀원이 저장했습니다. 팀 자료와 내 변경은 모두
          그대로 있습니다. 내 변경을 사본으로 저장하거나 최신 자료를 다시 열 수
          있습니다.
        </p>
        <label>
          <span>사본 이름</span>
          <input
            value={copyTitle}
            onChange={(event) => setCopyTitle(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <Button onClick={() => onChoose(null)}>계속 편집</Button>
          <Button
            className="danger"
            onClick={() => onChoose({ kind: "reload" })}
          >
            내 변경을 버리고 최신 자료 열기
          </Button>
          <Button className="primary" type="submit" disabled={!!problem}>
            내 변경을 사본으로 저장
          </Button>
        </div>
      </form>
    </Modal>
  );
}
