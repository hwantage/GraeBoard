import { useRef, useState } from "react";
import { Plus, Upload } from "lucide-react";
import { showTouchTooltip } from "../ui/Tooltip";
import { useRecentCreation } from "../sheet/NewTaskMark";
import { useTouchPress } from "../ui/useTouchPress";
import { Button } from "../ui/Button";
import SlideCardThumbnail from "./SlideCardThumbnail";
import type { SlideThumbnails } from "./slide-thumbnails";
import { Empty } from "../ui/Empty";
import {
  MAX_SLIDE_FILE_BYTES,
  slideTitleFromFileName,
} from "../../shared/slides/slide-file-rules.js";
import {
  createSlideFile,
  slideRequestId,
  type SlideFile,
} from "./slide-file-api";

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
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const touch = useTouchPress();
  async function importFile(file: File) {
    if (file.size > MAX_SLIDE_FILE_BYTES)
      return onError(
        `자료는 ${MAX_SLIDE_FILE_BYTES / 1024 / 1024}MB까지 가져올 수 있습니다.`,
      );
    const title = slideTitleFromFileName(file.name) || "가져온 자료";
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const created = await createSlideFile(
        teamId,
        title,
        bytes,
        slideRequestId(),
      );
      thumbnails?.remember(created, bytes);
      onChanged();
      onNotify("팀 자료로 가져왔습니다.");
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
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
              <li key={file.id} className="slide-file-card">
                <button
                  type="button"
                  className="slide-open"
                  aria-label={file.title}
                  data-tooltip={`${file.title}\n생성  ${dateTime.format(new Date(file.createdAt))}\n수정  ${dateTime.format(new Date(file.updatedAt))}\n크기  ${size(file.byteLength)}`}
                  onClick={() => onOpen(file)}
                  onPointerDown={(event) => {
                    const button = event.currentTarget;
                    touch.start(event, {
                      onLongPress: () => showTouchTooltip(button),
                    });
                  }}
                  onClickCapture={touch.onClickCapture}
                  onContextMenu={(event) => {
                    if (touch.isTouch.current) event.preventDefault();
                  }}
                >
                  <SlideCardThumbnail
                    key={file.contentHash}
                    file={file}
                    thumbnails={thumbnails}
                    canWrite={canWrite}
                  />
                  <span className="slide-card-heading">
                    <span className="slide-card-title">{file.title}</span>
                    <SlideNewMark createdAt={file.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SlideNewMark({ createdAt }: { createdAt: string }) {
  const isNew = useRecentCreation(createdAt);
  return isNew ? (
    <span className="task-new-mark" role="img" aria-label="새 자료" />
  ) : null;
}
