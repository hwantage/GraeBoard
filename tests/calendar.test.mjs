import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  insertTask,
  json,
  now,
  SCHEMA_VERSION,
} from "../server/db.mjs";
import { pruneDocumentVersions } from "../server/document-storage.mjs";
import {
  DEFAULT_SETTINGS,
  defaultView,
  filteredTasks,
  weeksForYear,
} from "../shared/domain.js";
import {
  calendarWeek,
  addDays,
  monthWeeks,
  moveMonth,
  moveCalendarRange,
} from "../shared/calendar.js";
import { placeCalendarEntry } from "../shared/calendar-layout.js";
import { MAX_DOCUMENT_BYTES } from "../shared/task-documents.js";
import { CALENDAR_TAG_COLORS } from "../shared/calendar-tags.js";
import { unpack } from "../shared/compact.js";
import { backupDatabase } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";

const deletionFor = (entry) => ({
  deletionId: randomUUID(),
  expectedUpdatedAt: entry.updatedAt,
  expectedTitle: entry.title,
  expectedRevision: entry.revision,
  expectedDate: entry.date,
  expectedEndDate: entry.endDate,
  expectedTagIds: entry.tagIds,
  expectedCheckedTagIds: entry.checkedTagIds,
});

test("일정 복제는 월 밖의 이름·동시 요청·재시도를 고려해 번호를 붙이고 본문 없이 태그를 보존한다", async (t) => {
  const f = await fixture(t);
  const tag = (
    await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
      id: randomUUID(),
      name: "확인",
      color: "green",
      kind: "check",
    })
  ).data;
  const source = (
    await f.req("/calendar/entries", "POST", {
      id: randomUUID(),
      teamId: f.teamId,
      userId: f.people.member.id,
      date: "2026-10-12",
      endDate: "2026-10-14",
      title: "팀 회의",
      tagIds: [tag.id],
      checkedTagIds: [tag.id],
    })
  ).data;
  await f.req(`/calendar/entries/${source.id}/document`, "PUT", {
    markdown: "복제하지 않을 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  await f.create("2026-09-01", "member", "팀 회의 (1)");
  const path = `/calendar/entries/${source.id}/copy`,
    id = randomUUID();
  for (const role of ["viewer", "second", "outsider"])
    assert.equal(
      (await f.req(path, "POST", { id: randomUUID() }, role)).status,
      403,
    );
  assert.equal((await f.req(path, "POST", { id: source.id })).status, 400);
  const first = await f.req(path, "POST", { id });
  assert.equal(first.status, 201);
  assert.equal(first.data.title, "팀 회의 (2)");
  for (const key of ["date", "endDate", "tagIds", "checkedTagIds"])
    assert.deepEqual(first.data[key], source[key]);
  assert.equal(
    (await f.req(`/calendar/entries/${id}/document`)).data.markdown,
    "",
  );
  const copies = await Promise.all(
    Array.from({ length: 4 }, () => f.req(path, "POST", { id: randomUUID() })),
  );
  assert.deepEqual(copies.map((r) => r.data.title).sort(), [
    "팀 회의 (3)",
    "팀 회의 (4)",
    "팀 회의 (5)",
    "팀 회의 (6)",
  ]);
  assert.deepEqual(await f.req(path, "POST", { id }), first);
  const again = await f.req(`/calendar/entries/${id}/copy`, "POST", {
    id: randomUUID(),
  });
  assert.equal(again.data.title, "팀 회의 (7)");
  const long = (
    await f.create("2026-10-12", "member", "가".repeat(115) + "📝abc")
  ).data;
  const shortened = await f.req(`/calendar/entries/${long.id}/copy`, "POST", {
    id: randomUUID(),
  });
  assert.equal(shortened.status, 201);
  assert.equal(shortened.data.title, "가".repeat(115) + " (1)");
  assert.equal(shortened.data.title.isWellFormed(), true);
  const shared = (
    await f.req("/calendar/entries", "POST", {
      id: randomUUID(),
      teamId: f.teamId,
      userId: null,
      date: "2026-10-12",
      title: "팀 회의",
    })
  ).data;
  const sharedCopy = await f.req(
    `/calendar/entries/${shared.id}/copy`,
    "POST",
    { id: randomUUID() },
    "viewer",
  );
  assert.equal(sharedCopy.status, 201);
  assert.equal(sharedCopy.data.title, "팀 회의 (1)");
});

