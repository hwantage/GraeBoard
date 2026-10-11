import { randomUUID } from "node:crypto";

// A bounded replay buffer for the single-server deployment. A new process or
// an expired cursor requests a DB snapshot instead of silently losing edits.
export function createCellEvents(
  db,
  {
    replayBytes = 8 * 1024 * 1024,
    replayCount = 512,
    maxEventBytes = 256 * 1024,
    heartbeatMs = 15000,
  } = {},
) {
  const epoch = randomUUID(),
    clients = new Set(),
    history = [];
  let sequence = 0,
    floor = 0,
    bytes = 0,
    heartbeat;
  const authorized = db.prepare(`
    SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN teams t ON t.id=?
    WHERE s.token=? AND s.expires_at>? AND u.active=1
      AND (u.system_role='admin' OR EXISTS (
        SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.team_id=t.id
      ))
  `);
  const cursor = () => `${epoch}:${sequence}`;
  function remove(client) {
    clients.delete(client);
    if (!clients.size) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }
  function allowed(client) {
    if (authorized.get(client.teamId, client.token, Date.now())) return true;
    client.res.end("event: access-revoked\ndata: {}\n\n");
    remove(client);
    return false;
  }
  function write(client, text) {
    if (
      client.res.destroyed ||
      client.res.writableEnded ||
      !clients.has(client) ||
      !allowed(client)
    )
      return;
    // Slow clients reconnect and replay; never accumulate an unbounded queue.
    if (client.res.writableLength > 1024 * 1024) {
      client.res.destroy();
      remove(client);
      return;
    }
    client.res.write(text);
  }
  function frame(type, data, eventId) {
    return `id: ${eventId}\nevent: ${type}\ndata: ${data}\n\n`;
  }
  function messageFor(entry, client) {
    const matches = client.scopes.filter((scope) => entry.messages.has(scope));
    if (!matches.length) return;
    const eventId = `${epoch}:${entry.sequence}`;
    const data = matches.map((scope) => entry.messages.get(scope));
    if (data.some((value) => value === null))
      return frame("reset", "{}", eventId);
    if (data.length === 1) return frame("cells", data[0], eventId);
    // One atomic event per operation, even if its tasks belong to both years.
    // A reconnect after this cursor must not lose the second year's changes.
    const payloads = data.map((value) => JSON.parse(value));
    const cells = new Map();
    for (const payload of payloads)
      for (const c of payload.cells) cells.set(`${c.taskId}:${c.key}`, c);
    const merged = JSON.stringify({
      operationId: payloads[0].operationId,
      cells: [...cells.values()],
      updatedAt: Object.assign({}, ...payloads.map((p) => p.updatedAt)),
    });
    return Buffer.byteLength(merged) > maxEventBytes
      ? frame("reset", "{}", eventId)
      : frame("cells", merged, eventId);
  }
  function subscribe(req, res, { teamId, year, token }) {
    const years = Array.isArray(year) ? year : [year];
    const client = {
      res,
      teamId,
      token,
      scope: `${teamId}:${years}`,
      scopes: years.map((y) => `${teamId}:${y}`),
    };
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 2000\n\n");
    clients.add(client);
    res.on("close", () => remove(client));
    const last = String(req.get("Last-Event-ID") || req.query.after || "");
    const [generation, position] = last.split(":");
    const since = Number(position);
    if (
      generation !== epoch ||
      !/^\d+$/.test(position || "") ||
      !Number.isSafeInteger(since) ||
      since < floor ||
      since > sequence
    ) {
      write(client, frame("reset", "{}", cursor()));
    } else {
      for (const entry of history) {
        if (entry.sequence <= since) continue;
        const message = messageFor(entry, client);
        if (message) write(client, message);
      }
    }
    // Advance over changes to other teams/years without exposing their data.
    write(client, frame("ready", "{}", cursor()));
    if (!heartbeat && clients.size) {
      heartbeat = setInterval(() => {
        for (const c of clients) write(c, ": keep-alive\n\n");
      }, heartbeatMs);
      heartbeat.unref();
    }
  }
  function publish(result, tasks) {
    if (!result.cells.length) return;
    const scopes = new Map();
    for (const c of result.cells) {
      const task = tasks.get(c.taskId);
      for (const year of task.years) {
        const scope = `${task.teamId}:${year}`;
        let payload = scopes.get(scope);
        if (!payload) {
          payload = {
            operationId: result.operationId,
            cells: [],
            updatedAt: {},
          };
          scopes.set(scope, payload);
        }
        payload.cells.push(c);
        payload.updatedAt[c.taskId] = result.updatedAt[c.taskId];
      }
    }
    sequence++;
    const entry = { sequence, messages: new Map(), bytes: 0 };
    for (const [scope, payload] of scopes) {
      const data = JSON.stringify(payload);
      const stored = Buffer.byteLength(data) > maxEventBytes ? null : data;
      entry.messages.set(scope, stored);
      entry.bytes += Buffer.byteLength(
        frame(stored === null ? "reset" : "cells", stored ?? "{}", cursor()),
      );
    }
    history.push(entry);
    bytes += entry.bytes;
    while (
      history.length &&
      (bytes > replayBytes || history.length > replayCount)
    ) {
      const removed = history.shift();
      bytes -= removed.bytes;
      floor = removed.sequence;
    }
    const delivery = new Map();
    for (const client of clients) {
      if (!delivery.has(client.scope))
        delivery.set(client.scope, messageFor(entry, client));
      const message = delivery.get(client.scope);
      if (message) write(client, message);
    }
  }
  function close() {
    for (const client of clients) client.res.end();
    clients.clear();
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  return { cursor, subscribe, publish, close };
}
