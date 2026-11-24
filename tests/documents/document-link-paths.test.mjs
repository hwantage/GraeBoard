import test from "node:test";
import assert from "node:assert/strict";
import {
  documentLinkPath,
  documentLinkWithoutDocument,
  parseDocumentLinkPath,
} from "../../shared/documents/document-links.js";

const TASK = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";

test("link paths read back as written, with a task's document when named", () => {
  const targets = [
    { kind: "task", id: TASK },
    { kind: "task", id: TASK, documentId: "main" },
    { kind: "task", id: TASK, documentId: OTHER },
    { kind: "calendar", id: TASK },
    { kind: "memo", teamId: TASK, year: 2026, id: "main" },
    { kind: "memo", teamId: TASK, year: 2026, id: OTHER },
    { kind: "sheet-clone-task", sheetCloneId: OTHER, id: TASK },
    {
      kind: "sheet-clone-task",
      sheetCloneId: OTHER,
      id: TASK,
      documentId: "main",
    },
    {
      kind: "sheet-clone-task",
      sheetCloneId: OTHER,
      id: TASK,
      documentId: TASK,
    },
    { kind: "sheet-clone-memo", sheetCloneId: OTHER, id: "main" },
    { kind: "slide", teamId: OTHER, id: TASK },
  ];
  for (const target of targets)
    assert.deepEqual(parseDocumentLinkPath(documentLinkPath(target)), target);
  // Paths stored before the document part keep their meaning.
  assert.equal(
    documentLinkPath({ kind: "task", id: TASK }),
    `/links/task/${TASK}`,
  );
  assert.equal(
    documentLinkPath({ kind: "task", id: TASK, documentId: OTHER }),
    `/links/task/${TASK}/${OTHER}`,
  );
  assert.equal(
    documentLinkPath({
      kind: "sheet-clone-task",
      sheetCloneId: OTHER,
      id: TASK,
      documentId: "main",
    }),
    `/links/sheet-clone-task/${OTHER}/${TASK}/main`,
  );
  assert.equal(
    documentLinkPath({ kind: "slide", teamId: OTHER, id: TASK }),
    `/links/slide/${OTHER}/${TASK}`,
  );
});

test("a slide link names a team and one of its files by UUID", () => {
  for (const path of [
    `/links/slide/${TASK}`,
    `/links/slide/${OTHER}/main`,
    `/links/slide/${OTHER}/${TASK}/main`,
    `/links/slide/${OTHER}/${TASK}/`,
    `/links/slide/not-a-team/${TASK}`,
    `/links/slide/${OTHER}/${TASK}?share=abc`,
  ])
    assert.equal(parseDocumentLinkPath(path), null, path);
});

test("only tasks take a document, and only a document ID", () => {
  for (const path of [
    `/links/task/${TASK}/`,
    `/links/task/${TASK}/second`,
    `/links/task/${TASK}/main/`,
    `/links/task/${TASK}/main/${OTHER}`,
    `/links/task/${TASK}/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`,
    `/links/calendar/${TASK}/main`,
    `/links/memo/${TASK}/2026/main/main`,
    `/links/sheet-clone-task/${OTHER}/${TASK}/main/main`,
    `/links/sheet-clone-memo/${OTHER}/main/main`,
    `/links/task/${TASK}?document=main`,
  ])
    assert.equal(parseDocumentLinkPath(path), null, path);
});

test("links to different documents of a task share its window", () => {
  assert.deepEqual(
    documentLinkWithoutDocument({ kind: "task", id: TASK, documentId: "main" }),
    { kind: "task", id: TASK },
  );
  assert.deepEqual(
    documentLinkWithoutDocument({
      kind: "sheet-clone-task",
      sheetCloneId: OTHER,
      id: TASK,
      documentId: OTHER,
    }),
    { kind: "sheet-clone-task", sheetCloneId: OTHER, id: TASK },
  );
  const memo = { kind: "memo", teamId: TASK, year: 2026, id: "main" };
  assert.equal(documentLinkWithoutDocument(memo), memo);
});
