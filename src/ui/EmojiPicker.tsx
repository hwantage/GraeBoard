import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Clock3, Search, SmilePlus } from "lucide-react";
import { usePopover } from "./usePopover";
import {
  EMOJI_CATEGORIES,
  EMOJI_ENTRIES,
  searchEmojis,
  type EmojiEntry,
} from "./emoji-catalog";
import "./emoji-picker.css";

const RECENT_KEY = "weekly-plan:recent-emojis";
const RECENT_LIMIT = 16;
// Recent picks stay for this page when the browser blocks storage.
let sessionRecent: string[] = [];
let persistent = true;

function readRecent(): string[] {
  if (persistent)
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(RECENT_KEY) || "[]",
      );
      return Array.isArray(stored)
        ? [
            ...new Set(
              stored.filter(
                (value): value is string =>
                  typeof value === "string" && EMOJI_ENTRIES.has(value),
              ),
            ),
          ].slice(0, RECENT_LIMIT)
        : [];
    } catch {
      persistent = false;
    }
  return sessionRecent;
}

function rememberEmoji(emoji: string) {
  const next = [emoji, ...readRecent().filter((item) => item !== emoji)].slice(
    0,
    RECENT_LIMIT,
  );
  sessionRecent = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    persistent = true;
  } catch {
    persistent = false;
  }
  return next;
}

const editable = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    ((element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement) &&
      !element.readOnly &&
      !element.disabled));

type Section = {
  id: string;
  name: string;
  icon: ReactNode;
  emojis: EmojiEntry[];
};

