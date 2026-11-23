import type { ReactNode } from "react";
import {
  CALENDAR_REMINDER_OPTIONS,
  CALENDAR_TIME_PATTERN,
  CALENDAR_TIME_ZONE_OFFSET,
  calendarReminderLabel,
  calendarReminders,
} from "../../shared/calendar/calendar.js";

// A start time with the reminders before it. `time` is null while the start
// reminder is off, and may be a time still being typed while it is on.
export type CalendarSchedule = { time: string | null; reminders: number[] };
export const NO_SCHEDULE: CalendarSchedule = { time: null, reminders: [] };
export const sameSchedule = (a: CalendarSchedule, b: CalendarSchedule) =>
  a.time === b.time &&
  a.reminders.length === b.reminders.length &&
  a.reminders.every((minutes, index) => minutes === b.reminders[index]);
export const validSchedule = (schedule: CalendarSchedule) =>
  schedule.time === null || CALENDAR_TIME_PATTERN.test(schedule.time);

// Turning the start reminder on asks for one five minutes before.
const DEFAULT_REMINDER = 5;
// The next half hour in Korea, where entry times are read.
function nextHalfHour() {
  const offset =
    (CALENDAR_TIME_ZONE_OFFSET.startsWith("-") ? -1 : 1) *
    (Number(CALENDAR_TIME_ZONE_OFFSET.slice(1, 3)) * 60 +
      Number(CALENDAR_TIME_ZONE_OFFSET.slice(4, 6)));
  const minutes = Math.floor((Date.now() / 60000 + offset) % 1440),
    next = (Math.floor(minutes / 30) + 1) * 30;
  return `${String(Math.floor(next / 60) % 24).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

// The "시작 알림" switch opens the start time and, on the same line, a check
// box for each reminder; with it off the entry has neither. Used when adding
// an entry and in its detail.
export default function CalendarScheduleFields({
  value,
  disabled = false,
  readOnly = false,
  onChange,
  actions,
}: {
  value: CalendarSchedule;
  disabled?: boolean;
  readOnly?: boolean;
  // `settled` is false for a time being typed, true for a choice.
  onChange: (next: CalendarSchedule, settled: boolean) => void;
  // Shown after the last reminder choice, e.g. a test button.
  actions?: ReactNode;
}) {
  const on = value.time !== null;
  return (
    <div className="calendar-schedule">
      <label className="switch-field">
        <span>시작 알림</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="시작 알림"
          checked={on}
          disabled={disabled || readOnly}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { time: nextHalfHour(), reminders: [DEFAULT_REMINDER] }
                : NO_SCHEDULE,
              true,
            )
          }
        />
        <span className="switch-track" aria-hidden="true" />
      </label>
      {on && (
        <div className="calendar-schedule-fields">
          <label className="calendar-schedule-time">
            시작 시각
            <input
              type="time"
              aria-label="일정 시작 시각"
              value={value.time ?? ""}
              disabled={disabled}
              readOnly={readOnly}
              onChange={(event) =>
                onChange({ ...value, time: event.target.value }, false)
              }
            />
          </label>
          <div
            className="calendar-reminder-options"
            role="group"
            aria-label="알림 시점"
          >
            {CALENDAR_REMINDER_OPTIONS.map((minutes: number) => {
              const selected = value.reminders.includes(minutes);
              return (
                <label key={minutes} className="checkbox">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled || readOnly}
                    onChange={() =>
                      onChange(
                        {
                          ...value,
                          reminders: calendarReminders(
                            selected
                              ? value.reminders.filter(
                                  (item) => item !== minutes,
                                )
                              : [...value.reminders, minutes],
                          ),
                        },
                        true,
                      )
                    }
                  />
                  {calendarReminderLabel(minutes)}
                </label>
              );
            })}
            {actions}
          </div>
        </div>
      )}
    </div>
  );
}
