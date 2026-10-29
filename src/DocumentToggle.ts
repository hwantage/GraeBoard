import { $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";
import type { MarkdownNode, Root } from "@milkdown/kit/transformer";
import type { Node, NodeType, ResolvedPos } from "@milkdown/kit/prose/model";
import {
  Plugin,
  TextSelection,
  type Command,
  type EditorState,
} from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { closeHistory } from "@milkdown/kit/prose/history";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import { iconButton } from "./DocumentImageView";

// Toggle blocks are stored as portable HTML inside the Markdown body:
//
//   <details open>
//   <summary><h2>제목</h2></summary>
//
//   내용
//
//   </details>
//
// remark keeps `<details>` and `</details>` as raw html blocks and parses the
// blank-line separated body as ordinary Markdown. The remark transform below
// groups those siblings into one `details` node so the rich editor can show
// them, and the to-markdown handler writes the same shape back. Only the
// `open` attribute and `<h1>`~`<h6>` summaries are supported; any other
// attribute or tag keeps the original html, so `checkMarkdown` leaves such
// documents in the Markdown source editor.

export const TOGGLE_LEVELS = [1, 2, 3] as const;

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  [key: string]: unknown;
};
type Summary = { type: "summary"; level: number; children: MdNode[] };
type Details = { type: "details"; open: boolean; children: MdNode[] };
type ParseFragment = (markdown: string) => MdNode;

