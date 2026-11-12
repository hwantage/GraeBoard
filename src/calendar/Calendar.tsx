import useCalendarMutation from "./useCalendarMutation";
import useCalendarCreation from "./useCalendarCreation";
import useCalendarCommands from "./useCalendarCommands";
import useResourceSync from "../platform/useResourceSync";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  LockKeyhole,
  EyeOff,
  FileText,
  Search,
  Plus,
  SlidersHorizontal,
  Settings,
  Tags,
  Users,
  X,
} from "lucide-react";
import { api } from "../platform/api";
import { normalizeSearchQuery } from "../../shared/search.js";
import { busyProps } from "../ui/busyProps";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import LoadingState from "../ui/LoadingState";
import GridHeaderMenu from "../ui/GridHeaderMenu";

import { StandaloneRowPanel } from "../Panels";
import { UndoToast } from "../ui/Toast";
import CalendarEntryPanel from "./CalendarEntryPanel";
import SecretCalendarEntryPanel from "./SecretCalendarEntryPanel";
import useSecretCalendar from "./useSecretCalendar";
import {
  calendarDisplayLane,
  mergeSecretCalendarLayout,
  moveSecretEntries,
} from "./secret-calendar-layout";

import { isSecretEntry, setSecretCalendarVisible } from "./secret-calendar";
import CalendarEntries from "./CalendarEntries";
import CalendarTaskPicker from "./CalendarTaskPicker";
import CalendarTagManager, {
  CalendarTagPicker,
  calendarTagManagerLabel,
} from "./CalendarTags";

import { useCalendarDrag, type CalendarRange } from "./useCalendarDrag";
import { reorderItems, useListReorder } from "../ui/useListReorder";
import { useCalendarData } from "./useCalendarData";
import {
  CALENDAR_SCROLL_MONTHS,
  calendarMonthFirstDay,
  useCalendarMonthRange,
  useCalendarMonthScroll,
} from "./useCalendarMonthScroll";
import { placeCalendarEntry } from "../../shared/calendar/calendar-layout.js";
import { CalendarRuleSettings, CalendarWeekdays } from "./CalendarSettings";
import {
  addDays,
  calendarWeek,
  monthWeeks,
  weekLabel,
  CALENDAR_DAYS,
  DAY_LABELS,
} from "../../shared/calendar/calendar.js";
import {
  canContribute,
  canManageTeam,
  displayValueFor,
  todayKey,
} from "../../shared/domain.js";
import type { Task, Team, User } from "../types";
import type {
  CalendarContext,
  CalendarData,
  CalendarEntry,
  CalendarTag,
  WeeklyItem,
} from "./calendar-types";
import "./calendar.css";
import "./secret-calendar.css";

const EMPTY_MEMBERS: User[] = [];
const EMPTY_ENTRIES: CalendarEntry[] = [];
const EMPTY_TAGS: CalendarTag[] = [];

// A week's to-do items in their order. Dragging an item or Alt+Up/Down on it
// moves it; the item itself is the handle, as calendar cards are.
type ReorderHandle = ReturnType<
  ReturnType<typeof useListReorder>["handleProps"]
>;
function WeeklyTaskList({
  items,
  disabled,
  onMove,
  renderItem,
}: {
  items: WeeklyItem[];
  disabled: boolean;
  onMove: (taskIds: string[]) => void;
  renderItem: (item: WeeklyItem, handle: ReorderHandle) => ReactNode;
}) {
  const ids = items.map((item) => item.taskId);
  const reorder = useListReorder<HTMLUListElement>(
    ids,
    (id, targetId, placement) => {
      const next = reorderItems(
        ids.map((taskId) => ({ id: taskId })),
        id,
        targetId,
        placement,
      ).map((item) => item.id);
      if (next.join() !== ids.join()) onMove(next);
    },
    disabled,
  );
  return (
    <ul ref={reorder.root}>
      {items.map((item) => (
        <li
          key={item.taskId}
          className="calendar-week-task"
          {...reorder.itemProps(item.taskId)}
        >
          {renderItem(item, reorder.handleProps(item.taskId))}
        </li>
      ))}
    </ul>
  );
}

