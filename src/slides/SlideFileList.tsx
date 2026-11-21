import { useRef, useState } from "react";
import {
  Copy,
  Download,
  FilePlus2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { saveFile } from "../platform/api";
import type { User } from "../types";
import { Button } from "../ui/Button";
import SlideTitleDialog from "./SlideTitleDialog";
import { Empty } from "../ui/Empty";
import { Modal } from "../ui/Modal";
import {
  MAX_SLIDE_FILE_BYTES,
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
  | { kind: "new" }
  | { kind: "rename"; file: SlideFile }
  | { kind: "copy"; file: SlideFile }
  | { kind: "delete"; file: SlideFile };

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
const time = (value: string) =>
  new Date(value).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  });

export default function SlideFileList({
  teamId,
  files,
  canWrite,
  people,
  onOpen,
  onNew,
  onChanged,
  onError,
  onNotify,
}: {
  teamId: string;
  files: SlideFile[];
  canWrite: boolean;
  people: User[];
  onOpen: (file: SlideFile) => void;
  onNew: (title: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const name = (id: string) =>
    people.find((person) => person.id === id)?.name || "알 수 없음";

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
    await run(
      async () =>
        createSlideFile(
          teamId,
          title,
          new Uint8Array(await file.arrayBuffer()),
          slideRequestId(),
        ),
      "팀 자료로 가져왔습니다.",
    );
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
            <Button
              className="primary"
              title="새 팀 자료"
              disabled={busy}
              onClick={() => setPrompt({ kind: "new" })}
            >
              <FilePlus2 size={15} />
              <span>새 자료</span>
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
          <table className="settings-table slide-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>마지막 저장</th>
                <th>저장한 사람</th>
                <th>크기</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td>
                    <button
                      type="button"
                      className="slide-open"
                      onClick={() => onOpen(file)}
                    >
                      {file.title}
                    </button>
                  </td>
                  <td>{time(file.updatedAt)}</td>
                  <td>{name(file.updatedBy)}</td>
                  <td>{size(file.byteLength)}</td>
                  <td>
                    <div className="slide-row-actions">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          heading={
            prompt.kind === "new"
              ? "새 자료"
              : prompt.kind === "rename"
                ? "이름 변경"
                : "사본 만들기"
          }
          action={
            prompt.kind === "new"
              ? "만들기"
              : prompt.kind === "rename"
                ? "변경"
                : "사본 만들기"
          }
          initial={
            prompt.kind === "new"
              ? ""
              : prompt.kind === "rename"
                ? prompt.file.title
                : `${prompt.file.title} 사본`
          }
          busy={busy}
          onClose={() => setPrompt(null)}
          onSubmit={(title) => {
            if (prompt.kind === "new") {
              setPrompt(null);
              onNew(title);
            } else if (prompt.kind === "rename")
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
