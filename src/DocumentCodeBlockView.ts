import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
} from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const isMermaid = (node: Node) =>
  node.type.name === "code_block" && node.attrs.language === "mermaid";

// Keep source editing in ProseMirror so copying, history and remote changes
// use exactly the same code-block document and transactions as before.
export const documentCodeBlockSelection = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          beforeinput: (view, event) => {
            if (
              event.inputType !== "insertText" ||
              !event.data?.includes("\n") ||
              event.isComposing ||
              !view.editable
            )
              return false;
            // WebKit splits native multiline replacements into sibling pre
            // elements. Use the browser's target range before it changes DOM.
            const range = event.getTargetRanges()[0];
            if (!range) return false;
            const from = view.posAtDOM(range.startContainer, range.startOffset);
            const to = view.posAtDOM(range.endContainer, range.endOffset);
            const $from = view.state.doc.resolve(from);
            if (
              !isMermaid($from.parent) ||
              !$from.sameParent(view.state.doc.resolve(to))
            )
              return false;
            event.preventDefault();
            const tr = view.state.tr.insertText(event.data, from, to);
            view.dispatch(
              tr.setSelection(
                TextSelection.create(tr.doc, from + event.data.length),
              ),
            );
            return true;
          },
        },
        decorations: ({ doc, selection }) => {
          const decorations: Decoration[] = [];
          doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (isMermaid(node))
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "document-code-selected",
                }),
              );
          });
          return DecorationSet.create(doc, decorations);
        },
      },
    }),
);

let renderId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
class MermaidLoadError extends Error {}

function renderMermaid(source: string, dark: boolean, current: () => boolean) {
  // Mermaid has global configuration. Serialize initialize + render together
  // so diagrams in different editor/theme contexts cannot change each other.
  const result = renderQueue.then(async () => {
    if (!current()) return;
    // Do not retain a rejected import promise in the application.
    const { default: mermaid } = await import("mermaid").catch(() => {
      throw new MermaidLoadError();
    });
    if (!current()) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: dark ? "dark" : "default",
      fontFamily: "Pretendard, sans-serif",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "theme",
        "themeVariables",
        "themeCSS",
        "fontFamily",
        "dompurifyConfig",
      ],
    });
    const host = document.createElement("div");
    host.className = "document-mermaid-render";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(
        `document-mermaid-${++renderId}`,
        source,
        host,
      );
      if (!current()) return;
      // Only Mermaid's strict-mode sanitized SVG enters the DOM; Markdown
      // and error messages never become HTML. Do not bind click callbacks.
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = parsed.documentElement;
      if (root.localName !== "svg" || parsed.querySelector("parsererror"))
        throw new Error("Invalid Mermaid SVG");
      const width = Number(root.getAttribute("viewBox")?.split(/\s+/)[2]);
      if (Number.isFinite(width) && width > 0)
        root.setAttribute("width", String(width));
      return document.importNode(root, true);
    } finally {
      host.remove();
    }
  });
  renderQueue = result.catch(() => {});
  return result;
}

export function documentCodeBlockView(
  initial: Node,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  let node = initial;
  const mermaid = isMermaid(node);
  const pre = document.createElement("pre");
  const contentDOM = document.createElement("code");
  pre.append(contentDOM);
  const dom = mermaid ? document.createElement("div") : pre;
  const preview = document.createElement("div");
  const error = document.createElement("p");
  let generation = 0;
  let timer: ReturnType<typeof setTimeout>;
  let themeObserver: MutationObserver | undefined;
  let themeRoot: Element | null = null;
  let dark = false;
  const schedule = () => {
    const request = ++generation;
    clearTimeout(timer);
    timer = setTimeout(() => {
      themeRoot ??= view.dom.closest("[data-calendar-theme]");
      dark = themeRoot?.getAttribute("data-calendar-theme") === "dark";
      if (themeRoot && !themeObserver) {
        themeObserver = new MutationObserver(() => {
          if (
            (themeRoot?.getAttribute("data-calendar-theme") === "dark") !==
            dark
          )
            schedule();
        });
        themeObserver.observe(themeRoot, {
          attributes: true,
          attributeFilter: ["data-calendar-theme"],
        });
      }
      const current = () => generation === request;
      void renderMermaid(node.textContent, dark, current)
        .then((svg) => {
          if (!svg || !current()) return;
          preview.replaceChildren(svg);
          dom.classList.add("has-preview");
          dom.classList.remove("has-error");
          error.hidden = true;
        })
        .catch((reason: unknown) => {
          if (!current()) return;
          preview.replaceChildren();
          dom.classList.remove("has-preview");
          dom.classList.add("has-error");
          const loadFailed = reason instanceof MermaidLoadError;
          error.textContent = loadFailed
            ? "다이어그램 도구를 불러오지 못했습니다. 새로고침해 주세요."
            : "Mermaid 다이어그램을 표시할 수 없습니다. 소스를 확인해 주세요.";
          if (!loadFailed && reason instanceof Error) {
            const detail = document.createElement("span");
            detail.className = "document-mermaid-error-detail";
            detail.textContent = reason.message
              .split(/[\r\n]/, 1)[0]
              .slice(0, 200);
            if (detail.textContent)
              error.append(document.createElement("br"), detail);
          }
          error.hidden = false;
        });
    }, 250);
  };
  if (mermaid) {
    dom.className = "document-mermaid";
    preview.className = "document-mermaid-preview";
    preview.contentEditable = "false";
    preview.setAttribute("role", "img");
    preview.setAttribute("aria-label", "Mermaid 다이어그램");
    preview.addEventListener("mousedown", (event) => {
      if (!view.editable || event.button !== 0) return;
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, pos + 1),
        ),
      );
      view.focus();
    });
    error.className = "document-error";
    error.contentEditable = "false";
    error.hidden = true;
    dom.append(pre, preview, error);
    schedule();
  }
  const update = (next: Node) => {
    if (next.type !== node.type || isMermaid(next) !== mermaid) return false;
    const changed = next.textContent !== node.textContent;
    node = next;
    if (node.attrs.language) pre.dataset.language = node.attrs.language;
    else delete pre.dataset.language;
    if (node.attrs.meta) pre.dataset.meta = node.attrs.meta;
    else delete pre.dataset.meta;
    if (mermaid && changed) schedule();
    return true;
  };
  update(node);
  return {
    dom,
    contentDOM,
    update,
    ignoreMutation: (mutation) =>
      mutation.type !== "selection" &&
      (preview.contains(mutation.target) ||
        error.contains(mutation.target) ||
        (mutation.type === "attributes" &&
          (mutation.target === dom || mutation.target === pre))),
    destroy: () => {
      generation++;
      clearTimeout(timer);
      themeObserver?.disconnect();
    },
  };
}
