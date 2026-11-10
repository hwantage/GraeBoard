import { isDocumentImage } from "../../../shared/documents/document-images.js";
import { parseDocumentLinkPath } from "../../../shared/documents/document-links.js";
import { documentLinkTarget } from "../document-links";

import {
  editorViewCtx,
  parserCtx,
  serializerCtx,
  remarkCtx,
} from "@milkdown/kit/core";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";

import { Fragment, Slice, type Node } from "@milkdown/kit/prose/model";

import { $remark } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkdownNode, Root } from "@milkdown/kit/transformer";

import type { RichEditorProps as Props } from "./rich-editor-types";
// Keep an empty paragraph after blocks that offer no caret position below
// them, including a paragraph that ends with an image. The doc serializer
// already drops a final empty paragraph, so saved Markdown is unchanged.
export function needsTrailingParagraph(last: Node | null) {
  if (!last || last.type.name === "heading") return false;
  if (last.type.name === "paragraph")
    return last.lastChild?.type.name === "image";
  return true;
}
// Milkdown keeps only a fence's language. Keep the rest of the info string
// (```plain text, ```js filename="a.js", future mermaid options) so rich
// editing round-trips it instead of rewriting the fence.
export const codeBlockMetaSchema = codeBlockSchema.extendSchema(
  (prev) => (ctx) => {
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
          state.addNode(
            "code",
            undefined,
            node.content.firstChild?.text || "",
            {
              lang: node.attrs.language,
              meta: node.attrs.meta || undefined,
            },
          );
        },
      },
    };
  },
);
export function safeDocumentLink(url: string) {
  return (
    (/^(https?:|mailto:)/i.test(url) ||
      !!parseDocumentLinkPath(url) ||
      isDocumentImage(url)) &&
    !/[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/u.test(url)
  );
}
export function isPlainLineBreak(value: unknown): value is string {
  return typeof value === "string" && /^<br\s*\/?\s*>$/i.test(value.trim());
}
// GFM can parse rows wider or narrower than the header. Pad missing cells
// before both the loss check and ProseMirror parsing so all existing cells
// survive, and the table editor starts with a rectangular table. This does
// not write back to the source until the user actually edits the document.
export const remarkTableShape = $remark(
  "remarkDocumentTableShape",
  () => () => {
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
  },
);
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
export function checkMarkdown(
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
export function safeClipboardSlice(
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
export function clipboardMarkdown(ctx: Ctx, slice: Slice) {
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
  const { schema } = ctx.get(editorViewCtx).state;
  // A selected image, or another inline node, is copied as its own line.
  if (!line && content.firstChild?.isInline)
    line = schema.nodes.paragraph.create(null, content);
  // Plain words stay as written, without Markdown escapes such as "\[".
  let plain = !!line;
  line?.forEach((node) => {
    if (!node.isText || node.marks.length) plain = false;
  });
  if (line && (plain || line.type.spec.code)) return line.textContent;
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
export function tableCellPaste(ctx: Ctx, text: string) {
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
