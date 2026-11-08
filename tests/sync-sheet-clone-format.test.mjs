import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { writeFormatting, readFormatting } from "../server/db.mjs";
import { decodeSheetClone } from "../server/sheet-clones/sheet-clones.mjs";
import { allEntities, readEntity } from "../server/sync/entities.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { reduce } from "../server/sync/reducer.mjs";
import { splitSheetCloneRecord } from "../server/sync/versions.mjs";
import {
  canonical,
  emptyState,
  entityId,
  stateHash,
  validateEntityPayload,
} from "../server/sync/protocol.mjs";
import { defaultView } from "../shared/domain.js";
import { stringify } from "../shared/formatting/compact.js";
import {
  isPackedSheetCloneData,
  packSheetCloneData,
  unpackSheetCloneData,
  unpackSheetClonePayload,
} from "../shared/sheet-clones/sheet-clone-sync-data.js";

const MiB = 1024 * 1024;
// 운영 팀과 같은 모양: 규칙 5개는 약 430개 행 ID, 3개는 19개 행 ID를 가진 열 규칙.
function productionRules(ids) {
  const keys = [
    "title",
    "description",
    "owner",
    "supporters",
    "status",
    "category",
    "2026-01-05",
    "2026-01-12",
  ];
  const rule = (index, rows) => ({
    id: `rule-${index}`,
    rows,
    keys: [keys[index - 1]],
    excludeKeys: [],
    style: { backgroundColor: "#d1eee6" },
    orders: { backgroundColor: index },
  });
  return {
    revision: 8,
    rules: [
      ...[1, 2, 3, 5, 6].map((index) => rule(index, ids.slice(0, 430))),
      ...[4, 7, 8].map((index) => rule(index, ids.slice(0, 19))),
    ],
  };
}
const post = (f, path, body) =>
  fetch(f.origin + path, {
    method: "POST",
    headers: {
      cookie: "weekly_session=" + f.tokens[0],
      "Content-Type": "application/json",
      "X-Requested-With": "WeeklyPlan",
    },
    body: JSON.stringify(body),
  });

test("사본 저장의 동기화 명령은 저장 BLOB과 같은 공유 사전 형태라 업무 438건·규칙 8개에서도 수 MiB에 머문다", async (t) => {
  const f = await performanceFixture({
    rows: 438,
    clients: 1,
    users: 10,
    documents: 0,
  });
  t.after(() => f.close());
  f.setLink("paused");
  writeFormatting(f.db, f.teamId, productionRules(f.taskIds));
  assert.ok(
    Buffer.byteLength(JSON.stringify(readFormatting(f.db, f.teamId))) >
      80 * 1024,
  );
  const year = new Date().getFullYear();
  const response = await post(f, "/api/sheet-clones", {
    teamId: f.teamId,
    year,
    name: "공유 사전 사본",
    referenceDate: `${year}-10-30`,
    view: defaultView(year),
    taskIds: f.taskIds,
  });
  const created = await response.json();
  assert.equal(response.status, 201, JSON.stringify(created));
  const outbox = f.db
    .prepare("SELECT payload FROM sync_outbox ORDER BY local_seq DESC LIMIT 1")
    .get();
  const operation = JSON.parse(outbox.payload),
    change = operation.changes.find((c) => c.entity === "sheetClone");
  assert.equal(change.action, "create");
  assert.ok(isPackedSheetCloneData(change.desired.data));
  assert.equal(change.desired.data.$formats.length, 1);
  assert.ok(
    Buffer.byteLength(outbox.payload) < 4 * MiB,
    `operation ${Buffer.byteLength(outbox.payload)} bytes`,
  );
  // 같은 사본을 평문으로 풀면 운영에서 32MiB 한도를 넘겼던 크기가 된다.
  const expanded = unpackSheetCloneData(change.desired.data);
  assert.equal(expanded.tasks.length, 438);
  assert.ok(Buffer.byteLength(canonical(expanded)) > 32 * MiB);
  // DB BLOB을 푼 결과와 동기화 payload를 푼 결과는 같은 내용이다.
  const row = f.db
    .prepare("SELECT data FROM sheet_clones WHERE id=?")
    .get(created.id);
  const stored = decodeSheetClone(row.data);
  assert.deepEqual(
    expanded.tasks.map((task) => task.formatting),
    stored.tasks.map((task) => task.formatting),
  );
  assert.equal(
    readEntity(f.db, f.teamId, "sheetClone", [created.id]).payload.data.$formats
      .length,
    1,
  );
});