test("일정 즉시 삭제·실행취소는 본문·태그·체크·상대 순서를 보존하고 권한과 재시도를 검사한다", async (t) => {
  const f = await fixture(t);
  const tag = (
    await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
      id: randomUUID(),
      name: "완료",
      color: "green",
      kind: "check",
    })
  ).data;
  const payload = {
    id: randomUUID(),
    teamId: f.teamId,
    userId: f.people.member.id,
    date: "2026-10-12",
    endDate: "2026-10-14",
    title: "복원할 일정",
    tagIds: [tag.id],
    checkedTagIds: [tag.id],
  };
  const original = (await f.req("/calendar/entries", "POST", payload)).data;
  const below = (await f.create("2026-10-13", "member", "아래 일정")).data;
  const path = `/calendar/entries/${original.id}`;
  const markdown = "# 복원할 본문\n\n- [x] 완료한 내용";
  const saved = (
    await f.req(`${path}/document`, "PUT", {
      markdown,
      expectedRevision: 0,
      operationId: randomUUID(),
    })
  ).data.entry;
  const deletion = deletionFor(saved);
  const removed = await f.req(path, "DELETE", deletion);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.deletionId, deletion.deletionId);
  assert.deepEqual(removed.data.placements, [{ id: below.id, lane: 0 }]);
  assert.deepEqual(
    (await f.list()).data.entries.map((e) => e.id),
    [below.id],
  );
  assert.deepEqual(
    (await f.list("viewer", "")).data.entries.map((e) => e.id),
    [below.id],
  );
  assert.equal((await f.req(path)).status, 404);
  assert.equal((await f.req(`${path}/document`)).status, 404);
  assert.equal(
    (
      await f.req(path, "PATCH", {
        title: "삭제 중 수정",
        expectedTitle: saved.title,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.req(`${path}/tags/${tag.id}`, "PATCH", {
        checked: false,
        expectedChecked: true,
      })
    ).status,
    404,
  );
  assert.equal((await f.req("/calendar/entries", "POST", payload)).status, 409);
  assert.equal(
    (await f.req(`/calendar/teams/${f.teamId}/tags`)).data.tags[0].usageCount,
    0,
  );
  pruneDocumentVersions(f.db, f.teamId);
  assert.equal(
    f.db.prepare("SELECT markdown FROM document_versions").get().markdown,
    markdown,
  );
  const retry = await f.req(path, "DELETE", deletion);
  assert.deepEqual(retry, removed);
  assert.equal(
    (await f.req(path, "DELETE", { ...deletion, deletionId: randomUUID() }))
      .status,
    409,
  );
  const undo = {
    deletionId: deletion.deletionId,
    previousRange: { date: saved.date, endDate: saved.endDate },
  };
  for (const role of ["second", "viewer", "outsider"])
    assert.equal(
      (await f.req(`${path}/restore`, "POST", undo, role)).status,
      403,
    );
  assert.equal(
    (await f.req(`${path}/restore`, "POST", { deletionId: randomUUID() }))
      .status,
    409,
  );
  const restored = await f.req(`${path}/restore`, "POST", undo, "lead");
  assert.equal(restored.status, 200);
  for (const field of [
    "id",
    "teamId",
    "userId",
    "date",
    "endDate",
    "lane",
    "title",
    "preview",
    "revision",
    "tagIds",
    "checkedTagIds",
  ])
    assert.deepEqual(restored.data[field], saved[field], field);
  assert.deepEqual(
    Object.fromEntries(restored.data.placements.map((e) => [e.id, e.lane])),
    {
      [original.id]: 0,
      [below.id]: 1,
    },
  );
  assert.equal((await f.req(`${path}/document`)).data.markdown, markdown);
  assert.equal(
    (await f.req(`/calendar/teams/${f.teamId}/tags`)).data.tags[0].usageCount,
    1,
  );
  assert.deepEqual(
    await f.req(`${path}/restore`, "POST", undo),
    restored,
    "복구 응답 유실 재시도는 다시 저장하지 않는다",
  );
  assert.equal(
    (await f.req(path, "DELETE", deletion)).status,
    409,
    "복구된 일정에 늦은 삭제 요청을 재실행하지 않는다",
  );
  const moved = (
    await f.req(path, "PATCH", {
      date: "2026-10-16",
      endDate: "2026-10-16",
      expectedDate: saved.date,
      expectedEndDate: saved.endDate,
    })
  ).data;
  assert.deepEqual(
    (await f.req(`${path}/restore`, "POST", undo)).data,
    moved,
    "복구 뒤 편집했어도 재시도가 최신 내용과 배치를 되돌리지 않는다",
  );
  const newer = deletionFor(moved);
  assert.equal((await f.req(path, "DELETE", newer)).status, 200);
  assert.equal(
    (await f.req(`${path}/restore`, "POST", undo)).status,
    409,
    "오래된 실행취소로 새 삭제를 취소하지 않는다",
  );
  assert.equal(
    (
      await f.req(
        `${path}/restore`,
        "POST",
        { deletionId: newer.deletionId },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await f.req(path, "DELETE", deletion)).status, 409);
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

async function fixture(t, date = Date.UTC(2026, 9, 17, 3)) {
  t.mock.timers.enable({ apis: ["Date"], now: date });
  const dir = mkdtempSync(join(tmpdir(), "graeboard-calendar-"));
  const path = join(dir, "test.sqlite"),
    images = join(dir, "images");
  const db = openDatabase(path),
    teamId = randomUUID(),
    otherTeam = randomUUID();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.properties.push(
    {
      id: "condition",
      name: "준비 단계",
      kind: "option",
      display: "text",
      values: [
        {
          id: "ready-id",
          label: "준비 중",
          backgroundColor: "#ffffff",
          dotColor: "#177b70",
          emoji: "",
        },
        {
          id: "doing-id",
          label: "진행 중",
          backgroundColor: "#ffffff",
          dotColor: "#177b70",
          emoji: "",
        },
      ],
    },
    {
      id: "supporters",
      name: "지원",
      kind: "member",
      multiple: true,
      display: "text",
      values: [],
    },
    {
      id: "reviewer",
      name: "검토자",
      kind: "member",
      display: "text",
      values: [],
    },
  );
  for (const id of [teamId, otherTeam])
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      id,
      "캘린더 검증",
      json(settings),
    );
  const people = {};
  for (const role of [
    "lead",
    "member",
    "second",
    "viewer",
    "outsider",
    "admin",
  ]) {
    const id = randomUUID(),
      token = randomUUID();
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, role, role, "unused", role === "admin" ? "admin" : "user", now());
    if (role !== "admin")
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        id,
        role === "outsider" ? otherTeam : teamId,
        ["lead", "viewer"].includes(role) ? role : "member",
      );
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(token).digest("hex"),
      id,
      Date.now() + 3600000,
    );
    people[role] = { id, token };
  }
  const app = createApp({ db, rateLimits: false, documentImagesDir: images });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function req(path, method = "GET", body, role = "member") {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          Cookie: `weekly_session=${people[role].token}`,
          "X-Requested-With": "WeeklyPlan",
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : json(body) }),
      },
    );
    return {
      status: response.status,
      data: response.headers.get("content-type")?.includes("json")
        ? unpack(await response.json())
        : Buffer.from(await response.arrayBuffer()),
    };
  }
  const create = (date = "2026-10-11", role = "member", title = "일정") =>
    req(
      "/calendar/entries",
      "POST",
      { id: randomUUID(), teamId, userId: people[role].id, date, title },
      role,
    );
  const list = (
    role = "member",
    userId = people.member.id,
    from = "2026-10-01",
    to = "2026-10-31",
    team = teamId,
  ) =>
    req(
      `/calendar?${new URLSearchParams({ teamId: team, from, to, ...(userId ? { userId } : {}) })}`,
      "GET",
      undefined,
      role,
    );
  const rule = (
    role = "lead",
    expectedRevision = 0,
    filter = {
      propertyId: "condition",
      values: ["ready-id", "doing-id"],
      mode: "include",
    },
  ) =>
    req(
      `/calendar/teams/${teamId}/rule`,
      "PUT",
      {
        ...filter,
        expectedRevision,
      },
      role,
    );
  const importWeek = (
    role = "member",
    userId = people.member.id,
    weekStart = "2026-10-11",
  ) => req("/calendar/import", "POST", { teamId, userId, weekStart }, role);
  const task = (fields = {}, year = 2026, team = teamId) =>
    insertTask(db, {
      teamId: team,
      year,
      actorId: people.lead.id,
      fields: {
        title: "연간 업무",
        owner: people.member.id,
        condition: "ready-id",
        ...fields,
      },
    });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/api`,
    dir,
    path,
    db,
    images,
    people,
    teamId,
    otherTeam,
    settings,
    req,
    create,
    list,
    rule,
    importWeek,
    task,
  };
}

test("조회 범위 밖으로 이어진 배치 좌표는 개인·공용 캘린더별로만 조회한다", async (t) => {
  const f = await fixture(t);
  for (const owner of [f.people.member.id, null]) {
    const entries = [];
    for (const [date, endDate] of [
      ["2026-09-01", "2026-09-26"],
      ["2026-09-26", "2026-10-06"],
      ["2026-10-02", "2026-10-02"],
    ])
      entries.push(
        (
          await f.req("/calendar/entries", "POST", {
            id: randomUUID(),
            teamId: f.teamId,
            userId: owner,
            date,
            endDate,
            title: "연결된 일정",
          })
        ).data,
      );
    const [outside, bridge, target] = entries;
    const reordered = await f.req(`/calendar/entries/${target.id}`, "PATCH", {
      lane: 2,
      expectedLane: target.lane,
      expectedDate: target.date,
      expectedEndDate: target.endDate,
    });
    assert.equal(reordered.data.lane, 2);
    await f.req("/calendar/entries", "POST", {
      id: randomUUID(),
      teamId: f.teamId,
      userId: owner,
      date: "2025-01-01",
      title: "무관한 과거 일정",
    });
    const result = await f.req(
      `/calendar?${new URLSearchParams({ teamId: f.teamId, from: "2026-09-27", to: "2026-11-07", ...(owner ? { userId: owner } : { scope: "team" }) })}`,
    );
    assert.deepEqual(
      new Set(result.data.entries.map((item) => item.id)),
      new Set([bridge.id, target.id]),
    );
    assert.deepEqual(
      new Set(result.data.layout.map((item) => item.id)),
      new Set([outside.id, bridge.id, target.id]),
    );
    assert.ok(
      result.data.layout.every(
        (item) =>
          Object.keys(item).toSorted().join() === "date,endDate,id,lane",
      ),
    );
  }
});

test("긴 일정이 화면 밖의 새 날짜에 닿아도 미리보기 좌표와 저장 결과가 같다", async (t) => {
  const f = await fixture(t);
  const create = async (date, endDate) =>
    (
      await f.req("/calendar/entries", "POST", {
        id: randomUUID(),
        teamId: f.teamId,
        userId: f.people.member.id,
        date,
        endDate,
        title: "긴 일정 범위",
      })
    ).data;
  await create("2026-01-01", "2026-01-02");
  const target = await create("2026-01-01", "2026-03-01");
  const future = await create("2026-03-05", "2026-03-06");
  assert.equal(target.lane, 1);
  const loaded = (
    await f.list("member", f.people.member.id, "2026-02-01", "2026-02-07")
  ).data;
  assert.deepEqual(
    loaded.entries.map((item) => item.id),
    [target.id],
  );
  assert.ok(loaded.layout.some((item) => item.id === future.id));
  const changed = { ...target, date: "2026-01-07", endDate: "2026-03-07" };
  assert.equal(
    placeCalendarEntry(loaded.layout, changed).find(
      (item) => item.id === target.id,
    ).lane,
    1,
  );
  const saved = await f.req(`/calendar/entries/${target.id}`, "PATCH", {
    date: changed.date,
    endDate: changed.endDate,
    expectedDate: target.date,
    expectedEndDate: target.endDate,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.lane, 1);
  assert.ok(saved.data.layout.some((item) => item.id === future.id));
});

test("이동·재시도는 이전·새 구간의 연결된 일정만 반환하고 무관한 이력을 제외한다", async (t) => {
  const f = await fixture(t);
  const target = (await f.create("2026-10-12")).data;
  const oldNeighbor = (await f.create("2026-10-12")).data;
  const newNeighbor = (await f.create("2026-11-12")).data;
  const insert = f.db.prepare(
    "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,lane,title,updated_at,actor_id) VALUES(?,?,?,?,?,0,'이력',?,?)",
  );
  for (let index = 0; index < 1000; index++) {
    const date = addDays("2020-01-01", index);
    insert.run(
      randomUUID(),
      f.teamId,
      f.people.member.id,
      date,
      date,
      now(),
      f.people.member.id,
    );
  }
  const path = `/calendar/entries/${target.id}`;
  const move = {
    date: "2026-11-12",
    endDate: "2026-11-12",
    expectedDate: target.date,
    expectedEndDate: target.endDate,
  };
  const first = await f.req(path, "PATCH", move);
  assert.equal(first.status, 200);
  assert.deepEqual(
    new Set(first.data.placements.map((item) => item.id)),
    new Set([target.id, oldNeighbor.id, newNeighbor.id]),
  );
  assert.equal(first.data.layout.length, 3);
  assert.deepEqual(
    Object.fromEntries(
      first.data.placements.map((item) => [item.id, item.lane]),
    ),
    { [target.id]: 0, [oldNeighbor.id]: 0, [newNeighbor.id]: 1 },
  );
  assert.deepEqual((await f.req(path, "PATCH", move)).data, first.data);
  const fresh = await f.list(
    "member",
    f.people.member.id,
    "2026-11-08",
    "2026-11-14",
  );
  assert.equal(fresh.data.layout.length, 2);
  const previous = await f.req(
    `${path}?placements=1&from=${target.date}&to=${target.endDate}`,
  );
  assert.deepEqual(previous.data.placements, first.data.placements);
});

test("배치 범위는 양쪽 끝으로 이어진 긴 연쇄도 누락 없이 확장하고 분리된 일정은 읽지 않는다", async (t) => {
  const f = await fixture(t);
  const insert = f.db.prepare(
    "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,lane,title,updated_at,actor_id) VALUES(?,?,?,?,?,?,'연쇄',?,?)",
  );
  const ids = [];
  for (let index = 0; index < 160; index++) {
    const id = randomUUID();
    ids.push(id);
    insert.run(
      id,
      f.teamId,
      f.people.member.id,
      addDays("2026-01-01", index),
      addDays("2026-01-02", index),
      index,
      now(),
      f.people.member.id,
    );
  }
  await f.create("2025-06-01");
  await f.create("2026-12-01");
  const result = await f.list(
    "member",
    f.people.member.id,
    "2026-03-01",
    "2026-03-07",
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    new Set(result.data.layout.map((item) => item.id)),
    new Set(ids),
  );
  assert.equal(result.data.entries.length, 8);
});

test("기간 변경은 겹치는 카드 순서를 유지하고 비워진 날짜 구간은 위로 채운다", async (t) => {
  const f = await fixture(t);
  const a = (await f.create("2026-10-12", "member", "고정할 카드")).data;
  const b = (await f.create("2026-10-13", "member", "겹치는 카드")).data;
  const c = (await f.create("2026-10-13", "member", "다음 카드")).data;
  const other = (await f.create("2026-10-13", "second", "다른 팀원")).data;
  assert.deepEqual([a.lane, b.lane, c.lane, other.lane], [0, 0, 1, 0]);
  const range = async (entry, date, endDate) => {
    const result = await f.req(`/calendar/entries/${entry.id}`, "PATCH", {
      date,
      endDate,
      expectedDate: entry.date,
      expectedEndDate: entry.endDate,
    });
    assert.equal(result.status, 200);
    return result.data;
  };
  const lanes = async () =>
    Object.fromEntries(
      (await f.list()).data.entries.map((entry) => [entry.id, entry.lane]),
    );
  const extended = await range(a, a.date, "2026-10-14");
  assert.equal(extended.lane, 0);
  assert.deepEqual(
    (await f.req(`/calendar/entries/${a.id}?placements=1`)).data.placements,
    extended.placements,
  );
  assert.equal(
    (
      await f.req(
        `/calendar/entries/${a.id}?placements=1`,
        "GET",
        undefined,
        "outsider",
      )
    ).status,
    403,
  );
  assert.deepEqual(await lanes(), { [a.id]: 0, [b.id]: 1, [c.id]: 2 });
  assert.equal((await f.req(`/calendar/entries/${other.id}`)).data.lane, 0);
  // Retrying a response that was lost returns all current positions, without
  // pushing already displaced cards a second time.
  assert.deepEqual(
    (await range(a, a.date, "2026-10-14")).placements,
    extended.placements,
  );
  await range(extended, a.date, a.date);
  assert.deepEqual(await lanes(), { [a.id]: 0, [b.id]: 0, [c.id]: 1 });
  const before = (await f.req(`/calendar/entries/${b.id}`)).data;
  const earlier = await range(before, "2026-09-28", "2026-11-03");
  assert.equal(earlier.lane, 0);
  assert.deepEqual(await lanes(), { [a.id]: 1, [b.id]: 0, [c.id]: 1 });
  const laterWindow = await f.list(
    "member",
    f.people.member.id,
    "2026-11-01",
    "2026-11-30",
  );
  assert.equal(
    laterWindow.data.entries.find((item) => item.id === b.id).lane,
    0,
  );
  assert.equal(
    (
      await f.req(`/calendar/entries/${b.id}`, "PATCH", {
        title: "제목만 수정",
        expectedTitle: b.title,
      })
    ).data.lane,
    0,
  );
});

test("월요일 카드를 목요일로 옮기면 월~화 카드가 올라가고 같은 날짜 순서와 삭제 후 빈칸도 정리한다", async (t) => {
  const f = await fixture(t);
  const a = (await f.create("2026-10-12", "member", "이동할 월요일")).data;
  const b = (
    await f.req("/calendar/entries", "POST", {
      id: randomUUID(),
      teamId: f.teamId,
      userId: f.people.member.id,
      date: "2026-10-12",
      endDate: "2026-10-13",
      title: "월요일부터 화요일",
    })
  ).data;
  const c = (await f.create("2026-10-12", "member", "월요일 아래 카드")).data;
  const d = (await f.create("2026-10-15", "member", "기존 목요일")).data;
  const lanes = async () =>
    Object.fromEntries(
      (await f.list()).data.entries.map((item) => [item.id, item.lane]),
    );
  const move = async (entry) => {
    const body = {
      date: "2026-10-15",
      endDate: "2026-10-15",
      expectedDate: entry.date,
      expectedEndDate: entry.endDate,
    };
    const result = await f.req(`/calendar/entries/${entry.id}`, "PATCH", body);
    assert.equal(result.status, 200);
    assert.deepEqual(
      (await f.req(`/calendar/entries/${entry.id}`, "PATCH", body)).data,
      result.data,
    );
    return result.data;
  };
  await move(a);
  assert.deepEqual(await lanes(), {
    [a.id]: 0,
    [b.id]: 0,
    [c.id]: 1,
    [d.id]: 1,
  });
  const reordered = await f.req(`/calendar/entries/${c.id}`, "PATCH", {
    lane: 0,
    expectedLane: 1,
    expectedDate: c.date,
    expectedEndDate: c.endDate,
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual(await lanes(), {
    [a.id]: 0,
    [b.id]: 1,
    [c.id]: 0,
    [d.id]: 1,
  });
  const moved = await move(reordered.data);
  assert.deepEqual(await lanes(), {
    [a.id]: 1,
    [b.id]: 0,
    [c.id]: 0,
    [d.id]: 2,
  });
  const removed = await f.req(`/calendar/entries/${c.id}`, "DELETE", {
    ...deletionFor(moved),
    expectedRevision: moved.revision,
    expectedTitle: moved.title,
    expectedDate: moved.date,
    expectedEndDate: moved.endDate,
    expectedTagIds: moved.tagIds,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    Object.fromEntries(
      removed.data.placements.map((item) => [item.id, item.lane]),
    ),
    { [a.id]: 0, [d.id]: 1 },
  );
  assert.deepEqual(await lanes(), { [a.id]: 0, [b.id]: 0, [d.id]: 1 });
  const span = (await f.req(`/calendar/entries/${b.id}`)).data;
  assert.deepEqual(
    [span.date, span.endDate, span.lane],
    ["2026-10-12", "2026-10-13", 0],
  );
});

test("카드 순서는 날짜·문서와 독립적으로 저장하며 권한·충돌·재시도를 검사한다", async (t) => {
  const f = await fixture(t);
  const entries = [];
  for (const title of ["첫 카드", "둘째 카드", "셋째 카드"])
    entries.push((await f.create("2026-10-12", "member", title)).data);
  const [a, b, c] = entries;
  const disjoint = (await f.create("2026-10-19", "member", "다른 주")).data;
  const payload = {
    lane: 0,
    expectedLane: 2,
    expectedDate: c.date,
    expectedEndDate: c.endDate,
  };
  const path = `/calendar/entries/${c.id}`;
  for (const role of ["second", "viewer", "outsider"])
    assert.equal((await f.req(path, "PATCH", payload, role)).status, 403);
  for (const lane of [-1, 0.5, 10001])
    assert.equal(
      (await f.req(path, "PATCH", { ...payload, lane })).status,
      400,
    );
  const first = await f.req(path, "PATCH", payload);
  assert.equal(first.status, 200);
  const positions = (result) =>
    Object.fromEntries(
      result.data.placements.map((item) => [item.id, item.lane]),
    );
  assert.deepEqual(positions(first), {
    [a.id]: 1,
    [b.id]: 2,
    [c.id]: 0,
  });
  assert.equal((await f.req(`/calendar/entries/${disjoint.id}`)).data.lane, 0);
  assert.deepEqual((await f.req(path, "PATCH", payload)).data, first.data);
  assert.deepEqual(
    [
      first.data.date,
      first.data.endDate,
      first.data.revision,
      first.data.updatedAt,
    ],
    [c.date, c.endDate, c.revision, c.updatedAt],
  );
  const stale = await f.req(path, "PATCH", { ...payload, lane: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.details.currentRange.lane, 0);
  const lowered = await f.req(
    path,
    "PATCH",
    { ...payload, lane: 2, expectedLane: 0 },
    "lead",
  );
  assert.equal(lowered.status, 200);
  assert.deepEqual(positions(lowered), {
    [a.id]: 0,
    [b.id]: 1,
    [c.id]: 2,
  });
  await f.req(path, "PATCH", {
    date: "2026-10-13",
    endDate: "2026-10-13",
    expectedDate: c.date,
    expectedEndDate: c.endDate,
  });
  assert.equal((await f.req(path, "PATCH", payload)).status, 409);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("달력은 일요일 주 키와 인접 월 경계 주·윤년·연도·타임존 경계를 처리한다", () => {
  assert.deepEqual(monthWeeks("2026-02"), [
    "2026-01-25",
    "2026-02-01",
    "2026-02-08",
    "2026-02-15",
    "2026-02-22",
    "2026-03-01",
  ]);
  assert.equal(monthWeeks("2024-02").length, 5);
  assert.equal(monthWeeks("2026-08").length, 6);
  assert.equal(monthWeeks("2026-10").at(-1), "2026-11-01");
  assert.equal(monthWeeks("2026-03")[0], "2026-02-22");
  assert.deepEqual(
    moveCalendarRange(
      { date: "2024-02-28", endDate: "2024-03-02" },
      "move",
      "2024-02-29",
      "2024-03-01",
    ),
    { date: "2024-02-29", endDate: "2024-03-03" },
  );
  assert.deepEqual(
    moveCalendarRange(
      { date: "2026-12-30", endDate: "2026-12-30" },
      "end",
      "2026-12-30",
      "2027-01-05",
    ),
    { date: "2026-12-30", endDate: "2027-01-05" },
  );
  assert.equal(calendarWeek("2027-01-01"), "2026-12-27");
  assert.equal(moveMonth("2026-12", 1), "2027-01");
  assert.equal(moveMonth("2026-01", -1), "2025-12");
  for (const zone of [
    "Asia/Seoul",
    "America/Los_Angeles",
    "Pacific/Kiritimati",
  ]) {
    const previous = process.env.TZ;
    try {
      process.env.TZ = zone;
      assert.equal(addDays("2024-02-28", 1), "2024-02-29");
      assert.equal(addDays("2024-02-29", 1), "2024-03-01");
      assert.equal(addDays("2026-03-08", 1), "2026-03-09");
      assert.equal(calendarWeek("2026-11-01"), "2026-11-01");
      assert.ok(
        weeksForYear(2027).some(
          (week) => week.key === addDays("2026-12-27", 1),
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }
});

test("개인 요일 설정은 사용자별로 저장하며 숨긴 날짜의 일정과 다른 사용자를 바꾸지 않는다", async (t) => {
  const f = await fixture(t);
  const sunday = (await f.create()).data;
  assert.deepEqual(
    (await f.req("/calendar/preferences")).data.weekdays,
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(
    (await f.req("/calendar/preferences", "PUT", { weekdays: [] })).status,
    400,
  );
  assert.equal(
    (await f.req("/calendar/preferences", "PUT", { weekdays: [7] })).status,
    400,
  );
  assert.equal(
    (
      await f.req("/calendar/preferences", "PUT", {
        weekdays: [1, 2, 3, 4],
        userId: f.people.second.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.req("/calendar/preferences", "PUT", { weekdays: [1, 2, 3, 4] }))
      .status,
    200,
  );
  assert.deepEqual(
    (await f.req("/calendar/preferences")).data.weekdays,
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    (await f.req("/calendar/preferences", "GET", undefined, "second")).data
      .weekdays,
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal((await f.list()).data.entries[0].id, sunday.id);
  assert.equal((await f.list()).data.entries[0].date, "2026-10-11");
});

test("캘린더는 기간·팀·팀원을 제한하고 구성원 조회와 본인/팀장 수정 권한을 서버에서 강제한다", async (t) => {
  const f = await fixture(t);
  const entry = (await f.create()).data,
    path = `/calendar/entries/${entry.id}`;
  await f.create("2026-10-12", "second", "다른 팀원");
  await f.create("2026-11-10");
  assert.equal((await f.list()).data.entries.length, 1);
  assert.equal((await f.list("viewer", "")).data.entries.length, 2);
  assert.equal((await f.list("outsider")).status, 403);
  assert.equal((await f.list("member", f.people.outsider.id)).status, 404);
  assert.equal(
    (await f.list("member", "", "2026-01-01", "2026-12-31")).status,
    400,
  );
  assert.equal(
    (await f.list("member", "", "2026-02-30", "2026-03-01")).status,
    400,
  );
  for (const role of ["second", "viewer", "outsider"]) {
    assert.equal(
      (
        await f.req(
          path,
          "PATCH",
          { title: "침범", expectedTitle: "일정" },
          role,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.req(
          `${path}/document`,
          "PUT",
          { markdown: "침범", expectedRevision: 0, operationId: randomUUID() },
          role,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.req(
          path,
          "DELETE",
          {
            ...deletionFor(entry),
            expectedRevision: 0,
            expectedTitle: "일정",
            expectedDate: "2026-10-11",
            expectedEndDate: "2026-10-11",
          },
          role,
        )
      ).status,
      403,
    );
  }
  assert.equal((await f.create("2026-10-11", "viewer")).status, 403);
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { title: "팀장 수정", expectedTitle: "일정" },
        "lead",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { title: "관리자 수정", expectedTitle: "팀장 수정" },
        "admin",
      )
    ).status,
    200,
  );
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.people.member.id);
  assert.equal((await f.req(path, "GET", undefined, "lead")).status, 404);
  assert.equal((await f.list("lead", "")).data.entries.length, 1);
});

test("팀장 기준은 안정적인 속성/옵션 ID를 사용하고 권한·충돌·이름 변경·삭제를 처리한다", async (t) => {
  const f = await fixture(t);
  f.task();
  assert.equal((await f.importWeek()).status, 400);
  for (const role of ["member", "viewer", "outsider"])
    assert.equal((await f.rule(role)).status, 403);
  assert.equal((await f.rule()).status, 200);
  assert.equal((await f.rule()).status, 409);
  assert.equal((await f.rule("admin", 1)).status, 200);
  const properties = structuredClone(f.settings.properties);
  properties.find((p) => p.id === "condition").name = "이름 변경";
  properties.find((p) => p.id === "condition").values[0].label = "새 표시 이름";
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties },
        "lead",
      )
    ).status,
    200,
  );
  assert.equal((await f.importWeek()).data.added, 1);
  properties.find((p) => p.id === "condition").values.shift();
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties },
        "lead",
      )
    ).status,
    200,
  );
  assert.match(
    (await f.req(`/calendar/teams/${f.teamId}`)).data.ruleProblem,
    /옵션/,
  );
  assert.equal((await f.importWeek()).status, 400);
  assert.equal(
    (await f.list()).data.weekly.length,
    1,
    "기준 삭제도 이전 가져오기 기록을 지우지 않는다",
  );
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties: properties.filter((p) => p.id !== "condition") },
        "lead",
      )
    ).status,
    200,
  );
  assert.match(
    (await f.req(`/calendar/teams/${f.teamId}`)).data.ruleProblem,
    /속성/,
  );
});

test("주간 기준은 허용된 속성의 일치·제외·미지정을 연간 필터와 동일하게 가져온다", async (t) => {
  const f = await fixture(t);
  const properties = [
    ...f.settings.properties,
    ...[
      ["memo", "메모", "text"],
      ["due", "예정일", "date"],
      ["score", "점수", "number"],
    ].map(([id, name, kind]) => ({
      id,
      name,
      kind,
      display: "text",
      values: [],
      visible: false,
    })),
  ];
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties },
        "lead",
      )
    ).status,
    200,
  );
  const aFields = {
    title: "알파",
    memo: "검토",
    due: "2026-10-14",
    score: 0,
    reviewer: f.people.member.id,
    supporters: [f.people.second.id, f.people.lead.id],
  };
  const rows = [
    f.task(aFields),
    f.task({
      title: "베타",
      condition: "doing-id",
      memo: "배포",
      due: "2026-10-15",
      score: 7,
      reviewer: f.people.second.id,
      supporters: [f.people.second.id],
    }),
    f.task({
      title: "감마",
      condition: "",
      memo: "",
      due: "",
      score: "",
      reviewer: "",
      supporters: [],
    }),
    f.task({ title: "델타" }),
  ];
  f.db
    .prepare(
      "DELETE FROM cells WHERE task_id=? AND key NOT IN ('title','owner')",
    )
    .run(rows[3].id);
  rows[3].cells = Object.fromEntries(
    Object.entries(rows[3].cells).filter(([key]) =>
      ["title", "owner"].includes(key),
    ),
  );
  // 같은 값이어도 팀·연도·삭제 여부·담당 범위 밖의 업무는 가져오지 않는다.
  f.task(aFields, 2025);
  f.task(aFields, 2027);
  f.task(aFields, 2026, f.otherTeam);
  f.task({ ...aFields, owner: f.people.lead.id });
  const deleted = f.task(aFields);
  f.db
    .prepare("UPDATE tasks SET deleted_at=? WHERE id=?")
    .run(now(), deleted.id);
  const cases = [
    ["condition", ["ready-id"], [0]],
    ["condition", ["ready-id", "doing-id"], [0, 1]],
    ["condition", [""], [2, 3]],
    ["memo", ["검토", "배포"], [0, 1]],
    ["memo", [""], [2, 3]],
    ["due", ["2026-10-14"], [0]],
    ["due", [""], [2, 3]],
    ["score", ["0"], [0]],
    ["score", [""], [2, 3]],
    ["reviewer", [f.people.member.id], [0]],
    ["reviewer", [""], [2, 3]],
    ["supporters", [f.people.second.id], [0, 1]],
    ["supporters", [""], [2, 3]],
    ["supporters", [f.people.lead.id, ""], [0, 2, 3]],
    ["condition", [], [0, 1, 2, 3]],
  ];
  let revision = 0;
  for (const [propertyId, values, indices] of cases) {
    for (const mode of ["include", "exclude"]) {
      const label = JSON.stringify({ propertyId, values, mode });
      const saved = await f.rule("lead", revision, {
        propertyId,
        values,
        mode,
      });
      assert.equal(saved.status, 200, label);
      assert.deepEqual(saved.data.rule, {
        propertyId,
        values,
        mode,
        revision: ++revision,
      });
      assert.deepEqual(
        (await f.req(`/calendar/teams/${f.teamId}`)).data.rule,
        saved.data.rule,
      );
      const expected = rows
        .filter(
          (_, index) =>
            !values.length ||
            (mode === "exclude"
              ? !indices.includes(index)
              : indices.includes(index)),
        )
        .map((task) => task.id);
      const view = {
        ...defaultView(2026),
        propertyFilters: { [propertyId]: values },
        propertyFilterModes: { [propertyId]: mode },
      };
      assert.deepEqual(
        new Set(filteredTasks(rows, view).map((task) => task.id)),
        new Set(expected),
        label,
      );
      const imported = await f.importWeek();
      assert.equal(imported.status, 200, label);
      assert.deepEqual(
        new Set(imported.data.weekly.map((item) => item.taskId)),
        new Set(expected),
        label,
      );
      assert.equal(imported.data.matched, expected.length, label);
      const retry = await f.importWeek();
      assert.equal(retry.data.added, 0, label);
      assert.equal(retry.data.existing, expected.length, label);
      f.db
        .prepare("DELETE FROM calendar_weekly_items WHERE team_id=?")
        .run(f.teamId);
    }
  }
});

test("주간 필터는 잘못된 속성·값·방식을 거절하고 제외 조건도 기존 목록을 보존한다", async (t) => {
  const f = await fixture(t);
  const filter = {
    propertyId: "condition",
    values: ["ready-id"],
    mode: "exclude",
  };
  for (const invalid of [
    { mode: "invalid" },
    { values: null },
    { values: [0] },
    { values: Array(102).fill("ready-id") },
    { values: ["x".repeat(10001)] },
    { values: ["없는 옵션"] },
    { propertyId: "없는 속성" },
    { propertyId: "title" },
    { propertyId: "owner" },
  ])
    assert.equal(
      (await f.rule("lead", 0, { ...filter, ...invalid })).status,
      400,
    );
  const archived = structuredClone(f.settings.properties);
  archived.find((p) => p.id === "condition").archived = true;
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties: archived },
        "lead",
      )
    ).status,
    200,
  );
  assert.equal((await f.rule("lead", 0, filter)).status, 400);
  assert.equal(
    (
      await f.req(
        `/teams/${f.teamId}/settings`,
        "PATCH",
        { properties: f.settings.properties },
        "lead",
      )
    ).status,
    200,
  );
  const done = f.task({ title: "진행 중 업무", condition: "doing-id" });
  const ready = f.task({ title: "준비 중 업무" });
  f.task({ owner: "", condition: "doing-id" });
  f.task({ owner: "" });
  assert.equal((await f.rule("lead", 0, filter)).status, 200);
  const first = await f.importWeek();
  assert.deepEqual(
    first.data.weekly.map((task) => task.taskId),
    [done.id],
  );
  assert.equal(first.data.unassigned, 1);
  assert.equal(
    f.db.prepare("SELECT filter_mode FROM calendar_rules").get().filter_mode,
    "exclude",
  );
  const changed = await f.rule("lead", 1, {
    ...filter,
    values: ["ready-id", "ready-id"],
    mode: "include",
  });
  assert.deepEqual(changed.data.rule.values, ["ready-id"]);
  assert.deepEqual(
    (await f.list()).data.weekly.map((task) => task.taskId),
    [done.id],
  );
  assert.deepEqual(
    new Set((await f.importWeek()).data.weekly.map((task) => task.taskId)),
    new Set([done.id, ready.id]),
  );
});

test("기존에 저장된 작업·팀원 기준도 가져오기를 막고 다른 속성으로 다시 설정한다", async (t) => {
  const f = await fixture(t);
  const own = f.task();
  for (const [propertyId, value] of [
    ["title", "연간 업무"],
    ["owner", f.people.member.id],
  ]) {
    f.db
      .prepare(
        "INSERT OR REPLACE INTO calendar_rules(team_id,property_id,filter_values,filter_mode,revision) VALUES(?,?,?,'include',1)",
      )
      .run(f.teamId, propertyId, json([value]));
    const context = await f.req(`/calendar/teams/${f.teamId}`);
    assert.match(context.data.ruleProblem, /작업과 팀원 속성/);
    const imported = await f.importWeek();
    assert.equal(imported.status, 400);
    assert.match(imported.data.error, /작업과 팀원 속성/);
    assert.equal((await f.list()).data.weekly.length, 0);
  }
  assert.equal((await f.rule("lead", 1)).status, 200);
  assert.deepEqual(
    (await f.importWeek()).data.weekly.map((item) => item.taskId),
    [own.id],
  );
});

test("명시적 가져오기는 팀원이 본인인 업무만 포함하고 지원·검토 참여와 재시도를 구분한다", async (t) => {
  const f = await fixture(t);
  const own = f.task({
    title: "본인 담당",
    supporters: [f.people.member.id, f.people.second.id],
  });
  f.task({
    title: "지원 담당",
    owner: f.people.lead.id,
    supporters: [f.people.member.id, f.people.second.id],
    condition: "doing-id",
  });
  f.task({
    title: "검토자는 담당자 아님",
    owner: f.people.lead.id,
    reviewer: f.people.member.id,
  });
  f.task({ title: "미지정", owner: "" });
  f.task({
    title: "담당자 없이 지원만 참여",
    owner: "",
    supporters: [f.people.member.id],
  });
  const secondOwn = f.task({
    title: "다른 팀원 담당",
    owner: f.people.second.id,
    supporters: [f.people.member.id],
  });
  f.task({ title: "다른 상태", condition: "" });
  f.task({ title: "다른 연도" }, 2025);
  f.task({ title: "다른 팀" }, 2026, f.otherTeam);
  f.task({ title: "다음 연도" }, 2027);
  await f.rule();
  await f.req(`/calendar/teams/${f.teamId}`);
  await f.list();
  await f.list("member", f.people.member.id, "2026-11-01", "2026-11-30");
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM calendar_weekly_items").get().n,
    0,
  );
  const first = await f.importWeek();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(
    {
      added: first.data.added,
      existing: first.data.existing,
      unassigned: first.data.unassigned,
    },
    { added: 1, existing: 0, unassigned: 2 },
  );
  const repeated = await Promise.all([f.importWeek(), f.importWeek()]);
  assert.ok(repeated.every((r) => r.data.added === 0 && r.data.existing === 1));
  assert.deepEqual(
    new Set((await f.list()).data.weekly.map((item) => item.taskId)),
    new Set([own.id]),
  );
  assert.equal((await f.importWeek("member", f.people.second.id)).status, 403);
  const second = await f.importWeek("second", f.people.second.id);
  assert.equal(second.data.added, 1);
  assert.deepEqual(
    second.data.weekly.map((item) => item.taskId),
    [secondOwn.id],
  );
  assert.equal((await f.importWeek("viewer", f.people.viewer.id)).status, 403);
  assert.equal(
    (await f.importWeek("member", f.people.member.id, "2026-10-12")).status,
    400,
  );
  for (const week of ["2026-10-04", "2026-10-18", "2026-12-27"]) {
    const rejected = await f.importWeek("member", f.people.member.id, week);
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /이번 주/);
  }
  assert.equal((await f.list()).data.weekly.length, 1);
  f.db
    .prepare("UPDATE cells SET value=? WHERE task_id=? AND key='condition'")
    .run(json(""), own.id);
  const addedMidweek = f.task({ title: "주중에 새로 생긴 업무" });
  const refreshed = await f.importWeek();
  assert.equal(refreshed.data.added, 1);
  assert.deepEqual(
    new Set(refreshed.data.weekly.map((item) => item.taskId)),
    new Set([own.id, addedMidweek.id]),
  );
});

test("이번 주 가져오기는 서울 일요일 경계와 두 연도에 걸친 주를 처리한다", async (t) => {
  // 토요일 UTC이지만 서울에서는 일요일: 이 주에 걸친 양쪽 연도의 업무를 포함한다.
  const f = await fixture(t, Date.UTC(2026, 11, 26, 15));
  const currentYear = f.task({ title: "올해 업무" }, 2026);
  const nextYear = f.task({ title: "다음 연도" }, 2027);
  f.task({ title: "그 이전 연도" }, 2025);
  await f.rule();
  assert.equal(
    (await f.importWeek("member", f.people.member.id, "2026-12-20")).status,
    400,
  );
  assert.equal(
    (await f.importWeek("member", f.people.member.id, "2026-12-27")).data.added,
    2,
  );
  assert.deepEqual(
    new Set(
      (
        await f.list("member", f.people.member.id, "2026-12-27", "2027-01-02")
      ).data.weekly.map((item) => item.taskId),
    ),
    new Set([currentYear.id, nextYear.id]),
  );
});

test("직접 선택한 업무는 상태·담당자·연도와 무관하게 과거·현재·미래 주에 연결하고 원본 제목을 따른다", async (t) => {
  const f = await fixture(t);
  const completed = f.task(
    {
      title: "과거 누락 업무",
      owner: f.people.second.id,
      condition: "",
      status: "status-completed",
    },
    2024,
  );
  const planned = f.task(
    {
      title: "미래 예정 업무",
      owner: "",
      condition: "",
      status: "status-planned",
    },
    2027,
  );
  const original = {
    tasks: f.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    cells: f.db.prepare("SELECT * FROM cells ORDER BY task_id,key").all(),
  };
  const weeks = ["2026-10-04", "2026-10-11", "2026-10-18"];
  const add = (weekStart) =>
    f.req("/calendar/weekly", "POST", {
      teamId: f.teamId,
      userId: f.people.member.id,
      weekStart,
      taskIds: [completed.id, planned.id],
    });
  for (const week of weeks) {
    const result = await add(week);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.added, 2);
    assert.equal(result.data.existing, 0);
    assert.equal(result.data.weekly.length, 2);
    assert.ok(
      result.data.weekly.every(
        (item) => item.weekStart === week && item.userId === f.people.member.id,
      ),
    );
  }
  const retried = await Promise.all([add(weeks[0]), add(weeks[0])]);
  assert.ok(retried.every((r) => r.data.added === 0 && r.data.existing === 2));
  assert.equal((await f.list()).data.weekly.length, 6);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    original.tasks,
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM cells ORDER BY task_id,key").all(),
    original.cells,
  );
  assert.equal(
    (await f.list()).data.entries.length,
    0,
    "날짜 일정은 복제하지 않는다",
  );

  const changed = await f.req(
    "/cells/batch",
    "POST",
    {
      operationId: randomUUID(),
      createdAt: now(),
      changes: [
        {
          taskId: completed.id,
          key: "title",
          value: "원본에서 바꾼 업무 제목",
          expectedVersion: completed.cells.title.version,
        },
      ],
    },
    "lead",
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const linked = (await f.list()).data.weekly.filter(
    (item) => item.taskId === completed.id,
  );
  assert.equal(linked.length, 3);
  assert.ok(linked.every((item) => item.title === "원본에서 바꾼 업무 제목"));
  f.task({ title: "연결 뒤 생긴 업무" });
  assert.equal(
    (await f.list()).data.weekly.length,
    6,
    "새 업무는 주간 목록에 자동 추가하지 않는다",
  );
});

test("주간 업무 선택은 대상 사용자 권한과 모든 업무 ID를 검사하고 실패 시 일부도 추가하지 않는다", async (t) => {
  const f = await fixture(t);
  const active = f.task(),
    removed = f.task(),
    foreign = f.task({}, 2026, f.otherTeam);
  f.db
    .prepare("UPDATE tasks SET deleted_at=? WHERE id=?")
    .run(now(), removed.id);
  const payload = {
    teamId: f.teamId,
    userId: f.people.member.id,
    weekStart: "2026-10-04",
    taskIds: [active.id],
  };
  for (const taskIds of [
    [],
    [active.id, active.id],
    [active.id, removed.id],
    [active.id, foreign.id],
    [active.id, randomUUID()],
  ])
    assert.equal(
      (await f.req("/calendar/weekly", "POST", { ...payload, taskIds })).status,
      400,
    );
  for (const fields of [{ weekStart: "2026-10-05" }, { userId: null }])
    assert.equal(
      (await f.req("/calendar/weekly", "POST", { ...payload, ...fields }))
        .status,
      400,
    );
  for (const [role, userId] of [
    ["viewer", f.people.viewer.id],
    ["member", f.people.second.id],
    ["outsider", f.people.member.id],
  ])
    assert.equal(
      (await f.req("/calendar/weekly", "POST", { ...payload, userId }, role))
        .status,
      403,
    );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM calendar_weekly_items").get().n,
    0,
  );
  for (const role of ["lead", "admin"]) {
    const result = await f.req(
      "/calendar/weekly",
      "POST",
      { ...payload, userId: f.people.second.id },
      role,
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.weekly.length, 1);
  }
  assert.equal(
    (await f.list("member", f.people.second.id)).data.weekly.length,
    1,
  );
  assert.equal((await f.list()).data.weekly.length, 0);
});

test("업무 선택 검색은 활성 팀 업무만 페이지로 반환하며 검색어와 주별 중복을 구분한다", async (t) => {
  const f = await fixture(t);
  const planned = f.task(
    {
      title: "Search 100% 예정 CAFÉ 한글".normalize("NFD"),
      owner: "",
      condition: "",
    },
    2027,
  );
  const old = f.task({ title: "Search 과거", owner: f.people.second.id }, 2024);
  const removed = f.task({ title: "Search 삭제됨" });
  f.db
    .prepare("UPDATE tasks SET deleted_at=? WHERE id=?")
    .run(now(), removed.id);
  f.task({ title: "Search 타 팀" }, 2026, f.otherTeam);
  for (let i = 0; i < 50; i++) f.task({ title: `Search 업무 ${i}` });
  const scope = {
    teamId: f.teamId,
    userId: f.people.member.id,
    weekStart: "2026-10-04",
  };
  const search = (params = {}, role = "member") =>
    f.req(
      `/calendar/tasks?${new URLSearchParams({ ...scope, ...params })}`,
      "GET",
      undefined,
      role,
    );
  const first = await search({ q: " SEARCH " });
  assert.equal(first.status, 200);
  assert.equal(first.data.tasks.length, 50);
  assert.equal(first.data.nextOffset, 50);
  const second = await search({ q: "search", offset: "50" });
  assert.equal(second.data.tasks.length, 2);
  assert.equal(second.data.nextOffset, null);
  const options = [...first.data.tasks, ...second.data.tasks];
  assert.equal(new Set(options.map((item) => item.id)).size, 52);
  assert.ok(
    options.some((item) => item.id === old.id && item.years.includes(2024)),
  );
  assert.deepEqual(
    (await search({ q: "%" })).data.tasks.map((item) => item.id),
    [planned.id],
  );
  for (const q of ["café", "한글"])
    assert.deepEqual(
      (await search({ q })).data.tasks.map((item) => item.id),
      [planned.id],
    );
  assert.equal((await search({ q: "없음" })).data.tasks.length, 0);
  assert.equal((await search({}, "outsider")).status, 403);
  assert.equal((await search({ userId: f.people.outsider.id })).status, 404);
  assert.equal((await search({ weekStart: "2026-10-05" })).status, 400);
  assert.equal((await search({ offset: "-1" })).status, 400);
  await f.req("/calendar/weekly", "POST", { ...scope, taskIds: [planned.id] });
  assert.equal((await search({ q: "%" })).data.tasks[0].added, true);
  assert.equal(
    (await search({ q: "%", weekStart: "2026-10-18" })).data.tasks[0].added,
    false,
  );
  assert.equal(
    (await search({ q: "%", userId: f.people.second.id })).data.tasks[0].added,
    false,
  );
});

test("가져온 작업 링크는 실제 작업을 조회하고 속성 변경/삭제 이후도 안전하다", async (t) => {
  const f = await fixture(t),
    task = f.task();
  await f.rule();
  await f.importWeek();
  const fetched = await f.req(`/calendar/tasks/${task.id}`);
  assert.equal(fetched.data.task.id, task.id);
  const changed = await f.req("/cells/batch", "POST", {
    operationId: randomUUID(),
    createdAt: now(),
    changes: [
      {
        taskId: task.id,
        key: "title",
        value: "실제 업무 이름 변경",
        expectedVersion: fetched.data.task.cells.title.version,
      },
    ],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await f.list()).data.weekly[0].title, "실제 업무 이름 변경");
  f.db.prepare("UPDATE tasks SET deleted_at=? WHERE id=?").run(now(), task.id);
  assert.equal((await f.req(`/calendar/tasks/${task.id}`)).status, 404);
  assert.equal((await f.list()).data.weekly[0].unavailable, true);
  assert.equal(
    (await f.req(`/calendar/tasks/${task.id}`, "GET", undefined, "outsider"))
      .status,
    404,
  );
});

test("날짜 일정 생성·본문 저장·충돌·삭제가 연간 업무나 주간 기록을 변경하지 않는다", async (t) => {
  const f = await fixture(t),
    task = f.task();
  await f.rule();
  await f.importWeek();
  const id = randomUUID(),
    payload = {
      id,
      teamId: f.teamId,
      userId: f.people.member.id,
      date: "2024-02-29",
      title: "윤일 기록",
    };
  assert.equal(
    (
      await f.req("/calendar/entries", "POST", {
        ...payload,
        date: "2023-02-29",
      })
    ).status,
    400,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.req("/calendar/entries", "POST", payload)).status,
      201,
    );
  const path = `/calendar/entries/${id}`;
  const content = {
    markdown:
      "# 한국어\n\n- [ ] 업무\n\n| 표 | 값 |\n| --- | --- |\n| 날짜 | 2/29 |",
    expectedRevision: 0,
    operationId: randomUUID(),
  };
  const saved = await f.req(`${path}/document`, "PUT", content);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.revision, 1);
  assert.equal(
    (await f.req(`${path}/document`, "PUT", content)).data.revision,
    1,
  );
  const conflict = await f.req(`${path}/document`, "PUT", {
    ...content,
    markdown: "충돌",
    operationId: randomUUID(),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details.current.markdown, content.markdown);
  assert.equal(
    (
      await f.req(`${path}/document`, "PUT", {
        ...content,
        markdown: "가".repeat(MAX_DOCUMENT_BYTES / 2),
        expectedRevision: 1,
      })
    ).status,
    400,
  );
  const listed = (
    await f.list("member", f.people.member.id, "2024-02-25", "2024-03-02")
  ).data.entries;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].markdown, undefined, "목록 조회에 본문을 싣지 않는다");
  assert.ok(listed[0].preview.includes("한국어"));
  assert.equal(
    (
      await f.req(path, "PATCH", {
        title: "새 제목",
        expectedTitle: "오래된 제목",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(path, "DELETE", {
        ...deletionFor(listed[0]),
        expectedRevision: 0,
        expectedTitle: "윤일 기록",
        expectedDate: "2024-02-29",
        expectedEndDate: "2024-02-29",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(path, "DELETE", {
        ...deletionFor(listed[0]),
        expectedRevision: 1,
        expectedTitle: "윤일 기록",
        expectedDate: "2024-02-29",
        expectedEndDate: "2024-02-29",
      })
    ).status,
    200,
  );
  assert.equal((await f.req(`${path}/document`)).status, 404);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tasks").get().n, 1);
  assert.equal((await f.list()).data.weekly[0].taskId, task.id);
});

test("기간 일정은 겹치는 범위에 한 번 조회되고 이동·재시도·충돌·권한을 검사한다", async (t) => {
  const f = await fixture(t);
  const single = (await f.create("2024-02-29")).data;
  assert.equal(single.endDate, single.date);
  const id = randomUUID();
  const payload = {
    id,
    teamId: f.teamId,
    userId: f.people.member.id,
    date: "2026-12-28",
    endDate: "2027-01-05",
    title: "연말 일정",
  };
  assert.equal(
    (
      await f.req("/calendar/entries", "POST", {
        ...payload,
        endDate: "2026-12-27",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req("/calendar/entries", "POST", {
        ...payload,
        endDate: "2027-02-29",
      })
    ).status,
    400,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.req("/calendar/entries", "POST", payload)).status,
      201,
    );
  const path = `/calendar/entries/${id}`;
  for (const [from, to] of [
    ["2026-12-28", "2026-12-28"],
    ["2027-01-01", "2027-01-02"],
    ["2027-01-05", "2027-01-05"],
  ]) {
    const entries = (await f.list("member", f.people.member.id, from, to)).data
      .entries;
    assert.deepEqual(
      entries.map((item) => item.id),
      [id],
    );
    assert.equal(entries[0].endDate, "2027-01-05");
  }
  assert.equal(
    (await f.list("member", f.people.member.id, "2027-01-06", "2027-01-07"))
      .data.entries.length,
    0,
  );
  const move = {
    date: "2026-12-30",
    endDate: "2027-01-07",
    expectedDate: payload.date,
    expectedEndDate: payload.endDate,
  };
  for (const role of ["second", "viewer", "outsider"])
    assert.equal((await f.req(path, "PATCH", move, role)).status, 403);
  assert.equal(
    (await f.req(path, "PATCH", { date: move.date, endDate: move.endDate }))
      .status,
    400,
  );
  assert.equal(
    (await f.req(path, "PATCH", { ...move, endDate: "2026-12-29" })).status,
    400,
  );
  const body = {
    markdown: "# 유지할 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  };
  await f.req(`${path}/document`, "PUT", body);
  for (let i = 0; i < 2; i++)
    assert.equal((await f.req(path, "PATCH", move)).status, 200);
  assert.equal((await f.req(`${path}/document`)).data.markdown, body.markdown);
  const collision = await f.req(path, "PATCH", {
    ...move,
    endDate: "2027-01-09",
  });
  assert.equal(collision.status, 409);
  assert.deepEqual(collision.data.details.currentRange, {
    date: move.date,
    endDate: move.endDate,
  });
  const removal = {
    ...deletionFor((await f.req(path)).data),
    expectedRevision: 1,
    expectedTitle: payload.title,
    expectedDate: payload.date,
    expectedEndDate: payload.endDate,
  };
  assert.equal((await f.req(path, "DELETE", removal)).status, 409);
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        {
          ...move,
          date: "2026-12-29",
          expectedDate: move.date,
          expectedEndDate: move.endDate,
        },
        "lead",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(path, "DELETE", {
        ...removal,
        expectedUpdatedAt: (await f.req(path)).data.updatedAt,
        expectedDate: "2026-12-29",
        expectedEndDate: move.endDate,
      })
    ).status,
    200,
  );
});

test("캘린더 이미지의 공통 업로드·권한·백업 복구와 문서 참조 정리가 일관된다", async (t) => {
  const f = await fixture(t),
    entry = (await f.create()).data;
  const path = `/calendar/entries/${entry.id}/document`;
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#177b70" },
  })
    .png()
    .toBuffer();
  const body = () => {
    const data = new FormData();
    data.append("image", new Blob([png], { type: "image/png" }), "image.png");
    return data;
  };
  assert.equal(
    (await f.req(`${path}/images`, "POST", body(), "second")).status,
    403,
  );
  const uploaded = await f.req(`${path}/images`, "POST", body());
  assert.equal(uploaded.status, 201);
  assert.ok(uploaded.data.url.includes(f.teamId));
  const markdown = `![캘린더 이미지](${uploaded.data.url})`;
  const save = (text, revision = 0) =>
    f.req(path, "PUT", {
      markdown: text,
      expectedRevision: revision,
      operationId: randomUUID(),
    });
  assert.equal(
    (await save(markdown.replace(f.teamId, f.otherTeam))).status,
    400,
  );
  assert.equal((await save(markdown)).status, 200);
  pruneDocumentVersions(f.db, f.teamId);
  assert.equal((await f.req(path)).data.markdown, markdown);
  assert.equal(
    (await f.req(uploaded.data.url.slice(4), "GET", undefined, "outsider"))
      .status,
    403,
  );
  await f.req("/calendar/preferences", "PUT", { weekdays: [1, 2, 3, 4] });
  f.task();
  await f.rule();
  await f.importWeek();
  assert.equal(
    (
      await f.req(`/calendar/entries/${entry.id}`, "PATCH", {
        date: "2026-10-10",
        endDate: "2026-11-02",
        expectedDate: entry.date,
        expectedEndDate: entry.endDate,
      })
    ).status,
    200,
  );
  const tag = (
    await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
      id: randomUUID(),
      name: "백업 태그",
      color: "blue",
      kind: "check",
    })
  ).data;
  assert.equal(
    (
      await f.req(`/calendar/entries/${entry.id}`, "PATCH", {
        tagIds: [tag.id],
        expectedTagIds: [],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(`/calendar/entries/${entry.id}`, "PATCH", {
        lane: 3,
        expectedLane: 0,
        expectedDate: "2026-10-10",
        expectedEndDate: "2026-11-02",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(`/calendar/entries/${entry.id}/tags/${tag.id}`, "PATCH", {
        checked: true,
        expectedChecked: false,
      })
    ).status,
    200,
  );
  const deletion = deletionFor(
    (await f.req(`/calendar/entries/${entry.id}`)).data,
  );
  assert.equal(
    (await f.req(`/calendar/entries/${entry.id}`, "DELETE", deletion)).status,
    200,
  );
  pruneDocumentVersions(f.db, f.teamId);
  assert.equal((await f.req(path)).status, 404);
  assert.equal((await f.req(`${path}/images`, "POST", body())).status, 404);
  const backup = backupDatabase(f.path, join(f.dir, "backup.sqlite"), {
    documentImagesDir: f.images,
  });
  const restoredPath = restoreDatabase(backup, join(f.dir, "restored.sqlite"), {
    documentImagesDir: join(f.dir, "restored-images"),
  });
  const restored = openDatabase(restoredPath);
  try {
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM calendar_entries").get().n,
      1,
    );
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM calendar_weekly_items").get().n,
      1,
    );
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM calendar_rules").get().n,
      1,
    );
    assert.equal(
      restored.prepare("SELECT weekdays FROM calendar_preferences").get()
        .weekdays,
      "[1,2,3,4]",
    );
    assert.equal(
      restored.prepare("SELECT markdown FROM document_versions").get().markdown,
      markdown,
    );
    assert.deepEqual(
      {
        ...restored
          .prepare("SELECT date,end_date,lane FROM calendar_entries")
          .get(),
      },
      { date: "2026-10-10", end_date: "2026-11-02", lane: 0 },
    );
    assert.equal(restored.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      restored.prepare("SELECT name FROM calendar_tags").get().name,
      "백업 태그",
    );
    assert.equal(
      restored.prepare("SELECT tag_id FROM calendar_entry_tags").get().tag_id,
      tag.id,
    );
    assert.equal(
      restored.prepare("SELECT kind FROM calendar_tags").get().kind,
      "check",
    );
    assert.equal(
      restored.prepare("SELECT checked FROM calendar_entry_tags").get().checked,
      1,
    );
    const tombstone = restored
      .prepare("SELECT deleted_at,deletion_id FROM calendar_entries")
      .get();
    assert.ok(tombstone.deleted_at);
    assert.equal(tombstone.deletion_id, deletion.deletionId);
  } finally {
    restored.close();
  }
  assert.equal(
    (
      await f.req(`/calendar/entries/${entry.id}/restore`, "POST", {
        deletionId: deletion.deletionId,
      })
    ).status,
    200,
  );
  assert.equal((await f.req(path)).data.markdown, markdown);
  assert.equal((await f.req(uploaded.data.url.slice(4))).status, 200);
  assert.equal((await save("최신 본문", 1)).status, 200);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    1,
  );
  assert.equal(
    (
      await f.req(
        `/admin/teams/${f.teamId}`,
        "DELETE",
        { confirmed: true },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM calendar_entries").get().n,
    0,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM calendar_tags").get().n, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM calendar_entry_tags").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    0,
  );
});

test("이전 스키마는 자동 이관하지 않고 기존 DB를 보존한 채 거부한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "calendar-schema-")),
    path = join(dir, "old.sqlite");
  const previous = new DatabaseSync(path);
  previous.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  previous.close();
  try {
    assert.throws(() => openDatabase(path), /지원하지 않습니다/);
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        verify.prepare("PRAGMA user_version").get().user_version,
        SCHEMA_VERSION - 1,
      );
    } finally {
      verify.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("개인·팀 공용 태그는 이름·목록·사용 수·편집 권한과 일정 연결을 분리한다", async (t) => {
  const f = await fixture(t);
  const path = `/calendar/teams/${f.teamId}/tags`;
  const tags = [];
  for (const [role, userId] of [
    ["member", f.people.member.id],
    ["second", f.people.second.id],
    ["viewer", null],
  ]) {
    const payload = {
      id: randomUUID(),
      name: "완료",
      color: "green",
      kind: "check",
      userId,
    };
    const result = await f.req(path, "POST", payload, role);
    assert.equal(result.status, 201);
    assert.equal(result.data.userId, userId);
    assert.deepEqual(await f.req(path, "POST", payload, role), result);
    assert.equal(
      (await f.req(path, "POST", { ...payload, id: randomUUID() }, role))
        .status,
      409,
    );
    tags.push(result.data);
  }
  const [mine, theirs, shared] = tags;
  assert.deepEqual(
    (await f.req(path)).data.tags.map((t) => t.id),
    [mine.id],
  );
  assert.deepEqual(
    (await f.req(path, "GET", undefined, "second")).data.tags.map((t) => t.id),
    [theirs.id],
  );
  assert.deepEqual(
    (
      await f.req(`${path}?scope=team`, "GET", undefined, "viewer")
    ).data.tags.map((t) => t.id),
    [shared.id],
  );
  assert.deepEqual(
    (await f.req(`${path}?userId=${f.people.second.id}`)).data.tags.map(
      (t) => t.id,
    ),
    [theirs.id],
  );
  assert.equal(
    (await f.req(`${path}?scope=team&userId=${f.people.member.id}`)).status,
    400,
  );
  assert.equal(
    (await f.req(`${path}?scope=team`, "GET", undefined, "outsider")).status,
    403,
  );
  assert.equal(
    (
      await f.req(path, "POST", {
        id: mine.id,
        name: mine.name,
        color: mine.color,
        kind: mine.kind,
        userId: null,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(path, "POST", {
        id: randomUUID(),
        name: "권한 없음",
        color: "blue",
        userId: f.people.second.id,
      })
    ).status,
    403,
  );
  const entries = [];
  for (const tag of tags) {
    const input = {
      id: randomUUID(),
      teamId: f.teamId,
      userId: tag.userId,
      date: "2026-10-12",
      title: "독립 일정",
      tagIds: [tag.id],
      checkedTagIds: [tag.id],
    };
    const created = await f.req("/calendar/entries", "POST", input, "lead");
    assert.equal(created.status, 201);
    entries.push(created.data);
    for (const other of tags.filter((t) => t.id !== tag.id)) {
      assert.equal(
        (
          await f.req(
            "/calendar/entries",
            "POST",
            {
              ...input,
              id: randomUUID(),
              tagIds: [other.id],
              checkedTagIds: [other.id],
            },
            "lead",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await f.req(
            `/calendar/entries/${input.id}`,
            "PATCH",
            { tagIds: [other.id], expectedTagIds: [tag.id] },
            "lead",
          )
        ).status,
        400,
      );
    }
    assert.deepEqual(
      (await f.req(`/calendar/entries/${input.id}`)).data,
      created.data,
    );
  }
  const context = (await f.req(`/calendar/teams/${f.teamId}`)).data;
  assert.equal(context.tags.length, 3);
  assert.ok(context.tags.every((tag) => tag.usageCount === 1));
  const edit = { name: "공용 완료", color: "red", expectedRevision: 1 };
  assert.equal(
    (await f.req(`/calendar/tags/${shared.id}`, "PATCH", edit, "outsider"))
      .status,
    403,
  );
  assert.equal(
    (await f.req(`/calendar/tags/${shared.id}`, "PATCH", edit, "second"))
      .status,
    200,
  );
  assert.equal(
    (
      await f.req(
        `/calendar/tags/${mine.id}`,
        "DELETE",
        { expectedRevision: 1 },
        "second",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        `/calendar/tags/${shared.id}`,
        "DELETE",
        { expectedRevision: 2 },
        "viewer",
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.req(`/calendar/entries/${entries[0].id}`)).data.checkedTagIds,
    [mine.id],
  );
  assert.deepEqual(
    (await f.req(`/calendar/entries/${entries[1].id}`)).data.checkedTagIds,
    [theirs.id],
  );
  assert.deepEqual(
    (await f.req(`/calendar/entries/${entries[2].id}`)).data.tagIds,
    [],
  );
  assert.equal((await f.req(path)).data.tags[0].name, "완료");
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("팀 공용 일정은 열람자를 포함한 모든 구성원이 함께 편집하고 개인 배치·태그와 분리하며 삭제·복구·백업을 보존한다", async (t) => {
  const f = await fixture(t);
  const listPath = `/calendar?teamId=${f.teamId}&scope=team&from=2026-10-01&to=2026-10-31`;
  const tag = (
    await f.req(
      `/calendar/teams/${f.teamId}/tags`,
      "POST",
      {
        id: randomUUID(),
        userId: null,
        name: "완료",
        color: "green",
        kind: "check",
      },
      "viewer",
    )
  ).data;
  const personal = (await f.create("2026-10-12")).data;
  const input = {
    id: randomUUID(),
    teamId: f.teamId,
    userId: null,
    date: personal.date,
    endDate: personal.date,
    title: "팀 일정",
    tagIds: [tag.id],
  };
  assert.equal(
    (await f.req("/calendar/entries", "POST", input, "outsider")).status,
    403,
  );
  const created = await f.req("/calendar/entries", "POST", input, "viewer");
  assert.equal(created.status, 201);
  assert.equal(created.data.userId, null);
  assert.equal(created.data.lane, 0);
  assert.deepEqual(
    await f.req("/calendar/entries", "POST", input, "second"),
    created,
  );
  assert.equal(
    (
      await f.req("/calendar/entries", "POST", {
        ...input,
        userId: f.people.member.id,
        tagIds: [],
      })
    ).status,
    409,
  );
  const second = (
    await f.req(
      "/calendar/entries",
      "POST",
      { ...input, id: randomUUID(), title: "다른 팀원 일정" },
      "second",
    )
  ).data;
  assert.equal(second.lane, 1);
  assert.deepEqual(
    (await f.list("viewer", "")).data.entries.map((e) => e.id),
    [personal.id],
  );
  const sharedList = await f.req(listPath, "GET", undefined, "viewer");
  assert.equal(sharedList.status, 200);
  assert.deepEqual(
    new Set(sharedList.data.entries.map((e) => e.id)),
    new Set([input.id, second.id]),
  );
  assert.deepEqual(sharedList.data.weekly, []);
  assert.equal(
    (await f.req(`${listPath}&userId=${f.people.member.id}`)).status,
    400,
  );
  assert.equal(
    (await f.req(listPath, "GET", undefined, "outsider")).status,
    403,
  );
  const path = `/calendar/entries/${input.id}`;
  const range = {
    date: "2026-10-13",
    endDate: "2026-10-15",
    expectedDate: input.date,
    expectedEndDate: input.endDate,
  };
  assert.equal((await f.req(path, "PATCH", range, "outsider")).status, 403);
  const moved = await f.req(path, "PATCH", range, "viewer");
  assert.equal(moved.status, 200);
  assert.deepEqual(
    new Set(moved.data.placements.map((p) => p.id)),
    new Set([input.id, second.id]),
  );
  assert.equal(
    (await f.req(`/calendar/entries/${personal.id}`)).data.lane,
    personal.lane,
  );
  const resized = await f.req(path, "PATCH", {
    date: input.date,
    endDate: "2026-10-16",
    expectedDate: moved.data.date,
    expectedEndDate: moved.data.endDate,
  });
  assert.equal(resized.status, 200);
  const reordered = await f.req(
    `/calendar/entries/${second.id}`,
    "PATCH",
    {
      lane: 0,
      expectedLane: 1,
      expectedDate: second.date,
      expectedEndDate: second.endDate,
    },
    "second",
  );
  assert.equal(reordered.status, 200);
  assert.equal((await f.req(path)).data.lane, 1);
  const checks = { checked: true, expectedChecked: false };
  assert.equal(
    (await f.req(`${path}/tags/${tag.id}`, "PATCH", checks, "outsider")).status,
    403,
  );
  assert.equal(
    (await f.req(`${path}/tags/${tag.id}`, "PATCH", checks, "viewer")).status,
    200,
  );
  const doc = {
    markdown: "# 공용 본문\n\n팀원이 함께 관리합니다.",
    expectedRevision: 0,
    operationId: randomUUID(),
  };
  assert.equal(
    (await f.req(`${path}/document`, "PUT", doc, "outsider")).status,
    403,
  );
  assert.equal(
    (await f.req(`${path}/document`, "PUT", doc, "viewer")).status,
    200,
  );
  assert.equal(
    (await f.req(`${path}/document`, "GET", undefined, "viewer")).data.markdown,
    doc.markdown,
  );
  const current = (await f.req(path)).data;
  const deletion = deletionFor(current);
  assert.equal((await f.req(path, "DELETE", deletion, "outsider")).status, 403);
  assert.equal((await f.req(path, "DELETE", deletion, "viewer")).status, 200);
  assert.equal(
    (
      await f.req(
        `${path}/restore`,
        "POST",
        { deletionId: deletion.deletionId },
        "outsider",
      )
    ).status,
    403,
  );
  const restored = await f.req(
    `${path}/restore`,
    "POST",
    {
      deletionId: deletion.deletionId,
    },
    "viewer",
  );
  assert.equal(restored.status, 200);
  for (const field of [
    "id",
    "userId",
    "date",
    "endDate",
    "title",
    "preview",
    "revision",
    "tagIds",
    "checkedTagIds",
    "lane",
  ])
    assert.deepEqual(restored.data[field], current[field], field);
  // Public entries belong to the team even after their creator leaves it.
  f.db
    .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
    .run(f.teamId, f.people.viewer.id);
  assert.equal((await f.req(path, "GET", undefined, "second")).status, 200);
  assert.equal(
    (
      await f.req(
        path,
        "PATCH",
        { title: "탈퇴 후 유지", expectedTitle: input.title },
        "second",
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.req(listPath, "GET", undefined, "second")).data.entries.length,
    2,
  );
  const backup = backupDatabase(f.path, join(f.dir, "shared-backup"), {
    documentImagesDir: f.images,
  });
  const restoredPath = restoreDatabase(
    backup,
    join(f.dir, "shared-restored.sqlite"),
    { documentImagesDir: join(f.dir, "shared-images") },
  );
  const db = openDatabase(restoredPath);
  try {
    assert.equal(
      db
        .prepare("SELECT user_id FROM calendar_entries WHERE id=?")
        .get(input.id).user_id,
      null,
    );
    assert.equal(
      db.prepare("SELECT user_id FROM calendar_tags WHERE id=?").get(tag.id)
        .user_id,
      null,
    );
    assert.equal(
      db
        .prepare(
          "SELECT checked FROM calendar_entry_tags WHERE entry_id=? AND tag_id=?",
        )
        .get(input.id, tag.id).checked,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT markdown FROM document_versions WHERE id=(SELECT version_id FROM calendar_entries WHERE id=?)",
        )
        .get(input.id).markdown,
      doc.markdown,
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
});

test("개인 캘린더 태그는 고정 10색·소유자별 중복·권한·동시 수정을 검증한다", async (t) => {
  const f = await fixture(t);
  const path = `/calendar/teams/${f.teamId}/tags`;
  const payload = { id: randomUUID(), name: " 회의 ", color: "purple" };
  assert.equal((await f.req(path, "POST", payload, "viewer")).status, 403);
  assert.equal((await f.req(path, "POST", payload, "outsider")).status, 403);
  const first = await f.req(path, "POST", payload);
  assert.equal(first.status, 201);
  assert.equal(first.data.name, "회의");
  assert.equal((await f.req(path, "POST", payload)).status, 201);
  assert.equal(
    (await f.req(path, "POST", { ...payload, id: randomUUID() })).status,
    409,
  );
  assert.equal(
    (await f.req(path, "POST", { id: randomUUID(), name: "", color: "blue" }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.req(path, "POST", {
        id: randomUUID(),
        name: "임의 색",
        color: "#000000",
      })
    ).status,
    400,
  );
  assert.equal((await f.req(path, "GET", undefined, "viewer")).status, 200);
  assert.equal((await f.req(path, "GET", undefined, "outsider")).status, 403);
  for (const color of CALENDAR_TAG_COLORS) {
    assert.equal(
      (
        await f.req(path, "POST", {
          id: randomUUID(),
          name: color.name,
          color: color.id,
        })
      ).status,
      201,
    );
  }
  assert.equal(CALENDAR_TAG_COLORS.length, 10);
  const tagPath = `/calendar/tags/${payload.id}`;
  const patch = {
    name: "팀 회의",
    color: "pink",
    expectedRevision: first.data.revision,
  };
  assert.equal((await f.req(tagPath, "PATCH", patch, "viewer")).status, 403);
  assert.equal((await f.req(tagPath, "PATCH", patch, "outsider")).status, 403);
  assert.equal((await f.req(tagPath, "PATCH", patch, "second")).status, 403);
  const updated = await f.req(tagPath, "PATCH", patch, "lead");
  assert.equal(updated.status, 200);
  assert.equal(updated.data.revision, 2);
  assert.equal((await f.req(tagPath, "PATCH", patch)).data.revision, 2);
  assert.equal(
    (await f.req(tagPath, "PATCH", { ...patch, color: "red" })).status,
    409,
  );
  assert.equal(
    (await f.req(tagPath, "DELETE", { expectedRevision: 1 })).status,
    409,
  );
  assert.equal(
    (await f.req(tagPath, "DELETE", { expectedRevision: 2 }, "viewer")).status,
    403,
  );
  assert.equal(
    (await f.req(tagPath, "DELETE", { expectedRevision: 2 })).status,
    200,
  );
  assert.equal((await f.req(path)).data.tags.length, 10);
  assert.equal(
    (await f.req(`/calendar/teams/${f.teamId}`)).data.tags.length,
    10,
  );
});

test("일정 태그는 순서·재시도·독립 저장·충돌·다른 팀 참조를 처리한다", async (t) => {
  const f = await fixture(t);
  const makeTag = async (name, color, team = f.teamId, role = "member") =>
    (
      await f.req(
        `/calendar/teams/${team}/tags`,
        "POST",
        { id: randomUUID(), name, color },
        role,
      )
    ).data;
  const a = await makeTag("회의", "purple"),
    b = await makeTag("연구", "blue"),
    other = await makeTag("외부 태그", "red", f.otherTeam, "outsider");
  const input = {
    id: randomUUID(),
    teamId: f.teamId,
    userId: f.people.member.id,
    date: "2026-10-12",
    endDate: "2026-10-14",
    title: "태그 일정",
    tagIds: [b.id, a.id],
  };
  const created = await f.req("/calendar/entries", "POST", input);
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.tagIds, input.tagIds);
  assert.deepEqual(
    (await f.req("/calendar/entries", "POST", input)).data.tagIds,
    input.tagIds,
  );
  assert.equal(
    (await f.req("/calendar/entries", "POST", { ...input, tagIds: [a.id] }))
      .status,
    409,
  );
  const path = `/calendar/entries/${input.id}`;
  assert.deepEqual((await f.list()).data.entries[0].tagIds, input.tagIds);
  assert.deepEqual(
    (
      await f.req(path, "PATCH", {
        title: "새 제목",
        expectedTitle: input.title,
      })
    ).data.tagIds,
    input.tagIds,
  );
  assert.deepEqual(
    (
      await f.req(path, "PATCH", {
        date: "2026-10-13",
        endDate: "2026-10-15",
        expectedDate: input.date,
        expectedEndDate: input.endDate,
      })
    ).data.tagIds,
    input.tagIds,
  );
  const patch = { tagIds: [a.id, b.id], expectedTagIds: input.tagIds };
  assert.equal((await f.req(path, "PATCH", patch, "second")).status, 403);
  assert.equal((await f.req(path, "PATCH", patch, "viewer")).status, 403);
  assert.equal(
    (await f.req(path, "PATCH", { ...patch, tagIds: [other.id] })).status,
    400,
  );
  assert.equal(
    (await f.req(path, "PATCH", { ...patch, tagIds: [a.id, a.id] })).status,
    400,
  );
  assert.equal(
    (await f.req(path, "PATCH", { ...patch, tagIds: [randomUUID()] })).status,
    400,
  );
  assert.deepEqual((await f.req(path)).data.tagIds, input.tagIds);
  assert.equal((await f.req(path, "PATCH", patch)).status, 200);
  assert.equal((await f.req(path, "PATCH", patch)).status, 200);
  const stale = await f.req(path, "PATCH", { ...patch, tagIds: [] });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.details.currentTagIds, patch.tagIds);
  const savedDocument = await f.req(`${path}/document`, "PUT", {
    markdown: "별도 본문",
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  assert.equal(savedDocument.status, 200);
  assert.deepEqual(savedDocument.data.entry.tagIds, patch.tagIds);
  const current = (await f.req(path)).data;
  const deletion = {
    ...deletionFor(current),
    expectedTagIds: [],
    expectedTitle: current.title,
    expectedRevision: current.revision,
    expectedDate: current.date,
    expectedEndDate: current.endDate,
  };
  assert.equal((await f.req(path, "DELETE", deletion)).status, 409);
  assert.equal(
    (
      await f.req(path, "DELETE", {
        ...deletion,
        expectedTagIds: current.tagIds,
      })
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM calendar_entry_tags").get().n,
    current.tagIds.length,
  );
});

test("태그 이름·색상 변경과 삭제는 연결된 일정과 본문을 보존한다", async (t) => {
  const f = await fixture(t);
  const makeTag = async (name, color) =>
    (
      await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
        id: randomUUID(),
        name,
        color,
      })
    ).data;
  const a = await makeTag("회의", "purple"),
    b = await makeTag("연구", "blue");
  const entries = [];
  for (const date of ["2026-10-12", "2026-10-13"]) {
    const entry = (await f.create(date)).data;
    const assigned = await f.req(`/calendar/entries/${entry.id}`, "PATCH", {
      tagIds: [a.id, b.id],
      expectedTagIds: [],
    });
    assert.equal(assigned.status, 200);
    entries.push(assigned.data);
  }
  assert.equal(
    (await f.req(`/calendar/teams/${f.teamId}/tags`)).data.tags.find(
      (tag) => tag.id === a.id,
    ).usageCount,
    2,
  );
  assert.equal(
    (
      await f.req(`/calendar/tags/${a.id}`, "PATCH", {
        name: "정기 회의",
        color: "green",
        expectedRevision: 1,
      })
    ).status,
    200,
  );
  for (const entry of entries)
    assert.deepEqual(
      (await f.req(`/calendar/entries/${entry.id}`)).data,
      entry,
    );
  assert.equal(
    (await f.req(`/calendar/tags/${a.id}`, "DELETE", { expectedRevision: 2 }))
      .status,
    200,
  );
  for (const entry of entries)
    assert.deepEqual((await f.req(`/calendar/entries/${entry.id}`)).data, {
      ...entry,
      tagIds: [b.id],
    });
  assert.equal(
    (await f.req(`/calendar/tags/${b.id}`, "DELETE", { expectedRevision: 1 }))
      .status,
    200,
  );
  for (const entry of entries)
    assert.deepEqual((await f.req(`/calendar/entries/${entry.id}`)).data, {
      ...entry,
      tagIds: [],
    });
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("체크 태그는 일정별로 저장하고 일반 태그·미지정 태그·권한 없는 체크를 거절한다", async (t) => {
  const f = await fixture(t);
  const makeTag = async (name, kind) =>
    (
      await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
        id: randomUUID(),
        name,
        kind,
        color: "green",
      })
    ).data;
  const check = await makeTag("완료", "check"),
    other = await makeTag("검토", "check"),
    label = await makeTag("회의", "label");
  assert.equal(check.kind, "check");
  const first = (await f.create()).data,
    second = (await f.create("2026-10-12")).data;
  for (const [entry, role] of [
    [first, "member"],
    [second, "member"],
  ])
    assert.equal(
      (
        await f.req(
          `/calendar/entries/${entry.id}`,
          "PATCH",
          {
            tagIds: [check.id, other.id, label.id],
            expectedTagIds: [],
          },
          role,
        )
      ).status,
      200,
    );
  const path = `/calendar/entries/${first.id}`;
  const url = `${path}/tags/${check.id}`;
  const checked = { checked: true, expectedChecked: false };
  for (const role of ["viewer", "second", "outsider"])
    assert.equal((await f.req(url, "PATCH", checked, role)).status, 403);
  assert.equal(
    (await f.req(`${path}/tags/${label.id}`, "PATCH", checked)).status,
    400,
  );
  assert.equal(
    (await f.req(`${path}/tags/${randomUUID()}`, "PATCH", checked)).status,
    409,
  );
  assert.equal(
    (await f.req(url, "PATCH", { ...checked, checked: "yes" })).status,
    400,
  );
  const saved = await f.req(url, "PATCH", checked);
  assert.equal(saved.status, 200);
  assert.deepEqual((await f.req(url, "PATCH", checked)).data, saved.data);
  assert.deepEqual((await f.req(path)).data.checkedTagIds, [check.id]);
  assert.deepEqual(
    (await f.req(`/calendar/entries/${second.id}`)).data.checkedTagIds,
    [],
  );
  assert.deepEqual((await f.list()).data.entries[0].checkedTagIds, [check.id]);
  assert.equal(
    (await f.req(`${path}/tags/${other.id}`, "PATCH", checked, "lead")).status,
    200,
  );
  const reordered = await f.req(path, "PATCH", {
    tagIds: [label.id, other.id, check.id],
    expectedTagIds: [check.id, other.id, label.id],
  });
  assert.deepEqual(reordered.data.checkedTagIds, [other.id, check.id]);
  const titled = await f.req(path, "PATCH", {
    title: "변경한 일정",
    expectedTitle: first.title,
  });
  assert.deepEqual(titled.data.checkedTagIds, [other.id, check.id]);
  assert.equal(
    (
      await f.req(path, "PATCH", {
        tagIds: [other.id, label.id],
        expectedTagIds: reordered.data.tagIds,
      })
    ).status,
    200,
  );
  assert.equal((await f.req(url, "PATCH", checked)).status, 409);
  const restored = await f.req(path, "PATCH", {
    tagIds: [other.id, label.id, check.id],
    expectedTagIds: [other.id, label.id],
  });
  assert.deepEqual(restored.data.checkedTagIds, [other.id]);
  const entry = restored.data;
  const deletion = {
    ...deletionFor(entry),
    expectedTitle: entry.title,
    expectedDate: entry.date,
    expectedEndDate: entry.endDate,
    expectedRevision: entry.revision,
    expectedTagIds: entry.tagIds,
    expectedCheckedTagIds: [],
  };
  assert.equal((await f.req(path, "DELETE", deletion)).status, 409);
  assert.equal(
    (
      await f.req(path, "DELETE", {
        ...deletion,
        expectedCheckedTagIds: [other.id],
      })
    ).status,
    200,
  );
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("체크 태그의 생성 초기값·유형 변경·삭제는 유효한 체크만 유지한다", async (t) => {
  const f = await fixture(t);
  const tag = (
    await f.req(`/calendar/teams/${f.teamId}/tags`, "POST", {
      id: randomUUID(),
      name: "진행 확인",
      color: "blue",
      kind: "check",
    })
  ).data;
  const input = {
    id: randomUUID(),
    teamId: f.teamId,
    userId: f.people.member.id,
    date: "2026-10-12",
    title: "처음부터 체크",
    tagIds: [tag.id],
    checkedTagIds: [tag.id],
  };
  const created = await f.req("/calendar/entries", "POST", input);
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.checkedTagIds, [tag.id]);
  assert.equal((await f.req("/calendar/entries", "POST", input)).status, 201);
  assert.equal(
    (
      await f.req("/calendar/entries", "POST", {
        ...input,
        id: randomUUID(),
        tagIds: [],
      })
    ).status,
    400,
  );
  const tagPath = `/calendar/tags/${tag.id}`,
    entryPath = `/calendar/entries/${input.id}`;
  const rename = {
    name: "완료 확인",
    color: "purple",
    expectedRevision: 1,
  };
  assert.equal((await f.req(tagPath, "PATCH", rename)).status, 200);
  assert.equal(
    (await f.req(`/calendar/teams/${f.teamId}/tags`)).data.tags[0].kind,
    "check",
  );
  assert.deepEqual((await f.req(entryPath)).data.checkedTagIds, [tag.id]);
  assert.equal(
    (
      await f.req(tagPath, "PATCH", {
        ...rename,
        kind: "unknown",
        expectedRevision: 2,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req(tagPath, "PATCH", {
        ...rename,
        kind: "label",
        expectedRevision: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(tagPath, "PATCH", {
        ...rename,
        kind: "label",
        expectedRevision: 2,
      })
    ).status,
    200,
  );
  assert.deepEqual((await f.req(entryPath)).data.checkedTagIds, []);
  assert.equal(
    (await f.req("/calendar/entries", "POST", { ...input, id: randomUUID() }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.req(tagPath, "PATCH", {
        ...rename,
        kind: "check",
        expectedRevision: 3,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(`${entryPath}/tags/${tag.id}`, "PATCH", {
        checked: true,
        expectedChecked: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.req(tagPath, "DELETE", { expectedRevision: 4 })).status,
    200,
  );
  const latest = (await f.req(entryPath)).data;
  assert.deepEqual(latest.tagIds, []);
  assert.deepEqual(latest.checkedTagIds, []);
  assert.equal(latest.title, input.title);
});

for (const transport of ["direct", "shared"])
  test(`${transport} 캘린더 문서 SSE는 저장·재연결 시 최신 본문을 전달하고 팀 권한 회수 후 차단한다`, async (t) => {
    const f = await fixture(t);
    const entry = (await f.create()).data;
    const path = `/calendar/entries/${entry.id}/document`;
    assert.equal(
      (await f.req(`${path}/events`, "GET", undefined, "outsider")).status,
      403,
    );
    async function connect(person = "viewer") {
      const { documentStream } = await import("./document-events-helper.mjs");
      if (transport === "direct")
        return documentStream(t, f.baseURL, path, f.people[person].token);
      const stream = await documentStream(
        t,
        f.baseURL,
        "",
        f.people[person].token,
        "",
        { streams: [{ id: 1, path: `/api${path}/events` }] },
      );
      return {
        close: stream.close,
        async next() {
          const { event, data } = await stream.next();
          assert.equal(event, "stream");
          return { event: data.event, data: JSON.parse(data.data) };
        },
      };
    }
    const stream = await connect();
    assert.equal((await stream.next()).data.revision, 0);
    const memberStream = await connect("member");
    assert.equal((await memberStream.next()).data.revision, 0);
    const save = (markdown, revision) =>
      f.req(path, "PUT", {
        markdown,
        expectedRevision: revision,
        operationId: randomUUID(),
      });
    await save("실시간 첫 입력", 0);
    const update = await stream.next();
    assert.equal(update.event, "document");
    assert.equal(update.data.markdown, "실시간 첫 입력");
    assert.equal(update.data.entry.id, entry.id);
    assert.deepEqual(await memberStream.next(), update);
    stream.close();
    await save("재연결 전 수정", 1);
    assert.equal((await memberStream.next()).data.markdown, "재연결 전 수정");
    const reconnect = await connect();
    assert.equal((await reconnect.next()).data.markdown, "재연결 전 수정");
    f.db
      .prepare("DELETE FROM memberships WHERE team_id=? AND user_id=?")
      .run(f.teamId, f.people.viewer.id);
    await save("권한 회수 후 비공개 입력", 2);
    assert.deepEqual(await reconnect.next(), {
      event: "access-revoked",
      data: { status: 403 },
    });
    assert.equal(
      (await memberStream.next()).data.markdown,
      "권한 회수 후 비공개 입력",
    );
  });
