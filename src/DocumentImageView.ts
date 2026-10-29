import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { closeHistory } from "@milkdown/kit/prose/history";
import {
  documentImageSource,
  documentImageWidth,
  withDocumentImageWidth,
} from "../shared/document-images.js";

export type ImagePreview = { src: string; alt: string };
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
): NodeView {
  let node = initial;
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
    const src = documentImageSource(node.attrs.src);
    if (src && img.getAttribute("src") !== src) img.src = src;
    if (!src) img.removeAttribute("src");
    img.alt = node.attrs.alt || "";
    img.title = node.attrs.title || "";
    renderWidth(documentImageWidth(node.attrs.src));
    return true;
  };
  const commit = (width: number | null) => {
    const pos = getPos();
    if (readOnly() || pos === undefined) return;
    const src = withDocumentImageWidth(node.attrs.src, width);
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
    const src = documentImageSource(node.attrs.src);
    if (src) onPreview({ src, alt: node.attrs.alt || "문서 이미지" });
  };
  enlarge.addEventListener("click", preview);
  img.addEventListener("dblclick", (event) => {
    event.preventDefault();
    preview();
  });
  img.addEventListener("load", () => {
    if (!drag) renderWidth(documentImageWidth(node.attrs.src));
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
    renderWidth(documentImageWidth(node.attrs.src));
  };
  handle.addEventListener("pointerup", (event) => finish(event, true));
  handle.addEventListener("pointercancel", (event) => finish(event, false));
  handle.addEventListener("lostpointercapture", (event) =>
    finish(event, false),
  );
  handle.addEventListener("keydown", (event) => {
    if (readOnly()) return;
    const width =
      documentImageWidth(node.attrs.src) || dom.getBoundingClientRect().width;
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
  dom.append(img, actions, handle, widthLabel);
  update(node);
  return {
    dom,
    update,
    selectNode: () => dom.classList.add("ProseMirror-selectednode"),
    deselectNode: () => dom.classList.remove("ProseMirror-selectednode"),
    stopEvent: (event) =>
      actions.contains(event.target as globalThis.Node) ||
      handle.contains(event.target as globalThis.Node) ||
      event.type === "dblclick",
    ignoreMutation: (mutation) => mutation.type !== "selection",
  };
}
