import {
  inToggleSummary,
  setToggleCommand,
  unwrapToggleCommand,
} from "./DocumentToggle";

import { editorViewCtx, commandsCtx } from "@milkdown/kit/core";
import {
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  headingSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";

import { TextSelection, type Command } from "@milkdown/kit/prose/state";
import { Fragment, NodeRange, type Node } from "@milkdown/kit/prose/model";
import { keydownHandler } from "@milkdown/kit/prose/keymap";

import { closeHistory } from "@milkdown/kit/prose/history";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
} from "@milkdown/kit/prose/tables";

import type { Ctx } from "@milkdown/kit/ctx";

export const deleteTableColumn: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { left, right, map } = selectedRect(state);
  return (right - left === map.width ? deleteTable : deleteColumn)(
    state,
    dispatch,
  );
};
export const deleteTableRow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { top, bottom, map } = selectedRect(state);
  // Milkdown's Markdown table requires a header and at least one body row.
  if (top === 0 || bottom - top === map.height - 1) return false;
  return deleteRow(state, dispatch);
};
export type ListFormat = "bullet" | "ordered" | "task";
export function listFormatCommand(format: ListFormat): Command {
  return (state, dispatch) => {
    const { schema, selection } = state;
    const { $from, $to } = selection;
    const isList = (node: Node) =>
      node.type === schema.nodes.bullet_list ||
      node.type === schema.nodes.ordered_list;
    let range = $from.blockRange($to);
    // A caret or selection within one list changes that list's depth only.
    for (let depth = $from.sharedDepth($to.pos); depth > 0; depth--) {
      if (isList($from.node(depth))) {
        range = new NodeRange($from, $to, depth - 1);
        break;
      }
    }
    if (!range) return false;
    const { parent, startIndex, endIndex, start, end } = range;
    const type =
      schema.nodes[format === "ordered" ? "ordered_list" : "bullet_list"];
    const first = parent.child(startIndex);
    const attrs = isList(first) ? first.attrs : undefined;
    const order = attrs?.order ?? 1;
    const items: Node[] = [];
    // Map text positions inside the replacement, including backwards ranges.
    // The default replace mapping would collapse the selection to its end.
    const positions: { from: number; to: number; offset: number }[] = [];
    let size = 0;
    const append = (item: Node, from: number, to: number, offset: number) => {
      const checked = format === "task" ? (item.attrs.checked ?? false) : null;
      const listType = format === "ordered" ? "ordered" : "bullet";
      const label = format === "ordered" ? `${order + items.length}.` : "•";
      items.push(
        item.attrs.checked === checked &&
          item.attrs.listType === listType &&
          item.attrs.label === label
          ? item
          : item.type.create(
              { ...item.attrs, checked, listType, label },
              item.content,
              item.marks,
            ),
      );
      positions.push({ from, to, offset: start + 1 + size + offset - from });
      size += item.nodeSize;
    };
    let pos = start;
    for (let index = startIndex; index < endIndex; index++) {
      const block = parent.child(index);
      if (isList(block)) {
        block.forEach((item, offset) => {
          const from = pos + 1 + offset;
          append(item, from, from + item.nodeSize, 0);
        });
      } else if (block.isTextblock) {
        const paragraph = schema.nodes.paragraph.create(null, block.content);
        append(
          schema.nodes.list_item.create(null, paragraph),
          pos,
          pos + block.nodeSize,
          1,
        );
      } else return false;
      pos += block.nodeSize;
    }
    const list = type.create(
      attrs,
      items,
      isList(first) ? first.marks : undefined,
    );
    const content = Fragment.from(list);
    if (!parent.canReplace(startIndex, endIndex, content)) return false;
    if (dispatch && !state.doc.slice(start, end).content.eq(content)) {
      // Build once: one replacement avoids rebuilding the parent per item.
      const tr = state.tr.replaceWith(start, end, list);
      if (selection instanceof TextSelection) {
        const mapPosition = (pos: number) => {
          const part = positions.find(
            ({ from, to }) => pos >= from && pos <= to,
          );
          return part ? pos + part.offset : tr.mapping.map(pos);
        };
        tr.setSelection(
          TextSelection.create(
            tr.doc,
            mapPosition(selection.anchor),
            mapPosition(selection.head),
          ),
        );
      }
      dispatch(closeHistory(tr).scrollIntoView());
    }
    return true;
  };
}
export const listFormatKeydown = keydownHandler({
  "Mod-Alt-7": listFormatCommand("ordered"),
  "Mod-Alt-8": listFormatCommand("bullet"),
});
export function blockCommand(ctx: Ctx, value: string): Command | null {
  if (value === "bullet" || value === "ordered" || value === "task")
    return listFormatCommand(value);
  if (value.startsWith("toggle"))
    return setToggleCommand(Number(value.slice(6)) || 0);
  const commands = ctx.get(commandsCtx);
  const summary = inToggleSummary(ctx.get(editorViewCtx).state);
  if (value.startsWith("h")) {
    const level = Number(value.slice(1));
    return summary
      ? unwrapToggleCommand(headingSchema.type(ctx), { level })
      : commands.get(wrapInHeadingCommand.key)(level);
  }
  if (value === "paragraph")
    return summary
      ? unwrapToggleCommand(paragraphSchema.type(ctx))
      : commands.get(turnIntoTextCommand.key)();
  if (value === "quote") return commands.get(wrapInBlockquoteCommand.key)();
  if (value === "code") return commands.get(createCodeBlockCommand.key)();
  return null;
}
