import { isIP } from "node:net";
import { requireThat } from "../../shared/validation.js";
import {
  calendarReminderLabel,
  calendarStartMs,
  CALENDAR_REMINDER_GRACE_MS,
  CALENDAR_REMINDER_MAX_MINUTES,
  CALENDAR_TIME_ZONE_OFFSET,
} from "../../shared/calendar/calendar.js";
import { documentLinkPath } from "../../shared/documents/document-links.js";

// Calendar reminders reach people through the Dabada hub, which pushes a
// message to the desktop client connected from a fixed intranet address.
// Only this internal server can reach the hub, so it alone sends: a reminder
// set on the external site is sent here once synchronization delivered it.
// Reminder times are compared with this server's clock.
//
// The hub addresses a person by IP, so this server remembers the address each
// person last used the internal site from (push_addresses). That table and the
// sent log (calendar_reminder_sends) are local and never synchronized. The
// log also tells how each reminder went (calendarReminderStatus), so its rows
// stay as long as their entry.

const TICK_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
// A person may send themselves a test push this often.
const TEST_INTERVAL_MS = 10 * 1000;
const ZONE_MS =
  (CALENDAR_TIME_ZONE_OFFSET.startsWith("-") ? -1 : 1) *
  (Number(CALENDAR_TIME_ZONE_OFFSET.slice(1, 3)) * 60 +
    Number(CALENDAR_TIME_ZONE_OFFSET.slice(4, 6))) *
  60000;
const dayOf = (ms) => new Date(ms + ZONE_MS).toISOString().slice(0, 10);

/** The address the hub knows a client by; "" when it cannot receive a push. */
export function pushAddress(value) {
  let ip = String(value || "").trim();
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  // The server's own browser has no address another host can push to.
  return isIP(ip) && ip !== "::1" && !ip.startsWith("127.") ? ip : "";
}

// `minutes` is the reminder being sent, one of the entry's reminders.
export function calendarReminderMessage(entry, minutes, { appOrigin } = {}) {
  const start = calendarStartMs(entry.date, entry.time);
  const link = appOrigin
    ? appOrigin.replace(/\/+$/, "") +
      documentLinkPath({ kind: "calendar", id: entry.id })
    : null;
  return {
    msg_type: "noti",
    title: `⏰ ${entry.time} ${entry.title}`,
    message:
      (minutes === 0
        ? "지금 시작하는 일정입니다."
        : `${calendarReminderLabel(minutes)} 알림입니다.`) +
      ` (${entry.date} ${entry.time} 시작` +
      (entry.userId === null ? ` · ${entry.teamName} 팀 일정)` : ")"),
    payload: { category: "그래보드 캘린더", ...(link ? { link } : {}) },
    action_url: link,
    expired_at: new Date(start + 60 * 60 * 1000).toISOString(),
  };
}

