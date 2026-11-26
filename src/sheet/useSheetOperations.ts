import { useEffect, useRef, useState } from "react";
import {
  api,
  send,
  serverNow,
  type ApiError,
  taskQuery,
} from "../platform/api";
import type { BatchResult, CellChange, FormatChange, Task } from "../types";
import {
  enqueue,
  project,
  rebase,
  request,
  watch,
  type QueuedChange,
} from "./cell-save-queue.js";

export type CellFailure = {
  payload: {
    operationId: string;
    createdAt: string;
    changes: CellChange[];
    format?: FormatChange;
  };
  error: ApiError | Error;
  mode: "normal" | "undo" | "redo";
  // Names the change for onResult (see submit).
  token?: string;
};

// One busy state for original-sheet commands, plus retained cell requests.
// Replaying a failed delivery preserves its ID; explicit conflict overwrite
// creates a new request against freshly read versions.
//
// Cell and format changes made while an earlier one is being saved wait in
// order. Each is built when it is made, from the sheet its author sees (see
// cell-save-queue.js): what it expects moves only past the author's own saved
// changes, so someone else's change made meanwhile is refused as a conflict.
// A failed save holds the changes behind it until the user settles it.
export default function useSheetOperations(options: {
  teamId: string;
  year: number;
  startMonth: number;
  onStart: () => void;
  onSnapshot: (tasks: Task[]) => void;
  // `token` names the change (see submit) when it had one.
  onResult: (
    result: BatchResult,
    mode: CellFailure["mode"],
    selected: number,
    token?: string,
  ) => void;
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
  // Whether a request is on its way, or a retry is preparing one. `pending`
  // also counts the changes waiting behind a failed save, which must not keep
  // the user from retrying or dismissing that failure.
  const [sending, setSending] = useState(false);
  const busy = useRef(0);
  async function busyWith<T>(work: () => Promise<T>) {
    if (busy.current++ === 0) setSending(true);
    try {
      return await work();
    } finally {
      if (--busy.current === 0 && mounted.current) setSending(false);
    }
  }
  const [failed, setFailed] = useState<CellFailure | null>(null);
  const pendingRef = useRef(0);
  const failedRef = useRef<CellFailure | null>(null);
  const queue = useRef(Promise.resolve());
  // The changes waiting or on their way, in order; `queued` shows them.
  const changes = useRef<QueuedChange[]>([]);
  const [queued, setQueued] = useState<QueuedChange[]>([]);
  const nextId = useRef(1);
  function publish(next: QueuedChange[]) {
    changes.current = next;
    setQueued(next);
  }
  // What the open cell editor saw (see watchCell).
  const editorWatch = useRef<QueuedChange | null>(null);
  // Moves the queued changes and the editor's expectation together.
  function move(next: (waiting: QueuedChange[]) => QueuedChange[]) {
    publish(next(changes.current));
    if (editorWatch.current)
      [editorWatch.current] = next([editorWatch.current]);
  }
  // Changes waiting behind a failed save, released when it is settled.
  const held = useRef<(() => void)[]>([]);
  useEffect(() => {
    clearFailure({ discard: true });
  }, [teamId, year]);

  // `discard` drops the changes waiting behind the failure instead of
  // sending them: they were made on top of input the user throws away, or on
  // a sheet that is gone.
  function clearFailure({ discard = false } = {}) {
    failedRef.current = null;
    setFailed(null);
    if (discard) publish([]);
    for (const resume of held.current.splice(0)) resume();
  }
  function fail(failure: CellFailure) {
    failedRef.current = failure;
    setFailed(failure);
  }
  // Row commands and the task panel save outside the queue, and a format
  // undo/redo restores a recorded state the sheet cannot show before its
  // result (see project): cell changes are refused until they finish (see
  // isRowPending).
  const rowPendingRef = useRef(0);
  function begin(kind: "row" | "cell" = "row") {
    latest.current.onStart();
    setPending(++pendingRef.current);
    if (kind === "row") rowPendingRef.current++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (kind === "row") rowPendingRef.current--;
      setPending(--pendingRef.current);
    };
  }
  // An own change saved: the changes behind it move past it.
  function settle(id: number, result: BatchResult) {
    move((waiting) =>
      rebase(
        waiting.filter((change) => change.id !== id),
        result,
      ),
    );
  }

  // Opening the cell editor: an edit committed in it expects what was shown
  // then, moved only past own saves (cell-save-queue.js).
  function watchCell(taskId: string, key: string, version: number) {
    editorWatch.current = watch(taskId, key, version);
  }

  // `build` runs now, on the sheet as the author sees it (see project).
  // `token` is handed back to onResult when this change is saved; `editor`
  // marks the edit committed in the watched cell editor (see watchCell).
  function submit(
    build: () => { changes: CellChange[]; format?: FormatChange },
    mode: CellFailure["mode"],
    selected: number,
    { token, editor = false }: { token?: string; editor?: boolean } = {},
  ) {
    if (failedRef.current) return false;
    let built: ReturnType<typeof build>;
    try {
      built = build();
    } catch (error) {
      latest.current.onError((error as Error).message);
      return false;
    }
    if (!built.changes.length && !built.format) return true;
    const owner = scope.current;
    const current = () => mounted.current && scope.current === owner;
    const change = enqueue(
      {
        operationId: crypto.randomUUID(),
        createdAt: serverNow(),
        changes: built.changes,
        ...(built.format ? { format: built.format } : {}),
      },
      nextId.current++,
      editor ? editorWatch.current?.bases : undefined,
    );
    if (editor) editorWatch.current = null;
    publish([...changes.current, change]);
    const finish = begin(built.format?.restore ? "row" : "cell");
    queue.current = queue.current.then(async () => {
      let payload: CellFailure["payload"] | null = null;
      try {
        // The save before this one failed while this one waited: wait until
        // the user retries or dismisses it.
        while (current() && failedRef.current)
          await new Promise<void>((resume) => held.current.push(resume));
        const waiting = changes.current.find((c) => c.id === change.id);
        if (!current() || !waiting) return;
        payload = request(waiting, serverNow());
        const sent = payload;
        const result = await busyWith(() =>
          send<BatchResult>("/cells/batch", sent),
        );
        if (!current()) return;
        settle(change.id, result);
        latest.current.onResult(result, mode, selected, token);
      } catch (error) {
        if (!current()) return;
        if (!payload) {
          latest.current.onError((error as Error).message);
          return;
        }
        // Its input moves to the failure; the changes behind it wait.
        publish(changes.current.filter((c) => c.id !== change.id));
        fail({ payload, error: error as Error, mode, token });
      } finally {
        finish();
      }
    });
    return true;
  }

  async function retry(overwrite: boolean, selected: number) {
    const failure = failedRef.current;
    if (!failure || busy.current) return false;
    const owner = scope.current;
    const current = () => mounted.current && scope.current === owner;
    const finish = begin("cell");
    let payload = failure.payload;
    try {
      return await busyWith(async () => {
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
        const sent = payload;
        const result = await send<BatchResult>("/cells/batch", sent);
        if (!current()) return false;
        // Saved as it was made, the changes on top of it follow it. Forced
        // over someone else's change, they do not: what it replaced is not
        // what they saw, so they still conflict (cell-save-queue.js).
        move((waiting) => rebase(waiting, result));
        latest.current.onResult(result, failure.mode, selected, failure.token);
        clearFailure();
        return true;
      });
    } catch (error) {
      if (current()) fail({ ...failure, payload, error: error as Error });
      return false;
    } finally {
      finish();
    }
  }

  return {
    pending,
    sending,
    failed,
    queued,
    begin,
    submit,
    retry,
    clearFailure,
    watchCell,
    // Settles once every change queued so far is done.
    idle: () => queue.current,
    isRowPending: () => rowPendingRef.current > 0,
    // The sheet with the queued changes applied, as the author sees it.
    project: (tasks: Task[]) => project(tasks, changes.current),
    isPending: () => pendingRef.current > 0,
    failure: () => failedRef.current,
  };
}
