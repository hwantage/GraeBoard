import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { Modal } from "../../ui/Modal";
import { ErrorNote } from "../../ui/ErrorNote";
import {
  trackPointerDrag,
  type PointerPosition,
} from "../../ui/trackPointerDrag";
import type { ImagePreview } from "./DocumentImageView";
import DocumentImageTools from "./DocumentImageTools";
import DocumentImageTextInput from "./DocumentImageTextInput";
import {
  annotationBounds,
  annotationHandles,
  hitImageAnnotation,
  moveImageAnnotation,
  paintImageAnnotations,
  resizeImageAnnotation,
  IMAGE_HANDLES,
  type ImageAnnotation,
  type ImageHandle,
  type ImagePoint,
  type ImageStyle,
  type ImageTool,
} from "./document-image-annotations";
import "./document-image-editor.css";

const initialStyle: ImageStyle = {
  stroke: "#e02020",
  fill: "",
  lineWidth: 3,
  fontSize: 24,
};
type History = {
  past: ImageAnnotation[][];
  marks: ImageAnnotation[];
  future: ImageAnnotation[][];
};
const emptyHistory = (): History => ({ past: [], marks: [], future: [] });
function replaceText(marks: ImageAnnotation[], text: ImageAnnotation) {
  const existing = marks.find((mark) => mark.id === text.id);
  if (!text.text.trim())
    return existing ? marks.filter((mark) => mark.id !== text.id) : marks;
  if (existing === text) return marks;
  return existing
    ? marks.map((mark) => (mark.id === text.id ? text : mark))
    : [...marks, text];
}

