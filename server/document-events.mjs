import { randomUUID } from "node:crypto";

// Transport cursors are process-local, independent of numeric/UUID DB revisions.
// A fresh snapshot on reconnect also covers writes by another server process.
export function createDocumentEvents(refreshUser) {
  const session = randomUUID();
  let sequence = 0;
  const channels = new Map();
  const versions = new Map();
  const stamp = (document) => ({
    ...document,
    sync: { session, sequence: ++sequence },
  });
  return {
    stamp,
    watch(req, res, key, authorize) {
      this.subscribe(req, res, key, (request) => {
        authorize(request);
        return { revision: versions.get(key) || 0 };
      });
    },
    notify(key) {
      for (const client of channels.get(key) || []) client.send();
    },
    invalidate(key, clientId) {
      if (!channels.has(key)) return;
      versions.set(key, ++sequence);
      this.publish(key, { revision: sequence, clientId });
    },
    subscribe(req, res, key, read) {
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
          versions.delete(key);
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
          const current = read({ ...req, user: refreshUser(req) });
          if (revision !== current.revision) {
            res.write(
              snapshot?.revision === current.revision
                ? snapshot.message
                : `event: document\ndata: ${JSON.stringify(stamp(current))}\n\n`,
            );
            revision = current.revision;
          } else res.write(": keep-alive\n\n");
        } catch {
          res.write("event: access-revoked\ndata: {}\n\n");
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
      const clients = channels.get(key);
      if (clients?.size) {
        // Encode once per write, while checking each subscriber's access.
        const snapshot = {
          revision: result.revision,
          message: `event: document\ndata: ${JSON.stringify(result)}\n\n`,
        };
        for (const client of clients) client.send(snapshot);
      }
      return result;
    },
    close() {
      for (const clients of channels.values())
        for (const client of [...clients]) client.close();
    },
  };
}
