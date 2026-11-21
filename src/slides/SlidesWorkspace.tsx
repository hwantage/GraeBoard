import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { User } from "../types";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Empty";
import { ErrorNote } from "../ui/ErrorNote";
import LoadingState from "../ui/LoadingState";
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
import SlideFileList from "./SlideFileList";
import "./slides.css";

export type SlidesWorkspaceHandle = {
  // Resolves false when the author keeps editing unsaved work.
  leave: () => Promise<boolean>;
};

// The slide address inside `/slides`: `file` opens a team file, `share` a
// temporary snapshot (with the `team` it belongs to).
function readAddress() {
  const params = new URLSearchParams(location.search);
  return {
    file: params.get("file"),
    share: params.get("share"),
    team: params.get("team"),
  };
}
function writeAddress(values: { file?: string } = {}) {
  const url = new URL(location.href);
  for (const key of ["file", "share", "team"]) url.searchParams.delete(key);
  if (values.file) url.searchParams.set("file", values.file);
  history.replaceState(history.state, "", url);
}

export default function SlidesWorkspace({
  ref,
  teamId,
  user,
  people,
  teams,
  onSelectTeam,
  onNotify,
}: {
  ref?: Ref<SlidesWorkspaceHandle>;
  teamId: string;
  user: User;
  people: User[];
  teams: { id: string; name: string }[];
  onSelectTeam: (teamId: string) => void;
  onNotify: (message: string) => void;
}) {
  const [editor, setEditor] = useState<SlideEditorBuild | null | undefined>();
  const [list, setList] = useState<SlideFiles | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [start, setStart] = useState<SlideEditorStart | null>(() => {
    const { team, share, file } = readAddress();
    if (team && team !== teamId) return null;
    if (share && isSlideShareId(share))
      return { kind: "share", shareId: share };
    return file ? { kind: "file", fileId: file } : null;
  });
  const [otherTeam] = useState(() => {
    const address = readAddress();
    return address.team && address.team !== teamId && address.share
      ? address.team
      : null;
  });
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
      if (!otherTeam) writeAddress();
      return true;
    },
  }));
  function open(next: SlideEditorStart) {
    setError("");
    setStart(next);
    writeAddress(next.kind === "file" ? { file: next.fileId } : {});
  }
  async function close() {
    if (frame.current && !(await frame.current.leave())) return;
    setStart(null);
    writeAddress();
    refresh();
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
    return (
      <section className="board slides-board">
        <ErrorNote error={error} />
        {!error && <LoadingState label="슬라이드를 불러오는 중입니다." />}
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
          onClose={() => void close()}
          onSaved={(file) => {
            writeAddress({ file: file.id });
            refresh();
          }}
          onNotify={onNotify}
        />
      </section>
    );
  return (
    <section className="board slides-board">
      <ErrorNote error={error} />
      {!editor && (
        <p className="slide-notice" role="status">
          이 서버에 CanvaSlide 편집기 배포본이 설치되지 않았습니다. 자료 목록과
          내려받기만 사용할 수 있습니다.
        </p>
      )}
      {!list.durable && (
        <p className="slide-notice" role="status">
          이 서버는 슬라이드 자료를 임시 메모리에 보관합니다. 서버를 다시
          시작하면 자료가 사라지므로 필요한 자료는 내려받아 두세요.
        </p>
      )}
      <SlideFileList
        teamId={teamId}
        files={list.files}
        canWrite={list.canWrite && !!editor}
        people={people}
        onOpen={(file) => editor && open({ kind: "file", fileId: file.id })}
        onNew={(title) => open({ kind: "new", title })}
        onOpenLocal={() => editor && open({ kind: "local" })}
        onChanged={refresh}
        onError={setError}
        onNotify={onNotify}
      />
    </section>
  );
}
