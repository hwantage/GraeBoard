// Read-only entry point. It shares the editor's file decoder, presentation
// order and static element renderer without starting an editor or recovery session.
import { parseDocumentFile } from "@shared/canvas/document-file";
import { contentBounds } from "@shared/canvas/element-bounds";
import { createFrameElement } from "@shared/canvas/element-factory";
import type {
  CanvasDocument,
  CanvasElement,
  Rect,
} from "@shared/canvas/element-types";
import { orderedFrames } from "@shared/canvas/presentation-sequence";
import { zoomLayerCssStyle } from "@shared/canvas/zoom-layer-style";
import { pdfPageElements } from "@shared/pdf/pdf-export-pages";
import { renderElement } from "@shared/render/element-dom";
import elementCss from "@shared/render/element.css?raw";

async function decoded(src: string) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

async function drawVectors(
  context: CanvasRenderingContext2D,
  nodes: HTMLElement[],
  frame: Rect,
  scale: number,
) {
  if (!nodes.length) return;
  const { width, height } = context.canvas;
  const root = document.createElement("div");
  root.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`;
  const zoom = document.createElement("div");
  Object.assign(zoom.style, zoomLayerCssStyle(scale, navigator.userAgent));
  const world = document.createElement("div");
  world.style.cssText = `position:absolute;left:${-frame.x}px;top:${-frame.y}px`;
  const style = document.createElement("style");
  style.textContent = elementCss;
  for (const node of nodes) world.append(node);
  zoom.append(world);
  root.append(style, zoom);
  const markup = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  context.drawImage(
    await decoded(
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
    ),
    0,
    0,
  );
  nodes.length = 0;
}

function videoNode(element: Extract<CanvasElement, { type: "video" }>) {
  const node = document.createElement("div");
  node.style.cssText = `position:absolute;display:grid;place-items:center;background:#24292b;color:white;left:${element.x}px;top:${element.y}px;width:${element.width}px;height:${element.height}px;font-size:${Math.min(element.width, element.height) / 3}px`;
  node.textContent = "▶";
  return node;
}

function previewFrame(doc: CanvasDocument) {
  const first = orderedFrames(doc)[0];
  if (first) return first;
  const box = contentBounds(doc);
  if (!box) return null;
  const pad = Math.max(1, Math.max(box.width, box.height) * 0.05);
  return createFrameElement(
    doc,
    {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + 2 * pad,
      height: box.height + 2 * pad,
    },
    "preview",
  );
}

export async function renderThumbnail(
  bytes: Uint8Array,
): Promise<string | null> {
  const parsed = parseDocumentFile(bytes);
  if (!parsed.ok) throw new Error("Invalid CanvaSlide document");
  const doc = parsed.document;
  const frame = previewFrame(doc);
  if (!frame || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(384 / frame.width, 240 / frame.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const nodes: HTMLElement[] = [];
  for (const element of pdfPageElements(doc, frame)) {
    if (element.type !== "image") {
      const node =
        element.type === "video"
          ? videoNode(element)
          : renderElement(element, doc);
      if (node) nodes.push(node);
      continue;
    }
    // WebKit can omit photos nested in an SVG foreignObject on its first paint.
    // Decode the embedded photo itself before compositing it in z-order.
    const asset = doc.assets[element.assetId];
    if (!asset || !/^data:image\//i.test(asset.data)) continue;
    await drawVectors(context, nodes, frame, scale);
    const image = await decoded(asset.data);
    const width = element.width * scale,
      height = element.height * scale;
    context.save();
    context.translate(
      (element.x - frame.x) * scale + width / 2,
      (element.y - frame.y) * scale + height / 2,
    );
    context.rotate(((element.rotation ?? 0) * Math.PI) / 180);
    context.drawImage(image, -width / 2, -height / 2, width, height);
    context.restore();
  }
  await drawVectors(context, nodes, frame, scale);
  return canvas.toDataURL("image/jpeg", 0.82);
}
