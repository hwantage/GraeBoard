import type { Node } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
} from "@milkdown/kit/prose/view";
import { closeHistory } from "@milkdown/kit/prose/history";
import { $prose } from "@milkdown/kit/utils";
import {
  documentImageSource,
  documentImageWidth,
  withDocumentImageWidth,
} from "../shared/document-images.js";

import type { DocumentImages } from "./document-storage";

export type ImagePreview = { src: string; alt: string };

// Browsers differ on the caret beside an image, which is not editable text:
// Chromium draws none and WebKit one as tall as the image. The image beside
// the caret marks that side; the stylesheet draws the caret there and hides
// the browser's own. The marker is an attribute on the image, so typing next
// to it, Korean composition included, meets no extra DOM.
export const imageCaret = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (state) => {
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !selection.empty)
            return null;
          const { pos, nodeBefore, nodeAfter } = selection.$head;
          const caret =
            nodeBefore?.type.name === "image"
              ? Decoration.node(pos - nodeBefore.nodeSize, pos, {
                  "data-caret": "after",
                })
              : nodeAfter?.type.name === "image"
                ? Decoration.node(pos, pos + nodeAfter.nodeSize, {
                    "data-caret": "before",
                  })
                : null;
          return caret && DecorationSet.create(state.doc, [caret]);
        },
      },
    }),
);

// Chromium commits the first jamo of a Korean composition started right
// after an image that ends its paragraph: as the text arrives, ProseMirror
// drops the separator and line break it keeps after the image (Chromium and
// Safari only), and Chromium ends a composition whose surroundings change. A
// zero-width space typed first gives the composition a text to follow. It
// never enters the undo history and leaves once the composition has ended.
const SPACER = "\u200b";
const spacerKey = new PluginKey<number | null>("document-image-spacer");
export const imageComposition = $prose(
  () =>
    new Plugin<number | null>({
      key: spacerKey,
      state: {
        init: () => null,
        apply: (tr, pos) => {
          const meta = tr.getMeta(spacerKey);
          if (meta !== undefined) return meta;
          if (pos === null) return null;
          const mapped = tr.mapping.mapResult(pos);
          return mapped.deleted ? null : mapped.pos;
        },
      },
      props: {
        handleDOMEvents: {
          compositionstart: (view) => {
            const { selection } = view.state;
            if (!(selection instanceof TextSelection) || !selection.empty)
              return false;
            const { $head } = selection;
            const image = $head.nodeBefore;
            if (image?.type.name !== "image" || $head.nodeAfter) return false;
            const separator = view.nodeDOM($head.pos - image.nodeSize)
              ?.nextSibling as Element | null | undefined;
            if (!separator?.classList?.contains("ProseMirror-separator"))
              return false;
            view.dispatch(
              view.state.tr
                .insertText(SPACER, $head.pos)
                .setMeta("addToHistory", false)
                .setMeta(spacerKey, $head.pos),
            );
            return false;
          },
          compositionend: (view) => {
            if (spacerKey.getState(view.state) == null) return false;
            // ProseMirror reads the composed text after this event.
            setTimeout(() => {
              const pos = spacerKey.getState(view.state);
              if (pos == null || view.isDestroyed) return;
              const tr = view.state.tr
                .setMeta(spacerKey, null)
                .setMeta("addToHistory", false);
              if (view.state.doc.textBetween(pos, pos + 1) === SPACER)
                tr.delete(pos, pos + 1);
              view.dispatch(tr);
            });
            return false;
          },
        },
      },
    }),
);

// The document to save: drafts and saves never carry the placeholder, even
// when the composition is cut off before it leaves.
export function withoutImageSpacer(state: EditorState) {
  const pos = spacerKey.getState(state);
  return pos != null && state.doc.textBetween(pos, pos + 1) === SPACER
    ? state.tr.delete(pos, pos + 1).doc
    : state.doc;
}

export function iconButton(label: string, paths: string[]) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  for (const d of paths) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  button.append(svg);
  return button;
}

