import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Clock3, Search } from "lucide-react";
import {
  EMOJI_CATEGORIES,
  EMOJI_ENTRIES,
  searchEmojis,
  type EmojiEntry,
} from "./emoji-catalog";

const RECENT_LIMIT = 16;
const recentKey = (userId: string) => `weekly-plan:recent-emojis:${userId}`;
// Recent picks stay for this page when the browser blocks storage.
const sessionRecent = new Map<string, string[]>();
let persistent = true;

function readRecent(userId: string): string[] {
  if (persistent)
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(recentKey(userId)) || "[]",
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
  return sessionRecent.get(userId) ?? [];
}

function rememberEmoji(userId: string, emoji: string) {
  const next = [
    emoji,
    ...readRecent(userId).filter((item) => item !== emoji),
  ].slice(0, RECENT_LIMIT);
  sessionRecent.set(userId, next);
  try {
    localStorage.setItem(recentKey(userId), JSON.stringify(next));
    persistent = true;
  } catch {
    persistent = false;
  }
}

type EmojiList = {
  id: string;
  name: string;
  icon: ReactNode;
  emojis: EmojiEntry[];
};

// Only the options whose tab stop changes render again when focus moves.
const EmojiOption = memo(function EmojiOption({
  entry,
  slot,
  tabbable,
  onChoose,
}: {
  entry: EmojiEntry;
  slot: string;
  tabbable: boolean;
  onChoose: (emoji: string) => void;
}) {
  return (
    <button
      type="button"
      className="emoji-option"
      data-emoji={entry.emoji}
      data-slot={slot}
      aria-label={entry.name}
      data-tooltip={entry.name}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onChoose(entry.emoji)}
    >
      {entry.emoji}
    </button>
  );
});

// The body of EmojiPicker's popup: search, categories, the recent row and
// the emoji grids (emoji-catalog.ts). It mounts on each open, so the search
// and recent row start fresh. The emoji form one tab stop; arrow keys move
// between them.
export default function EmojiPickerPanel({
  userId,
  focusSearch,
  onPick,
}: {
  userId: string;
  focusSearch: boolean;
  onPick: (emoji: string) => void;
}) {
  const [recent] = useState(() => readRecent(userId));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() =>
    recent.length ? "recent" : EMOJI_CATEGORIES[0].id,
  );
  const [tabStop, setTabStop] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const jumpTo = useRef<string | null>(null);
  const latestPick = useRef(onPick);
  useLayoutEffect(() => {
    latestPick.current = onPick;
  });
  const choose = useCallback(
    (emoji: string) => {
      rememberEmoji(userId, emoji);
      latestPick.current(emoji);
    },
    [userId],
  );
  const sections = useMemo<EmojiList[]>(
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
  const lists = useMemo(
    () =>
      results
        ? [{ id: "results", name: "검색 결과", icon: null, emojis: results }]
        : sections,
    [results, sections],
  );
  const slots = useMemo(
    () =>
      new Set(
        lists.flatMap((list) =>
          list.emojis.map((entry) => `${list.id}:${entry.emoji}`),
        ),
      ),
    [lists],
  );
  // The last focused emoji keeps the tab stop while it is shown.
  const stop = slots.has(tabStop)
    ? tabStop
    : (slots.values().next().value ?? "");
  useLayoutEffect(() => {
    if (focusSearch) search.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const id = jumpTo.current;
    if (results || !id) return;
    jumpTo.current = null;
    const section = scroller.current?.querySelector<HTMLElement>(
      `[data-category="${id}"]`,
    );
    if (scroller.current && section)
      scroller.current.scrollTop = section.offsetTop;
    setActive(id);
  });

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
      ...(root.current?.querySelectorAll<HTMLButtonElement>(".emoji-option") ??
        []),
    ];
    if (event.target === search.current) {
      if (event.nativeEvent.isComposing || !options.length) return;
      if (event.key === "ArrowDown") {
        // Into the category chosen above, or the first search result.
        const first =
          (!results &&
            root.current?.querySelector<HTMLButtonElement>(
              `[data-category="${active}"] .emoji-option`,
            )) ||
          options[0];
        event.preventDefault();
        first.focus({ preventScroll: true });
        first.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && query.trim()) {
        event.preventDefault();
        choose(options[0].dataset.emoji!);
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
    next?.focus({ preventScroll: true });
    // The list's scroll padding keeps it clear of the sticky heading.
    next?.scrollIntoView({ block: "nearest" });
  }
  const grid = (list: EmojiList) => (
    <div className="emoji-grid">
      {list.emojis.map((entry) => {
        const slot = `${list.id}:${entry.emoji}`;
        return (
          <EmojiOption
            key={entry.emoji}
            entry={entry}
            slot={slot}
            tabbable={slot === stop}
            onChoose={choose}
          />
        );
      })}
    </div>
  );
  return (
    <div
      ref={root}
      className="emoji-picker-panel"
      onKeyDown={move}
      onFocus={(event) => {
        const slot = (event.target as HTMLElement).dataset.slot;
        if (slot) setTabStop(slot);
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
      <div className="emoji-categories" role="group" aria-label="이모지 분류">
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
            <section aria-label="검색 결과">{grid(lists[0])}</section>
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
              {grid(section)}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