export default function Calendar({
  team,
  user,
  reloadKey = 0,
  onBusyChange,
  onNotify,
}: {
  team: Team;
  user: User;
  // Changes after a detail opened from a document link has saved.
  reloadKey?: number;
  onBusyChange: (busy: boolean) => void;
  onNotify: (message: string) => void;
}) {
  const today = todayKey();
  // The monthly views list months one after another from range.start;
  // `month` is the month in the period selects.
  const months = useCalendarMonthRange(today);
  const { month, range: monthRange, chunks: monthChunks } = months;
  const scroll = useRef<HTMLDivElement>(null);
  const createTitle = useRef<HTMLInputElement>(null);
  const composingTitle = useRef(false);
  const [memberWeeks, setMemberWeeks] = useState<Record<string, string>>({});
  const [view, setView] = useState<"shared" | "month" | "team">("month");
  const [memberId, setMemberId] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>(CALENDAR_DAYS);
  const [context, setContext] = useState<CalendarContext | null>(null);
  const [error, setError] = useState("");
  const secret = useSecretCalendar(user.id, team.id);

  const [rangeChange, setRangeChange] = useState<{
    entry: CalendarEntry;
    range: CalendarRange;
    lane?: number;
  } | null>(null);
  const [rangeConflict, setRangeConflict] = useState<
    (CalendarRange & { lane?: number }) | null
  >(null);
  const [reload, setReload] = useState(0);
  const [contextAttempt, setContextAttempt] = useState(0);
  const [showDays, setShowDays] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsMenu, setSettingsMenu] = useState<{
    x: number;
    y: number;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const composingSearch = useRef(false);
  const searchQuery = normalizeSearchQuery(search);
  function clearSearch() {
    setSearch("");
    searchInput.current?.focus();
  }
  const [showRule, setShowRule] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [addingWeek, setAddingWeek] = useState<{
    userId: string;
    weekStart: string;
  } | null>(null);
  const [entry, setEntry] = useState<CalendarEntry | null>(null);
  const [entryMenu, setEntryMenu] = useState<{
    entry: CalendarEntry;
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null>(null);
  const [tagEntry, setTagEntry] = useState<CalendarEntry | null>(null);

  // Only one undo is offered at a time, for a card or for a weekly item.

  const [task, setTask] = useState<Task | null>(null);

  const members = context?.members || EMPTY_MEMBERS;
  const tags = context?.tags || EMPTY_TAGS;
  const tagMap = useMemo(
    () => new Map(tags.map((tag) => [tag.id, tag])),
    [tags],
  );
  const tagCatalogs = useMemo(() => {
    const catalogs = new Map<string | null, CalendarTag[]>();
    for (const tag of tags) {
      if (!catalogs.has(tag.userId)) catalogs.set(tag.userId, []);
      catalogs.get(tag.userId)!.push(tag);
    }
    return catalogs;
  }, [tags]);
  const tagsFor = (ownerId: string | null) =>
    tagCatalogs.get(ownerId) || EMPTY_TAGS;
  const monthlyOwner = view === "shared" ? null : memberId;

  const queries = useMemo(() => {
    if (view !== "shared" && (!members.length || !memberId)) return [];
    // A month at a time, so a month added by scrolling reads only itself.
    if (view !== "team")
      return monthChunks.map(({ weeks }) => ({
        userId: view === "shared" ? null : memberId,
        from: weeks[0],
        to: addDays(weeks[weeks.length - 1], 6),
      }));
    return members.map((member) => {
      const from = memberWeeks[member.id] || calendarWeek(today);
      return { userId: member.id, from, to: addDays(from, 6) };
    });
  }, [members, memberId, view, monthChunks, memberWeeks, today]);
  const {
    data,
    schedules,
    ranges,
    updateData,
    beginMutation,
    endMutation,
    retry,
  } = useCalendarData(team.id, queries, reload);
  const loadError =
    view !== "team" ? schedules.get(monthlyOwner)?.error || "" : "";
  // Months show in order once loaded; the first month still loading or
  // failed shows its state below them.
  const missingMonth = ranges.findIndex((result) => !result?.data);
  const loadedMonths =
    view === "team" ? 0 : missingMonth === -1 ? ranges.length : missingMonth;
  const weeks = useMemo(
    () => monthChunks.slice(0, loadedMonths).flatMap(({ weeks }) => weeks),
    [monthChunks, loadedMonths],
  );
  const waitingMonth =
    view !== "team" && loadedMonths < ranges.length
      ? { ...monthChunks[loadedMonths], result: ranges[loadedMonths] }
      : null;
  const monthScroll = useCalendarMonthScroll(
    scroll,
    months,
    weeks,
    view !== "team",
  );
  // Adding months below keeps the scope: open menus, drags and saves go on.
  const scope =
    view === "team"
      ? `${team.id}:${view}:${JSON.stringify(queries)}`
      : `${team.id}:${view}:${monthlyOwner}:${monthRange.start}`;

  const mutation = useCalendarMutation(
    scope,
    beginMutation,
    endMutation,
    setError,
  );
  const { pending, busy, action, alive, localAction } = mutation;
  const manageable = canManageTeam(user, team.id);
  const writable = (ownerId: string | null) =>
    ownerId === null
      ? manageable || user.teamIds.includes(team.id)
      : manageable || (ownerId === user.id && canContribute(user, team.id));
  const dragging = useCalendarDrag(
    scroll,
    `${scope}:${weekdays.join(",")}`,
    pending || !!rangeChange,
    (item, range, lane) => void saveRange({ entry: item, range, lane }),
  );
  const locked = pending || !!rangeChange || !!dragging.drag;
  const {
    creating,
    setCreating,
    newEntry,
    changeCreating,
    saveCreating,
    closeCreating,
  } = useCalendarCreation({
    user,
    team,
    tagMap,
    schedules,
    mutation,
    writable,
    locked,
    composingTitle,
    upsert: (saved) => commands.upsert(saved),
    setError,
  });
  const tagOwner = tagEntry
    ? tagEntry.userId
    : entry
      ? entry.userId
      : creating
        ? creating.userId
        : view === "shared"
          ? null
          : view === "month"
            ? memberId
            : members.some((m) => m.id === user.id)
              ? user.id
              : memberId;
  const seenReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey === seenReloadKey.current) return;
    seenReloadKey.current = reloadKey;
    setReload((value) => value + 1);
  }, [reloadKey]);
  useResourceSync(`/teams/${team.id}`, async () => {
    if (locked || busy.current) return false;
    setReload((value) => value + 1);
    setContextAttempt((value) => value + 1);
    return true;
  });
  const undoBlocked =
    locked ||
    !!entry ||
    !!tagEntry ||
    !!entryMenu ||
    !!settingsMenu ||
    !!task ||
    !!creating ||
    showDays ||
    showHidden ||
    showRule ||
    showTags ||
    !!addingWeek;

  useEffect(() => {
    setEntryMenu(null);
    setTagEntry(null);
  }, [scope]);
  useEffect(() => {
    if (!rangeChange) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [rangeChange]);
  const commands = useCalendarCommands({
    scope,
    mutation,
    team,
    user,
    members,
    tagOwner,
    undoBlocked,
    locked,
    writable,
    schedules,
    updateData,
    setContext,
    setTagEntry,
    setCreating,
    setEntry,
    setTask,
    setRangeChange,
    setRangeConflict,
    setError,
    onNotify,
  });
  const {
    deleted,
    removedWeekly,
    importing,
    upsert,
    changeTags,
    entryDeleted,
    removeSecret,
    checkEntryTag,
    duplicateEntry,
    removeEntry,
    updateEntryTags,
    restoreEntry,
    updateWeekly,
    importWeek,
    removeWeekly,
    reorderWeekly,
    restoreWeekly,
    saveRange,
    openTask,
    checkTag,
  } = commands;
  useEffect(() => {
    onBusyChange(
      locked ||
        !!entry ||
        !!tagEntry ||
        !!entryMenu ||
        !!settingsMenu ||
        !!task ||
        !!creating ||
        showDays ||
        showHidden ||
        showRule ||
        showTags ||
        !!addingWeek,
    );
    return () => onBusyChange(false);
  }, [
    locked,
    entry,
    tagEntry,
    entryMenu,
    settingsMenu,
    task,
    creating,
    showDays,
    showHidden,
    showRule,
    showTags,
    addingWeek,
    onBusyChange,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void Promise.all([
      api<CalendarContext>(`/calendar/teams/${team.id}`, {
        signal: controller.signal,
      }),
      api<{ weekdays: number[] }>("/calendar/preferences", {
        signal: controller.signal,
      }),
    ])
      .then(([ctx, preferences]) => {
        if (controller.signal.aborted) return;
        setContext(ctx);
        setMemberId((previous) =>
          ctx.members.some((m) => m.id === previous)
            ? previous
            : ctx.members.find((m) => m.id === user.id)?.id ||
              ctx.members[0]?.id ||
              "",
        );
        setWeekdays(preferences.weekdays);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [team.id, user.id, contextAttempt]);
  useEffect(() => {
    setError("");
  }, [scope, reload]);
  const displayedCalendars = useMemo(
    () =>
      new Map(
        [...schedules].map(([ownerId, schedule]) => {
          const entries = schedule?.data?.entries || EMPTY_ENTRIES;
          const change =
            rangeChange?.entry.userId === ownerId ? rangeChange : null;
          const placed = change
            ? new Map(
                placeCalendarEntry(schedule!.data!.layout, {
                  ...change.entry,
                  ...change.range,
                  lane: change.lane ?? change.entry.lane,
                }).map((item) => [item.id, item]),
              )
            : null;
          const local =
            ownerId === user.id && secret.visible && schedule?.data
              ? secret.entries
              : [];
          const layout = placed
            ? [...placed.values()]
            : schedule?.data?.layout || [];
          const merged = new Map(
            mergeSecretCalendarLayout(layout, local).map((item) => [
              item.id,
              item.lane,
            ]),
          );
          const displayed = [
            ...entries.map((item) => {
              const position = placed?.get(item.id);
              return position ? { ...item, ...position } : item;
            }),
            ...local.filter(
              (item) =>
                item.date <= schedule!.query.to &&
                item.endDate >= schedule!.query.from,
            ),
          ]
            .map((item) => ({
              ...item,
              displayLane: merged.get(item.id) ?? item.lane,
            }))
            .sort(
              (a, b) =>
                calendarDisplayLane(a) - calendarDisplayLane(b) ||
                a.date.localeCompare(b.date),
            );
          return [ownerId, displayed] as const;
        }),
      ),
    [schedules, rangeChange, secret.entries, secret.visible, user.id],
  );
  const displayEntries = useMemo(
    () => [...displayedCalendars.values()].flat(),
    [displayedCalendars],
  );
  const dragPreview = useMemo(() => {
    const drag = dragging.drag;
    if (!drag?.valid) return null;
    const entry = displayEntries.find((item) => item.id === drag.id);
    if (!entry) return null;
    const layout = schedules.get(entry.userId)!.data!.layout;
    if (isSecretEntry(entry)) {
      const moved = moveSecretEntries(
        layout,
        secret.entries,
        entry.id,
        drag,
        drag.mode === "order" ? drag.lane : undefined,
      );
      const position = mergeSecretCalendarLayout(layout, moved).find(
        (item) => item.id === entry.id,
      )!;
      return { ...entry, ...position, displayLane: position.lane };
    }
    const positions = placeCalendarEntry(layout, {
      ...entry,
      date: drag.date,
      endDate: drag.endDate,
      lane: drag.lane,
    });
    const position = positions.find((item) => item.id === drag.id)!;
    const display = mergeSecretCalendarLayout(
      positions,
      entry.userId === user.id && secret.visible ? secret.entries : [],
    ).find((item) => item.id === drag.id)!;
    return { ...entry, ...position, displayLane: display.lane };
  }, [
    dragging.drag,
    displayEntries,
    schedules,
    secret.entries,
    secret.visible,
    user.id,
  ]);

  const weeklyMap = useMemo(() => {
    const map = new Map<string, CalendarData["weekly"]>();
    for (const item of data?.weekly || []) {
      const key = `${item.userId}:${item.weekStart}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [data]);

  // Removing a weekly item only unlinks the task from that week. Undo links
  // the same task again at its previous position, like a card's undo.

  // Moving a weekly item saves the week's new order. The list shows it at
  // once and returns to the saved order when saving fails.

  // In the monthly views only days before the first listed month are outside.
  // A line steps along each month boundary, and the month's first shown day
  // names the month (with the year in January).
  const dayCell = (
    date: string,
    ownerId: string | null,
    column: number,
    dates: string[],
    firstRow: boolean,
  ) => {
    const monthly = view !== "team";
    const outside = monthly && date < `${monthRange.start}-01`;
    const monthStart =
      monthly &&
      !outside &&
      date === calendarMonthFirstDay(date.slice(0, 7), weekdays);
    const boundary = monthly
      ? `${!firstRow && Number(date.slice(8)) <= 7 ? " is-month-top" : ""}${column > 0 && dates[column - 1].slice(0, 7) !== date.slice(0, 7) ? " is-month-left" : ""}`
      : "";
    return (
      <div
        key={date}
        className={`calendar-day${date === today ? " is-today" : ""}${outside ? " is-outside" : ""}${boundary}`}
        data-date={date}
        data-weekday={weekdays[column]}
        data-owner-id={ownerId ?? "team"}
        style={
          { "--calendar-day-column": column + 1, gridRow: 1 } as CSSProperties
        }
      >
        <div className="calendar-date">
          <time
            dateTime={date}
            aria-label={date}
            aria-current={date === today ? "date" : undefined}
          >
            {monthStart && (
              <strong className="calendar-month-label">
                {date.slice(5, 7) === "01" && (
                  <span>{date.slice(0, 4)}년 </span>
                )}
                {Number(date.slice(5, 7))}월
              </strong>
            )}
            {outside
              ? date.slice(5).replace("-", "/")
              : date.slice(8).replace(/^0/, "")}
            {date === today && <span>오늘</span>}
          </time>
          {(writable(ownerId) || ownerId === user.id) && (
            <Button
              title={`${date} ${ownerId === null ? "팀 공용" : members.find((m) => m.id === ownerId)?.name} 일정 추가`}
              {...busyProps(locked)}
              onClick={() => newEntry(date, ownerId)}
            >
              <Plus size={15} />
            </Button>
          )}
        </div>
      </div>
    );
  };
  const weeklyCell = (start: string, ownerId: string) => {
    const items = weeklyMap.get(`${ownerId}:${start}`) || [];
    const editable = writable(ownerId);
    const currentWeek = start === calendarWeek(today);
    const loading =
      importing?.userId === ownerId && importing.weekStart === start;
    return (
      <aside
        className="calendar-week-tasks"
        aria-label={`${members.find((m) => m.id === ownerId)?.name} ${weekLabel(start)} 주간 할 일`}
        aria-busy={loading || undefined}
      >
        <div className="calendar-week-header">
          {view === "month" && (
            <div className="calendar-week-period">
              {start.slice(5).replace("-", "/")} ~{" "}
              {addDays(start, 6).slice(5).replace("-", "/")}
            </div>
          )}
          {!!items.length && <small>{items.length}개 업무</small>}
          {editable && (
            <Button
              className="calendar-member-import"
              title="업무 추가"
              {...busyProps(locked)}
              onClick={() =>
                setAddingWeek({ userId: ownerId, weekStart: start })
              }
            >
              <Plus size={12} />
            </Button>
          )}
        </div>
        {loading ? (
          <LoadingState
            className="compact calendar-week-loading"
            label="업무를 불러오는 중"
          />
        ) : items.length ? (
          <WeeklyTaskList
            items={items}
            disabled={!editable || locked}
            onMove={(taskIds) =>
              void reorderWeekly(ownerId, start, items, taskIds)
            }
            renderItem={(item, handle) => (
              <>
                <button
                  className={`calendar-week-task-open${item.unavailable ? " is-unavailable" : ""}`}
                  aria-keyshortcuts={
                    editable ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                  }
                  onPointerDown={(event) => {
                    if (event.pointerType !== "touch")
                      handle.onPointerDown(event);
                  }}
                  onKeyDown={handle.onKeyDown}
                  onClickCapture={handle.onClickCapture}
                  aria-description={
                    item.hasDocument
                      ? item.documentCount > 1
                        ? `문서 ${item.documentCount}개`
                        : "문서 있음"
                      : undefined
                  }
                  {...busyProps(locked)}
                  onClick={() => void openTask(item.taskId)}
                >
                  <span>
                    {item.title || "제목 없는 업무"}
                    {item.unavailable && <span> · 조회할 수 없는 업무</span>}
                  </span>
                  {/* Like the annual board, a single document shows the
                      icon only and several show their count. */}
                  {item.hasDocument && (
                    <span className="calendar-week-document" aria-hidden="true">
                      {item.documentCount > 1 && (
                        <span className="task-document-count">
                          {item.documentCount}
                        </span>
                      )}
                      <FileText size={11} />
                    </span>
                  )}
                </button>
                {editable && (
                  <button
                    type="button"
                    className="calendar-week-task-remove"
                    title="주간 업무에서 삭제"
                    aria-label={`${item.title || "제목 없는 업무"} 주간 업무에서 삭제`}
                    {...busyProps(locked)}
                    onClick={() => void removeWeekly(item)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          />
        ) : (
          <p className="calendar-week-empty">등록된 업무가 없습니다.</p>
        )}
        {currentWeek && (
          <div className="calendar-week-actions">
            <Button
              className="calendar-member-import"
              title={context?.ruleProblem || undefined}
              {...busyProps(locked, !editable || !!context?.ruleProblem)}
              onClick={() => void importWeek(ownerId, start)}
            >
              이번주 할일 확인
            </Button>
          </div>
        )}
      </aside>
    );
  };
  const hiddenEntries = useMemo(
    () =>
      displayEntries.filter((item) => {
        if (!normalizeSearchQuery(item.title).includes(searchQuery))
          return false;
        const starts =
          view !== "team"
            ? weeks
            : [memberWeeks[item.userId!] || calendarWeek(today)];
        // Entries of months still loading are not counted as hidden.
        if (
          view !== "team" &&
          (!weeks.length ||
            item.date > addDays(weeks[weeks.length - 1], 6) ||
            item.endDate < weeks[0])
        )
          return false;
        return !starts.some((start) =>
          weekdays.some((day) => {
            const date = addDays(start, day);
            return date >= item.date && date <= item.endDate;
          }),
        );
      }),
    [displayEntries, view, weeks, memberWeeks, weekdays, today, searchQuery],
  );
  const weekRow = (start: string, ownerId: string | null, firstRow = true) => {
    const dates = weekdays.map((day) => addDays(start, day));
    return (
      <div
        key={`${start}:${ownerId}`}
        className="calendar-week-row"
        data-week={start}
        data-owner-id={ownerId ?? "team"}
      >
        {ownerId !== null && weeklyCell(start, ownerId)}
        {dates.map((date, index) =>
          dayCell(date, ownerId, index, dates, firstRow),
        )}
        <CalendarEntries
          entries={displayedCalendars.get(ownerId) || EMPTY_ENTRIES}
          tags={tagMap}
          start={start}
          weekdays={weekdays}
          preview={dragPreview?.userId === ownerId ? dragPreview : null}
          drag={dragging.drag}
          disabled={locked}
          readOnly={!writable(ownerId)}
          changingId={rangeChange?.entry.id || dragging.drag?.id}
          savingId={pending ? rangeChange?.entry.id : undefined}
          searchQuery={searchQuery}
          onOpen={setEntry}
          onContextMenu={(event, item) => {
            setEntryMenu({
              entry: item,
              x: event.clientX,
              y: event.clientY,
              anchor: event.currentTarget,
            });
          }}
          onDragStart={dragging.start}
          canClick={dragging.canClick}
          onRangeChange={(item, range) =>
            void saveRange({ entry: item, range })
          }
          onOrderChange={(item, lane) =>
            void saveRange({ entry: item, range: item, lane })
          }
          onCheckTag={(item, tagId, checked) =>
            void checkTag(item, tagId, checked)
          }
        />
      </div>
    );
  };
  const ruleProperty = context?.settings.properties?.find(
    (p) => p.id === context.rule.propertyId,
  );
  const ruleDescription =
    context?.ruleProblem ||
    (ruleProperty && context
      ? `${ruleProperty.name}: ${
          context.rule.values.length
            ? context.rule.values
                .map((v) =>
                  v === ""
                    ? "미지정"
                    : displayValueFor(ruleProperty, v, members),
                )
                .join(", ") +
              (context.rule.mode === "exclude" ? " 제외" : " 일치")
            : "전체 표시"
        }`
      : "기준을 불러오는 중…");
  function changeMemberWeek(ownerId: string, start: string) {
    setMemberWeeks((previous) => ({ ...previous, [ownerId]: start }));
    setMemberId(ownerId);
  }
  function openRule() {
    void action(async () => {
      const latest = await api<CalendarContext>(`/calendar/teams/${team.id}`);
      if (alive.current) {
        setContext(latest);
        setShowRule(true);
      }
    });
  }
  // Secret entries show only on the user's own calendar, so the toggle sits
  // there: in the toolbar of the user's own personal month, and left of the
  // user's own week dates in the team week.
  const secretToggle = () => (
    <Button
      className="calendar-secret-toggle"
      tooltip={secret.visible ? "시크릿 일정 숨기기" : "시크릿 일정 보이기"}
      aria-pressed={secret.visible}
      active={secret.visible}
      {...busyProps(locked)}
      onClick={() =>
        localAction(() => setSecretCalendarVisible(user.id, !secret.visible))
      }
    >
      {secret.visible ? (
        <LockKeyhole size={16} aria-hidden="true" />
      ) : (
        <EyeOff size={16} aria-hidden="true" />
      )}
    </Button>
  );
  const gridHeader = () => (
    <div className="calendar-grid-header">
      {view !== "shared" && (
        <div className="calendar-week-heading">주간 할 일</div>
      )}
      {weekdays.map((day) => (
        <div key={day} className={`weekday-${day}`}>
          {DAY_LABELS[day]}
        </div>
      ))}
    </div>
  );
  return (
    <section
      className="calendar-workspace"
      aria-label="캘린더"
      data-calendar-view={view}
    >
      <div className="page-heading calendar-heading">
        <div className="heading-line">
          <h1>캘린더</h1>
          <span className="year-badge">{month.slice(0, 4)}</span>
        </div>
        <div className="heading-actions calendar-view-switch">
          <Button
            active={view === "shared"}
            aria-pressed={view === "shared"}
            {...busyProps(locked)}
            onClick={() => {
              if (view === "shared") return;
              months.open();
              setView("shared");
            }}
          >
            <CalendarDays size={13} />팀 월간 보기
          </Button>
          <Button
            active={view === "team"}
            aria-pressed={view === "team"}
            {...busyProps(locked)}
            onClick={() => {
              // Members without a week of their own start from the month in
              // the period selects: this week in the current month.
              const monthWeek =
                month === today.slice(0, 7)
                  ? calendarWeek(today)
                  : monthWeeks(month)[0];
              setMemberWeeks((previous) =>
                Object.fromEntries(
                  members.map((m) => [
                    m.id,
                    previous[m.id] ||
                      (view === "team"
                        ? memberWeeks[memberId] || calendarWeek(today)
                        : monthWeek),
                  ]),
                ),
              );
              setView("team");
            }}
          >
            <Users size={13} />팀 주간 일정 보기
          </Button>
          <Button
            active={view === "month"}
            aria-pressed={view === "month"}
            {...busyProps(locked)}
            onClick={() => {
              if (view === "month") return;
              months.open();
              setView("month");
            }}
          >
            <CalendarDays size={13} />
            개인 월간 보기
          </Button>
        </div>
        <Button
          ref={settingsButton}
          className="calendar-settings-toggle"
          tooltip="캘린더 설정"
          aria-haspopup="menu"
          aria-expanded={!!settingsMenu}
          {...busyProps(locked, !context)}
          onClick={() => {
            const anchor = settingsButton.current!;
            const box = anchor.getBoundingClientRect();
            setSettingsMenu(
              settingsMenu ? null : { x: box.left, y: box.bottom, anchor },
            );
          }}
        >
          <Settings size={16} aria-hidden="true" />
        </Button>
        <div className="heading-actions calendar-view-options">
          {manageable && view !== "shared" && (
            <Button {...busyProps(locked, !context)} onClick={openRule}>
              <ListFilter size={13} />
              주간 할 일 기준
            </Button>
          )}
          <Button
            {...busyProps(locked, !context || tagOwner === "")}
            onClick={() => setShowTags(true)}
          >
            <Tags size={13} />
            {calendarTagManagerLabel(tagOwner)}
          </Button>
          <Button
            title="내 표시 요일 설정"
            {...busyProps(locked, !context)}
            onClick={() => setShowDays(true)}
          >
            <SlidersHorizontal size={13} />
            표시 요일
          </Button>
        </div>
      </div>
      <div className="board calendar-board">
        <div
          className="view-controls calendar-toolbar"
          aria-label="캘린더 기간 및 보기 설정"
        >
          {view !== "team" ? (
            <>
              <div className="calendar-period">
                <div
                  className="year-control calendar-period-control"
                  role="group"
                  aria-label="캘린더 표시 기간"
                >
                  <Button
                    title="이전 달"
                    {...busyProps(locked, month === "2000-01")}
                    onClick={months.previous}
                  >
                    <ChevronLeft size={15} />
                  </Button>
                  <div className="calendar-month-picker">
                    <select
                      aria-label="캘린더 연도"
                      {...busyProps(locked)}
                      value={month.slice(0, 4)}
                      onChange={(e) =>
                        months.select(`${e.target.value}-${month.slice(5)}`)
                      }
                    >
                      {Array.from({ length: 101 }, (_, i) => 2000 + i).map(
                        (year) => (
                          <option key={year} value={year}>
                            {year}년
                          </option>
                        ),
                      )}
                    </select>
                    <select
                      aria-label="표시 월"
                      {...busyProps(locked)}
                      value={Number(month.slice(5))}
                      onChange={(e) =>
                        months.select(
                          `${month.slice(0, 4)}-${e.target.value.padStart(2, "0")}`,
                        )
                      }
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(
                        (month) => (
                          <option key={month} value={month}>
                            {month}월
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <Button
                    title="다음 달"
                    {...busyProps(locked, month === "2100-12")}
                    onClick={months.next}
                  >
                    <ChevronRight size={15} />
                  </Button>
                </div>
                {view === "month" && (
                  <div
                    className="calendar-owner-list"
                    role="group"
                    aria-label="캘린더 팀원"
                  >
                    {members.map((member) => (
                      <Button
                        key={member.id}
                        className="calendar-owner-button"
                        data-member-id={member.id}
                        tooltip={member.name}
                        aria-label={member.name}
                        data-tooltip-tone="black"
                        active={memberId === member.id}
                        aria-pressed={memberId === member.id}
                        {...busyProps(locked, !context)}
                        onClick={() => {
                          if (memberId === member.id) return;
                          months.restart();
                          setMemberId(member.id);
                        }}
                      >
                        <Avatar user={member} small />
                        <span>{member.name}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="calendar-team-overview">
              <span>팀원 {members.length}명</span>
              <span>{ruleDescription}</span>
            </div>
          )}
          <div className="view-bar calendar-toolbar-actions">
            {hiddenEntries.length > 0 && (
              <Button
                {...busyProps(locked)}
                onClick={() => setShowHidden(true)}
              >
                숨긴 요일에 일정 {hiddenEntries.length}개
              </Button>
            )}
            {view === "month" && memberId === user.id && secretToggle()}
            <div
              className="search-box calendar-search"
              role="search"
              aria-label="일정 찾기"
            >
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchInput}
                type="search"
                aria-label="일정 제목 검색"
                placeholder="일정 제목 검색"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onCompositionStart={() => {
                  composingSearch.current = true;
                }}
                onCompositionEnd={() => {
                  composingSearch.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    composingSearch.current ||
                    event.keyCode === 229
                  )
                    return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    clearSearch();
                  }
                }}
              />
              <button
                type="button"
                aria-label="검색 지우기"
                title="검색 지우기 (Esc)"
                disabled={!search}
                onClick={clearSearch}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
            {view !== "team" && (
              <Button
                className="calendar-today-control"
                title="오늘"
                {...busyProps(locked)}
                onClick={months.today}
              >
                오늘
              </Button>
            )}
          </div>
        </div>
        <ErrorNote error={error || loadError || secret.error} />
        {rangeChange && !pending && (
          <div className="calendar-range-pending" role="status">
            <span>
              {rangeChange.entry.title} ·{" "}
              {rangeChange.lane === undefined
                ? `${rangeChange.range.date} ~ ${rangeChange.range.endDate}`
                : `${rangeChange.lane + 1}번째 행`}
              {" · 아직 저장되지 않았습니다."}
            </span>
            {rangeConflict && (
              <span>
                {rangeChange.lane === undefined
                  ? `최신 서버 기간: ${rangeConflict.date} ~ ${rangeConflict.endDate}`
                  : `최신 서버 위치: ${(rangeConflict.lane ?? rangeChange.entry.lane) + 1}번째 행`}
              </span>
            )}
            <Button
              onClick={() =>
                void saveRange(rangeChange, rangeConflict || undefined)
              }
            >
              {rangeChange.lane !== undefined
                ? rangeConflict
                  ? "내 순서로 최신 순서 교체"
                  : "순서 변경 다시 시도"
                : rangeConflict
                  ? "내 기간으로 최신 기간 교체"
                  : "기간 변경 다시 시도"}
            </Button>
            <Button
              onClick={() => {
                setRangeChange(null);
                setRangeConflict(null);
                setError("");
                setReload((n) => n + 1);
              }}
            >
              {rangeChange.lane === undefined
                ? "기간 변경 취소"
                : "순서 변경 취소"}
            </Button>
          </div>
        )}
        {dragging.drag && (
          <p className="visually-hidden" role="status">
            {dragging.drag.valid
              ? dragging.drag.mode === "order"
                ? `${dragging.drag.lane + 1}번째 행 · 놓아서 순서 저장`
                : `${dragging.drag.date} ~ ${dragging.drag.endDate} · 놓아서 기간 저장`
              : "같은 팀원의 날짜 칸에 놓아 주세요."}{" "}
            · Esc 취소
          </p>
        )}
        <span id="calendar-drag-help" className="visually-hidden">
          같은 날짜에서 카드를 위아래로 드래그하거나 Alt+Shift와 위아래 방향키로
          순서를 변경합니다. 다른 날짜로 드래그하거나 Alt와 방향키로 이동합니다.
          시크릿 일정은 Alt와 위아래 방향키로도 순서를 변경합니다. 양 끝을
          드래그하거나 끝부분에서 방향키로 기간을 조정합니다. Enter로 상세
          기간을 편집하고 Escape로 드래그를 취소합니다.
        </span>
        {(error || loadError) && !rangeChange && (
          <div>
            <Button
              {...busyProps(locked)}
              onClick={() => {
                setContextAttempt((n) => n + 1);
                setReload((n) => n + 1);
              }}
            >
              캘린더 다시 불러오기
            </Button>
          </div>
        )}
        {!context ||
        (view !== "team" && !data && (view === "shared" || memberId)) ? (
          !error &&
          !loadError && (
            <LoadingState
              className="calendar-loading"
              label="일정을 불러오는 중"
            />
          )
        ) : view !== "shared" && !members.length ? (
          <p className="calendar-loading">이 팀에 활성 구성원이 없습니다.</p>
        ) : (
          <div
            ref={scroll}
            className="calendar-scroll"
            data-dragging={
              dragging.drag
                ? dragging.drag.valid
                  ? "valid"
                  : "invalid"
                : undefined
            }
            tabIndex={0}
            aria-label="달력 가로·세로 스크롤"
            style={{ "--calendar-days": weekdays.length } as CSSProperties}
            {...monthScroll}
          >
            {view !== "team" ? (
              <>
                <div className="calendar-grid">
                  {gridHeader()}
                  {weeks.map((start, index) =>
                    weekRow(start, monthlyOwner, index === 0),
                  )}
                </div>
                {waitingMonth ? (
                  <div className="calendar-member-loading calendar-month-loading">
                    {waitingMonth.result?.error ? (
                      <>
                        <ErrorNote error={waitingMonth.result.error} />
                        <Button {...busyProps(locked)} onClick={retry}>
                          {Number(waitingMonth.month.slice(5))}월 일정 다시
                          불러오기
                        </Button>
                      </>
                    ) : (
                      <LoadingState
                        className="compact"
                        label={`${waitingMonth.month.slice(0, 4)}년 ${Number(waitingMonth.month.slice(5))}월 일정을 불러오는 중`}
                      />
                    )}
                  </div>
                ) : (
                  monthRange.end < "2100-12" &&
                  monthChunks.length >= CALENDAR_SCROLL_MONTHS && (
                    <p className="calendar-month-limit">
                      한 번에 {CALENDAR_SCROLL_MONTHS}개월까지 이어서
                      표시합니다. 다음 달 버튼으로 계속 볼 수 있습니다.
                    </p>
                  )
                )}
              </>
            ) : (
              members.map((m) => {
                const start = memberWeeks[m.id] || calendarWeek(today);
                const schedule = schedules.get(m.id);
                return (
                  <section
                    key={m.id}
                    className="calendar-team-section"
                    aria-label={`${m.name} 주간 일정`}
                    aria-busy={!schedule?.data && !schedule?.error}
                    data-member-id={m.id}
                  >
                    <header className="calendar-team-heading">
                      <div className="calendar-member">
                        <span aria-hidden="true">
                          <Avatar user={m} />
                        </span>
                        <h2>{m.name}</h2>
                        {m.id === user.id && (
                          <span className="calendar-member-label">나</span>
                        )}
                        {m.teamRoles[team.id] === "viewer" && (
                          <span className="calendar-member-label">열람자</span>
                        )}
                      </div>
                      <div
                        className="calendar-member-navigation"
                        role="group"
                        aria-label={`${m.name} 주간 탐색`}
                      >
                        {m.id === user.id && secretToggle()}
                        <div className="year-control calendar-period-control">
                          <Button
                            title={`${m.name} 이전 주`}
                            {...busyProps(locked)}
                            onClick={() =>
                              changeMemberWeek(m.id, addDays(start, -7))
                            }
                          >
                            <ChevronLeft size={15} />
                          </Button>
                          <strong className="calendar-member-period">
                            <time dateTime={start}>
                              <span className="calendar-member-year">
                                {start.slice(0, 4)}.
                              </span>
                              {start.slice(5).replace("-", ".")}
                            </time>
                            <span>~</span>
                            <time dateTime={addDays(start, 6)}>
                              <span className="calendar-member-year">
                                {addDays(start, 6).slice(0, 4)}.
                              </span>
                              {addDays(start, 6).slice(5).replace("-", ".")}
                            </time>
                          </strong>
                          <Button
                            title={`${m.name} 다음 주`}
                            {...busyProps(locked)}
                            onClick={() =>
                              changeMemberWeek(m.id, addDays(start, 7))
                            }
                          >
                            <ChevronRight size={15} />
                          </Button>
                        </div>
                        <Button
                          title={`${m.name} 이번 주`}
                          {...busyProps(locked)}
                          onClick={() =>
                            changeMemberWeek(m.id, calendarWeek(today))
                          }
                        >
                          이번 주
                        </Button>
                      </div>
                    </header>
                    <div className="calendar-grid">
                      {gridHeader()}
                      {schedule?.data ? (
                        weekRow(start, m.id)
                      ) : (
                        <div className="calendar-member-loading">
                          {schedule?.error ? (
                            <>
                              <ErrorNote error={schedule.error} />
                              <Button {...busyProps(locked)} onClick={retry}>
                                {m.name} 일정 다시 불러오기
                              </Button>
                            </>
                          ) : (
                            <LoadingState
                              className="compact"
                              label={`${m.name}의 일정을 불러오는 중`}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>
      {settingsMenu && (
        <GridHeaderMenu
          x={settingsMenu.x}
          y={settingsMenu.y}
          anchor={settingsMenu.anchor}
          title="캘린더 설정"
          onClose={(restore) => {
            setSettingsMenu(null);
            if (restore) settingsMenu.anchor.focus({ preventScroll: true });
          }}
          actions={[
            ...(manageable && view !== "shared"
              ? [
                  {
                    label: "주간 할 일 기준",
                    icon: <ListFilter size={15} />,
                    run: openRule,
                  },
                ]
              : []),
            {
              label: calendarTagManagerLabel(tagOwner),
              icon: <Tags size={15} />,
              disabled: tagOwner === "",
              run: () => setShowTags(true),
            },
            {
              label: "표시 요일",
              icon: <SlidersHorizontal size={15} />,
              run: () => setShowDays(true),
            },
          ]}
        />
      )}
      {showHidden && (
        <Modal title="숨긴 요일의 일정" onClose={() => setShowHidden(false)}>
          <ul className="calendar-hidden-entries">
            {hiddenEntries.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setShowHidden(false);
                    setEntry(item);
                  }}
                >
                  <strong>
                    {isSecretEntry(item) && (
                      <LockKeyhole size={12} aria-label="시크릿 일정" />
                    )}
                    {item.title}
                    {(item.hasDocument ?? !!item.preview) && (
                      <FileText size={12} aria-label="문서 있음" />
                    )}
                  </strong>
                  <span>
                    {item.date}
                    {item.endDate !== item.date && ` ~ ${item.endDate}`} ·{" "}
                    {item.userId === null
                      ? "팀 공용"
                      : members.find((member) => member.id === item.userId)
                          ?.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {showDays && (
        <CalendarWeekdays
          weekdays={weekdays}
          onSaved={setWeekdays}
          onClose={() => setShowDays(false)}
        />
      )}
      {showRule && context && (
        <CalendarRuleSettings
          teamId={team.id}
          context={context}
          onSaved={(rule) => setContext({ ...context, rule, ruleProblem: "" })}
          onClose={() => setShowRule(false)}
        />
      )}
      {entryMenu && (
        <GridHeaderMenu
          x={entryMenu.x}
          y={entryMenu.y}
          title={entryMenu.entry.title}
          anchor={entryMenu.anchor}
          scrollContainer={scroll.current}
          onClose={(restore) => {
            if (restore)
              entryMenu.anchor
                .querySelector<HTMLButtonElement>(".calendar-entry-card")
                ?.focus({ preventScroll: true });
            setEntryMenu(null);
          }}
          actions={[
            {
              label: "일정 복제",
              disabled: locked,
              run: () => void duplicateEntry(entryMenu.entry),
            },
            {
              label: "태그 설정",
              disabled: locked,
              run: () => {
                setError("");
                setTagEntry(entryMenu.entry);
              },
            },
            {
              label: "일정 삭제",
              danger: true,
              disabled: locked,
              run: () => void removeEntry(entryMenu.entry),
            },
          ]}
        />
      )}
      {tagEntry && (
        <Modal
          title="일정 태그"
          onClose={() => {
            if (!pending) setTagEntry(null);
          }}
        >
          <strong>{tagEntry.title}</strong>
          <CalendarTagPicker
            userId={tagEntry.userId}
            tags={tagsFor(tagEntry.userId)}
            value={tagEntry.tagIds}
            checkedIds={tagEntry.checkedTagIds}
            disabled={locked}
            onChange={(ids) => void updateEntryTags(tagEntry, ids)}
            onCheckChange={(tagId, checked) =>
              checkEntryTag(tagEntry, tagId, checked)
            }
            onManage={() => setShowTags(true)}
          />
          <ErrorNote error={error} />
        </Modal>
      )}
      {creating && (
        <Modal
          title="일정 추가"
          initialFocus={createTitle}
          onOutsideClick={() => {
            if (locked || composingTitle.current) return;
            if (creating.title.trim()) saveCreating();
            else if (creating.tagIds.length) createTitle.current?.focus();
            else setCreating(null);
          }}
          onClose={closeCreating}
        >
          <form
            className="calendar-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveCreating();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (composingTitle.current ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  event.repeat)
              )
                event.preventDefault();
            }}
          >
            <p>
              {creating.date} ·{" "}
              {creating.userId === null
                ? "팀 공용 일정"
                : members.find((m) => m.id === creating.userId)?.name}
            </p>
            <label className="calendar-field">
              일정 제목
              <input
                ref={createTitle}
                onFocus={() => {
                  composingTitle.current = false;
                }}
                onCompositionStart={() => {
                  composingTitle.current = true;
                }}
                onCompositionEnd={() => {
                  composingTitle.current = false;
                }}
                aria-label="새 일정 제목"
                {...busyProps(locked)}
                maxLength={120}
                value={creating.title}
                onChange={(e) => {
                  changeCreating({ ...creating, title: e.target.value });
                }}
              />
            </label>
            {creating.userId === user.id && (
              <label className="switch-field">
                <span>시크릿 일정</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="시크릿 일정"
                  checked={creating.secret}
                  disabled={locked || !writable(creating.userId)}
                  onChange={(event) =>
                    changeCreating({
                      ...creating,
                      secret: event.target.checked,
                    })
                  }
                />
                <span className="switch-track" aria-hidden="true" />
              </label>
            )}
            {creating.secret && (
              <p className="calendar-hint">
                이 브라우저에만 저장되며 다른 사람·관리자에게 보이지 않습니다.
              </p>
            )}
            <CalendarTagPicker
              userId={creating.userId}
              tags={tagsFor(creating.userId)}
              value={creating.tagIds}
              checkedIds={creating.checkedTagIds}
              disabled={locked}
              onChange={(tagIds) =>
                changeCreating({
                  ...creating,
                  tagIds,
                  checkedTagIds: creating.checkedTagIds.filter((id) =>
                    tagIds.includes(id),
                  ),
                })
              }
              onCheckChange={(id, checked) =>
                changeCreating({
                  ...creating,
                  checkedTagIds: checked
                    ? [...creating.checkedTagIds, id]
                    : creating.checkedTagIds.filter((value) => value !== id),
                })
              }
              onManage={() => setShowTags(true)}
            />
            <ErrorNote error={error} />
            <p className="calendar-hint">
              제목을 입력한 뒤 바깥을 클릭하면 일정이 저장됩니다. 닫기 버튼과
              Esc는 입력을 이 브라우저 탭에 보관합니다.
            </p>
            <Button disabled={locked || !creating.title.trim()} type="submit">
              일정 만들기
            </Button>
          </form>
        </Modal>
      )}
      {entry && isSecretEntry(entry) && (
        <SecretCalendarEntryPanel
          key={entry.id}
          entry={entry}
          tags={tagsFor(entry.userId)}
          onManageTags={() => setShowTags(true)}
          onClose={() => setEntry(null)}
          onDeleted={removeSecret}
        />
      )}
      {entry && !isSecretEntry(entry) && (
        <CalendarEntryPanel
          key={entry.id}
          entry={entry}
          tags={tagsFor(entry.userId)}
          onManageTags={() => setShowTags(true)}
          userId={user.id}
          readOnly={!writable(entry.userId)}
          onSaved={upsert}
          onClose={() => setEntry(null)}
          onDeleted={entryDeleted}
        />
      )}
      {deleted && (
        <UndoToast
          message={`‘${deleted.entry.title}’ 일정을 삭제했습니다.`}
          disabled={undoBlocked}
          onUndo={() => void restoreEntry()}
        />
      )}
      {removedWeekly && (
        <UndoToast
          message={`‘${removedWeekly.item.title || "제목 없는 업무"}’ 업무를 주간 할 일에서 삭제했습니다.`}
          disabled={undoBlocked}
          onUndo={() => void restoreWeekly()}
        />
      )}
      {addingWeek && context && (
        <CalendarTaskPicker
          teamId={team.id}
          settings={context.settings}
          members={members}
          userId={addingWeek.userId}
          ownerName={
            members.find((m) => m.id === addingWeek.userId)?.name || "구성원"
          }
          weekStart={addingWeek.weekStart}
          onAdded={(weekly) => {
            updateWeekly(addingWeek.userId, addingWeek.weekStart, weekly);
          }}
          onClose={() => setAddingWeek(null)}
        />
      )}
      {showTags && (
        <CalendarTagManager
          teamId={team.id}
          userId={tagOwner}
          ownerName={members.find((m) => m.id === tagOwner)?.name || "개인"}
          tags={tagsFor(tagOwner)}
          readOnly={tagOwner !== null && !writable(tagOwner)}
          onChanged={changeTags}
          onClose={() => setShowTags(false)}
        />
      )}
      {task && context && (
        <StandaloneRowPanel
          key={task.id}
          task={task}
          settings={context.settings}
          user={user}
          users={members}
          onClose={() => {
            setTask(null);
          }}
          onDocumentSaved={(result) => {
            // Weekly items of the task show the same document count.
            const id = task.id;
            updateData((previous) =>
              previous.weekly.some((item) => item.taskId === id)
                ? {
                    ...previous,
                    weekly: previous.weekly.map((item) =>
                      item.taskId === id && !item.unavailable
                        ? {
                            ...item,
                            hasDocument: result.hasDocument,
                            documentCount: result.documentCount,
                          }
                        : item,
                    ),
                  }
                : previous,
            );
          }}
          onCellsSaved={(result) => {
            const titles = new Map(
              result.cells
                .filter((cell) => cell.key === "title")
                .map((cell) => [cell.taskId, String(cell.value)]),
            );
            if (titles.size)
              updateData((previous) => ({
                ...previous,
                weekly: previous.weekly.map((item) =>
                  titles.has(item.taskId)
                    ? { ...item, title: titles.get(item.taskId)! }
                    : item,
                ),
              }));
          }}
        />
      )}
    </section>
  );
}
