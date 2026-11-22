import { useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { slideDownloadName } from "../../shared/slides/slide-file-rules.js";
import { ApiError, saveFile } from "../platform/api";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import { deleteSlideFile, readSlideFile } from "./slide-file-api";

export default function SlideFileActions({
  teamId,
  fileId,
  title,
  canWrite,
  dirty = false,
  disabled = false,
  onDeleted,
  onError,
}: {
  teamId: string;
  fileId: string;
  title: string;
  canWrite: boolean;
  dirty?: boolean;
  disabled?: boolean;
  onDeleted: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function download() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onError("");
    try {
      const file = await readSlideFile(teamId, fileId);
      saveFile(
        new Blob([file.bytes], { type: "application/json" }),
        slideDownloadName(file.title),
      );
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!removed) {
        try {
          await deleteSlideFile(teamId, fileId);
        } catch (failure) {
          // A retry after a lost response can find the file already deleted.
          if (!(failure instanceof ApiError && failure.status === 404))
            throw failure;
        }
        setRemoved(true);
      }
      await onDeleted();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function cancel() {
    if (pending.current || removed) return;
    setConfirming(false);
    setError("");
  }

  return (
    <>
      <Button
        title="서버에 저장된 파일 내려받기"
        disabled={disabled || busy}
        onClick={() => void download()}
      >
        <Download size={15} aria-hidden="true" />
        <span>내려받기</span>
      </Button>
      {canWrite && (
        <Button
          title="자료 삭제"
          disabled={disabled || busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={15} aria-hidden="true" />
          <span>삭제</span>
        </Button>
      )}
      {confirming && (
        <Modal
          title="자료 삭제"
          className="slide-delete-dialog"
          onClose={cancel}
        >
          <p>
            {removed ? (
              "팀 자료가 삭제되었습니다."
            ) : (
              <>
                <strong>{title}</strong> 자료를 팀 목록에서 삭제합니다.
                {dirty && " 저장하지 않은 변경도 함께 버립니다."}
              </>
            )}
          </p>
          <ErrorNote error={error} />
          <div className="form-actions">
            {!removed && (
              <Button disabled={busy} onClick={cancel}>
                취소
              </Button>
            )}
            <Button
              className={removed ? "primary" : "danger"}
              disabled={busy}
              onClick={() => void remove()}
            >
              {removed ? "목록으로" : "삭제"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
