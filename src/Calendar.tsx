import useResourceSync from "./useResourceSync";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Plus,
  SlidersHorizontal,
  Tags,
  Users,
} from "lucide-react";
import { api, ApiError, send } from "./api";
import { busyProps } from "./busyProps";
import { Avatar, Button, ErrorNote, Modal } from "./components";
import GridHeaderMenu from "./GridHeaderMenu";
import {
  deleteCalendarEntry,
  saveCalendarEntryTags,
} from "./calendar-entry-actions";
import { RowPanel } from "./Panels";
import { UndoToast } from "./Toast";
import CalendarEntryPanel from "./CalendarEntryPanel";
import CalendarEntries from "./CalendarEntries";
import CalendarTaskPicker from "./CalendarTaskPicker";
import CalendarTagManager, {
  CalendarTagPicker,
  calendarTagManagerLabel,
} from "./CalendarTags";
import {
  applyCalendarTagCheck,
  saveCalendarTagCheck,
} from "./calendar-tag-checks";
import { useCalendarDrag, type CalendarRange } from "./useCalendarDrag";
import { useCalendarData } from "./useCalendarData";
import {
  mergeCalendarLayout,
  placeCalendarEntry,
} from "../shared/calendar-layout.js";
import { CalendarRuleSettings, CalendarWeekdays } from "./CalendarSettings";
import {
  addDays,
  calendarWeek,
  monthWeeks,
  moveMonth,
  weekLabel,
  CALENDAR_DAYS,
  DAY_LABELS,
} from "../shared/calendar.js";
import {
  canContribute,
  canManageTeam,
  displayValueFor,
  todayKey,
} from "../shared/domain.js";
import type { BatchResult, Task, Team, User } from "./types";
import type {
  CalendarContext,
  CalendarData,
  CalendarEntry,
  CalendarEntryUpdate,
  CalendarTag,
  CalendarEntryDeletion,
  WeeklyItem,
  WeeklyAddResult,
} from "./calendar-types";
import "./calendar.css";

const EMPTY_MEMBERS: User[] = [];
const EMPTY_ENTRIES: CalendarEntry[] = [];
const EMPTY_TAGS: CalendarTag[] = [];

