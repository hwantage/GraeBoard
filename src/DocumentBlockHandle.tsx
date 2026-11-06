import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from "lucide-react";
import { Fragment, Slice, type Node } from "@milkdown/kit/prose/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";
import { canJoin, dropPoint } from "@milkdown/kit/prose/transform";
import { closeHistory } from "@milkdown/kit/prose/history";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import { $prose } from "@milkdown/kit/utils";
import DocumentSlashMenu, { type SlashItem } from "./DocumentSlashMenu";
import { TOGGLE_LEVELS } from "./DocumentToggle";
import { trackPointerDrag } from "./trackPointerDrag";

// The handle in the left gutter moves a block by dragging and opens a menu to
// convert, duplicate, move or delete it. A block is a top-level block, a list
// item or a block inside a toggle's content; tables, quotes and code blocks
// move as a whole. Blocks a selection spans move together: a text selection
// across blocks, the blocks a drag in the margin selects, or a range extended
// with Shift+click on a handle. Moves are ordinary document changes, so the
// saved Markdown keeps its usual shape and one move is one undo step.

// "/" menu formats offered under 전환. They act on the caret, which the menu
// places in the block first.
export const BLOCK_FORMATS = [
  "paragraph",
  "h1",
  "h2",
  "h3",
  "bullet",
  "ordered",
  "task",
  "quote",
  "code",
  "toggle0",
  ...TOGGLE_LEVELS.map((level) => `toggle${level}`),
];

type Block = { pos: number; node: Node };
// Whole sibling blocks of one container, from the start of the first to the
// end of the last.
type Range = { from: number; to: number };
const CONTAINERS = new Set([
  "doc",
  "bullet_list",
  "ordered_list",
  "toggle_content",
]);
const LISTS = new Set(["bullet_list", "ordered_list"]);
const WHOLE = new Set(["table", "blockquote", "code_block"]);

function blockAt(doc: Node, inside: number): Block | null {
  const $pos = doc.resolve(inside);
  const chain: Block[] = [];
  for (let depth = 1; depth <= $pos.depth; depth++)
    chain.push({ pos: $pos.before(depth), node: $pos.node(depth) });
  const node = doc.nodeAt(inside);
  if (node && !node.isInline) chain.push({ pos: inside, node });
  let found: Block | null = null;
  let parent = doc;
  for (const block of chain) {
    if (CONTAINERS.has(parent.type.name)) found = block;
    if (WHOLE.has(block.node.type.name)) break;
    parent = block.node;
  }
  return found;
}

function blockFrom(doc: Node, pos: number): Block | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const node = doc.nodeAt(pos);
  return node && !node.isInline ? { pos, node } : null;
}

const rangeOf = (block: Block): Range => ({
  from: block.pos,
  to: block.pos + block.node.nodeSize,
});

function blockRange(doc: Node, from: number, to: number): Range | null {
  if (from < 0 || to > doc.content.size || from >= to) return null;
  const $from = doc.resolve(from);
  return $from.sameParent(doc.resolve(to)) &&
    CONTAINERS.has($from.parent.type.name)
    ? { from, to }
    : null;
}

const rangeContent = (doc: Node, range: Range) =>
  doc.slice(range.from, range.to).content;

// The empty paragraph at the end is the typing area the trailing plugin keeps.
// It is never saved, so it neither moves nor takes blocks below it.
function isTypingArea(doc: Node, block: Block) {
  return (
    block.pos + block.node.nodeSize === doc.content.size &&
    block.node.type.name === "paragraph" &&
    !block.node.content.size
  );
}

function withoutTypingArea(doc: Node, range: Range): Range {
  const last = doc.lastChild;
  return last &&
    range.to === doc.content.size &&
    range.to - last.nodeSize > range.from &&
    isTypingArea(doc, { pos: range.to - last.nodeSize, node: last })
    ? { from: range.from, to: range.to - last.nodeSize }
    : range;
}

// The nearest block around `pos` that has its own handle, such as the toggle
// around its content or the item around a nested list.
function enclosingBlock(doc: Node, pos: number): Block | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--)
    if (CONTAINERS.has($pos.node(depth - 1).type.name))
      return { pos: $pos.before(depth), node: $pos.node(depth) };
  return null;
}

// The blocks from `a` to `b` at the deepest level where they are siblings:
// items of one list, or the top-level blocks around lists and toggles.
function rangeBetween(doc: Node, a: Block, b: Block): Range | null {
  const chain = (block: Block) => {
    const blocks = [block];
    for (
      let next = enclosingBlock(doc, block.pos);
      next;
      next = enclosingBlock(doc, next.pos)
    )
      blocks.push(next);
    return blocks;
  };
  const others = chain(b);
  for (const x of chain(a))
    for (const y of others) {
      const $x = doc.resolve(x.pos);
      if (!$x.sameParent(doc.resolve(y.pos))) continue;
      return withoutTypingArea(doc, {
        from: Math.min(x.pos, y.pos),
        to: Math.max(x.pos + x.node.nodeSize, y.pos + y.node.nodeSize),
      });
    }
  return null;
}

