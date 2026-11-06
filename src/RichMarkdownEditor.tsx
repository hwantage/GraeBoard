import type { DocumentImages } from "./document-storage";
import {
  configureDocumentInputRules,
  documentInputKeydown,
} from "./DocumentInputRules";
import { documentLinkTitle, pasteExternalLink } from "./DocumentLinkTitle";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isDocumentImage } from "../shared/document-images.js";
import { parseDocumentLinkPath } from "../shared/document-links.js";
import {
  DocumentLinkTitles,
  documentLinkTarget,
  copyToClipboard,
  useDocumentLinkOpener,
} from "./document-links";
import {
  documentLinkSchema,
  documentLinkView,
  openDocumentLink,
  pasteDocumentLink,
} from "./DocumentLinkNode";
import { documentImageView, type ImagePreview } from "./DocumentImageView";
import {
  documentCodeBlockSelection,
  documentCodeBlockView,
} from "./DocumentCodeBlockView";
import { Button, Modal } from "./components";
import Toast, { useToast } from "./Toast";
import Select from "./Select";
import DocumentLoading from "./DocumentLoading";
import DocumentToolMenu from "./DocumentToolMenu";
import DocumentBlockHandle, {
  BLOCK_FORMATS,
  blockDrag,
  blockMoveKeydown,
  blockSelect,
  blockSelectKeydown,
  type BlockHandleApi,
} from "./DocumentBlockHandle";
import DocumentSlashMenu, {
  filterSlashItems,
  slashMatch,
  type SlashItem,
  type SlashMatch,
} from "./DocumentSlashMenu";
import {
  TOGGLE_LEVELS,
  inToggleSummary,
  remarkToggle,
  setToggleCommand,
  toggle,
  toggleKeydown,
  toggleSummaryView,
  unwrapToggleCommand,
} from "./DocumentToggle";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { trailing, trailingConfig } from "@milkdown/kit/plugin/trailing";
import { Decoration, type EditorView } from "@milkdown/kit/prose/view";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  commandsCtx,
  parserCtx,
  serializerCtx,
  remarkCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  insertHrCommand,
  codeBlockSchema,
  headingSchema,
  linkSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  insertTableCommand,
  addRowAfterCommand,
  addColAfterCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import {
  history,
  undoCommand,
  redoCommand,
} from "@milkdown/kit/plugin/history";
import {
  Plugin,
  TextSelection,
  type Command,
  type EditorState,
} from "@milkdown/kit/prose/state";
import {
  Fragment,
  NodeRange,
  Slice,
  type Mark,
  type Node,
} from "@milkdown/kit/prose/model";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import {
  closeHistory,
  undoDepth,
  redoDepth,
} from "@milkdown/kit/prose/history";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
} from "@milkdown/kit/prose/tables";
import { $prose, $remark, callCommand } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkdownNode, Root } from "@milkdown/kit/transformer";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Copy,
  ExternalLink,
  Link,
  Pencil,
  Unlink,
  Undo2,
  Redo2,
  List,
  ListOrdered,
  ListChecks,
  ListCollapse,
  Table2,
  Maximize2,
  ZoomIn,
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  SquareCode,
  Workflow,
  Minus,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  TableRowsSplit,
  TableColumnsSplit,
  Trash2,
} from "lucide-react";
import "@milkdown/kit/prose/view/style/prosemirror.css";

const deleteTableColumn: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { left, right, map } = selectedRect(state);
  return (right - left === map.width ? deleteTable : deleteColumn)(
    state,
    dispatch,
  );
};

const deleteTableRow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { top, bottom, map } = selectedRect(state);
  // Milkdown's Markdown table requires a header and at least one body row.
  if (top === 0 || bottom - top === map.height - 1) return false;
  return deleteRow(state, dispatch);
};

type ListFormat = "bullet" | "ordered" | "task";
function listFormatCommand(format: ListFormat): Command {
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
const listFormatKeydown = keydownHandler({
  "Mod-Alt-7": listFormatCommand("ordered"),
  "Mod-Alt-8": listFormatCommand("bullet"),
});

// Keep an empty paragraph after blocks that offer no caret position below
// them, including a paragraph that ends with an image. The doc serializer
// already drops a final empty paragraph, so saved Markdown is unchanged.
function needsTrailingParagraph(last: Node | null) {
  if (!last || last.type.name === "heading") return false;
  if (last.type.name === "paragraph")
    return last.lastChild?.type.name === "image";
  return true;
}

// Uploaded images land at the end of their paragraph without a visible caret.
// Continue typing in the paragraph below, creating it when needed.
function selectAfterImage(state: EditorState, pos: number) {
  const $after = state.doc.resolve(pos + 1);
  const tr = state.tr;
  if ($after.parentOffset < $after.parent.content.size)
    return tr.setSelection(TextSelection.create(tr.doc, $after.pos));
  const end = $after.after();
  const $end = state.doc.resolve(end);
  const next = $end.nodeAfter;
  const { paragraph } = state.schema.nodes;
  if (next?.type === paragraph && next.content.size === 0)
    return tr.setSelection(TextSelection.create(tr.doc, end + 1));
  if (!$end.parent.canReplaceWith($end.index(), $end.index(), paragraph))
    return tr.setSelection(TextSelection.create(tr.doc, $after.pos));
  tr.insert(end, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, end + 1));
}

// Milkdown keeps only a fence's language. Keep the rest of the info string
// (```plain text, ```js filename="a.js", future mermaid options) so rich
// editing round-trips it instead of rewriting the fence.
const codeBlockMetaSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  const parseRule = base.parseDOM![0];
  return {
    ...base,
    attrs: { ...base.attrs, meta: { default: "", validate: "string" } },
    parseDOM: [
      {
        ...parseRule,
        getAttrs: (dom) => ({
          ...(parseRule.getAttrs?.(dom) || {}),
          meta: (dom as HTMLElement).dataset.meta ?? "",
        }),
      },
    ],
    toDOM: (node) => {
      const [tag, attrs, ...rest] = base.toDOM!(node) as [string, object];
      return [
        tag,
        node.attrs.meta ? { ...attrs, "data-meta": node.attrs.meta } : attrs,
        ...rest,
      ];
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.openNode(type, {
          language: node.lang ?? "",
          meta: node.meta ?? "",
        });
        if (node.value) state.addText(node.value as string);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.addNode("code", undefined, node.content.firstChild?.text || "", {
          lang: node.attrs.language,
          meta: node.attrs.meta || undefined,
        });
      },
    },
  };
});

