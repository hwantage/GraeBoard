import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ArrowLeft, Copy, Save } from "lucide-react";
import SlideFileActions from "./SlideFileActions";
import SlideTitleDialog from "./SlideTitleDialog";
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
  slideCopyTitle,
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
  | { kind: "new"; key: string }
  | { kind: "share"; shareId: string };
export type SlideEditorHandle = { leave: () => Promise<boolean> };

type ConflictChoice =
  { kind: "copy"; title: string } | { kind: "reload" } | null;
type LeaveChoice = "save" | "save-as" | "discard" | null;
type Dialog =
  | {
      kind: "save-target" | "first-save";
      name: string;
      resolve: (value: string | null) => void;
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
  initialFile,
  onDeleted,
  onClose,
  onNew,
  onSaved,
}: {
  ref?: Ref<SlideEditorHandle>;
  editor: SlideEditorBuild;
  teamId: string;
  userId: string;
  canWrite: boolean;
  start: SlideEditorStart;
  initialFile?: SlideFile;
  onDeleted: (id: string) => void;
  onClose: () => void;
  onNew: () => void;
  onSaved: (file: SlideFile, bytes: Uint8Array<ArrayBuffer>) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<SlideFrameBridge | null>(null);
  const [ready, setReady] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [state, setState] = useState<SlideEditorState | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [writingTeamFile, setWritingTeamFile] = useState(false);
  const [titleDraft, setTitleDraft] = useState<{
    session: number;
    name: string;
  } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const busy = !ready || saving || writingTeamFile;
  const activeSave = useRef(false);
  const leaving = useRef(false);
  const unconfirmedCreate = useRef<{
    title: string;
    bytes: Uint8Array;
    requestId: string;
  } | null>(null);
  const live = useRef({
    canWrite,
    onSaved,
    start,
    runFileCommand,
    dialog,
    state,
  });
  live.current = { canWrite, onSaved, start, runFileCommand, dialog, state };
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
  const stored = (file: SlideFile, bytes: Uint8Array<ArrayBuffer>) => {
    setError("");
    live.current.onSaved(file, bytes);
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
      } else if (first.kind === "new") {
        const result = await bridge.current!.request<{ outcome: string }>(
          "new",
          { teamId, title: "" },
        );
        if (result.outcome !== "replaced" && result.outcome !== "declined")
          throw new Error("새 자료를 열지 못했습니다. 다시 시도하세요.");
      }
    } catch (failure) {
      setOpenFailed(true);
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
            throw fail(new Error("이 팀의 자료를 저장할 권한이 없습니다."));
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
              bytes,
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
                  bytes,
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
          const previous = unconfirmedCreate.current;
          if (
            previous &&
            previous.title === title &&
            previous.bytes.length === bytes.length &&
            previous.bytes.every((byte, index) => byte === bytes[index])
          )
            requestId = previous.requestId;
          setWritingTeamFile(true);
          try {
            const file = await withRetry(() =>
              createSlideFile(teamId, title, bytes, requestId),
            );
            unconfirmedCreate.current = null;
            return stored(file, bytes);
          } catch (failure) {
            // A lost response can follow a committed create. Replay the identical
            // submission on a manual retry, even after both HTTP attempts failed.
            unconfirmedCreate.current = transient(failure)
              ? { title, bytes, requestId }
              : null;
            throw fail(failure);
          } finally {
            setWritingTeamFile(false);
          }
        },
        async "save-target"({ name, bound }) {
          if (!live.current.canWrite)
            throw fail(new Error("이 팀에 자료를 만들 권한이 없습니다."));
          if (!live.current.state?.canStore || live.current.dialog) return null;
          const title = await ask<string | null>((resolve) => ({
            kind: "save-target",
            name: bound ? slideCopyTitle(name) : name,
            resolve,
          }));
          return title ? { kind: "team", title } : null;
        },
        "file-command": ({ command }) => live.current.runFileCommand(command),
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

  async function newFile() {
    if (await leave()) onNew();
  }
  async function save(asCopy = false) {
    if (!bridge.current || activeSave.current) return false;
    activeSave.current = true;
    setSaving(true);
    try {
      if (!asCopy) {
        const current = await bridge.current.request<SlideEditorState>("state");
        if (current.binding?.fileId === null && !current.name.trim()) {
          const title = await ask<string | null>((resolve) => ({
            kind: "first-save",
            name: "",
            resolve,
          }));
          if (!title) return false;
          await bridge.current.request("rename", {
            name: title,
            documentSession: current.documentSession,
          });
        }
      }
      const result = await bridge.current.request<
        SlideEditorState & { saved: boolean }
      >("save", { asCopy });
      return result.saved && !result.dirty;
    } catch (failure) {
      // The save handlers already showed their own failures.
      if (!error) setError((failure as Error).message);
      return false;
    } finally {
      activeSave.current = false;
      setSaving(false);
    }
  }
  async function leave() {
    if (
      document.querySelector(".slide-delete-dialog[open]") ||
      leaving.current ||
      activeSave.current ||
      saving ||
      writingTeamFile ||
      (!ready && start.kind === "new")
    )
      return false;
    if (!bridge.current || !ready) return true;
    leaving.current = true;
    try {
      const current = await bridge.current.request<SlideEditorState>(
        "state",
        {},
        3000,
      );
      let discard = false;
      if (current.dirty) {
        const choice = await ask<LeaveChoice>((resolve) => ({
          kind: "leave",
          resolve,
        }));
        if (!choice) return false;
        discard = choice === "discard";
        if (!discard && !(await save(choice === "save-as"))) return false;
      }
      return await bridge.current.request<boolean>("prepare-leave", {
        documentSession: current.documentSession,
        discard,
      });
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      leaving.current = false;
    }
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
  const teamFile =
    binding?.fileId && binding.teamId === teamId
      ? { id: binding.fileId, title: binding.title }
      : openFailed
        ? initialFile
        : undefined;
  async function finishDeletion(fileId: string) {
    if (binding?.fileId === fileId && state) {
      const cleared = await bridge.current?.request<boolean>("prepare-leave", {
        documentSession: state.documentSession,
        discard: true,
      });
      if (!cleared)
        throw new Error("편집 복구본을 정리하지 못했습니다. 다시 시도하세요.");
    }
    onDeleted(fileId);
  }
  function canSave(current: SlideEditorState | null) {
    return (
      !busy &&
      canWrite &&
      current?.canStore &&
      current.dirty &&
      (!current.binding ||
        !slideTitleProblem(current.name) ||
        (current.binding.fileId === null && !current.name.trim()))
    );
  }
  function rename(name: string) {
    if (!state || !binding || !canWrite) return;
    void bridge.current
      ?.request("rename", { name, documentSession: state.documentSession })
      .catch((failure) => setError((failure as Error).message));
  }
  async function runFileCommand(command: string) {
    if (busy || dialog || document.querySelector(".slide-delete-dialog[open]"))
      return;
    if (command === "open") return onClose();
    if (!canWrite) return;
    if (command === "new") return newFile();
    if (command !== "save" && command !== "save-as") return;
    // A keystroke in the title can still be on its way to the frame.
    const current = await bridge.current?.request<SlideEditorState>("state");
    if (
      current &&
      (command === "save-as" ? current.canStore : canSave(current))
    )
      await save(command === "save-as");
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return;
      const key = event.key.toLowerCase();
      const command =
        key === "s"
          ? event.shiftKey
            ? "save-as"
            : "save"
          : !event.shiftKey &&
            (key === "n" ? "new" : key === "o" ? "open" : null);
      if (!command) return;
      event.preventDefault();
      void runFileCommand(command).catch((failure) =>
        setError((failure as Error).message),
      );
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
            placeholder="자료 제목"
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
            {(openFailed && !binding && initialFile?.title) ||
              state?.name ||
              "CanvaSlide"}
          </strong>
        )}
        <div className="heading-actions">
          <Button
            title="저장 (Ctrl/Cmd+S)"
            aria-busy={!ready || saving || writingTeamFile}
            disabled={!canSave(state)}
            onClick={() => void save()}
          >
            <Save size={15} />
            <span>저장</span>
          </Button>
          {canWrite && (
            <Button
              title="다른 이름으로 저장"
              disabled={busy || !state?.canStore}
              onClick={() => void save(true)}
            >
              <Copy size={15} />
              <span>다른 이름으로 저장</span>
            </Button>
          )}
          {teamFile && (
            <SlideFileActions
              key={teamFile.id}
              teamId={teamId}
              fileId={teamFile.id}
              title={teamFile.title}
              canWrite={canWrite}
              dirty={dirty}
              disabled={busy}
              onDeleted={() => finishDeletion(teamFile.id)}
              onError={setError}
            />
          )}
        </div>
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
      {(dialog?.kind === "save-target" || dialog?.kind === "first-save") && (
        <SlideTitleDialog
          heading={
            dialog.kind === "first-save" ? "자료 저장" : "다른 이름으로 저장"
          }
          action={dialog.kind === "first-save" ? "저장" : "팀 사본으로 저장"}
          initial={dialog.name}
          busy={false}
          onClose={() => dialog.resolve(null)}
          onSubmit={dialog.resolve}
        />
      )}
      {dialog?.kind === "conflict" && (
        <ConflictDialog title={dialog.title} onChoose={dialog.resolve} />
      )}
      {dialog?.kind === "leave" && (
        <Modal title="저장하지 않은 변경" onClose={() => dialog.resolve(null)}>
          <p>저장하지 않은 변경이 있습니다. 이동하기 전에 저장할까요?</p>
          <div className="form-actions slide-leave-actions">
            <Button onClick={() => dialog.resolve(null)}>계속 편집</Button>
            <Button
              className="danger"
              onClick={() => dialog.resolve("discard")}
            >
              저장하지 않고 이동
            </Button>
            {canWrite && (
              <>
                <Button
                  className="primary"
                  onClick={() => dialog.resolve("save")}
                >
                  저장 후 이동
                </Button>
                <Button
                  disabled={!state?.canStore}
                  onClick={() => dialog.resolve("save-as")}
                >
                  다른 이름으로 저장
                </Button>
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
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