test("공유 사전 직렬화는 키 순서와 무관하게 같은 바이트를 내고 풀면 원래 내용으로 돌아온다", (t) => {
  const f = sqliteFixture(t);
  const row = f.db
      .prepare("SELECT data FROM sheet_clones WHERE id=?")
      .get(f.sheetCloneId),
    decoded = decodeSheetClone(row.data),
    reordered = JSON.parse(canonical(decoded));
  const a = packSheetCloneData(decoded),
    b = packSheetCloneData(reordered);
  assert.ok(isPackedSheetCloneData(a));
  assert.equal(canonical(a), canonical(b));
  assert.deepEqual(unpackSheetCloneData(a), decoded);
  assert.deepEqual(
    unpackSheetCloneData(packSheetCloneData(unpackSheetCloneData(a))),
    decoded,
  );
  assert.equal(canonical(packSheetCloneData(a)), canonical(a));
  // 저장 BLOB의 사전 형태와 같은 코덱이다.
  assert.deepEqual(JSON.parse(stringify(decoded)).$styles, a.$styles);
  // 사전이 필요 없는 사본은 평문 그대로이며 푸는 쪽도 그대로 돌려준다.
  const plain = { tasks: [], users: [], view: {}, settings: {} };
  assert.ok(!isPackedSheetCloneData(packSheetCloneData(plain)));
  assert.deepEqual(packSheetCloneData(plain), plain);
  assert.equal(unpackSheetCloneData(plain), plain);
});

test("사본 payload 검증은 공유 사전 형태를 받아들이고 잘못된 사전은 거절한다", (t) => {
  const f = sqliteFixture(t);
  const record = f.state.entities[entityId("sheetClone", [f.sheetCloneId])];
  assert.ok(isPackedSheetCloneData(record.payload.data));
  validateEntityPayload("sheetClone", record.key, record.payload, f.teamId, 3);
  validateEntityPayload(
    "sheetClone",
    record.key,
    unpackSheetClonePayload(record.payload),
    f.teamId,
    3,
  );
  assert.throws(
    () =>
      validateEntityPayload(
        "sheetClone",
        record.key,
        { ...record.payload, data: { $styles: "x", $data: {} } },
        f.teamId,
        3,
      ),
    /Invalid sheetClone payload/,
  );
  assert.throws(
    () =>
      validateEntityPayload(
        "sheetClone",
        record.key,
        {
          ...record.payload,
          data: {
            ...record.payload.data,
            $data: {
              ...record.payload.data.$data,
              users: [{ id: "x", email: "x" }],
            },
          },
        },
        f.teamId,
        3,
      ),
    /Private account data/,
  );
  // 프로토콜 4 분할은 공유 사전 형태와 평문에서 같은 행·셀 레코드를 만든다.
  assert.deepEqual(
    splitSheetCloneRecord(record).map((r) => [r.entity, r.key, r.payload]),
    splitSheetCloneRecord({
      ...record,
      payload: unpackSheetClonePayload(record.payload),
    }).map((r) => [r.entity, r.key, r.payload]),
  );
});

test("기존 평문 사본 기준본에 공유 사전 명령을 적용해도 편집·삭제가 충돌로 바뀌지 않는다", (t) => {
  const f = sqliteFixture(t);
  const id = entityId("sheetClone", [f.sheetCloneId]),
    packed = f.state.entities[id];
  const legacy = structuredClone(f.state);
  legacy.entities[id] = {
    ...packed,
    payload: unpackSheetClonePayload(packed.payload),
  };
  assert.ok(!isPackedSheetCloneData(legacy.entities[id].payload.data));
  assert.notEqual(stateHash(legacy), stateHash(f.state));
  // 풀린 객체는 참조가 없는 가지를 원본과 공유하므로 수정 전에 복제한다.
  const data = structuredClone(unpackSheetCloneData(packed.payload.data));
  data.tasks[0].cells.title = {
    ...data.tasks[0].cells.title,
    value: "공유 사전 편집",
  };
  const edit = makeOperation({
    link: f.link,
    actorRef: f.user.id,
    before: { [id]: packed },
    after: {
      [id]: {
        ...packed,
        payload: { ...packed.payload, data: packSheetCloneData(data) },
      },
    },
  });
  assert.deepEqual(edit.changes[0].fields, ["data"]);
  const edited = reduce(legacy, edit);
  assert.equal(
    edited.receipt.result,
    "applied",
    JSON.stringify(edited.receipt),
  );
  const after = edited.state.entities[id];
  assert.ok(isPackedSheetCloneData(after.payload.data));
  assert.equal(
    unpackSheetCloneData(after.payload.data).tasks[0].cells.title.value,
    "공유 사전 편집",
  );
  const removal = makeOperation({
    link: f.link,
    actorRef: f.user.id,
    before: { [id]: packed },
    after: { [id]: null },
  });
  assert.equal(removal.changes[0].action, "delete");
  const removed = reduce(legacy, removal);
  assert.equal(
    removed.receipt.result,
    "applied",
    JSON.stringify(removed.receipt),
  );
  assert.equal(removed.state.entities[id].deleted, true);
  // 내용이 실제로 다른 base는 여전히 충돌이다.
  const stale = structuredClone(data);
  stale.tasks[0].cells.title.value = "다른 사람의 편집";
  const conflicting = reduce(
    edited.state,
    makeOperation({
      link: f.link,
      actorRef: f.user.id,
      before: { [id]: packed },
      after: {
        [id]: {
          ...packed,
          payload: { ...packed.payload, data: packSheetCloneData(stale) },
        },
      },
    }),
  );
  assert.equal(conflicting.receipt.result, "conflict");
});

