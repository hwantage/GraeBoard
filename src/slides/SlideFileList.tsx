import { useEffect, useRef, useState } from "react";
import { Copy, Download, Plus, Pencil, Trash2, Upload } from "lucide-react";
import { saveFile } from "../platform/api";
import { useRecentCreation } from "../sheet/NewTaskMark";
import { useTouchPress } from "../ui/useTouchPress";
import { Button } from "../ui/Button";
import SlideCardThumbnail from "./SlideCardThumbnail";
import type { SlideThumbnails } from "./slide-thumbnails";
import SlideTitleDialog from "./SlideTitleDialog";
import { Empty } from "../ui/Empty";
import { Modal } from "../ui/Modal";
import {
  MAX_SLIDE_FILE_BYTES,
  slideCopyTitle,
  slideDownloadName,
  slideTitleFromFileName,
} from "../../shared/slides/slide-file-rules.js";
import {
  copySlideFile,
  createSlideFile,
  deleteSlideFile,
  readSlideFile,
  renameSlideFile,
  slideRequestId,
  type SlideFile,
} from "./slide-file-api";

type Prompt =
  | { kind: "rename"; file: SlideFile }
  | { kind: "copy"; file: SlideFile }
  | { kind: "delete"; file: SlideFile };

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
const dateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
});

