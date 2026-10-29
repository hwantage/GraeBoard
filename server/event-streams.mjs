import { EventEmitter } from "node:events";
import { z } from "zod";
import { requireThat } from "../shared/validation.js";

const routes = new WeakMap();

// A broadcast uses the same frame for every subscriber. Cache only its latest
// envelope so large document bodies are not re-encoded once per connected user.
let cachedFrame, cachedEnvelope;
function envelope(frame) {
  if (frame === cachedFrame) return cachedEnvelope;
  cachedFrame = frame;
  cachedEnvelope = undefined;
  const event = frame.match(/^event: (.+)$/m)?.[1];
  if (event) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    const lastEventId = frame.match(/^id: (.*)$/m)?.[1];
    cachedEnvelope = JSON.stringify({ event, data, lastEventId }).slice(1);
  }
  return cachedEnvelope;
}

// Keep the individual endpoints and their authorization in one place. The
// multiplexed endpoint can dispatch only to these explicitly registered readers.
export function registerEventRoute(app, path, handler) {
  if (!routes.has(app)) routes.set(app, []);
  routes.get(app).push({ segments: path.split("/"), handler });
  app.get(path, handler);
}

const subscriptionsSchema = z
  .array(
    z
      .object({
        id: z.number().int().nonnegative(),
        path: z.string().max(1024).startsWith("/api/"),
        lastEventId: z.string().max(128).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(256);

// Adapt the existing hubs' SSE response interface without making internal HTTP
// requests. A channel's close releases its hub listeners and heartbeat timer.
class EventChannel extends EventEmitter {
  constructor(response, id) {
    super();
    this.response = response;
    this.id = id;
    this.closed = false;
    this.buffer = "";
  }
  get destroyed() {
    return this.closed || this.response.destroyed;
  }
  get writableEnded() {
    return this.closed || this.response.writableEnded;
  }
  get writableLength() {
    return this.response.writableLength;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const encoded = envelope(frame);
      if (encoded) {
        this.response.write(
          `event: stream\ndata: {"id":${this.id},${encoded}\n\n`,
        );
      } else if (frame.startsWith(":")) this.response.write(": keep-alive\n\n");
    }
    return this.writableLength < 1024 * 1024;
  }
  send(event, data) {
    if (!this.response.destroyed && !this.response.writableEnded)
      this.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  end(chunk) {
    if (this.closed) return;
    if (chunk) this.write(chunk);
    this.closed = true;
    this.buffer = "";
    this.send("closed", { id: this.id });
    this.emit("close");
    this.removeAllListeners();
  }
  destroy() {
    this.end();
  }
}

export function installEventStreams(app) {
  const subscribe = async (req, res) => {
    const parsed = subscriptionsSchema.safeParse(req.body?.streams);
    if (!parsed.success) {
      const rejectedIds = [
        ...new Set(
          parsed.error.issues
            .filter((issue) => typeof issue.path[0] === "number")
            .map((issue) => req.body.streams[issue.path[0]]?.id)
            .filter((id) => Number.isSafeInteger(id) && id >= 0),
        ),
      ];
      return res.status(400).json({
        error: "실시간 구독 형식이 올바르지 않습니다.",
        rejectedIds,
      });
    }
    const streams = parsed.data;
    requireThat(
      new Set(streams.map((s) => s.id)).size === streams.length,
      400,
      "실시간 구독 ID가 중복되었습니다.",
    );
    const rejectedIds = [];
    const subscriptions = streams.flatMap((stream) => {
      try {
        const url = new URL(stream.path, "http://events.local");
        const segments = url.pathname.split("/");
        const route = (routes.get(app) || []).find(
          (candidate) =>
            candidate.segments.length === segments.length &&
            candidate.segments.every(
              (part, i) => part.startsWith(":") || part === segments[i],
            ),
        );
        requireThat(
          url.origin === "http://events.local" && !url.hash && route,
          400,
          "지원하지 않는 실시간 구독입니다.",
        );
        const params = {};
        route.segments.forEach((part, i) => {
          if (part.startsWith(":")) {
            try {
              params[part.slice(1)] = decodeURIComponent(segments[i]);
            } catch {
              requireThat(false, 400, "지원하지 않는 실시간 구독입니다.");
            }
          }
        });
        const overrides = {
          params,
          path: url.pathname,
          url: stream.path,
          query: Object.fromEntries(url.searchParams),
          get: (name) =>
            name.toLowerCase() === "last-event-id"
              ? stream.lastEventId
              : req.get(name),
        };
        return [
          {
            stream,
            handler: route.handler,
            request: Object.create(
              req,
              Object.fromEntries(
                Object.entries(overrides).map(([name, value]) => [
                  name,
                  {
                    value,
                    writable: true,
                    configurable: true,
                    enumerable: true,
                  },
                ]),
              ),
            ),
          },
        ];
      } catch (error) {
        if (error.status !== 400) throw error;
        rejectedIds.push(stream.id);
        return [];
      }
    });
    if (rejectedIds.length)
      return res.status(400).json({
        error: "지원하지 않는 실시간 구독입니다.",
        rejectedIds,
      });
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const channels = subscriptions.map(
      ({ stream }) => new EventChannel(res, stream.id),
    );
    for (const channel of channels)
      channel.once("close", () => {
        if (
          channels.every((item) => item.closed) &&
          !res.destroyed &&
          !res.writableEnded
        )
          res.end();
      });
    res.on("close", () => channels.forEach((channel) => channel.end()));
    for (const [index, subscription] of subscriptions.entries()) {
      if (res.destroyed || res.writableEnded) return;
      const channel = channels[index];
      try {
        await subscription.handler(subscription.request, channel);
      } catch (error) {
        // Denied/deleted channels must not expose snapshots, even when another
        // channel in this connection is authorized. Handler rejection terminates
        // only this channel; transport failures are retried by the broker.
        if ([401, 403, 404].includes(error.status))
          channel.write(
            `event: access-revoked\ndata: ${JSON.stringify({ status: error.status })}\n\n`,
          );
        else
          channel.write(
            `event: rejected\ndata: ${JSON.stringify({
              status: error instanceof z.ZodError ? 400 : error.status || 500,
            })}\n\n`,
          );
        channel.end();
      }
      // Initial snapshots from many tabs can exceed the hubs' slow-reader
      // limit if written in one synchronous burst. Drain before the next one.
      if (res.writableNeedDrain && !res.destroyed && !res.writableEnded)
        await new Promise((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
    }
  };
  app.post("/api/events", subscribe);
}
