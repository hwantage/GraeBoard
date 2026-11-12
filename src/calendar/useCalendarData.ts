import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../platform/api";
import type {
  CalendarData,
  CalendarEntry,
  CalendarPlacement,
  WeeklyItem,
} from "./calendar-types";
import { CALENDAR_MEMBER_BATCH } from "../../shared/calendar/calendar.js";
import { mergeCalendarLayout } from "../../shared/calendar/calendar-layout.js";

export type CalendarQuery = { userId: string | null; from: string; to: string };
type LoadedCalendar = {
  key: string;
  query: CalendarQuery;
  reload: number;
  data?: CalendarData;
  error?: string;
};
type CalendarUpdate = (
  data: CalendarData,
  query: CalendarQuery,
) => CalendarData;

// The monthly views read one member's calendar as consecutive ranges, a month
// at a time. They show as one calendar: an entry crossing ranges keeps its
// newest copy and the first range's failure is the calendar's failure.
function mergeCalendarRanges(
  results: (LoadedCalendar | undefined)[],
): LoadedCalendar | undefined {
  const [first] = results;
  const ready = results.filter(
    (result): result is LoadedCalendar & { data: CalendarData } =>
      !!result?.data,
  );
  if (!ready.length) return first;
  const entries = new Map<string, CalendarEntry>();
  const weekly = new Map<string, WeeklyItem>();
  let layout: CalendarPlacement[] = [];
  for (const { data } of ready) {
    for (const entry of data.entries) {
      const known = entries.get(entry.id);
      if (!known || known.revision <= entry.revision)
        entries.set(entry.id, entry);
    }
    for (const item of data.weekly)
      weekly.set(`${item.userId}:${item.weekStart}:${item.taskId}`, item);
    layout = mergeCalendarLayout(layout, data.layout);
  }
  return {
    key: ready.map((result) => result.key).join("|"),
    query: {
      userId: ready[0].query.userId,
      from: ready[0].query.from,
      to: ready[ready.length - 1].query.to,
    },
    reload: ready[0].reload,
    data: {
      entries: [...entries.values()],
      weekly: [...weekly.values()],
      layout,
    },
    error: first?.error,
  };
}

