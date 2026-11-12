import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  addDays,
  calendarWeek,
  monthWeeks,
  moveMonth,
} from "../../shared/calendar/calendar.js";

const FIRST_MONTH = "2000-01";
const LAST_MONTH = "2100-12";
// Months listed one after another at most. Scrolling stops adding months
// here, so a long scroll does not keep adding rows and range reads; the
// period buttons and selects still move on.
export const CALENDAR_SCROLL_MONTHS = 12;

// A row to bring to the top of the grid once it is shown. Today also brings
// its column into view.
type CalendarJump = { week: string; date?: string };
type CalendarMonthChunk = { month: string; weeks: string[] };

function calendarMonthCount(start: string, end: string) {
  return (
    (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
    Number(end.slice(5)) -
    Number(start.slice(5)) +
    1
  );
}

// Each listed month and the weeks it adds, each week once. The first month
// keeps its edge weeks as a single month view does; a later month adds the
// weeks after the one holding its first day. The ranges never depend on the
// first month, so adding a month reads only that month.
function calendarMonthChunks(start: string, end: string): CalendarMonthChunk[] {
  const chunks: CalendarMonthChunk[] = [];
  let last = "";
  for (let month = start; month <= end; month = moveMonth(month, 1)) {
    const weeks = monthWeeks(month).filter((week: string) => week > last);
    chunks.push({ month, weeks });
    last = weeks[weeks.length - 1];
  }
  return chunks;
}

// The first shown day of a month: its 1st unless that weekday is hidden.
export function calendarMonthFirstDay(month: string, weekdays: number[]) {
  const first = `${month}-01`;
  const day = new Date(`${first}T12:00:00Z`).getUTCDay();
  return addDays(
    first,
    Math.min(...weekdays.map((weekday) => (weekday - day + 7) % 7)),
  );
}

export function useCalendarMonthRange(today: string) {
  const current = today.slice(0, 7);
  const [range, setRange] = useState({ start: current, end: current });
  // The month of the period selects: the one scrolled to the top or moved to.
  const [month, setMonth] = useState(current);
  const jump = useRef<CalendarJump | null>({
    week: calendarWeek(today),
    date: today,
  });
  const [jumped, setJumped] = useState(0);
  const chunks = useMemo(
    () => calendarMonthChunks(range.start, range.end),
    [range.start, range.end],
  );
  const count = calendarMonthCount(range.start, range.end);
  // Scrolling adds no more months: the cap, or the last selectable month.
  const capped = range.end < LAST_MONTH && count >= CALENDAR_SCROLL_MONTHS;
  const full = capped || range.end >= LAST_MONTH;
  const todayJump = { week: calendarWeek(today), date: today };
  function go(target: CalendarJump, header: string) {
    jump.current = target;
    setMonth(header);
    setJumped((value) => value + 1);
  }
  // Lists months again from start, at the top unless another row is given.
  function show(
    start: string,
    target: CalendarJump = { week: monthWeeks(start)[0] },
    header = start,
  ) {
    setRange({ start, end: start });
    go(target, header);
  }
  return {
    range,
    month,
    chunks,
    full,
    capped,
    jump,
    jumped,
    setMonth,
    // A monthly view opened anew shows today, as the 오늘 button does.
    open: () => show(current, todayJump, current),
    today: () =>
      current >= range.start && current <= range.end
        ? go(todayJump, current)
        : show(current, todayJump, current),
    previous: () => {
      const target = moveMonth(month, -1);
      if (target >= FIRST_MONTH) show(target);
    },
    next: () => {
      const target = moveMonth(month, 1);
      if (target > LAST_MONTH) return;
      const anchor = { week: calendarWeek(`${target}-01`) };
      if (target <= range.end) go(anchor, target);
      else if (!full) {
        setRange({ start: range.start, end: target });
        go(anchor, target);
      } else show(target);
    },
    select: (target: string) => {
      if (
        /^\d{4}-(0[1-9]|1[0-2])$/.test(target) &&
        target >= FIRST_MONTH &&
        target <= LAST_MONTH
      )
        show(target);
    },
    // Lists months from the shown one again, e.g. for another member.
    restart: () => show(month),
    append: (end: string) =>
      setRange((previous) =>
        previous.end === end && end < LAST_MONTH
          ? { start: previous.start, end: moveMonth(end, 1) }
          : previous,
      ),
  };
}

type CalendarMonthRange = ReturnType<typeof useCalendarMonthRange>;

// The month whose first day is at or above the top row, i.e. the month of the
// top row's Saturday. At the very end of a list that cannot grow, the last
// month, whose first row may never reach the top.
function monthInView(
  root: HTMLElement,
  start: string,
  end: string,
  full: boolean,
) {
  const top =
    (root.querySelector(".calendar-grid-header")?.getBoundingClientRect()
      .bottom ?? root.getBoundingClientRect().top) + 1;
  let month = start;
  for (const row of root.querySelectorAll<HTMLElement>(
    ".calendar-week-row[data-week]",
  ))
    if (row.getBoundingClientRect().bottom > top) {
      month = addDays(row.dataset.week!, 6).slice(0, 7);
      break;
    }
  if (full && root.scrollTop + root.clientHeight >= root.scrollHeight - 1)
    month = end;
  return month < start ? start : month > end ? end : month;
}

// Applies jumps, follows the scrolled month in the period selects and adds
// the next month when the grid is scrolled within a screen of its end.
// `shown` lists the rendered weeks; months still loading are not rendered.
// A jump turns off the browser's scroll anchoring for the grid until the user
// scrolls. Anchoring would otherwise move the grid by itself when content
// changes size (the sticky header once web fonts load, for one), leaving the
// jumped-to row a few pixels off and firing scroll events nobody made. A jump
// cut short by the end of the list stays until the following month is shown
// and then completes. Only wheel, touch, keys and pointers on the grid end it.
export function useCalendarMonthScroll(
  scroll: RefObject<HTMLDivElement | null>,
  months: CalendarMonthRange,
  shown: string[],
  enabled: boolean,
) {
  const { range, chunks, full, jump, jumped, setMonth, append } = months;
  // Where the last jump left the grid; its own scroll event keeps the month
  // moved to instead of the one at the top.
  const placed = useRef<{ top: number; left: number } | null>(null);
  const lastWeek = chunks[chunks.length - 1].weeks.at(-1)!;
  function fill(root: HTMLElement) {
    if (
      full ||
      shown[shown.length - 1] !== lastWeek ||
      root.scrollHeight - root.scrollTop - root.clientHeight > root.clientHeight
    )
      return;
    append(range.end);
  }
  useLayoutEffect(() => {
    const root = scroll.current;
    const target = jump.current;
    if (!enabled || !root) return;
    const row =
      target &&
      root.querySelector<HTMLElement>(
        `.calendar-week-row[data-week="${target.week}"]`,
      );
    if (target && row) {
      const bounds = root.getBoundingClientRect();
      const header =
        root.querySelector(".calendar-grid-header")?.getBoundingClientRect()
          .height || 0;
      const cell = target.date
        ? row.querySelector<HTMLElement>(`[data-date="${target.date}"]`)
        : null;
      const stickyWidth =
        row.querySelector(".calendar-week-tasks")?.getBoundingClientRect()
          .width || 0;
      // Right below the sticky header, and today's column right of the
      // sticky week column.
      const top = Math.max(
        0,
        root.scrollTop +
          row.getBoundingClientRect().top -
          bounds.top -
          root.clientTop -
          header,
      );
      root.style.overflowAnchor = "none";
      root.scrollTo({
        left: cell
          ? Math.max(
              0,
              root.scrollLeft +
                cell.getBoundingClientRect().left -
                bounds.left -
                root.clientLeft -
                stickyWidth,
            )
          : root.scrollLeft,
        top,
      });
      placed.current = { top: root.scrollTop, left: root.scrollLeft };
      if (full || root.scrollTop >= top - 1) jump.current = null;
    }
    fill(root);
  }, [enabled, shown, jumped]);
  const release = () => {
    jump.current = null;
    scroll.current?.style.removeProperty("overflow-anchor");
  };
  return {
    onScroll() {
      const root = scroll.current;
      if (!enabled || !root) return;
      const at = placed.current;
      if (
        !jump.current &&
        (!at ||
          Math.abs(root.scrollTop - at.top) > 1 ||
          Math.abs(root.scrollLeft - at.left) > 1)
      ) {
        placed.current = null;
        setMonth(monthInView(root, range.start, range.end, full));
      }
      fill(root);
    },
    onWheel: release,
    onTouchStart: release,
    onPointerDown: release,
    onKeyDown: release,
  };
}