test("실제 PostgreSQL 외부 사이트는 사본을 공유 사전 형태로 저장·전송하고 앱에는 풀린 서식을 돌려준다", async (t) => {
  const seed = sqliteFixture(t);
  writeFormatting(seed.db, seed.teamId, {
    revision: 1,
    rules: [
      {
        id: "outside-rule",
        rows: [seed.taskId],
        keys: ["title"],
        excludeKeys: [],
        style: { backgroundColor: "#ffe8a3" },
        orders: { backgroundColor: 1 },
      },
    ],
  });
  const state = { ...emptyState(), entities: allEntities(seed.db, seed.link) };
  assert.ok(state.entities[entityId("formats", [])]);
  const f = await postgresFixture(t, { ...seed, state });
  if (!f) return;
  const app = createExternalRouteApp({ env: f.env, defaultUserId: f.user.id });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "WeeklyPlan",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const created = await call("/api/sheet-clones", {
      teamId: f.teamId,
      year: 2026,
      name: "외부 공유 사전 사본",
      referenceDate: "2026-10-30",
      view: defaultView(2026),
      taskIds: [f.taskId],
    });
    assert.ok(
      [200, 201].includes(created.status),
      JSON.stringify(created.data),
    );
    const stored = (
      await f.pool.query(
        "SELECT payload FROM graeboard.site_entities WHERE entity='sheetClone' AND entity_key=$1",
        [canonical([created.data.id])],
      )
    ).rows[0];
    const storedData = JSON.parse(stored.payload).data;
    assert.ok(isPackedSheetCloneData(storedData));
    assert.equal(storedData.$formats.length, 1);
    const outbox = (
      await f.pool.query(
        "SELECT payload FROM graeboard.sync_outbox ORDER BY local_seq DESC LIMIT 1",
      )
    ).rows[0];
    const change = JSON.parse(outbox.payload).changes.find(
      (c) => c.entity === "sheetClone",
    );
    assert.equal(change.action, "create");
    assert.ok(isPackedSheetCloneData(change.desired.data));
    assert.equal(canonical(change.desired.data), canonical(storedData));
    const read = await call("/api/sheet-clones/" + created.data.id);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    const view = unpackSheetCloneData(read.data);
    assert.equal(view.tasks[0].formatting.rules.length, 1);
    assert.equal(view.tasks[0].formatting.rules[0].id, "outside-rule");
    assert.deepEqual(
      view.tasks[0].formatting,
      unpackSheetCloneData(storedData).tasks[0].formatting,
    );
    // 이름 변경처럼 data를 바꾸지 않는 편집은 같은 저장 형태를 유지한다.
    const renamed = await call(
      `/api/sheet-clones/${created.data.id}/name`,
      { name: "외부 사본 이름", expectedName: "외부 공유 사전 사본" },
      "PATCH",
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    const latest = (
      await f.pool.query(
        "SELECT payload FROM graeboard.sync_outbox ORDER BY local_seq DESC LIMIT 1",
      )
    ).rows[0];
    const rename = JSON.parse(latest.payload).changes.find(
      (c) => c.entity === "sheetClone",
    );
    assert.deepEqual(rename.fields, ["name"]);
    assert.ok(isPackedSheetCloneData(rename.base.data));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
});
