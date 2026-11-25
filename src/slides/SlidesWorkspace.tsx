import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ArrowLeft } from "lucide-react";
import type { User } from "../types";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Empty";
import { ErrorNote } from "../ui/ErrorNote";
import CopyDocumentLinkButton from "../documents/CopyDocumentLinkButton";
import { SlidesLoadingBoard } from "./SlideLoadingState";
import { isSlideShareId } from "../../shared/slides/slide-file-rules.js";
import {
  listSlideFiles,
  readSlideEditor,
  type SlideEditorBuild,
  type SlideFileList as SlideFiles,
} from "./slide-file-api";
import SlideEditorFrame, {
  type SlideEditorHandle,
  type SlideEditorStart,
} from "./SlideEditorFrame";
import { SlideThumbnails } from "./slide-thumbnails";
import SlideFileActions from "./SlideFileActions";
import SlideFileList, { type SlideListView } from "./SlideFileList";
import {
  readSlideAddress,
  slideShareOtherTeam,
  writeSlideAddress,
} from "./slide-address";
import "./slides.css";

export type SlidesWorkspaceHandle = {
  // Resolves false when the author keeps editing unsaved work.
  leave: () => Promise<boolean>;
};

export default function SlidesWorkspace({
  ref,
  teamId,
  user,
  teams,
  users,
  onSelectTeam,
  onNotify,
}: {
  ref?: Ref<SlidesWorkspaceHandle>;
  teamId: string;
  user: User;
  users: User[];
  teams: { id: string; name: string }[];
  onSelectTeam: (teamId: string) => void;
  onNotify: (message: string) => void;
}) {
  const [editor, setEditor] = useState<SlideEditorBuild | null | undefined>();
  const thumbnails = useMemo(
    () => (editor ? new SlideThumbnails(editor.path, user.id) : null),
    [editor, teamId, user.id],
  );
  const [list, setList] = useState<SlideFiles | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const viewKey = `graeboard:slides:view:${user.id}`;
  const [view, setView] = useState<SlideListView>(() => {
    try {
      return localStorage.getItem(viewKey) === "table" ? "table" : "cards";
    } catch {
      return "cards";
    }
  });
  function changeView(next: SlideListView) {
    setView(next);
    try {
      localStorage.setItem(viewKey, next);
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }
  const [start, setStart] = useState<SlideEditorStart | null>(() => {
    const { team, share, file } = readSlideAddress();
    if (team && team !== teamId) return null;
    if (share && isSlideShareId(share))
      return { kind: "share", shareId: share };
    return file ? { kind: "file", fileId: file } : null;
  });
  const [otherTeam] = useState(() => slideShareOtherTeam(teamId));
  const frame = useRef<SlideEditorHandle>(null);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    void readSlideEditor()
      .then(setEditor)
      .catch((failure) => {
        setEditor(null);
        setError((failure as Error).message);
      });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void listSlideFiles(teamId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setList(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError((failure as Error).message);
      });
    return () => controller.abort();
  }, [teamId, reload]);

  useImperativeHandle(ref, () => ({
    async leave() {
      if (start && frame.current && !(await frame.current.leave()))
        return false;
      // A share link for another team is opened after the team changes.
      if (!otherTeam) writeSlideAddress();
      return true;
    },
  }));
  function openNew() {
    open({ kind: "new", key: crypto.randomUUID() });
  }
  function open(next: SlideEditorStart) {
    setError("");
    setStart(next);
    writeSlideAddress(next.kind === "file" ? { file: next.fileId } : {});
  }
  async function close() {
    if (frame.current && !(await frame.current.leave())) return;
    showList();
  }
  function showList() {
    setStart(null);
    setError("");
    writeSlideAddress();
    refresh();
  }
  function deleted(fileId: string) {
    setList(
      (previous) =>
        previous && {
          ...previous,
          files: previous.files.filter((file) => file.id !== fileId),
        },
    );
    showList();
    onNotify("자료를 삭제했습니다.");
  }

  if (otherTeam) {
    const team = teams.find((item) => item.id === otherTeam);
    return (
      <section className="board slides-board">
        <Empty
          title="다른 팀의 공유 링크입니다"
          description={
            team
              ? `${team.name} 팀의 자료입니다. 팀을 바꾸면 열 수 있습니다.`
              : "이 링크의 팀에 접근할 권한이 없습니다."
          }
          action={
            team && (
              <Button className="primary" onClick={() => onSelectTeam(team.id)}>
                {team.name} 팀으로 바꾸기
              </Button>
            )
          }
        />
      </section>
    );
  }
  if (editor === undefined || !list)
    return <SlidesLoadingBoard error={error} />;
  const initialFile =
    start?.kind === "file"
      ? list.files.find((file) => file.id === start.fileId)
      : undefined;
  if (initialFile && !editor)
    return (
      <section className="board slides-board slides-editing">
        <header className="slide-editor-bar">
          <Button title="팀 자료 목록" onClick={showList}>
            <ArrowLeft size={15} aria-hidden="true" />
            <span>목록</span>
          </Button>
          <strong className="slide-editor-title">{initialFile.title}</strong>
          <CopyDocumentLinkButton
            target={{ kind: "slide", teamId, id: initialFile.id }}
            title={initialFile.title}
          />
          <div className="heading-actions">
            <SlideFileActions
              key={initialFile.id}
              teamId={teamId}
              fileId={initialFile.id}
              title={initialFile.title}
              canWrite={list.canWrite}
              onDeleted={() => deleted(initialFile.id)}
              onError={setError}
            />
          </div>
        </header>
        <ErrorNote error={error} />
        <p className="slide-notice">
          이 서버에 CanvaSlide 편집기 배포본이 설치되지 않았습니다.
        </p>
      </section>
    );
  if (start && editor)
    return (
      <section className="board slides-board slides-editing">
        <SlideEditorFrame
          key={`${teamId}:${JSON.stringify(start)}`}
          ref={frame}
          editor={editor}
          teamId={teamId}
          userId={user.id}
          canWrite={list.canWrite}
          start={start}
          initialFile={initialFile}
          onDeleted={deleted}
          onClose={() => void close()}
          onNew={openNew}
          onSaved={(file, bytes) => {
            thumbnails?.remember(file, bytes);
            writeSlideAddress({ file: file.id });
            refresh();
          }}
        />
      </section>
    );
  return (
    <>
      <ErrorNote error={error} />
      {!editor && (
        <p className="slide-notice" role="status">
          이 서버에 CanvaSlide 편집기 배포본이 설치되지 않았습니다. 자료를 열어
          저장된 파일을 내려받을 수 있습니다.
        </p>
      )}
      <SlideFileList
        thumbnails={thumbnails}
        teamId={teamId}
        files={list.files}
        users={users}
        view={view}
        onViewChange={changeView}
        canWrite={list.canWrite && !!editor}
        onOpen={(file) => open({ kind: "file", fileId: file.id })}
        onNew={openNew}
        onChanged={refresh}
        onError={setError}
        onNotify={onNotify}
      />
    </>
  );
}
