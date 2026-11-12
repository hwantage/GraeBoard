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
// Pixels a jump may drift while rows settle before it counts as a scroll.
const SETTLE = 8;
const LAST_MONTH = "2100-12";
// Months listed one after another at most. Scrolling stops adding months
// here, so a long scroll does not keep adding rows and range reads; the
// period buttons and selects still move on.
export const CALENDAR_SCROLL_MONTHS = 12;

// A row to bring to the top of the grid once it is shown. Today also brings
// its column into view. top/left record where the jump left the grid; until
// the user scrolls away from there, months added below complete a jump that
// the grid's end cut short.
type CalendarJump = {
  week: string;
  date?: string;
  top?: number;
  left?: number;
};
export type CalendarMonthChunk = { month: string; weeks: string[] };

export function calendarMonthCount(start: string, end: string) {
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
export function calendarMonthChunks(
  start: string,
  end: string,
): CalendarMonthChunk[] {
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
      else if (
        calendarMonthCount(range.start, target) <= CALENDAR_SCROLL_MONTHS
      ) {
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

export type CalendarMonthRange = ReturnType<typeof useCalendarMonthRange>;

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
// A jump is applied again when `content` changes until the user scrolls, so
// rows growing above it keep it in place. The grid turns off the browser's
// scroll anchoring for this (calendar.css): its adjustment would otherwise
// look like a user scroll.
export function useCalendarMonthScroll(
  scroll: RefObject<HTMLDivElement | null>,
  months: CalendarMonthRange,
  shown: string[],
  content: unknown,
  enabled: boolean,
) {
  const { range, chunks, jump, jumped, setMonth, append } = months;
  const full =
    range.end >= LAST_MONTH ||
    calendarMonthCount(range.start, range.end) >= CALENDAR_SCROLL_MONTHS;
  const lastWeek = chunks[chunks.length - 1].weeks.at(-1)!;
  // Whether the grid is still about where the last jump left it. Rows and
  // the loading row settling move it by a few pixels, and the grid's end
  // moving up pulls it back; neither is a scroll. Wheel, touch, keys and
  // pointers on the grid end the jump at once (see the returned handlers).
  function kept(root: HTMLElement, target: CalendarJump) {
    if (target.top === undefined) return false;
    const moved = root.scrollTop - target.top;
    if (Math.abs(root.scrollLeft - target.left!) > SETTLE || moved > SETTLE)
      return false;
    return (
      moved >= -SETTLE ||
      root.scrollTop + root.clientHeight >= root.scrollHeight - 1
    );
  }
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
    if (target?.top !== undefined && !kept(root, target)) jump.current = null;
    else if (target) {
      const row = root.querySelector<HTMLElement>(
        `.calendar-week-row[data-week="${target.week}"]`,
      );
      if (row) {
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
          top: Math.max(
            0,
            root.scrollTop +
              row.getBoundingClientRect().top -
              bounds.top -
              root.clientTop -
              header,
          ),
        });
        target.top = root.scrollTop;
        target.left = root.scrollLeft;
      }
    }
    fill(root);
  }, [enabled, shown, content, jumped]);
  const release = () => {
    jump.current = null;
  };
  return {
    onScroll() {
      const root = scroll.current;
      const target = jump.current;
      if (!enabled || !root) return;
      if (!target || !kept(root, target)) {
        jump.current = null;
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
