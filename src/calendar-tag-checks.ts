import { send } from "./api";
import type { CalendarEntry, CalendarTagCheck } from "./calendar-types";

export function saveCalendarTagCheck(
  entry: CalendarEntry,
  tagId: string,
  checked: boolean,
) {
  return send<CalendarTagCheck>(
    `/calendar/entries/${entry.id}/tags/${tagId}`,
    { checked, expectedChecked: entry.checkedTagIds.includes(tagId) },
    "PATCH",
  );
}

// A checkbox response only changes that tag; concurrent title, range,
// document and other checkbox saves must keep their latest values.
export function applyCalendarTagCheck(
  entry: CalendarEntry,
  change: CalendarTagCheck,
): CalendarEntry {
  if (!entry.tagIds.includes(change.tagId)) return entry;
  const checked = new Set(entry.checkedTagIds);
  if (change.checked) checked.add(change.tagId);
  else checked.delete(change.tagId);
  return {
    ...entry,
    checkedTagIds: entry.tagIds.filter((id) => checked.has(id)),
    updatedAt:
      change.updatedAt > entry.updatedAt ? change.updatedAt : entry.updatedAt,
  };
}
