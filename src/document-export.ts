import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { Editor, rootCtx, parserCtx, schemaCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import {
  codeBlockMetaSchema,
  remarkTableShape,
  safeDocumentLink,
} from "./RichMarkdownEditor";
import { documentLinkSchema } from "./DocumentLinkNode";
import { remarkToggle, toggle } from "./DocumentToggle";
import { renderMermaid } from "./DocumentCodeBlockView";
import {
  documentImageSource,
  documentImageWidth,
  isDocumentImage,
} from "../shared/document-images.js";
import { parseDocumentLinkPath } from "../shared/document-links.js";
import { saveFile } from "./api";
import type { DocumentImages } from "./document-storage";

// A document downloads as one file that opens away from this site: the
// Markdown source, a standalone HTML page or, through the browser's print
// dialog, a PDF. Images go into the file as data: addresses and links to
// other documents become this site's full addresses. Nothing is sent to the
// server; the server images are read like the editor shows them.
export type DocumentExportFormat = "pdf" | "markdown" | "html";
type Images = Pick<DocumentImages, "accepts" | "source" | "width">;
const serverImages: Images = {
  accepts: isDocumentImage,
  source: documentImageSource,
  width: documentImageWidth,
};

export async function exportDocument(
  format: DocumentExportFormat,
  input: { markdown: string; title: string; images?: Images },
) {
  const files = new ImageFiles(input.images ?? serverImages);
  if (format === "markdown")
    saveFile(
      new Blob([await portableMarkdown(input.markdown, files)], {
        type: "text/markdown;charset=utf-8",
      }),
      fileName(input.title, "md"),
    );
  else {
    const body = await documentBody(input.markdown, files, format === "pdf");
    if (format === "html")
      saveFile(
        new Blob([page(input.title, body)], {
          type: "text/html;charset=utf-8",
        }),
        fileName(input.title, "html"),
      );
    else await printPage(page(input.title, body, fontFaces()), input.title);
  }
  // Images that could not be read stay out of the file.
  return files.missing.size;
}

export function fileName(title: string, extension: string) {
  const name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return `${Array.from(name || "문서")
    .slice(0, 100)
    .join("")}.${extension}`;
}

class ImageFiles {
  missing = new Set<string>();
  private files = new Map<string, Promise<string | null>>();
  constructor(readonly images: Images) {}
  // The image as a data: address, or null when it could not be read.
  read(url: string) {
    let file = this.files.get(url);
    if (!file) this.files.set(url, (file = this.load(url)));
    return file;
  }
  private async load(url: string) {
    try {
      const source = await this.images.source(url);
      if (!source) throw new Error("Unknown image");
      if (source.startsWith("data:image/")) return source;
      const response = await fetch(source, { credentials: "same-origin" });
      const blob = await response.blob();
      if (!response.ok || !blob.type.startsWith("image/"))
        throw new Error("Unavailable image");
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      this.missing.add(url);
      return null;
    }
  }
}

const absolute = (path: string) => new URL(path, location.origin).href;

type MdNode = {
  type: string;
  url?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};
const markdownParser = unified().use(remarkParse).use(remarkGfm);
// The source as written, with only the image and document link addresses
// replaced. Code and other text stay exactly as they are.
async function portableMarkdown(markdown: string, files: ImageFiles) {
  const edits: { start: number; end: number; value: string }[] = [];
  const replace = (start: number, url: string, value: string) => {
    if (markdown.startsWith(url, start))
      edits.push({ start, end: start + url.length, value });
  };
  // The address ends a link or image; a reference sets it in its definition.
  const replaceUrl = (node: MdNode, value: string) => {
    const { start, end } = {
      start: node.position?.start.offset,
      end: node.position?.end.offset,
    };
    if (start == null || end == null || !node.url) return;
    const at = markdown.lastIndexOf(node.url, end - node.url.length);
    if (at >= start) replace(at, node.url, value);
  };
  const reads: Promise<void>[] = [];
  const visit = (node: MdNode) => {
    const url = node.url;
    if (
      url &&
      (node.type === "image" || node.type === "definition") &&
      files.images.accepts(url)
    )
      reads.push(
        files.read(url).then((file) => {
          if (file) replaceUrl(node, file);
        }),
      );
    else if (
      url &&
      (node.type === "link" || node.type === "definition") &&
      parseDocumentLinkPath(url)
    )
      replaceUrl(node, absolute(url));
    // A toggle's title is html: `<summary>[제목](/links/…)</summary>`.
    else if (node.type === "html" && node.value) {
      const offset = node.position?.start.offset;
      if (offset != null)
        for (const match of node.value.matchAll(/\]\((\/links\/[^\s)]+)\)/g))
          if (parseDocumentLinkPath(match[1]))
            replace(offset + match.index + 2, match[1], absolute(match[1]));
    }
    node.children?.forEach(visit);
  };
  visit(markdownParser.parse(markdown) as MdNode);
  await Promise.all(reads);
  let text = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

