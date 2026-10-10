import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { weeksForYear } from "../shared/domain.js";
import type { View } from "./types";

type Unit = "month" | "week";
type Drag = { unit: Unit; anchor: number; end: number; pointerId: number };

export default function PeriodPicker({
  year,
  view,
  disabled = false,
  onChange,
}: {
  year: number;
  view: View;
  disabled?: boolean;
  onChange: (range: Partial<View>) => void;
}) {
  const weeks = useMemo(() => weeksForYear(year), [year]);
  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        weeks: weeks.filter((week) => week.month === index + 1),
      })),
    [weeks],
  );
  const root = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const keyboardAnchor = useRef<{ unit: Unit; index: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => {
    setDrag(null);
    return () => stopDrag.current?.();
  }, [year, disabled]);

  function apply(unit: Unit, anchor: number, end: number) {
    const first = Math.min(anchor, end),
      last = Math.max(anchor, end);
    onChange({
      fromMonth: unit === "month" ? first + 1 : 1,
      toMonth: unit === "month" ? last + 1 : 12,
      fromWeek: unit === "week" ? weeks[first].key : "",
      toWeek: unit === "week" ? weeks[last].key : "",
      hiddenWeeks: [],
      collapsedMonths: [],
    });
  }
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || dragRef.current) return;
    const grid = event.currentTarget;
    const monthRow = grid.querySelector<HTMLButtonElement>(".period-month")!;
    const unit =
      event.clientY < monthRow.getBoundingClientRect().bottom
        ? "month"
        : "week";
    const buttons = [
      ...grid.querySelectorAll<HTMLButtonElement>(
        `[data-period-unit="${unit}"]`,
      ),
    ];
    const indexAt = (x: number) => {
      const index = buttons.findIndex(
        (button) => x < button.getBoundingClientRect().right,
      );
      return index < 0 ? buttons.length - 1 : index;
    };
    const index = indexAt(event.clientX);
    const pointerId = event.pointerId;
    event.preventDefault();
    buttons[index].focus({ preventScroll: true });
    const next: Drag = { unit, anchor: index, end: index, pointerId };
    dragRef.current = next;
    setDrag(next);
    keyboardAnchor.current = { unit, index };

    const clean = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancelPointer, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      dragRef.current = null;
      stopDrag.current = null;
      if (grid.hasPointerCapture(pointerId))
        grid.releasePointerCapture(pointerId);
    };
    const cancel = () => {
      clean();
      setDrag(null);
    };
    const commit = (end: number) => {
      clean();
      setDrag(null);
      apply(unit, index, end);
    };
    const move = (event: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== pointerId) return;
      if (!(event.buttons & 1)) {
        // Some browsers report the released button in a move before pointerup.
        // Keep the last range dragged while pressed; this move may be a hover.
        commit(current.end);
        return;
      }
      const end = indexAt(event.clientX);
      if (end === current.end) return;
      const next = { ...current, end };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      // The release can arrive without a final pointermove during a fast drag.
      const end = indexAt(event.clientX);
      commit(end);
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointerId) cancel();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    stopDrag.current = clean;
    // Keep tracking outside the cells, including when the browser drops capture.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancelPointer, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    grid.setPointerCapture(pointerId);
  }
  function key(
    event: KeyboardEvent<HTMLButtonElement>,
    unit: Unit,
    index: number,
  ) {
    const count = unit === "month" ? 12 : weeks.length;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? count - 1
          : event.key === "ArrowLeft"
            ? Math.max(0, index - 1)
            : event.key === "ArrowRight"
              ? Math.min(count - 1, index + 1)
              : null;
    if (next === null) return;
    event.preventDefault();
    root.current
      ?.querySelectorAll<HTMLButtonElement>(`[data-period-unit="${unit}"]`)
      [next]?.focus();
    if (event.shiftKey) {
      if (keyboardAnchor.current?.unit !== unit)
        keyboardAnchor.current = { unit, index };
      apply(unit, keyboardAnchor.current.index, next);
    } else keyboardAnchor.current = { unit, index: next };
  }
  const isSelected = (index: number) => {
    const week = weeks[index];
    if (drag) {
      const value = drag.unit === "month" ? week.month - 1 : index;
      return (
        value >= Math.min(drag.anchor, drag.end) &&
        value <= Math.max(drag.anchor, drag.end)
      );
    }
    return (
      week.month >= view.fromMonth &&
      week.month <= view.toMonth &&
      (!view.fromWeek || week.key >= view.fromWeek) &&
      (!view.toWeek || week.key <= view.toWeek)
    );
  };
  return (
    <div className="period-picker" role="group" aria-label="월·주차 기간 선택">
      <div
        ref={root}
        className={`period-grid ${drag ? "is-dragging" : ""}`}
        style={{
          gridTemplateColumns: `repeat(${weeks.length}, minmax(10px, 1fr))`,
          minWidth: weeks.length * 10 + 2,
        }}
        onPointerDown={begin}
      >
        {months.map(({ month, weeks: monthWeeks }, index) => {
          const selected = monthWeeks.filter((week) =>
            isSelected(week.index - 1),
          ).length;
          return (
            <button
              type="button"
              key={month}
              className={`period-month ${selected === monthWeeks.length ? "is-selected" : selected ? "is-partial" : ""}`}
              style={{ gridColumn: `span ${monthWeeks.length}` }}
              data-period-unit="month"
              data-month={month}
              aria-label={`${month}월 전체`}
              aria-pressed={
                selected === monthWeeks.length
                  ? true
                  : selected
                    ? "mixed"
                    : false
              }
              title={`${month}월 · 드래그하여 여러 월 선택`}
              disabled={disabled}
              onKeyDown={(event) => key(event, "month", index)}
              onClick={(event) => {
                if (event.detail === 0) {
                  keyboardAnchor.current = { unit: "month", index };
                  apply("month", index, index);
                }
              }}
            >
              {month}월
            </button>
          );
        })}
        {months.flatMap(({ month, weeks: monthWeeks }) =>
          monthWeeks.map((week, index) => (
            <button
              type="button"
              key={week.key}
              className={`period-week ${isSelected(week.index - 1) ? "is-selected" : ""} ${index === 0 ? "month-start" : ""}`}
              data-period-unit="week"
              data-week={week.key}
              aria-label={`${month}월 ${index + 1}주`}
              aria-pressed={isSelected(week.index - 1)}
              title={`${month}월 ${index + 1}주 · ${week.key} ~ ${week.end}`}
              disabled={disabled}
              onKeyDown={(event) => key(event, "week", week.index - 1)}
              onClick={(event) => {
                if (event.detail === 0) {
                  keyboardAnchor.current = {
                    unit: "week",
                    index: week.index - 1,
                  };
                  apply("week", week.index - 1, week.index - 1);
                }
              }}
            >
              {index + 1}
            </button>
          )),
        )}
      </div>
    </div>
  );
}