const PHRASING_PARENTS = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "link",
  "linkReference",
  "emphasis",
  "strong",
  "delete",
  "summary",
]);
const SUMMARY_INLINE = new Set([
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
]);
const DETAILS_OPEN =
  /^<details((?:\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?)\s*>[ \t]*\r?\n?/i;
const SUMMARY = /^[ \t]*<summary>([^\n]*?)<\/summary>[ \t]*(?:\r?\n|$)/i;
const SUMMARY_HEADING = /^\s*<h([1-6])>([^\n]*?)<\/h\1>\s*$/i;
const DETAILS_CLOSE = /^<\/details\s*>[ \t]*(?:\r?\n|$)/i;
const DETAILS_END = /\r?\n?<\/details\s*>\s*$/i;

// Milkdown's html transformer wraps block html into a paragraph before this
// transform runs. Accept both shapes.
function blockHtml(node: MdNode): string | null {
  if (node.type === "html") return node.value || "";
  if (
    node.type === "paragraph" &&
    node.children?.length === 1 &&
    node.children[0].type === "html"
  )
    return node.children[0].value || "";
  return null;
}

function supportedInline(nodes: MdNode[]): boolean {
  return nodes.every(
    (node) =>
      SUMMARY_INLINE.has(node.type) &&
      (!node.children || supportedInline(node.children)),
  );
}

function parseSummary(
  html: string,
  parse: ParseFragment,
): { summary: Summary; rest: string } | null {
  const match = SUMMARY.exec(html);
  if (!match) return null;
  let level = 0;
  let text = match[1];
  const heading = SUMMARY_HEADING.exec(text);
  if (heading) {
    level = Number(heading[1]);
    text = heading[2];
  }
  let children: MdNode[] = [];
  if (text.trim()) {
    const root = parse(text);
    const [block, ...more] = root.children || [];
    if (!block || more.length || block.type !== "paragraph") return null;
    children = block.children || [];
    if (!supportedInline(children)) return null;
  }
  return {
    summary: { type: "summary", level, children },
    rest: html.slice(match[0].length),
  };
}

type Open = {
  node: Details;
  body: MdNode[];
  siblings: MdNode[];
  origin: MdNode;
  closed: boolean;
};

function parseOpen(
  html: string,
  origin: MdNode,
  parse: ParseFragment,
): Open | null {
  const match = DETAILS_OPEN.exec(html);
  if (!match) return null;
  const summary = parseSummary(html.slice(match[0].length), parse);
  if (!summary) return null;
  let rest = summary.rest;
  const closed = DETAILS_END.test(rest);
  if (closed) rest = rest.replace(DETAILS_END, "");
  return {
    node: {
      type: "details",
      open: /open/i.test(match[1]),
      children: [summary.summary],
    },
    body: rest.trim() ? (parse(rest).children ?? []) : [],
    siblings: [],
    origin,
    closed,
  };
}

function groupDetails(children: MdNode[], parse: ParseFragment): MdNode[] {
  const out: MdNode[] = [];
  const stack: Open[] = [];
  const push = (node: MdNode) =>
    (stack.length ? stack[stack.length - 1].siblings : out).push(node);
  const finish = (entry: Open) => {
    entry.node.children.push(...entry.body, ...entry.siblings);
    push(entry.node);
  };
  for (const child of children) {
    const html = blockHtml(child);
    if (html !== null) {
      const open = parseOpen(html, child, parse);
      if (open) {
        if (open.closed) finish(open);
        else stack.push(open);
        continue;
      }
      const close = DETAILS_CLOSE.exec(html);
      if (close && stack.length) {
        finish(stack.pop()!);
        const rest = html.slice(close[0].length);
        if (rest.trim()) (parse(rest).children ?? []).forEach(push);
        continue;
      }
    }
    if (child.children && !PHRASING_PARENTS.has(child.type))
      child.children = groupDetails(child.children, parse);
    push(child);
  }
  // Unclosed blocks keep their original html so the source stays untouched.
  let rest: MdNode[] = [];
  while (stack.length) {
    const entry = stack.pop()!;
    rest = [entry.origin, ...entry.siblings, ...rest];
  }
  return out.concat(rest);
}

type ToMarkdownState = {
  containerPhrasing: (parent: MdNode, info: object) => string;
  containerFlow: (parent: MdNode, info: object) => string;
  createTracker: (info: object) => {
    move: (value: string) => string;
    current: () => object;
  };
};

function detailsToMarkdown(
  node: Details,
  _parent: unknown,
  state: ToMarkdownState,
  info: object,
) {
  const [summary, ...blocks] = node.children as [Summary, ...MdNode[]];
  const title = state.containerPhrasing(summary, {
    ...info,
    before: ">",
    after: "<",
  });
  const tracker = state.createTracker(info);
  const level = summary.level;
  let value = `<details${node.open ? " open" : ""}>\n<summary>${
    level ? `<h${level}>${title}</h${level}>` : title
  }</summary>`;
  tracker.move(value);
  const body = state.containerFlow(
    { type: "details", children: blocks },
    tracker.current(),
  );
  if (body) {
    tracker.move("\n\n");
    value += `\n\n${body}`;
  }
  return `${value}\n\n</details>`;
}

type Processor = {
  data: (key: string, value?: unknown) => unknown;
  parse: (value: string) => MdNode;
  runSync: (tree: MdNode, file: string) => MdNode;
};

export const remarkToggle = $remark(
  "remarkDocumentToggle",
  () =>
    function (this: unknown) {
      const processor = this as Processor;
      const extensions =
        (processor.data("toMarkdownExtensions") as object[] | undefined) ?? [];
      processor.data("toMarkdownExtensions", [
        ...extensions,
        { handlers: { details: detailsToMarkdown } },
      ]);
      const parse: ParseFragment = (markdown) =>
        processor.runSync(processor.parse(markdown), markdown);
      return (tree: Root) => {
        const root = tree as unknown as MdNode;
        root.children = groupDetails(root.children ?? [], parse);
      };
    },
);

export const toggleSchema = $nodeSchema("toggle", (ctx) => ({
  content: "toggle_summary toggle_content",
  group: "block",
  defining: true,
  attrs: { open: { default: true, validate: "boolean" } },
  parseDOM: [
    {
      tag: "details",
      getAttrs: (dom) => ({ open: (dom as HTMLElement).hasAttribute("open") }),
    },
    {
      tag: "div.document-toggle",
      getAttrs: (dom) => ({
        open: (dom as HTMLElement).dataset.open !== "false",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    { class: "document-toggle", "data-open": String(node.attrs.open) },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === "details",
    runner: (state, node, type) => {
      const details = node as unknown as Details;
      const [summary, ...blocks] = details.children;
      state.openNode(type, { open: !!details.open });
      state.next(summary as MarkdownNode);
      state.openNode(toggleContentSchema.type(ctx));
      state.next(blocks as MarkdownNode[]);
      state.closeNode();
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "toggle",
    runner: (state, node) => {
      state.openNode("details", undefined, { open: node.attrs.open });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

export const toggleSummarySchema = $nodeSchema("toggle_summary", () => ({
  content: "text*",
  defining: true,
  attrs: { level: { default: 0, validate: "number" } },
  parseDOM: [
    {
      tag: "summary",
      getAttrs: (dom) => ({
        level: Number(
          /^H([1-6])$/.exec(
            (dom as HTMLElement).firstElementChild?.tagName || "",
          )?.[1] || 0,
        ),
      }),
    },
    {
      tag: ".document-toggle-summary",
      getAttrs: (dom) => ({
        level: Number(
          /^H([1-6])$/.exec((dom as HTMLElement).tagName)?.[1] || 0,
        ),
      }),
    },
  ],
  toDOM: (node) => [
    node.attrs.level ? `h${node.attrs.level}` : "div",
    { class: "document-toggle-summary" },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === "summary",
    runner: (state, node, type) => {
      const summary = node as unknown as Summary;
      state.openNode(type, { level: summary.level || 0 });
      state.next((summary.children ?? []) as MarkdownNode[]);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "toggle_summary",
    runner: (state, node) => {
      state.openNode("summary", undefined, { level: node.attrs.level });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

export const toggleContentSchema = $nodeSchema("toggle_content", () => ({
  content: "block+",
  defining: true,
  parseDOM: [{ tag: ".document-toggle-content" }],
  toDOM: () => ["div", { class: "document-toggle-content" }, 0],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === "toggle_content",
    runner: (state, node) => {
      state.next(node.content);
    },
  },
}));

function syncToggleButton(button: HTMLElement, open: boolean) {
  const label = open ? "토글 접기" : "토글 펼치기";
  if (button.getAttribute("aria-expanded") === String(open)) return;
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

// Changing `open` re-creates the toggle wrapper but ProseMirror keeps the
// unchanged summary view, so the button reads the current state after every
// DOM update instead of only when it is built.
export const toggleButtonSync = $prose(
  () =>
    new Plugin({
      view: (view) => ({
        update: () => {
          for (const button of view.dom.querySelectorAll<HTMLElement>(
            ".document-toggle > .document-toggle-summary > .document-toggle-button",
          ))
            syncToggleButton(
              button,
              button.closest<HTMLElement>(".document-toggle")?.dataset.open !==
                "false",
            );
        },
      }),
    }),
);

export const toggle = [
  toggleSchema,
  toggleSummarySchema,
  toggleContentSchema,
  toggleButtonSync,
].flat();

function findToggle($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "toggle")
      return {
        depth,
        node,
        start: $pos.before(depth),
        end: $pos.after(depth),
      };
  }
  return null;
}

function isEmptyParagraph(node: Node | null | undefined) {
  return !!node && node.type.name === "paragraph" && node.content.size === 0;
}

export function inToggleSummary(state: EditorState) {
  const { $from, $to } = state.selection;
  return $from.sameParent($to) && $from.parent.type.name === "toggle_summary";
}

// Turn the current paragraph or heading into a toggle, or change the summary
// heading level of the toggle the cursor is in. 0 is a plain toggle.
export function setToggleCommand(level: number): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
    const block = $from.parent;
    const depth = $from.depth;
    const { nodes } = state.schema;
    if (block.type === nodes.toggle_summary) {
      if (block.attrs.level !== level && dispatch)
        dispatch(
          closeHistory(
            state.tr.setNodeMarkup($from.before(depth), undefined, { level }),
          ),
        );
      return true;
    }
    if (block.type !== nodes.paragraph && block.type !== nodes.heading)
      return false;
    const index = $from.index(depth - 1);
    if (
      !$from.node(depth - 1).canReplaceWith(index, index + 1, nodes.toggle) ||
      !nodes.toggle_summary.validContent(block.content)
    )
      return false;
    const content = nodes.toggle_content.createAndFill();
    if (!content) return false;
    const start = $from.before(depth);
    const tr = state.tr.replaceWith(
      start,
      $from.after(depth),
      nodes.toggle.create({ open: true }, [
        nodes.toggle_summary.create({ level }, block.content),
        content,
      ]),
    );
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        start + 2 + $from.parentOffset,
        start + 2 + $to.parentOffset,
      ),
    );
    dispatch?.(closeHistory(tr).scrollIntoView());
    return true;
  };
}

// Replace the toggle around the summary cursor with a plain block holding the
// summary text, followed by the toggle's content blocks.
export function unwrapToggleCommand(
  type: NodeType,
  attrs?: Record<string, unknown>,
): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if (!$from.sameParent($to) || $from.parent.type.name !== "toggle_summary")
      return false;
    const found = findToggle($from);
    if (!found) return false;
    const content = found.node.child(1);
    const blocks = [type.create(attrs, $from.parent.content)];
    if (!(content.childCount === 1 && isEmptyParagraph(content.firstChild)))
      content.forEach((block) => blocks.push(block));
    const tr = state.tr.replaceWith(found.start, found.end, blocks);
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        found.start + 1 + $from.parentOffset,
        found.start + 1 + $to.parentOffset,
      ),
    );
    dispatch?.(closeHistory(tr).scrollIntoView());
    return true;
  };
}

// Enter in the summary opens the toggle and moves into its first content
// block. Enter in a trailing empty paragraph of the content leaves the toggle.
const enterInToggle: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return false;
  const found = findToggle($from);
  if (!found) return false;
  const { nodes } = state.schema;
  if ($from.parent.type === nodes.toggle_summary) {
    const tr = state.tr;
    if (!found.node.attrs.open)
      tr.setNodeMarkup(found.start, undefined, { open: true });
    const contentStart = $from.after($from.depth) + 1;
    const first = found.node.child(1).firstChild;
    if (!first?.isTextblock) tr.insert(contentStart, nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, contentStart + 1));
    dispatch?.(closeHistory(tr).scrollIntoView());
    return true;
  }
  const content = $from.node($from.depth - 1);
  if (
    !state.selection.empty ||
    content.type !== nodes.toggle_content ||
    $from.depth !== found.depth + 2 ||
    !isEmptyParagraph($from.parent) ||
    $from.index($from.depth - 1) !== content.childCount - 1
  )
    return false;
  const tr = state.tr;
  if (content.childCount > 1)
    tr.delete($from.before($from.depth), $from.after($from.depth));
  const after = tr.mapping.map(found.end);
  tr.insert(after, nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  dispatch?.(closeHistory(tr).scrollIntoView());
  return true;
};

// Backspace at the start of the summary unwraps the toggle. At the start of
// the first content block it steps back into the summary instead of joining.
const backspaceInToggle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset > 0 || !$from.parent.isTextblock)
    return false;
  const found = findToggle($from);
  if (!found) return false;
  const { nodes } = state.schema;
  if ($from.parent.type === nodes.toggle_summary)
    return unwrapToggleCommand(nodes.paragraph)(state, dispatch);
  const content = $from.node($from.depth - 1);
  if (
    content.type !== nodes.toggle_content ||
    $from.depth !== found.depth + 2 ||
    $from.index($from.depth - 1) !== 0
  )
    return false;
  const summaryEnd = found.start + found.node.child(0).nodeSize;
  dispatch?.(
    state.tr
      .setSelection(TextSelection.create(state.doc, summaryEnd))
      .scrollIntoView(),
  );
  return true;
};

export const toggleKeydown = keydownHandler({
  Enter: enterInToggle,
  Backspace: backspaceInToggle,
});

// The summary owns the disclosure button so it stays on the title line.
// Changing `open` re-renders the toggle and rebuilds this view.
export function toggleSummaryView(
  initial: Node,
  view: EditorView,
  getPos: () => number | undefined,
  readOnly: () => boolean,
): NodeView {
  let node = initial;
  const dom = document.createElement(
    node.attrs.level ? `h${node.attrs.level}` : "div",
  );
  dom.className = "document-toggle-summary";
  const button = iconButton("토글 접기", ["m9 18 6-6-6-6"]);
  button.className = "document-toggle-button";
  button.contentEditable = "false";
  const contentDOM = document.createElement("div");
  contentDOM.className = "document-toggle-title";
  const parent = () => {
    const pos = getPos();
    if (pos === undefined) return null;
    const $pos = view.state.doc.resolve(pos);
    return {
      node: $pos.parent,
      pos: $pos.before(),
      summaryEnd: pos + node.nodeSize - 1,
    };
  };
  syncToggleButton(button, parent()?.node.attrs.open !== false);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    const target = parent();
    if (!target) return;
    const open = !target.node.attrs.open;
    if (readOnly()) {
      // Readers fold locally; the document itself stays unchanged.
      const toggle = dom.parentElement;
      if (toggle) toggle.dataset.open = String(open);
      syncToggleButton(button, open);
      return;
    }
    let tr = view.state.tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      open,
    });
    const { from, to } = view.state.selection;
    if (
      !open &&
      from > target.summaryEnd &&
      to <= target.pos + target.node.nodeSize
    )
      tr = tr.setSelection(TextSelection.create(tr.doc, target.summaryEnd));
    view.dispatch(closeHistory(tr));
    view.focus();
  });
  dom.append(button, contentDOM);
  return {
    dom,
    contentDOM,
    update: (next) => {
      if (next.type !== node.type || next.attrs.level !== node.attrs.level)
        return false;
      node = next;
      return true;
    },
    stopEvent: (event) => button.contains(event.target as globalThis.Node),
    ignoreMutation: (mutation) =>
      mutation.type !== "selection" &&
      (mutation.target === button || button.contains(mutation.target)),
  };
}
