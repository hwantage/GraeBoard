import { useEffect, useRef, useState } from "react";
import { Eye, Maximize2, Pencil, ZoomIn } from "lucide-react";
import {
  trackPointerDrag,
  type PointerPosition,
} from "../../ui/trackPointerDrag";
import { Modal } from "../../ui/Modal";
import { Button } from "../../ui/Button";
import { ErrorNote } from "../../ui/ErrorNote";
import type { ImagePreview } from "./DocumentImageView";

export default function DocumentImagePreview({
  image,
  zoom,
  onZoom,
  onClose,
  onEdit,
}: {
  image: ImagePreview;
  zoom: boolean;
  onZoom: () => void;
  onClose: () => void;
  onEdit?: (src: string) => void;
}) {
  const active = useRef(true);
  const cancelPan = useRef<(() => void) | null>(null);
  const [panning, setPanning] = useState(false);
  useEffect(() => () => cancelPan.current?.(), [zoom]);
  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (
      !zoom ||
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      cancelPan.current
    )
      return;
    const canvas = event.currentTarget;
    // Leave the scrollbar and the browser's native touch scrolling available.
    if (event.target !== canvas.querySelector("img")) return;
    event.preventDefault();
    const x = canvas.scrollLeft + event.clientX;
    const y = canvas.scrollTop + event.clientY;
    const move = (pointer: PointerPosition) =>
      canvas.scrollTo(x - pointer.clientX, y - pointer.clientY);
    canvas.setPointerCapture(event.pointerId);
    setPanning(true);
    cancelPan.current = trackPointerDrag(event.nativeEvent, {
      captureTarget: canvas,
      onMove: move,
      onEnd: (position, cancelled) => {
        if (!cancelled) move(position);
        cancelPan.current = null;
        setPanning(false);
      },
    });
  }
  const [original, setOriginal] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function toggleOriginal() {
    if (showOriginal) {
      setShowOriginal(false);
      setError("");
      return;
    }
    if (original) {
      setShowOriginal(true);
      return;
    }
    if (!image.original || loading) return;
    setLoading(true);
    setError("");
    try {
      const src = await image.original.source();
      if (!src) throw new Error("원본 이미지를 불러오지 못했습니다.");
      if (active.current) {
        setOriginal(src);
        setShowOriginal(true);
      }
    } catch {
      if (active.current) setError("원본 이미지를 불러오지 못했습니다.");
    } finally {
      if (active.current) setLoading(false);
    }
  }
  const src = showOriginal && original ? original : image.src;
  const originalLabel = loading
    ? "불러오는 중…"
    : showOriginal
      ? "편집본 보기"
      : "원본 보기";
  const zoomLabel = zoom ? "화면에 맞추기" : "실제 크기";
  return (
    <Modal
      title="이미지 크게 보기"
      onClose={onClose}
      className="document-image-modal document-image-preview"
      headerActions={
        <div className="document-image-view-controls">
          {onEdit && (
            <Button
              title="이미지 편집"
              disabled={loading}
              onClick={() => onEdit(src)}
            >
              <Pencil size={14} aria-hidden="true" />
              <span>이미지 편집</span>
            </Button>
          )}
          {image.original && (
            <Button
              title={originalLabel}
              aria-pressed={showOriginal}
              disabled={loading}
              onClick={() => void toggleOriginal()}
            >
              <Eye size={14} aria-hidden="true" />
              <span>{originalLabel}</span>
            </Button>
          )}
          <Button title={zoomLabel} onClick={onZoom}>
            {zoom ? <Maximize2 size={14} /> : <ZoomIn size={14} />}
            <span>{zoomLabel}</span>
          </Button>
        </div>
      }
    >
      <ErrorNote error={error} />
      <div
        className={`document-image-canvas${zoom ? " actual-size" : ""}`}
        onPointerDown={startPan}
        data-panning={panning || undefined}
      >
        <img
          draggable={false}
          src={src}
          alt={showOriginal ? image.original?.alt : image.alt}
        />
      </div>
    </Modal>
  );
}