// Blocks selected with a drag in the margin or Shift+click on a handle. The
// editor keeps a text selection over them for copying and typing; this range
// also holds a divider at either end and shows the blocks as selected. Any
// other selection change ends it.
type Selected = { range: Range; selection: Selection } | null;
const selectKey = new PluginKey<Selected>("document-block-select");
export const blockSelect = $prose(
  () =>
    new Plugin<Selected>({
      key: selectKey,
      state: {
        init: () => null,
        apply: (tr, value, _previous, state) => {
          const meta = tr.getMeta(selectKey);
          if (meta !== undefined) return meta;
          if (!value) return null;
          let selection = value.selection.map(tr.doc, tr.mapping);
          // Plugins may adjust the selection made for the blocks, as tables
          // do for one that ends in an empty cell.
          if (tr.getMeta("appendedTransaction") && !tr.docChanged)
            selection = state.selection;
          if (!selection.eq(state.selection)) return null;
          const range = blockRange(
            tr.doc,
            tr.mapping.map(value.range.from, 1),
            tr.mapping.map(value.range.to, -1),
          );
          return range && { range, selection };
        },
      },
      props: {
        decorations: (state) => {
          const value = selectKey.getState(state);
          if (!value) return null;
          const decorations: Decoration[] = [];
          let pos = value.range.from;
          rangeContent(state.doc, value.range).forEach((node) => {
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: "document-block-selected",
              }),
            );
            pos += node.nodeSize;
          });
          return DecorationSet.create(state.doc, decorations);
        },
        attributes: (state): Record<string, string> =>
          selectKey.getState(state)
            ? { class: "document-blocks-selected" }
            : {},
      },
    }),
);

function selectRange(view: EditorView, range: Range) {
  const { state } = view;
  const current = selectKey.getState(state);
  if (
    current &&
    current.range.from === range.from &&
    current.range.to === range.to
  )
    return;
  const tr = state.tr.setSelection(
    TextSelection.between(
      state.doc.resolve(range.from),
      state.doc.resolve(range.to),
    ),
  );
  view.dispatch(tr.setMeta(selectKey, { range, selection: tr.selection }));
}

// The blocks the selection covers: the selected range, a run of sibling
// blocks around a selection that spans several, or the caret's block.
function selectedRange(state: EditorState): Range | null {
  const selected = selectKey.getState(state);
  if (selected) return selected.range;
  const { selection, doc } = state;
  if (selection instanceof NodeSelection) {
    const block = blockAt(doc, selection.from);
    return block && selection.to <= block.pos + block.node.nodeSize
      ? rangeOf(block)
      : null;
  }
  const { $from } = selection;
  // A gap cursor between blocks is in neither of them.
  if (selection.empty && !$from.depth) return null;
  let { $to } = selection;
  // A selection ending at the start of a line, as Shift+Down leaves it,
  // does not take that line's block.
  if ($to.depth && !$to.parentOffset && $to.pos > $from.pos) {
    const previous = Selection.findFrom(doc.resolve($to.before()), -1, true);
    if (previous && previous.$head.pos >= $from.pos) $to = previous.$head;
  }
  const first = $from.depth
    ? blockAt(doc, $from.before())
    : blockFrom(doc, $from.pos);
  const lastNode = $to.depth ? null : $to.nodeBefore;
  const last = $to.depth
    ? blockAt(doc, $to.before())
    : lastNode && { pos: $to.pos - lastNode.nodeSize, node: lastNode };
  if (!first || !last) return null;
  return first.pos === last.pos
    ? rangeOf(first)
    : rangeBetween(doc, first, last);
}

// The selected blocks when several are selected and `block` is in them,
// otherwise `block` alone. The caret's own block, such as a toggle around
// the block, does not count.
function rangeFor(state: EditorState, block: Block): Range {
  const selected = selectedRange(state);
  const several =
    !!selected &&
    (!!selectKey.getState(state) ||
      rangeContent(state.doc, selected).childCount > 1);
  return several &&
    selected.from <= block.pos &&
    block.pos + block.node.nodeSize <= selected.to
    ? selected
    : rangeOf(block);
}

function firstText(block: Block) {
  if (block.node.isTextblock) return block.pos + 1;
  let found: number | null = null;
  block.node.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) found = block.pos + pos + 2;
    return found === null;
  });
  return found;
}

// A list cannot be empty, so it goes with all of its items.
function removalRange(doc: Node, range: Range): Range {
  let { from, to } = range;
  for (
    let $from = doc.resolve(from);
    $from.depth &&
    LISTS.has($from.parent.type.name) &&
    from === $from.start() &&
    to === $from.end();
    $from = doc.resolve(from)
  ) {
    from = $from.before();
    to = $from.after();
  }
  return { from, to };
}

