import { useEffect, useState } from "react";
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

// Where other people on the same internal server have a sheet cell selected or
// open for editing. Only a hint for avoiding the same cell: nothing is saved,
// and the external server, a sheet copy or presentation pass a null team.
export default function useSheetPresence(
  teamId: string | null,
  point: Point | null,
  editing: boolean,
) {
  const [cells, setCells] = useState<PresenceCell[]>([]);
  useEffect(() => {
    if (!teamId) return;
    const source = new EventStream(
      `/api/presence/events?teamId=${encodeURIComponent(teamId)}`,
    );
    source.addEventListener("presence", (event: MessageEvent) => {
      try {
        setCells(JSON.parse(event.data).cells || []);
      } catch {
        /* keep the last positions */
      }
    });
    source.addEventListener("access-revoked", () => setCells([]));
    const leave = () => report(teamId, null, false, true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      source.close();
      setCells([]);
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