export function useCalendarData(
  teamId: string,
  queries: CalendarQuery[],
  reload: number,
) {
  const [loaded, setLoaded] = useState<Record<string, LoadedCalendar>>({});
  // Retrying reads again only the ranges that failed.
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const mutations = useRef(0);
  const deferred = useRef(new Set<() => void>());
  const pendingUpdates = useRef(new Set<CalendarUpdate[]>());
  const keyFor = (query: CalendarQuery) =>
    `${teamId}:${query.userId}:${query.from}:${query.to}`;
  // One result per range: adding a month to a monthly view reads only it.
  const slotFor = (query: CalendarQuery) =>
    `${query.userId ?? "team"}:${query.from}`;

  useEffect(() => {
    const controller = new AbortController();
    const reads = new Set<() => void>();
    // Keep the visible ranges only. Navigating one member reuses the others'
    // completed requests; unfinished requests are safely restarted.
    // A failed range is read again below, so it shows as loading, not failed.
    setLoaded((previous) =>
      Object.fromEntries(
        queries.flatMap((query) => {
          const slot = slotFor(query);
          return previous[slot]?.data ? [[slot, previous[slot]]] : [];
        }),
      ),
    );
    // Members on the same range load together, so the team view costs one
    // request (one server call) instead of one per member.
    const batches: CalendarQuery[][] = [];
    for (const query of queries) {
      const previous = loaded[slotFor(query)];
      if (
        previous?.key === keyFor(query) &&
        previous.reload === reload &&
        previous.data
      )
        continue;
      const batch =
        query.userId !== null &&
        batches.find(
          ([first, ...rest]) =>
            first.userId !== null &&
            first.from === query.from &&
            first.to === query.to &&
            rest.length + 1 < CALENDAR_MEMBER_BATCH,
        );
      if (batch) batch.push(query);
      else batches.push([query]);
    }
    for (const batch of batches) {
      const [{ from, to, userId }] = batch;
      const load = () =>
        batch.length > 1
          ? api<{ members: Record<string, CalendarData> }>(
              `/calendar/members?${new URLSearchParams({ teamId, from, to, userIds: batch.map((query) => query.userId).join(",") })}`,
              { signal: controller.signal },
            ).then((result) =>
              batch.map((query) => result.members[query.userId!]),
            )
          : api<CalendarData>(
              `/calendar?${new URLSearchParams({ teamId, from, to, ...(userId === null ? { scope: "team" } : { userId }) })}`,
              { signal: controller.signal },
            ).then((data) => [data]);
      const settle = (result: (query: CalendarQuery, i: number) => object) =>
        setLoaded((current) => ({
          ...current,
          ...Object.fromEntries(
            batch.map((query, i) => [
              slotFor(query),
              { key: keyFor(query), query, reload, ...result(query, i) },
            ]),
          ),
        }));
      const read = () => {
        if (controller.signal.aborted) return;
        if (mutations.current) {
          deferred.current.add(read);
          return;
        }
        deferred.current.delete(read);
        const startedAt = generation.current;
        const updates: CalendarUpdate[] = [];
        pendingUpdates.current.add(updates);
        void load()
          .then((results) => {
            if (controller.signal.aborted) return;
            // A local edit may have committed after this GET captured its
            // snapshot. Reconcile only after the entire mutation settles, so
            // neither a stale result nor its retry replaces optimistic input.
            if (startedAt !== generation.current || mutations.current) {
              read();
              return;
            }
            settle((query, i) => ({
              data: updates.reduce(
                (result, update) => update(result, query),
                results[i],
              ),
            }));
          })
          .catch((error: Error) => {
            if (controller.signal.aborted) return;
            if (startedAt !== generation.current || mutations.current) {
              read();
              return;
            }
            settle(() => ({ error: error.message }));
          })
          .finally(() => pendingUpdates.current.delete(updates));
      };
      reads.add(read);
      read();
    }
    return () => {
      controller.abort();
      for (const read of reads) deferred.current.delete(read);
    };
    // Loaded results deliberately do not trigger new requests.
  }, [teamId, queries, reload, attempt]);

  // Results in the order of the queries; a member with several ranges reads
  // them in schedules as one calendar.
  const ranges = useMemo(
    () =>
      queries.map((query) => {
        const result = loaded[slotFor(query)];
        return result?.key === keyFor(query) ? result : undefined;
      }),
    [teamId, queries, reload, loaded],
  );
  const schedules = useMemo(() => {
    const owners = new Map<string | null, (LoadedCalendar | undefined)[]>();
    queries.forEach((query, i) => {
      const results = owners.get(query.userId) || [];
      results.push(ranges[i]);
      owners.set(query.userId, results);
    });
    return new Map(
      [...owners].map(([owner, results]) => [
        owner,
        results.length === 1 ? results[0] : mergeCalendarRanges(results),
      ]),
    );
  }, [queries, ranges]);
  const data = useMemo(() => {
    const available = [...schedules.values()].flatMap((result) =>
      result?.data ? [result.data] : [],
    );
    return available.length
      ? {
          entries: available.flatMap((result) => result.entries),
          weekly: available.flatMap((result) => result.weekly),
        }
      : null;
  }, [schedules]);

  function updateData(update: CalendarUpdate) {
    // Local merges also apply to unfinished reads. Updating a tag catalog or
    // task title must not discard another member's valid calendar response.
    for (const updates of pendingUpdates.current) updates.push(update);
    setLoaded((previous) => {
      let next = previous;
      for (const [id, result] of Object.entries(previous)) {
        if (!result.data) continue;
        const data = update(result.data, result.query);
        if (data === result.data) continue;
        if (next === previous) next = { ...previous };
        next[id] = { ...result, data };
      }
      return next;
    });
  }
  function beginMutation() {
    mutations.current++;
    generation.current++;
  }
  function endMutation() {
    if (!mutations.current || --mutations.current) return;
    for (const read of [...deferred.current]) read();
  }
  function retry() {
    setAttempt((value) => value + 1);
  }
  return {
    data,
    schedules,
    ranges,
    updateData,
    beginMutation,
    endMutation,
    retry,
  };
}
