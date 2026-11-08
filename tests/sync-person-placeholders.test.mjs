import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  openDatabase,
  json,
  passwordHash,
  insertTask,
  getTask,
} from "../server/db.mjs";
import { DEFAULT_SETTINGS, defaultView } from "../shared/domain.js";
import { encodeSheetClone } from "../server/sheet-clones/sheet-clones.mjs";
import {
  allEntities,
  materialize,
  syncActorId,
  SYNC_ACTOR_NAME,
} from "../server/sync/entities.mjs";
import { upgradeState } from "../server/sync/versions.mjs";
import {
  entityId,
  validateEntityPayload,
  PROTOCOL,
  SPLIT_PROTOCOL,
} from "../server/sync/protocol.mjs";

// 받는 쪽은 보내는 쪽이 사람마다 person 엔티티를 실어 준다는 전제로 users 행을
// 참조한다(created_by, user_id, actor_id FK). 그 전제가 깨져도 수신이 멈추지 않고
// 자리표시 행으로 이어져야 한다(2026-11-03 운영 수신 정지와 같은 부류).
function fixture(teamId = randomUUID()) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Sync",
    json(DEFAULT_SETTINGS),
  );
  return { db, teamId };
}
const record = (entity, key, payload, deleted = false) => [
  entityId(entity, key),
  { entity, key, payload, deleted },
];
// node:sqlite rows have a null prototype; copy them for deepEqual.
const plain = (row) => row && { ...row };
const user = (db, id) =>
  plain(
    db.prepare("SELECT name,password,active FROM users WHERE id=?").get(id),
  );
const ref = (db, teamId, id) =>
  plain(
    db
      .prepare(
        "SELECT profile,local_user_id AS localUserId FROM sync_person_refs WHERE team_id=? AND person_id=?",
      )
      .get(teamId, id),
  );

test("references without a person entity materialize placeholder users named by their ID", (t) => {
  const { db, teamId } = fixture();
  t.after(() => db.close());
  const taskId = randomUUID(),
    creator = randomUUID(),
    owner = randomUUID(),
    tagOwner = randomUUID(),
    weeklyOwner = randomUUID();
  const entities = Object.fromEntries([
    record("task", [taskId], {
      years: [2026],
      position: 1,
      defaultStyle: {},
      rowStyle: {},
      createdBy: creator,
      createdAt: "2026-11-07T00:00:00.000Z",
    }),
    record("cell", [taskId, "title"], { value: "업무", style: {} }),
    record("calendar", ["entry"], {
      userId: owner,
      date: "2026-11-10",
      endDate: "2026-11-10",
      lane: 0,
      title: "일정",
      tags: [],
    }),
    record("tag", ["tag"], {
      userId: tagOwner,
      name: "태그",
      color: "green",
      kind: "label",
    }),
    record("weekly", [weeklyOwner, "2026-11-09", taskId], { title: "업무" }),
    record("document", ["task", taskId, "main"], {
      title: "문서 1",
      position: 0,
      markdown: "# 본문",
    }),
  ]);
  const changed = materialize(db, teamId, entities, {});
  assert.equal(changed.length, Object.keys(entities).length);
  for (const id of [creator, owner, tagOwner, weeklyOwner]) {
    assert.deepEqual(user(db, id), { name: id, password: "!", active: 0 });
    assert.deepEqual(ref(db, teamId, id), {
      profile: JSON.stringify({ name: id }),
      localUserId: id,
    });
  }
  assert.equal(
    db.prepare("SELECT created_by FROM tasks WHERE id=?").get(taskId)
      .created_by,
    creator,
  );
  assert.equal(
    db.prepare("SELECT user_id FROM calendar_entries WHERE id='entry'").get()
      .user_id,
    owner,
  );
  assert.equal(
    db.prepare("SELECT user_id FROM calendar_tags WHERE id='tag'").get()
      .user_id,
    tagOwner,
  );
  assert.equal(
    db
      .prepare("SELECT user_id FROM calendar_weekly_items WHERE task_id=?")
      .get(taskId).user_id,
    weeklyOwner,
  );
  // Received documents name no author: one placeholder actor per team, never
  // an arbitrary local account.
  const actor = syncActorId(teamId);
  assert.ok(z.string().uuid().safeParse(actor).success);
  assert.equal(syncActorId(teamId), actor);
  assert.notEqual(syncActorId(randomUUID()), actor);
  assert.deepEqual(user(db, actor), {
    name: SYNC_ACTOR_NAME,
    password: "!",
    active: 0,
  });
  assert.equal(
    db
      .prepare("SELECT actor_id FROM task_documents WHERE task_id=?")
      .get(taskId).actor_id,
    actor,
  );
  assert.equal(
    db
      .prepare("SELECT created_by FROM document_versions WHERE team_id=?")
      .get(teamId).created_by,
    actor,
  );
  assert.equal(
    db.prepare("SELECT actor_id FROM calendar_entries WHERE id='entry'").get()
      .actor_id,
    actor,
  );
  // Applying the same state again is a no-op for the placeholders.
  materialize(db, teamId, entities, entities);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE password='!'").get().n,
    5,
  );
});

