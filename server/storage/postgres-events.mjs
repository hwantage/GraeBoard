import { HttpError } from "../validation.mjs";
import { stringify } from "../../shared/compact.js";

// The response port is shared by a dedicated HTTP response and EventChannel.
// PostgreSQL admission/cursor/deltas come from the repository, while the host
// supplies its own session refresh and shutdown registration.
export async function subscribePostgresEvents({
  user,
  request,
  response,
  refreshUser,
  register,
  read: readBatch,
  pollMs = 250,
}) {
  let stopped = false,
    timer,
    lastWrite = Date.now(),
    cursor = String(request.get("Last-Event-ID") || request.query.after || "");
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  response.on("close", stop);
  const permissions = (current) =>
    JSON.stringify([
      current?.id,
      current?.systemRole,
      current?.teamIds,
      current?.teamRoles,
    ]);
  const read = async () => {
    let currentUser = await refreshUser();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (currentUser?.id !== user.id)
        throw new HttpError(401, "로그인이 변경되었습니다.");
      const batch = await readBatch(currentUser, cursor),
        latest = await refreshUser();
      // The asynchronous PG snapshot may finish after a Node membership/session
      // change. Re-admit against the latest cookie identity before emitting it.
      if (permissions(currentUser) === permissions(latest)) return batch;
      currentUser = latest;
    }
    throw new HttpError(403, "권한이 변경되었습니다. 다시 연결하세요.");
  };
  const first = await read();
  if (
    stopped ||
    response.destroyed ||
    response.writableEnded ||
    register?.(response) === false
  )
    return;
  response.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write("retry: 2000\n\n");
  const write = (event, payload, id) => {
    if (stopped || response.destroyed || response.writableEnded) return;
    if (response.writableLength > 1024 * 1024) {
      response.destroy();
      stop();
      return;
    }
    lastWrite = Date.now();
    response.write(
      `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${stringify(payload)}\n\n`,
    );
  };
  const deliver = (batch, initial = false) => {
    if (batch.reset) write("reset", {}, batch.cursor);
    else
      for (const event of batch.events) {
        if (
          new TextEncoder().encode(stringify(event.payload)).length >
          256 * 1024
        ) {
          write("reset", {}, batch.cursor);
          break;
        }
        write(event.event || "cells", event.payload, event.cursor);
      }
    if (
      initial ||
      (!batch.reset && !batch.events.length && batch.cursor !== cursor)
    )
      write("ready", {}, batch.cursor);
    cursor = batch.cursor;
  };
  deliver(first, true);
  const poll = async () => {
    if (stopped) return;
    try {
      deliver(await read());
      if (!stopped && Date.now() - lastWrite >= 15000) {
        response.write(": keep-alive\n\n");
        lastWrite = Date.now();
      }
    } catch (error) {
      write(
        [401, 403, 404].includes(error.status) ? "access-revoked" : "rejected",
        { status: error.status || 503 },
      );
      response.end();
      stop();
      return;
    }
    if (!stopped) {
      timer = setTimeout(poll, pollMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(poll, pollMs);
  timer.unref?.();
  return stop;
}
