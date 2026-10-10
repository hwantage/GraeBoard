import test from "node:test";
import assert from "node:assert/strict";
import { createPropertySearch } from "../shared/search.js";

const properties = [
  { id: "title", name: "업무명", kind: "text", values: [] },
  { id: "owner", kind: "member", values: [] },
  {
    id: "status",
    kind: "option",
    values: [{ id: "s-1", label: "Alpha 검토" }],
  },
  { id: "memo", name: "작업", kind: "text", visible: false, values: [] },
  { id: "number", kind: "number", values: [] },
  { id: "date", kind: "date", values: [] },
  { id: "retired", kind: "text", archived: true, values: [] },
];
const users = [{ id: "u-1", name: "Alpha 담당자" }];
const task = (id, values) => ({
  id,
  cells: Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value }]),
  ),
});

test("전체 활성 속성은 이름·타입·열 숨김에 관계없이 표시값을 검색하고 셀 단위로 센다", async () => {
  const tasks = [
    task("a", {
      title: "ALPHA Alpha",
      owner: ["u-1"],
      status: "s-1",
      memo: "Alpha",
    }),
    task("b", {
      title: "별도 업무",
      memo: "다른 Alpha",
      retired: "Alpha",
      orphan: "Alpha",
      "2026-01-05": "Alpha",
    }),
  ];
  const search = createPropertySearch(properties, users);
  const result = await search.find(tasks, "  aLpHa  ");
  assert.equal(result.count, 5);
  assert.deepEqual(
    Array.from({ length: result.count }, (_, i) => result.pointAt(i)),
    [
      { taskId: "a", key: "title" },
      { taskId: "a", key: "owner" },
      { taskId: "a", key: "status" },
      { taskId: "a", key: "memo" },
      { taskId: "b", key: "memo" },
    ],
  );
  assert.equal((await search.find(tasks, "u-1")).count, 0);
  assert.equal((await search.find(tasks, "s-1")).count, 0);
  assert.equal((await search.find(tasks, "업무명")).count, 0);
});

test("숫자 0·날짜·유니코드·정규식 문자를 일반 검색어로 처리한다", async () => {
  const tasks = [
    task("a", { title: "한글 [a.*] café", number: 0, date: "2026-10-10" }),
  ];
  const search = createPropertySearch(properties, users);
  for (const [query, key] of [
    ["[a.*]", "title"],
    ["cafe\u0301", "title"],
    ["0", "number"],
    ["2026-10", "date"],
  ]) {
    const found = await search.find(tasks, query);
    assert(found.indexOf({ taskId: "a", key }) >= 0);
  }
  for (const query of ["", "   ", "검색 결과 없음"])
    assert.equal((await search.find(tasks, query)).count, 0);
});

test("수정·삭제·정렬·속성/팀원 이름 변경 후 결과 위치와 표시값을 갱신한다", async () => {
  const search = createPropertySearch(properties, users);
  const original = task("a", { title: "이전 값", owner: "u-1" });
  const second = task("b", { title: "이전 값" });
  const initial = await search.find([original, second], "이전");
  assert.equal(initial.count, 2);
  const changed = task("a", { title: "새 값", owner: "u-1" });
  const updated = await search.find([second, changed], "이전");
  assert.equal(updated.count, 1);
  assert.deepEqual(updated.pointAt(0), { taskId: "b", key: "title" });
  assert.equal(updated.indexOf({ taskId: "a", key: "title" }), -1);
  assert.equal((await search.find([changed], "이전")).count, 0);
  assert.equal((await search.find([changed], "새 값")).count, 1);
  const renamed = createPropertySearch(properties, [
    { id: "u-1", name: "새 팀원" },
  ]);
  assert.equal((await renamed.find([changed], "Alpha")).count, 0);
  assert.deepEqual((await renamed.find([changed], "새 팀원")).pointAt(0), {
    taskId: "a",
    key: "owner",
  });
  assert.equal(updated.pointAt(-1), null);
  assert.equal(updated.pointAt(1), null);
});

test("취소된 검색은 결과를 반환하지 않는다", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await createPropertySearch(properties, users).find(
      [task("a", { title: "Alpha" })],
      "Alpha",
      controller.signal,
    ),
    null,
  );
});