export default function SlideFileList({
  teamId,
  files,
  thumbnails,
  canWrite,
  onOpen,
  onNew,
  onChanged,
  onError,
  onNotify,
}: {
  teamId: string;
  files: SlideFile[];
  thumbnails: SlideThumbnails | null;
  canWrite: boolean;
  onOpen: (file: SlideFile) => void;
  onNew: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const touch = useTouchPress();
  const [inspected, setInspected] = useState<string | null>(null);
  const inspectedCard = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!inspected) return;
    const outside = (event: PointerEvent) => {
      if (!inspectedCard.current?.contains(event.target as Node))
        setInspected(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const card = inspectedCard.current;
      if (card?.contains(document.activeElement))
        card.querySelector<HTMLButtonElement>(".slide-open")?.focus();
      setInspected(null);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [inspected]);

  async function run(work: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await work();
      setPrompt(null);
      onChanged();
      onNotify(done);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    if (file.size > MAX_SLIDE_FILE_BYTES)
      return onError(
        `자료는 ${MAX_SLIDE_FILE_BYTES / 1024 / 1024}MB까지 가져올 수 있습니다.`,
      );
    const title = slideTitleFromFileName(file.name) || "가져온 자료";
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const created = await createSlideFile(
        teamId,
        title,
        bytes,
        slideRequestId(),
      );
      thumbnails?.remember(created, bytes);
    }, "팀 자료로 가져왔습니다.");
  }
  async function download(file: SlideFile) {
    onError("");
    try {
      const { bytes, title } = await readSlideFile(teamId, file.id);
      saveFile(
        new Blob([bytes], { type: "application/json" }),
        slideDownloadName(title),
      );
    } catch (error) {
      onError((error as Error).message);
    }
  }

  return (
    <section className="slide-list" aria-label="팀 자료 목록">
      <header className="page-heading slide-list-heading">
        <div className="heading-line">
          <h1>CanvaSlide</h1>
          {canWrite && (
            <div className="heading-actions">
              <Button
                className="primary"
                title="새 팀 자료"
                disabled={busy}
                onClick={onNew}
              >
                <Plus size={15} />
                <span>새 자료</span>
              </Button>
            </div>
          )}
        </div>
        {canWrite && (
          <div className="heading-actions">
            <input
              ref={picker}
              type="file"
              hidden
              accept=".canvaslide,.json"
              aria-label="가져올 CanvaSlide 파일"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
            <Button
              title="이 기기의 .canvaslide 파일을 팀 자료로 가져오기"
              disabled={busy}
              onClick={() => picker.current?.click()}
            >
              <Upload size={15} />
              <span>파일 가져오기</span>
            </Button>
          </div>
        )}
      </header>
      <div className="board slides-board slide-list-body">
        {files.length === 0 ? (
          <Empty
            title="아직 팀 자료가 없습니다"
            description={
              canWrite
                ? "새 자료를 만들거나 이 기기의 CanvaSlide 파일을 가져오세요."
                : "팀원이 자료를 저장하면 여기에 표시됩니다."
            }
          />
        ) : (
          <ul className="slide-card-grid" aria-label="팀 자료">
            {files.map((file) => (
              <li
                key={file.id}
                className="slide-file-card"
                ref={inspected === file.id ? inspectedCard : undefined}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") setInspected(file.id);
                }}
                onPointerLeave={(event) => {
                  if (
                    event.pointerType !== "touch" &&
                    !event.currentTarget.querySelector(":focus-visible")
                  )
                    setInspected((id) => (id === file.id ? null : id));
                }}
                onFocus={(event) => {
                  if (event.target.matches(":focus-visible"))
                    setInspected(file.id);
                }}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget) &&
                    !event.currentTarget.matches(":hover")
                  )
                    setInspected((id) => (id === file.id ? null : id));
                }}
              >
                <SlideCardThumbnail
                  key={file.contentHash}
                  file={file}
                  thumbnails={thumbnails}
                  canWrite={canWrite}
                />
                <div className="slide-card-heading">
                  <button
                    type="button"
                    className="slide-open"
                    title={file.title}
                    onPointerDown={(event) =>
                      touch.start(event, {
                        onLongPress: () => setInspected(file.id),
                      })
                    }
                    onClickCapture={touch.onClickCapture}
                    onContextMenu={(event) => {
                      if (touch.isTouch.current) event.preventDefault();
                    }}
                    onClick={() => onOpen(file)}
                  >
                    {file.title}
                  </button>
                  {inspected === file.id && (
                    <SlideNewMark createdAt={file.createdAt} />
                  )}
                </div>
                {inspected === file.id && (
                  <div className="slide-card-info">
                    <dl className="slide-card-details">
                      <dt>생성</dt>
                      <dd>
                        <time dateTime={file.createdAt}>
                          {dateTime.format(new Date(file.createdAt))}
                        </time>
                      </dd>
                      <dt>수정</dt>
                      <dd>
                        <time dateTime={file.updatedAt}>
                          {dateTime.format(new Date(file.updatedAt))}
                        </time>
                      </dd>
                      <dt>크기</dt>
                      <dd className="slide-card-size">
                        {size(file.byteLength)}
                      </dd>
                    </dl>
                    <div className="slide-card-actions">
                      <Button
                        tooltip="내려받기"
                        onClick={() => void download(file)}
                      >
                        <Download size={15} />
                      </Button>
                      {canWrite && (
                        <>
                          <Button
                            tooltip="이름 변경"
                            onClick={() => setPrompt({ kind: "rename", file })}
                          >
                            <Pencil size={15} />
                          </Button>
                          <Button
                            tooltip="사본 만들기"
                            onClick={() => setPrompt({ kind: "copy", file })}
                          >
                            <Copy size={15} />
                          </Button>
                          <Button
                            tooltip="삭제"
                            onClick={() => setPrompt({ kind: "delete", file })}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {prompt?.kind === "delete" && (
        <Modal title="자료 삭제" onClose={() => setPrompt(null)}>
          <p>
            <strong>{prompt.file.title}</strong> 자료를 팀 목록에서 삭제합니다.
          </p>
          <div className="form-actions">
            <Button onClick={() => setPrompt(null)}>취소</Button>
            <Button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => deleteSlideFile(teamId, prompt.file.id),
                  "자료를 삭제했습니다.",
                )
              }
            >
              삭제
            </Button>
          </div>
        </Modal>
      )}
      {prompt && prompt.kind !== "delete" && (
        <SlideTitleDialog
          heading={prompt.kind === "rename" ? "이름 변경" : "사본 만들기"}
          action={prompt.kind === "rename" ? "변경" : "사본 만들기"}
          initial={
            prompt.kind === "rename"
              ? prompt.file.title
              : slideCopyTitle(prompt.file.title)
          }
          busy={busy}
          onClose={() => setPrompt(null)}
          onSubmit={(title) => {
            if (prompt.kind === "rename")
              void run(
                () => renameSlideFile(teamId, prompt.file.id, title),
                "이름을 변경했습니다.",
              );
            else
              void run(
                () => copySlideFile(teamId, prompt.file.id, title),
                "사본을 만들었습니다.",
              );
          }}
        />
      )}
    </section>
  );
}

function SlideNewMark({ createdAt }: { createdAt: string }) {
  const isNew = useRecentCreation(createdAt);
  return isNew ? (
    <span className="task-new-mark" role="img" aria-label="새 자료" />
  ) : null;
}