// The rich editor's own parser and schema turn the source into the same
// blocks it shows, without its editing views.
async function documentFragment(markdown: string, doc: Document) {
  const editor = await Editor.make()
    .config((ctx) => ctx.set(rootCtx, document.createElement("div")))
    .use(commonmark)
    .use(codeBlockMetaSchema)
    .use(gfm)
    .use(documentLinkSchema)
    .use(toggle)
    .use(remarkToggle)
    .use(remarkTableShape)
    .create();
  try {
    return editor.action((ctx) =>
      DOMSerializer.fromSchema(ctx.get(schemaCtx)).serializeFragment(
        ctx.get(parserCtx)(markdown).content,
        { document: doc },
      ),
    );
  } finally {
    await editor.destroy();
  }
}

async function documentBody(
  markdown: string,
  files: ImageFiles,
  print: boolean,
) {
  // A document without a window: its images load nothing until they become
  // data: addresses, so no address in the text is ever requested here.
  const doc = document.implementation.createHTMLDocument("");
  const body = doc.createElement("main");
  try {
    body.append(await documentFragment(markdown, doc));
  } catch {
    // Text the editor cannot read stays readable as its source.
    const source = doc.createElement("pre");
    source.textContent = markdown;
    body.append(source);
  }
  // A toggle opens as it was saved; paper shows every toggle open.
  for (const block of body.querySelectorAll<HTMLElement>(".document-toggle")) {
    const details = doc.createElement("details");
    details.open = print || block.dataset.open !== "false";
    const summary = doc.createElement("summary");
    const title = block.querySelector(":scope > .document-toggle-summary");
    if (title && /^H[1-6]$/.test(title.tagName)) {
      title.removeAttribute("class");
      summary.append(title);
    } else if (title) summary.append(...title.childNodes);
    details.append(summary);
    const content = block.querySelector(":scope > .document-toggle-content");
    if (content) {
      content.className = "toggle-content";
      details.append(content);
    }
    block.replaceWith(details);
  }
  for (const item of body.querySelectorAll<HTMLElement>(
    'li[data-item-type="task"]',
  )) {
    // Shown like the editor's checkbox, not dimmed, but not changed here.
    const box = doc.createElement("input");
    box.type = "checkbox";
    box.tabIndex = -1;
    if (item.dataset.checked === "true") box.setAttribute("checked", "");
    item.className = "task";
    item.prepend(box);
  }
  // The editor shows a lone `<br>` as a line break; other html stays text.
  for (const html of body.querySelectorAll('span[data-type="html"]')) {
    const value = html.textContent || "";
    html.replaceWith(
      /^<br\s*\/?\s*>$/i.test(value.trim())
        ? doc.createElement("br")
        : doc.createTextNode(value),
    );
  }
  for (const link of body.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (parseDocumentLinkPath(href)) link.setAttribute("href", absolute(href));
    else if (!safeDocumentLink(href)) link.replaceWith(...link.childNodes);
  }
  for (const code of body.querySelectorAll<HTMLElement>(
    'pre[data-language="mermaid"]',
  )) {
    // A diagram that cannot be drawn keeps its code, as in the editor.
    const svg = await renderMermaid(
      code.textContent || "",
      false,
      () => true,
    ).catch(() => null);
    if (!svg) continue;
    const figure = doc.createElement("figure");
    figure.className = "mermaid";
    figure.append(svg);
    code.replaceWith(figure);
  }
  await Promise.all(
    [...body.querySelectorAll("img")].map(async (image) => {
      const url = image.getAttribute("src") || "";
      const alt = doc.createTextNode(image.getAttribute("alt") || "");
      // Other images are not part of the rich document; they stay links.
      if (!files.images.accepts(url)) {
        if (!/^https?:/i.test(url)) return image.replaceWith(alt);
        const link = doc.createElement("a");
        link.href = url;
        link.textContent = alt.data || url;
        return image.replaceWith(link);
      }
      const file = await files.read(url);
      if (!file) return image.replaceWith(alt);
      image.setAttribute("src", file);
      const width = files.images.width(url);
      if (width) image.setAttribute("width", String(width));
      if (!image.getAttribute("title")) image.removeAttribute("title");
    }),
  );
  for (const element of body.querySelectorAll("*"))
    if (!element.closest("svg"))
      for (const name of element.getAttributeNames())
        if (name.startsWith("data-")) element.removeAttribute(name);
  return body.outerHTML;
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
function page(title: string, body: string, style = "") {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}${style}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// The app's own fonts for the print page. A saved HTML file uses the
// viewer's fonts instead.
function fontFaces() {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href || document.baseURI;
    for (const rule of list)
      if (
        rule instanceof CSSFontFaceRule &&
        /Pretendard|Nanum Gothic Coding/i.test(
          rule.style.getPropertyValue("font-family"),
        )
      )
        rules.push(
          rule.cssText.replace(
            /url\((["']?)([^"')]+)\1\)/g,
            (_, _quote, url: string) => `url("${new URL(url, base).href}")`,
          ),
        );
  }
  return rules.join("\n");
}

// A frame written by this page takes the page's address, which the print
// dialog shows instead of about:blank. Chromium names the PDF after the
// page's title, not the frame's, so the page carries the document's title
// while the dialog is open.
async function printPage(html: string, title: string) {
  // Printing focuses the frame; focus returns where it was, such as the
  // download button a keyboard pick went back to.
  const focused = document.activeElement as HTMLElement | null;
  // A frame left by a dialog that never reported closing.
  document.querySelector(".document-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.className = "document-print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const view = frame.contentWindow!;
  void doc.body.offsetHeight;
  await Promise.all(
    [...doc.images].map((image) => image.decode().catch(() => {})),
  );
  await doc.fonts?.ready;
  const pageTitle = document.title;
  const restore = () => {
    if (document.title === title) document.title = pageTitle;
    frame.remove();
    if (document.activeElement === document.body)
      focused?.focus({ preventScroll: true });
  };
  view.addEventListener("afterprint", () => setTimeout(restore), {
    once: true,
  });
  document.title = title;
  try {
    view.focus();
    view.print();
  } catch (error) {
    restore();
    throw error;
  }
}

// The document's look on screen, without the app around it.
const PAGE_STYLE = `
* { box-sizing: border-box; }
html { color-scheme: light; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  background: #fff;
  color: #293c42;
  font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  font-size: 15px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
main { max-width: 860px; margin: 0 auto; padding: 40px 32px; }
main > :first-child { margin-top: 0; }
p { margin: 0.7em 0; }
h1, h2, h3 { margin: 1em 0 0.5em; line-height: 1.4; }
h1 { font-size: 28px; }
h2 { font-size: 23px; }
h3 { font-size: 19px; }
h4 { font-size: 16px; }
h5, h6 { font-size: 15px; }
h3, h4, h5, h6 { font-weight: 600; }
ul, ol { padding-left: 26px; }
li p { margin: 0.2em 0; }
li.task { list-style: none; position: relative; }
li.task > input { position: absolute; left: -24px; top: 0.45em; width: 16px; height: 16px; margin: 0; accent-color: #24796d; pointer-events: none; }
blockquote { margin: 16px 0; padding: 0 16px; border-left: 3px solid #24796d; color: #718087; }
pre, code { font-family: "Nanum Gothic Coding", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f0f4f2; border-radius: 4px; }
code { padding: 2px 4px; font-size: 0.9em; }
pre { padding: 14px; white-space: pre-wrap; }
pre code { padding: 0; font-size: inherit; background: none; }
a { color: #1b6258; text-decoration: underline; }
hr { margin: 24px 0; border: 0; border-top: 1px solid #d5e1dd; }
img { max-width: 100%; height: auto; }
table { width: 100%; margin: 20px 0; border-collapse: collapse; }
th, td { min-width: 6em; padding: 6px 8px; border: 1px solid #d5e1dd; line-height: 1.5; vertical-align: top; }
th { background: #f0f4f2; font-weight: 600; }
:is(th, td) > p { margin: 0; }
:is(th, td) > p + p { margin-top: 0.35em; }
figure.mermaid { margin: 16px 0; overflow-x: auto; }
figure.mermaid > svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
details { margin: 0.7em 0; }
summary { cursor: pointer; }
summary > :is(h1, h2, h3, h4, h5, h6) { display: inline; }
.toggle-content { padding-left: 22px; }
@page { margin: 16mm 14mm; }
@media print {
  main { max-width: none; padding: 0; }
  :is(h1, h2, h3, h4, h5, h6, summary) { break-after: avoid; }
  :is(tr, img, figure, blockquote) { break-inside: avoid; }
}
`;
