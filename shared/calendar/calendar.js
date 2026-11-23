// Calendar dates are civil dates, never local timestamps. Weeks run Sunday–Saturday.
// Annual sheets use the Monday inside that calendar week; neither key is inferred
// from the visible weekdays (hiding Sunday must not change a saved week).
export const CALENDAR_MAX_RANGE_DAYS = 62;
// Team members on the same week load in one request of at most this many.
export const CALENDAR_MEMBER_BATCH = 50;
export const CALENDAR_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
// An entry may start at a time of day ("HH:MM") on its first date and ask for
// reminders some minutes before it, several at once. Both are optional, and
// reminders need a time. The time is read in Korea Standard Time on both sites.
export const CALENDAR_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const CALENDAR_REMINDER_MAX_MINUTES = 1440;
export const CALENDAR_REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60];
// A reminder is still sent this long after its time (a restart, an entry that
// arrived late from the other site). Later than that it counts as missed.
export const CALENDAR_REMINDER_GRACE_MS = 10 * 60 * 1000;
/** Reminder minutes without repeats, soonest before the start last. */
export const calendarReminders = (list) =>
  [...new Set(list || [])].sort((a, b) => a - b);
export const CALENDAR_TIME_ZONE_OFFSET = "+09:00";
/** "정시", "10분 전" or "1시간 전" for a reminder's minutes. */
export function calendarReminderLabel(minutes) {
  if (minutes === 0) return "정시";
  if (minutes % 60 === 0) return `${minutes / 60}시간 전`;
  return `${minutes}분 전`;
}
/**
 * The shared (synchronized) fields of a start time and its reminders: a field
 * that is not set is left out, so entries without a time keep the payload
 * they had before these fields existed. The two are stored independently,
 * because sites may change them at the same time; the commands of both sites
 * clear the reminders with the time, and reminders without a time never fire.
 * @param {string | null | undefined} time
 * @param {number[] | null | undefined} reminders
 * @returns {{ time?: string, reminders?: number[] }}
 */
export function calendarSchedule(time, reminders) {
  const list = calendarReminders(reminders);
  return {
    ...(time ? { time } : {}),
    ...(list.length ? { reminders: list } : {}),
  };
}
/**
 * How an entry's reminders stand on the site that sends them: "failed" when
 * one reached nobody or was missed, else "pending" while one is still to
 * come, else "sent". null without a time or reminders.
 * @param {{ date: string, time?: string | null, reminders?: number[] }} entry
 * @param {Map<string, number>} sent recipients by the reminder's ISO time
 * @param {number} now epoch milliseconds
 * @returns {"pending" | "sent" | "failed" | null}
 */
export function calendarReminderStatus(entry, sent, now) {
  const start = calendarStartMs(entry.date, entry.time);
  if (start === null || !entry.reminders?.length) return null;
  let pending = false;
  for (const minutes of entry.reminders) {
    const at = start - minutes * 60000,
      recipients = sent.get(new Date(at).toISOString());
    if (recipients === undefined) {
      if (now - at > CALENDAR_REMINDER_GRACE_MS) return "failed";
      pending = true;
    } else if (!recipients) return "failed";
  }
  return pending ? "pending" : "sent";
}
/** When an entry starts, in epoch milliseconds; null without a start time. */
export function calendarStartMs(date, time) {
  if (!time) return null;
  const ms = Date.parse(`${date}T${time}:00${CALENDAR_TIME_ZONE_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}
export function addDays(key, count) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function calendarWeek(key) {
  return addDays(key, -new Date(`${key}T12:00:00Z`).getUTCDay());
}
export function daysBetween(from, to) {
  return (
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000
  );
}
export function moveCalendarRange(entry, mode, anchor, target) {
  if (mode === "start")
    return {
      date: target > entry.endDate ? entry.endDate : target,
      endDate: entry.endDate,
    };
  if (mode === "end")
    return {
      date: entry.date,
      endDate: target < entry.date ? entry.date : target,
    };
  const offset = daysBetween(anchor, target);
  return {
    date: addDays(entry.date, offset),
    endDate: addDays(entry.endDate, offset),
  };
}
export function monthWeeks(month) {
  const first = `${month}-01`;
  const date = new Date(`${first}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  // Include the week containing the previous month's last day and the next
  // month's first day, even when this month starts Sunday or ends Saturday.
  const last = calendarWeek(date.toISOString().slice(0, 10));
  const weeks = [];
  for (
    let start = calendarWeek(addDays(first, -1));
    start <= last;
    start = addDays(start, 7)
  )
    weeks.push(start);
  return weeks;
}
export function moveMonth(month, offset) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
export function weekLabel(start) {
  return `${start} ~ ${addDays(start, 6)}`;
}
export function canUseCalendarRuleProperty(property) {
  return property.id !== "title" && property.id !== "owner";
}
export function calendarRuleProblem(rule, properties) {
  if (!rule?.propertyId || !Array.isArray(rule.values))
    return "주간 할 일 기준이 없습니다. 팀장에게 기준 설정을 요청하세요.";
  const property = properties.find(
    (p) => p.id === rule.propertyId && !p.archived,
  );
  if (!property)
    return "기준 속성이 삭제되거나 보관되었습니다. 팀장이 기준을 다시 설정해야 합니다.";
  if (!canUseCalendarRuleProperty(property))
    return "작업과 팀원 속성은 주간 할 일 기준으로 선택할 수 없습니다. 팀장이 기준을 다시 설정해야 합니다.";
  if (
    property.kind === "option" &&
    rule.values.some(
      (id) =>
        id !== "" && !property.values.some((v) => v.id === id && !v.archived),
    )
  )
    return "기준 옵션이 삭제되거나 보관되었습니다. 팀장이 기준을 다시 설정해야 합니다.";
  return "";
}

// Keep one copy suffix and leave room within the existing 120-character title limit.
export function nextCalendarCopyTitle(title, existingTitles) {
  const titles = new Set(existingTitles);
  const match = title.match(/^(.*) \(([1-9]\d*)\)$/);
  const base = match?.[1] || title;
  const previous = Number(match?.[2] || 0);
  let number =
    Number.isSafeInteger(previous) &&
    previous < Number.MAX_SAFE_INTEGER - titles.size - 1
      ? previous + 1
      : 1;
  for (;;) {
    const suffix = ` (${number})`;
    const prefix = base
      .slice(0, 120 - suffix.length)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd();
    const candidate = `${prefix}${suffix}`;
    if (!titles.has(candidate)) return candidate;
    number++;
  }
}

// A week's to-do items are listed by importedAt, then task ID. Reordering
// hands the same times out again in the new order, made strictly increasing,
// so items added later still come last. Both sites use this, and only items
// whose time changes are written.
/**
 * @param {{taskId: string, importedAt: string}[]} current items in their order
 * @param {string[]} taskIds the same items in the new order
 * @returns {Map<string, string>} new importedAt by task ID, changed ones only
 */
export function weeklyOrderStamps(current, taskIds) {
  const times = current.map((item) => Date.parse(item.importedAt));
  times.sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++)
    if (times[i] <= times[i - 1]) times[i] = times[i - 1] + 1;
  const before = new Map(current.map((item) => [item.taskId, item.importedAt]));
  const changed = new Map();
  taskIds.forEach((taskId, index) => {
    const stamp = new Date(times[index]).toISOString();
    if (before.get(taskId) !== stamp) changed.set(taskId, stamp);
  });
  return changed;
}