// A button that opens a searchable emoji grid (emoji-catalog.ts). Picking an
// emoji hands it to onPick, closes the grid and returns to the input that was
// being edited, or to the button. Esc closes only the grid.
export default function EmojiPicker({
  label,
  className = "",
  onPick,
}: {
  label: string;
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
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const touch = useRef(false);
  const jumpTo = useRef<string | null>(null);
  const sections = useMemo<Section[]>(
    () => [
      ...(recent.length
        ? [
            {
              id: "recent",
              name: "최근 사용",
              icon: <Clock3 size={15} aria-hidden="true" />,
              emojis: recent.map((emoji) => EMOJI_ENTRIES.get(emoji)!),
            },
          ]
        : []),
      ...EMOJI_CATEGORIES,
    ],
    [recent],
  );
  const results = useMemo(
    () => (query.trim() ? searchEmojis(query) : null),
    [query],
  );
  // A touch opens the grid without the on-screen keyboard.
  useLayoutEffect(() => {
    if (open && !touch.current) search.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    const id = jumpTo.current;
    if (!open || results || !id) return;
    jumpTo.current = null;
    const section = scroller.current?.querySelector<HTMLElement>(
      `[data-category="${id}"]`,
    );
    if (scroller.current && section)
      scroller.current.scrollTop = section.offsetTop;
    setActive(id);
  });

  function toggle() {
    if (open) {
      close();
      return;
    }
    const focused = document.activeElement;
    returnTo.current = editable(focused) ? focused : null;
    const stored = readRecent();
    setRecent(stored);
    setQuery("");
    setActive(stored.length ? "recent" : EMOJI_CATEGORIES[0].id);
    setOpen(true);
  }
  function pick(emoji: string) {
    setRecent(rememberEmoji(emoji));
    // The copy starts inside this click, which the clipboard requires.
    onPick(emoji);
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
  }
  function jump(id: string) {
    jumpTo.current = id;
    setQuery("");
    setActive(id);
  }
  function track() {
    const box = scroller.current;
    if (!box) return;
    const shown = [...box.querySelectorAll<HTMLElement>("[data-category]")];
    let current = shown[0]?.dataset.category ?? "";
    for (const section of shown)
      if (section.offsetTop <= box.scrollTop + 8)
        current = section.dataset.category!;
    // The last sections cannot reach the top at the end of the list, so a
    // chosen one stays marked while its heading is in view.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1)
      setActive((chosen) => {
        const section = shown.find((item) => item.dataset.category === chosen);
        return section && section.offsetTop >= box.scrollTop - 1
          ? chosen
          : current;
      });
    else setActive(current);
  }
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const options = [
      ...(popup.current?.querySelectorAll<HTMLButtonElement>(".emoji-option") ??
        []),
    ];
    if (event.target === search.current) {
      if (event.nativeEvent.isComposing || !options.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        options[0].focus();
      } else if (event.key === "Enter" && query.trim()) {
        event.preventDefault();
        pick(options[0].dataset.emoji!);
      }
      return;
    }
    const index = options.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = options[index + 1];
    else if (event.key === "ArrowLeft") next = options[index - 1];
    else if (event.key === "Home") next = options[0];
    else if (event.key === "End") next = options.at(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Rows differ between sections, so move to the nearest option on the
      // next row by position.
      const down = event.key === "ArrowDown";
      const from = options[index].getBoundingClientRect();
      const middle = from.left + from.width / 2;
      const rows = options
        .map((option) => ({ option, box: option.getBoundingClientRect() }))
        .filter(({ box }) =>
          down
            ? box.top > from.top + from.height / 2
            : box.top < from.top - from.height / 2,
        );
      if (rows.length) {
        const top = down
          ? Math.min(...rows.map(({ box }) => box.top))
          : Math.max(...rows.map(({ box }) => box.top));
        next = rows
          .filter(({ box }) => Math.abs(box.top - top) < 1)
          .sort(
            (a, b) =>
              Math.abs(a.box.left + a.box.width / 2 - middle) -
              Math.abs(b.box.left + b.box.width / 2 - middle),
          )[0]?.option;
      } else if (!down) {
        event.preventDefault();
        search.current?.focus();
        return;
      }
    } else return;
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  }
  const grid = (entries: EmojiEntry[]) => (
    <div className="emoji-grid">
      {entries.map((entry) => (
        <button
          key={entry.emoji}
          type="button"
          className="emoji-option"
          data-emoji={entry.emoji}
          aria-label={entry.name}
          data-tooltip={entry.name}
          onClick={() => pick(entry.emoji)}
        >
          {entry.emoji}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`button emoji-picker-trigger ${className}`}
        data-tooltip={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(event) => {
          touch.current = event.pointerType === "touch";
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
            onKeyDown={(event) => {
              onKeyDown(event);
              if (!event.defaultPrevented) move(event);
            }}
            onMouseDown={(event) => {
              // WebKit focuses the surrounding modal when a non-input part of
              // the popup is pressed, which reads as an outside focus.
              if (
                !(event.target instanceof HTMLInputElement) &&
                event.target !== scroller.current
              )
                event.preventDefault();
            }}
          >
            <label className="emoji-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={search}
                type="text"
                aria-label="이모지 검색"
                placeholder="이모지 검색 (예: 웃음, 하트, 체크)"
                autoComplete="off"
                enterKeyHint="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div
              className="emoji-categories"
              role="group"
              aria-label="이모지 분류"
            >
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-label={section.name}
                  data-tooltip={section.name}
                  aria-current={
                    !results && active === section.id ? "true" : undefined
                  }
                  onClick={() => jump(section.id)}
                >
                  {section.icon}
                </button>
              ))}
            </div>
            <div
              ref={scroller}
              className="emoji-scroll"
              tabIndex={-1}
              onScroll={results ? undefined : track}
            >
              {results ? (
                results.length ? (
                  <section aria-label="검색 결과">{grid(results)}</section>
                ) : (
                  <p className="emoji-empty">찾는 이모지가 없습니다.</p>
                )
              ) : (
                sections.map((section) => (
                  <section
                    key={section.id}
                    data-category={section.id}
                    aria-label={section.name}
                  >
                    <h3>{section.name}</h3>
                    {grid(section.emojis)}
                  </section>
                ))
              )}
            </div>
          </div>,
          container(),
        )}
    </>
  );
}
