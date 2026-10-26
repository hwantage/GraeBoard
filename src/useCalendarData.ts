import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { CalendarData } from "./calendar-types";

export type CalendarQuery = { userId: string | null; from: string; to: string };
type LoadedCalendar = {
  key: string;
  query: CalendarQuery;
  reload: number;
  data?: CalendarData;
  error?: string;
};

export function useCalendarData(
  teamId: string,
  queries: CalendarQuery[],
  reload: number,
) {
  const [loaded, setLoaded] = useState<Record<string, LoadedCalendar>>({});
  const generation = useRef(0);
  const mutations = useRef(0);
  const deferred = useRef(new Set<() => void>());
  const keyFor = (query: CalendarQuery) =>
    `${teamId}:${query.userId}:${query.from}:${query.to}`;

  useEffect(() => {
    const controller = new AbortController();
    const reads = new Set<() => void>();
    // Keep one range per visible member. Navigating one member reuses the
    // others' completed requests; unfinished requests are safely restarted.
    setLoaded((previous) =>
      Object.fromEntries(
        queries.flatMap(({ userId }) => {
          const owner = userId ?? "team";
          return previous[owner] ? [[owner, previous[owner]]] : [];
        }),
      ),
    );
    for (const query of queries) {
      const key = keyFor(query);
      const owner = query.userId ?? "team";
      const previous = loaded[owner];
      if (previous?.key === key && previous.reload === reload && previous.data)
        continue;
      const read = () => {
        if (controller.signal.aborted) return;
        if (mutations.current) {
          deferred.current.add(read);
          return;
        }
        deferred.current.delete(read);
        const startedAt = generation.current;
        void api<CalendarData>(
          `/calendar?${new URLSearchParams({ teamId, from: query.from, to: query.to, ...(query.userId === null ? { scope: "team" } : { userId: query.userId }) })}`,
          { signal: controller.signal },
        )
          .then((data) => {
            if (controller.signal.aborted) return;
            // A local edit may have committed after this GET captured its
            // snapshot. Reconcile only after the entire mutation settles, so
            // neither a stale result nor its retry replaces optimistic input.
            if (startedAt !== generation.current || mutations.current) {
              read();
              return;
            }
            setLoaded((current) => ({
              ...current,
              [owner]: { key, query, reload, data },
            }));
          })
          .catch((error: Error) => {
            if (controller.signal.aborted) return;
            if (startedAt !== generation.current || mutations.current) {
              read();
              return;
            }
            setLoaded((current) => ({
              ...current,
              [owner]: { key, query, reload, error: error.message },
            }));
          });
      };
      reads.add(read);
      read();
    }
    return () => {
      controller.abort();
      for (const read of reads) deferred.current.delete(read);
    };
    // Loaded results deliberately do not trigger new requests.
  }, [teamId, queries, reload]);

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

  function updateData(
    update: (data: CalendarData, query: CalendarQuery) => CalendarData,
  ) {
    generation.current++;
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
  return { data, schedules, updateData, beginMutation, endMutation };
}