export function safeDocumentLink(url: string) {
  return (
    (/^(https?:|mailto:)/i.test(url) || !!parseDocumentLinkPath(url)) &&
    !/[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/u.test(url)
  );
}

function isPlainLineBreak(value: unknown): value is string {
  return typeof value === "string" && /^<br\s*\/?\s*>$/i.test(value.trim());
}

// GFM can parse rows wider or narrower than the header. Pad missing cells
// before both the loss check and ProseMirror parsing so all existing cells
// survive, and the table editor starts with a rectangular table. This does
// not write back to the source until the user actually edits the document.
const remarkTableShape = $remark("remarkDocumentTableShape", () => () => {
  function visit(node: MarkdownNode) {
    if (node.type === "table" && node.children?.length) {
      const width = node.children.reduce(
        (max, row) => Math.max(max, row.children?.length ?? 0),
        0,
      );
      const align = (node.align as (string | null)[] | undefined) ?? [];
      while (align.length < width) align.push(null);
      node.align = align;
      for (const row of node.children) {
        row.children ??= [];
        while (row.children.length < width)
          row.children.push({ type: "tableCell", children: [] });
      }
    }
    node.children?.forEach(visit);
  }
  return (tree: Root) => visit(tree as MarkdownNode);
});

// Compare meaning, not choices of delimiters, indentation or table spacing.
// Unrepresented AST nodes must never be silently discarded by rich editing.
function semanticTree(node: any): any {
  if (Array.isArray(node)) return node.map(semanticTree);
  if (!node || typeof node !== "object") return node;
  // Milkdown omits the final empty paragraph (its typing area) when saving.
  // Ignore only trailing empty root paragraphs in this comparison, including
  // <br /> placeholders restored by its remark plugin. Keep interior blanks,
  // nested blocks, table cells and all nonempty content in the loss check.
  if (node.type === "root" && Array.isArray(node.children)) {
    let end = node.children.length;
    while (
      end > 0 &&
      node.children[end - 1].type === "paragraph" &&
      node.children[end - 1].children?.length === 0
    )
      end--;
    node = { ...node, children: node.children.slice(0, end) };
  }
  if (node.type === "html" && isPlainLineBreak(node.value))
    return { type: "html", value: "<br />" };
  return Object.fromEntries(
    Object.keys(node)
      .sort()
      .filter((k) => !["position", "spread", "data"].includes(k))
      .map((k) => [k, semanticTree(node[k])]),
  );
}
function checkMarkdown(
  ctx: Ctx,
  markdown: string,
  options?: Pick<Props, "images" | "documentLinks">,
) {
  const remark = ctx.get(remarkCtx);
  // Validate after Milkdown's remark transforms: they keep unsupported HTML
  // as html nodes, restore serializer-generated <br /> placeholders to empty
  // paragraphs/table cells and group toggle blocks into details nodes.
  const tree = remark.runSync(remark.parse(markdown), markdown);
  const supported = new Set([
    "root",
    "paragraph",
    "text",
    "heading",
    "strong",
    "emphasis",
    "delete",
    "inlineCode",
    "code",
    "break",
    "thematicBreak",
    "blockquote",
    "list",
    "listItem",
    "link",
    "image",
    "table",
    "tableRow",
    "tableCell",
    "details",
    "summary",
  ]);
  function visit(node: any) {
    if (
      !supported.has(node.type) &&
      !(node.type === "html" && isPlainLineBreak(node.value))
    )
      throw new Error(
        "HTML·각주·참조 링크 등은 Markdown 원문에서 편집하세요. 원문은 그대로 보존됩니다.",
      );
    if (
      node.type === "link" &&
      (!safeDocumentLink(node.url) ||
        (options?.documentLinks === false && !!documentLinkTarget(node.url)))
    )
      throw new Error(
        "HTTP(S)·메일·문서 링크만 리치 편집에서 지원합니다. 원문은 그대로 보존됩니다.",
      );
    if (
      node.type === "image" &&
      !(options?.images?.accepts || isDocumentImage)(node.url)
    )
      throw new Error(
        "외부 이미지는 Markdown 원문에 보존됩니다. 리치 문서에는 이미지를 직접 붙여넣어 주세요.",
      );
    node.children?.forEach(visit);
  }
  visit(tree);
  const doc = ctx.get(parserCtx)(markdown);
  const roundtrip = ctx.get(serializerCtx)(doc);
  if (
    JSON.stringify(semanticTree(tree)) !==
    JSON.stringify(
      semanticTree(remark.runSync(remark.parse(roundtrip), roundtrip)),
    )
  )
    throw new Error(
      "이 구문은 리치 편집으로 변환하면 달라질 수 있어 원문을 유지했습니다. Markdown 원문에서 계속 편집하세요.",
    );
  return doc;
}

function safeClipboardSlice(
  slice: Slice,
  options?: Pick<Props, "images" | "documentLinks">,
) {
  let safe = true;
  slice.content.descendants((node) => {
    if (
      (node.type.name === "html" && !isPlainLineBreak(node.attrs.value)) ||
      (node.type.name === "image" &&
        !(options?.images?.accepts || isDocumentImage)(node.attrs.src)) ||
      (options?.documentLinks === false &&
        node.type.name === "document_link") ||
      node.type.name === "footnote_definition" ||
      node.type.name === "footnote_reference" ||
      node.marks.some(
        (mark) =>
          mark.type.name === "link" &&
          (!safeDocumentLink(mark.attrs.href) ||
            (options?.documentLinks === false &&
              !!documentLinkTarget(mark.attrs.href))),
      )
    )
      safe = false;
    return safe;
  });
  return safe;
}

// The clipboard's plain text is the selection's Markdown, as Notion copies,
// so chat apps and the Markdown source keep headings, lists and links. Part
// of one line keeps only its inline formatting, and code inside a code block
// stays plain code.
function clipboardMarkdown(ctx: Ctx, slice: Slice) {
  let { content, openStart, openEnd } = slice;
  let line: Node | null = null;
  while (content.childCount === 1 && openStart > 0 && openEnd > 0) {
    const only = content.firstChild!;
    if (only.isTextblock) {
      line = only;
      break;
    }
    content = only.content;
    openStart--;
    openEnd--;
  }
  // Plain words stay as written, without Markdown escapes such as "\[".
  let plain = !!line;
  line?.forEach((node) => {
    if (!node.isText || node.marks.length) plain = false;
  });
  if (line && (plain || line.type.spec.code)) return line.textContent;
  const { schema } = ctx.get(editorViewCtx).state;
  try {
    const doc = schema.topNodeType.createChecked(
      null,
      line ? schema.nodes.paragraph.create(null, line.content) : slice.content,
    );
    return ctx.get(serializerCtx)(doc).replace(/\n+$/, "");
  } catch {
    // ProseMirror falls back to the selection's text.
    return "";
  }
}

type LinkRange = { from: number; to: number; mark: Mark };
// The link around the caret, including its edges, or the one link that holds
// the whole selection. Between two links the caret belongs to the one before,
// as typing there would extend it.
function linkAround(state: EditorState): LinkRange | null {
  const type = state.schema.marks.link;
  const { selection } = state;
  const { $from, $to } = selection;
  if (!type || !(selection instanceof TextSelection) || !$from.sameParent($to))
    return null;
  const parent = $from.parent;
  const offset = $from.parentOffset;
  let mark: Mark | null | undefined = null;
  let index = -1;
  for (const hit of [
    offset ? parent.childBefore(offset) : null,
    parent.childAfter(offset),
  ]) {
    mark = hit?.node && type.isInSet(hit.node.marks);
    if (mark) {
      index = hit!.index;
      break;
    }
  }
  if (!mark) return null;
  let first = index;
  let last = index + 1;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  while (last < parent.childCount && mark.isInSet(parent.child(last).marks))
    last++;
  let from = $from.start();
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = first; i < last; i++) to += parent.child(i).nodeSize;
  return $from.pos >= from && $to.pos <= to ? { from, to, mark } : null;
}

