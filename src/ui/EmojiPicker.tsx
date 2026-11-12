import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SmilePlus } from "lucide-react";
import { usePopover } from "./usePopover";
import "./emoji-picker.css";

// The list, search and emoji data load on the first open, not with the page.
// Pointing at or focusing the button fetches them ahead of the click.
const loadPanel = () => import("./EmojiPickerPanel");
const EmojiPickerPanel = lazy(loadPanel);
let prefetched = false;
function prefetchPanel() {
  if (prefetched) return;
  prefetched = true;
  // A failure shows when the list opens (EmojiListBoundary).
  loadPanel().catch(() => {});
}
// A list that cannot load (a removed build file, offline) stays inside the
// popup instead of unmounting the page. React remembers the failed import,
// so the message asks for a reload.
class EmojiListBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="emoji-empty" role="alert">
        이모지 목록을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 열어
        주세요.
      </p>
    ) : (
      this.props.children
    );
  }
}

const editable = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    ((element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement) &&
      !element.readOnly &&
      !element.disabled));

// A button that opens a searchable emoji grid (EmojiPickerPanel). Picking an
// emoji hands it to onPick, closes the grid and returns to the input that was
// being edited, or to the button. Esc closes only the grid.
export default function EmojiPicker({
  label,
  userId,
  className = "",
  onPick,
}: {
  label: string;
  // Recent picks are kept per user in this browser.
  userId: string;
  className?: string;
  onPick: (emoji: string) => void;
}) {
  const {
    open,
    setOpen,
    position,
    popup,
    trigger,
    close,
    onKeyDown,
    container,
  } = usePopover(320, false, "end");
  const returnTo = useRef<HTMLElement | null>(null);
  const touch = useRef(false);
  const [focusSearch, setFocusSearch] = useState(true);
  const latestPick = useRef(onPick);
  useLayoutEffect(() => {
    latestPick.current = onPick;
  });
  // Opened by touch, focus stays outside the grid. Esc then closes the grid
  // first instead of reaching the detail around it.
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        popup.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);
  const pick = useCallback((emoji: string) => {
    // The copy starts inside this click, which the clipboard requires.
    latestPick.current(emoji);
    setOpen(false);
    const back = returnTo.current;
    const dialog = trigger.current?.closest("dialog") ?? null;
    if (
      back?.isConnected &&
      editable(back) &&
      back.closest("dialog") === dialog
    )
      back.focus({ preventScroll: true });
    else trigger.current?.focus({ preventScroll: true });
  }, []);
  function toggle() {
    if (open) {
      close();
      return;
    }
    const focused = document.activeElement;
    returnTo.current = editable(focused) ? focused : null;
    // A touch opens the grid without the on-screen keyboard.
    setFocusSearch(!touch.current);
    setOpen(true);
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`button ${className}`}
        data-tooltip={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={prefetchPanel}
        onFocus={prefetchPanel}
        onPointerDown={(event) => {
          touch.current = event.pointerType === "touch";
          prefetchPanel();
        }}
        // Keep the caret where it was, so a pick can return there.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (event.detail === 0) touch.current = false;
          toggle();
        }}
      >
        <SmilePlus size={16} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="emoji-popover"
            role="dialog"
            aria-label={label}
            style={position}
            onKeyDown={onKeyDown}
            onMouseDown={(event) => {
              // WebKit focuses the surrounding modal when a non-input part of
              // the popup is pressed, which reads as an outside focus. The
              // list's own scroll bar still takes the press.
              const target = event.target as Element;
              if (
                !(target instanceof HTMLInputElement) &&
                !target.classList.contains("emoji-scroll")
              )
                event.preventDefault();
            }}
          >
            <EmojiListBoundary>
              <Suspense
                fallback={
                  <p className="emoji-empty" role="status">
                    이모지 목록을 불러오는 중…
                  </p>
                }
              >
                <EmojiPickerPanel
                  userId={userId}
                  focusSearch={focusSearch}
                  onPick={pick}
                />
              </Suspense>
            </EmojiListBoundary>
          </div>,
          container(),
        )}
    </>
  );
}
