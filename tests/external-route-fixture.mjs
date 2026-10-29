import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";
import { json } from "../worker/entry.mjs";
import {
  authenticate,
  controlRoutes,
  RequestContext,
} from "../worker/control.mjs";
import { adminRoutes } from "../worker/admin.mjs";
import { taskRoutes } from "../worker/tasks.mjs";
import { documentRoutes } from "../worker/documents.mjs";
import {
  reportRoutes,
  filterRoutes,
  browserRoutes,
} from "../worker/reports.mjs";
import { calendarRoutes } from "../worker/calendar.mjs";
import { transferRoutes } from "../worker/transfer.mjs";
import { auditRoutes, historyCleanupRoutes } from "../worker/history.mjs";
import { eventResponse } from "../worker/events.mjs";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { PostgresDocumentRepository } from "../worker/storage/postgres-documents.mjs";
import { unpack } from "../shared/compact.js";

// The contract suites exercise the actual external route dispatcher. The only
// authentication stub is a synthetic identity selected by the fixture's user ID;
// memberships, data access and stream revalidation use the real PG control store.
export function createExternalRouteApp({ env, defaultUserId, contextFor }) {
  const control = new Pool(env.PG_CONTROL);
  const pending = new Set();
  const runtime = {
    ...env,
    GRAEBOARD_SITE: "external",
    EVENT_STREAM_POLL_MS: 20,
    EVENT_STREAM_LIFETIME_MS: 60000,
  };
  const verify = async (request) => {
    const userId =
      request.headers.get("cookie")?.match(/weekly_session=([^;]+)/)?.[1] ||
      defaultUserId;
    const user = (
      await control.query(
        "SELECT id,email,username FROM graeboard.users WHERE id=$1",
        [userId],
      )
    ).rows[0];
    if (!user)
      throw Object.assign(new Error("Unknown fixture identity"), {
        status: 401,
      });
    return {
      issuer: "https://contract.example.test",
      subject: user.id,
      email: user.email || user.username,
      expiresAt: Date.now() + 3600000,
    };
  };
  const handle = async (request, execution) => {
    try {
      const identity = await verify(request);
      const user = await authenticate(runtime, identity, request);
      const ctx = contextFor
        ? contextFor(user, request)
        : new RequestContext(runtime, user, identity, request, execution);
      Object.assign(ctx, { env: runtime, user, identity, request, execution });
      const url = new URL(request.url),
        path = url.pathname.slice(4),
        method = request.method;
      const body =
        request.body &&
        request.headers.get("content-type")?.includes("application/json")
          ? unpack(await request.json())
          : {};
      if (path === "/events" && method === "POST")
        return await eventResponse(ctx, body.streams);
      if (path.endsWith("/events") && method === "GET")
        return await eventResponse(
          ctx,
          [
            {
              id: 0,
              path: url.pathname + url.search,
              lastEventId: request.headers.get("last-event-id") || undefined,
            },
          ],
          { multiplex: false },
        );
      if (path.startsWith("/document-images/") && method === "GET") {
        const stream = await new DocumentBusinessService(
          new PostgresDocumentRepository({ context: ctx }),
          user,
        ).readImage("/api" + path, { stream: true });
        return new Response(stream, {
          headers: { "Content-Type": "image/webp" },
        });
      }
      for (const route of [
        controlRoutes,
        adminRoutes,
        taskRoutes,
        documentRoutes,
        reportRoutes,
        filterRoutes,
        browserRoutes,
        calendarRoutes,
        transferRoutes,
        auditRoutes,
        historyCleanupRoutes,
      ]) {
        const result = await route(ctx, path, method, body, url.searchParams);
        if (result === undefined) continue;
        if (result instanceof Response) return result;
        const headers =
          path === "/tasks" && method === "GET"
            ? { ETag: result.etag, "X-Cell-Event-ID": result.cellEventId }
            : {};
        return json(result, 200, headers);
      }
      return json({ error: "Unknown contract route" }, 404);
    } catch (error) {
      return json(
        { error: error.message, details: error.details },
        error.status || (error.name === "ZodError" ? 400 : 500),
      );
    }
  };
  return {
    listen(...args) {
      const server = createServer(async (incoming, outgoing) => {
        const controller = new AbortController();
        outgoing.once("close", () => controller.abort());
        try {
          const origin = `http://${incoming.headers.host}`;
          runtime.APP_ORIGIN = origin;
          const chunks = [];
          for await (const chunk of incoming) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const request = new Request(origin + incoming.url, {
            method: incoming.method,
            headers: incoming.headers,
            signal: controller.signal,
            ...(body.length ? { body } : {}),
          });
          const response = await handle(request, {
            waitUntil(promise) {
              const work = Promise.resolve(promise)
                .catch(() => {})
                .finally(() => pending.delete(work));
              pending.add(work);
            },
          });
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          if (response.body)
            await pipeline(Readable.fromWeb(response.body), outgoing);
          else outgoing.end();
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!outgoing.headersSent)
            outgoing.writeHead(500, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ error: error.message }));
        }
      });
      return server.listen(...args);
    },
    async close() {
      await Promise.all([...pending]);
      await control.end();
    },
  };
}
