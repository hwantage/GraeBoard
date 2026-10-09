import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { inspectWorkbook } from "../server/transfer.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";

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
