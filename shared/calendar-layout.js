/** @typedef {{id: string, date: string, endDate: string, lane: number}} Placement */

/** @param {Pick<Placement, 'date'|'endDate'>} a @param {Pick<Placement, 'date'|'endDate'>} b */
const overlaps = (a, b) => a.date <= b.endDate && b.date <= a.endDate;

/** @param {Placement[]} entries @param {Pick<Placement, 'date'|'endDate'>} range */
export function firstCalendarLane(entries, range) {
  const occupied = new Set(
    entries.filter((item) => overlaps(item, range)).map((item) => item.lane),
  );
  let lane = 0;
  while (occupied.has(lane)) lane++;
  return lane;
}

/**
 * Pack an established order without reversing overlapping cards. Each card
 * sits directly below the highest card overlapping any part of its date range.
 * A range-max tree avoids comparing every pair in a user's calendar history.
 * @template {Placement} T
 * @param {T[]} ordered
 * @returns {Map<string, T>}
 */
function stackCalendarEntries(ordered) {
  const dates = [
    ...new Set(ordered.flatMap((item) => [item.date, item.endDate])),
  ].sort();
  const indices = new Map(dates.map((date, index) => [date, index]));
  const highest = new Int32Array(dates.length * 4).fill(-1);
  const pending = new Int32Array(dates.length * 4).fill(-1);
  function range(node, left, right, from, to, value = -1) {
    if (right < from || left > to) return -1;
    if (from <= left && right <= to) {
      if (value >= 0) highest[node] = pending[node] = value;
      return highest[node];
    }
    if (pending[node] >= 0) {
      highest[node * 2] = pending[node * 2] = pending[node];
      highest[node * 2 + 1] = pending[node * 2 + 1] = pending[node];
      pending[node] = -1;
    }
    const middle = (left + right) >> 1;
    const result = Math.max(
      range(node * 2, left, middle, from, to, value),
      range(node * 2 + 1, middle + 1, right, from, to, value),
    );
    highest[node] = Math.max(highest[node * 2], highest[node * 2 + 1]);
    return result;
  }
  return new Map(
    ordered.map((item) => {
      const from = indices.get(item.date),
        to = indices.get(item.endDate);
      const lane = range(1, 0, dates.length - 1, from, to) + 1;
      range(1, 0, dates.length - 1, from, to, lane);
      return [item.id, lane === item.lane ? item : { ...item, lane }];
    }),
  );
}

/** @template {Placement} T @param {T[]} entries @returns {T[]} */
export function compactCalendarEntries(entries) {
  const placed = stackCalendarEntries(
    [...entries].sort(
      (a, b) =>
        a.lane - b.lane ||
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id),
    ),
  );
  return entries.map((item) => placed.get(item.id));
}

/**
 * Keep the relative order when dates change; explicit reordering shifts the
 * intervening cards toward the old position. Then close empty rows across the
 * full span of each card. Shared by the optimistic UI and the server.
 * @template {Placement} T
 * @param {T[]} entries
 * @param {T} changed
 * @returns {T[]}
 */
export function placeCalendarEntry(entries, changed) {
  const previous = entries.find((item) => item.id === changed.id);
  const from = previous?.lane ?? changed.lane;
  const to = changed.lane;
  const candidates = entries
    .filter((item) => item.id !== changed.id)
    .map((item) => {
      let lane = item.lane;
      if (overlaps(item, changed)) {
        if (from < to && lane > from && lane <= to) lane--;
        if (from > to && lane >= to && lane < from) lane++;
      }
      return { item, lane };
    })
    .concat({ item: changed, lane: to })
    .sort(
      (a, b) =>
        a.lane - b.lane ||
        Number(b.item.id === changed.id) - Number(a.item.id === changed.id) ||
        a.item.lane - b.item.lane ||
        a.item.date.localeCompare(b.item.date) ||
        a.item.id.localeCompare(b.item.id),
    );
  const placed = stackCalendarEntries(candidates.map(({ item }) => item));
  return entries.map((item) => placed.get(item.id));
}

/** @param {Placement[]} previous @param {Placement[]} changes @param {string} [removedId] */
export function mergeCalendarLayout(previous, changes, removedId) {
  const next = new Map(previous.map((item) => [item.id, item]));
  if (removedId) next.delete(removedId);
  for (const { id, date, endDate, lane } of changes)
    next.set(id, { id, date, endDate, lane });
  return [...next.values()];
}
