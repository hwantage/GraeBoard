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
// move as a whole. Moves are ordinary document changes, so the saved Markdown
// keeps its usual shape and one move is one undo step.

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

function selectedBlock(state: EditorState) {
  const { selection, doc } = state;
  const { $from } = selection;
  const block =
    selection instanceof NodeSelection
      ? blockAt(doc, selection.from)
      : $from.depth
        ? blockAt(doc, $from.before())
        : null;
  return block && selection.to <= block.pos + block.node.nodeSize
    ? block
    : null;
}

// The empty paragraph at the end is the typing area the trailing plugin keeps.
// It is never saved, so it neither moves nor takes blocks below it.
function isTypingArea(doc: Node, block: Block) {
  return (
    block.pos + block.node.nodeSize === doc.content.size &&
    block.node.type.name === "paragraph" &&
    !block.node.content.size
  );
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

// A list cannot be empty, so it goes with its last item.
function removalRange(doc: Node, block: Block) {
  let from = block.pos;
  let to = block.pos + block.node.nodeSize;
  for (
    let $from = doc.resolve(from);
    $from.depth &&
    LISTS.has($from.parent.type.name) &&
    $from.parent.childCount === 1;
    $from = doc.resolve(from)
  ) {
    from = $from.before();
    to = $from.after();
  }
  return { from, to };
}

// Where `source` lands when dropped at the block boundary `pos`: the nearest
// place its type fits, as ProseMirror's own drop does. null keeps it in place.
function dropPosition(doc: Node, source: Block, pos: number) {
  let insert = dropPoint(doc, pos, new Slice(Fragment.from(source.node), 0, 0));
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

// A toggle's content keeps an empty line when its only block leaves.
function removeBlock(tr: Transaction, block: Block) {
  const { from, to } = removalRange(tr.doc, block);
  const $from = tr.doc.resolve(from);
  if ($from.parent.canReplace($from.index(), $from.index() + 1)) {
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

function moveBlock(state: EditorState, source: Block, pos: number) {
  const insert = dropPosition(state.doc, source, pos);
  if (insert === null) return null;
  const end = source.pos + source.node.nodeSize;
  const tr = state.tr;
  removeBlock(tr, source);
  const at = tr.mapping.map(insert);
  const $at = tr.doc.resolve(at);
  let node = source.node;
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), node.type)) {
    // A list item placed outside a list keeps its own kind of list.
    const list = state.doc.resolve(source.pos).parent;
    if (
      !LISTS.has(list.type.name) ||
      !$at.parent.canReplaceWith($at.index(), $at.index(), list.type)
    )
      return null;
    node = list.type.create(list.attrs, node, list.marks);
  }
  tr.insert(at, node);
  const { selection } = state;
  if (selection.from >= source.pos && selection.to <= end) {
    const offset = at + (node === source.node ? 0 : 1) - source.pos;
    keepSelection(tr, selection, (position) => position + offset);
  }
  joinLists(tr, at + node.nodeSize);
  joinLists(tr, at);
  return closeHistory(tr);
}

function sibling(doc: Node, block: Block, step: -1 | 1) {
  const $pos = doc.resolve(block.pos);
  const index = $pos.index() + step;
  return index >= 0 && index < $pos.parent.childCount
    ? $pos.parent.child(index)
    : null;
}

// The nearest block around `block` that has its own handle, such as the
// toggle around its content or the item around a nested list.
function enclosingBlock(doc: Node, block: Block): Block | null {
  const $pos = doc.resolve(block.pos);
  for (let depth = $pos.depth; depth > 0; depth--)
    if (CONTAINERS.has($pos.node(depth - 1).type.name))
      return { pos: $pos.before(depth), node: $pos.node(depth) };
  return null;
}

// One step up or down passes the neighbouring block. At the edge of a list
// the item passes the block next to the list; at the edge of a toggle or a
// nested list it moves next to the block around it.
function stepMove(state: EditorState, block: Block, step: -1 | 1) {
  const { doc } = state;
  let unit = block;
  // A list holding only this item moves as a whole.
  for (
    let $pos = doc.resolve(unit.pos);
    $pos.depth &&
    LISTS.has($pos.parent.type.name) &&
    $pos.parent.childCount === 1;
    $pos = doc.resolve(unit.pos)
  )
    unit = { pos: $pos.before(), node: $pos.parent };
  let anchor = unit;
  const $unit = doc.resolve(unit.pos);
  if (!sibling(doc, unit, step) && LISTS.has($unit.parent.type.name))
    anchor = { pos: $unit.before(), node: $unit.parent };
  const next = sibling(doc, anchor, step);
  const end = anchor.pos + anchor.node.nodeSize;
  let pos: number;
  if (next) {
    if (step > 0 && isTypingArea(doc, { pos: end, node: next })) return null;
    pos = step < 0 ? anchor.pos - next.nodeSize : end + next.nodeSize;
  } else {
    const outer = enclosingBlock(doc, anchor);
    if (!outer) return null;
    pos = step < 0 ? outer.pos : outer.pos + outer.node.nodeSize;
  }
  return moveBlock(state, unit, pos);
}

function duplicateBlock(state: EditorState, block: Block) {
  const end = block.pos + block.node.nodeSize;
  const tr = state.tr.insert(end, block.node);
  const { selection } = state;
  if (selection.from >= block.pos && selection.to <= end)
    keepSelection(tr, selection, (pos) => pos + block.node.nodeSize);
  else tr.setSelection(Selection.near(tr.doc.resolve(end + 1)));
  return closeHistory(tr);
}

function deleteBlock(state: EditorState, block: Block) {
  const tr = state.tr;
  removeBlock(tr, block);
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(Math.min(tr.mapping.map(block.pos), tr.doc.content.size)),
    ),
  );
  return closeHistory(tr);
}

