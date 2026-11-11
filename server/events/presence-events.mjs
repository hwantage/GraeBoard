import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerEventRoute } from "./event-streams.mjs";

const updateSchema = z
  .object({
    teamId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128).nullable(),
    key: z.string().min(1).max(128).nullable(),
    editing: z.boolean().default(false),
  })
  .strict();
const clientIdSchema = z.string().uuid();
// More open tabs than this per person only replace that person's oldest tab.
const MAX_TABS = 20;

// Which annual sheet cell each open tab has selected or is editing, kept only
// in this process for people on the same internal server. Nothing is stored or
// synced; tabs resend their cell while open, so a restart or a closed tab just
// lets the entry expire.
export function createPresenceEvents({
  refreshUser,
  teamAccess,
  ttlMs = 30000,
  heartbeatMs = 15000,
} = {}) {
  // Event ids let a tab joining a stream another tab of the same browser
  // already holds ask for the current list, as cell and document streams do.
  const epoch = randomUUID(),
    teams = new Map();
  let heartbeat,
    shuttingDown = false;
  const teamState = (teamId) => {
    if (!teams.has(teamId))
      teams.set(teamId, {
        entries: new Map(),
        listeners: new Set(),
        sequence: 0,
      });
    return teams.get(teamId);
  };
  // The heartbeat runs while any team holds positions or listeners, so
  // positions of a team nobody watches expire too.
  function forget(teamId) {
    const state = teams.get(teamId);
    if (state && !state.entries.size && !state.listeners.size)
      teams.delete(teamId);
    if (!teams.size) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    } else if (!heartbeat && !shuttingDown) {
      heartbeat = setInterval(tick, heartbeatMs);
      heartbeat.unref();
    }
  }
  function prune(state, now = Date.now()) {
    let changed = false;
    for (const [clientId, entry] of state.entries)
      if (entry.expiresAt <= now) {
        state.entries.delete(clientId);
        changed = true;
      }
    return changed;
  }
  function changed(teamId) {
    const state = teams.get(teamId);
    if (!state) return;
    state.sequence++;
    for (const listener of state.listeners) listener.send();
  }
  function tick() {
    for (const [teamId, state] of teams) {
      if (prune(state)) changed(teamId);
      for (const listener of state.listeners) listener.check();
      forget(teamId);
    }
  }
  return {
    update(user, clientId, body) {
      const id = clientIdSchema.parse(clientId);
      const { teamId, taskId, key, editing } = updateSchema.parse(body);
      teamAccess(user, teamId);
      const state = teamState(teamId);
      let dirty = prune(state);
      const previous = state.entries.get(id);
      if (!taskId || !key) state.entries.delete(id);
      else {
        const tabs = [...state.entries].filter(
          ([, entry]) => entry.userId === user.id,
        );
        if (!previous && tabs.length >= MAX_TABS)
          state.entries.delete(tabs[0][0]);
        state.entries.set(id, {
          userId: user.id,
          name: user.name,
          color: user.color,
          taskId,
          key,
          editing,
          expiresAt: Date.now() + ttlMs,
        });
      }
      const next = state.entries.get(id);
      dirty ||= ["userId", "name", "color", "taskId", "key", "editing"].some(
        (field) => previous?.[field] !== next?.[field],
      );
      if (dirty) changed(teamId);
      forget(teamId);
    },
    subscribe(req, res, teamId) {
      if (shuttingDown) return res.end();
      teamAccess(req.user, teamId);
      res.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write("retry: 2000\n\n");
      const state = teamState(teamId);
      let sent = "";
      const close = () => {
        state.listeners.delete(listener);
        if (!res.writableEnded) res.end();
        forget(teamId);
      };
      // Members removed from the team stop seeing positions.
      const allowed = () => {
        if (res.destroyed || res.writableEnded) {
          close();
          return false;
        }
        try {
          teamAccess(refreshUser(req), teamId);
          return true;
        } catch (error) {
          res.write(
            `event: access-revoked\ndata: ${JSON.stringify({ status: error.status || 403 })}\n\n`,
          );
          close();
          return false;
        }
      };
      const listener = {
        close,
        send() {
          const cells = [...state.entries.values()]
            .filter((entry) => entry.userId !== req.user.id)
            .map(({ userId, name, color, taskId, key, editing }) => ({
              userId,
              name,
              color,
              taskId,
              key,
              editing,
            }));
          const data = JSON.stringify({ cells });
          if (data === sent || !allowed()) return;
          sent = data;
          res.write(
            `id: ${epoch}:${state.sequence}\nevent: presence\ndata: ${data}\n\n`,
          );
        },
        check() {
          if (allowed()) res.write(": keep-alive\n\n");
        },
      };
      state.listeners.add(listener);
      res.on("close", close);
      if (prune(state)) state.sequence++;
      listener.send();
      forget(teamId);
    },
    shutdown() {
      shuttingDown = true;
      for (const state of [...teams.values()])
        for (const listener of [...state.listeners]) listener.close();
      teams.clear();
      clearInterval(heartbeat);
      heartbeat = undefined;
    },
  };
}

export function installPresenceRoutes(app, { refreshUser, teamAccess }) {
  const presence = createPresenceEvents({ refreshUser, teamAccess });
  app.post("/api/presence", (req, res) => {
    presence.update(req.user, req.get("X-Client-ID"), req.body);
    res.json({});
  });
  registerEventRoute(app, "/api/presence/events", (req, res) =>
    presence.subscribe(req, res, String(req.query.teamId || "")),
  );
  return presence;
}
