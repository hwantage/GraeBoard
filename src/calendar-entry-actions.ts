import { send } from "./api";
import type { CalendarEntry, CalendarEntryDeletion } from "./calendar-types";

export function deleteCalendarEntry(entry: CalendarEntry, deletionId: string) {
  return send<CalendarEntryDeletion>(
    `/calendar/entries/${entry.id}`,
    {
      deletionId,
      expectedUpdatedAt: entry.updatedAt,
      expectedRevision: entry.revision,
      expectedTitle: entry.title,
      expectedDate: entry.date,
      expectedEndDate: entry.endDate,
      expectedTagIds: entry.tagIds,
      expectedCheckedTagIds: entry.checkedTagIds,
    },
    "DELETE",
  );
}

export function saveCalendarEntryTags(entry: CalendarEntry, tagIds: string[]) {
  return send<CalendarEntry>(
    `/calendar/entries/${entry.id}`,
    {
      tagIds,
      expectedTagIds: entry.tagIds,
    },
    "PATCH",
  );
}
