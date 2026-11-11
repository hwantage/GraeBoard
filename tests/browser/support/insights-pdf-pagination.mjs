import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Read the real serialized PDF, not the HTML preview's unpaginated layout.
// Poppler is a test prerequisite; never turn a missing tool into a skip/pass.
export function pdfTextPages(path) {
  let text;
  try {
    text = execFileSync("pdftotext", ["-layout", path, "-"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
    });
  } catch (cause) {
    throw new Error(
      "Actual Insights PDF pagination checks require Poppler's pdftotext on PATH (brew install poppler / apt-get install poppler-utils).",
      { cause },
    );
  }
  return text.split("\f").filter((page) => page.trim());
}

const compact = (text) => text.normalize("NFC").replace(/\s+/gu, "");
export function assertPdfTableStart(pages, { title, columns, firstRow }) {
  const matches = pages.flatMap((page, index) =>
    compact(page).includes(compact(title)) ? [index] : [],
  );
  assert.equal(matches.length, 1, `${title}: expected one chart heading`);
  const index = matches[0];
  const content = compact(pages[index]);
  const afterTitle = content.slice(
    content.indexOf(compact(title)) + compact(title).length,
  );
  assert.ok(firstRow.trim(), `${title}: expected a nonempty source first row`);
  const firstRowOffset = afterTitle.indexOf(compact(firstRow));
  const header =
    firstRowOffset < 0 ? afterTitle : afterTitle.slice(0, firstRowOffset);
  for (const column of columns)
    assert.ok(
      header.includes(compact(column)),
      `${title}: PDF page ${index + 1} lacks its own column ${column} after the heading and before the first row`,
    );
  assert.ok(
    firstRowOffset >= 0,
    `${title}: PDF page ${index + 1} must include the first data row after its heading`,
  );
  return { title, pageNumber: index + 1, pageCount: pages.length };
}
