import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, json } from "../../server/db.mjs";
import { DEFAULT_SETTINGS } from "../../shared/domain.js";
import {
  calendarReminderLabel,
  calendarSchedule,
  calendarStartMs,
} from "../../shared/calendar/calendar.js";
import {
  CALENDAR_REMINDER_GRACE_MS,
  calendarReminderMessage,
  createCalendarReminderPush,
  pushAddress,
} from "../../server/calendar/calendar-reminder-push.mjs";

const HUB = "http://hub.example.test:7500";
function fixture(t, { hubUrl = HUB, appOrigin = "http://board.test" } = {}) {
  const db = openDatabase(":memory:"),
    teamId = randomUUID(),
    people = {};
  t.after(() => db.close());
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "알림 팀",
    json(DEFAULT_SETTINGS),
  );
  for (const [name, active, member] of [
    ["owner", 1, true],
    ["member", 1, true],
    ["unregistered", 1, true],
    ["inactive", 0, true],
    ["outsider", 1, false],
  ]) {
    const id = randomUUID();
    people[name] = id;
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,active,created_at) VALUES(?,?,?,'!','user',?,'2026-01-01')",
    ).run(id, name + "@example.test", name, active);
    if (member)
      db.prepare("INSERT INTO memberships VALUES(?,?,'member')").run(
        id,
        teamId,
      );
  }
  const calls = [];
  const clock = { ms: Date.parse("2026-11-23T00:00:00.000Z") };
  const hub = { status: 200, fail: false };
  const push = createCalendarReminderPush({
    db,
    hubUrl,
    appOrigin,
    now: () => clock.ms,
    request: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (hub.fail) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify({ success: true, messageId: 1 }), {
        status: hub.status,
      });
    },
  });
  const entry = (values) => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,title,updated_at,actor_id,start_time,remind_minutes,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      teamId,
      values.userId === undefined ? people.owner : values.userId,
      values.date,
      values.endDate || values.date,
      values.title || "주간 회의",
      "2026-11-01T00:00:00.000Z",
      people.owner,
      values.time ?? null,
      values.remindMinutes ?? null,
      values.deletedAt ?? null,
    );
    return id;
  };
  const sends = () =>
    db.prepare("SELECT * FROM calendar_reminder_sends ORDER BY fire_at").all();
  return { db, teamId, people, calls, clock, hub, push, entry, sends };
}
// 2026-11-23 10:00 in Korea.
const START = Date.parse("2026-11-23T01:00:00.000Z");

test("times are civil Korean times and unset fields are left out of the shared payload", () => {
  assert.equal(calendarStartMs("2026-11-23", "10:00"), START);
  assert.equal(calendarStartMs("2026-11-23", null), null);
  assert.deepEqual(calendarSchedule(null, null), {});
  assert.deepEqual(calendarSchedule("09:05", null), { time: "09:05" });
  assert.deepEqual(calendarSchedule("09:05", 0), {
    time: "09:05",
    remindMinutes: 0,
  });
  // Stored independently, so a concurrent merge loses neither value.
  assert.deepEqual(calendarSchedule(null, 10), { remindMinutes: 10 });
  assert.deepEqual([0, 10, 60, 120, 1440].map(calendarReminderLabel), [
    "정시",
    "10분 전",
    "1시간 전",
    "2시간 전",
    "하루 전",
  ]);
  assert.equal(pushAddress("::ffff:10.1.2.3"), "10.1.2.3");
  assert.equal(pushAddress(" 10.1.2.3 "), "10.1.2.3");
  for (const value of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "pc-1", ""])
    assert.equal(pushAddress(value), "", value);
});

