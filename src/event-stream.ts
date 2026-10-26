import {
  StreamBroker,
  type StreamMessage,
  type StreamSubscription,
} from "./event-stream-broker";
export { retryableRejection, streamErrorStatus } from "./event-stream-broker";

const streams = new Map<number, EventStream>();
let nextId = 0;
let port: MessagePort | undefined;
let worker: SharedWorker | undefined;
let fallback: ReturnType<StreamBroker["attach"]> | undefined;
let unavailable = false;
let suspended = false;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let startup: ReturnType<typeof setTimeout> | undefined;
let health: ReturnType<typeof setInterval> | undefined;
let lastMessage = 0;
let resumePending = false;

function snapshot(): StreamSubscription[] {
  return [...streams.values()].map(({ id, path, lastEventId }) => ({
    id,
    path,
    lastEventId,
  }));
}
function receive(message: StreamMessage) {
  const stream = streams.get(message.id);
  if (!stream) return;
  if (message.kind === "event") {
    stream.lastEventId = message.lastEventId;
    stream.dispatch(message.event, message.data);
  } else {
    stream.readyState = message.readyState;
    if (message.error) stream.onerror?.();
  }
}
function disconnect() {
  clearTimeout(startup);
  clearInterval(health);
  startup = undefined;
  health = undefined;
  if (port) {
    port.postMessage({ kind: "disconnect" });
    port.close();
    port = undefined;
  }
  if (worker) worker.onerror = null;
  worker = undefined;
  fallback?.close();
  fallback = undefined;
}
function useFallback() {
  disconnect();
  unavailable = true;
  if (!suspended && (streams.size || resumePending)) {
    fallback = new StreamBroker().attach(receive);
    fallback.update(snapshot());
    sendResume();
  }
}
function sendResume() {
  if (!resumePending) return;
  if (fallback) {
    fallback.resume();
    resumePending = false;
    if (!streams.size) scheduleSync();
  } else port?.postMessage({ kind: "resume" });
}
export function resumeSession() {
  for (const stream of streams.values())
    stream.readyState = EventSource.CONNECTING;
  resumePending = true;
  // A login-only page also joins the shared worker long enough to notify the
  // other tabs. The acknowledgement releases that otherwise unused port.
  scheduleSync();
}
function sync() {
  syncTimer = undefined;
  if (suspended || (!streams.size && !resumePending)) {
    disconnect();
    return;
  }
  if (fallback) {
    fallback.update(snapshot());
    sendResume();
    return;
  }
  if (port) {
    port.postMessage({ kind: "sync", streams: snapshot() });
    sendResume();
    return;
  }
  if (unavailable || typeof SharedWorker === "undefined") {
    useFallback();
    return;
  }
  try {
    // URL identity shares this worker across tabs, while separating app builds.
    worker = new SharedWorker(
      new URL("./event-stream.worker.ts", import.meta.url),
      { type: "module" },
    );
    const current = worker.port;
    port = current;
    lastMessage = Date.now();
    let started = false;
    worker.onerror = (event) => {
      event.preventDefault();
      if (port !== current) return;
      if (!started) useFallback();
      else {
        disconnect();
        scheduleSync();
      }
    };
    current.onmessage = (event) => {
      if (port !== current) return;
      lastMessage = Date.now();
      const message = event.data;
      if (message.kind === "ready") {
        started = true;
        clearTimeout(startup);
        current.postMessage({ kind: "sync", streams: snapshot() });
        sendResume();
      } else if (message.kind === "resumed") {
        resumePending = false;
        if (!streams.size) scheduleSync();
      } else if (message.kind === "ping") current.postMessage({ kind: "pong" });
      else if (message.kind === "resubscribe") {
        disconnect();
        for (const stream of streams.values())
          stream.readyState = EventSource.CONNECTING;
        scheduleSync();
      } else if (message.kind !== "pong") {
        try {
          receive(message);
        } finally {
          current.postMessage({ kind: "ack", delivery: message.delivery });
        }
      }
    };
    current.onmessageerror = () => {
      if (port === current) useFallback();
    };
    current.start();
    startup = setTimeout(() => {
      if (port === current) useFallback();
    }, 10000);
    health = setInterval(() => {
      if (Date.now() - lastMessage > 45000) {
        disconnect();
        scheduleSync();
      } else current.postMessage({ kind: "ping" });
    }, 15000);
  } catch {
    useFallback();
  }
}
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 0);
}
window.addEventListener("pagehide", () => {
  suspended = true;
  disconnect();
});
window.addEventListener("pageshow", () => {
  suspended = false;
  scheduleSync();
});
window.addEventListener("online", () => {
  unavailable = false;
  disconnect();
  scheduleSync();
});
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    Date.now() - lastMessage > 45000
  ) {
    disconnect();
    scheduleSync();
  }
});

export class EventStream {
  readonly id = ++nextId;
  lastEventId = "";
  readyState: number = EventSource.CONNECTING;
  onerror: (() => void) | null = null;
  private target = new EventTarget();
  constructor(readonly path: string) {
    streams.set(this.id, this);
    scheduleSync();
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.target.addEventListener(type, listener as EventListener);
  }
  dispatch(type: string, data: string) {
    this.target.dispatchEvent(
      new MessageEvent(type, { data, lastEventId: this.lastEventId }),
    );
  }
  close() {
    if (!streams.delete(this.id)) return;
    this.readyState = EventSource.CLOSED;
    scheduleSync();
  }
}
