import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { inspectWorkbook } from "../server/transfer.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";

test("수식의 저장된 0·false·날짜 결과를 보존하고 미계산 결과를 경고한다", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("업무");
  sheet.addRow(["작업", "진척률", "설명", "목표일", "1/2"]);
  sheet.addRow([
    "계산 결과",
    { formula: "SUM(0)", result: 0 },
    { formula: "1=2", result: false },
    { formula: "DATE(2026,1,2)", result: new Date("2026-01-02T00:00:00Z") },
    { formula: "SUM(0)", result: 0 },
  ]);
  sheet.getCell("B2").numFmt = "0%";
  sheet.getCell("D2").numFmt = "yyyy-mm-dd";
  sheet.addRow(["미계산 결과", "", { formula: "SUM(1)" }]);
  const [result] = await inspectWorkbook(
    await workbook.xlsx.writeBuffer(),
    2026,
    DEFAULT_SETTINGS,
  );
  assert.equal(result.rows[0].fields.progress, "0%");
  assert.equal(result.rows[0].fields.description, "false");
  assert.equal(result.rows[0].fields.deadline, "2026-01-02");
  assert.equal(result.rows[0].cells["2025-12-29"].value, "0");
  assert.equal(result.rows[1].fields.description, "");
  assert.deepEqual(
    result.warnings.filter((warning) => warning.includes("수식 표시값이 없어")),
    ["C3: 수식 표시값이 없어 빈 값으로 가져옵니다."],
  );
});

test("엑셀 진척률의 문구·백분율·100 초과 값을 텍스트로 보존한다", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("업무");
  sheet.addRow(["작업", "진척률"]);
  for (const value of ["완료", "검토 중", "120%", 120, 0.375])
    sheet.addRow([`업무 ${sheet.rowCount}`, value]);
  sheet.getCell("B6").numFmt = "0.0%";
  const [result] = await inspectWorkbook(
    await workbook.xlsx.writeBuffer(),
    2026,
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(
    result.rows.map((r) => r.fields.progress),
    ["완료", "검토 중", "120%", "120", "37.5%"],
  );
  assert.ok(
    result.rows.every((r) => !r.fields.status && !r.fields.description),
  );
  assert.doesNotMatch(result.warnings.join("\n"), /숫자.*설명/);
});

test("여러 줄 헤더와 명시한 원본 범위를 사용하고 연말 날짜를 순서대로 연결한다", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("연간 업무");
  sheet.getCell("C1").value = "주간계획 (2026-10-09)";
  sheet.getCell("D1").value = "1W\n12/5";
  sheet.getCell("E1").value = "5W\n1/2";
  sheet.getCell("F1").value = "2W\n1/9";
  sheet.getCell("G1").value = "진척도";
  sheet.getCell("H1").value = "목표일";
  sheet.getRow(3).values = ["분류", "", "작업"];
  sheet.getRow(5).values = [
    "기타",
    "검토",
    "실제 업무",
    "지난해 일정",
    "첫 주",
    "다음 주",
    0.75,
    new Date("2026-01-09T00:00:00Z"),
  ];
  sheet.getCell("G5").numFmt = "0%";
  sheet.getCell("H5").numFmt = "yyyy-mm-dd";
  sheet.getColumn(4).hidden = true;
  sheet.getRow(7).values = ["참고 표", "", "내용", "담당자", "일시"];
  sheet.getRow(8).values = ["회의", "", "별도 표", "다른 형식"];
  workbook.addWorksheet("빈 시트");
  const [result, empty] = await inspectWorkbook(
    await workbook.xlsx.writeBuffer(),
    2026,
    DEFAULT_SETTINGS,
    {
      "연간 업무": {
        headerRow: 3,
        startRow: 5,
        endRow: 6,
        columns: { type: 2 },
      },
    },
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.fields.type, "검토");
  assert.equal(row.fields.progress, "75%");
  assert.equal(row.fields.deadline, "2026-01-09");
  assert.equal(row.cells["2025-12-01"].value, "지난해 일정");
  assert.equal(row.cells["2025-12-29"].value, "첫 주");
  assert.equal(row.cells["2026-01-05"].value, "다음 주");
  assert.deepEqual(result.hiddenWeeks, ["2025-12-01"]);
  assert.ok(result.visibleFields.includes("progress"));
  assert.ok(result.visibleFields.includes("type"));
  assert.equal(empty.rows.length, 0);
});

test("명시된 연도·수식 날짜와 두 번의 연말 경계를 유지한다", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("업무");
  sheet.addRow([
    "작업",
    "12/6",
    "1/3",
    "12/26",
    "1/2",
    { formula: "DATE(2026,1,9)", result: 46031 },
  ]);
  sheet.getCell("F1").numFmt = "yyyy-mm-dd";
  sheet.addRow(["연결 검증", "a", "b", "c", "d", "e"]);
  const [result] = await inspectWorkbook(
    await workbook.xlsx.writeBuffer(),
    2026,
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(
    Object.keys(result.rows[0].cells).filter((k) => /^20/.test(k)),
    ["2024-12-02", "2024-12-30", "2025-12-22", "2025-12-29", "2026-01-05"],
  );
});
