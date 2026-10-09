import { test } from "node:test";
import assert from "node:assert/strict";
import { textLinks } from "../shared/domain.js";

test("여섯 자리 이슈 번호를 각각 연결하고 원래 문장과 줄바꿈을 보존한다", () => {
  const text =
    "이슈 #234566 검토\n#000123 확인, #12345와 #1234567은 일반 텍스트";
  const parts = textLinks(text);
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.deepEqual(
    parts.filter((p) => p.href),
    [
      {
        text: "#234566",
        href: "http://redmine.somansa.com/redmine/issues/234566",
      },
      {
        text: "#000123",
        href: "http://redmine.somansa.com/redmine/issues/000123",
      },
    ],
  );
});

test("HTTP 링크는 그대로 유지하고 URL 내부 번호와 실행 가능한 문자열을 재해석하지 않는다", () => {
  const parts = textLinks(
    "https://example.com/#234566 #210161 javascript:alert(1) <script>x</script>",
  );
  assert.deepEqual(
    parts.filter((p) => p.href).map((p) => p.href),
    [
      "https://example.com/#234566",
      "http://redmine.somansa.com/redmine/issues/210161",
    ],
  );
  assert.deepEqual(textLinks("javascript:alert(1)"), [
    { text: "javascript:alert(1)" },
  ]);
  assert.deepEqual(textLinks(""), [{ text: "" }]);
});
