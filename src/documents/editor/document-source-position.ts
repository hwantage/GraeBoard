import { mapDocumentPositions } from "../../../shared/documents/document-merge.js";
import { withoutImageSpacer } from "./DocumentImageView";
import { sameContent } from "./DocumentInputRules";

import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Fragment, type Node } from "@milkdown/kit/prose/model";
import { Selection, type EditorState } from "@milkdown/kit/prose/state";
import { Transform } from "@milkdown/kit/prose/transform";

// Private-use characters stand for positions while the text goes through the
// editor's own serializer or parser. Markdown escapes and parses them as
// plain letters.
const MARKS = ["\uE000", "\uE001", "\uE002"];
const MARK = MARKS[0];
const ANY_MARK = /[\uE000-\uE002]/g;

// The offset of each `MARK` in `text`, counted without the marks.
function markOffsets(text: string) {
  const offsets: number[] = [];
  for (let at = text.indexOf(MARK); at >= 0; at = text.indexOf(MARK, at + 1))
    offsets.push(at - offsets.length);
  return offsets;
}

// Offsets in one spelling of the document mapped to another, such as the
// serializer's `*` lists and escapes against the saved source. When the two
// are too different to compare in time, the same column of the same line.
function mapOffsets(from: string, to: string, offsets: number[]): number[] {
  if (from === to) return offsets;
  const mapped: number[] | null = mapDocumentPositions(from, to, offsets);
  if (mapped) return mapped;
  const lines = to.split("\n");
  return offsets.map((offset) => {
    const start = from.lastIndexOf("\n", offset - 1) + 1;
    const line = Math.min(
      from.slice(0, start).split("\n").length - 1,
      lines.length - 1,
    );
    let at = 0;
    for (let index = 0; index < line; index++) at += lines[index].length + 1;
    return at + Math.min(offset - start, lines[line].length);
  });
}

// The offsets in `markdown`, the text the document shows, of document
// positions. Each position counts as its nearest text position.
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
  const found = unique.map((_, index) => marked.indexOf(MARKS[index]));
  const offsets = mapOffsets(
    marked.replace(ANY_MARK, ""),
    markdown,
    found.map(
      (at) =>
        at - (marked.slice(0, Math.max(at, 0)).match(ANY_MARK)?.length ?? 0),
    ),
  );
  return texts.map((pos) => {
    const index = pos == null ? -1 : unique.indexOf(pos);
    return index < 0 || found[index] < 0 ? null : offsets[index];
  });
}

// The offset marked and parsed again gives the position exactly, unless the
// mark changes the blocks, as inside `**`, a link address or a fence line.
function markedPosition(ctx: Ctx, doc: Node, markdown: string, offset: number) {
  let marked: Node;
  try {
    marked = ctx.get(parserCtx)(
      markdown.slice(0, offset) + MARK + markdown.slice(offset),
    );
  } catch {
    return null;
  }
  let found: number | null = null;
  marked.descendants((node, pos) => {
    if (found !== null) return false;
    const index = node.isText ? node.text!.indexOf(MARK) : -1;
    if (index >= 0) found = pos + index;
    return found === null;
  });
  return found !== null &&
    sameContent(new Transform(marked).delete(found, found + 1).doc, doc)
    ? found
    : null;
}

// A copy of the document with `MARK` at the start and end of every text
// block, built in one pass: a transform step per block would copy each parent
// each time.
function markBlocks(node: Node): Node {
  if (node.isTextblock) {
    const mark = Fragment.from(node.type.schema.text(MARK));
    return node.copy(mark.append(node.content).append(mark));
  }
  if (node.isLeaf) return node;
  const children: Node[] = [];
  node.forEach((child) => children.push(markBlocks(child)));
  return node.copy(Fragment.fromArray(children));
}

// A text block with `MARK` at each of its positions, and those positions.
function markPositions(block: Node, start: number) {
  const { schema } = block.type;
  const parts: Node[] = [];
  const positions: number[] = [];
  let pos = start;
  block.forEach((child) => {
    for (const part of child.isText ? [...child.text!] : [child]) {
      parts.push(schema.text(MARK, child.marks));
      positions.push(pos);
      if (typeof part === "string") {
        parts.push(schema.text(part, child.marks));
        pos += part.length;
      } else {
        parts.push(part);
        pos += part.nodeSize;
      }
    }
  });
  parts.push(schema.text(MARK));
  positions.push(pos);
  return { block: block.copy(Fragment.fromArray(parts)), positions };
}

// The positions in `doc`, the editor's parse of `markdown`, of Markdown
// offsets. An offset the parser cannot place (`markedPosition`) is found in
// the serializer's spelling instead. One serialization with marks at each
// text block's start and end finds the block, or the nearer block edge for
// syntax between blocks, such as a fence line. Another with a mark at each
// position of that block finds the nearest position. Marks change escapes
// beside them and widen table columns, so each serialization compares the
// offset mapped to its own text.
// A few passes over the document, whatever its size.
export function documentPositions(
  ctx: Ctx,
  doc: Node,
  markdown: string,
  offsets: number[],
): (number | null)[] {
  const found = new Map<number, number>();
  const missing: number[] = [];
  for (const offset of new Set(offsets)) {
    const pos = markedPosition(ctx, doc, markdown, offset);
    if (pos === null) missing.push(offset);
    else found.set(offset, pos);
  }
  const blocks: { node: Node; start: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) blocks.push({ node, start: pos + 1 });
    return !node.isTextblock;
  });
  if (missing.length && blocks.length) {
    const serialize = ctx.get(serializerCtx);
    const withEdges = serialize(markBlocks(doc));
    // The start and end of block `n` are edges[2n] and edges[2n + 1]. The
    // offsets are mapped to the same text, whose table padding the marks
    // widened.
    const edges = markOffsets(withEdges);
    const targets = mapOffsets(
      markdown,
      withEdges.replace(ANY_MARK, ""),
      missing,
    );
    const inBlock = new Map<
      number,
      { positions: number[]; at: number[]; written: string }
    >();
    targets.forEach((target, index) => {
      let block = 0;
      while (block + 1 < blocks.length && edges[2 * block + 2] <= target)
        block++;
      const { node, start } = blocks[block];
      const end = edges[2 * block + 1];
      if (target >= end) {
        const next = edges[2 * block + 2];
        found.set(
          missing[index],
          next !== undefined && next - target < target - end
            ? blocks[block + 1].start
            : start + node.content.size,
        );
        return;
      }
      let marked = inBlock.get(block);
      if (!marked) {
        const { block: copy, positions } = markPositions(node, start);
        const replaced = new Transform(doc).replaceWith(
          start - 1,
          start - 1 + node.nodeSize,
          copy,
        );
        const text = serialize(replaced.doc);
        marked = {
          positions,
          at: markOffsets(text),
          written: text.replace(ANY_MARK, ""),
        };
        inBlock.set(block, marked);
      }
      // The offset in this serialization, whose escapes around the marks
      // and table padding differ from the one that found the block.
      const [wanted] = mapOffsets(markdown, marked.written, [missing[index]]);
      // The nearest position; the earlier one when two are as near.
      let nearest = 0;
      marked.at.forEach((at, position) => {
        if (Math.abs(at - wanted) < Math.abs(marked.at[nearest] - wanted))
          nearest = position;
      });
      found.set(missing[index], marked.positions[nearest]);
    });
  }
  return offsets.map((offset) => found.get(offset) ?? null);
}
