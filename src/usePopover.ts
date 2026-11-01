import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

// 도구 모음 버튼 아래에 띄우는 작은 팝업. 화면 안에 위치를 맞추고, 바깥을
// 누르거나 포커스가 나가면 닫으며, Esc는 팝업을 닫고 버튼으로 포커스를 돌린다.
export function usePopover(width: number) {
  const [open, setOpen] = useState(false);
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
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
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
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return {
    open,
    setOpen,
    position,
    popup,
    trigger,
    close,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    },
    // 모달 안에서는 모달의 최상위 층(dialog)에 붙여야 팝업이 가려지지 않는다.
    container: () => trigger.current?.closest("dialog") || document.body,
  };
}