export function documentImageView(
  initial: Node,
  view: EditorView,
  getPos: () => number | undefined,
  readOnly: () => boolean,
  onPreview: (image: ImagePreview) => void,
  images?: DocumentImages,
): NodeView {
  let node = initial;
  let active = true;
  let sourceKey = "";
  const widthOf = images?.width || documentImageWidth;
  const withWidth = images?.withWidth || withDocumentImageWidth;
  const dom = document.createElement("span");
  dom.className = "document-image";
  dom.contentEditable = "false";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  const actions = document.createElement("span");
  actions.className = "document-image-actions";
  const enlarge = iconButton("이미지 크게 보기", [
    "M15 3h6v6 M21 3l-7 7 M9 21H3v-6 M3 21l7-7",
  ]);
  const reset = iconButton("이미지 원래 크기", [
    "M3 10a9 9 0 1 1 2.7 8 M3 4v6h6",
  ]);
  reset.className = "document-image-edit";
  const handle = document.createElement("span");
  handle.className = "document-image-resize document-image-edit";
  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "이미지 너비 조절");
  handle.setAttribute("aria-valuemin", "32");
  handle.setAttribute("aria-valuemax", "4096");
  handle.dataset.tooltip = "드래그 또는 방향키로 크기 조절";
  const widthLabel = document.createElement("span");
  widthLabel.className = "document-image-size";
  // An image this site never received (or whose file was lost) is shown as
  // missing; deleting it and pasting it again stores it anew.
  const missing = document.createElement("span");
  missing.className = "document-image-missing";
  missing.textContent = "이미지 없음 · 지우고 다시 붙여넣으세요";
  missing.hidden = true;
  const showMissing = (shown: boolean) => {
    missing.hidden = !shown;
    dom.classList.toggle("is-missing", shown);
  };
  let drag: {
    id: number;
    x: number;
    width: number;
    target: number;
    max: number;
  } | null = null;
  const renderWidth = (width: number | null) => {
    dom.style.width = width ? `${width}px` : "";
    const displayed =
      Math.round(dom.getBoundingClientRect().width) || img.naturalWidth || 32;
    handle.setAttribute("aria-valuenow", String(width || displayed));
    handle.setAttribute("aria-valuetext", `${width || displayed} 픽셀`);
    widthLabel.textContent = `${width || displayed}px`;
  };
  const update = (next: Node) => {
    if (next.type !== node.type) return false;
    node = next;
    if (images) {
      const key =
        typeof node.attrs.src === "string" ? node.attrs.src.split("#")[0] : "";
      if (sourceKey !== key) {
        sourceKey = key;
        img.removeAttribute("src");
        void Promise.resolve(images.source(key))
          .then((src) => {
            if (!active || sourceKey !== key) return;
            showMissing(!src);
            if (src) img.src = src;
          })
          .catch(() => {
            if (active && sourceKey === key) showMissing(true);
          });
      }
    } else {
      const src = documentImageSource(node.attrs.src);
      if (src && img.getAttribute("src") !== src) {
        showMissing(false);
        img.src = src;
      }
      if (!src) img.removeAttribute("src");
    }
    img.alt = node.attrs.alt || "";
    img.title = node.attrs.title || "";
    renderWidth(widthOf(node.attrs.src));
    return true;
  };
  const commit = (width: number | null) => {
    const pos = getPos();
    if (readOnly() || pos === undefined) return;
    const src = withWidth(node.attrs.src, width);
    if (!src || src === node.attrs.src) return;
    // One resize gesture is one undo step, separate from typing before/after it.
    view.dispatch(
      closeHistory(view.state.tr).setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src,
      }),
    );
    view.dispatch(closeHistory(view.state.tr));
  };
  const preview = () => {
    const src = images
      ? img.getAttribute("src")
      : documentImageSource(node.attrs.src);
    if (src) onPreview({ src, alt: node.attrs.alt || "문서 이미지" });
  };
  enlarge.addEventListener("click", preview);
  img.addEventListener("dblclick", (event) => {
    event.preventDefault();
    preview();
  });
  img.addEventListener("load", () => {
    showMissing(false);
    if (!drag) renderWidth(widthOf(node.attrs.src));
  });
  img.addEventListener("error", () => {
    if (img.getAttribute("src")) showMissing(true);
  });
  reset.addEventListener("click", () => commit(null));
  handle.addEventListener("pointerdown", (event) => {
    if (readOnly() || event.button !== 0) return;
    event.preventDefault();
    const width = dom.getBoundingClientRect().width;
    const parent = dom.parentElement;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      width,
      target: width,
      max: Math.max(32, Math.min(4096, parent?.clientWidth || 4096)),
    };
    handle.setPointerCapture(event.pointerId);
    dom.classList.add("resizing");
    handle.focus({ preventScroll: true });
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.target = Math.round(
      Math.max(32, Math.min(drag.max, drag.width + event.clientX - drag.x)),
    );
    renderWidth(drag.target);
  });
  const finish = (event: PointerEvent, save: boolean) => {
    if (!drag || drag.id !== event.pointerId) return;
    const width = drag.target;
    drag = null;
    dom.classList.remove("resizing");
    if (handle.hasPointerCapture(event.pointerId))
      handle.releasePointerCapture(event.pointerId);
    if (save) commit(width);
    renderWidth(widthOf(node.attrs.src));
  };
  handle.addEventListener("pointerup", (event) => finish(event, true));
  handle.addEventListener("pointercancel", (event) => finish(event, false));
  handle.addEventListener("lostpointercapture", (event) =>
    finish(event, false),
  );
  handle.addEventListener("keydown", (event) => {
    if (readOnly()) return;
    const width = widthOf(node.attrs.src) || dom.getBoundingClientRect().width;
    const step = event.shiftKey ? 50 : 10;
    const next = {
      ArrowLeft: width - step,
      ArrowDown: width - step,
      ArrowRight: width + step,
      ArrowUp: width + step,
      Home: 32,
      End: 4096,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      commit(next);
    }
  });
  actions.append(reset, enlarge);
  dom.append(img, missing, actions, handle, widthLabel);
  update(node);
  return {
    dom,
    update,
    destroy: () => {
      active = false;
    },
    selectNode: () => dom.classList.add("ProseMirror-selectednode"),
    deselectNode: () => dom.classList.remove("ProseMirror-selectednode"),
    stopEvent: (event) =>
      actions.contains(event.target as globalThis.Node) ||
      handle.contains(event.target as globalThis.Node) ||
      event.type === "dblclick",
    ignoreMutation: (mutation) => mutation.type !== "selection",
  };
}
