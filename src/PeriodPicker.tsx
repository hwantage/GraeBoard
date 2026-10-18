import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
  visibleWeeks,
  weeksForPeriod,
  periodMonths,
  todayKey,
} from "../shared/domain.js";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./components";
import type { View } from "./types";
import { trackPointerDrag } from "./trackPointerDrag";

type Unit = "month" | "week";
type Drag = { unit: Unit; anchor: number; end: number; pointerId: number };

export default function PeriodPicker({
  year,
  view,
  disabled = false,
  onChange,
  onNavigate,
  navigationDisabled = false,
}: {
  year: number;
  view: View;
  disabled?: boolean;
  onChange: (range: Partial<View>) => void;
  onNavigate: (direction: -1 | 1) => void;
  navigationDisabled?: boolean;
}) {
  const weeks = useMemo(
    () => weeksForPeriod(year, view.startMonth),
    [year, view.startMonth],
  );
  const selectedWeeks = useMemo(
    () => new Set(visibleWeeks(year, view).map((week) => week.key)),
    [year, view],
  );
  const months = useMemo(
    () =>
      periodMonths(year, view.startMonth).map((month) => ({
        ...month,
        weeks: weeks.filter((week) => week.monthIndex === month.index),
      })),
    [weeks, year, view.startMonth],
  );
  const root = useRef<HTMLDivElement>(null);
  const today = todayKey();
  const dragRef = useRef<Drag | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const keyboardAnchor = useRef<{ unit: Unit; index: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => {
    keyboardAnchor.current = null;
    setDrag(null);
    return () => stopDrag.current?.();
  }, [year, view.startMonth, disabled]);

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

    stopDrag.current = trackPointerDrag(event, {
      captureTarget: grid,
      onMove: (event) => {
        const current = dragRef.current;
        if (!current) return;
        const end = indexAt(event.clientX);
        if (end === current.end) return;
        const next = { ...current, end };
        dragRef.current = next;
        setDrag(next);
      },
      onEnd: (position, cancelled) => {
        dragRef.current = null;
        stopDrag.current = null;
        setDrag(null);
        if (!cancelled) apply(unit, index, indexAt(position.clientX));
      },
    });
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
      const value = drag.unit === "month" ? week.monthIndex - 1 : index;
      return (
        value >= Math.min(drag.anchor, drag.end) &&
        value <= Math.max(drag.anchor, drag.end)
      );
    }
    return selectedWeeks.has(week.key);
  };
  return (
    <div className="period-picker" role="group" aria-label="월·주차 기간 선택">
      <Button
        className="period-nav"
        tooltip="이전 달로 이동"
        disabled={
          disabled ||
          navigationDisabled ||
          (year === 2000 && view.startMonth === 1)
        }
        onClick={() => onNavigate(-1)}
      >
        <ChevronLeft size={15} />
      </Button>
      <div className="period-scroll">
        <div
          ref={root}
          className={`period-grid ${drag ? "is-dragging" : ""}`}
          style={{
            gridTemplateColumns: weeks
              .map((week) => `minmax(${week.month === 1 ? 14 : 10}px, 1fr)`)
              .join(" "),
            minWidth: weeks.reduce(
              (width, week) => width + (week.month === 1 ? 14 : 10),
              2,
            ),
          }}
          onPointerDown={begin}
        >
          {months.map(
            (
              { year: monthYear, month, key: monthKey, weeks: monthWeeks },
              index,
            ) => {
              const selected = monthWeeks.filter((week) =>
                isSelected(week.index - 1),
              ).length;
              const label = month === 1 ? `${monthYear}년 1월` : `${month}월`;
              return (
                <button
                  type="button"
                  key={monthKey}
                  className={`period-month ${selected === monthWeeks.length ? "is-selected" : selected ? "is-partial" : ""}`}
                  style={{ gridColumn: `span ${monthWeeks.length}` }}
                  data-period-unit="month"
                  data-month={month}
                  data-year={monthYear}
                  aria-label={`${label} 전체`}
                  aria-pressed={
                    selected === monthWeeks.length
                      ? true
                      : selected
                        ? "mixed"
                        : false
                  }
                  data-tooltip={`${monthYear}년 ${month}월 · 드래그하여 여러 월 선택`}
                  disabled={disabled}
                  onKeyDown={(event) => key(event, "month", index)}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      keyboardAnchor.current = { unit: "month", index };
                      apply("month", index, index);
                    }
                  }}
                >
                  {label}
                </button>
              );
            },
          )}
          {months.flatMap(({ month, weeks: monthWeeks }) =>
            monthWeeks.map((week, index) => (
              <button
                type="button"
                key={week.key}
                className={`period-week ${isSelected(week.index - 1) ? "is-selected" : ""} ${index === 0 ? "month-start" : ""} ${today >= week.key && today <= week.end ? "this-week" : ""}`}
                data-period-unit="week"
                data-week={week.key}
                aria-label={`${month}월 ${index + 1}주`}
                aria-pressed={isSelected(week.index - 1)}
                aria-current={
                  today >= week.key && today <= week.end ? "date" : undefined
                }
                data-tooltip={`${month}월 ${index + 1}주 · ${week.key} ~ ${week.end}${today >= week.key && today <= week.end ? " · 이번 주" : ""}`}
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
      <Button
        className="period-nav"
        tooltip="다음 달로 이동"
        disabled={disabled || navigationDisabled || year === 2100}
        onClick={() => onNavigate(1)}
      >
        <ChevronRight size={15} />
      </Button>
    </div>
  );
}
