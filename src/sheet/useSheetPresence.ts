import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../platform/api";
import { EventStream } from "../platform/event-stream";
import type { Point } from "../types";

export type PresenceCell = {
  userId: string;
  name: string;
  color: string;
  taskId: string;
  key: string;
  editing: boolean;
};

// The server forgets a tab 30 to 45 seconds after it last heard from it.
const RESEND_MS = 10000;

function report(
  teamId: string,
  point: Point | null,
  editing: boolean,
  keepalive = false,
) {
  api("/presence", {
    method: "POST",
    keepalive,
    body: JSON.stringify({
      teamId,
      taskId: point?.taskId || null,
      key: point?.key || null,
      editing,
    }),
  }).catch(() => {});
}

export type PresenceStore = {
  teamId: string;
  subscribe: (listener: () => void) => () => void;
  cells: () => PresenceCell[];
  set: (cells: PresenceCell[]) => void;
};
const NO_CELLS: PresenceCell[] = [];
const noStore = () => () => {};

function createPresenceStore(teamId: string): PresenceStore {
  let cells = NO_CELLS;
  const listeners = new Set<() => void>();
  return {
    teamId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cells: () => cells,
    set(next) {
      cells = next;
      for (const listener of listeners) listener();
    },
  };
}

// The team's stream of other people's cells on the same internal server. The
// workspace keeps it open as long as the team's own stream, so moving between
// the annual sheet and insights does not reconnect the shared event stream.
// Positions live outside React state; only the Grid that draws them renders.
// The external server, a sheet copy and presentation pass a null team.
export function usePresenceStream(teamId: string | null) {
  const store = useMemo(
    () => (teamId ? createPresenceStore(teamId) : null),
    [teamId],
  );
  useEffect(() => {
    if (!store) return;
    const source = new EventStream(
      `/api/presence/events?teamId=${encodeURIComponent(store.teamId)}`,
    );
    source.addEventListener("presence", (event: MessageEvent) => {
      try {
        store.set(JSON.parse(event.data).cells || NO_CELLS);
      } catch {
        /* keep the last positions */
      }
    });
    source.addEventListener("access-revoked", () => store.set(NO_CELLS));
    return () => {
      source.close();
      store.set(NO_CELLS);
    };
  }, [store]);
  return store;
}

// Reports this tab's selected or editing cell while the sheet is shown, and
// returns where other people are. Only a hint for avoiding the same cell:
// nothing is saved.
export default function useSheetPresence(
  store: PresenceStore | null,
  point: Point | null,
  editing: boolean,
) {
  const cells = useSyncExternalStore(
    store?.subscribe ?? noStore,
    store?.cells ?? (() => NO_CELLS),
  );
  const teamId = store?.teamId;
  useEffect(() => {
    if (!teamId) return;
    const leave = () => report(teamId, null, false, true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [teamId]);
  const taskId = point?.taskId,
    key = point?.key;
  useEffect(() => {
    if (!teamId) return;
    const current = taskId && key ? { taskId, key } : null;
    const send = () => {
      if (document.visibilityState === "visible")
        report(teamId, current, editing);
    };
    // Arrow keys move fast; report where the selection settles.
    const settle = setTimeout(send, 150);
    const resend = setInterval(send, RESEND_MS);
    document.addEventListener("visibilitychange", send);
    return () => {
      clearTimeout(settle);
      clearInterval(resend);
      document.removeEventListener("visibilitychange", send);
    };
  }, [teamId, taskId, key, editing]);
  return cells;
}
