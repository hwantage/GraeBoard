import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

// 도구 모음 버튼 아래에 띄우는 작은 팝업. 화면 안에 위치를 맞추고, 바깥을
// 누르거나 포커스가 나가면 닫으며, Esc는 팝업을 닫고 버튼으로 포커스를 돌린다.
// focusOnOpen이 false이면 열 때 포커스를 옮기지 않는다. align이 "end"이면
// 팝업의 오른쪽 끝을 버튼의 오른쪽 끝에 맞춘다(화면 오른쪽 끝의 버튼).
export function usePopover(
  width: number,
  focusOnOpen = true,
  align: "start" | "end" = "start",
) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = popup.current?.offsetHeight || 280;
      const popupWidth = popup.current?.offsetWidth || width;
      const top = Math.max(
        8,
        Math.min(rect.bottom + 4, window.innerHeight - height - 8),
      );
      const left = Math.max(
        8,
        Math.min(
          align === "end" ? rect.right - popupWidth : rect.left,
          window.innerWidth - popupWidth - 8,
        ),
      );
      // An unchanged place keeps the same object, so the popup does not
      // render again.
      setPosition((previous) =>
        previous.top === top && previous.left === left
          ? previous
          : { top, left },
      );
    };
    // Scrolling inside the popup (a long list) does not move it.
    const scrolled = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    place();
    if (focusOnOpen) popup.current?.querySelector("button")?.focus();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scrolled, true);
      observer.disconnect();
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
      // An Esc that ends a Korean composition stays in the input.
      if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    },
    // Nested border colors stay inside their parent popup for outside/focus checks.
    // 모달 안에서는 최상위 층(dialog)에 붙여야 팝업이 가려지지 않는다.
    container: () =>
      trigger.current?.closest(".border-popover") ||
      trigger.current?.closest("dialog") ||
      document.body,
  };
}
