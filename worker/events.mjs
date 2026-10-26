import { PostgresTaskRepository } from "../server/storage/postgres-tasks.mjs";
import { periodScopeSchema } from "../server/validation.mjs";
import { stringify } from "../shared/compact.js";
import { assert } from "./access.mjs";
import { authenticate } from "./control.mjs";
import { documentScope, documentRoutes } from "./documents.mjs";
const encoder = new TextEncoder();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function eventResponse(
  ctx,
  streams,
  { multiplex = true, pollMs = 1000, lifetimeMs = 60000 } = {},
) {
  assert(
    Array.isArray(streams) &&
      streams.length > 0 &&
      streams.length <= 256 &&
      new Set(streams.map((s) => s.id)).size === streams.length,
    400,
    "구독 목록을 확인하세요.",
  );
  const channels = [];
  for (const item of streams) {
    assert(
      Number.isInteger(item.id) &&
        item.id >= 0 &&
        typeof item.path === "string" &&
        item.path.length <= 1024 &&
        item.path.startsWith("/api/") &&
        !item.path.startsWith("//"),
      400,
      "구독 경로를 확인하세요.",
    );
    const url = new URL(item.path, ctx.env.APP_ORIGIN);
    assert(
      url.origin === ctx.env.APP_ORIGIN && url.pathname.endsWith("/events"),
      400,
      "구독 경로를 확인하세요.",
    );
    const path = url.pathname.slice(4, -7);
    let teamId,
      type = "resource";
    if (path === "/cells") {
      teamId = url.searchParams.get("teamId");
      type = "cells";
      await ctx.team(teamId);
      periodScopeSchema.parse({
        year: new Date().getFullYear(),
        ...Object.fromEntries(url.searchParams),
      });
    } else {
      let m;
      if ((m = /^\/teams\/([^/]+)$/.exec(path))) {
        teamId = m[1];
        await ctx.team(teamId);
      } else if ((m = /^\/reports\/([^/]+)$/.exec(path))) {
        teamId = (await ctx.locate("report", m[1])).teamId;
      } else {
        const scope = await documentScope(ctx, path);
        assert(scope, 400, "등록되지 않은 구독 경로입니다.");
        teamId = scope.teamId;
        type = scope.documentId ? "document" : "resource";
      }
    }
    channels.push({
      ...item,
      path,
      url,
      teamId,
      type,
      cursor: item.lastEventId || url.searchParams.get("after") || "",
      lastRevision: null,
      closed: false,
    });
  }
  let stopped = false;
  const stream = new ReadableStream(
    {
      start(controller) {
        const write = (channel, event, data, id) => {
          if (stopped) return;
          const content = typeof data === "string" ? data : stringify(data);
          const text =
            multiplex && event === "closed"
              ? `event: closed\ndata: ${JSON.stringify({ id: channel.id })}\n\n`
              : multiplex
                ? `event: stream\ndata: ${JSON.stringify({ id: channel.id, event, data: content, ...(id ? { lastEventId: id } : {}) })}\n\n`
                : `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${content}\n\n`;
          assert(text.length <= 1024 * 1024, 503, "이벤트가 너무 큽니다.");
          controller.enqueue(encoder.encode(text));
        };
        const run = async () => {
          const start = Date.now();
          while (
            !stopped &&
            Date.now() - start < lifetimeMs &&
            !ctx.request.signal.aborted
          ) {
            assert(
              Date.now() < ctx.identity.expiresAt,
              401,
              "로그인이 만료되었습니다.",
            );
            ctx.user = await authenticate(ctx.env, ctx.identity);
            ctx.teamCache.clear();
            const batches = new Map();
            for (const channel of channels) {
              if (channel.closed) continue;
              try {
                if (channel.type === "cells") {
                  const batch = await new PostgresTaskRepository({
                    context: ctx,
                  }).readEvents(
                    ctx.user,
                    {
                      teamId: channel.teamId,
                      ...periodScopeSchema.parse({
                        year: new Date().getFullYear(),
                        ...Object.fromEntries(channel.url.searchParams),
                      }),
                    },
                    channel.cursor,
                  );
                  if (batch.reset) write(channel, "reset", {}, batch.cursor);
                  else
                    for (const event of batch.events)
                      write(channel, "cells", event.payload, event.cursor);
                  if (
                    channel.lastRevision === null ||
                    (!batch.reset &&
                      !batch.events.length &&
                      batch.cursor !== channel.cursor)
                  )
                    write(channel, "ready", {}, batch.cursor);
                  channel.lastRevision = batch.cursor;
                  channel.cursor = batch.cursor;
                  continue;
                }
                await ctx.team(channel.teamId);
                let snapshot = batches.get(channel.teamId);
                if (!snapshot) {
                  snapshot = await ctx.data(channel.teamId, async (s) => {
                    const q = await s.tx.query(
                      "SELECT COALESCE(MAX(cursor),0) AS cursor FROM site_events WHERE team_id=$1",
                      [channel.teamId],
                    );
                    return { cursor: Number(q.rows[0].cursor) };
                  });
                  batches.set(channel.teamId, snapshot);
                }
                const eventId = "pg:" + snapshot.cursor;
                if (
                  channel.cursor !== eventId ||
                  channel.lastRevision === null
                ) {
                  let payload;
                  if (channel.type === "document")
                    payload = await documentRoutes(
                      ctx,
                      channel.path,
                      "GET",
                      {},
                      channel.url.searchParams,
                    );
                  else payload = { revision: snapshot.cursor };
                  if (
                    channel.lastRevision !== payload.revision &&
                    channel.cursor !== eventId
                  )
                    write(
                      channel,
                      "document",
                      {
                        ...payload,
                        sync: {
                          session: "postgres",
                          sequence: snapshot.cursor,
                        },
                      },
                      eventId,
                    );
                  channel.lastRevision = payload.revision;
                }
                channel.cursor = eventId;
              } catch (error) {
                const status = error.status || 500;
                write(
                  channel,
                  [401, 403, 404].includes(status)
                    ? "access-revoked"
                    : "rejected",
                  { status },
                );
                write(channel, "closed", {});
                channel.closed = true;
              }
            }
            if (channels.every((c) => c.closed)) break;
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            if (
              controller.desiredSize !== null &&
              controller.desiredSize < -1024 * 1024
            )
              break;
            await pause(pollMs);
          }
        };
        run()
          .catch((error) => {
            if (!stopped)
              for (const channel of channels)
                if (!channel.closed)
                  try {
                    write(
                      channel,
                      error.status === 401 ? "access-revoked" : "rejected",
                      { status: error.status || 503 },
                    );
                    write(channel, "closed", {});
                  } catch {}
          })
          .finally(() => {
            if (!stopped) {
              stopped = true;
              try {
                controller.close();
              } catch {}
            }
          });
      },
      cancel() {
        stopped = true;
      },
    },
    { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
