import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeDocument,
  mapDocumentPosition,
  mapDocumentPositions,
} from "../../shared/documents/document-merge.js";

test("문서 병합은 같은 줄의 독립 수정·여러 구간·한글과 이모지를 보존한다", () => {
  assert.equal(
    mergeDocument("오늘 회의 준비", "내일 회의 준비", "오늘 회의 완료"),
    "내일 회의 완료",
  );
  assert.equal(
    mergeDocument(
      "가나다\n라마바\n사아자",
      "가X다\n라마바\n사Y자",
      "가나다\n라Z바\n사아자",
    ),
    "가X다\n라Z바\n사Y자",
  );
  assert.equal(
    mergeDocument("🙂 회의", "🙂 회의 완료", "🧑‍💻 회의"),
    "🧑‍💻 회의 완료",
  );
  assert.equal(mergeDocument("회의", "회의 A", "회의 B"), "회의 B A");
  assert.equal(mergeDocument("회의", "회의 완료", "회의 완료"), "회의 완료");
});

test("같은 부분의 서로 다른 교체·삭제는 자동 덮어쓰기하지 않는다", () => {
  assert.equal(mergeDocument("예정", "완료", "취소"), null);
  assert.equal(mergeDocument("abcdef", "abf", "abcXdef"), null);
  assert.equal(mergeDocument("abcdef", "abXef", "abcYf"), null);
});

test("원문 커서는 앞쪽의 원격 삽입·삭제 뒤에도 같은 글자를 가리킨다", () => {
  assert.equal(mapDocumentPosition("가나 다라", "추가 가나 다라", 4), 7);
  assert.equal(mapDocumentPosition("🙂 가나 다라", "가나 다라", 7), 4);
});

test("여러 위치는 한 번의 비교로 각각 같은 글자를 가리킨다", () => {
  const before = "* 가나\n\n\\[공통] 다라";
  const after = "- 가나\n\n[공통] 다라";
  const positions = [0, 2, 6, 11, before.length];
  assert.deepEqual(
    mapDocumentPositions(before, after, positions),
    positions.map((position) => mapDocumentPosition(before, after, position)),
  );
  assert.deepEqual(mapDocumentPositions(before, after, [7, 11]), [6, 10]);
});
