import { PostgresTaskRepository } from "./storage/postgres-tasks.mjs";
import { periodScopeSchema } from "../shared/validation.js";
import { stringify } from "../shared/compact.js";
import { assert } from "./access.mjs";
import { authenticate } from "./control.mjs";
import { documentScope, documentRoutes } from "./documents.mjs";
import { streamScope, eventTouches } from "./event-scope.mjs";
const encoder = new TextEncoder();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FEED_LIMIT = 512;
const position = (cursor) => {
  const m = /^pg:(\d+)$/.exec(cursor);
  return m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : null;
};
// One team's events since the oldest cursor its streams hold, read once per
// poll. Cell deltas are skipped by every stream here, so their payload is not
// read. `until` marks a read cut at the limit: streams behind it, like streams
// behind removed events, treat everything as changed.
async function readFeed(ctx, teamId, channels) {
  return ctx.data(teamId, async (s) => {
    const range = (
      await s.tx.query(
        "SELECT COALESCE(MAX(cursor),0) AS cursor,COALESCE(MIN(cursor),0) AS oldest FROM site_events WHERE team_id=$1",
        [teamId],
      )
    ).rows[0];
    const cursor = Number(range.cursor),
      oldest = Number(range.oldest),
      behind = channels
        .filter((c) => c.teamId === teamId && c.type !== "cells" && !c.closed)
        .map((c) => position(c.cursor))
        .filter((at) => at !== null && at < cursor && at >= oldest - 1);
    const feed = { cursor, oldest, from: cursor, events: [] };
    if (!behind.length) return feed;
    feed.from = Math.min(...behind);
    const rows = (
      await s.tx.query(
        "SELECT cursor,kind,CASE WHEN kind='cells' THEN NULL ELSE payload END AS payload FROM site_events WHERE team_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3",
        [teamId, feed.from, FEED_LIMIT + 1],
      )
    ).rows;
    // Streams before a gap or past the read limit cannot tell what changed.
    if (rows.length > FEED_LIMIT)
      feed.until = Number(rows[FEED_LIMIT - 1].cursor);
    feed.events = rows.slice(0, FEED_LIMIT).map((row) => ({
      cursor: Number(row.cursor),
      kind: row.kind,
      payload: row.payload == null ? null : JSON.parse(row.payload),
    }));
    return feed;
  });
}
// Whether anything this stream shows may have changed since its cursor.
function changedFor(channel, feed) {
  const at = position(channel.cursor);
  if (at === feed.cursor) return false;
  if (at === null || at > feed.cursor || at < feed.oldest - 1 || at < feed.from)
    return true;
  if (feed.until !== undefined) return true;
  return feed.events.some(
    (event) => event.cursor > at && eventTouches(channel.scope, event),
  );
}
export async function eventResponse(
  ctx,
  streams,
  {
    multiplex = true,
    pollMs = ctx.env.EVENT_STREAM_POLL_MS || 1000,
    lifetimeMs = ctx.env.EVENT_STREAM_LIFETIME_MS || 60000,
  } = {},
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
      scope,
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
        scope = streamScope(path);
      } else if ((m = /^\/reports\/([^/]+)$/.exec(path))) {
        teamId = await ctx.locateTeam("report", m[1]);
        scope = streamScope(path);
      } else {
        const document = await documentScope(ctx, path);
        assert(document, 400, "등록되지 않은 구독 경로입니다.");
        teamId = document.teamId;
        type = document.documentId ? "document" : "resource";
        scope = streamScope(path, document);
      }
    }
    channels.push({
      ...item,
      path,
      url,
      teamId,
      type,
      scope,
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
            ctx.user = await authenticate(ctx.env, ctx.identity, ctx.request);
            ctx.teamCache.clear();
            const feeds = new Map();
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
                let feed = feeds.get(channel.teamId);
                if (!feed) {
                  feed = await readFeed(ctx, channel.teamId, channels);
                  feeds.set(channel.teamId, feed);
                }
                const eventId = "pg:" + feed.cursor;
                // A document is read only when an event since this stream's
                // cursor names it; nothing is sent for other records.
                if (changedFor(channel, feed)) {
                  let payload;
                  if (channel.type === "document")
                    payload = await documentRoutes(
                      ctx,
                      channel.path,
                      "GET",
                      {},
                      channel.url.searchParams,
                    );
                  else payload = { revision: feed.cursor };
                  if (channel.lastRevision !== payload.revision)
                    write(
                      channel,
                      "document",
                      {
                        ...payload,
                        // Document GET/save responses use the entity revision.
                        // Keep that sequence domain; pg:<cursor> only resumes
                        // the transport and must not replace a document stamp.
                        sync: payload.sync || {
                          session: "postgres",
                          sequence: feed.cursor,
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
