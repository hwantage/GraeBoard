import { useEffect, useRef, useState, type ReactNode } from "react";
import { isDocumentImage } from "../shared/document-images.js";
import { documentImageView, type ImagePreview } from "./DocumentImageView";
import { Button, Modal } from "./components";
import Select from "./Select";
import DocumentLoading from "./DocumentLoading";
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
import { $prose, callCommand } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
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
  Minus,
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
    /^(https?:|mailto:)/i.test(url) &&
    !/[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/u.test(url)
  );
}

function isPlainLineBreak(value: unknown): value is string {
  return typeof value === "string" && /^<br\s*\/?\s*>$/i.test(value.trim());
}

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
function checkMarkdown(ctx: Ctx, markdown: string) {
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
    if (node.type === "link" && !safeDocumentLink(node.url))
      throw new Error(
        "HTTP(S)·메일 링크만 리치 편집에서 지원합니다. 원문은 그대로 보존됩니다.",
      );
    if (node.type === "image" && !isDocumentImage(node.url))
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

function safeClipboardSlice(slice: Slice) {
  let safe = true;
  slice.content.descendants((node) => {
    if (
      (node.type.name === "html" && !isPlainLineBreak(node.attrs.value)) ||
      (node.type.name === "image" && !isDocumentImage(node.attrs.src)) ||
      node.type.name === "footnote_definition" ||
      node.type.name === "footnote_reference" ||
      node.marks.some(
        (mark) =>
          mark.type.name === "link" && !safeDocumentLink(mark.attrs.href),
      )
    )
      safe = false;
    return safe;
  });
  return safe;
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
  initialMarkdown: string;
  remoteMarkdown?: { markdown: string; sequence: number };
  readOnly: boolean;
  saveStatus?: ReactNode;
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
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [canDeleteRow, setCanDeleteRow] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [imageZoom, setImageZoom] = useState(false);
  type SlashState = SlashMatch & { left: number; top: number; flip: boolean };
  const shell = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
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
  useEffect(() => {
    let active = true;
    let initialized = false;
    const uploads = new Set<AbortController>();
    const pendingImages = new Set<Node>();
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
                if (!isDocumentImage(url))
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
        ctx.set(editorViewOptionsCtx, {
          editable: () => !latest.current.readOnly,
          attributes: {
            role: "textbox",
            "aria-label": props.label || "업무 문서 리치 편집",
            "aria-multiline": "true",
            spellcheck: "false",
            translate: "no",
          },
          handleDOMEvents: {
            blur: () => {
              closeSlash();
              return false;
            },
            click: (_view, event) => {
              const anchor = (event.target as Element).closest("a");
              if (!anchor) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") || "";
              if (
                safeDocumentLink(href) &&
                (latest.current.readOnly || event.metaKey || event.ctrlKey)
              )
                window.open(href, "_blank", "noopener,noreferrer");
              return true;
            },
          },
          handleKeyDown: (view, event) => {
            if (latest.current.readOnly || view.composing || event.isComposing)
              return false;
            if (slashKeydown(event)) return true;
            if (toggleKeydown(view, event)) return true;
            if (listFormatKeydown(view, event)) return true;
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
            // ProseMirror has already parsed HTML through the editor schema.
            // Keep its slice boundaries, marks and table paste handling instead
            // of replacing rich clipboard content with its plain-text fallback.
            if (
              view.state.selection.$from.parent.type.spec.code ||
              (event.clipboardData?.getData("text/html") &&
                safeClipboardSlice(slice))
            )
              return false;
            // Markdown/plain text still uses the same preservation check.
            event.preventDefault();
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
              const doc = checkMarkdown(ctx, text);
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
                dom.className = task ? "document-check-item" : "";
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
      .use(gfm)
      .use(toggle)
      .use(remarkToggle)
      .use(history)
      .use(upload)
      .use(trailing)
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
            checkMarkdown(ctx, latest.current.initialMarkdown),
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
        const parsed = checkMarkdown(ctx, props.remoteMarkdown!.markdown);
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
    if (props.readOnly) closeSlash();
    editorRef.current?.action((ctx) =>
      ctx.get(editorViewCtx).setProps({ editable: () => !props.readOnly }),
    );
    root.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((input) => {
        input.disabled = props.readOnly;
      });
  }, [props.readOnly]);
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
  // Block formats from the select and the "/" menu. A toggle summary turns
  // back into a plain block because Milkdown's block commands cannot change
  // it in place.
  function setBlock(value: string) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const exec = (command: Command) =>
        command(view.state, view.dispatch, view);
      if (value.startsWith("toggle")) {
        exec(setToggleCommand(Number(value.slice(6)) || 0));
        return;
      }
      const summary = inToggleSummary(view.state);
      if (value.startsWith("h")) {
        const level = Number(value.slice(1));
        if (summary)
          exec(unwrapToggleCommand(headingSchema.type(ctx), { level }));
        else callCommand(wrapInHeadingCommand.key, level)(ctx);
      } else if (value === "paragraph") {
        if (summary) exec(unwrapToggleCommand(paragraphSchema.type(ctx)));
        else callCommand(turnIntoTextCommand.key)(ctx);
      } else if (value === "quote")
        callCommand(wrapInBlockquoteCommand.key)(ctx);
      else if (value === "code") callCommand(createCodeBlockCommand.key)(ctx);
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
        else if (id === "link") {
          setLink("");
          setLinkError("");
        } else setBlock(id);
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
              [
                "링크",
                Link,
                () => {
                  setLink("");
                  setLinkError("");
                },
              ],
              [
                "표 삽입",
                Table2,
                () => command(insertTableCommand.key, { row: 3, col: 3 }),
              ],
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
            <button
              type="button"
              disabled={!ready || !inTable}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(addRowAfterCommand.key)}
            >
              표 행 +
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(addColAfterCommand.key)}
            >
              표 열 +
            </button>
            <button
              type="button"
              disabled={!ready || !canDeleteRow}
              data-tooltip="선택한 행 삭제 (머리글과 마지막 본문 행 제외)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTableRow)}
            >
              표 행 -
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              data-tooltip="선택한 열 삭제 (마지막 열은 표 전체 삭제)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTableColumn)}
            >
              표 열 -
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              data-tooltip="현재 표 전체 삭제"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTable)}
            >
              표 삭제
            </button>
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
            </div>
          </div>
          {link !== null && (
            <form
              className="document-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!safeDocumentLink(link)) {
                  setLinkError(
                    "https:// 또는 mailto:로 시작하는 주소를 입력하세요.",
                  );
                  return;
                }
                run((ctx) => {
                  const view = ctx.get(editorViewCtx),
                    { from, to } = view.state.selection;
                  let tr = view.state.tr;
                  if (from === to) tr = tr.insertText(link, from);
                  view.dispatch(
                    tr
                      .addMark(
                        from,
                        from === to ? from + link.length : to,
                        linkSchema.type(ctx).create({ href: link }),
                      )
                      .scrollIntoView(),
                  );
                });
                setLink(null);
              }}
            >
              <label>
                링크 주소{" "}
                <input
                  autoFocus
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://"
                />
              </label>
              <button type="submit">적용</button>
              <button type="button" onClick={() => setLink(null)}>
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
