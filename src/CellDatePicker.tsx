import { useId, useLayoutEffect, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { todayKey } from "../shared/domain.js";
import type { EditMove } from "./InlineCellEditor";

export function normalizeDateInput(value: string): string | null {
  const text = value.trim();
  if (!text) return "";
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (!match || Number(match[1]) === 0) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

export default function CellDatePicker({
  label,
  value,
  inputRef,
  inputProps,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string;
  value: string;
  inputRef: (input: HTMLInputElement | null) => void;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  onChange: (value: string) => void;
  onCommit: (move?: EditMove) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const anchor = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const today = todayKey();
  const selected = normalizeDateInput(value);
  const [month, setMonth] = useState((selected || today).slice(0, 7));
  const [focusedDate, setFocusedDate] = useState(selected || today);
  const pendingFocus = useRef<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 340 });
  const actions = useRef({ onCommit });
  actions.current = { onCommit };

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const panel = popup.current;
      if (!rect || !panel) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = panel.scrollHeight + 2;
      const flipped = below < height && above > below;
      const maxHeight = Math.max(0, Math.floor(flipped ? above : below));
      setPosition({
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8),
        ),
        top: flipped
          ? Math.max(8, rect.top - Math.min(height, maxHeight) - 4)
          : rect.bottom + 4,
        maxHeight,
      });
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        actions.current.onCommit();
    };
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, []);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    popup.current
      ?.querySelector<HTMLButtonElement>(
        `[data-date="${pendingFocus.current}"]`,
      )
      ?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [month, focusedDate]);

  function choose(date: string) {
    onChange(date);
    onCommit("stay");
  }
  function moveMonth(delta: number) {
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(date.toISOString().slice(0, 7));
  }
  const first = new Date(`${month}-01T12:00:00Z`);
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const activeDate = focusedDate.startsWith(month)
    ? focusedDate
    : `${month}-01`;
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = index - first.getUTCDay() + 1;
    return day > 0 && day <= last.getUTCDate() ? day : null;
  });
  return (
    <>
      <input
        {...inputProps}
        ref={(input) => {
          anchor.current = input;
          inputRef(input);
        }}
        type="text"
        inputMode="numeric"
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        aria-haspopup="dialog"
        aria-expanded="true"
        aria-controls={id}
        value={value}
        onChange={(event) => {
          const text = event.target.value;
          onChange(text);
          const date = normalizeDateInput(text);
          if (date) {
            setMonth(date.slice(0, 7));
            setFocusedDate(date);
          }
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            popup.current?.contains(event.relatedTarget)
          )
            return;
          inputProps.onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            popup.current
              ?.querySelector<HTMLButtonElement>(`[data-date="${activeDate}"]`)
              ?.focus();
          } else inputProps.onKeyDown?.(event);
        }}
      />
      {createPortal(
        <div
          id={id}
          ref={popup}
          role="dialog"
          aria-label={`${label} 달력`}
          className="cell-option-popup cell-date-popup"
          style={position}
          onPointerDown={(event) => {
            event.stopPropagation();
            // 날짜를 누를 때 입력칸의 blur가 먼저 저장하지 않게 한다.
            event.preventDefault();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              !event.currentTarget.contains(event.relatedTarget) &&
              !anchor.current?.contains(event.relatedTarget)
            )
              onCommit();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            } else if (event.key === "Tab") {
              event.preventDefault();
              onCommit(event.shiftKey ? "previous" : "next");
            } else if (
              event.target instanceof HTMLElement &&
              event.target.dataset.date
            ) {
              const date = new Date(`${event.target.dataset.date}T12:00:00Z`);
              const delta: Record<string, number> = {
                ArrowLeft: -1,
                ArrowRight: 1,
                ArrowUp: -7,
                ArrowDown: 7,
                Home: -date.getUTCDay(),
                End: 6 - date.getUTCDay(),
              };
              if (!(event.key in delta)) return;
              event.preventDefault();
              date.setUTCDate(date.getUTCDate() + delta[event.key]);
              if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
                return;
              const next = date.toISOString().slice(0, 10);
              pendingFocus.current = next;
              setMonth(next.slice(0, 7));
              setFocusedDate(next);
            }
          }}
        >
          <div className="cell-date-heading">
            <button
              type="button"
              aria-label="이전 달"
              disabled={month === "0001-01"}
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <strong aria-live="polite">
              {first.getUTCFullYear()}년 {first.getUTCMonth() + 1}월
            </strong>
            <button
              type="button"
              aria-label="다음 달"
              disabled={month === "9999-12"}
              onClick={() => moveMonth(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="cell-date-days">
            {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
              <span key={day} className="cell-date-weekday">
                {day}
              </span>
            ))}
            {days.map((day, index) => {
              const date = `${month}-${String(day).padStart(2, "0")}`;
              return day === null ? (
                <span key={index} />
              ) : (
                <button
                  type="button"
                  key={index}
                  data-date={date}
                  aria-label={`${first.getUTCFullYear()}년 ${first.getUTCMonth() + 1}월 ${day}일`}
                  aria-pressed={selected === date}
                  aria-current={today === date ? "date" : undefined}
                  tabIndex={activeDate === date ? 0 : -1}
                  onFocus={() => setFocusedDate(date)}
                  onClick={() => choose(date)}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="cell-date-actions">
            <button type="button" onClick={() => choose("")}>
              날짜 지우기
            </button>
            <button type="button" onClick={() => choose(today)}>
              오늘
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
