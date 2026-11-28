import { mapDocumentPosition } from "../../../shared/documents/document-merge.js";
import { withoutImageSpacer } from "./DocumentImageView";
import { sameContent } from "./DocumentInputRules";

import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node } from "@milkdown/kit/prose/model";
import { EditorState, Selection } from "@milkdown/kit/prose/state";
import { Transform } from "@milkdown/kit/prose/transform";

// Private-use characters stand for positions while the text goes through the
// editor's own serializer or parser. Markdown escapes and parses them as
// plain letters.
const MARKS = ["\uE000", "\uE001", "\uE002"];
const ANY_MARK = /[\uE000-\uE002]/g;
const MAX_BISECTED = 64 * 1024;

// The offsets in `markdown`, the text the document shows, of document
// positions. Each position counts as its nearest text position, and the
// serializer's own spelling (`*` lists, escapes) is mapped to `markdown`.
export function markdownOffsets(
  ctx: Ctx,
  state: EditorState,
  positions: number[],
  markdown: string,
): (number | null)[] {
  const { doc } = state;
  const texts = positions.map((pos) => {
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    if ($pos.parent.inlineContent) return $pos.pos;
    return (
      Selection.findFrom($pos, 1, true) ?? Selection.findFrom($pos, -1, true)
    )?.head;
  });
  const unique = [...new Set(texts)]
    .filter((pos): pos is number => pos != null)
    .sort((a, b) => b - a);
  const tr = state.tr;
  // From the end, so the earlier positions stay valid.
  unique.forEach((pos, index) => tr.insertText(MARKS[index], pos));
  const marked = ctx.get(serializerCtx)(withoutImageSpacer(state.apply(tr)));
  const written = marked.replace(ANY_MARK, "");
  const offsets = unique.map((_, index) => {
    const at = marked.indexOf(MARKS[index]);
    if (at < 0) return null;
    const offset = at - (marked.slice(0, at).match(ANY_MARK)?.length ?? 0);
    return written === markdown
      ? offset
      : mapDocumentPosition(written, markdown, offset);
  });
  return texts.map((pos) =>
    pos == null ? null : offsets[unique.indexOf(pos)],
  );
}

// The position in `doc`, the editor's parse of `markdown`, of a Markdown
// offset. The offset is marked and parsed again. A mark that changes the
// blocks, as inside `**`, a link address or a fence line, is moved to the end
// of its line, then of the next and the previous line.
export function documentPosition(
  ctx: Ctx,
  doc: Node,
  markdown: string,
  offset: number,
): number | null {
  const parse = ctx.get(parserCtx);
  const lineEnd = (at: number) => {
    const end = markdown.indexOf("\n", at);
    return end < 0 ? markdown.length : end;
  };
  const end = lineEnd(offset);
  const previous = markdown.lastIndexOf("\n", offset - 1);
  const tries = new Set([offset, end, lineEnd(end + 1), previous]);
  for (const at of tries) {
    if (at < 0 || at > markdown.length) continue;
    let marked: Node;
    try {
      marked = parse(markdown.slice(0, at) + MARKS[0] + markdown.slice(at));
    } catch {
      continue;
    }
    let found: number | null = null;
    marked.descendants((node, pos) => {
      if (found !== null) return false;
      const index = node.isText ? node.text!.indexOf(MARKS[0]) : -1;
      if (index >= 0) found = pos + index;
      return found === null;
    });
    if (
      found !== null &&
      sameContent(new Transform(marked).delete(found, found + 1).doc, doc)
    )
      return found;
  }
  // A mark that fits nowhere near, as in a link address inside a table, is
  // left for bisection: serialized offsets grow with positions. It serializes
  // the document each step, so a long document skips it.
  if (markdown.length > MAX_BISECTED) return null;
  const state = EditorState.create({ doc });
  let low = 0,
    high = doc.content.size;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const [at] = markdownOffsets(ctx, state, [middle], markdown);
    if (at != null && at <= offset) low = middle;
    else high = middle - 1;
  }
  return Selection.near(doc.resolve(low)).head;
}
