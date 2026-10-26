import { randomUUID } from "node:crypto";

// Transport cursors are process-local, independent of numeric/UUID DB revisions.
// Only revision/cursor metadata is retained; document bodies stay in the DB.
export function createDocumentEvents(refreshUser) {
  const session = randomUUID();
  let sequence = 0,
    shuttingDown = false;
  const channels = new Map();
  const versions = new Map();
  const remember = (key, value) => {
    versions.delete(key);
    versions.set(key, value);
    // Eviction is safe: a missing cursor causes an authoritative snapshot.
    if (versions.size > 10000) versions.delete(versions.keys().next().value);
    return value;
  };
  const stamp = (document) => ({
    ...document,
    sync: { session, sequence: ++sequence },
  });
  return {
    stamp,
    watch(req, res, key, authorize) {
      this.subscribe(req, res, key, (request) => {
        authorize(request);
        return { revision: versions.get(key)?.revision || 0 };
      });
    },
    notify(key) {
      for (const client of channels.get(key) || []) client.send();
    },
    invalidate(key, clientId) {
      // Track writes even between connections, when the last listener is gone.
      this.publish(key, { revision: ++sequence, clientId });
    },
    subscribe(req, res, key, read) {
      if (shuttingDown) return res.end();
      read(req); // Reject unauthorized subscriptions before opening the stream.
      res.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write("retry: 1500\n\n");
      let revision;
      let cursor = req.get("Last-Event-ID") || "";
      let closed = false;
      const clients = channels.get(key) || new Set();
      channels.set(key, clients);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clients.delete(client);
        if (!clients.size) {
          channels.delete(key);
        }
        res.end();
      };
      const send = (snapshot) => {
        if (
          res.destroyed ||
          res.writableEnded ||
          res.writableLength > 1024 * 1024
        )
          return close();
        try {
          // Never reuse membership/session state captured when connecting.
          const current = read(
            Object.assign(Object.create(req), { user: refreshUser(req) }),
          );
          if (revision !== current.revision) {
            let version = versions.get(key);
            if (!version || version.revision !== current.revision)
              version = remember(key, {
                revision: current.revision,
                sequence: ++sequence,
              });
            const eventId = `${session}:${version.sequence}`;
            if (cursor !== eventId)
              res.write(
                snapshot?.revision === current.revision
                  ? snapshot.message
                  : `id: ${eventId}\nevent: document\ndata: ${JSON.stringify({ ...current, sync: { session, sequence: version.sequence } })}\n\n`,
              );
            else res.write(": keep-alive\n\n");
            cursor = eventId;
            revision = current.revision;
          } else res.write(": keep-alive\n\n");
        } catch (error) {
          res.write(
            `event: access-revoked\ndata: ${JSON.stringify({ status: error?.status || 403 })}\n\n`,
          );
          close();
        }
      };
      const client = { send, close };
      const heartbeat = setInterval(send, 15000);
      heartbeat.unref();
      clients.add(client);
      res.on("close", close);
      send();
    },
    publish(key, document) {
      const result = stamp(document);
      remember(key, {
        revision: result.revision,
        sequence: result.sync.sequence,
      });
      const clients = channels.get(key);
      if (clients?.size) {
        // Encode once per write, while checking each subscriber's access.
        const snapshot = {
          revision: result.revision,
          message: `id: ${session}:${result.sync.sequence}\nevent: document\ndata: ${JSON.stringify(result)}\n\n`,
        };
        for (const client of clients) client.send(snapshot);
      }
      return result;
    },
    close() {
      for (const clients of channels.values())
        for (const client of [...clients]) client.close();
    },
    shutdown() {
      shuttingDown = true;
      this.close();
    },
  };
}
