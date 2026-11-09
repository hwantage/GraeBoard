import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { api, ApiError, taskQuery } from "../platform/api";
import { useSite } from "../platform/site-context";
import { queryPolicyFor } from "../platform/query-policy";
import { joinQuery } from "../platform/shared-query";
import { mergeCellUpdates, mergeSnapshotCells } from "./cell-updates.js";
import { subscribeCellChanges } from "./cell-sync";
import { updateDocumentLinkTitle } from "../documents/document-links";
import type { Bootstrap, Task } from "../types";

// Owns the original sheet's read model, read cancellation and live updates.
// Commands replace this snapshot only after their own persistence succeeds.
export default function useTaskData(options: {
  teamId: string;
  year: number;
  startMonth: number;
  viewYear: number;
  copy: boolean;
  active: boolean;
  available: boolean;
  boot: Bootstrap;
  onBootstrap: (boot: Bootstrap) => void;
  blocked: () => boolean;
  onScopeChange: () => void;
  onAccessLost: () => void;
}) {
  const {
    teamId,
    year,
    startMonth,
    viewYear,
    copy,
    active,
    available,
    boot,
    onBootstrap,
  } = options;
  const latest = useRef(options);
  latest.current = options;
  const blocked = () => latest.current.blocked();
  const site = useSite();
  const [tasks, updateTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadedScope, setLoadedScope] = useState("");
  const [queryError, setQueryError] = useState("");
  const tasksRef = useRef(tasks);
  const boardKey = useRef("");
  const scopeMonth = startMonth > 1 ? 2 : 1;
  const taskScope = `${teamId}:${year}:${scopeMonth}`;
  const taskScopeRef = useRef(taskScope);
  taskScopeRef.current = taskScope;
  const ready = loaded && (copy || loadedScope === taskScope);
  const bootJsonRef = useRef("");
  const mutationEpoch = useRef(0);
  const remoteEpoch = useRef(0);
  const cellEventCursor = useRef<string | null>(null);
  useEffect(() => {
    bootJsonRef.current = JSON.stringify(boot);
  }, [boot]);
  function setTasks(next: SetStateAction<Task[]>) {
    tasksRef.current =
      typeof next === "function" ? next(tasksRef.current) : next;
    updateTasks(tasksRef.current);
  }
  const queryPolicy = queryPolicyFor(site);
  const querySchedule = useRef({ nextPollAt: 0, retryAt: 0, failures: 0 });
  const queryGeneration = useRef(0);
  const refreshWork = useRef<{
    scope: string;
    epoch: number;
    remote: number;
    generation: number;
    controller: AbortController;
    consumers: Set<object>;
    promise: Promise<boolean | undefined>;
  } | null>(null);
  function querySucceeded() {
    querySchedule.current = {
      nextPollAt: Date.now() + queryPolicy.pollMs,
      retryAt: 0,
      failures: 0,
    };
    // Read recovery must never dismiss a failed save or another action's error.
    setQueryError("");
  }
  function queryFailed(failure: Error) {
    const schedule = querySchedule.current;
    schedule.failures++;
    const delay = queryPolicy.retryDelay(
      schedule.failures,
      failure instanceof ApiError ? failure : {},
    );
    schedule.retryAt = Date.now() + delay;
    schedule.nextPollAt = schedule.retryAt;
    setQueryError(failure.message);
  }
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!teamId || signal?.aborted) return true;
      if (Date.now() < querySchedule.current.retryAt) return false;
      if (blocked()) return false;
      const key = `${teamId}:${year}`,
        scope = taskScopeRef.current,
        epoch = mutationEpoch.current,
        remote = remoteEpoch.current,
        generation = queryGeneration.current;
      const existing = refreshWork.current;
      if (
        existing?.scope === scope &&
        existing.epoch === epoch &&
        existing.remote === remote &&
        existing.generation === generation &&
        !existing.controller.signal.aborted
      )
        return joinQuery(existing, signal);
      const work = {
        scope,
        epoch,
        remote,
        generation,
        controller: new AbortController(),
        consumers: new Set<object>(),
        promise: null! as Promise<boolean | undefined>,
      };
      work.promise = (async () => {
        try {
          // Consumers share one read until all subscriptions have left. Scope
          // and mutation guards below prevent late responses replacing new data.
          const [r, latestBoot] = await Promise.all([
            api(taskQuery(teamId, year, latest.current.startMonth), {
              signal: work.controller.signal,
            }),
            api<Bootstrap>("/bootstrap", { signal: work.controller.signal }),
          ]);
          if (
            !work.controller.signal.aborted &&
            boardKey.current === key &&
            taskScopeRef.current === scope &&
            generation === queryGeneration.current &&
            epoch === mutationEpoch.current &&
            remote === remoteEpoch.current &&
            !blocked()
          ) {
            setTasks(r.tasks);
            if (!cellEventCursor.current)
              cellEventCursor.current = r.cellEventId;
            setLoadedScope(scope);
            querySucceeded();
            // 바뀐 게 없으면 그대로 둔다. 새 객체를 넘기면 표 전체가 다시 그려진다.
            if (JSON.stringify(latestBoot) !== bootJsonRef.current)
              onBootstrap(latestBoot);
            return true;
          }
          return false;
        } catch (e) {
          if (
            work.controller.signal.aborted ||
            generation !== queryGeneration.current ||
            boardKey.current !== key ||
            taskScopeRef.current !== scope ||
            epoch !== mutationEpoch.current ||
            remote !== remoteEpoch.current
          )
            return;
          if (e instanceof ApiError && [403, 404].includes(e.status)) {
            try {
              const latest = await api<Bootstrap>("/bootstrap", {
                signal: work.controller.signal,
              });
              if (
                !work.controller.signal.aborted &&
                boardKey.current === key &&
                generation === queryGeneration.current &&
                !latest.teams.some((t) => t.id === teamId)
              ) {
                onBootstrap(latest);
                return;
              }
            } catch {}
          }
          if (
            work.controller.signal.aborted ||
            boardKey.current !== key ||
            taskScopeRef.current !== scope ||
            generation !== queryGeneration.current
          )
            return;
          queryFailed(e as Error);
          return false;
        }
      })().finally(() => {
        if (refreshWork.current === work) refreshWork.current = null;
      });
      refreshWork.current = work;
      return joinQuery(work, signal);
    },
    [teamId, year, queryPolicy],
  );
  useEffect(() => {
    queryGeneration.current++;
    refreshWork.current?.controller.abort();
    refreshWork.current = null;
    boardKey.current = available ? `${teamId}:${year}` : "";
    cellEventCursor.current = null;
    setLoadedScope("");
    setLoaded(false);
    setTasks([]);
    setQueryError("");
    querySchedule.current = { nextPollAt: 0, retryAt: 0, failures: 0 };
    return () => {
      boardKey.current = "";
      queryGeneration.current++;
      refreshWork.current?.controller.abort();
      refreshWork.current = null;
    };
  }, [teamId, year, available]);

  useEffect(() => {
    if (
      !loaded ||
      copy ||
      viewYear !== year ||
      !loadedScope.startsWith(`${teamId}:${year}:`) ||
      loadedScope === taskScope
    )
      return;
    let cancelled = false;
    queryGeneration.current++;
    refreshWork.current?.controller.abort();
    refreshWork.current = null;
    cellEventCursor.current = null;
    latest.current.onScopeChange();
    setQueryError("");
    querySchedule.current = { nextPollAt: 0, retryAt: 0, failures: 0 };
    api(taskQuery(teamId, year, scopeMonth))
      .then((r) => {
        if (cancelled || taskScopeRef.current !== taskScope) return;

        setTasks(r.tasks);
        cellEventCursor.current = r.cellEventId;
        setLoadedScope(taskScope);
        querySucceeded();
      })
      .catch((e) => {
        if (!cancelled && taskScopeRef.current === taskScope) queryFailed(e);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, year, scopeMonth, loaded, copy]);
  useEffect(() => {
    if (!active || !ready || copy || !cellEventCursor.current) return;
    const key = `${teamId}:${year}`;
    return subscribeCellChanges({
      teamId,
      year,
      startMonth: scopeMonth,
      cursor: cellEventCursor.current,
      onActivity: () => {
        remoteEpoch.current++;
      },
      onChanges: (changes) => {
        if (boardKey.current !== key || taskScopeRef.current !== taskScope)
          return;
        const next = mergeCellUpdates(tasksRef.current, changes);

        setTasks(next);
        // Open documents linking to a renamed task show the new title.
        for (const cell of changes.cells)
          if (cell.key === "title")
            updateDocumentLinkTitle(
              { kind: "task", id: cell.taskId },
              String(cell.value),
            );
      },
      onSnapshot: (snapshot) => {
        if (boardKey.current !== key || taskScopeRef.current !== taskScope)
          return;
        const next = mergeSnapshotCells(tasksRef.current, snapshot);

        setTasks(next);
      },
      onAccessLost: () => {
        if (boardKey.current === key) void latest.current.onAccessLost();
      },
    });
  }, [teamId, year, scopeMonth, ready, copy, active]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        active &&
        loaded &&
        !copy &&
        !blocked() &&
        !refreshWork.current &&
        Date.now() >= querySchedule.current.nextPollAt &&
        document.visibilityState === "visible"
      )
        refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh, copy, active, loaded]);
  async function initialize(month: number, signal: AbortSignal) {
    const key = `${teamId}:${year}`;
    const generation = queryGeneration.current;
    const result = await api(taskQuery(teamId, year, month), { signal });
    if (
      signal.aborted ||
      boardKey.current !== key ||
      generation !== queryGeneration.current
    )
      return false;
    setTasks(result.tasks);
    cellEventCursor.current = result.cellEventId;
    setLoadedScope(`${key}:${month > 1 ? 2 : 1}`);
    querySucceeded();
    setLoaded(true);
    return true;
  }
  return {
    tasks,
    loaded,
    loadedScope,
    ready,
    taskScope,
    queryError,
    refresh,
    initialize,
    snapshot: () => tasksRef.current,
    replace: setTasks,
    invalidate() {
      mutationEpoch.current++;
    },
    currentScope: () => taskScopeRef.current,
    failInitial(error?: Error) {
      if (error) queryFailed(error);
      setLoaded(true);
    },
  };
}