test("a later person entity renames a placeholder but never a local account", (t) => {
  const { db, teamId } = fixture();
  t.after(() => db.close());
  const taskId = randomUUID(),
    remote = randomUUID(),
    local = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,'user',?)",
  ).run(
    local,
    "local@example.com",
    "로컬 사용자",
    passwordHash("local-password"),
    "2026-11-07T00:00:00.000Z",
  );
  const task = (createdBy) =>
    record("task", [taskId], {
      years: [2026],
      position: 1,
      defaultStyle: {},
      rowStyle: {},
      createdBy,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
  materialize(db, teamId, Object.fromEntries([task(remote)]), {});
  assert.equal(user(db, remote).name, remote);
  const people = Object.fromEntries([
    record("person", [remote], { name: "홍길동" }),
    record("person", [local], { name: "덮어쓰기 시도" }),
  ]);
  materialize(db, teamId, people, {});
  assert.deepEqual(user(db, remote), {
    name: "홍길동",
    password: "!",
    active: 0,
  });
  assert.equal(ref(db, teamId, remote).profile, json({ name: "홍길동" }));
  assert.equal(user(db, local).name, "로컬 사용자");
  assert.equal(user(db, local).active, 1);
  // A reference arriving after the person keeps the real name.
  materialize(
    db,
    teamId,
    Object.fromEntries([
      record("calendar", ["entry"], {
        userId: remote,
        date: "2026-11-10",
        endDate: "2026-11-10",
        lane: 0,
        title: "일정",
        tags: [],
      }),
      task(local),
    ]),
    {},
  );
  assert.equal(user(db, remote).name, "홍길동");
  assert.equal(user(db, local).name, "로컬 사용자");
  // An existing task keeps its creator; the new reference is still resolved.
  assert.equal(
    db.prepare("SELECT created_by FROM tasks WHERE id=?").get(taskId)
      .created_by,
    remote,
  );
  // A reference alone does not register a local account as a remote person.
  const member = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,'user',?)",
  ).run(
    member,
    "member@example.com",
    "팀원",
    passwordHash("member-password"),
    "2026-11-07T00:00:00.000Z",
  );
  materialize(
    db,
    teamId,
    Object.fromEntries([
      record("tag", ["tag"], {
        userId: member,
        name: "태그",
        color: "green",
        kind: "label",
      }),
    ]),
    {},
  );
  assert.equal(user(db, member).name, "팀원");
  assert.equal(ref(db, teamId, member), undefined);
});

test("calendar and tag owners must be null or a usable ID", () => {
  const teamId = randomUUID();
  const entry = (userId) => ({
    userId,
    date: "2026-11-10",
    endDate: "2026-11-10",
    lane: 0,
    title: "일정",
    tags: [],
  });
  const tag = (userId) => ({
    userId,
    name: "태그",
    color: "green",
    kind: "label",
  });
  // Both the whole-record and the split protocol check them.
  for (const version of [PROTOCOL, SPLIT_PROTOCOL]) {
    for (const userId of [null, randomUUID()]) {
      validateEntityPayload(
        "calendar",
        ["entry"],
        entry(userId),
        teamId,
        version,
      );
      validateEntityPayload("tag", ["tag"], tag(userId), teamId, version);
    }
    for (const userId of ["", 5, "x".repeat(201)]) {
      assert.throws(
        () =>
          validateEntityPayload(
            "calendar",
            ["entry"],
            entry(userId),
            teamId,
            version,
          ),
        /Invalid calendar userId/,
      );
      assert.throws(
        () =>
          validateEntityPayload("tag", ["tag"], tag(userId), teamId, version),
        /Invalid tag userId/,
      );
    }
  }
});