function moveCommand(step: -1 | 1): Command {
  return (state, dispatch) => {
    const block = selectedBlock(state);
    if (!block) return false;
    const tr = isTypingArea(state.doc, block)
      ? null
      : stepMove(state, block, step);
    if (tr) dispatch?.(tr.scrollIntoView());
    // Consume the key at the edges too instead of extending the selection.
    return true;
  };
}
export const blockMoveKeydown = keydownHandler({
  "Alt-Shift-ArrowUp": moveCommand(-1),
  "Alt-Shift-ArrowDown": moveCommand(1),
});

// Dims the dragged block. The range follows remote and local changes so the
// drop still moves the right block.
type DragRange = { from: number; to: number } | null;
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
          const range = dragKey.getState(state);
          return range
            ? DecorationSet.create(state.doc, [
                Decoration.node(range.from, range.to, {
                  class: "document-block-dragging",
                }),
              ])
            : null;
        },
      },
    }),
);
function dragged(state: EditorState): Block | null {
  const range = dragKey.getState(state);
  const block = range && blockFrom(state.doc, range.from);
  return block && block.pos + block.node.nodeSize === range.to ? block : null;
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

// Above, between or below the top-level blocks.
function topLevelAtY(view: EditorView, y: number): Block | null {
  const { doc } = view.state;
  let last: Block | null = null;
  for (
    let index = 0, pos = 0;
    index < doc.childCount;
    pos += doc.child(index++).nodeSize
  ) {
    last = { pos, node: doc.child(index) };
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement && dom.getBoundingClientRect().bottom >= y)
      return last;
  }
  return last;
}

function rectOf(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
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
    const text = firstText(block);
    if (text !== null)
      try {
        const caret = view.coordsAtPos(text);
        top = caret.top;
        bottom = Math.min(caret.bottom, top + 40 * scale);
      } catch {
        // Keep the block's own top edge.
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
    const text = block.node.type.name === "table" ? null : firstText(block);
    // Conversions act on the caret, so it moves into the block first. The
    // start of the line never completes a "/" query.
    const { selection } = view.state;
    if (
      text !== null &&
      (selection.from < block.pos ||
        selection.to > block.pos + block.node.nodeSize)
    )
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, text)),
      );
    view.focus();
    const act =
      (make: (state: EditorState, block: Block) => Transaction | null) =>
      () => {
        const current = getView();
        const target = current && blockFrom(current.state.doc, block.pos);
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
        run: act(duplicateBlock),
      },
      {
        id: "up",
        label: "위로 이동",
        keywords: "",
        icon: <ArrowUp size={16} />,
        disabled: !stepMove(view.state, block, -1),
        run: act((state, target) => stepMove(state, target, -1)),
      },
      {
        id: "down",
        label: "아래로 이동",
        keywords: "",
        icon: <ArrowDown size={16} />,
        disabled: !stepMove(view.state, block, 1),
        run: act((state, target) => stepMove(state, target, 1)),
      },
      {
        id: "delete",
        label: "삭제",
        keywords: "",
        icon: <Trash2 size={16} />,
        run: act(deleteBlock),
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
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const view = getView();
    const current = spotRef.current;
    const source = view && current && blockFrom(view.state.doc, current.pos);
    if (event.button !== 0 || !view || !source || view.composing) return;
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
          current?.dispatch(
            current.state.tr.setMeta(dragKey, {
              from: source.pos,
              to: source.pos + source.node.nodeSize,
            }),
          );
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
            ? moveBlock(current.state, block, target)
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
          title="드래그하여 블록 이동 · 클릭하여 메뉴 열기 · Alt+Shift+위/아래 방향키"
          tabIndex={-1}
          style={{ left: spot.left, top: spot.top }}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={startDrag}
          onClick={() => {
            if (Date.now() < suppressClickUntil.current) return;
            if (menuRef.current) closeMenu();
            else openMenu();
          }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
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
