export type StreamSubscription = {
  id: number;
  path: string;
  lastEventId: string;
};
export type StreamMessage =
  | {
      kind: "event";
      id: number;
      event: string;
      data: string;
      lastEventId: string;
    }
  | { kind: "state"; id: number; readyState: number; error?: boolean };
type Subscriber = {
  send: (message: StreamMessage) => void;
  streams: Map<number, StreamSubscription & { key: string }>;
};
type Channel = {
  id: number;
  path: string;
  lastEventId: string;
  readyState: number;
  retryAt: number;
  retryDelay: number;
  rejected?: boolean;
  termination?: "subscription" | "session";
  listeners: Map<Subscriber, number[]>;
};

export function streamErrorStatus(data: string) {
  try {
    return Number(JSON.parse(data).status) || 403;
  } catch {
    return 403;
  }
}
export function retryableRejection(data: string) {
  return streamErrorStatus(data) >= 500;
}

function subscription(value: StreamSubscription) {
  const url = new URL(value.path, "http://streams.local");
  const lastEventId = value.lastEventId || url.searchParams.get("after") || "";
  url.searchParams.delete("after");
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return {
    ...value,
    lastEventId,
    key: url.pathname + (query ? `?${query}` : ""),
  };
}
function earlierCursor(current: string, incoming: string) {
  if (current === incoming) return current;
  const [epoch, sequence] = current.split(":");
  const [otherEpoch, otherSequence] = incoming.split(":");
  // Different server generations (or no cursor) request an authoritative reset.
  if (
    epoch !== otherEpoch ||
    !/^\d+$/.test(sequence || "") ||
    !/^\d+$/.test(otherSequence || "")
  )
    return "";
  return Number(sequence) <= Number(otherSequence) ? current : incoming;
}
function atOrAfter(current: string, incoming: string) {
  return (
    !!current && !!incoming && earlierCursor(current, incoming) === incoming
  );
}

// Shared by the worker and the per-page fallback. No document snapshots are
// cached: every new subscriber gets a fresh, authorized server snapshot/replay.
export class StreamBroker {
  private clients = new Set<Subscriber>();
  private channels = new Map<string, Channel>();
  private nextId = 0;
  private request?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private channelRetry?: ReturnType<typeof setTimeout>;
  private retryDelay = 1500;
  private retryAt = 0;

