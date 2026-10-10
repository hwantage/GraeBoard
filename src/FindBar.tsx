import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Search, X } from "lucide-react";
import {
  createPropertySearch,
  normalizeSearchQuery,
} from "../shared/search.js";
import type { Point, Property, Task, User } from "./types";

type SearchResult = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createPropertySearch>["find"]>>
>;

export default function FindBar({
  tasks,
  properties,
  users,
  onNavigate,
}: {
  tasks: Task[];
  properties: Property[];
  users: User[];
  onNavigate: (point: Point) => void;
}) {
  const [input, setInput] = useState("");
  const [composing, setComposing] = useState(false);
  // Polling creates new objects even when labels have not changed.
  const metadata = JSON.stringify([
    properties.map((p) => [
      p.id,
      p.kind,
      p.archived,
      p.values.map((v) => [v.id, v.label]),
    ]),
    users.map((user) => [user.id, user.name]),
  ]);
  const engine = useMemo(
    () => createPropertySearch(properties, users),
    [metadata],
  );
  const query = normalizeSearchQuery(input);
  const [found, setFound] = useState<{
    query: string;
    tasks: Task[];
    engine: typeof engine;
    result: SearchResult;
    index: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useRef(onNavigate);
  const current = useRef<{ query: string; point: Point | null } | null>(null);
  useLayoutEffect(() => {
    navigate.current = onNavigate;
  });
  useEffect(() => {
    if (!query || composing) {
      setFound(null);
      if (!query) current.current = null;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await engine.find(tasks, query, controller.signal);
      if (!result || controller.signal.aborted) return;
      const previous = current.current;
      const sameQuery = previous?.query === query;
      const preserved = sameQuery ? result.indexOf(previous.point) : -1;
      const index = result.count ? Math.max(0, preserved) : -1;
      const point = result.pointAt(index);
      setFound({ query, tasks, engine, result, index });
      current.current = { query, point };
      // Refreshes retain the active result without stealing the user's selection.
      if (point && (!sameQuery || preserved < 0)) navigate.current(point);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, composing, tasks, engine]);

  const ready =
    !!found &&
    found.query === query &&
    found.tasks === tasks &&
    found.engine === engine &&
    !composing;
  const count = ready ? found.result.count : 0;
  const busy = !!query && !ready;
  function move(direction: number) {
    if (!ready || !count) return;
    const index = (found.index + direction + count) % count;
    const point = found.result.pointAt(index)!;
    setFound({ ...found, index });
    current.current = { query, point };
    navigate.current(point);
  }
  function clear() {
    setInput("");
    current.current = null;
    inputRef.current?.focus();
  }
  return (
    <div className="search-box" role="search" aria-label="전체 속성 찾기">
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        aria-label="전체 속성 검색"
        placeholder="전체 속성 검색"
        title="현재 필터에 해당하는 업무의 전체 속성에서 찾습니다. 숨겨진 행·열은 결과로 이동하면 표시됩니다."
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            composing ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Enter") {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            clear();
          }
        }}
      />
      <span
        className="search-count"
        role="status"
        aria-live="polite"
        aria-label={
          busy
            ? "검색 중"
            : `검색 결과 ${count}개${count ? ` 중 ${found!.index + 1}번째` : ""}`
        }
        title="일치하는 셀 수"
      >
        {busy ? "검색 중" : `${count ? found!.index + 1 : 0} / ${count}`}
      </span>
      <button
        type="button"
        aria-label="이전 검색 결과"
        title="이전 검색 결과 (Shift+Enter)"
        disabled={!count}
        onClick={() => move(-1)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        aria-label="다음 검색 결과"
        title="다음 검색 결과 (Enter)"
        disabled={!count}
        onClick={() => move(1)}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        aria-label="검색 지우기"
        title="검색 지우기 (Esc)"
        disabled={!input}
        onClick={clear}
      >
        <X size={13} />
      </button>
    </div>
  );
}
