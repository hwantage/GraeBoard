import { $nodeSchema } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { parseDocumentLinkPath } from "../../../shared/document-links.js";
import {
  UNAVAILABLE_LINK_MESSAGE,
  documentLinkHref,
  documentLinkTarget,
  documentLinkUrl,
  type DocumentLinkOpener,
  type DocumentLinkTarget,
  type DocumentLinkTitles,
} from "../document-links";

// A link to another document is one inline unit in the rich editor: the
// document icon and the target's current title. Markdown keeps the ordinary
// link `[stored text](/links/<kind>/<id>)`, so the source editor and other
// viewers show a plain link. Formatted link text stays an ordinary link mark.
type MdNode = {
  type: string;
  url?: string;
  title?: string | null;
  value?: string;
  children?: MdNode[];
};
const plainText = (children: MdNode[] = []) =>
  children.length === 0 ||
  (children.length === 1 && children[0].type === "text");

export const documentLinkSchema = $nodeSchema("document_link", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: {
    href: { validate: "string" },
    text: { default: "", validate: "string" },
    title: { default: null },
  },
  leafText: (node: Node) => node.attrs.text,
  parseDOM: [
    {
      // Above the link mark: this site's document links, pasted or dropped.
      tag: "a[href]",
      priority: 60,
      getAttrs: (dom) => {
        const target = documentLinkTarget(
          (dom as HTMLElement).getAttribute("href") || "",
        );
        return target
          ? {
              href: documentLinkHref(target),
              text: (dom as HTMLElement).textContent || "",
              title: (dom as HTMLElement).getAttribute("title"),
            }
          : false;
      },
    },
  ],
  toDOM: (node) => [
    "a",
    {
      href: node.attrs.href,
      ...(node.attrs.title ? { title: node.attrs.title } : {}),
    },
    node.attrs.text,
  ],
  parseMarkdown: {
    match: (node) =>
      node.type === "link" &&
      !!parseDocumentLinkPath(node.url) &&
      plainText(node.children as MdNode[]),
    runner: (state, node, type) => {
      const link = node as unknown as MdNode;
      // Text-only places such as a toggle summary keep an ordinary link.
      if (!state.top()?.type.contentMatch.matchType(type)) {
        const mark = state.schema.marks.link;
        state.openMark(mark, { href: link.url, title: link.title });
        state.next(node.children);
        state.closeMark(mark);
        return;
      }
      state.addNode(type, {
        href: link.url,
        text: link.children?.[0]?.value ?? "",
        title: link.title ?? null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "document_link",
    runner: (state, node) => {
      state.addNode(
        "link",
        [{ type: "text", value: node.attrs.text }],
        undefined,
        { url: node.attrs.href, title: node.attrs.title },
      );
    },
  },
}));

const FILE_TEXT = [
  "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
  "M14 2v5a1 1 0 0 0 1 1h5",
  "M10 9H8",
  "M16 13H8",
  "M16 17H8",
];
function documentIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "1em",
    height: "1em",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  for (const d of FILE_TEXT) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// While loading, after a failed lookup and for an unavailable target the
// stored text is shown. The refreshed title is never written back.
export function documentLinkView(
  initial: Node,
  titles: DocumentLinkTitles,
): NodeView {
  let node = initial;
  let unwatch = () => {};
  const dom = document.createElement("a");
  dom.className = "document-link";
  dom.contentEditable = "false";
  dom.draggable = false;
  const label = document.createElement("span");
  dom.append(documentIcon(), label);
  const target = () => parseDocumentLinkPath(node.attrs.href)!;
  const render = () => {
    const state = titles.get(target());
    dom.dataset.state = state.status;
    label.textContent =
      (state.status === "ready" && state.title.trim()) ||
      node.attrs.text ||
      "제목 없음";
  };
  const bind = () => {
    unwatch();
    dom.setAttribute("href", node.attrs.href);
    unwatch = titles.watch(target(), render);
    render();
  };
  bind();
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      const moved = next.attrs.href !== node.attrs.href;
      node = next;
      if (moved) bind();
      else render();
      return true;
    },
    destroy: () => unwatch(),
    ignoreMutation: () => true,
  };
}

// A pasted address of this site's document link becomes a link. Without
// a title on the clipboard, the looked-up title replaces the address as the
// stored text; it belongs to the paste, so undo removes the link at once.
export function pasteDocumentLink(
  view: EditorView,
  text: string,
  titles: DocumentLinkTitles,
) {
  const target = documentLinkTarget(text.trim());
  const type = view.state.schema.nodes.document_link;
  if (!target || !type) return false;
  const known = titles.get(target);
  const node = type.create({
    href: documentLinkHref(target),
    text: (known.status === "ready" && known.title.trim()) || text.trim(),
  });
  view.dispatch(
    view.state.tr.replaceSelectionWith(node, false).scrollIntoView(),
  );
  if (known.status === "ready") return true;
  void titles.load(target).then(() => {
    const found = titles.get(target);
    if (view.isDestroyed || found.status !== "ready" || !found.title.trim())
      return;
    let pos = -1;
    view.state.doc.descendants((child, at) => {
      if (child === node) pos = at;
      return pos < 0;
    });
    if (pos >= 0)
      view.dispatch(
        view.state.tr
          .setNodeMarkup(pos, undefined, {
            ...node.attrs,
            text: found.title.trim(),
          })
          .setMeta("addToHistory", false),
      );
  });
  return true;
}

// A plain click opens the target's detail here, also while editing; ⌘/Ctrl
// opens its address in a new tab like other links.
export function openDocumentLink(
  target: DocumentLinkTarget,
  event: MouseEvent,
  titles: DocumentLinkTitles,
  opener: DocumentLinkOpener | null,
  onError: (message: string) => void,
) {
  if (event.metaKey || event.ctrlKey) {
    window.open(documentLinkUrl(target), "_blank", "noopener,noreferrer");
    return;
  }
  onError("");
  if (titles.get(target).status === "unavailable")
    onError(UNAVAILABLE_LINK_MESSAGE);
  else
    opener?.open(target).catch((error: Error) => {
      if (error.message === UNAVAILABLE_LINK_MESSAGE)
        titles.set(target, { status: "unavailable" });
      onError(error.message);
    });
}