  attach(send: Subscriber["send"]) {
    const client: Subscriber = { send, streams: new Map() };
    this.clients.add(client);
    return {
      update: (streams: StreamSubscription[]) => {
        if (!this.clients.has(client)) return;
        const previous = client.streams;
        client.streams = new Map(
          streams.map((stream) => {
            const value = subscription(stream);
            const old = previous.get(stream.id);
            // A page's sync may be queued behind events already sent by the worker.
            if (old?.key === value.key) value.lastEventId = old.lastEventId;
            return [stream.id, value];
          }),
        );
        this.rebuild(client, previous);
      },
      resume: () => {
        if (!this.clients.has(client)) return;
        this.rebuild(undefined, undefined, true);
        // The caller set its local streams to CONNECTING. Restore their actual
        // states even when there were no session-closed channels to reopen.
        for (const [id, stream] of client.streams) {
          const channel = this.channels.get(stream.key)!;
          client.send({ kind: "state", id, readyState: channel.readyState });
        }
      },
      close: () => {
        if (!this.clients.delete(client)) return;
        this.rebuild();
      },
    };
  }
  private rebuild(
    changed?: Subscriber,
    previous = new Map<number, ReturnType<typeof subscription>>(),
    resumeSession = false,
  ) {
    const before = new Map(
      [...this.channels]
        .filter(([, channel]) => channel.readyState !== 2)
        .map(([key, channel]) => [key, channel.lastEventId]),
    );
    const channels = new Map<string, Channel>();
    // A login retry can add a cell stream while other tabs still hold session-
    // closed resources. Reauthorize those together, not invalid subscriptions.
    const rejoined =
      changed &&
      [...changed.streams.values()].some(
        (stream) => previous.get(stream.id)?.key !== stream.key,
      );
    let resumedSession = false;
    const joined: { client: Subscriber; id: number; channel: Channel }[] = [];
    for (const client of this.clients)
      for (const stream of client.streams.values()) {
        let channel = channels.get(stream.key);
        if (!channel) {
          const old = this.channels.get(stream.key);
          const resume =
            (resumeSession || rejoined) && old?.termination === "session";
          resumedSession ||= !!resume;
          channel = (resume ? undefined : old) || {
            id: ++this.nextId,
            path: stream.key,
            lastEventId: old?.lastEventId || stream.lastEventId,
            readyState: 0,
            retryAt: 0,
            retryDelay: 1500,
            listeners: new Map(),
          };
          channel.listeners = new Map();
          channels.set(stream.key, channel);
        }
        if (client === changed && previous.get(stream.id)?.key !== stream.key) {
          channel.lastEventId = earlierCursor(
            channel.lastEventId,
            stream.lastEventId,
          );
          joined.push({ client, id: stream.id, channel });
        }
        const ids = channel.listeners.get(client) || [];
        ids.push(stream.id);
        channel.listeners.set(client, ids);
      }
    this.channels = channels;
    if (resumedSession) {
      this.retryAt = 0;
      this.retryDelay = 1500;
    }
    const active = [...channels.values()].filter(
      (channel) => channel.readyState !== 2,
    );
    if (
      before.size !== active.length ||
      active.some((channel) => before.get(channel.path) !== channel.lastEventId)
    ) {
      // During a partial close, apply subscription changes at the retry time.
      // An older cursor still needs an immediate stop: live events must not
      // advance a newly joined listener past the replay it has yet to receive.
      const keepRequest =
        !!(this.retry || this.channelRetry) &&
        !!this.request &&
        !resumedSession &&
        active.every(
          (channel) =>
            !before.has(channel.path) ||
            before.get(channel.path) === channel.lastEventId,
        );
      this.schedule(10, keepRequest);
    }
    this.scheduleChannelRetry();
    for (const { client, id, channel } of joined)
      client.send({
        kind: "state",
        id,
        readyState: channel.readyState,
        error: channel.readyState === 2,
      });
  }
  private deliver(
    channel: Channel,
    message:
      | Omit<Extract<StreamMessage, { kind: "event" }>, "id">
      | Omit<Extract<StreamMessage, { kind: "state" }>, "id">,
  ) {
    for (const [client, ids] of [...channel.listeners])
      for (const id of ids)
        if (this.clients.has(client)) {
          const stream = client.streams.get(id);
          if (stream?.key !== channel.path) continue;
          if (message.kind === "event") {
            const caughtUp = atOrAfter(stream.lastEventId, message.lastEventId);
            if (
              caughtUp &&
              ["cells", "document", "reset"].includes(message.event)
            )
              continue;
            if (!caughtUp) stream.lastEventId = message.lastEventId;
            client.send({ ...message, id, lastEventId: stream.lastEventId });
          } else client.send({ ...message, id });
        }
  }
  private state(
    readyState: number,
    error = false,
    channels = this.channels.values(),
  ) {
    for (const channel of [...channels]) {
      if (channel.readyState === 2) continue;
      channel.readyState = readyState;
      this.deliver(channel, { kind: "state", readyState, error });
    }
  }
  private closeChannel(
    channel: Channel,
    termination: Channel["termination"] = "subscription",
  ) {
    if (channel.readyState === 2) return;
    channel.termination = termination;
    channel.readyState = 2;
    this.deliver(channel, { kind: "state", readyState: 2, error: true });
  }
  private failed(keepRequest = false) {
    // Several channels may close in one chunk, followed by EOF. Count that as
    // one failure, and keep reading healthy channels until the retry is due.
    if (this.retryAt <= Date.now()) {
      const delay = this.retryDelay;
      this.retryDelay = Math.min(delay * 2, 30000);
      this.retryAt = Date.now() + delay;
    }
    this.schedule(0, keepRequest);
    if (!keepRequest) this.state(0, true);
  }
  private stopRequest() {
    this.request?.abort();
    this.request = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
  }
  private scheduleChannelRetry() {
    clearTimeout(this.channelRetry);
    this.channelRetry = undefined;
    const deadlines = [...this.channels.values()]
      .filter(
        (channel) => channel.readyState !== 2 && channel.retryAt > Date.now(),
      )
      .map((channel) => channel.retryAt);
    if (deadlines.length)
      this.channelRetry = setTimeout(
        () => {
          this.channelRetry = undefined;
          // A transport retry or subscription update already reconnects when due.
          if (!this.retry) this.schedule(0);
        },
        Math.min(...deadlines) - Date.now(),
      );
  }
  private schedule(delay = 10, keepRequest = false) {
    const active = [...this.channels.values()].some(
      (channel) => channel.readyState !== 2,
    );
    if (keepRequest && active) clearTimeout(this.retry);
    else {
      this.stopRequest();
      this.state(0);
    }
    if (active)
      this.retry = setTimeout(
        () => {
          this.stopRequest();
          void this.connect();
        },
        Math.max(delay, this.retryAt - Date.now()),
      );
    else {
      this.retryAt = 0;
      this.retryDelay = 1500;
    }
  }
  private async connect() {
    this.retry = undefined;
    const channels = new Map(
      [...this.channels.values()]
        .filter(
          (channel) =>
            channel.readyState !== 2 && channel.retryAt <= Date.now(),
        )
        .map((channel) => [channel.id, channel]),
    );
    this.scheduleChannelRetry();
    if (!channels.size) return;
    const request = new AbortController();
    this.request = request;
    for (const channel of channels.values()) channel.rejected = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const refreshDeadline = () => {
      clearTimeout(idle);
      // Some proxies leave the downstream response open after upstream loss.
      // Three missed 15-second heartbeats must also trigger cursor recovery.
      idle = setTimeout(() => {
        if (this.request !== request) return;
        this.failed();
      }, 45000);
    };
    try {
      refreshDeadline();
      // POST avoids URL/header-size limits when many tabs watch different docs.
      const response = await fetch("/api/events", {
        method: "POST",
        credentials: "same-origin",
        signal: request.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
        },
        body: JSON.stringify({
          streams: [...channels.values()].map(({ id, path, lastEventId }) => ({
            id,
            path,
            lastEventId,
          })),
        }),
      });
      if (request.signal.aborted) return;
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        if (response.status === 400) {
          const rejected = await response.json().catch(() => null);
          let removed = false;
          for (const id of Array.isArray(rejected?.rejectedIds)
            ? rejected.rejectedIds
            : []) {
            const channel = channels.get(id);
            if (!channel) continue;
            removed = true;
            this.deliver(channel, {
              kind: "event",
              event: "rejected",
              data: JSON.stringify({ status: 400 }),
              lastEventId: channel.lastEventId,
            });
            this.closeChannel(channel);
          }
          if (removed) {
            // A bad subscription is not a transport failure for healthy ones.
            this.schedule(0);
            return;
          }
        } else await response.body?.cancel();
        if (response.status === 401) {
          this.stopRequest();
          for (const channel of this.channels.values())
            this.closeChannel(channel, "session");
          this.scheduleChannelRetry();
          return;
        }
        throw new Error("Stream unavailable");
      }
      this.state(1, false, channels.values());
      const connectedAt = Date.now();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!request.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!this.retry && Date.now() - connectedAt >= 15000) {
          this.retryDelay = 1500;
          this.retryAt = 0;
        }
        if (Date.now() - connectedAt >= 15000)
          for (const channel of channels.values()) {
            channel.retryAt = 0;
            channel.retryDelay = 1500;
          }
        refreshDeadline();
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4 * 1024 * 1024)
          throw new Error("Stream frame too large");
        let end;
        while (
          !request.signal.aborted &&
          (end = buffer.indexOf("\n\n")) !== -1
        ) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          if (!event) continue;
          const message = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "{}");
          const channel = channels.get(message.id);
          if (
            !channel ||
            channel.readyState === 2 ||
            this.channels.get(channel.path) !== channel
          )
            continue;
          if (event === "closed") {
            channels.delete(channel.id);
            if (channel.termination)
              this.closeChannel(channel, channel.termination);
            else {
              channel.readyState = 0;
              this.deliver(channel, {
                kind: "state",
                readyState: 0,
                error: true,
              });
              if (channel.rejected) {
                channel.retryAt = Date.now() + channel.retryDelay;
                channel.retryDelay = Math.min(channel.retryDelay * 2, 30000);
                this.scheduleChannelRetry();
              } else this.failed(true);
            }
            continue;
          }
          if (event !== "stream") continue;
          if (message.event === "access-revoked")
            channel.termination =
              streamErrorStatus(message.data) === 401
                ? "session"
                : "subscription";
          else if (message.event === "rejected") {
            channel.rejected = retryableRejection(message.data);
            if (!channel.rejected) channel.termination = "subscription";
          }
          if (message.lastEventId !== undefined)
            channel.lastEventId = message.lastEventId;
          this.deliver(channel, {
            kind: "event",
            event: message.event,
            data: message.data,
            lastEventId: channel.lastEventId,
          });
        }
      }
    } catch {
      // Transport failures reconnect from the last delivered cursor. The server
      // decides whether replay or a full snapshot is needed, as before.
    } finally {
      clearTimeout(idle);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (this.request === request && !request.signal.aborted) {
        // EOF after explicit per-channel closes is expected. Only a lost live
        // channel makes this a transport failure; 5xx deadlines stay separate.
        if (channels.size) this.failed();
        else this.request = undefined;
      }
    }
  }
}