test("a sheet clone received without its creator's person keeps placeholders in protocol 3 and 4", (t) => {
  // The sending site's state, as its application stores it: a task and a
  // sheet clone of it made by a member the receiving site has never seen.
  const { db: source, teamId } = fixture();
  t.after(() => source.close());
  const creator = randomUUID(),
    cloneId = randomUUID(),
    memoId = randomUUID(),
    stamp = "2026-11-07T00:00:00.000Z";
  source
    .prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
    )
    .run(creator, "creator@example.test", "작성자", stamp);
  const task = insertTask(source, {
    teamId,
    year: 2026,
    actorId: creator,
    fields: { title: "사본 업무" },
  });
  source.prepare("INSERT INTO sheet_clones VALUES(?,?,?,?,?,?,?,?)").run(
    cloneId,
    teamId,
    2026,
    "받은 사본",
    "2026-11-01",
    creator,
    stamp,
    encodeSheetClone({
      settings: DEFAULT_SETTINGS,
      view: defaultView(2026),
      users: [{ id: creator, name: "작성자" }],
      tasks: [getTask(source, task.id)],
    }),
  );
  const whole = Object.fromEntries(
    Object.entries({
      ...allEntities(source, { team_id: teamId, bootstrap_id: "boot" }),
      ...Object.fromEntries([
        record("document", ["sheetClone", cloneId, task.id, "main"], {
          title: "문서 1",
          position: 0,
          markdown: "# 사본 문서",
        }),
        record("document", ["sheetCloneMemo", cloneId, memoId], {
          title: "사본 메모",
          position: 0,
          markdown: "메모 본문",
        }),
      ]),
      // The sender left its person entities out.
    }).filter(([, e]) => e.entity !== "person"),
  );
  const split = upgradeState({
    entities: whole,
    receipts: {},
    conflicts: {},
  }).entities;
  assert.ok(
    Object.values(split).some((e) => e.entity === "sheetCloneTask"),
    "protocol 4 carries the clone as row records",
  );
  for (const [version, entities] of [
    [PROTOCOL, whole],
    [SPLIT_PROTOCOL, split],
  ]) {
    const { db } = fixture(teamId);
    materialize(db, teamId, entities, {});
    const actor = syncActorId(teamId);
    assert.deepEqual(
      user(db, creator),
      { name: creator, password: "!", active: 0 },
      `protocol ${version}`,
    );
    assert.equal(
      db.prepare("SELECT created_by FROM sheet_clones WHERE id=?").get(cloneId)
        .created_by,
      creator,
    );
    assert.equal(
      db.prepare("SELECT created_by FROM tasks WHERE id=?").get(task.id)
        .created_by,
      creator,
    );
    // Documents arrive without an author: the team's sync actor.
    assert.equal(
      db
        .prepare(
          "SELECT v.created_by FROM sheet_clone_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.sheet_clone_id=? AND d.task_id=?",
        )
        .get(cloneId, task.id).created_by,
      actor,
    );
    assert.equal(
      db
        .prepare(
          "SELECT actor_id FROM sheet_clone_memos WHERE sheet_clone_id=? AND id=?",
        )
        .get(cloneId, memoId).actor_id,
      actor,
    );
    assert.deepEqual(user(db, actor), {
      name: SYNC_ACTOR_NAME,
      password: "!",
      active: 0,
    });
    const placeholders = () =>
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE password='!'").get().n;
    const count = placeholders();
    materialize(db, teamId, entities, entities);
    assert.equal(placeholders(), count);
    // The creator's person arriving later names the placeholder.
    materialize(
      db,
      teamId,
      Object.fromEntries([record("person", [creator], { name: "작성자" })]),
      {},
    );
    assert.equal(user(db, creator).name, "작성자");
    db.close();
  }
});
