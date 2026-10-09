import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Grid2X2 } from "lucide-react";
import { Button } from "./components";
import BorderControls from "./BorderControls";
import type { Border, BorderPreset } from "./types";

export default function BorderMenu({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (preset: BorderPreset, border: Border) => void;
}) {
  const [open, setOpen] = useState(false);
  const [border, setBorder] = useState<Border>({
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
    popup.current?.querySelector("select")?.focus();
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
        title="테두리"
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
                e.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <BorderControls
              label="테두리 선"
              value={border}
              onChange={setBorder}
            />
            <div className="border-actions">
              {(
                [
                  ["outside", "바깥쪽 테두리"],
                  ["all", "모든 테두리"],
                  ["none", "테두리 지우기"],
                ] as const
              ).map(([preset, label]) => (
                <Button
                  key={preset}
                  disabled={disabled}
                  onClick={() => {
                    onApply(preset, border);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <p className="field-help">
              ⌘/Ctrl을 누르고 드래그하면 떨어진 영역도 추가할 수 있습니다.
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
