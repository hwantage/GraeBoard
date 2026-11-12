import {
  inToggleSummary,
  setToggleCommand,
  unwrapToggleCommand,
} from "./DocumentToggle";

import { commandsCtx } from "@milkdown/kit/core";
import {
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  headingSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";

import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Fragment, NodeRange, type Node } from "@milkdown/kit/prose/model";
import { canJoin, liftTarget, StepMap } from "@milkdown/kit/prose/transform";
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
// Lift the list item at `pos` out of its own list, into the block that holds
// the list: the top level, a toggle, a quote or the parent item of a nested
// list. The list splits around the item. The item's other blocks, such as its
// sub-items, follow its paragraph and join the items after it when both are
// the same kind of list. A checklist item's check is dropped with the item.
// When an ordered list splits, the list after the item continues from the
// item's number.
function liftItemOutOfList(tr: Transaction, pos: number) {
  const { doc } = tr;
  const item = doc.nodeAt(pos);
  if (!item) return false;
  const $item = doc.resolve(pos);
  const list = $item.parent;
  const index = $item.index();
  const range = new NodeRange(
    doc.resolve(pos + 1),
    doc.resolve(pos + item.nodeSize - 1),
    $item.depth + 1,
  );
  if (liftTarget(range) !== $item.depth - 1) return false;
  const steps = tr.steps.length;
  tr.lift(range, $item.depth - 1);
  // In a tight parent item Markdown would join the lifted blocks to the lists
  // around them without blank lines, and a paragraph after a list, a block
  // after a toggle or an ordered list not starting at 1 would then be read
  // back as part of the block before it. A loose item keeps them apart.
  const holder = $item.node($item.depth - 1);
  if (holder.type === item.type && !holder.attrs.spread)
    tr.setNodeMarkup($item.before($item.depth - 1), undefined, {
      ...holder.attrs,
      spread: true,
    });
  if (index === list.childCount - 1) return true;
  // The list of the items after the lifted one starts right after its blocks.
  const after = tr.mapping.slice(steps).map(pos + item.nodeSize - 1, -1);
  const rest = tr.doc.nodeAt(after);
  if (!rest || rest.type !== list.type) return true;
  const attrs =
    index && list.type.name === "ordered_list"
      ? { ...rest.attrs, order: (list.attrs.order ?? 1) + index + 1 }
      : rest.attrs;
  const $after = tr.doc.resolve(after);
  const children = $after.nodeBefore;
  if (children?.type === rest.type && canJoin(tr.doc, after)) {
    tr.setNodeMarkup(after - children.nodeSize, undefined, attrs);
    tr.join(after);
  } else if (attrs !== rest.attrs) tr.setNodeMarkup(after, undefined, attrs);
  return true;
}

// Lift every list item whose first paragraph the selection touches. A
// selection ending at the start of an item's line, as Shift+Down leaves it,
// does not take that item, as for the block handle. The last item goes
// first: a lift keeps the positions before the lifted item, so the positions
// found earlier stay valid, and a nested item leaves before its parent item
// does.
function liftSelectedListItems(state: EditorState): Transaction | null {
  const { from, to, empty } = state.selection;
  const listItem = state.schema.nodes.list_item;
  const found: number[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (
      node.type === listItem &&
      (empty ? pos + 1 : pos + 2) < to &&
      pos + 1 + node.firstChild!.nodeSize > from
    )
      found.push(pos);
  });
  if (!found.length) return null;
  const tr = state.tr;
  for (const pos of found.reverse())
    if (!liftItemOutOfList(tr, pos)) return null;
  return tr;
}

// The block menu checks every format against the same state. They share one
// lifted state instead of lifting again for each format.
const liftedStates = new WeakMap<EditorState, EditorState | null>();
function liftedState(state: EditorState): EditorState | null {
  let lifted = liftedStates.get(state);
  if (lifted === undefined) {
    const tr = liftSelectedListItems(state);
    lifted = tr && EditorState.create({ doc: tr.doc, selection: tr.selection });
    liftedStates.set(state, lifted);
  }
  return lifted;
}

// A list item starts with a paragraph, so a heading, quote, code block or
// toggle cannot replace it there. Lift the selected items out of their lists
// first and convert them in the same change, one undo step. Turning items into
// paragraphs needs only the lift.
function outOfListCommand(convert: Command, liftConverts = false): Command {
  return (state, dispatch, view) => {
    if (!dispatch) {
      const next = liftedState(state);
      return next
        ? convert(next) || liftConverts
        : convert(state, undefined, view);
    }
    const lifted = liftSelectedListItems(state);
    if (!lifted) return convert(state, dispatch, view);
    const next = EditorState.create({
      doc: lifted.doc,
      selection: lifted.selection,
    });
    const result: { tr: Transaction | null } = { tr: null };
    if (!convert(next, (tr) => (result.tr = tr)) && !liftConverts) return false;
    const converted = result.tr;
    if (converted) {
      for (const step of converted.steps) lifted.step(step);
      if (converted.selectionSet)
        lifted.setSelection(converted.selection.map(lifted.doc, StepMap.empty));
    }
    dispatch(closeHistory(lifted).scrollIntoView());
    return true;
  };
}

// In a toggle's title the toggle itself changes. The state the command runs
// on decides, so a check against another selection gives the same answer.
function summaryOr(summary: Command, other: Command): Command {
  return (state, dispatch, view) =>
    (inToggleSummary(state) ? summary : other)(state, dispatch, view);
}

export function blockCommand(ctx: Ctx, value: string): Command | null {
  if (value === "bullet" || value === "ordered" || value === "task")
    return listFormatCommand(value);
  if (value.startsWith("toggle"))
    return outOfListCommand(setToggleCommand(Number(value.slice(6)) || 0));
  const commands = ctx.get(commandsCtx);
  if (value.startsWith("h")) {
    const level = Number(value.slice(1));
    return summaryOr(
      unwrapToggleCommand(headingSchema.type(ctx), { level }),
      outOfListCommand(commands.get(wrapInHeadingCommand.key)(level)),
    );
  }
  if (value === "paragraph")
    return summaryOr(
      unwrapToggleCommand(paragraphSchema.type(ctx)),
      outOfListCommand(commands.get(turnIntoTextCommand.key)(), true),
    );
  if (value === "quote")
    return outOfListCommand(commands.get(wrapInBlockquoteCommand.key)());
  if (value === "code")
    return outOfListCommand(commands.get(createCodeBlockCommand.key)());
  return null;
}
