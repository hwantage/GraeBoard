import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { ErrorNote } from "../../ui/ErrorNote";
import type { ImagePreview } from "./DocumentImageView";
import "./document-image-editor.css";

type Point = { x: number; y: number };
type Annotation = {
  tool: "pen" | "rectangle" | "text";
  points: Point[];
  text: string;
};

export default function DocumentImageEditor({
  image,
  onClose,
}: {
  image: ImagePreview;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<HTMLImageElement | null>(null);
  const gesture = useRef<{ id: number; mark: Annotation } | null>(null);
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [tool, setTool] = useState<Annotation["tool"]>("rectangle");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (!active || !canvas.current) return;
      bitmap.current = img;
      canvas.current.width = img.naturalWidth;
      canvas.current.height = img.naturalHeight;
      setReady(true);
    };
    img.onerror = () => {
      if (active) setError("이미지를 불러오지 못했습니다.");
    };
    img.src = image.src;
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [image.src]);
  function paint(includeMarks: boolean) {
    const surface = canvas.current,
      img = bitmap.current;
    const ctx = surface?.getContext("2d");
    if (!ctx || !surface || !img) return;
    ctx.clearRect(0, 0, surface.width, surface.height);
    ctx.drawImage(img, 0, 0);
    if (!includeMarks) return;
    const unit = Math.max(1, img.naturalWidth / 800);
    ctx.strokeStyle = ctx.fillStyle = "#e02020";
    ctx.lineWidth = 3 * unit;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.font = `bold ${24 * unit}px sans-serif`;
    ctx.textBaseline = "top";
    for (const mark of [...marks, ...(draft ? [draft] : [])]) {
      const first = mark.points[0],
        last = mark.points.at(-1)!;
      if (mark.tool === "text") ctx.fillText(mark.text, first.x, first.y);
      else if (mark.tool === "rectangle")
        ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
      else {
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (const p of mark.points) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
  }
  useEffect(() => {
    paint(!original);
  }, [ready, marks, draft, original]);
  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const el = event.currentTarget,
      box = el.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(el.width, ((event.clientX - box.left) * el.width) / box.width),
      ),
      y: Math.max(
        0,
        Math.min(
          el.height,
          ((event.clientY - box.top) * el.height) / box.height,
        ),
      ),
    };
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const p = point(event);
    current.mark = {
      ...current.mark,
      points:
        current.mark.tool === "pen"
          ? [...current.mark.points, p]
          : [current.mark.points[0], p],
    };
    setDraft(current.mark);
  }
  function finish(event: PointerEvent<HTMLCanvasElement>, cancel = false) {
    if (gesture.current?.id !== event.pointerId) return;
    if (!cancel) {
      move(event);
      const mark = gesture.current.mark;
      const first = mark.points[0];
      if (mark.points.some((p) => Math.hypot(p.x - first.x, p.y - first.y) > 2))
        setMarks((prev) => [...prev, mark]);
    }
    gesture.current = null;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function save() {
    if (!image.apply || !canvas.current || busy) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      paint(true);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.current!.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("이미지를 만들지 못했습니다.")),
          "image/png",
        ),
      );
      await image.apply(
        new File([blob], "annotated-image.png", { type: "image/png" }),
        abort.signal,
      );
      if (!abort.signal.aborted) onClose();
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        paint(!original);
      }
    }
  }
  return (
    <Modal
      title="이미지 편집"
      className="document-image-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="document-image-editor-tools">
        {(
          [
            ["rectangle", "빨간 사각형"],
            ["pen", "빨간 펜"],
            ["text", "글자"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            aria-pressed={tool === value}
            disabled={busy}
            onClick={() => {
              setTool(value);
              setOriginal(false);
            }}
          >
            {label}
          </Button>
        ))}
        <Button
          disabled={busy || !marks.length}
          onClick={() => setMarks((prev) => prev.slice(0, -1))}
        >
          실행취소
        </Button>
        <Button
          aria-pressed={original}
          disabled={busy}
          onClick={() => setOriginal(!original)}
        >
          원본 보기
        </Button>
        <Button
          disabled={!ready || !marks.length || busy}
          onClick={() => void save()}
        >
          {busy ? "저장 중…" : "적용"}
        </Button>
      </div>
      {tool === "text" && (
        <div className="document-image-editor-text">
          <input
            aria-label="이미지에 넣을 글자"
            placeholder="글자를 입력한 뒤 이미지에서 위치 선택"
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      )}
      <ErrorNote error={error} />
      <div className="document-image-editor-surface">
        <canvas
          ref={canvas}
          aria-label="이미지 강조 영역"
          onPointerDown={(event) => {
            if (
              !ready ||
              busy ||
              original ||
              event.button !== 0 ||
              !event.isPrimary
            )
              return;
            event.preventDefault();
            const mark: Annotation = { tool, points: [point(event)], text };
            if (tool === "text") {
              if (text.trim()) setMarks((prev) => [...prev, mark]);
              return;
            }
            gesture.current = { id: event.pointerId, mark };
            setDraft(mark);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={move}
          onPointerUp={(event) => finish(event)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => finish(event, true)}
        />
      </div>
    </Modal>
  );
}
