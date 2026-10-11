import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronUp, ChevronDown, ChevronRight, X } from "lucide-react";
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
  const [scopeOpen, setScopeOpen] = useState(false);
  // null follows all active properties, including properties added later.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const activeProperties = useMemo(
    () => properties.filter((property) => !property.archived),
    [properties],
  );
  const selected = useMemo(
    () => (selectedIds === null ? null : new Set(selectedIds)),
    [selectedIds],
  );
  const searchProperties = useMemo(
    () =>
      activeProperties.filter(
        (property) => !selected || selected.has(property.id),
      ),
    [activeProperties, selected],
  );
  const scopeKey = useMemo(
    () => JSON.stringify(searchProperties.map((property) => property.id)),
    [searchProperties],
  );
  const allSelected =
    activeProperties.length > 0 &&
    searchProperties.length === activeProperties.length;
  const scopeId = useId();
  const scopeTrigger = useRef<HTMLButtonElement>(null);
  const scopePopup = useRef<HTMLDivElement>(null);
  const allCheckbox = useRef<HTMLInputElement>(null);
  const [scopeHeight, setScopeHeight] = useState(320);
  useLayoutEffect(() => {
    if (allCheckbox.current)
      allCheckbox.current.indeterminate =
        !allSelected && searchProperties.length > 0;
  }, [scopeOpen, allSelected, searchProperties.length]);
  useLayoutEffect(() => {
    if (!scopeOpen) return;
    const resize = () => {
      const bottom = scopeTrigger.current!.getBoundingClientRect().bottom;
      setScopeHeight(
        Math.max(80, Math.min(320, window.innerHeight - bottom - 14)),
      );
    };
    resize();
    allCheckbox.current?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !scopePopup.current?.contains(event.target) &&
        !scopeTrigger.current?.contains(event.target)
      )
        setScopeOpen(false);
    };
    // Some browsers do not keep focus on a checkbox clicked with the mouse.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setScopeOpen(false);
      scopeTrigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", resize);
    };
  }, [scopeOpen]);
  function selectProperty(id: string, checked: boolean) {
    setSelectedIds((previous) => {
      const ids = new Set(
        activeProperties
          .filter((property) => !previous || previous.includes(property.id))
          .map((property) => property.id),
      );
      if (checked) ids.add(id);
      else ids.delete(id);
      return ids.size === activeProperties.length ? null : [...ids];
    });
  }
  // Polling creates new objects even when labels have not changed.
  const metadata = useMemo(
    () =>
      JSON.stringify([
        searchProperties.map((p) => [
          p.id,
          p.kind,
          p.archived,
          p.values.map((v) => [v.id, v.label]),
        ]),
        users.map((user) => [user.id, user.name]),
      ]),
    [searchProperties, users],
  );
  const engine = useMemo(
    () => createPropertySearch(searchProperties, users),
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
  const current = useRef<{
    query: string;
    scopeKey: string;
    point: Point | null;
  } | null>(null);
  useLayoutEffect(() => {
    navigate.current = onNavigate;
  });
  useEffect(() => {
    if (!query || composing || !searchProperties.length) {
      setFound(null);
      if (!query) current.current = null;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await engine.find(tasks, query, controller.signal);
      if (!result || controller.signal.aborted) return;
      const previous = current.current;
      const sameQuery =
        previous?.query === query && previous.scopeKey === scopeKey;
      const preserved = sameQuery ? result.indexOf(previous.point) : -1;
      const index = result.count ? Math.max(0, preserved) : -1;
      const point = result.pointAt(index);
      setFound({ query, tasks, engine, result, index });
      current.current = { query, scopeKey, point };
      // Refreshes retain the active result without stealing the user's selection.
      if (point && (!sameQuery || preserved < 0)) navigate.current(point);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, composing, tasks, engine, scopeKey]);

  const ready =
    !!found &&
    found.query === query &&
    found.tasks === tasks &&
    found.engine === engine &&
    !composing;
  const count = ready ? found.result.count : 0;
  const busy = !!query && searchProperties.length > 0 && !ready;
  function move(direction: number) {
    if (!ready || !count) return;
    const index = (found.index + direction + count) % count;
    const point = found.result.pointAt(index)!;
    setFound({ ...found, index });
    current.current = { query, scopeKey, point };
    navigate.current(point);
  }
  function clear() {
    setInput("");
    current.current = null;
    inputRef.current?.focus();
  }
  return (
    <div className="search-box" role="search" aria-label="속성 찾기">
      <button
        ref={scopeTrigger}
        type="button"
        className={`search-scope-toggle ${allSelected ? "" : "active"}`}
        aria-label="검색 대상 속성 선택"
        aria-haspopup="dialog"
        aria-expanded={scopeOpen}
        aria-controls={scopeOpen ? scopeId : undefined}
        title={`검색 대상 속성 선택 (${searchProperties.length}/${activeProperties.length}개)`}
        onClick={() => setScopeOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setScopeOpen(true);
            allCheckbox.current?.focus({ preventScroll: true });
          }
        }}
      >
        {scopeOpen ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
      </button>
      <input
        ref={inputRef}
        aria-label={allSelected ? "전체 속성 검색" : "선택 속성 검색"}
        placeholder={
          allSelected
            ? "전체 속성 검색"
            : searchProperties.length === 1
              ? `${searchProperties[0].name} 검색`
              : searchProperties.length
                ? `${searchProperties.length}개 속성 검색`
                : "검색 대상 선택"
        }
        title="현재 필터에 해당하는 업무의 선택된 속성에서 찾습니다. 숨겨진 행·열은 결과로 이동하면 표시됩니다."
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
      {scopeOpen && (
        <div
          ref={scopePopup}
          id={scopeId}
          role="dialog"
          aria-label="검색 대상 속성 선택"
          className="search-scope-popup"
          style={{ maxHeight: scopeHeight }}
        >
          <div className="search-scope-heading">
            <strong>검색 대상 속성</strong>
            <span>
              {searchProperties.length} / {activeProperties.length}
            </span>
          </div>
          <label className="search-scope-all">
            <input
              ref={allCheckbox}
              type="checkbox"
              checked={allSelected}
              disabled={!activeProperties.length}
              onChange={(event) =>
                setSelectedIds(event.target.checked ? null : [])
              }
            />
            <span>전체 선택</span>
          </label>
          <div
            className="search-scope-list"
            role="group"
            aria-label="속성 목록"
          >
            {activeProperties.map((property) => (
              <label key={property.id}>
                <input
                  type="checkbox"
                  checked={!selected || selected.has(property.id)}
                  onChange={(event) =>
                    selectProperty(property.id, event.target.checked)
                  }
                />
                <span>{property.name}</span>
              </label>
            ))}
          </div>
          {!searchProperties.length && (
            <p className="search-scope-empty">검색할 속성을 선택하세요.</p>
          )}
        </div>
      )}
    </div>
  );
}