test("a personal reminder goes once to its owner's address at the reminder time", async (t) => {
  const f = fixture(t);
  f.push.remember(f.people.owner, "::ffff:10.1.2.3");
  const id = f.entry({ date: "2026-11-23", time: "10:00", remindMinutes: 10 });
  f.entry({ date: "2026-11-23", time: "10:00" });
  f.entry({ date: "2026-11-23", remindMinutes: 10 });
  f.entry({
    date: "2026-11-23",
    time: "10:00",
    remindMinutes: 10,
    deletedAt: "2026-11-22T00:00:00.000Z",
  });
  // One second before the reminder time nothing is due.
  f.clock.ms = START - 10 * 60000 - 1000;
  await f.push.tick();
  assert.deepEqual(f.calls, []);
  f.clock.ms = START - 10 * 60000;
  await f.push.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, HUB + "/api/push/send");
  assert.deepEqual(f.calls[0].body, {
    msg_type: "noti",
    title: "⏰ 10:00 주간 회의",
    message: "10분 전 알림입니다. (2026-11-23 10:00 시작)",
    payload: {
      category: "그래보드 캘린더",
      link: `http://board.test/links/calendar/${id}`,
    },
    action_url: `http://board.test/links/calendar/${id}`,
    expired_at: "2026-11-23T02:00:00.000Z",
    target_ip: "10.1.2.3",
  });
  assert.deepEqual(
    f.sends().map(({ entry_id, fire_at, recipients }) => ({
      entry_id,
      fire_at,
      recipients,
    })),
    [{ entry_id: id, fire_at: "2026-11-23T00:50:00.000Z", recipients: 1 }],
  );
  // Later checks do not send it again.
  f.clock.ms += 30000;
  await f.push.tick();
  await f.push.tick();
  assert.equal(f.calls.length, 1);
  // A changed time is another reminder.
  f.db
    .prepare("UPDATE calendar_entries SET start_time='10:05' WHERE id=?")
    .run(id);
  f.clock.ms = START - 5 * 60000;
  await f.push.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.title, "⏰ 10:05 주간 회의");
  assert.equal(f.sends().length, 2);
});

test("a team entry reminds every active member with an address; others are skipped", async (t) => {
  const f = fixture(t);
  f.push.remember(f.people.owner, "10.1.2.3");
  f.push.remember(f.people.member, "10.1.2.4");
  f.push.remember(f.people.inactive, "10.1.2.5");
  f.push.remember(f.people.outsider, "10.1.2.6");
  f.entry({
    userId: null,
    date: "2026-11-23",
    time: "10:00",
    remindMinutes: 0,
    title: "팀 회의",
  });
  f.clock.ms = START;
  await f.push.tick();
  assert.deepEqual(f.calls.map((call) => call.body.target_ip).sort(), [
    "10.1.2.3",
    "10.1.2.4",
  ]);
  assert.equal(
    f.calls[0].body.message,
    "지금 시작하는 일정입니다. (2026-11-23 10:00 시작 · 알림 팀 팀 일정)",
  );
  assert.equal(f.sends()[0].recipients, 2);
});

test("a reminder nobody can receive is closed, an unreachable hub is retried within the grace period and late reminders are dropped", async (t) => {
  const f = fixture(t);
  const lonely = f.entry({
    userId: f.people.unregistered,
    date: "2026-11-23",
    time: "10:00",
    remindMinutes: 0,
  });
  f.clock.ms = START;
  await f.push.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(
    f.sends().map((row) => [row.entry_id, row.recipients]),
    [[lonely, 0]],
  );

  f.push.remember(f.people.owner, "10.1.2.3");
  const id = f.entry({ date: "2026-11-23", time: "11:00", remindMinutes: 30 });
  f.hub.fail = true;
  f.clock.ms = START + 30 * 60000;
  await f.push.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends().length, 1);
  f.hub.fail = false;
  f.hub.status = 500;
  f.clock.ms += 30000;
  await f.push.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.sends().length, 1);
  f.hub.status = 200;
  f.clock.ms += 30000;
  await f.push.tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    f.sends().map((row) => row.entry_id),
    [lonely, id],
  );

  // The server was down past the grace period: the reminder is not sent late.
  const late = f.entry({ date: "2026-11-23", time: "13:00", remindMinutes: 0 });
  f.clock.ms =
    Date.parse("2026-11-23T04:00:00.000Z") + CALENDAR_REMINDER_GRACE_MS + 1;
  await f.push.tick();
  assert.equal(f.calls.length, 3);
  assert.equal(
    f.sends().some((row) => row.entry_id === late),
    false,
  );
  // A reminder a day ahead belongs to an entry dated tomorrow.
  f.entry({ date: "2026-11-25", time: "09:00", remindMinutes: 1440 });
  f.clock.ms = Date.parse("2026-11-24T00:00:00.000Z");
  await f.push.tick();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].body.message.startsWith("하루 전 알림입니다."), true);
});

test("without a hub address nothing is sent or recorded", async (t) => {
  const f = fixture(t, { hubUrl: "" });
  f.push.remember(f.people.owner, "10.1.2.3");
  f.entry({ date: "2026-11-23", time: "10:00", remindMinutes: 0 });
  f.clock.ms = START;
  assert.equal(f.push.enabled, false);
  await f.push.tick();
  f.push.start();
  await f.push.close();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.sends(), []);
  assert.equal(f.push.address(f.people.owner).enabled, false);
  await assert.rejects(f.push.test(f.people.owner), /DABADA_PUSH_URL/);
});