// Where `source` lands when dropped at the block boundary `pos`: the nearest
// place its blocks fit, as ProseMirror's own drop does. null keeps them.
function dropPosition(doc: Node, source: Range, pos: number) {
  let insert = dropPoint(doc, pos, new Slice(rangeContent(doc, source), 0, 0));
  if (insert === null) return null;
  const last = doc.lastChild;
  if (
    last &&
    insert === doc.content.size &&
    isTypingArea(doc, { pos: insert - last.nodeSize, node: last })
  )
    insert -= last.nodeSize;
  const { from, to } = removalRange(doc, source);
  return insert >= from && insert <= to ? null : insert;
}

// Neighbouring lists of the same kind become one list, as they read.
function joinLists(tr: Transaction, pos: number) {
  const { nodeBefore, nodeAfter } = tr.doc.resolve(pos);
  if (
    nodeBefore &&
    nodeAfter &&
    nodeBefore.type === nodeAfter.type &&
    LISTS.has(nodeBefore.type.name) &&
    canJoin(tr.doc, pos)
  )
    tr.join(pos);
}

// A toggle's content keeps an empty line when all of its blocks leave.
function removeRange(tr: Transaction, range: Range) {
  const { from, to } = removalRange(tr.doc, range);
  const $from = tr.doc.resolve(from);
  if ($from.parent.canReplace($from.index(), tr.doc.resolve(to).index())) {
    tr.delete(from, to);
    joinLists(tr, from);
  } else tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph.create());
}

function keepSelection(
  tr: Transaction,
  selection: Selection,
  map: (pos: number) => number,
) {
  tr.setSelection(
    selection instanceof TextSelection
      ? TextSelection.create(tr.doc, map(selection.anchor), map(selection.head))
      : selection instanceof NodeSelection
        ? NodeSelection.create(tr.doc, map(selection.from))
        : Selection.near(tr.doc.resolve(map(selection.from))),
  );
}

// The selected range follows its blocks to where they now are. A move of
// other blocks maps it as any change does.
function keepSelected(
  tr: Transaction,
  state: EditorState,
  source: Range,
  from: number,
  to: number,
  steps: number,
) {
  const selected = selectKey.getState(state);
  if (
    !selected ||
    selected.range.from < source.from ||
    selected.range.to > source.to
  )
    return;
  const map = tr.mapping.slice(steps);
  // A moved list joined with its neighbour keeps its items selected.
  const range =
    blockRange(tr.doc, map.map(from, 1), map.map(to, -1)) ??
    blockRange(tr.doc, map.map(from + 1, 1), map.map(to - 1, -1));
  tr.setMeta(
    selectKey,
    range && { range: removalRange(tr.doc, range), selection: tr.selection },
  );
}

function moveRange(state: EditorState, source: Range, pos: number) {
  const insert = dropPosition(state.doc, source, pos);
  if (insert === null) return null;
  const content = rangeContent(state.doc, source);
  const tr = state.tr;
  removeRange(tr, source);
  const at = tr.mapping.map(insert);
  const $at = tr.doc.resolve(at);
  let nodes = content;
  if (!$at.parent.canReplace($at.index(), $at.index(), content)) {
    // List items placed outside a list keep their own kind of list.
    const list = state.doc.resolve(source.from).parent;
    if (
      !LISTS.has(list.type.name) ||
      !$at.parent.canReplaceWith($at.index(), $at.index(), list.type)
    )
      return null;
    nodes = Fragment.from(list.type.create(list.attrs, content, list.marks));
  }
  tr.insert(at, nodes);
  const start = at + (nodes === content ? 0 : 1);
  const { selection } = state;
  if (selection.from >= source.from && selection.to <= source.to)
    keepSelection(tr, selection, (position) => position + start - source.from);
  const steps = tr.steps.length;
  joinLists(tr, at + nodes.size);
  joinLists(tr, at);
  keepSelected(tr, state, source, start, start + content.size, steps);
  return closeHistory(tr);
}

function sibling(doc: Node, range: Range, step: -1 | 1) {
  const $from = doc.resolve(range.from);
  const index =
    step < 0 ? $from.index() - 1 : doc.resolve(range.to).index($from.depth);
  return index >= 0 && index < $from.parent.childCount
    ? $from.parent.child(index)
    : null;
}

// One step up or down passes the neighbouring block. At the edge of a list
// the items pass the block next to the list; at the edge of a toggle or a
// nested list they move next to the block around it.
function stepMove(state: EditorState, range: Range, step: -1 | 1) {
  const { doc } = state;
  // A list holding only these items moves as a whole.
  const unit = removalRange(doc, range);
  let anchor = unit;
  const $unit = doc.resolve(unit.from);
  if (!sibling(doc, unit, step) && LISTS.has($unit.parent.type.name))
    anchor = { from: $unit.before(), to: $unit.after() };
  const next = sibling(doc, anchor, step);
  let pos: number;
  if (next) {
    if (step > 0 && isTypingArea(doc, { pos: anchor.to, node: next }))
      return null;
    pos = step < 0 ? anchor.from - next.nodeSize : anchor.to + next.nodeSize;
  } else {
    const outer = enclosingBlock(doc, anchor.from);
    if (!outer) return null;
    pos = step < 0 ? outer.pos : outer.pos + outer.node.nodeSize;
  }
  return moveRange(state, unit, pos);
}

