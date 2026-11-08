import { useEffect, useRef, useState } from "react";
import { FileText, ListFilter, Search } from "lucide-react";
import { addDays } from "../../shared/calendar.js";
import { propertiesFor } from "../../shared/domain.js";
import { normalizeSearchQuery } from "../../shared/search.js";
import { api, send } from "../platform/api";
import { busyProps } from "../ui/busyProps";
import { Button, ErrorNote, Modal } from "../components";
import LoadingState from "../ui/LoadingState";
import MemberValue from "../MemberValue";
import PropertyBadge from "../PropertyBadge";
import PropertyFilter from "../PropertyFilter";
import Select from "../ui/Select";
import { usePropertyFilterTasks } from "./CalendarSettings";
import type {
  CalendarTaskFilter,
  CalendarTaskOption,
  WeeklyAddResult,
  WeeklyItem,
} from "./calendar-types";
import type { FilterMode, Settings, User } from "../types";

type TaskPage = { tasks: CalendarTaskOption[]; nextOffset: number | null };

export default function CalendarTaskPicker({
  teamId,
  settings,
  members,
  userId,
  ownerName,
  weekStart,
  onAdded,
  onClose,
}: {
  teamId: string;
  settings: Settings;
  members: User[];
  userId: string;
  ownerName: string;
  weekStart: string;
  onAdded: (weekly: WeeklyItem[]) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    (TaskPage & { key: string; error: string }) | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Attribute filters use the annual board's PropertyFilter. The title has its
  // own search, so every other active property can be filtered.
  const properties = propertiesFor(settings).filter((p) => p.id !== "title");
  const owner = properties.find((p) => p.id === "owner");
  const status = properties.find((p) => p.id === "status");
  const [showFilters, setShowFilters] = useState(false);
  const [filterId, setFilterId] = useState(
    status?.id || properties[0]?.id || "",
  );
  const [filters, setFilters] = useState<
    Record<string, { values: string[]; mode: FilterMode }>
  >({});
  const filterProperty = properties.find((p) => p.id === filterId);
  const filterValues = usePropertyFilterTasks(
    teamId,
    showFilters ? filterProperty : undefined,
    weekStart,
  );
  const search = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const alive = useRef(true);
  const q = normalizeSearchQuery(input);
  const applied: CalendarTaskFilter[] = properties.flatMap((p) =>
    filters[p.id]?.values.length
      ? [{ propertyId: p.id, ...filters[p.id] }]
      : [],
  );
  const filterQuery = applied.length ? JSON.stringify(applied) : "";
  const key = JSON.stringify([
    teamId,
    userId,
    weekStart,
    q,
    filterQuery,
    offset,
    attempt,
  ]);
  const ready = result?.key === key;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void api<TaskPage>(
          `/calendar/tasks?${new URLSearchParams({
            teamId,
            userId,
            weekStart,
            q,
            offset: String(offset),
            ...(filterQuery ? { filters: filterQuery } : {}),
          })}`,
          { signal: controller.signal },
        )
          .then((page) => {
            if (!controller.signal.aborted)
              setResult({ ...page, key, error: "" });
          })
          .catch((e: Error) => {
            if (!controller.signal.aborted)
              setResult({ key, tasks: [], nextOffset: null, error: e.message });
          });
      },
      q || filterQuery ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  function changeFilter(
    propertyId: string,
    change: Partial<{ values: string[]; mode: FilterMode }>,
  ) {
    setFilters((previous) => ({
      ...previous,
      [propertyId]: {
        ...(previous[propertyId] || { values: [], mode: "include" }),
        ...change,
      },
    }));
    setOffset(0);
  }
  async function add() {
    if (saving.current || !selected.length) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await send<WeeklyAddResult>("/calendar/weekly", {
        teamId,
        userId,
        weekStart,
        taskIds: selected,
      });
      if (!alive.current) return;
      onAdded(saved.weekly);
      onClose();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="주간 업무 추가"
      wide
      className="calendar-task-picker"
      initialFocus={search}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <p className="calendar-hint">
        {ownerName} · {weekStart} ~ {addDays(weekStart, 6)}
      </p>
      <div className="calendar-task-toolbar">
        <label className="user-search calendar-task-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={search}
            type="search"
            aria-label="업무 제목 검색"
            placeholder="업무 제목 검색"
            maxLength={120}
            value={input}
            {...busyProps(busy)}
            onChange={(event) => {
              setInput(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        {!!properties.length && (
          <Button
            active={showFilters || !!applied.length}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((value) => !value)}
          >
            <ListFilter size={14} aria-hidden="true" />
            {`속성 필터${applied.length ? ` (${applied.length})` : ""}`}
          </Button>
        )}
      </div>
      <div
        className={`calendar-task-browser${showFilters ? " has-filters" : ""}`}
      >
        {showFilters && (
          <div
            className="calendar-task-filters"
            role="group"
            aria-label="속성 필터"
          >
            <label className="calendar-field">
              필터 속성
              <Select
                aria-label="필터 속성"
                value={filterId}
                disabled={busy}
                onChange={(event) => setFilterId(event.target.value)}
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.name}${filters[p.id]?.values.length ? ` (${filters[p.id].values.length})` : ""}`}
                  </option>
                ))}
              </Select>
            </label>
            {filterValues.loading && (
              <p role="status" className="calendar-hint">
                필터 값을 불러오고 있습니다…
              </p>
            )}
            {filterValues.error && (
              <>
                <ErrorNote error={filterValues.error} />
                <Button onClick={filterValues.retry}>
                  필터 값 다시 불러오기
                </Button>
              </>
            )}
            {filterProperty && !filterValues.loading && !filterValues.error && (
              <fieldset className="calendar-rule-filter" disabled={busy}>
                <PropertyFilter
                  key={filterProperty.id}
                  property={filterProperty}
                  tasks={filterValues.tasks}
                  users={members}
                  selected={filters[filterProperty.id]?.values || []}
                  mode={filters[filterProperty.id]?.mode || "include"}
                  onChange={(values) =>
                    changeFilter(filterProperty.id, { values })
                  }
                  onModeChange={(mode) =>
                    changeFilter(filterProperty.id, { mode })
                  }
                />
              </fieldset>
            )}
          </div>
        )}
        <div
          className="calendar-task-options"
          aria-label="추가할 업무"
          aria-busy={!ready}
        >
          {!ready ? (
            <LoadingState
              className="compact calendar-task-loading"
              label="업무를 불러오는 중"
            />
          ) : (
            result.tasks.map((task) => (
              <label key={task.id} className="calendar-task-option">
                <input
                  type="checkbox"
                  aria-label={task.title}
                  checked={task.added || selected.includes(task.id)}
                  {...busyProps(
                    busy,
                    task.added ||
                      (selected.length >= 100 && !selected.includes(task.id)),
                  )}
                  onChange={(event) => {
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, task.id]
                        : previous.filter((id) => id !== task.id),
                    );
                  }}
                />
                <span className="calendar-task-summary">
                  <strong>
                    {task.title}
                    {task.hasDocument && (
                      <span
                        className="calendar-task-document"
                        role="img"
                        aria-label={
                          task.documentCount > 1
                            ? `문서 ${task.documentCount}개`
                            : "문서 있음"
                        }
                        title={
                          task.documentCount > 1
                            ? `문서 ${task.documentCount}개`
                            : "문서 있음"
                        }
                      >
                        {task.documentCount > 1 && (
                          <span
                            className="task-document-count"
                            aria-hidden="true"
                          >
                            {task.documentCount}
                          </span>
                        )}
                        <FileText size={11} aria-hidden="true" />
                      </span>
                    )}
                  </strong>
                  <small>
                    {task.years.join(" · ")}
                    {task.added && " · 추가됨"}
                  </small>
                </span>
                <span className="calendar-task-details">
                  {owner && (
                    <MemberValue
                      property={owner}
                      value={task.owner}
                      users={members}
                    />
                  )}
                  {status && (
                    <PropertyBadge property={status} value={task.status} />
                  )}
                </span>
              </label>
            ))
          )}
          {ready && !result.tasks.length && !result.error && (
            <p className="calendar-hint">
              {q || applied.length
                ? "검색된 업무가 없습니다."
                : "추가할 업무가 없습니다."}
            </p>
          )}
        </div>
      </div>
      {ready && result.error && (
        <>
          <ErrorNote error={result.error} />
          <Button
            {...busyProps(busy)}
            onClick={() => setAttempt((value) => value + 1)}
          >
            업무 목록 다시 불러오기
          </Button>
        </>
      )}
      {(offset > 0 || (ready && result.nextOffset !== null)) && (
        <div className="calendar-task-pages">
          <Button
            {...busyProps(busy || !ready, offset === 0)}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            이전
          </Button>
          <span>{offset / 50 + 1}페이지</span>
          <Button
            {...busyProps(busy || !ready, !ready || result.nextOffset === null)}
            onClick={() => {
              if (ready && result.nextOffset !== null)
                setOffset(result.nextOffset);
            }}
          >
            다음
          </Button>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="calendar-actions">
        <Button
          {...busyProps(busy, !selected.length)}
          onClick={() => void add()}
        >
          {busy
            ? "추가 중…"
            : `선택한 업무 추가${selected.length ? ` (${selected.length})` : ""}`}
        </Button>
        <Button {...busyProps(busy)} onClick={onClose}>
          취소
        </Button>
      </div>
    </Modal>
  );
}
