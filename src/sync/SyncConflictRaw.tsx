import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export const conflictRawText = (value: unknown) =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "없음");

const sides = [
  ["base", "원래 내용"],
  ["current", "지금 내용(먼저 수정 반영)"],
  ["desired", "나중에 수정"],
] as const;

/** Serialize and mount raw values only while their disclosure is open. */
export default function SyncConflictRaw({
  conflict,
}: {
  conflict: { base: unknown; current: unknown; desired: unknown };
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="sync-conflict-raw"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>원본 JSON 보기</summary>
      {open && (
        <dl>
          {sides.map(([side, label]) => (
            <RawValue key={side} label={label} value={conflict[side]} />
          ))}
        </dl>
      )}
    </details>
  );
}

function RawValue({ label, value }: { label: string; value: unknown }) {
  const { text, ends } = useMemo(() => {
    const text = conflictRawText(value);
    const ends: number[] = [];
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const lineEnd = newline < 0 ? text.length : newline + 1;
      while (start < lineEnd) {
        let end = Math.min(start + 1024, lineEnd);
        // JSON strings can contain a whole document on one escaped line.
        // Bound each layout fragment without splitting a surrogate pair.
        const last = text.charCodeAt(end - 1);
        if (end < lineEnd && last >= 0xd800 && last <= 0xdbff) end--;
        ends.push(end);
        start = end;
      }
    }
    return { text, ends };
  }, [value]);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {ends.length > 200 || text.length > 20000 ? (
          <VirtualRawValue label={label} text={text} ends={ends} />
        ) : (
          <pre className="sync-conflict-raw-value">{text}</pre>
        )}
      </dd>
    </>
  );
}

/** Use the comparison view's virtual scrolling for bounded raw fragments. */
function VirtualRawValue({
  label,
  text,
  ends,
}: {
  label: string;
  text: string;
  ends: number[];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: ends.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 19.2,
    overscan: 8,
    // Keep the last value in view as wrapped fragments get measured.
    anchorTo: "end",
    useAnimationFrameWithResizeObserver: true,
  });
  useEffect(() => {
    virtual.measure();
  }, [text, virtual]);
  return (
    <div
      ref={scroll}
      className="sync-conflict-raw-value sync-diff-virtual"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => (
          <pre
            key={item.key}
            data-index={item.index}
            ref={virtual.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            }}
          >
            {text.slice(
              item.index === 0 ? 0 : ends[item.index - 1],
              ends[item.index],
            )}
          </pre>
        ))}
      </div>
    </div>
  );
}
