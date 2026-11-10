import { useEffect, useRef, useState } from "react";
import {
  api,
  send,
  serverNow,
  type ApiError,
  taskQuery,
} from "../platform/api";
import type { BatchResult, CellChange, FormatChange, Task } from "../types";

export type CellFailure = {
  payload: {
    operationId: string;
    createdAt: string;
    changes: CellChange[];
    format?: FormatChange;
  };
  error: ApiError | Error;
  mode: "normal" | "undo" | "redo";
};

// One busy state for original-sheet commands, plus retained cell requests.
// Replaying a failed delivery preserves its ID; explicit conflict overwrite
// creates a new request against freshly read versions.
export default function useSheetOperations(options: {
  teamId: string;
  year: number;
  startMonth: number;
  onStart: () => void;
  onSnapshot: (tasks: Task[]) => void;
  onResult: (
    result: BatchResult,
    mode: CellFailure["mode"],
    selected: number,
  ) => void;
  onSettled: () => void;
  onError: (message: string) => void;
}) {
  const { teamId, year } = options;
  const latest = useRef(options);
  latest.current = options;
  const scope = useRef({ teamId, year });
  if (scope.current.teamId !== teamId || scope.current.year !== year)
    scope.current = { teamId, year };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<CellFailure | null>(null);
  const pendingRef = useRef(0);
  const failedRef = useRef<CellFailure | null>(null);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    clearFailure();
  }, [teamId, year]);

  function clearFailure() {
    failedRef.current = null;
    setFailed(null);
  }
  function fail(failure: CellFailure) {
    failedRef.current = failure;
    setFailed(failure);
  }
  function begin() {
    latest.current.onStart();
    setPending(++pendingRef.current);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      setPending(--pendingRef.current);
    };
  }

  function submit(
    build: () => { changes: CellChange[]; format?: FormatChange },
    mode: CellFailure["mode"],
    selected: number,
  ) {
    if (failedRef.current || pendingRef.current) return false;
    const owner = scope.current;
    const current = () => mounted.current && scope.current === owner;
    const finish = begin();
    queue.current = queue.current.then(async () => {
      let payload: CellFailure["payload"] | null = null;
      try {
        if (!current() || failedRef.current) return;
        const { changes, format } = build();
        if (!changes.length && !format) return;
        payload = {
          operationId: crypto.randomUUID(),
          createdAt: serverNow(),
          changes,
          ...(format ? { format } : {}),
        };
        const result = await send<BatchResult>("/cells/batch", payload);
        if (current()) latest.current.onResult(result, mode, selected);
      } catch (error) {
        if (!current()) return;
        if (payload) fail({ payload, error: error as Error, mode });
        else latest.current.onError((error as Error).message);
      } finally {
        if (current()) latest.current.onSettled();
        finish();
      }
    });
    return true;
  }

  async function retry(overwrite: boolean, selected: number) {
    const failure = failedRef.current;
    if (!failure || pendingRef.current) return false;
    const owner = scope.current;
    const current = () => mounted.current && scope.current === owner;
    const finish = begin();
    let payload = failure.payload;
    try {
      if (overwrite) {
        const snapshot = await api<{ tasks: Task[] }>(
          taskQuery(teamId, year, latest.current.startMonth),
        );
        if (!current()) return false;
        const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
        latest.current.onSnapshot(snapshot.tasks);
        payload = {
          ...payload,
          operationId: crypto.randomUUID(),
          createdAt: serverNow(),
          changes: payload.changes.map((change) => ({
            ...change,
            expectedVersion:
              tasks.get(change.taskId)?.cells[change.key]?.version ?? 0,
            expectedFormatRevision:
              tasks.get(change.taskId)?.formatting?.revision ?? 0,
          })),
          ...(payload.format
            ? {
                format: {
                  ...payload.format,
                  expectedRevision:
                    snapshot.tasks[0]?.formatting?.revision ?? 0,
                  expectedTasks: Object.fromEntries(
                    snapshot.tasks.map((task) => [task.id, task.updatedAt]),
                  ),
                },
              }
            : {}),
        };
      }
      const result = await send<BatchResult>("/cells/batch", payload);
      if (!current()) return false;
      latest.current.onResult(result, failure.mode, selected);
      clearFailure();
      return true;
    } catch (error) {
      if (current()) fail({ ...failure, payload, error: error as Error });
      return false;
    } finally {
      finish();
    }
  }

  return {
    pending,
    failed,
    begin,
    submit,
    retry,
    clearFailure,
    isPending: () => pendingRef.current > 0,
    failure: () => failedRef.current,
  };
}