function duplicateRange(state: EditorState, range: Range) {
  const content = rangeContent(state.doc, range);
  const tr = state.tr.insert(range.to, content);
  const { selection } = state;
  if (selection.from >= range.from && selection.to <= range.to)
    keepSelection(tr, selection, (pos) => pos + content.size);
  else tr.setSelection(Selection.near(tr.doc.resolve(range.to + 1)));
  const steps = tr.steps.length;
  joinLists(tr, range.to + content.size);
  joinLists(tr, range.to);
  keepSelected(tr, state, range, range.to, range.to + content.size, steps);
  return closeHistory(tr);
}

function deleteRange(state: EditorState, range: Range) {
  const tr = state.tr;
  removeRange(tr, range);
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(Math.min(tr.mapping.map(range.from), tr.doc.content.size)),
    ),
  );
  return closeHistory(tr.setMeta(selectKey, null));
}

function moveCommand(step: -1 | 1): Command {
  return (state, dispatch) => {
    const range = selectedRange(state);
    if (!range) return false;
    const block = blockFrom(state.doc, range.from);
    const tr =
      block &&
      block.pos + block.node.nodeSize === range.to &&
      isTypingArea(state.doc, block)
        ? null
        : stepMove(state, range, step);
    if (tr) dispatch?.(tr.scrollIntoView());
    // Consume the key at the edges too instead of extending the selection.
    return true;
  };
}
export const blockMoveKeydown = keydownHandler({
  "Alt-Shift-ArrowUp": moveCommand(-1),
  "Alt-Shift-ArrowDown": moveCommand(1),
});

// Keys for blocks selected in the margin: deleting removes them whole, a
// divider at either end included, and Esc leaves the caret in their text.
export function blockSelectKeydown(view: EditorView, event: KeyboardEvent) {
  const selected = selectKey.getState(view.state);
  if (!selected || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key === "Backspace" || event.key === "Delete") {
    view.dispatch(deleteRange(view.state, selected.range).scrollIntoView());
    return true;
  }
  if (event.key === "Escape") {
    const { head } = view.state.selection;
    view.dispatch(
      view.state.tr
        .setSelection(Selection.near(view.state.doc.resolve(head)))
        .setMeta(selectKey, null),
    );
    return true;
  }
  return false;
}