export default function Calendar({
  team,
  user,
  onBusyChange,
  onNotify,
}: {
  team: Team;
  user: User;
  onBusyChange: (busy: boolean) => void;
  onNotify: (message: string) => void;
}) {
  const today = todayKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [todayJump, setTodayJump] = useState(0);
  const appliedJump = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const createTitle = useRef<HTMLInputElement>(null);
  const composingTitle = useRef(false);
  const [memberWeeks, setMemberWeeks] = useState<Record<string, string>>({});
  const [view, setView] = useState<"shared" | "month" | "team">("month");
  const [memberId, setMemberId] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>(CALENDAR_DAYS);
  const [context, setContext] = useState<CalendarContext | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
  const copyRequest = useRef<{ source: CalendarEntry; id: string } | null>(
    null,
  );
  const deleteRequests = useRef(new Map<string, string>());
  const [deleted, setDeleted] = useState<{
    entry: CalendarEntry;
    deletionId: string;
  } | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState<{
    id: string;
    date: string;
    userId: string | null;
    title: string;
    tagIds: string[];
    checkedTagIds: string[];
  } | null>(null);
  const weeks = useMemo(() => monthWeeks(month), [month]);
  const navigationWeek =
    view === "team"
      ? memberWeeks[memberId] || calendarWeek(today)
      : month === today.slice(0, 7)
        ? calendarWeek(today)
        : weeks[0];
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
  const queries = useMemo(() => {
    if (view !== "shared" && (!members.length || !memberId)) return [];
    if (view !== "team")
      return [
        {
          userId: view === "shared" ? null : memberId,
          from: weeks[0],
          to: addDays(weeks[weeks.length - 1], 6),
        },
      ];
    return members.map((member) => {
      const from = memberWeeks[member.id] || calendarWeek(today);
      return { userId: member.id, from, to: addDays(from, 6) };
    });
  }, [members, memberId, view, weeks, memberWeeks, today]);
  const { data, schedules, updateData, beginMutation, endMutation } =
    useCalendarData(team.id, queries, reload);
  const loadError =
    view !== "team" ? schedules.get(monthlyOwner)?.error || "" : "";
  const scope = `${team.id}:${view}:${JSON.stringify(queries)}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const alive = useRef(true);
  const busy = useRef(false);
  const dragging = useCalendarDrag(
    scroll,
    `${scope}:${weekdays.join(",")}`,
    pending || !!rangeChange,
    (item, range, lane) => void saveRange({ entry: item, range, lane }),
  );
  const locked = pending || !!rangeChange || !!dragging.drag;
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
    !!task ||
    !!creating ||
    showDays ||
    showRule ||
    showTags ||
    !!addingWeek;
  useEffect(() => {
    if (!deleted || undoBlocked) return;
    const timer = setTimeout(() => setDeleted(null), 8000);
    return () => clearTimeout(timer);
  }, [deleted, undoBlocked]);
  useEffect(() => setDeleted(null), [team.id, user.id]);
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
  useLayoutEffect(() => {
    if (!data || todayJump === appliedJump.current || !scroll.current) return;
    appliedJump.current = todayJump;
    const root = scroll.current;
    const target = root.querySelector<HTMLElement>(`[data-date="${today}"]`);
    if (!target) return;
    const bounds = root.getBoundingClientRect();
    const cell = target.getBoundingClientRect();
    const stickyWidth =
      root.querySelector(".calendar-week-tasks")?.getBoundingClientRect()
        .width || 0;
    const headerHeight =
      root.querySelector(".calendar-grid-header")?.getBoundingClientRect()
        .height || 0;
    root.scrollTo({
      left: Math.max(
        0,
        root.scrollLeft + cell.left - bounds.left - stickyWidth - 1,
      ),
      top: Math.max(
        0,
        root.scrollTop + cell.top - bounds.top - headerHeight - 1,
      ),
    });
  }, [data, todayJump, today]);
  const manageable = canManageTeam(user, team.id);
  const writable = (ownerId: string | null) =>
    ownerId === null
      ? manageable || user.teamIds.includes(team.id)
      : manageable || (ownerId === user.id && canContribute(user, team.id));
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(
      locked ||
        !!entry ||
        !!tagEntry ||
        !!entryMenu ||
        !!task ||
        !!creating ||
        showDays ||
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
    task,
    creating,
    showDays,
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
          const displayed = entries
            .map((item) => {
              const position = placed?.get(item.id);
              return position ? { ...item, ...position } : item;
            })
            .sort(
              (a, b) =>
                a.lane - b.lane ||
                a.date.localeCompare(b.date) ||
                a.id.localeCompare(b.id),
            );
          return [ownerId, displayed] as const;
        }),
      ),
    [schedules, rangeChange],
  );
  const displayEntries = useMemo(
    () => [...displayedCalendars.values()].flat(),
    [displayedCalendars],
  );
  const dragPreview = useMemo(() => {
    const drag = dragging.drag;
    if (!drag?.valid) return null;
    const entry = data?.entries.find((item) => item.id === drag.id);
    if (!entry) return null;
    const layout = schedules.get(entry.userId)!.data!.layout;
    const position = placeCalendarEntry(layout, {
      ...entry,
      date: drag.date,
      endDate: drag.endDate,
      lane: drag.lane,
    }).find((item) => item.id === drag.id)!;
    return { ...entry, ...position };
  }, [dragging.drag, data, schedules]);
  const weeklyMap = useMemo(() => {
    const map = new Map<string, CalendarData["weekly"]>();
    for (const item of data?.weekly || []) {
      const key = `${item.userId}:${item.weekStart}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [data]);
  function upsert({ placements = [], layout, ...saved }: CalendarEntryUpdate) {
    if (activeScope.current !== scope || !alive.current) return;
    const positions = new Map(placements.map((item) => [item.id, item.lane]));
    updateData((previous, query) =>
      query.userId !== saved.userId
        ? previous
        : {
            ...previous,
            layout: mergeCalendarLayout(previous.layout, layout || [saved]),
            entries: [
              ...previous.entries
                .filter((item) => item.id !== saved.id)
                .map((item) => {
                  const lane = positions.get(item.id);
                  return lane === undefined || lane === item.lane
                    ? item
                    : { ...item, lane };
                }),
              ...(saved.date <= query.to && saved.endDate >= query.from
                ? [saved]
                : []),
            ],
          },
    );
  }
  function changeTags(next: CalendarTag[]) {
    const available = new Set(next.map((tag) => tag.id));
    const checkable = new Set(
      next.filter((tag) => tag.kind === "check").map((tag) => tag.id),
    );
    setContext(
      (previous) =>
        previous && {
          ...previous,
          tags: [
            ...previous.tags.filter((tag) => tag.userId !== tagOwner),
            ...next,
          ],
        },
    );
    // Names and colors are resolved through the owner's catalog. Only removal
    // changes entry references; no calendar reload is needed for tag edits.
    updateData((previous, query) => {
      if (query.userId !== tagOwner) return previous;
      if (
        !previous.entries.some(
          (item) =>
            item.tagIds.some((id) => !available.has(id)) ||
            item.checkedTagIds.some((id) => !checkable.has(id)),
        )
      )
        return previous;
      return {
        ...previous,
        entries: previous.entries.map((item) =>
          item.tagIds.some((id) => !available.has(id)) ||
          item.checkedTagIds.some((id) => !checkable.has(id))
            ? {
                ...item,
                tagIds: item.tagIds.filter((id) => available.has(id)),
                checkedTagIds: item.checkedTagIds.filter((id) =>
                  checkable.has(id),
                ),
              }
            : item,
        ),
      };
    });
    setTagEntry((previous) =>
      previous && previous.userId === tagOwner
        ? {
            ...previous,
            tagIds: previous.tagIds.filter((id) => available.has(id)),
            checkedTagIds: previous.checkedTagIds.filter((id) =>
              checkable.has(id),
            ),
          }
        : previous,
    );
    setCreating((previous) =>
      previous && previous.userId === tagOwner
        ? {
            ...previous,
            tagIds: previous.tagIds.filter((id) => available.has(id)),
            checkedTagIds: previous.checkedTagIds.filter((id) =>
              checkable.has(id),
            ),
          }
        : previous,
    );
  }
  function changeMonth(next: string) {
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(next) ||
      next < "2000-01" ||
      next > "2100-12"
    )
      return;
    setMonth(next);
  }
  async function action(work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    beginMutation();
    setPending(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      busy.current = false;
      endMutation();
      if (alive.current) setPending(false);
    }
  }
  function entryDeleted(
    removed: CalendarEntry,
    { deletionId, placements, layout }: CalendarEntryDeletion,
  ) {
    const positions = new Map(placements.map((item) => [item.id, item.lane]));
    updateData((previous, query) =>
      query.userId !== removed.userId
        ? previous
        : {
            ...previous,
            layout: mergeCalendarLayout(previous.layout, layout, removed.id),
            entries: previous.entries
              .filter((item) => item.id !== removed.id)
              .map((item) => {
                const lane = positions.get(item.id);
                return lane === undefined || lane === item.lane
                  ? item
                  : { ...item, lane };
              }),
          },
    );
    setDeleted({ entry: removed, deletionId });
    onNotify("");
    setEntry(null);
  }
  async function duplicateEntry(source: CalendarEntry) {
    if (!writable(source.userId)) return;
    if (copyRequest.current?.source.id !== source.id)
      copyRequest.current = { source, id: crypto.randomUUID() };
    const copy = copyRequest.current;
    await action(async () => {
      const saved = await send<CalendarEntry>(
        `/calendar/entries/${copy.source.id}/copy`,
        { id: copy.id },
      );
      upsert(saved);
      copyRequest.current = null;
    });
  }
  async function removeEntry(source: CalendarEntry) {
    if (!writable(source.userId)) return;
    const deletionId =
      deleteRequests.current.get(source.id) || crypto.randomUUID();
    deleteRequests.current.set(source.id, deletionId);
    await action(async () => {
      const result = await deleteCalendarEntry(source, deletionId);
      if (!alive.current) return;
      entryDeleted(source, result);
      deleteRequests.current.delete(source.id);
    });
  }
  async function updateEntryTags(source: CalendarEntry, ids: string[]) {
    await action(async () => {
      try {
        const saved = await saveCalendarEntryTags(source, ids);
        upsert(saved);
        setTagEntry(saved);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const latest = await api<CalendarEntry>(
            `/calendar/entries/${source.id}`,
          );
          upsert(latest);
          setTagEntry(latest);
        }
        throw error;
      }
    });
  }
  async function restoreEntry() {
    if (!deleted || undoBlocked || busy.current) return;
    const restoring = deleted;
    await action(async () => {
      const saved = await send<CalendarEntryUpdate>(
        `/calendar/entries/${restoring.entry.id}/restore`,
        {
          deletionId: restoring.deletionId,
          previousRange: {
            date: restoring.entry.date,
            endDate: restoring.entry.endDate,
          },
        },
      );
      if (!alive.current || restoring.entry.teamId !== team.id) return;
      upsert(saved);
      setDeleted(null);
      onNotify(`‘${saved.title}’ 일정을 되살렸습니다.`);
    });
  }
  function updateWeekly(ownerId: string, start: string, weekly: WeeklyItem[]) {
    updateData((previous, query) =>
      query.userId !== ownerId
        ? previous
        : {
            ...previous,
            weekly: [
              ...previous.weekly.filter((item) => item.weekStart !== start),
              ...weekly,
            ],
          },
    );
  }
  async function importWeek(ownerId: string, start: string) {
    const requestScope = scope;
    await action(async () => {
      const result = await send<WeeklyAddResult & { unassigned: number }>(
        "/calendar/import",
        {
          teamId: team.id,
          userId: ownerId,
          weekStart: start,
        },
      );
      if (!alive.current || activeScope.current !== requestScope) return;
      updateWeekly(ownerId, start, result.weekly);
      setDeleted(null);
      onNotify(
        `${members?.find((m) => m.id === ownerId)?.name} · ${weekLabel(start)}: ${result.added}개 가져옴, 기존 ${result.existing}개 유지${result.unassigned ? ` · 미지정 ${result.unassigned}개 제외` : ""}`,
      );
    });
  }
  async function saveRange(
    change: { entry: CalendarEntry; range: CalendarRange; lane?: number },
    expected?: CalendarRange & { lane?: number },
  ) {
    const reordering = change.lane !== undefined;
    if (
      busy.current ||
      !writable(change.entry.userId) ||
      (reordering
        ? change.lane === change.entry.lane
        : change.entry.date === change.range.date &&
          change.entry.endDate === change.range.endDate)
    )
      return;
    if (reordering && expected)
      change = {
        ...change,
        entry: { ...change.entry, ...expected },
        range: { date: expected.date, endDate: expected.endDate },
      };
    setRangeChange(change);
    await action(async () => {
      try {
        const previous = expected || change.entry;
        const saved = await send<CalendarEntryUpdate>(
          `/calendar/entries/${change.entry.id}`,
          {
            ...(reordering
              ? {
                  lane: change.lane,
                  expectedLane: previous.lane ?? change.entry.lane,
                }
              : change.range),
            expectedDate: previous.date,
            expectedEndDate: previous.endDate,
          },
          "PATCH",
        );
        if (!alive.current || activeScope.current !== scope) return;
        upsert(saved);
        setRangeChange(null);
        setRangeConflict(null);
      } catch (e) {
        if (alive.current && e instanceof ApiError && e.details?.currentRange)
          setRangeConflict(e.details.currentRange as CalendarRange);
        throw e;
      }
    });
  }
  async function openTask(id: string) {
    const requestScope = scope;
    await action(async () => {
      const result = await api<{ task: Task }>(`/calendar/tasks/${id}`);
      if (alive.current && activeScope.current === requestScope)
        setTask(result.task);
    });
  }
  async function checkTag(
    item: CalendarEntry,
    tagId: string,
    checked: boolean,
  ) {
    if (locked || !writable(item.userId)) return;
    const requestScope = scope;
    const apply = (change: {
      tagId: string;
      checked: boolean;
      updatedAt: string;
    }) => {
      if (!alive.current || activeScope.current !== requestScope) return;
      updateData((previous, query) =>
        query.userId !== item.userId
          ? previous
          : {
              ...previous,
              entries: previous.entries.map((value) =>
                value.id === item.id
                  ? applyCalendarTagCheck(value, change)
                  : value,
              ),
            },
      );
    };
    await action(async () => {
      apply({ tagId, checked, updatedAt: item.updatedAt });
      try {
        apply(await saveCalendarTagCheck(item, tagId, checked));
      } catch (error) {
        apply({
          tagId,
          checked: item.checkedTagIds.includes(tagId),
          updatedAt: item.updatedAt,
        });
        throw error;
      }
    });
  }
  function newEntry(date: string, ownerId: string | null) {
    const key = `weekly-plan:calendar-create:${user.id}:${team.id}:${ownerId}:${date}`;
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      /* optional draft */
    }
    const tagIds: string[] = Array.isArray(saved?.tagIds)
      ? saved.tagIds.filter((id: string) => tagMap.get(id)?.userId === ownerId)
      : [];
    setCreating({
      id: typeof saved?.id === "string" ? saved.id : crypto.randomUUID(),
      date,
      userId: ownerId,
      title: typeof saved?.title === "string" ? saved.title : "",
      tagIds,
      checkedTagIds: Array.isArray(saved?.checkedTagIds)
        ? saved.checkedTagIds.filter(
            (id: string) =>
              tagIds.includes(id) && tagMap.get(id)?.kind === "check",
          )
        : [],
    });
  }
  const draftKey = creating
    ? `weekly-plan:calendar-create:${user.id}:${team.id}:${creating.userId}:${creating.date}`
    : "";
  function changeCreating(next: NonNullable<typeof creating>) {
    setCreating(next);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("새 일정을 임시 보관할 수 없습니다. 저장 후 닫아 주세요.");
    }
  }
  function saveCreating() {
    if (!creating || locked || !creating.title.trim() || composingTitle.current)
      return;
    void action(async () => {
      const saved = await send<CalendarEntry>("/calendar/entries", {
        ...creating,
        teamId: team.id,
      });
      if (!alive.current) return;
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* The server save succeeded. */
      }
      upsert(saved);
      setCreating(null);
    });
  }
  const dayCell = (date: string, ownerId: string | null, column: number) => (
    <div
      key={date}
      className={`calendar-day${date === today ? " is-today" : ""}${view !== "team" && !date.startsWith(month) ? " is-outside" : ""}`}
      data-date={date}
      data-weekday={weekdays[column]}
      data-owner-id={ownerId ?? "team"}
      style={{ gridColumn: column + (ownerId === null ? 1 : 2), gridRow: 1 }}
    >
      <div className="calendar-date">
        <time
          dateTime={date}
          aria-label={date}
          aria-current={date === today ? "date" : undefined}
        >
          {view !== "team" && !date.startsWith(month)
            ? date.slice(5).replace("-", "/")
            : date.slice(8).replace(/^0/, "")}
          {date === today && <span>오늘</span>}
        </time>
        {writable(ownerId) && (
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
  const weeklyCell = (start: string, ownerId: string) => {
    const items = weeklyMap.get(`${ownerId}:${start}`) || [];
    const editable = writable(ownerId);
    const currentWeek = start === calendarWeek(today);
    return (
      <aside
        className="calendar-week-tasks"
        aria-label={`${members.find((m) => m.id === ownerId)?.name} ${weekLabel(start)} 주간 할 일`}
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
        {items.length ? (
          <ul>
            {items.map((item) => (
              <li key={item.taskId}>
                <button
                  className={item.unavailable ? "is-unavailable" : ""}
                  {...busyProps(locked)}
                  onClick={() => void openTask(item.taskId)}
                >
                  {item.title || "제목 없는 업무"}
                  {item.unavailable && <span> · 조회할 수 없는 업무</span>}
                </button>
              </li>
            ))}
          </ul>
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
  const hiddenCount = useMemo(
    () =>
      displayEntries.filter((item) => {
        const starts =
          view !== "team"
            ? weeks
            : [memberWeeks[item.userId!] || calendarWeek(today)];
        return !starts.some((start) =>
          weekdays.some((day) => {
            const date = addDays(start, day);
            return date >= item.date && date <= item.endDate;
          }),
        );
      }).length,
    [displayEntries, view, weeks, memberWeeks, weekdays, today],
  );
  const weekRow = (start: string, ownerId: string | null) => {
    const dates = weekdays.map((day) => addDays(start, day));
    return (
      <div
        key={`${start}:${ownerId}`}
        className="calendar-week-row"
        data-week={start}
        data-owner-id={ownerId ?? "team"}
      >
        {ownerId !== null && weeklyCell(start, ownerId)}
        {dates.map((date, index) => dayCell(date, ownerId, index))}
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
          onOpen={setEntry}
          onContextMenu={(event, item) => {
            event.preventDefault();
            event.stopPropagation();
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
              if (!weeks.includes(navigationWeek))
                setMonth(addDays(navigationWeek, 3).slice(0, 7));
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
              setMemberWeeks((previous) =>
                Object.fromEntries(
                  members.map((m) => [m.id, previous[m.id] || navigationWeek]),
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
              if (!weeks.includes(navigationWeek))
                setMonth(addDays(navigationWeek, 3).slice(0, 7));
              setView("month");
            }}
          >
            <CalendarDays size={13} />
            개인 월간 보기
          </Button>
        </div>
        <div className="heading-actions calendar-view-options">
          {manageable && view !== "shared" && (
            <Button
              {...busyProps(locked, !context)}
              onClick={() =>
                void action(async () => {
                  const latest = await api<CalendarContext>(
                    `/calendar/teams/${team.id}`,
                  );
                  if (alive.current) {
                    setContext(latest);
                    setShowRule(true);
                  }
                })
              }
            >
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
                    onClick={() => changeMonth(moveMonth(month, -1))}
                  >
                    <ChevronLeft size={15} />
                  </Button>
                  <div className="calendar-month-picker">
                    <select
                      aria-label="캘린더 연도"
                      {...busyProps(locked)}
                      value={month.slice(0, 4)}
                      onChange={(e) =>
                        changeMonth(`${e.target.value}-${month.slice(5)}`)
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
                        changeMonth(
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
                    onClick={() => changeMonth(moveMonth(month, 1))}
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
                        data-tooltip-tone="black"
                        active={memberId === member.id}
                        aria-pressed={memberId === member.id}
                        {...busyProps(locked, !context)}
                        onClick={() => setMemberId(member.id)}
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
            {hiddenCount > 0 && (
              <Button onClick={() => setShowDays(true)}>
                숨긴 요일에 일정 {hiddenCount}개
              </Button>
            )}
            {view !== "team" && (
              <Button
                className="calendar-today-control"
                title="오늘"
                {...busyProps(locked)}
                onClick={() => {
                  setMonth(today.slice(0, 7));
                  setTodayJump((n) => n + 1);
                }}
              >
                오늘
              </Button>
            )}
          </div>
        </div>
        <ErrorNote error={error || loadError} />
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
          양 끝을 드래그하거나 끝부분에서 방향키로 기간을 조정합니다. Enter로
          상세 기간을 편집하고 Escape로 드래그를 취소합니다.
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
            <p role="status" className="calendar-loading">
              일정을 불러오고 있습니다…
            </p>
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
          >
            {view !== "team" ? (
              <div className="calendar-grid">
                {gridHeader()}
                {weeks.map((start) => weekRow(start, monthlyOwner))}
              </div>
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
                              {start.replaceAll("-", ".")}
                            </time>
                            <span>~</span>
                            <time dateTime={addDays(start, 6)}>
                              {addDays(start, 6).replaceAll("-", ".")}
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
                              <Button
                                {...busyProps(locked)}
                                onClick={() => setReload((n) => n + 1)}
                              >
                                {m.name} 일정 다시 불러오기
                              </Button>
                            </>
                          ) : (
                            <p role="status">
                              {m.name}의 일정을 불러오고 있습니다…
                            </p>
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
              void action(async () => {
                setTagEntry(
                  applyCalendarTagCheck(tagEntry, {
                    tagId,
                    checked,
                    updatedAt: tagEntry.updatedAt,
                  }),
                );
                try {
                  const change = await saveCalendarTagCheck(
                    tagEntry,
                    tagId,
                    checked,
                  );
                  const saved = applyCalendarTagCheck(tagEntry, change);
                  upsert(saved);
                  setTagEntry(saved);
                } catch (error) {
                  setTagEntry(tagEntry);
                  throw error;
                }
              })
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
          onClose={() => {
            if (pending) return;
            if (creating.title || creating.tagIds.length) {
              try {
                sessionStorage.setItem(draftKey, JSON.stringify(creating));
              } catch {
                setError(
                  "제목을 임시 보관할 수 없습니다. 제목을 복사하거나 저장 후 닫아 주세요.",
                );
                return;
              }
            }
            setCreating(null);
          }}
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
      {entry && (
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
      {addingWeek && (
        <CalendarTaskPicker
          teamId={team.id}
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
        <RowPanel
          task={task}
          settings={context.settings}
          user={user}
          users={members}
          onClose={() => {
            setTask(null);
          }}
          onDocumentSaved={(result) =>
            setTask(
              (previous) =>
                previous && {
                  ...previous,
                  hasDocument: result.hasDocument,
                  documentCount: result.documentCount,
                  updatedAt: result.taskUpdatedAt,
                },
            )
          }
          onSaveProperty={async (payload) => {
            const result = await send<BatchResult>("/cells/batch", payload);
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
            setTask(
              (previous) =>
                previous && {
                  ...previous,
                  updatedAt:
                    result.updatedAt?.[previous.id] || previous.updatedAt,
                  cells: {
                    ...previous.cells,
                    ...Object.fromEntries(
                      result.cells
                        .filter((cell) => cell.taskId === previous.id)
                        .map(({ key, taskId: _taskId, ...cell }) => [
                          key,
                          cell,
                        ]),
                    ),
                  },
                },
            );
            return result.cells;
          }}
        />
      )}
    </section>
  );
}