export function createCalendarReminderPush({
  db,
  hubUrl = process.env.DABADA_PUSH_URL,
  appOrigin = process.env.APP_ORIGIN,
  request = fetch,
  now = Date.now,
  // Called at the end of a check with each team that had a reminder sent or
  // closed in it, so open calendars show how those went.
  onSent,
} = {}) {
  const base = String(hubUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const enabled = /^https?:\/\//.test(base);
  // The address last stored for each person, to write only when it changes.
  const seen = new Map();
  const tested = new Map();
  let timer = null,
    running = null;

  function remember(userId, address) {
    const ip = pushAddress(address);
    if (!ip || seen.get(userId) === ip) return;
    seen.set(userId, ip);
    db.prepare(
      "INSERT INTO push_addresses(user_id,ip,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ip=excluded.ip,updated_at=excluded.updated_at WHERE push_addresses.ip<>excluded.ip",
    ).run(userId, ip, new Date(now()).toISOString());
  }
  function address(userId) {
    const row = db
      .prepare("SELECT ip FROM push_addresses WHERE user_id=?")
      .get(userId);
    return { enabled, ip: row?.ip || null };
  }

  // True once the hub took the message. It also keeps a message for a client
  // that is not connected (success:false with a message ID), which counts.
  async function send(ip, message) {
    try {
      const response = await request(base + "/api/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...message, target_ip: ip }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      await response.body?.cancel?.();
      return true;
    } catch (error) {
      console.warn(
        "GraeBoard reminder push failed",
        JSON.stringify({ ip, reason: error.message }),
      );
      return false;
    }
  }

  // Reminders whose time has come within the grace period and that were not
  // sent yet, each with the addresses of the people it goes to: the owner of
  // a personal entry, every active member of the team for a team entry.
  function due(at = now()) {
    const sent = db.prepare(
      "SELECT 1 FROM calendar_reminder_sends WHERE entry_id=? AND fire_at=?",
    );
    const owner = db.prepare(
      "SELECT a.user_id AS userId,a.ip FROM push_addresses a JOIN users u ON u.id=a.user_id WHERE u.active=1 AND a.user_id=?",
    );
    const members = db.prepare(
      "SELECT a.user_id AS userId,a.ip FROM push_addresses a JOIN users u ON u.id=a.user_id JOIN memberships m ON m.user_id=a.user_id WHERE u.active=1 AND m.team_id=? ORDER BY a.user_id",
    );
    return db
      .prepare(
        "SELECT e.id,e.team_id AS teamId,e.user_id AS userId,e.date,e.start_time AS time,e.reminders,e.title,t.name AS teamName FROM calendar_entries e JOIN teams t ON t.id=e.team_id WHERE e.deleted_at IS NULL AND e.start_time IS NOT NULL AND e.reminders IS NOT NULL AND e.date BETWEEN ? AND ? ORDER BY e.date,e.start_time,e.id",
      )
      .all(
        dayOf(at - CALENDAR_REMINDER_GRACE_MS),
        dayOf(at + CALENDAR_REMINDER_MAX_MINUTES * 60000),
      )
      .flatMap(({ reminders, ...entry }) => {
        const start = calendarStartMs(entry.date, entry.time);
        if (start === null) return [];
        let recipients;
        // The earliest reminder first.
        return JSON.parse(reminders)
          .toSorted((a, b) => b - a)
          .flatMap((minutes) => {
            const fireMs = start - minutes * 60000;
            if (fireMs > at || at - fireMs > CALENDAR_REMINDER_GRACE_MS)
              return [];
            const fireAt = new Date(fireMs).toISOString();
            if (sent.get(entry.id, fireAt)) return [];
            recipients ??=
              entry.userId === null
                ? members.all(entry.teamId)
                : owner.all(entry.userId);
            return [{ entry, minutes, fireAt, recipients }];
          });
      });
  }

  async function run() {
    const at = now();
    // Telling a team makes each of its open screens read again, so a team is
    // told once, when the check ends, however many of its reminders were due
    // together. A check that fails part way still tells the teams whose
    // reminders it recorded.
    const teams = new Set();
    try {
      for (const { entry, minutes, fireAt, recipients } of due(at)) {
        const message = calendarReminderMessage(entry, minutes, { appOrigin });
        const results = await Promise.all(
          recipients.map(({ ip }) => send(ip, message)),
        );
        // Nobody to send to is final. When the hub took none, the next tick
        // tries again until the grace period ends.
        if (recipients.length && !results.some(Boolean)) continue;
        db.prepare(
          "INSERT OR IGNORE INTO calendar_reminder_sends(entry_id,fire_at,sent_at,recipients) VALUES(?,?,?,?)",
        ).run(
          entry.id,
          fireAt,
          new Date(now()).toISOString(),
          results.filter(Boolean).length,
        );
        teams.add(entry.teamId);
      }
    } finally {
      for (const teamId of teams) onSent?.(teamId);
    }
  }
  // One pass at a time: a slow hub must not send a reminder twice.
  function tick() {
    if (!enabled) return Promise.resolve();
    running ||= run()
      .catch((error) =>
        console.warn("GraeBoard reminder check failed", error.message),
      )
      .finally(() => {
        running = null;
      });
    return running;
  }
  return {
    enabled,
    remember,
    address,
    due,
    tick,
    async test(userId) {
      requireThat(
        enabled,
        409,
        "이 서버에 다바다 푸시 주소(DABADA_PUSH_URL)가 설정되지 않았습니다.",
      );
      const ip = address(userId).ip;
      requireThat(ip, 409, "알림을 받을 PC 주소가 아직 등록되지 않았습니다.");
      requireThat(
        now() - (tested.get(userId) ?? -Infinity) >= TEST_INTERVAL_MS,
        429,
        "테스트 알림은 잠시 후 다시 보낼 수 있습니다.",
      );
      tested.set(userId, now());
      requireThat(
        await send(ip, {
          msg_type: "noti",
          title: "그래보드 알림 테스트",
          message: "캘린더 일정 알림이 이 PC로 전달됩니다.",
          payload: { category: "그래보드 캘린더" },
          action_url: null,
          expired_at: null,
        }),
        502,
        "다바다 푸시 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
      );
      return { ok: true, ip };
    },
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}

// Installed after authentication: every signed-in request tells where the
// person uses the internal site from, which is where their reminders go.
export function installCalendarReminderPush(app, options) {
  const push = createCalendarReminderPush(options);
  app.use("/api", (req, _res, next) => {
    if (req.user) push.remember(req.user.id, req.ip);
    next();
  });
  app.get("/api/push-address", (req, res) =>
    res.json(push.address(req.user.id)),
  );
  app.post("/api/push-address/test", async (req, res) =>
    res.json(await push.test(req.user.id)),
  );
  push.start();
  return push;
}