export default function DocumentImageEditor({
  image,
  onClose,
}: {
  image: ImagePreview;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const bitmap = useRef<HTMLImageElement | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const historyRef = useRef(history);
  const [textEdit, setTextEdit] = useState<ImageAnnotation | null>(null);
  const textEditRef = useRef<ImageAnnotation | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<ImageAnnotation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<ImageTool>("rectangle");
  const [style, setStyle] = useState(initialStyle);
  const [original, setOriginal] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = size.width > 0;
  const fit = ready
    ? Math.min(
        1,
        Math.max(1, area.width - 64) / size.width,
        Math.max(1, area.height - 64) / size.height,
      )
    : 1;
  const scale = zoom ?? fit;
  const marks =
    draft ?? (textEdit ? replaceText(history.marks, textEdit) : history.marks);
  const selected = textEdit ?? marks.find((mark) => mark.id === selectedId);
  const context = ready ? canvas.current?.getContext("2d") : null;
  const bounds =
    selected && context ? annotationBounds(selected, context) : null;
  const handles =
    bounds && selected
      ? annotationHandles(bounds, selected.rotation, scale)
      : null;

  useEffect(() => {
    let active = true;
    setSize({ width: 0, height: 0 });
    updateHistory(emptyHistory());
    updateTextEdit(null);
    setDraft(null);
    setSelectedId(null);
    setZoom(null);
    const img = new Image();
    img.onload = () => {
      if (!active || !canvas.current) return;
      bitmap.current = img;
      canvas.current.width = img.naturalWidth;
      canvas.current.height = img.naturalHeight;
      setSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (active) setError("이미지를 불러오지 못했습니다.");
    };
    img.src = image.src;
    return () => {
      active = false;
      cancelDrag.current?.();
      controller.current?.abort();
    };
  }, [image.src]);
  useLayoutEffect(() => {
    const el = viewport.current!;
    const observer = new ResizeObserver(() =>
      setArea({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx && bitmap.current && ready)
      paintImageAnnotations(
        ctx,
        bitmap.current,
        original ? [] : marks.filter((mark) => mark.id !== textEdit?.id),
      );
  }, [ready, marks, original, textEdit]);

  function updateHistory(next: History) {
    historyRef.current = next;
    setHistory(next);
  }
  function commit(next: ImageAnnotation[]) {
    const current = historyRef.current;
    if (next === current.marks) return;
    updateHistory({
      past: [...current.past.slice(-99), current.marks],
      marks: next,
      future: [],
    });
  }
  function updateTextEdit(mark: ImageAnnotation | null) {
    textEditRef.current = mark;
    setTextEdit(mark);
  }
  function beginText(mark: ImageAnnotation) {
    updateTextEdit(mark);
    setSelectedId(mark.id);
    setTool("text");
  }
  function finishText(cancel = false) {
    const edit = textEditRef.current;
    if (!edit) return historyRef.current.marks;
    // Blur and the following toolbar click may run in the same event batch.
    // Read the final DOM value and publish history synchronously to both.
    const value = textInput.current?.value ?? edit.text;
    const next = cancel
      ? historyRef.current.marks
      : replaceText(
          historyRef.current.marks,
          value === edit.text ? edit : { ...edit, text: value },
        );
    updateTextEdit(null);
    commit(next);
    setSelectedId(next.some((mark) => mark.id === edit.id) ? edit.id : null);
    setTool("select");
    if (document.activeElement === textInput.current)
      canvas.current?.focus({ preventScroll: true });
    return next;
  }
  function undo(redo = false) {
    cancelDrag.current?.();
    finishText();
    setSelectedId(null);
    const current = historyRef.current;
    const source = redo ? current.future : current.past;
    if (!source.length) return;
    updateHistory(
      redo
        ? {
            past: [...current.past, current.marks],
            marks: source[0],
            future: source.slice(1),
          }
        : {
            past: source.slice(0, -1),
            marks: source.at(-1)!,
            future: [current.marks, ...current.future],
          },
    );
  }
  function remove(all = false) {
    const current = finishText();
    if (!current.length || (!all && !selectedId)) return;
    commit(all ? [] : current.filter((mark) => mark.id !== selectedId));
    setSelectedId(null);
  }
  function chooseTool(value: ImageTool) {
    cancelDrag.current?.();
    finishText();
    setTool(value);
    setOriginal(false);
    if (value !== "select") setSelectedId(null);
  }
  function changeStyle(change: Partial<ImageStyle>) {
    setStyle((current) => ({ ...current, ...change }));
    if (textEditRef.current) {
      updateTextEdit({ ...textEditRef.current, ...change });
      return;
    }
    if (selected)
      commit(
        historyRef.current.marks.map((mark) =>
          mark.id === selected.id ? { ...mark, ...change } : mark,
        ),
      );
  }
  function changeText(value: string) {
    const current = textEditRef.current;
    if (current && current.text !== value)
      updateTextEdit({ ...current, text: value });
  }
  function point(position: PointerPosition): ImagePoint {
    const el = canvas.current!,
      box = el.getBoundingClientRect();
    return {
      x: ((position.clientX - box.left) * el.width) / box.width,
      y: ((position.clientY - box.top) * el.height) / box.height,
    };
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (
      !ready ||
      busy ||
      event.button !== 0 ||
      !event.isPrimary ||
      cancelDrag.current
    )
      return;
    if (original && tool !== "pan") return;
    event.preventDefault();
    if (textEditRef.current) {
      finishText();
      canvas.current?.focus({ preventScroll: true });
      return;
    }
    canvas.current?.focus({ preventScroll: true });
    const target = canvas.current!;
    const startPoint = point(event);
    const base = historyRef.current.marks;
    const previousSelection = selectedId;
    let mark: ImageAnnotation | undefined;
    let handle: ImageHandle | undefined;
    let creating = false;
    let changed = false;
    let next = base;
    const scroll = {
      x: viewport.current!.scrollLeft,
      y: viewport.current!.scrollTop,
    };
    const screenStart = { x: event.clientX, y: event.clientY };
    if (tool === "text") {
      let moved = false;
      target.setPointerCapture(event.pointerId);
      cancelDrag.current = trackPointerDrag(event.nativeEvent, {
        captureTarget: target,
        onMove: (move) => {
          move.preventDefault();
          moved ||=
            Math.hypot(
              move.clientX - screenStart.x,
              move.clientY - screenStart.y,
            ) > 4;
        },
        onEnd: (position, cancelled) => {
          cancelDrag.current = null;
          if (
            cancelled ||
            moved ||
            Math.hypot(
              position.clientX - screenStart.x,
              position.clientY - screenStart.y,
            ) > 4
          )
            return;
          const existing = [...base]
            .reverse()
            .find(
              (item) =>
                item.tool === "text" &&
                hitImageAnnotation(item, startPoint, context!, 5 / scale),
            );
          // Focus during the native pointerup activation so touch opens the keyboard.
          flushSync(() =>
            beginText(
              existing ?? {
                ...style,
                id: crypto.randomUUID(),
                tool: "text",
                points: [startPoint],
                text: "",
                rotation: 0,
              },
            ),
          );
        },
      });
      return;
    }
    if (tool === "select") {
      if (handles)
        handle = (Object.keys(handles) as ImageHandle[]).find(
          (key) =>
            Math.hypot(
              startPoint.x - handles[key].x,
              startPoint.y - handles[key].y,
            ) <=
            9 / scale,
        );
      mark = handle
        ? selected
        : [...base]
            .reverse()
            .find((item) =>
              hitImageAnnotation(item, startPoint, context!, 5 / scale),
            );
      setSelectedId(mark?.id ?? null);
      if (!mark) return;
    } else if (tool !== "pan") {
      mark = {
        ...style,
        id: crypto.randomUUID(),
        tool,
        points: [startPoint],
        text: "",
        rotation: 0,
      };
      creating = true;
    }
    const originalMark = mark;
    const box = mark ? annotationBounds(mark, context!) : null;
    function update(position: PointerPosition) {
      if (tool === "pan") {
        viewport.current!.scrollLeft =
          scroll.x - (position.clientX - screenStart.x);
        viewport.current!.scrollTop =
          scroll.y - (position.clientY - screenStart.y);
        return;
      }
      const p = point(position);
      if (creating) {
        const last = mark!.points.at(-1)!;
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.1)
          mark = {
            ...mark!,
            points:
              mark!.tool === "pen" ? [...mark!.points, p] : [startPoint, p],
          };
        // Closed pen loops remain meaningful even when the final point is the start.
        changed = mark!.points.some(
          (value) =>
            Math.hypot(value.x - startPoint.x, value.y - startPoint.y) * scale >
            2,
        );
        next = changed ? [...base, mark!] : base;
      } else {
        changed =
          Math.hypot(p.x - startPoint.x, p.y - startPoint.y) * scale > 0.5;
        const transformed = handle
          ? resizeImageAnnotation(originalMark!, box!, handle, p)
          : moveImageAnnotation(
              originalMark!,
              p.x - startPoint.x,
              p.y - startPoint.y,
            );
        next = changed
          ? base.map((item) =>
              item.id === originalMark!.id ? transformed : item,
            )
          : base;
      }
      setDraft(next);
    }
    target.setPointerCapture(event.pointerId);
    cancelDrag.current = trackPointerDrag(event.nativeEvent, {
      captureTarget: target,
      onMove: (move) => {
        move.preventDefault();
        update(move);
      },
      onEnd: (position, cancelled) => {
        cancelDrag.current = null;
        if (!cancelled) update(position);
        if (cancelled) {
          if (tool === "pan") {
            viewport.current!.scrollLeft = scroll.x;
            viewport.current!.scrollTop = scroll.y;
          }
          setSelectedId(previousSelection);
        } else if (changed) {
          commit(next);
          setSelectedId(mark!.id);
          if (creating && mark!.tool !== "pen") setTool("select");
        }
        setDraft(null);
      },
    });
  }
  function zoomTo(value: number | null) {
    cancelDrag.current?.();
    finishText();
    const el = viewport.current!;
    const viewBox = el.getBoundingClientRect();
    const imageBox = canvas.current!.getBoundingClientRect();
    const center = {
      x: (viewBox.left + el.clientWidth / 2 - imageBox.left) / scale,
      y: (viewBox.top + el.clientHeight / 2 - imageBox.top) / scale,
    };
    const next = value === null ? null : Math.min(4, Math.max(0.05, value));
    setZoom(next);
    requestAnimationFrame(() => {
      if (!viewport.current) return;
      const resized = canvas.current!.getBoundingClientRect();
      el.scrollLeft +=
        resized.left +
        center.x * (next ?? fit) -
        viewBox.left -
        el.clientWidth / 2;
      el.scrollTop +=
        resized.top +
        center.y * (next ?? fit) -
        viewBox.top -
        el.clientHeight / 2;
    });
  }
  async function save() {
    if (!image.apply || !bitmap.current || busy || cancelDrag.current) return;
    const finalMarks = finishText();
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      // Export independently: selection handles, zoom and original preview never enter the image.
      const exported = document.createElement("canvas");
      exported.width = size.width;
      exported.height = size.height;
      paintImageAnnotations(
        exported.getContext("2d")!,
        bitmap.current,
        finalMarks,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        exported.toBlob(
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
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  const disabled = busy || !ready;
  return (
    <Modal
      title="이미지 편집"
      className="document-image-modal document-image-edit-modal"
      onClose={() => {
        if (!busy) {
          cancelDrag.current?.();
          onClose();
        }
      }}
    >
      <div
        className="document-image-editor"
        onKeyDown={(event) => {
          if (
            busy ||
            event.defaultPrevented ||
            (event.target as HTMLElement).closest(
              "input, textarea, select, [contenteditable=true]",
            )
          )
            return;
          if (
            (event.metaKey || event.ctrlKey) &&
            (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
          ) {
            event.preventDefault();
            event.stopPropagation();
            undo(event.shiftKey || event.key.toLowerCase() === "y");
          } else if (
            event.key === "Enter" &&
            event.target === canvas.current &&
            selected?.tool === "text" &&
            !original
          ) {
            event.preventDefault();
            event.stopPropagation();
            flushSync(() => beginText(selected));
          } else if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            event.stopPropagation();
            remove();
          } else if (event.key === "Escape" && selectedId) {
            event.preventDefault();
            event.stopPropagation();
            setSelectedId(null);
          }
        }}
      >
        <DocumentImageTools
          placement="top"
          tool={tool}
          onTool={chooseTool}
          disabled={disabled}
          style={selected ?? style}
          onStyle={changeStyle}
          textVisible={tool === "text" || selected?.tool === "text"}
          scale={scale}
          onZoom={zoomTo}
          undo={() => undo()}
          redo={() => undo(true)}
          canUndo={!!history.past.length || marks !== history.marks}
          canRedo={!!history.future.length}
          remove={() => remove()}
          clear={() => remove(true)}
          hasSelection={!!selected}
          hasMarks={!!marks.length}
          original={original}
          onOriginal={() => {
            cancelDrag.current?.();
            finishText();
            setOriginal(!original);
          }}
          onSave={() => void save()}
          busy={busy}
        />
        <ErrorNote error={error} />
        <div
          ref={viewport}
          className="document-image-editor-surface"
          data-tool={tool}
          data-original={original || undefined}
        >
          <div className="document-image-editor-stage">
            <div
              className="document-image-editor-board"
              style={{
                width: ready ? size.width * scale : undefined,
                height: ready ? size.height * scale : undefined,
              }}
              onPointerDown={start}
              onDoubleClick={(event) => {
                if (
                  disabled ||
                  original ||
                  tool !== "select" ||
                  textEditRef.current
                )
                  return;
                const hit = [...historyRef.current.marks]
                  .reverse()
                  .find((mark) =>
                    hitImageAnnotation(mark, point(event), context!, 5 / scale),
                  );
                if (hit?.tool === "text") flushSync(() => beginText(hit));
              }}
            >
              <canvas ref={canvas} tabIndex={0} aria-label="이미지 강조 영역" />
              {textEdit && bounds && !original && (
                <DocumentImageTextInput
                  mark={textEdit}
                  bounds={bounds}
                  scale={scale}
                  input={textInput}
                  onChange={changeText}
                  onFinish={finishText}
                />
              )}
              {selected &&
                bounds &&
                handles &&
                !original &&
                tool === "select" && (
                  <svg
                    className="document-image-editor-selection"
                    width="100%"
                    height="100%"
                    aria-hidden="true"
                  >
                    <polygon
                      points={["nw", "ne", "se", "sw"]
                        .map(
                          (key) =>
                            `${handles[key as ImageHandle].x * scale},${handles[key as ImageHandle].y * scale}`,
                        )
                        .join(" ")}
                    />
                    <line
                      x1={handles.n.x * scale}
                      y1={handles.n.y * scale}
                      x2={handles.rotate.x * scale}
                      y2={handles.rotate.y * scale}
                    />
                    {IMAGE_HANDLES.map((handle) => (
                      <rect
                        key={handle}
                        data-handle={handle}
                        x={handles[handle].x * scale - 4}
                        y={handles[handle].y * scale - 4}
                        width={8}
                        height={8}
                      />
                    ))}
                    <circle
                      data-handle="rotate"
                      cx={handles.rotate.x * scale}
                      cy={handles.rotate.y * scale}
                      r={5}
                    />
                  </svg>
                )}
            </div>
          </div>
        </div>
        <DocumentImageTools
          placement="bottom"
          tool={tool}
          onTool={chooseTool}
          disabled={disabled || original}
          style={selected ?? style}
          onStyle={changeStyle}
          textVisible={tool === "text" || selected?.tool === "text"}
        />
      </div>
    </Modal>
  );
}
