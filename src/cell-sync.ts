import { api, ApiError, taskQuery } from "./api";
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
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flush: ReturnType<typeof setTimeout> | undefined;
  let queued: CellUpdates[] = [];
  let queuedCells = 0;
  let queuedBytes = 0;
  const abort = new AbortController();
  function connect(after: string) {
    if (stopped) return;
    source = new EventSource(
      `/api/cells/events?${new URLSearchParams({ teamId, year: String(year), ...(startMonth > 1 ? { startMonth: "2" } : {}), after })}`,
    );
    source.addEventListener("cells", (event: MessageEvent) => {
      if (stopped || recovering) return;
      try {
        const update = JSON.parse(event.data) as CellUpdates;
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
    source.addEventListener("reset", () => void recover());
    source.addEventListener("access-revoked", () => {
      void recover();
    });
    source.onerror = () => {
      // EventSource reconnects transient failures with Last-Event-ID. A rejected
      // HTTP connection (e.g. an expired session) needs a fresh authenticated GET.
      if (source?.readyState === EventSource.CLOSED) void recover();
    };
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
      retryDelay = 1000;
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
      retry = setTimeout(() => void recover(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
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
