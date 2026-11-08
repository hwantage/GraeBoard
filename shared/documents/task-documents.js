// Markdown is the source of truth. Keep this module parser-free for the grid.
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_TASK_DOCUMENTS = 50;
export const MAX_DOCUMENT_TITLE_LENGTH = 50;
export const DEFAULT_DOCUMENT_ID = "main";
export const DEFAULT_DOCUMENT_TITLE = "문서 1";
export const documentBytes = (markdown) =>
  new TextEncoder().encode(markdown).length;
export function hasDocumentContent(markdown = "") {
  return !!markdown
    .replace(/^[ \t]*(?:#{1,6}|>|[-+*]|\d+[.)])(?:[ \t]+|$)/gm, "")
    .replace(/^[ \t]*\[[ xX]\][ \t]*/gm, "")
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/[\s*_~`\u200B-\u200D\uFEFF-]/gu, "");
}
