import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { CalendarData } from "./calendar-types";
import { CALENDAR_MEMBER_BATCH } from "../shared/calendar.js";

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

  useEffect(() => {
    const controller = new AbortController();
    const reads = new Set<() => void>();
    // Keep one range per visible member. Navigating one member reuses the
    // others' completed requests; unfinished requests are safely restarted.
    // A failed range is read again below, so it shows as loading, not failed.
    setLoaded((previous) =>
      Object.fromEntries(
        queries.flatMap(({ userId }) => {
          const owner = userId ?? "team";
          return previous[owner]?.data ? [[owner, previous[owner]]] : [];
        }),
      ),
    );
    // Members on the same range load together, so the team view costs one
    // request (one server call) instead of one per member.
    const batches: CalendarQuery[][] = [];
    for (const query of queries) {
      const previous = loaded[query.userId ?? "team"];
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
              query.userId ?? "team",
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

  const schedules = useMemo(
    () =>
      new Map(
        queries.map((query) => {
          const result = loaded[query.userId ?? "team"];
          return [
            query.userId,
            result?.key === keyFor(query) ? result : undefined,
          ];
        }),
      ),
    [teamId, queries, reload, loaded],
  );
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
  return { data, schedules, updateData, beginMutation, endMutation, retry };
}