// Dims the dragged blocks. The range follows remote and local changes so the
// drop still moves the right blocks.
type DragRange = Range | null;
const dragKey = new PluginKey<DragRange>("document-block-drag");
export const blockDrag = $prose(
  () =>
    new Plugin<DragRange>({
      key: dragKey,
      state: {
        init: () => null,
        apply: (tr, range) => {
          const meta = tr.getMeta(dragKey);
          if (meta !== undefined) return meta;
          if (!range || !tr.docChanged) return range;
          const from = tr.mapping.mapResult(range.from, 1);
          const to = tr.mapping.mapResult(range.to, -1);
          return from.deleted || to.deleted || to.pos <= from.pos
            ? null
            : { from: from.pos, to: to.pos };
        },
      },
      props: {
        decorations: (state) => {
          const range = dragged(state);
          if (!range) return null;
          const decorations: Decoration[] = [];
          let pos = range.from;
          rangeContent(state.doc, range).forEach((node) => {
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: "document-block-dragging",
              }),
            );
            pos += node.nodeSize;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
);
function dragged(state: EditorState): Range | null {
  const range = dragKey.getState(state);
  return range ? blockRange(state.doc, range.from, range.to) : null;
}

// The block on the line at `y`. Hit testing in the middle of the text column
// finds the innermost block there, wherever the pointer is on that line.
function blockAtY(view: EditorView, y: number) {
  const box = view.dom.getBoundingClientRect();
  if (y < box.top || y > box.bottom) return null;
  const hit = view.posAtCoords({ left: box.left + box.width / 2, top: y });
  let block =
    hit && hit.inside >= 0 ? blockAt(view.state.doc, hit.inside) : null;
  // Beside the bullets of a list, take the item on that line.
  while (block && LISTS.has(block.node.type.name)) {
    const list: Block = block;
    block = null;
    for (
      let index = 0, pos = list.pos + 1;
      index < list.node.childCount && !block;
      pos += list.node.child(index++).nodeSize
    ) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement && dom.getBoundingClientRect().bottom >= y)
        block = { pos, node: list.node.child(index) };
    }
  }
  return block;
}

// Above, between or below the top-level blocks. Between two blocks, `below`
// takes the next one and otherwise the previous one.
function topLevelAtY(view: EditorView, y: number, below = true): Block | null {
  const { doc } = view.state;
  let last: Block | null = null;
  for (
    let index = 0, pos = 0;
    index < doc.childCount;
    pos += doc.child(index++).nodeSize
  ) {
    const block = { pos, node: doc.child(index) };
    const rect = rectOf(view, pos);
    if (rect && (below ? rect.bottom >= y : rect.top > y)) {
      if (below) return block;
      break;
    }
    last = block;
  }
  return last;
}

function rectOf(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

// The blocks a drag in the margin passes from `top` to `bottom`.
function rangeAcross(view: EditorView, top: number, bottom: number) {
  const box = view.dom.getBoundingClientRect();
  top = Math.max(top, box.top + 1);
  bottom = Math.min(bottom, box.bottom - 1);
  if (top > bottom) return null;
  const { doc } = view.state;
  const first = blockAtY(view, top) ?? topLevelAtY(view, top);
  const last = blockAtY(view, bottom) ?? topLevelAtY(view, bottom, false);
  if (!first || !last) return null;
  const range =
    first.pos === last.pos
      ? rangeOf(first)
      : rangeBetween(
          doc,
          first.pos <= last.pos ? first : last,
          first.pos <= last.pos ? last : first,
        );
  const only = range && blockFrom(doc, range.from);
  return !range ||
    (only &&
      only.pos + only.node.nodeSize === range.to &&
      isTypingArea(doc, only))
    ? null
    : range;
}

export type BlockHandleApi = {
  keydown: (event: KeyboardEvent) => boolean;
  update: (view: EditorView, previous: EditorState) => void;
};
type Props = {
  view: () => EditorView | null;
  shell: RefObject<HTMLDivElement | null>;
  formats: SlashItem[];
  canFormat: (id: string) => boolean;
  onOpen: () => void;
};
type Spot = { pos: number; left: number; top: number };
type Line = { left: number; top: number; width: number };
type Menu = Spot & { flip: boolean; items: SlashItem[] };
type Marquee = { left: number; top: number; width: number; height: number };
// A drag in the margin selects blocks; it never starts on controls, text or
// another dialog.
const MARQUEE_SKIP =
  "button, a, input, textarea, select, label, [contenteditable], [role='separator'], .document-rich-tools, .document-link-tip, .document-slash-menu";
const HANDLE_WIDTH = 18;
const HANDLE_HEIGHT = 24;
const HANDLE_GAP = 4;

export default forwardRef<BlockHandleApi, Props>(function DocumentBlockHandle(
  { view: getView, shell, formats, canFormat, onOpen },
  ref,
) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [active, setActive] = useState(0);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const spotRef = useRef(spot);
  spotRef.current = spot;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const activeRef = useRef(active);
  activeRef.current = active;
  const button = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);

  // Positions inside the shell. Grid zoom scales the client rectangles.
  function frame() {
    const box = shell.current;
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    return { rect, scale: rect.width / box.offsetWidth || 1 };
  }
  function place(view: EditorView, block: Block): Spot | null {
    const area = frame();
    const rect = rectOf(view, block.pos);
    if (!area || !rect) return null;
    const { scale } = area;
    // List items keep their bullet, number or checkbox right of the handle.
    const list =
      block.node.type.name === "list_item"
        ? rectOf(view, view.state.doc.resolve(block.pos).before())
        : null;
    let top = rect.top;
    let bottom = Math.min(rect.bottom, top + 28 * scale);
    let lineBottom = bottom;
    const text = firstText(block);
    if (text !== null)
      try {
        const caret = view.coordsAtPos(text);
        top = caret.top;
        lineBottom = caret.bottom;
        bottom = Math.min(caret.bottom, top + 40 * scale);
      } catch {
        // Keep the block's own top edge.
      }
    // A first line taller than the view, such as a large image, keeps the
    // handle beside its visible part when its top is scrolled under the
    // sticky toolbar or out of view.
    const visible = shell.current
      ?.querySelector(".document-rich-tools")
      ?.getBoundingClientRect().bottom;
    if (
      visible !== undefined &&
      top < visible &&
      lineBottom - HANDLE_HEIGHT * scale > visible
    ) {
      top = visible;
      bottom = Math.min(lineBottom, top + 40 * scale);
    }
    return {
      pos: block.pos,
      left:
        (Math.min(list?.left ?? rect.left, rect.left) - area.rect.left) /
          scale -
        HANDLE_GAP -
        HANDLE_WIDTH,
      top: ((top + bottom) / 2 - area.rect.top) / scale - HANDLE_HEIGHT / 2,
    };
  }
  function dropLine(view: EditorView, insert: number): Line | null {
    const area = frame();
    if (!area) return null;
    const $pos = view.state.doc.resolve(insert);
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    const below = after && rectOf(view, insert);
    const above = before && rectOf(view, insert - before.nodeSize);
    if (!below && !above) return null;
    const y =
      below && above
        ? (above.bottom + below.top) / 2
        : below
          ? below.top - 2
          : above!.bottom + 2;
    // Inside a list the line spans the markers too.
    const edge =
      (LISTS.has($pos.parent.type.name) && rectOf(view, $pos.before())) ||
      below ||
      above!;
    return {
      left: (edge.left - area.rect.left) / area.scale,
      width: edge.width / area.scale,
      top: (y - area.rect.top) / area.scale,
    };
  }
  function closeMenu() {
    if (!menuRef.current) return;
    menuRef.current = null;
    setMenu(null);
  }
  function choose(item: SlashItem) {
    if (item.disabled) return;
    closeMenu();
    setSpot(null);
    item.run();
  }
  function openMenu() {
    const view = getView();
    const current = spotRef.current;
    const block = view && current && blockFrom(view.state.doc, current.pos);
    if (!view || !current || !block) return;
    onOpen();
    const range = rangeFor(view.state, block);
    const single =
      range.from === block.pos && range.to === block.pos + block.node.nodeSize;
    const text = block.node.type.name === "table" ? null : firstText(block);
    // Conversions act on the caret, so it moves into the block first. The
    // start of the line never completes a "/" query. Selected blocks keep
    // their selection, and every item acts on all of them.
    const { selection } = view.state;
    if (
      single &&
      text !== null &&
      (selection.from < block.pos ||
        selection.to > block.pos + block.node.nodeSize)
    )
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, text)),
      );
    view.focus();
    const act =
      (make: (state: EditorState, range: Range) => Transaction | null) =>
      () => {
        const current = getView();
        const target =
          current && blockRange(current.state.doc, range.from, range.to);
        if (!current || !target) return;
        const tr = make(current.state, target);
        if (tr) current.dispatch(tr.scrollIntoView());
        current.focus();
      };
    const items: SlashItem[] = [
      {
        id: "duplicate",
        label: "복제",
        keywords: "",
        icon: <Copy size={16} />,
        run: act(duplicateRange),
      },
      {
        id: "up",
        label: "위로 이동",
        keywords: "",
        icon: <ArrowUp size={16} />,
        disabled: !stepMove(view.state, range, -1),
        run: act((state, target) => stepMove(state, target, -1)),
      },
      {
        id: "down",
        label: "아래로 이동",
        keywords: "",
        icon: <ArrowDown size={16} />,
        disabled: !stepMove(view.state, range, 1),
        run: act((state, target) => stepMove(state, target, 1)),
      },
      {
        id: "delete",
        label: "삭제",
        keywords: "",
        icon: <Trash2 size={16} />,
        run: act(deleteRange),
      },
      ...(text === null
        ? []
        : formats.map((item) => ({
            ...item,
            group: "전환",
            disabled: !canFormat(item.id),
          }))),
    ];
    const box = button.current?.getBoundingClientRect();
    const flip = !!box && box.bottom + 280 > window.innerHeight;
    setActive(0);
    setMenu({
      ...current,
      left: Math.max(0, current.left),
      top: flip ? current.top - 4 : current.top + HANDLE_HEIGHT + 4,
      flip,
      items,
    });
  }
  // Shift+click selects the blocks from the current selection to this one.
  function extendSelection() {
    const view = getView();
    const current = spotRef.current;
    const block = view && current && blockFrom(view.state.doc, current.pos);
    if (!view || !block) return;
    closeMenu();
    const { doc } = view.state;
    const selected = selectedRange(view.state);
    let range = rangeOf(block);
    if (selected) {
      // The far end of the current selection stays selected.
      const lastNode = doc.resolve(selected.to).nodeBefore;
      const end =
        block.pos >= selected.from
          ? blockFrom(doc, selected.from)
          : lastNode && {
              pos: selected.to - lastNode.nodeSize,
              node: lastNode,
            };
      range = (end && rangeBetween(doc, end, block)) || range;
    }
    selectRange(view, range);
    view.focus();
  }
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const view = getView();
    const current = spotRef.current;
    const block = view && current && blockFrom(view.state.doc, current.pos);
    if (
      event.button !== 0 ||
      event.shiftKey ||
      !view ||
      !block ||
      view.composing
    )
      return;
    const source = rangeFor(view.state, block);
    cancelDrag.current?.();
    const handle = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY };
    let y = origin.y;
    let target: number | null = null;
    let moved = false;
    let frameId = 0;
    // The nearest scrolling area: the task detail, a memo card or the sheet.
    let scroller = view.dom.parentElement;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    const locate = () => {
      const current = getView();
      const block = current && dragged(current.state);
      if (!current || !block) return;
      const over = blockAtY(current, y) ?? topLevelAtY(current, y);
      const rect = over && rectOf(current, over.pos);
      target =
        over && rect
          ? y < rect.top + rect.height / 2
            ? over.pos
            : over.pos + over.node.nodeSize
          : null;
      const insert =
        target === null ? null : dropPosition(current.state.doc, block, target);
      setLine(insert === null ? null : dropLine(current, insert));
    };
    const autoScroll = () => {
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const delta = y < box.top + 24 ? -8 : y > box.bottom - 24 ? 8 : 0;
        if (delta) {
          scroller.scrollTop += delta;
          locate();
        }
      }
      frameId = requestAnimationFrame(autoScroll);
    };
    cancelDrag.current = trackPointerDrag(event, {
      captureTarget: handle,
      onMove: (move) => {
        if (!moved) {
          if (Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < 4)
            return;
          moved = true;
          dragging.current = true;
          closeMenu();
          const current = getView();
          current?.dispatch(current.state.tr.setMeta(dragKey, source));
          document.body.classList.add("document-block-moving");
          frameId = requestAnimationFrame(autoScroll);
        }
        y = move.clientY;
        locate();
      },
      onEnd: (position, cancelled) => {
        cancelAnimationFrame(frameId);
        cancelDrag.current = null;
        if (!moved) return;
        if (!cancelled) {
          y = position.clientY;
          locate();
        }
        document.body.classList.remove("document-block-moving");
        dragging.current = false;
        suppressClickUntil.current = Date.now() + 250;
        setLine(null);
        setSpot(null);
        const current = getView();
        if (!current) return;
        const block = dragged(current.state);
        const tr =
          !cancelled && block && target !== null
            ? moveRange(current.state, block, target)
            : null;
        current.dispatch((tr ?? current.state.tr).setMeta(dragKey, null));
        if (tr) current.focus();
      },
    });
    handle.setPointerCapture(event.pointerId);
  }

  useImperativeHandle(ref, () => ({
    keydown: (event) => {
      const current = menuRef.current;
      if (!current) return false;
      const { items } = current;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : items.length - 1;
        let index = activeRef.current;
        do index = (index + step) % items.length;
        while (items[index].disabled && index !== activeRef.current);
        activeRef.current = index;
        setActive(index);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        choose(items[activeRef.current]);
        return true;
      }
      if (event.key === "Escape") {
        closeMenu();
        return true;
      }
      if (!["Shift", "Alt", "Control", "Meta"].includes(event.key)) closeMenu();
      return false;
    },
    update: (view, previous) => {
      if (view.state.doc === previous.doc) return;
      // Typing or a remote change moves the blocks under the handle.
      closeMenu();
      if (!dragging.current) setSpot(null);
    },
  }));

  useEffect(() => {
    const box = shell.current;
    if (!box) return;
    let frameId = 0;
    let pointer: { y: number; target: EventTarget | null } | null = null;
    const show = () => {
      frameId = 0;
      const view = getView();
      if (!pointer || !view || dragging.current || menuRef.current) return;
      const target = pointer.target instanceof Element ? pointer.target : null;
      if (target?.closest(".document-block-handle")) return;
      if (
        !view.editable ||
        view.composing ||
        target?.closest(".document-rich-tools, .document-slash-menu")
      ) {
        setSpot(null);
        return;
      }
      // Between top-level blocks, such as around a divider, the block below
      // takes the handle.
      const block = blockAtY(view, pointer.y) ?? topLevelAtY(view, pointer.y);
      if (!block) return;
      const next = isTypingArea(view.state.doc, block)
        ? null
        : place(view, block);
      setSpot((current) =>
        current &&
        next &&
        current.pos === next.pos &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5
          ? current
          : next,
      );
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer = { y: event.clientY, target: event.target };
      if (!frameId) frameId = requestAnimationFrame(show);
    };
    const leave = () => {
      pointer = null;
      if (!dragging.current && !menuRef.current) setSpot(null);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frameId);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerleave", leave);
      cancelDrag.current?.();
    };
  }, []);

  // Dragging in the margin beside or around the text selects the blocks the
  // drag passes, as a selection to move, copy or delete together. The margin
  // includes the blank page beside a full-page document.
  useEffect(() => {
    const box = shell.current;
    if (!box) return;
    let scroller = box.parentElement;
    while (
      scroller &&
      !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    const area = scroller ?? box;
    let cancel: (() => void) | null = null;
    const down = (event: PointerEvent) => {
      const view = getView();
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.button !== 0 ||
        event.pointerType === "touch" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !view?.editable ||
        view.composing ||
        !target ||
        dragging.current ||
        !box.getClientRects().length ||
        view.dom.contains(target) ||
        target.closest(MARQUEE_SKIP) ||
        target.closest("dialog") !== box.closest("dialog")
      )
        return;
      const rect = box.getBoundingClientRect();
      const bounds = area.getBoundingClientRect();
      const scale = bounds.width / area.offsetWidth || 1;
      if (
        event.clientY < rect.top ||
        event.clientY > rect.bottom ||
        // The scrollbar scrolls.
        event.clientX - bounds.left >
          (area.clientLeft + area.clientWidth) * scale
      )
        return;
      cancel?.();
      const origin = {
        x: event.clientX,
        y: event.clientY + area.scrollTop * scale,
      };
      let pointer = { x: event.clientX, y: event.clientY };
      let moved = false;
      let frameId = 0;
      // Keep the page's text from being selected by the same drag.
      const keepText = (selecting: Event) => selecting.preventDefault();
      document.addEventListener("selectstart", keepText, true);
      const clear = (view: EditorView) => {
        if (!selectKey.getState(view.state)) return;
        const { head } = view.state.selection;
        view.dispatch(
          view.state.tr
            .setSelection(Selection.near(view.state.doc.resolve(head)))
            .setMeta(selectKey, null),
        );
      };
      const select = () => {
        const view = getView();
        const shellArea = frame();
        if (!view || !shellArea) return;
        const startY = origin.y - area.scrollTop * scale;
        const top = Math.min(startY, pointer.y);
        const bottom = Math.max(startY, pointer.y);
        const left = Math.min(origin.x, pointer.x);
        setMarquee({
          left: (left - shellArea.rect.left) / shellArea.scale,
          top: (top - shellArea.rect.top) / shellArea.scale,
          width: Math.abs(pointer.x - origin.x) / shellArea.scale,
          height: (bottom - top) / shellArea.scale,
        });
        const range = rangeAcross(view, top, bottom);
        if (range) selectRange(view, range);
        else clear(view);
      };
      const autoScroll = () => {
        const box = area.getBoundingClientRect();
        const delta =
          pointer.y < box.top + 24 ? -8 : pointer.y > box.bottom - 24 ? 8 : 0;
        if (delta && scroller) {
          scroller.scrollTop += delta;
          select();
        }
        frameId = requestAnimationFrame(autoScroll);
      };
      cancel = trackPointerDrag(event, {
        onMove: (move) => {
          pointer = { x: move.clientX, y: move.clientY };
          if (!moved) {
            if (
              Math.hypot(
                move.clientX - event.clientX,
                move.clientY - event.clientY,
              ) < 4
            )
              return;
            moved = true;
            dragging.current = true;
            closeMenu();
            setSpot(null);
            document.body.classList.add("document-block-selecting");
            frameId = requestAnimationFrame(autoScroll);
          }
          select();
        },
        onEnd: (_position, cancelled) => {
          cancelAnimationFrame(frameId);
          document.removeEventListener("selectstart", keepText, true);
          cancel = null;
          const view = getView();
          // A click in the margin ends the block selection.
          if (!moved) {
            if (view && !cancelled) clear(view);
            return;
          }
          dragging.current = false;
          document.body.classList.remove("document-block-selecting");
          setMarquee(null);
          if (!view) return;
          if (cancelled) clear(view);
          // Keys act on the selected blocks next.
          else if (selectKey.getState(view.state)) view.focus();
        },
      });
    };
    area.addEventListener("pointerdown", down);
    return () => {
      area.removeEventListener("pointerdown", down);
      cancel?.();
    };
  }, []);

  useEffect(() => {
    const view = getView();
    if (!menu || !view) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (
        !menuBox.current?.contains(target) &&
        !button.current?.contains(target)
      )
        closeMenu();
    };
    const blur = (event: FocusEvent) => {
      if (!menuBox.current?.contains(event.relatedTarget as globalThis.Node))
        closeMenu();
    };
    document.addEventListener("pointerdown", outside, true);
    view.dom.addEventListener("focusout", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      view.dom.removeEventListener("focusout", blur);
    };
  }, [menu]);

  return (
    <>
      {spot && (
        <button
          ref={button}
          type="button"
          className="document-block-handle"
          aria-label="블록 메뉴"
          aria-haspopup="listbox"
          aria-expanded={!!menu}
          title="드래그하여 블록 이동 · 클릭하여 메뉴 열기 · Shift+클릭하여 여러 블록 선택 · Alt+Shift+위/아래 방향키"
          tabIndex={-1}
          style={{ left: spot.left, top: spot.top }}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={startDrag}
          onClick={(event) => {
            if (Date.now() < suppressClickUntil.current) return;
            if (event.shiftKey) extendSelection();
            else if (menuRef.current) closeMenu();
            else openMenu();
          }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
      )}
      {marquee && (
        <div
          className="document-block-marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
      {line && (
        <div
          className="document-block-drop"
          style={{ left: line.left, top: line.top, width: line.width }}
        />
      )}
      {menu && (
        <div ref={menuBox}>
          <DocumentSlashMenu
            label="블록 메뉴"
            items={menu.items}
            active={active}
            left={menu.left}
            top={menu.top}
            flip={menu.flip}
            onHover={(index) => {
              activeRef.current = index;
              setActive(index);
            }}
            onSelect={choose}
          />
        </div>
      )}
    </>
  );
});
