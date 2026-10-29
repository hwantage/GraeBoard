import { EventStream, retryableRejection } from "./event-stream";
import { api, ApiError, taskQuery } from "./api";
import { parseCompact } from "../shared/compact.js";
import type { Task } from "./types";
import type { CellUpdates, TaskSnapshot } from "./cell-updates.js";

export function subscribeCellChanges({
  teamId,
  year,
  startMonth = 1,
  cursor,
  onActivity,
  onChanges,
  onSnapshot,
  onAccessLost,
}: {
  teamId: string;
  year: number;
  startMonth?: number;
  cursor: string;
  onActivity: () => void;
  onChanges: (changes: CellUpdates) => void;
  onSnapshot: (tasks: Task[]) => void;
  onAccessLost: () => void;
}) {
  let stopped = false,
    recovering = false,
    retryDelay = 1000;
  let accessLost = false;
  let source: EventStream | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flush: ReturnType<typeof setTimeout> | undefined;
  let queued: CellUpdates[] = [];
  let queuedCells = 0;
  let queuedBytes = 0;
  const abort = new AbortController();
  function connect(after: string) {
    if (stopped) return;
    source = new EventStream(
      `/api/cells/events?${new URLSearchParams({ teamId, year: String(year), ...(startMonth > 1 ? { startMonth: "2" } : {}), after })}`,
    );
    source.addEventListener("cells", (event: MessageEvent) => {
      if (stopped || recovering) return;
      try {
        const update = parseCompact(event.data) as CellUpdates;
        onActivity();
        queuedCells += update.cells.length;
        queuedBytes += event.data.length * 2;
        if (queuedCells > 50000 || queuedBytes > 8 * 1024 * 1024) {
          void recover();
          return;
        }
        queued.push(update);
        // A burst of cell saves should cause one table update, not one per user.
        flush ??= setTimeout(() => {
          flush = undefined;
          const batch = queued;
          queued = [];
          queuedCells = 0;
          queuedBytes = 0;
          if (!stopped)
            onChanges({
              cells: batch.flatMap((update) => update.cells),
              taskMetadata: Object.assign(
                {},
                ...batch.map((update) => update.taskMetadata),
              ),
              updatedAt: Object.assign(
                {},
                ...batch.map((update) => update.updatedAt),
              ),
            });
        }, 40);
      } catch {
        void recover();
      }
    });
    source.addEventListener("ready", () => {
      if (!recovering) retryDelay = 1000;
    });
    source.addEventListener("rejected", (event: MessageEvent) => {
      if (retryableRejection(event.data)) {
        source?.close();
        scheduleRecovery();
      } else stop();
    });
    source.addEventListener("reset", () => void recover());
    source.addEventListener("access-revoked", () => {
      void recover();
    });
    source.onerror = () => {
      // The shared stream replays transient failures from its cursor. A rejected
      // HTTP connection (e.g. an expired session) needs a fresh authenticated GET.
      if (source?.readyState === EventSource.CLOSED) scheduleRecovery();
    };
  }
  function scheduleRecovery() {
    if (stopped || recovering || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void recover();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  async function recover() {
    if (stopped || recovering) return;
    recovering = true;
    source?.close();
    clearTimeout(flush);
    flush = undefined;
    queued = [];
    queuedCells = 0;
    queuedBytes = 0;
    try {
      const snapshot = await api<TaskSnapshot>(
        taskQuery(teamId, year, startMonth),
        { signal: abort.signal },
      );
      if (stopped) return;
      onActivity();
      onSnapshot(snapshot.tasks);
      recovering = false;
      accessLost = false;
      connect(snapshot.cellEventId);
    } catch (e) {
      recovering = false;
      if (stopped) return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        if (!accessLost) onAccessLost();
        accessLost = true;
        if (e.status !== 401) {
          stop();
          return;
        }
      }
      scheduleRecovery();
    }
  }
  function stop() {
    stopped = true;
    source?.close();
    clearTimeout(retry);
    clearTimeout(flush);
    queued = [];
    queuedCells = 0;
    queuedBytes = 0;
    abort.abort();
  }
  connect(cursor);
  return stop;
}