function tableCellPaste(ctx: Ctx, text: string) {
  const { schema } = ctx.get(editorViewCtx).state;
  // GFM cells hold one paragraph. Store line breaks as supported inline HTML
  // so they stay inside the cell when the document is saved as Markdown.
  const lineBreak = () => schema.nodes.html.create({ value: "<br />" });
  let content: Node[] = [];
  try {
    checkMarkdown(ctx, text).forEach((block, _offset, index) => {
      if (block.type.name !== "paragraph")
        throw new Error("Table cells only support inline formatting.");
      if (index) content.push(lineBreak(), lineBreak());
      block.forEach((node) =>
        content.push(node.type.name === "hardbreak" ? lineBreak() : node),
      );
    });
  } catch {
    // Keep unsupported/block syntax literal, including every line break.
    content = [];
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .forEach((line, index) => {
        if (index) content.push(lineBreak());
        if (line) content.push(schema.text(line));
      });
  }
  return new Slice(Fragment.fromArray(content), 0, 0);
}

type Props = {
  label?: string;
  images?: DocumentImages;
  documentLinks?: boolean;
  linkTitles?: boolean;
  initialMarkdown: string;
  remoteMarkdown?: { markdown: string; sequence: number };
  readOnly: boolean;
  saveStatus?: ReactNode;
  modeControl?: ReactNode;
  onChange: (markdown: string) => void;
  onUnsupported: (message: string) => void;
  onReady: () => void;
  onUpload?: (file: File, signal: AbortSignal) => Promise<string>;
  onUploading?: (count: number) => void;
};
export default function RichMarkdownEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const applyingRemote = useRef(false);
  const appliedRemote = useRef(props.remoteMarkdown);
  const latest = useRef(props);
  latest.current = props;
  const documentLinks = useDocumentLinkOpener();
  const linkOpener = useRef(documentLinks);
  linkOpener.current = documentLinks;
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [canDeleteRow, setCanDeleteRow] = useState(false);
  // `original` is the target's text when the form opened.
  type LinkForm = {
    href: string;
    text: string;
    original: string;
    editText: boolean;
  };
  const [link, setLink] = useState<LinkForm | null>(null);
  const linkFormOpen = useRef(false);
  linkFormOpen.current = link !== null;
  const [linkError, setLinkError] = useState("");
  type LinkTip = { href: string; left: number; top: number };
  const [linkTip, setLinkTip] = useState<LinkTip | null>(null);
  const linkTipRef = useRef<LinkTip | null>(null);
  const linkTipBox = useRef<HTMLDivElement>(null);
  const linkTitlesRef = useRef<DocumentLinkTitles | null>(null);
  const [notice, notify] = useToast();
  const [noticeFailed, setNoticeFailed] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [linkOpenError, setLinkOpenError] = useState("");
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [imageZoom, setImageZoom] = useState(false);
  type SlashState = SlashMatch & { left: number; top: number; flip: boolean };
  const shell = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const blockHandle = useRef<BlockHandleApi>(null);
  const slashRef = useRef<SlashState | null>(null);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const slashIndexRef = useRef(0);
  // Esc hides the menu for the "/" at this position until it is typed again.
  const dismissedSlash = useRef<number | null>(null);
  function closeSlash(dismiss = false) {
    dismissedSlash.current = dismiss ? (slashRef.current?.from ?? null) : null;
    if (!slashRef.current) return;
    slashRef.current = null;
    setSlash(null);
  }
  function applySlash(item: SlashItem) {
    const match = slashRef.current;
    if (!match || !editorRef.current || latest.current.readOnly) return;
    closeSlash();
    editorRef.current.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.delete(match.from, match.to));
    });
    item.run();
  }
  function slashKeydown(event: KeyboardEvent) {
    const items = slashItemsRef.current;
    if (!slashRef.current || !items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : items.length - 1;
      slashIndexRef.current = (slashIndexRef.current + step) % items.length;
      setSlashIndex(slashIndexRef.current);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      applySlash(items[slashIndexRef.current] || items[0]);
      return true;
    }
    if (event.key === "Escape") {
      closeSlash(true);
      return true;
    }
    return false;
  }
  function syncSlash(view: EditorView) {
    const match = latest.current.readOnly ? null : slashMatch(view.state);
    if (!match) return closeSlash();
    if (dismissedSlash.current === match.from) return;
    dismissedSlash.current = null;
    const coords = view.coordsAtPos(match.from);
    const rect = shell.current?.getBoundingClientRect();
    if (!rect) return;
    const flip = coords.bottom + 280 > window.innerHeight;
    const next = {
      ...match,
      left: Math.max(0, Math.min(coords.left - rect.left, rect.width - 220)),
      top: (flip ? coords.top - 4 : coords.bottom + 4) - rect.top,
      flip,
    };
    const current = slashRef.current;
    if (
      current &&
      (["from", "to", "query", "left", "top", "flip"] as const).every(
        (key) => current[key] === next[key],
      )
    )
      return;
    if (current?.from !== next.from) {
      slashIndexRef.current = 0;
      setSlashIndex(0);
    }
    slashRef.current = next;
    setSlash(next);
  }
  // The link under the caret shows its address with actions below it.
  function syncLinkTip(view: EditorView, focused = view.hasFocus()) {
    const range =
      focused && !latest.current.readOnly && !linkFormOpen.current
        ? linkAround(view.state)
        : null;
    const box = shell.current;
    let next: LinkTip | null = null;
    if (range && box) {
      const rect = box.getBoundingClientRect();
      const scale = rect.width / box.offsetWidth || 1;
      const start = view.coordsAtPos(range.from, 1);
      const end = view.coordsAtPos(range.to, -1);
      next = {
        href: range.mark.attrs.href,
        left: Math.max(0, (start.left - rect.left) / scale),
        top: (end.bottom - rect.top) / scale + 6,
      };
    }
    const current = linkTipRef.current;
    if (
      current === next ||
      (current &&
        next &&
        current.href === next.href &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5)
    )
      return;
    linkTipRef.current = next;
    setLinkTip(next);
  }
  useEffect(() => {
    let active = true;
    let initialized = false;
    const uploads = new Set<AbortController>();
    const pendingImages = new Set<Node>();
    const linkTitles = new DocumentLinkTitles();
    linkTitlesRef.current = linkTitles;
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root.current);
        ctx.set(defaultValueCtx, "");
        ctx.update(uploadConfig.key, (options) => ({
          ...options,
          enableHtmlFileUploader: true,
          uploadWidgetFactory: (pos, spec) => {
            const dom = document.createElement("span");
            dom.className = "document-upload-placeholder";
            dom.textContent = "이미지 업로드 중…";
            return Decoration.widget(pos, dom, spec);
          },
          uploader: async (files, schema) => {
            if (!active || latest.current.readOnly || !latest.current.onUpload)
              return [];
            setUploadError("");
            const controller = new AbortController();
            uploads.add(controller);
            latest.current.onUploading?.(uploads.size);
            try {
              const nodes = [];
              for (const file of Array.from(files)) {
                const url = await latest.current.onUpload(
                  file,
                  controller.signal,
                );
                if (!active || controller.signal.aborted) return [];
                if (!(latest.current.images?.accepts || isDocumentImage)(url))
                  throw new Error("이미지 주소를 확인할 수 없습니다.");
                nodes.push(
                  schema.nodes.image.create({
                    src: url,
                    alt: file.name.replace(/\.[^.]+$/, "") || "붙여넣은 이미지",
                  }),
                );
              }
              for (const node of nodes) pendingImages.add(node);
              return nodes;
            } catch (error) {
              if (active && !controller.signal.aborted)
                setUploadError((error as Error).message);
              return [];
            } finally {
              uploads.delete(controller);
              if (active) latest.current.onUploading?.(uploads.size);
            }
          },
        }));
        ctx.set(trailingConfig.key, {
          shouldAppend: needsTrailingParagraph,
          getNode: (state) => state.schema.nodes.paragraph.create(),
        });
        configureDocumentInputRules(ctx);
        ctx.set(editorViewOptionsCtx, {
          editable: () => !latest.current.readOnly,
          attributes: {
            role: "textbox",
            "aria-label": props.label || "업무 문서 리치 편집",
            "aria-multiline": "true",
            spellcheck: "false",
            translate: "no",
          },
          clipboardTextSerializer: (slice) => clipboardMarkdown(ctx, slice),
          handleDOMEvents: {
            keydown: (_view, event) =>
              latest.current.readOnly && event.key === "Tab",
            focus: (view) => {
              syncLinkTip(view, true);
              return false;
            },
            blur: (view, event) => {
              closeSlash();
              if (
                !linkTipBox.current?.contains(
                  (event as FocusEvent).relatedTarget as globalThis.Node,
                )
              )
                syncLinkTip(view, false);
              return false;
            },
            click: (_view, event) => {
              const anchor = (event.target as Element).closest("a");
              if (!anchor) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") || "";
              const target = parseDocumentLinkPath(href);
              if (
                latest.current.documentLinks === false &&
                documentLinkTarget(href)
              )
                return true;
              if (target)
                openDocumentLink(
                  target,
                  event,
                  linkTitles,
                  linkOpener.current,
                  (message) => active && setLinkOpenError(message),
                );
              // A click opens a web link; selecting its text by dragging
              // does not. The caret stays there for the link's actions.
              else if (
                safeDocumentLink(href) &&
                (latest.current.readOnly ||
                  event.metaKey ||
                  event.ctrlKey ||
                  document.getSelection()?.isCollapsed !== false)
              )
                window.open(href, "_blank", "noopener,noreferrer");
              return true;
            },
          },
          handleKeyDown: (view, event) => {
            if (latest.current.readOnly || view.composing || event.isComposing)
              return false;
            if (blockHandle.current?.keydown(event)) return true;
            if (slashKeydown(event)) return true;
            if (blockSelectKeydown(view, event)) return true;
            if (documentInputKeydown(view, event)) return true;
            if (toggleKeydown(view, event)) return true;
            if (listFormatKeydown(view, event)) return true;
            if (blockMoveKeydown(view, event)) return true;
            if (event.key === "Escape") {
              if (linkTipRef.current) {
                linkTipRef.current = null;
                setLinkTip(null);
              } else {
                const focused = document.activeElement;
                if (
                  focused instanceof HTMLElement &&
                  view.dom.contains(focused)
                )
                  focused.blur();
              }
              event.stopPropagation();
              return true;
            }
            if (
              event.key !== "Enter" ||
              !event.shiftKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              !isInTable(view.state)
            )
              return false;
            const { $from, $to } = view.state.selection;
            if (!$from.parent.isTextblock || !$from.sameParent($to))
              return false;
            // GFM cells need an inline <br />; a Markdown hardbreak would
            // split the table's source row and Milkdown filters it out.
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(
                  view.state.schema.nodes.html.create({ value: "<br />" }),
                )
                .scrollIntoView(),
            );
            return true;
          },
          handlePaste: (view, event, slice) => {
            if (event.clipboardData?.files?.length) {
              if (latest.current.readOnly) {
                event.preventDefault();
                return true;
              }
              return false; // Milkdown's upload plugin handles clipboard files.
            }
            const text = event.clipboardData?.getData("text/plain");
            if (text === undefined || latest.current.readOnly) return false;
            if (!view.state.selection.$from.parent.type.spec.code) {
              if (
                pasteDocumentLink(view, text, linkTitles) ||
                pasteExternalLink(
                  view,
                  text,
                  latest.current.linkTitles !== false,
                )
              ) {
                event.preventDefault();
                return true;
              }
            }
            // ProseMirror has already parsed HTML through the editor schema.
            // Keep its slice boundaries, marks and table paste handling instead
            // of replacing rich clipboard content with its plain-text fallback.
            if (
              view.state.selection.$from.parent.type.spec.code ||
              (event.clipboardData?.getData("text/html") &&
                safeClipboardSlice(slice, latest.current))
            )
              return false;
            // Markdown/plain text still uses the same preservation check.
            event.preventDefault();
            if (
              latest.current.documentLinks !== false &&
              pasteDocumentLink(view, text, linkTitles)
            )
              return true;
            const { $from, $to } = view.state.selection;
            if (
              isInTable(view.state) &&
              $from.parent.isTextblock &&
              $from.sameParent($to)
            ) {
              view.dispatch(
                view.state.tr
                  .replaceSelection(tableCellPaste(ctx, text))
                  .scrollIntoView(),
              );
              return true;
            }
            try {
              const doc = checkMarkdown(ctx, text, latest.current);
              view.dispatch(
                view.state.tr.replaceSelection(doc.slice(0)).scrollIntoView(),
              );
            } catch {
              view.dispatch(view.state.tr.insertText(text).scrollIntoView());
            }
            return true;
          },
          handleDrop: (_view, event) => {
            if (latest.current.readOnly && event.dataTransfer?.files?.length) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          nodeViews: {
            code_block: documentCodeBlockView,
            document_link: (node) => {
              if (latest.current.documentLinks !== false)
                return documentLinkView(node, linkTitles);
              const dom = document.createElement("span");
              dom.textContent = node.attrs.text;
              return { dom };
            },
            image: (node, view, getPos) =>
              documentImageView(
                node,
                view,
                getPos,
                () => latest.current.readOnly,
                (image) => {
                  setImageZoom(false);
                  setPreview(image);
                },
                latest.current.images,
              ),
            toggle_summary: (node, view, getPos) =>
              toggleSummaryView(
                node,
                view,
                getPos,
                () => latest.current.readOnly,
              ),
            html: (node) => {
              // Only attribute-free breaks become DOM elements. All other
              // HTML stays text, including nodes introduced by a DOM paste.
              const isBreak = isPlainLineBreak(node.attrs.value);
              const dom = document.createElement(isBreak ? "br" : "span");
              if (!isBreak) dom.textContent = node.attrs.value;
              return { dom };
            },
            list_item: (node, view, getPos) => {
              const dom = document.createElement("li");
              const contentDOM = document.createElement("div");
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.contentEditable = "false";
              checkbox.setAttribute("aria-label", "체크리스트 완료");
              const update = (next: typeof node) => {
                if (next.type !== node.type) return false;
                node = next;
                const task = node.attrs.checked != null;
                // Keep classes from decorations, such as selected blocks.
                dom.classList.toggle("document-check-item", task);
                checkbox.hidden = !task;
                checkbox.checked = !!node.attrs.checked;
                checkbox.disabled = latest.current.readOnly;
                return true;
              };
              checkbox.addEventListener("change", () => {
                const pos = getPos();
                if (pos === undefined || latest.current.readOnly) return;
                view.dispatch(
                  view.state.tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    checked: checkbox.checked,
                  }),
                );
              });
              dom.append(checkbox, contentDOM);
              update(node);
              return {
                dom,
                contentDOM,
                update,
                stopEvent: (event) => event.target === checkbox,
                ignoreMutation: (mutation) =>
                  mutation.type !== "selection" &&
                  (mutation.target === checkbox || mutation.target === dom),
              };
            },
          },
        });
      })
      .use(commonmark)
      .use(codeBlockMetaSchema)
      .use(documentCodeBlockSelection)
      .use(gfm)
      .use(documentLinkTitle)
      .use(documentLinkSchema)
      .use(toggle)
      .use(remarkToggle)
      .use(remarkTableShape)
      .use(history)
      .use(upload)
      .use(trailing)
      .use(blockDrag)
      .use(blockSelect)
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              appendTransaction: (transactions, _previous, state) => {
                if (
                  !pendingImages.size ||
                  !transactions.some((tr) => tr.docChanged)
                )
                  return null;
                let inserted = -1;
                state.doc.descendants((node, pos) => {
                  if (pendingImages.delete(node)) inserted = pos;
                });
                return inserted < 0
                  ? null
                  : selectAfterImage(state, inserted).scrollIntoView();
              },
              view: () => ({
                update: (view, previous) => {
                  if (active) {
                    setCanUndo(undoDepth(view.state) > 0);
                    setCanRedo(redoDepth(view.state) > 0);
                    setInTable(isInTable(view.state));
                    setCanDeleteRow(deleteTableRow(view.state));
                    syncSlash(view);
                    syncLinkTip(view);
                    blockHandle.current?.update(view, previous);
                  }
                  if (
                    active &&
                    initialized &&
                    !applyingRemote.current &&
                    !view.state.doc.eq(previous.doc)
                  )
                    latest.current.onChange(
                      ctx.get(serializerCtx)(view.state.doc),
                    );
                },
              }),
            }),
        ),
      );
    void editor
      .create()
      .then(() => {
        if (!active) return editor.destroy();
        try {
          const doc = editor.action((ctx) =>
            checkMarkdown(ctx, latest.current.initialMarkdown, latest.current),
          );
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(
              view.state.tr
                .replaceWith(0, view.state.doc.content.size, doc.content)
                .setMeta("addToHistory", false),
            );
          });
          editorRef.current = editor;
          initialized = true;
          setReady(true);
          latest.current.onReady();
        } catch (error) {
          latest.current.onUnsupported((error as Error).message);
        }
      })
      .catch((error) => {
        if (active)
          latest.current.onUnsupported(
            `리치 편집기를 열지 못했습니다. 원문에서 계속 편집할 수 있습니다. ${(error as Error).message}`,
          );
      });
    return () => {
      active = false;
      linkTitlesRef.current = null;
      linkTitles.dispose();
      pendingImages.clear();
      for (const controller of uploads) controller.abort();
      latest.current.onUploading?.(0);
      editorRef.current = null;
      if (editor.status === "Created") void editor.destroy();
    };
  }, []);
  useEffect(() => {
    if (
      !ready ||
      !props.remoteMarkdown ||
      appliedRemote.current === props.remoteMarkdown
    )
      return;
    appliedRemote.current = props.remoteMarkdown;
    try {
      applyingRemote.current = true;
      editorRef.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parsed = checkMarkdown(
          ctx,
          props.remoteMarkdown!.markdown,
          latest.current,
        );
        // Compare against the same trailing paragraph the view keeps so a
        // caret resting there is not moved by every remote save.
        const doc = needsTrailingParagraph(parsed.lastChild)
          ? parsed.copy(
              parsed.content.append(
                Fragment.from(view.state.schema.nodes.paragraph.create()),
              ),
            )
          : parsed;
        const start = view.state.doc.content.findDiffStart(doc.content);
        if (start === null) return;
        const end = view.state.doc.content.findDiffEnd(doc.content)!;
        const overlap = start - Math.min(end.a, end.b);
        const oldEnd = end.a + Math.max(0, overlap);
        const newEnd = end.b + Math.max(0, overlap);
        view.dispatch(
          view.state.tr
            .replace(start, oldEnd, doc.slice(start, newEnd))
            .setMeta("addToHistory", false),
        );
      });
    } catch (error) {
      latest.current.onUnsupported((error as Error).message);
    } finally {
      applyingRemote.current = false;
    }
  }, [ready, props.remoteMarkdown]);
  useEffect(() => {
    if (props.readOnly) {
      closeSlash();
      setLink(null);
      linkTipRef.current = null;
      setLinkTip(null);
    }
    editorRef.current?.action((ctx) =>
      ctx.get(editorViewCtx).setProps({ editable: () => !props.readOnly }),
    );
    root.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((input) => {
        input.disabled = props.readOnly;
      });
  }, [props.readOnly]);
  // The form above the text moves the link when it opens or closes, and a
  // narrower window wraps it elsewhere.
  useLayoutEffect(() => {
    const sync = () => {
      const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
      if (view) syncLinkTip(view);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [link === null]);
  // Keep the link's actions inside the document beside a link at its edge.
  useLayoutEffect(() => {
    const tip = linkTipBox.current;
    const box = shell.current;
    if (!tip || !box || !linkTip) return;
    const overflow = linkTip.left + tip.offsetWidth - box.clientWidth;
    tip.style.left = `${Math.max(0, linkTip.left - Math.max(0, overflow))}px`;
  }, [linkTip]);
  function run(action: (ctx: Ctx) => unknown) {
    if (props.readOnly || !editorRef.current) return;
    editorRef.current.action(action);
    editorRef.current.action((ctx) => ctx.get(editorViewCtx).focus());
  }
  const command = (key: any, payload?: any) => run(callCommand(key, payload));
  function removeFromTable(action: Command) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      action(view.state, (tr) =>
        view.dispatch(closeHistory(tr).scrollIntoView()),
      );
    });
  }
  function setListFormat(format: ListFormat) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      listFormatCommand(format)(view.state, view.dispatch, view);
    });
  }
  // Block formats from the select, the "/" menu and the block handle menu,
  // which also asks whether a format applies. A toggle summary turns back into
  // a plain block because Milkdown's block commands cannot change it in place.
  function blockCommand(ctx: Ctx, value: string): Command | null {
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
  // The form edits the link around the caret, or links the selection. The
  // name can change when the target is plain text within one line.
  function linkTarget(state: EditorState) {
    const around = linkAround(state);
    const { from, to } = around ?? state.selection;
    const $from = state.doc.resolve(from);
    let editText =
      $from.parent.isTextblock && $from.sameParent(state.doc.resolve(to));
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isInline && !node.isText) editText = false;
    });
    return {
      from,
      to,
      around,
      editText,
      text: editText ? state.doc.textBetween(from, to) : "",
    };
  }
  function openLinkForm() {
    const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
    if (!view || props.readOnly) return;
    const target = linkTarget(view.state);
    linkTipRef.current = null;
    setLinkTip(null);
    setLinkError("");
    setLink({
      href: target.around?.mark.attrs.href ?? "",
      text: target.text,
      original: target.text,
      editText: target.editText,
    });
  }
  function closeLinkForm() {
    linkFormOpen.current = false;
    setLink(null);
    editorRef.current?.action((ctx) => ctx.get(editorViewCtx).focus());
  }
  function applyLink(form: LinkForm) {
    const href = form.href.trim();
    if (
      !safeDocumentLink(href) ||
      (props.documentLinks === false && !!documentLinkTarget(href))
    ) {
      setLinkError("https:// 또는 mailto:로 시작하는 주소를 입력하세요.");
      return;
    }
    linkFormOpen.current = false;
    setLink(null);
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const type = linkSchema.type(ctx);
      const { from, to, around, editText, text: current } = linkTarget(state);
      const mark = type.create({ ...around?.mark.attrs, href });
      const text = form.text.trim() ? form.text : href;
      // The name replaces only the text the form opened on, or fills an
      // empty caret; a selection made since then is linked as it is.
      const rename =
        form.editText &&
        editText &&
        text !== current &&
        (current === form.original || from === to);
      const tr = state.tr;
      if (rename) {
        const marks =
          from < to
            ? (state.doc.nodeAt(from)?.marks ?? [])
            : (state.storedMarks ?? state.selection.$from.marks());
        tr.replaceWith(
          from,
          to,
          state.schema.text(text, mark.addToSet(type.removeFromSet(marks))),
        );
        tr.setSelection(TextSelection.create(tr.doc, from + text.length));
      } else if (from < to)
        tr.removeMark(from, to, type).addMark(from, to, mark);
      else return;
      view.dispatch(tr.scrollIntoView());
    });
  }
  function removeLink() {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const around = linkAround(view.state);
      if (around)
        view.dispatch(
          view.state.tr.removeMark(
            around.from,
            around.to,
            linkSchema.type(ctx),
          ),
        );
    });
  }
  function openLink(href: string, event: MouseEvent) {
    const target = parseDocumentLinkPath(href);
    if (props.documentLinks === false && documentLinkTarget(href)) return;
    if (target && linkTitlesRef.current)
      openDocumentLink(
        target,
        event,
        linkTitlesRef.current,
        linkOpener.current,
        setLinkOpenError,
      );
    else window.open(href, "_blank", "noopener,noreferrer");
  }
  async function copyLink(href: string) {
    try {
      await copyToClipboard(href);
      setNoticeFailed(false);
      notify("링크 주소를 복사했습니다.");
    } catch {
      setNoticeFailed(true);
      notify("링크 주소를 복사하지 못했습니다. 다시 시도해 주세요.");
    }
  }
  function setBlock(value: string) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      blockCommand(ctx, value)?.(view.state, view.dispatch, view);
    });
  }
  const slashEntries: [string, string, string, ReactNode][] = [
    ["paragraph", "본문", "text p", <Pilcrow size={16} />],
    ["h1", "제목 1", "heading h1", <Heading1 size={16} />],
    ["h2", "제목 2", "heading h2", <Heading2 size={16} />],
    ["h3", "제목 3", "heading h3", <Heading3 size={16} />],
    ["bullet", "글머리 목록", "list ul 목록", <List size={16} />],
    ["ordered", "번호 목록", "list ol 번호 목록", <ListOrdered size={16} />],
    ["task", "체크리스트", "todo task check 할 일", <ListChecks size={16} />],
    ["quote", "인용", "quote blockquote", <Quote size={16} />],
    ["code", "코드 블록", "code pre", <SquareCode size={16} />],
    [
      "mermaid",
      "Mermaid 다이어그램",
      "diagram chart 순서도",
      <Workflow size={16} />,
    ],
    ["table", "표", "table", <Table2 size={16} />],
    ["hr", "구분선", "divider hr rule 구분 선", <Minus size={16} />],
    ["toggle0", "토글", "toggle details 접기", <ListCollapse size={16} />],
    ...TOGGLE_LEVELS.map((level): [string, string, string, ReactNode] => [
      `toggle${level}`,
      `토글 제목 ${level}`,
      `toggle heading h${level} 토글제목`,
      <ListCollapse size={16} />,
    ]),
    ["link", "링크", "link url", <Link size={16} />],
  ];
  const slashItems: SlashItem[] = slashEntries.map(
    ([id, label, keywords, icon]) => ({
      id,
      label,
      keywords,
      icon,
      run: () => {
        if (id === "bullet" || id === "ordered" || id === "task")
          setListFormat(id);
        else if (id === "table")
          command(insertTableCommand.key, { row: 3, col: 3 });
        else if (id === "hr") command(insertHrCommand.key);
        else if (id === "link") openLinkForm();
        else if (id === "mermaid")
          run((ctx) => {
            const view = ctx.get(editorViewCtx);
            ctx.get(commandsCtx).call(createCodeBlockCommand.key, "mermaid");
            if (!view.state.selection.$from.parent.textContent)
              view.dispatch(
                view.state.tr.insertText("flowchart LR\n  A[시작] --> B[완료]"),
              );
          });
        else setBlock(id);
      },
    }),
  );
  const visibleSlashItems = slash
    ? filterSlashItems(slashItems, slash.query)
    : [];
  slashItemsRef.current = visibleSlashItems;
  const activeSlash = Math.min(
    slashIndex,
    Math.max(0, visibleSlashItems.length - 1),
  );
  slashIndexRef.current = activeSlash;
  return (
    <div
      className="rich-document"
      data-loading={!ready || undefined}
      ref={shell}
    >
      {!ready && <DocumentLoading />}
      {uploadError && (
        <p className="document-error" role="alert">
          {uploadError}
        </p>
      )}
      {linkOpenError && (
        <p className="document-error" role="alert">
          {linkOpenError}
        </p>
      )}
      {!props.readOnly && (
        <div className="document-rich-tools">
          <div
            className="document-formatbar"
            role="group"
            aria-label="문서 서식"
          >
            <Select
              aria-label="문서 블록"
              disabled={!ready}
              defaultValue=""
              onChange={(e) => {
                setBlock(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                문단 / 블록
              </option>
              <option value="paragraph">본문</option>
              <option value="h1">제목 1</option>
              <option value="h2">제목 2</option>
              <option value="h3">제목 3</option>
              <option value="quote">인용</option>
              <option value="code">코드 블록</option>
              <option value="toggle0">토글</option>
              {TOGGLE_LEVELS.map((level) => (
                <option key={level} value={`toggle${level}`}>
                  토글 제목 {level}
                </option>
              ))}
            </Select>
            {[
              ["굵게", Bold, () => command(toggleStrongCommand.key)],
              ["기울임", Italic, () => command(toggleEmphasisCommand.key)],
              [
                "취소선",
                Strikethrough,
                () => command(toggleStrikethroughCommand.key),
              ],
              ["인라인 코드", Code, () => command(toggleInlineCodeCommand.key)],
              ["글머리 목록", List, () => setListFormat("bullet")],
              ["번호 목록", ListOrdered, () => setListFormat("ordered")],
              ["체크리스트", ListChecks, () => setListFormat("task")],
              ["링크", Link, openLinkForm],
              ["인용", Quote, () => setBlock("quote")],
              ["코드 블록", SquareCode, () => setBlock("code")],
            ].map(([label, Icon, onClick]: any) => (
              <button
                type="button"
                key={label}
                disabled={!ready}
                aria-label={label}
                data-tooltip={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClick}
              >
                <Icon size={16} />
              </button>
            ))}
            <DocumentToolMenu
              label="토글"
              menuLabel="토글 제목 선택"
              icon={<ListCollapse size={16} />}
              disabled={!ready}
              onClick={() => setBlock("toggle0")}
              items={TOGGLE_LEVELS.map((level) => ({
                label: `토글 제목 ${level}`,
                icon: [
                  <Heading1 size={16} />,
                  <Heading2 size={16} />,
                  <Heading3 size={16} />,
                ][level - 1],
                run: () => setBlock(`toggle${level}`),
              }))}
            />
            <DocumentToolMenu
              label="표 삽입"
              menuLabel="표 행·열 편집"
              icon={<Table2 size={16} />}
              disabled={!ready}
              onClick={() =>
                command(insertTableCommand.key, { row: 3, col: 3 })
              }
              items={[
                {
                  label: "아래에 행 추가",
                  icon: <BetweenHorizontalStart size={16} />,
                  disabled: !inTable,
                  run: () => command(addRowAfterCommand.key),
                },
                {
                  label: "오른쪽에 열 추가",
                  icon: <BetweenVerticalStart size={16} />,
                  disabled: !inTable,
                  run: () => command(addColAfterCommand.key),
                },
                {
                  label: "행 삭제",
                  icon: <TableRowsSplit size={16} />,
                  tooltip: "선택한 행 삭제 (머리글과 마지막 본문 행 제외)",
                  disabled: !canDeleteRow,
                  run: () => removeFromTable(deleteTableRow),
                },
                {
                  label: "열 삭제",
                  icon: <TableColumnsSplit size={16} />,
                  tooltip: "선택한 열 삭제 (마지막 열은 표 전체 삭제)",
                  disabled: !inTable,
                  run: () => removeFromTable(deleteTableColumn),
                },
                {
                  label: "표 삭제",
                  icon: <Trash2 size={16} />,
                  tooltip: "현재 표 전체 삭제",
                  disabled: !inTable,
                  run: () => removeFromTable(deleteTable),
                },
              ]}
            />
            <div className="document-history-tools">
              {props.saveStatus}
              {[
                [
                  "문서 실행취소",
                  Undo2,
                  () => command(undoCommand.key),
                  canUndo,
                ],
                ["문서 재실행", Redo2, () => command(redoCommand.key), canRedo],
              ].map(([label, Icon, onClick, enabled]: any) => (
                <button
                  type="button"
                  key={label}
                  disabled={!ready || !enabled}
                  aria-label={label}
                  data-tooltip={label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onClick}
                >
                  <Icon size={16} />
                </button>
              ))}
              {props.modeControl}
            </div>
          </div>
          {link !== null && (
            <form
              className="document-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink(link);
              }}
              onKeyDown={(e) => {
                // Esc closes the form, not the detail around it.
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                closeLinkForm();
              }}
            >
              <label>
                <span>링크 주소</span>
                <input
                  autoFocus
                  value={link.href}
                  onChange={(e) => setLink({ ...link, href: e.target.value })}
                  placeholder="https://"
                />
              </label>
              {link.editText && (
                <label>
                  <span>표시 이름</span>
                  <input
                    value={link.text}
                    onChange={(e) => setLink({ ...link, text: e.target.value })}
                    placeholder="비워 두면 링크 주소"
                  />
                </label>
              )}
              <button type="submit">적용</button>
              <button type="button" onClick={closeLinkForm}>
                취소
              </button>
              {linkError && <span role="alert">{linkError}</span>}
            </form>
          )}
        </div>
      )}
      <div
        ref={root}
        className="document-prose"
        data-readonly={props.readOnly || undefined}
        onMouseDown={(event) => {
          // Clicks on the padding below the text continue at the end.
          if (event.target !== root.current || props.readOnly) return;
          event.preventDefault();
          editorRef.current?.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(
              view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
            );
            view.focus();
          });
        }}
      />
      {ready && !props.readOnly && (
        <DocumentBlockHandle
          ref={blockHandle}
          view={() =>
            editorRef.current?.action((ctx) => ctx.get(editorViewCtx)) ?? null
          }
          shell={shell}
          formats={slashItems.filter((item) => BLOCK_FORMATS.includes(item.id))}
          canFormat={(id) =>
            !!editorRef.current?.action((ctx) =>
              blockCommand(ctx, id)?.(ctx.get(editorViewCtx).state),
            )
          }
          onOpen={() => closeSlash()}
        />
      )}
      {linkTip && (
        <div
          ref={linkTipBox}
          className="document-link-tip"
          role="group"
          aria-label="링크"
          style={{ left: linkTip.left, top: linkTip.top }}
          onBlur={(event) => {
            const next = event.relatedTarget as globalThis.Node | null;
            if (
              !event.currentTarget.contains(next) &&
              !root.current?.contains(next)
            ) {
              linkTipRef.current = null;
              setLinkTip(null);
            }
          }}
        >
          <span className="document-link-tip-href" title={linkTip.href}>
            {linkTip.href}
          </span>
          {[
            [
              "링크 열기",
              ExternalLink,
              (event: MouseEvent) => openLink(linkTip.href, event),
            ],
            ["링크 주소 복사", Copy, () => void copyLink(linkTip.href)],
            ["링크 수정", Pencil, openLinkForm],
            ["링크 제거", Unlink, removeLink],
          ].map(([label, Icon, onClick]: any) => (
            <button
              type="button"
              key={label}
              aria-label={label}
              data-tooltip={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => onClick(e.nativeEvent)}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <Toast message={notice} failed={noticeFailed} />
      {slash && !props.readOnly && visibleSlashItems.length > 0 && (
        <DocumentSlashMenu
          items={visibleSlashItems}
          active={activeSlash}
          left={slash.left}
          top={slash.top}
          flip={slash.flip}
          onHover={(index) => {
            slashIndexRef.current = index;
            setSlashIndex(index);
          }}
          onSelect={applySlash}
        />
      )}
      {preview && (
        <Modal
          title="이미지 크게 보기"
          onClose={() => setPreview(null)}
          className="document-image-modal"
        >
          <div className="document-image-view-controls">
            <Button onClick={() => setImageZoom((value) => !value)}>
              {imageZoom ? <Maximize2 size={16} /> : <ZoomIn size={16} />}
              {imageZoom ? "화면에 맞추기" : "실제 크기"}
            </Button>
          </div>
          <div
            className={`document-image-canvas${imageZoom ? " actual-size" : ""}`}
          >
            <img src={preview.src} alt={preview.alt} />
          </div>
        </Modal>
      )}
    </div>
  );
}
