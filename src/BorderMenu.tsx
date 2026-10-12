import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eraser, Grid2X2 } from "lucide-react";
import BorderControls from "./BorderControls";
import { BORDER_PRESETS } from "../shared/borders.js";
import type { Border, BorderPreset } from "./types";

// 아이콘에서 강조할 선. 바깥 네 변과 가운데 가로·세로선.
const SEGMENTS = {
  top: "M2 2H16",
  right: "M16 2V16",
  bottom: "M2 16H16",
  left: "M2 2V16",
  horizontal: "M2 9H16",
  vertical: "M9 2V16",
};
type Segment = keyof typeof SEGMENTS;
const OUTSIDE: Segment[] = ["top", "right", "bottom", "left"];
const ICON_SEGMENTS: Record<Exclude<BorderPreset, "none">, Segment[]> = {
  all: [...OUTSIDE, "horizontal", "vertical"],
  inner: ["horizontal", "vertical"],
  horizontal: ["horizontal"],
  vertical: ["vertical"],
  outside: OUTSIDE,
  left: ["left"],
  top: ["top"],
  right: ["right"],
  bottom: ["bottom"],
};
// 셀 하나에 적용하는 기본 서식에는 안쪽 경계가 없다.
const INNER_PRESETS: BorderPreset[] = ["inner", "horizontal", "vertical"];

function BorderIcon({ preset }: { preset: BorderPreset }) {
  if (preset === "none") return <Eraser size={16} aria-hidden="true" />;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d={Object.values(SEGMENTS).join(" ")}
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeDasharray="1 2"
        fill="none"
      />
      <path
        d={ICON_SEGMENTS[preset].map((k) => SEGMENTS[k]).join(" ")}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        fill="none"
      />
    </svg>
  );
}

export default function BorderMenu({
  disabled,
  onApply,
  single = false,
}: {
  disabled: boolean;
  single?: boolean;
  onApply: (preset: BorderPreset, border: Border | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [border, setBorder] = useState<Border | null>({
    style: "solid",
    color: "#607984",
  });
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = popup.current?.offsetHeight || 280;
      setPosition({
        top: Math.max(
          8,
          Math.min(rect.bottom + 4, window.innerHeight - height - 8),
        ),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      });
    };
    place();
    popup.current?.querySelector("button")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="button"
        data-tooltip="테두리"
        aria-label="테두리"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Grid2X2 size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="border-popover"
            style={position}
            role="dialog"
            aria-label="선택 영역 테두리"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <BorderControls
              label="테두리 선"
              value={border || undefined}
              allowNone
              defaultSelected={border === null}
              onDefault={() => setBorder(null)}
              onChange={setBorder}
            />
            <div
              className="border-presets"
              role="group"
              aria-label="테두리 위치"
              // WebKit otherwise focuses the parent dialog before the click,
              // which dismisses this popup before its action can run.
              onMouseDown={(e) => e.preventDefault()}
            >
              {(BORDER_PRESETS as { value: BorderPreset; label: string }[])
                .filter((p) => !single || !INNER_PRESETS.includes(p.value))
                .map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className="border-preset"
                    data-tooltip={label}
                    aria-label={label}
                    disabled={disabled}
                    onClick={() => {
                      onApply(value, border);
                      setOpen(false);
                      trigger.current?.focus();
                    }}
                  >
                    <BorderIcon preset={value} />
                  </button>
                ))}
            </div>
          </div>,
          trigger.current?.closest("dialog") || document.body,
        )}
    </>
  );
}
