import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, taskQuery } from "../platform/api";
import { queryPolicyFor } from "../platform/query-policy";
import { useSite } from "../platform/site-context";
import useResourceSync from "../platform/useResourceSync";
import { joinQuery, type SharedQuery } from "../platform/shared-query";
import { subscribeCellChanges } from "../sheet/cell-sync";
import { mergeCellUpdates } from "../sheet/cell-updates.js";
import type { TaskSnapshot } from "../sheet/cell-updates.js";
import type { Task } from "../types";
import type { InsightsPeriod } from "./insights-types";
import { periodError } from "../../shared/insights/insights.js";

// Repeated year responses contain complete tasks. Reuse unchanged rows instead
// of invalidating every derived metric when a different task was edited.
export function reconcileInsightTasks(previous: Task[], fresh: Task[]) {
  const byId = new Map(previous.map((task) => [task.id, task]));
  const next = fresh.map((task) => {
    const old = byId.get(task.id);
    return old && JSON.stringify(old) === JSON.stringify(task) ? old : task;
  });
  return next.length === previous.length &&
    next.every((task, i) => task === previous[i])
    ? previous
    : next;
}

export default function useInsightsData(
  teamId: string,
  period: InsightsPeriod,
  initial: { tasks: Task[]; year: number; startMonth: number; cursor: string },
  refreshSettings: (signal: AbortSignal) => Promise<void>,
) {
  const policy = queryPolicyFor(useSite());
  const cache = useRef(
    new Map<number, TaskSnapshot>(
      (initial.startMonth > 1
        ? [initial.year, initial.year + 1]
        : [initial.year]
      ).map((year) => [
        year,
        { tasks: initial.tasks, cellEventId: initial.cursor },
      ]),
    ),
  );
  const [version, setVersion] = useState(0),
    [error, setError] = useState("");
  const pending = useRef(new Map<number, SharedQuery<void>>());
  const refreshWork = useRef(new Map<string, SharedQuery<boolean>>());
  const epoch = useRef(0);
  const valid = !periodError(period);
  const yearsKey = valid
    ? Array.from(
        {
          length:
            Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4)) + 1,
        },
        (_, i) => Number(period.from.slice(0, 4)) + i,
      ).join(":")
    : "";
  const years = useMemo(
    () => (yearsKey ? yearsKey.split(":").map(Number) : []),
    [yearsKey],
  );
  const previousYears = useRef(yearsKey);
  const scope = `${teamId}:${yearsKey}`;
  const querySchedule = useRef({
    scope: "",
    nextPollAt: 0,
    retryAt: 0,
    failures: 0,
    lastFailure: null as unknown,
  });
  // A different range may need missing years immediately. Old requests may
  // still serve another consumer, but cannot delay or overwrite this scope.
  if (querySchedule.current.scope !== scope)
    querySchedule.current = {
      scope,
      nextPollAt: Date.now() + policy.pollMs,
      retryAt: 0,
      failures: 0,
      lastFailure: null,
    };
  const settingsRef = useRef(refreshSettings);
  settingsRef.current = refreshSettings;
  const loadYear = useCallback(
    (year: number, signal: AbortSignal) => {
      let work = pending.current.get(year);
      if (!work || work.controller.signal.aborted) {
        work = {
          controller: new AbortController(),
          consumers: new Set(),
          promise: null!,
        };
        const entry = work;
        const read = async (): Promise<TaskSnapshot | undefined> => {
          // A sibling read can fail while this snapshot is being reconciled.
          // A stale-response retry obeys the same deadline as SSE/focus/poll.
          if (
            entry.controller.signal.aborted ||
            Date.now() < querySchedule.current.retryAt
          )
            return;
          const started = epoch.current;
          const snapshot = await api<TaskSnapshot>(taskQuery(teamId, year), {
            signal: entry.controller.signal,
          });
          return !entry.controller.signal.aborted && started !== epoch.current
            ? read()
            : snapshot;
        };
        entry.promise = read()
          .then((snapshot) => {
            if (!snapshot || entry.controller.signal.aborted) return;
            const old = cache.current.get(year);
            const tasks = reconcileInsightTasks(
              old?.tasks || [...cache.current.values()].flatMap((s) => s.tasks),
              snapshot.tasks,
            );
            cache.current.set(year, { ...snapshot, tasks });
            // A shared task is complete in every response; reconcile its identity
            // across year caches after this authoritative read as well.
            const fresh = new Map(tasks.map((task) => [task.id, task]));
            for (const [other, value] of cache.current)
              if (other !== year) {
                cache.current.set(other, {
                  ...value,
                  tasks: value.tasks.map((task) => fresh.get(task.id) || task),
                });
              }
            setVersion((v) => v + 1);
          })
          .finally(() => {
            if (pending.current.get(year) === entry)
              pending.current.delete(year);
          });
        pending.current.set(year, entry);
      }
      return joinQuery(work, signal);
    },
    [teamId],
  );
  const refresh = useCallback(
    async (signal: AbortSignal, missingOnly = false) => {
      const schedule = querySchedule.current;
      if (signal.aborted || schedule.scope !== scope) return true;
      if (Date.now() < schedule.retryAt) return false;
      const requestedYears = years.filter(
        (year) => !missingOnly || !cache.current.has(year),
      );
      if (missingOnly && !requestedYears.length) return true;
      const key = `${scope}:${missingOnly ? "missing" : "all"}`;
      let work = refreshWork.current.get(key);
      if (!work || work.controller.signal.aborted) {
        const entry: SharedQuery<boolean> = {
          controller: new AbortController(),
          consumers: new Set(),
          promise: null!,
        };
        const failuresAtStart = schedule.failures;
        const current = () =>
          !entry.controller.signal.aborted &&
          querySchedule.current === schedule;
        entry.promise = (async () => {
          try {
            const results = await Promise.allSettled([
              ...requestedYears.map((year) =>
                loadYear(year, entry.controller.signal),
              ),
              ...(!missingOnly
                ? [settingsRef.current(entry.controller.signal)]
                : []),
            ]);
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            // Different years/bootstrap can fail together. Honor the longest
            // Retry-After instead of whichever response happens to arrive first.
            if (failures.length)
              throw failures.toSorted(
                (a, b) =>
                  policy.retryDelay(
                    schedule.failures + 1,
                    b instanceof ApiError ? b : {},
                  ) -
                  policy.retryDelay(
                    schedule.failures + 1,
                    a instanceof ApiError ? a : {},
                  ),
              )[0];
            if (current()) {
              // A successful sibling must not dismiss a later failure.
              if (schedule.failures !== failuresAtStart) return false;
              schedule.nextPollAt = Date.now() + policy.pollMs;
              schedule.retryAt = 0;
              schedule.failures = 0;
              schedule.lastFailure = null;
              setError("");
            }
            return true;
          } catch (e) {
            if (!current()) return true;
            // The missing/full consumers can share the same failed year GET.
            if (schedule.lastFailure !== e) {
              schedule.lastFailure = e;
              const delay = policy.retryDelay(
                ++schedule.failures,
                e instanceof ApiError ? e : {},
              );
              const retryAt = Date.now() + delay;
              if (retryAt >= schedule.retryAt) {
                schedule.retryAt = retryAt;
                setError((e as Error).message);
              }
              schedule.nextPollAt = schedule.retryAt;
            }
            return false;
          }
        })().finally(() => {
          if (refreshWork.current.get(key) === entry)
            refreshWork.current.delete(key);
        });
        work = entry;
        refreshWork.current.set(key, entry);
      }
      return (await joinQuery(work, signal)) ?? true;
    },
    [years, loadYear, policy, scope],
  );
  useEffect(() => {
    const controller = new AbortController();
    const changed = previousYears.current !== yearsKey;
    previousYears.current = yearsKey;
    void refresh(controller.signal, !changed);
    return () => controller.abort();
  }, [refresh]);
  useResourceSync(`/teams/${teamId}`, (signal) => refresh(signal));
  // Cell saves use their own event channel rather than team invalidations.
  // One subscription per loaded year also covers out-of-range weeks of each
  // multi-year task, because the existing API scopes events by task membership.
  useEffect(() => {
    const controller = new AbortController();
    const stops = years.flatMap((year) => {
      const snapshot = cache.current.get(year);
      if (!snapshot?.cellEventId) return [];
      return [
        subscribeCellChanges({
          teamId,
          year,
          cursor: snapshot.cellEventId,
          onActivity: () => {
            epoch.current++;
          },
          onChanges: (changes) => {
            let changed = false;
            for (const [key, data] of cache.current) {
              const tasks = mergeCellUpdates(data.tasks, changes);
              if (tasks !== data.tasks) {
                cache.current.set(key, { ...data, tasks });
                changed = true;
              }
            }
            if (changed) setVersion((v) => v + 1);
          },
          onSnapshot: () => {
            epoch.current++;
            void refresh(controller.signal);
          },
          onAccessLost: () => {
            void refresh(controller.signal);
          },
        }),
      ];
    });
    return () => {
      controller.abort();
      stops.forEach((stop) => stop());
    };
    // A new fetched year needs its first subscription; cursor refreshes alone
    // do not reopen active streams on every cell update.
  }, [
    teamId,
    yearsKey,
    years.map((year) => cache.current.has(year)).join(":"),
    loadYear,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    const focus = () => {
      if (document.visibilityState === "visible")
        void refresh(controller.signal);
    };
    const poll = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() >= querySchedule.current.nextPollAt &&
        !refreshWork.current.has(`${scope}:all`) &&
        !refreshWork.current.has(`${scope}:missing`)
      )
        focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = setInterval(poll, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh, scope]);
  useEffect(
    () => () => {
      for (const work of refreshWork.current.values()) work.controller.abort();
      for (const work of pending.current.values()) work.controller.abort();
    },
    [],
  );
  const tasks = useMemo(() => {
    const merged = new Map<string, Task>();
    for (const year of years)
      for (const task of cache.current.get(year)?.tasks || [])
        merged.set(task.id, task);
    return [...merged.values()].filter((task) => !task.deletedAt);
  }, [years, version]);
  return {
    tasks,
    error,
    loading: years.some((year) => !cache.current.has(year)),
    retry: () => void refresh(new AbortController().signal),
  };
}
