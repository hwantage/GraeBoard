import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { moveCalendarRange } from "../shared/calendar.js";
import type { CalendarEntry } from "./calendar-types";
import { trackPointerDrag } from "./trackPointerDrag";

export type CalendarRange = Pick<CalendarEntry, "date" | "endDate">;
export type CalendarDragMode = "move" | "start" | "end" | "order";
export type CalendarDrag = CalendarRange & {
  id: string;
  valid: boolean;
  lane: number;
  mode: CalendarDragMode;
};

export function useCalendarDrag(
  root: RefObject<HTMLDivElement | null>,
  scope: string,
  disabled: boolean,
  onDrop: (entry: CalendarEntry, range: CalendarRange, lane?: number) => void,
) {
  const [drag, setDrag] = useState<CalendarDrag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const allowClick = (event: globalThis.PointerEvent) => {
      if (event.isPrimary && event.button === 0) {
        cleanup.current?.();
        suppressClick.current = false;
      }
    };
    window.addEventListener("pointerdown", allowClick, true);
    return () => {
      window.removeEventListener("pointerdown", allowClick, true);
      cleanup.current?.();
    };
  }, []);
  useEffect(() => {
    cleanup.current?.();
  }, [scope, disabled]);

  function start(
    event: PointerEvent<HTMLButtonElement>,
    entry: CalendarEntry,
    mode: CalendarDragMode,
  ) {
    const grid = root.current;
    if (!grid || disabled || event.button !== 0 || !event.isPrimary) return;
    cleanup.current?.();
    suppressClick.current = false;
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const originalRow =
      event.currentTarget.closest<HTMLElement>(".calendar-week-row");
    const events = event.currentTarget.closest<HTMLElement>(
      ".calendar-week-events",
    );
    const segment = event.currentTarget.closest<HTMLElement>(
      ".calendar-entry-segment",
    );
    const grabOffset =
      origin.y - (segment?.getBoundingClientRect().top || origin.y);
    let pointer = origin;
    let active = false;
    let frame = 0;
    let target: (CalendarRange & { lane?: number }) | null = null;
    const locate = () => {
      const bounds = grid.getBoundingClientRect();
      const left =
        bounds.left +
        (grid.querySelector(".calendar-week-tasks")?.getBoundingClientRect()
          .width || 0);
      const top =
        bounds.top +
        (grid.querySelector(".calendar-grid-header")?.getBoundingClientRect()
          .height || 0);
      if (
        pointer.x < left ||
        pointer.x >= bounds.right ||
        pointer.y < top ||
        pointer.y >= bounds.bottom
      )
        return null;
      return (
        Array.from(
          grid.querySelectorAll<HTMLElement>(".calendar-day[data-date]"),
        ).find((cell) => {
          if (cell.dataset.ownerId !== (entry.userId ?? "team")) return false;
          const box = cell.getBoundingClientRect();
          return (
            pointer.x >= box.left &&
            pointer.x < box.right &&
            pointer.y >= box.top &&
            pointer.y < box.bottom
          );
        }) || null
      );
    };
    const anchor = locate()?.dataset.date || entry.date;
    const maximumLane = Math.max(
      entry.lane,
      ...Array.from(
        events?.querySelectorAll<HTMLElement>("[data-entry-lane]") || [],
      )
        .filter(
          (item) =>
            item.dataset.rangeStart! <= anchor &&
            item.dataset.rangeEnd! >= anchor,
        )
        .map((item) => Number(item.dataset.entryLane)),
    );
    const update = () => {
      const cell = locate();
      const date = cell?.dataset.date;
      const sameDayOrder =
        mode === "move" &&
        date === anchor &&
        cell?.closest(".calendar-week-row") === originalRow;
      if (mode === "order" || sameDayOrder) {
        target = null;
        if (cell?.closest(".calendar-week-row") === originalRow && events) {
          const style = getComputedStyle(events);
          const pitch =
            parseFloat(style.getPropertyValue("--calendar-entry-height")) +
            parseFloat(style.getPropertyValue("--calendar-entry-gap"));
          const top =
            events.getBoundingClientRect().top + parseFloat(style.paddingTop);
          const lane = Math.max(
            0,
            Math.min(
              maximumLane,
              Math.round((pointer.y - grabOffset - top) / pitch),
            ),
          );
          target = { date: entry.date, endDate: entry.endDate, lane };
        }
      } else
        target = date ? moveCalendarRange(entry, mode, anchor, date) : null;
      const next = {
        id: entry.id,
        date: entry.date,
        endDate: entry.endDate,
        lane: entry.lane,
        ...target,
        mode: target?.lane === undefined ? mode : ("order" as const),
        valid: !!target,
      };
      setDrag((previous) =>
        previous?.date === next.date &&
        previous.endDate === next.endDate &&
        previous.lane === next.lane &&
        previous.mode === next.mode &&
        previous.valid === next.valid
          ? previous
          : next,
      );
    };
    const autoScroll = () => {
      const box = grid.getBoundingClientRect();
      if (
        pointer.x >= box.left &&
        pointer.x <= box.right &&
        pointer.y >= box.top &&
        pointer.y <= box.bottom
      ) {
        const left =
          box.left +
          (grid.querySelector(".calendar-week-tasks")?.getBoundingClientRect()
            .width || 0);
        const top =
          box.top +
          (grid.querySelector(".calendar-grid-header")?.getBoundingClientRect()
            .height || 0);
        const dx =
          pointer.x < left + 28 ? -10 : pointer.x > box.right - 28 ? 10 : 0;
        const dy =
          pointer.y < top + 28 ? -10 : pointer.y > box.bottom - 28 ? 10 : 0;
        if (dx || dy) {
          const previousLeft = grid.scrollLeft,
            previousTop = grid.scrollTop;
          grid.scrollLeft += dx;
          grid.scrollTop += dy;
          if (
            grid.scrollLeft !== previousLeft ||
            grid.scrollTop !== previousTop
          )
            update();
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!active && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 6)
        return;
      if (!active) {
        active = true;
        suppressClick.current = true;
        grid.setPointerCapture(pointerId);
        frame = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      pointer = { x: e.clientX, y: e.clientY };
      update();
    };
    const scrolled = () => {
      if (active) update();
    };
    cleanup.current = trackPointerDrag(event, {
      captureTarget: grid,
      onMove: move,
      onEnd: (position, cancelled) => {
        if (active && !cancelled) {
          pointer = { x: position.clientX, y: position.clientY };
          update();
        }
        cancelAnimationFrame(frame);
        grid.removeEventListener("scroll", scrolled);
        cleanup.current = null;
        setDrag(null);
        if (
          !cancelled &&
          active &&
          target &&
          (target.date !== entry.date ||
            target.endDate !== entry.endDate ||
            (target.lane !== undefined && target.lane !== entry.lane))
        )
          onDrop(
            entry,
            { date: target.date, endDate: target.endDate },
            target.lane,
          );
      },
    });
    grid.addEventListener("scroll", scrolled, { passive: true });
  }
  return { drag, start, canClick: () => !suppressClick.current };
}
