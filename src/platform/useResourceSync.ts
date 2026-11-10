import {
  EventStream,
  retryableRejection,
  streamErrorStatus,
} from "./event-stream";
import { clientId } from "./api";
import { useEffect, useRef } from "react";

// One stream per resource in this tab; callers coalesce bursts and defer while
// local writes are in flight. A reconnect invalidates only if its cursor changed.
const subscriptions = new Map<
  string,
  { source: EventStream; listeners: Set<(initial?: boolean) => void> }
>();
export default function useResourceSync(
  path: string | null,
  refresh: (signal: AbortSignal) => Promise<boolean>,
) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false,
      dirty = false;
    let delay = 150;
    const schedule = (initial = false) => {
      dirty = true;
      if (!running && !timer) timer = setTimeout(run, initial ? 0 : delay);
    };
    async function run() {
      timer = undefined;
      if (abort.signal.aborted) return;
      running = true;
      dirty = false;
      try {
        if (!(await latest.current(abort.signal))) dirty = true;
        delay = 150;
      } catch {
        dirty = true;
        delay = Math.min(Math.max(1000, delay * 2), 15000);
      } finally {
        running = false;
        if (dirty && !abort.signal.aborted) schedule();
      }
    }
    let subscription = subscriptions.get(path);
    const connected = !!subscription;
    if (!subscription) {
      const source = new EventStream(`/api${path}/events`);
      const listeners = new Set<(initial?: boolean) => void>();
      let initial = true;
      subscription = { source, listeners };
      subscriptions.set(path, subscription);
      source.addEventListener("document", (event: MessageEvent) => {
        try {
          if (JSON.parse(event.data).clientId === clientId) return;
        } catch {
          /* refetch malformed invalidations */
        }
        for (const listener of listeners) listener(initial);
        initial = false;
      });
      const denied = () => {
        source.close();
        for (const listener of listeners) listener();
      };
      source.addEventListener("access-revoked", (event: MessageEvent) => {
        // Keep the subscription so reauthentication in another tab revives it.
        if (streamErrorStatus(event.data) !== 401) denied();
      });
      source.addEventListener("rejected", (event: MessageEvent) => {
        if (!retryableRejection(event.data)) denied();
      });
    }
    subscription.listeners.add(schedule);
    // A late subscriber might have missed the stream's initial snapshot.
    if (connected) schedule(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
      subscription.listeners.delete(schedule);
      if (!subscription.listeners.size) {
        subscription.source.close();
        subscriptions.delete(path);
      }
    };
  }, [path]);
}