test("the address follows where the person uses the site from until they set one by hand", async (t) => {
  const f = fixture(t);
  const { owner } = f.people;
  assert.deepEqual(f.push.address(owner, "10.1.2.3"), {
    enabled: true,
    ip: null,
    manual: false,
    detectedIp: "10.1.2.3",
  });
  await assert.rejects(f.push.test(owner), /아직 등록되지 않았습니다/);
  f.push.remember(owner, "127.0.0.1");
  assert.equal(f.push.address(owner).ip, null);
  f.push.remember(owner, "10.1.2.3");
  f.push.remember(owner, "10.1.2.3");
  f.push.remember(owner, "10.9.9.9");
  assert.equal(f.push.address(owner).ip, "10.9.9.9");
  assert.throws(() => f.push.setAddress(owner, "office-pc"), /IP 주소/);
  assert.throws(() => f.push.setAddress(owner, "127.0.0.1"), /IP 주소/);
  assert.deepEqual(f.push.setAddress(owner, " 10.1.2.50 ", "10.9.9.9"), {
    enabled: true,
    ip: "10.1.2.50",
    manual: true,
    detectedIp: "10.9.9.9",
  });
  // Using the site from elsewhere no longer moves a hand-set address.
  f.push.remember(owner, "10.7.7.7");
  assert.equal(f.push.address(owner).ip, "10.1.2.50");
  assert.deepEqual(await f.push.test(owner), { ok: true, ip: "10.1.2.50" });
  assert.equal(f.calls.at(-1).body.target_ip, "10.1.2.50");
  assert.equal(f.calls.at(-1).body.title, "그래보드 알림 테스트");
  // One test push at a time, then again after a short wait.
  await assert.rejects(f.push.test(owner), /잠시 후 다시/);
  assert.equal(f.calls.length, 1);
  f.clock.ms += 10000;
  f.hub.fail = true;
  await assert.rejects(f.push.test(owner), /연결하지 못했습니다/);
  // Clearing it follows the current address again, or forgets it.
  assert.deepEqual(f.push.setAddress(owner, null, "10.7.7.7"), {
    enabled: true,
    ip: "10.7.7.7",
    manual: false,
    detectedIp: "10.7.7.7",
  });
  f.push.remember(owner, "10.8.8.8");
  assert.equal(f.push.address(owner).ip, "10.8.8.8");
  assert.equal(f.push.setAddress(owner, null, "127.0.0.1").ip, null);
  // Deleting the person removes the address with them.
  f.push.remember(f.people.outsider, "10.1.1.1");
  f.db.prepare("DELETE FROM users WHERE id=?").run(f.people.outsider);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM push_addresses").get().n,
    0,
  );
});

test("a reminder message without an application origin carries no link", () => {
  const message = calendarReminderMessage({
    id: "entry",
    userId: "person",
    date: "2026-11-23",
    time: "10:00",
    remindMinutes: 60,
    title: "점검",
    teamName: "팀",
  });
  assert.equal(message.action_url, null);
  assert.deepEqual(message.payload, { category: "그래보드 캘린더" });
  assert.equal(message.message, "1시간 전 알림입니다. (2026-11-23 10:00 시작)");
});

test("SQLite shares a time and a reminder only when set and applies received ones, including their removal", async (t) => {
  const { readEntity, materializeEntity } =
    await import("../../server/sync/node/entities.mjs");
  const f = fixture(t);
  const plain = f.entry({ date: "2026-11-23" }),
    timed = f.entry({ date: "2026-11-23", time: "10:00", remindMinutes: 15 });
  const read = (id) => readEntity(f.db, f.teamId, "calendar", [id]);
  assert.deepEqual(Object.keys(read(plain).payload), [
    "userId",
    "date",
    "endDate",
    "lane",
    "title",
    "deletedAt",
    "tags",
  ]);
  assert.deepEqual(
    (({ time, remindMinutes }) => ({ time, remindMinutes }))(
      read(timed).payload,
    ),
    { time: "10:00", remindMinutes: 15 },
  );
  // The other site set a time on one entry and cleared it on the other.
  const received = read(plain);
  materializeEntity(
    f.db,
    f.teamId,
    { ...received, payload: { ...received.payload, time: "08:15" } },
    { actorId: f.people.owner },
  );
  assert.deepEqual(read(plain).payload, {
    ...received.payload,
    time: "08:15",
  });
  const { time, remindMinutes, ...cleared } = read(timed).payload;
  materializeEntity(
    f.db,
    f.teamId,
    { ...read(timed), payload: cleared },
    { actorId: f.people.owner },
  );
  assert.deepEqual(read(timed).payload, cleared);
  const row = f.db
    .prepare(
      "SELECT start_time,remind_minutes FROM calendar_entries WHERE id=?",
    )
    .get(timed);
  assert.deepEqual([row.start_time, row.remind_minutes], [null, null]);
});
