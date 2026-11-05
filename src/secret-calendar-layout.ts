import { placeCalendarEntry } from "../shared/calendar-layout.js";
import type { CalendarPlacement } from "./calendar-types";
import type { SecretCalendarEntry } from "./secret-calendar";

const overlaps = (a: CalendarPlacement, b: CalendarPlacement) =>
  a.date <= b.endDate && b.date <= a.endDate;

export function calendarDisplayLane(entry: CalendarPlacement) {
  return "displayLane" in entry && typeof entry.displayLane === "number"
    ? entry.displayLane
    : entry.lane;
}

// Server positions are only copied into this presentation layout. Neither
// the server cache nor a server write receives a secret card or display lane.
export function mergeSecretCalendarLayout(
  layout: CalendarPlacement[],
  entries: SecretCalendarEntry[],
): CalendarPlacement[] {
  let placed = [...layout];
  const previous: SecretCalendarEntry[] = [];
  for (const entry of [...entries].sort(
    (a, b) => a.lane - b.lane || a.order - b.order,
  )) {
    const bottom = nextLane(placed, entry);
    let lane = Math.min(entry.lane, bottom);
    for (const other of previous) {
      if (overlaps(other, entry))
        lane = Math.max(
          lane,
          placed.find((item) => item.id === other.id)!.lane + 1,
        );
    }
    const added = { ...entry, lane: bottom };
    placed = placeCalendarEntry([...placed, added], { ...added, lane });
    previous.push(entry);
  }
  return placed;
}

function nextLane(layout: CalendarPlacement[], range: CalendarPlacement) {
  return (
    Math.max(
      -1,
      ...layout
        .filter((item) => overlaps(item, range))
        .map((item) => item.lane),
    ) + 1
  );
}

export function nextSecretLane(
  layout: CalendarPlacement[],
  entries: SecretCalendarEntry[],
  range: CalendarPlacement,
) {
  return nextLane(mergeSecretCalendarLayout(layout, entries), range);
}

export function moveSecretEntries(
  layout: CalendarPlacement[],
  entries: SecretCalendarEntry[],
  id: string,
  range: Pick<CalendarPlacement, "date" | "endDate">,
  lane?: number,
) {
  const merged = mergeSecretCalendarLayout(layout, entries);
  const previous = merged.find((item) => item.id === id)!;
  const positions = new Map(
    placeCalendarEntry(merged, {
      ...previous,
      ...range,
      lane: lane ?? previous.lane,
    }).map((item) => [item.id, item.lane]),
  );
  return entries.map((entry) => ({
    ...entry,
    ...(entry.id === id ? range : {}),
    lane: positions.get(entry.id)!,
  }));
}
