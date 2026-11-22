import { useEffect, useMemo, useRef, useState } from "react";
import { Info, LayoutGrid, List, Plus, Upload } from "lucide-react";
import ray from "../../assets/character/canvaslide-ray-384.png";
import { showTouchTooltip } from "../ui/Tooltip";
import { useRecentCreation } from "../sheet/NewTaskMark";
import { Avatar } from "../ui/Avatar";
import { relativeTime } from "../ui/HistoryTime";
import { serverNow } from "../platform/api";
import type { User } from "../types";
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
const date = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});

export type SlideListView = "cards" | "table";

export default function SlideFileList({
  teamId,
  files,
  users,
  view,
  onViewChange,
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
  users: User[];
  view: SlideListView;
  onViewChange: (view: SlideListView) => void;
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
  const [now, setNow] = useState(() => Date.parse(serverNow()));
  const creators = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles) return;
    setNow(Date.parse(serverNow()));
    const timer = window.setInterval(
      () => setNow(Date.parse(serverNow())),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [hasFiles]);
  const creatorFor = (file: SlideFile) =>
    file.creationFromSync ? undefined : creators.get(file.createdBy);

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
          <div
            className="heading-actions slide-view-switch"
            role="group"
            aria-label="자료 보기 방식"
          >
            <Button
              title="카드형 보기"
              active={view === "cards"}
              aria-pressed={view === "cards"}
              onClick={() => onViewChange("cards")}
            >
              <LayoutGrid size={15} aria-hidden="true" />
            </Button>
            <Button
              title="목록형 보기"
              active={view === "table"}
              aria-pressed={view === "table"}
              onClick={() => onViewChange("table")}
            >
              <List size={15} aria-hidden="true" />
            </Button>
          </div>
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
            illustration={
              <img src={ray} width={144} height={96} alt="" draggable={false} />
            }
            description={
              canWrite
                ? "새 자료를 만들거나 이 기기의 CanvaSlide 파일을 가져오세요."
                : "팀원이 자료를 저장하면 여기에 표시됩니다."
            }
          />
        ) : view === "table" ? (
          <table className="settings-table slide-table" aria-label="팀 자료">
            <thead>
              <tr>
                <th scope="col">제목</th>
                <th scope="col" className="slide-table-creator">
                  생성자
                </th>
                <th scope="col" className="slide-table-date">
                  생성일
                </th>
                <th scope="col" className="slide-table-date">
                  수정일
                </th>
                <th scope="col">크기</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td>
                    <div className="slide-table-title">
                      <button
                        type="button"
                        data-tooltip={file.title}
                        onClick={() => onOpen(file)}
                      >
                        {file.title}
                      </button>
                      <SlideNewMark createdAt={file.createdAt} />
                    </div>
                  </td>
                  <td className="slide-table-creator">
                    {creatorFor(file)?.name ??
                      (file.creationFromSync ? "첫 동기화본" : "정보 없음")}
                  </td>
                  <td>
                    <SlideDate value={file.createdAt} now={now} />
                  </td>
                  <td>
                    <SlideDate value={file.updatedAt} now={now} />
                  </td>
                  <td>{size(file.byteLength)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <SlideFileCards
            files={files}
            creatorFor={creatorFor}
            now={now}
            thumbnails={thumbnails}
            canWrite={canWrite}
            onOpen={onOpen}
          />
        )}
      </div>
    </section>
  );
}

function SlideFileCards({
  files,
  creatorFor,
  now,
  thumbnails,
  canWrite,
  onOpen,
}: {
  files: SlideFile[];
  creatorFor: (file: SlideFile) => User | undefined;
  now: number;
  thumbnails: SlideThumbnails | null;
  canWrite: boolean;
  onOpen: (file: SlideFile) => void;
}) {
  return (
    <ul className="slide-card-grid" aria-label="팀 자료">
      {files.map((file) => {
        const creator = creatorFor(file);
        const createdLabel = file.creationFromSync ? "첫 동기화본" : "생성";
        const info = `${file.title}\n${createdLabel}  ${dateTime.format(new Date(file.createdAt))}\n수정  ${dateTime.format(new Date(file.updatedAt))}\n크기  ${size(file.byteLength)}`;
        return (
          <li key={file.id} className="slide-file-card">
            <SlideCardThumbnail
              key={file.contentHash}
              file={file}
              thumbnails={thumbnails}
              canWrite={canWrite}
            />
            <SlideNewMark createdAt={file.createdAt} />
            <div className="slide-card-heading">
              <span
                role="img"
                aria-label={
                  creator ? `작성자 ${creator.name}` : "작성자 정보 없음"
                }
              >
                <Avatar user={creator} />
              </span>
              <div className="slide-card-caption">
                <button
                  type="button"
                  className="slide-open"
                  onClick={() => onOpen(file)}
                >
                  <span className="slide-card-title">{file.title}</span>
                </button>
                <div className="slide-card-byline">
                  {(creator || file.creationFromSync) && (
                    <span>{creator?.name ?? createdLabel}</span>
                  )}
                  <time dateTime={file.createdAt}>
                    {relativeTime(file.createdAt, now, "minute")}
                  </time>
                </div>
              </div>
              <button
                type="button"
                className="slide-card-info"
                aria-label={`${file.title} 정보`}
                data-tooltip={info}
                onClick={(event) => showTouchTooltip(event.currentTarget)}
              >
                <Info size={17} aria-hidden="true" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SlideDate({ value, now }: { value: string; now: number }) {
  const stamp = new Date(value);
  const full = dateTime.format(stamp);
  return (
    <time dateTime={value} title={full}>
      <span className="slide-date-time">{full}</span>
      <span className="slide-date-short">{date.format(stamp)}</span>{" "}
      <span className="slide-date-relative">
        ({relativeTime(value, now, "minute")})
      </span>
    </time>
  );
}

function SlideNewMark({ createdAt }: { createdAt: string }) {
  const isNew = useRecentCreation(createdAt);
  return isNew ? (
    <span className="slide-new-mark" role="img" aria-label="새 자료">
      NEW
    </span>
  ) : null;
}
