import { useLayoutEffect, useRef, type RefObject } from "react";
import type {
  ImageAnnotation,
  ImageBounds,
} from "./document-image-annotations";

export default function DocumentImageTextInput({
  mark,
  bounds,
  scale,
  input,
  onChange,
  onFinish,
}: {
  mark: ImageAnnotation;
  bounds: ImageBounds;
  scale: number;
  input: RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  onFinish: (cancel?: boolean) => void;
}) {
  const composing = useRef(false);
  useLayoutEffect(() => {
    const el = input.current!;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [input]);
  // Keep the native font at least 16px for mobile focus; scale only its visual
  // representation so caret, selected text and the exported canvas agree.
  const fontSize = Math.max(16, mark.fontSize);
  const ratio = fontSize / mark.fontSize;
  return (
    <div
      className="document-image-text-position"
      style={{
        left: bounds.x * scale,
        top: bounds.y * scale,
        width: bounds.width * scale,
        height: bounds.height * scale,
        transform: `rotate(${mark.rotation}rad)`,
      }}
    >
      <textarea
        ref={input}
        className="document-image-text-input"
        aria-label="이미지에 넣을 글자"
        placeholder="글자 입력"
        value={mark.text}
        wrap="off"
        spellCheck={false}
        style={{
          width:
            Math.max(bounds.width + mark.fontSize * 0.6, 96 / scale) * ratio,
          height: bounds.height * ratio,
          fontSize,
          lineHeight: `${fontSize * 1.2}px`,
          color: mark.stroke,
          transform: `scale(${scale / ratio})`,
        }}
        onChange={(event) => onChange(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()}
        onCut={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
        onBlur={() => {
          if (!composing.current) onFinish();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onChange(event.currentTarget.value);
          if (document.activeElement !== event.currentTarget) onFinish();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.nativeEvent.isComposing ||
            composing.current ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            onFinish(true);
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            onFinish();
          }
        }}
      />
    </div>
  );
}
