export type ImagePoint = { x: number; y: number };
export type ImageTool =
  "select" | "pan" | "pen" | "rectangle" | "ellipse" | "triangle" | "text";
export type ImageStyle = {
  stroke: string;
  fill: string;
  lineWidth: number;
  fontSize: number;
};
export type ImageAnnotation = ImageStyle & {
  id: string;
  tool: Exclude<ImageTool, "select" | "pan">;
  points: ImagePoint[];
  text: string;
  rotation: number;
};
export type ImageBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export const IMAGE_HANDLES = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
] as const;
export type ImageHandle = (typeof IMAGE_HANDLES)[number] | "rotate";

export function annotationBounds(
  mark: ImageAnnotation,
  ctx: CanvasRenderingContext2D,
): ImageBounds {
  const first = mark.points[0];
  if (mark.tool === "text") {
    ctx.font = `bold ${mark.fontSize}px sans-serif`;
    return {
      x: first.x,
      y: first.y,
      width: Math.max(
        1,
        ...mark.text.split("\n").map((line) => ctx.measureText(line).width),
      ),
      height: mark.fontSize * 1.2 * mark.text.split("\n").length,
    };
  }
  let left = first.x,
    right = first.x,
    top = first.y,
    bottom = first.y;
  for (const point of mark.points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}
export const boundsCenter = (box: ImageBounds): ImagePoint => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
export function rotateImagePoint(
  point: ImagePoint,
  center: ImagePoint,
  angle: number,
): ImagePoint {
  const x = point.x - center.x,
    y = point.y - center.y;
  return {
    x: center.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: center.y + x * Math.sin(angle) + y * Math.cos(angle),
  };
}
export function annotationHandles(
  box: ImageBounds,
  rotation: number,
  scale: number,
) {
  const center = boundsCenter(box);
  return Object.fromEntries(
    [...IMAGE_HANDLES, "rotate"].map((handle) => {
      const x =
        handle === "rotate"
          ? center.x
          : handle.includes("w")
            ? box.x
            : handle.includes("e")
              ? box.x + box.width
              : center.x;
      const y =
        handle === "rotate"
          ? box.y - 24 / scale
          : handle.includes("n")
            ? box.y
            : handle.includes("s")
              ? box.y + box.height
              : center.y;
      return [handle, rotateImagePoint({ x, y }, center, rotation)];
    }),
  ) as Record<ImageHandle, ImagePoint>;
}
export function paintImageAnnotations(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  marks: ImageAnnotation[],
) {
  ctx.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
  ctx.drawImage(image, 0, 0);
  for (const mark of marks) {
    const box = annotationBounds(mark, ctx),
      center = boundsCenter(box);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(mark.rotation);
    ctx.translate(-center.x, -center.y);
    ctx.strokeStyle = mark.stroke;
    ctx.fillStyle = mark.fill || "transparent";
    ctx.lineWidth = mark.lineWidth;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    if (mark.tool === "text") {
      ctx.font = `bold ${mark.fontSize}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = mark.stroke;
      mark.text
        .split("\n")
        .forEach((line, i) =>
          ctx.fillText(line, box.x, box.y + i * mark.fontSize * 1.2),
        );
    } else if (mark.tool === "pen") {
      ctx.moveTo(mark.points[0].x, mark.points[0].y);
      for (const point of mark.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      if (mark.tool === "rectangle")
        ctx.rect(box.x, box.y, box.width, box.height);
      if (mark.tool === "ellipse")
        ctx.ellipse(
          center.x,
          center.y,
          box.width / 2,
          box.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      if (mark.tool === "triangle") {
        ctx.moveTo(center.x, box.y);
        ctx.lineTo(box.x + box.width, box.y + box.height);
        ctx.lineTo(box.x, box.y + box.height);
        ctx.closePath();
      }
      if (mark.fill) ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
export function hitImageAnnotation(
  mark: ImageAnnotation,
  point: ImagePoint,
  ctx: CanvasRenderingContext2D,
  tolerance: number,
) {
  const box = annotationBounds(mark, ctx);
  const local = rotateImagePoint(point, boundsCenter(box), -mark.rotation);
  if (mark.tool !== "pen")
    return (
      local.x >= box.x - tolerance &&
      local.x <= box.x + box.width + tolerance &&
      local.y >= box.y - tolerance &&
      local.y <= box.y + box.height + tolerance
    );
  return mark.points.some((b, index) => {
    const a = mark.points[Math.max(0, index - 1)];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((local.x - a.x) * dx + (local.y - a.y) * dy) /
          (dx * dx + dy * dy || 1),
      ),
    );
    return (
      Math.hypot(local.x - a.x - t * dx, local.y - a.y - t * dy) <=
      tolerance + mark.lineWidth / 2
    );
  });
}
export function moveImageAnnotation(
  mark: ImageAnnotation,
  dx: number,
  dy: number,
): ImageAnnotation {
  return {
    ...mark,
    points: mark.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}
export function resizeImageAnnotation(
  mark: ImageAnnotation,
  box: ImageBounds,
  handle: ImageHandle,
  point: ImagePoint,
): ImageAnnotation {
  const center = boundsCenter(box);
  if (handle === "rotate")
    return {
      ...mark,
      rotation:
        Math.atan2(point.y - center.y, point.x - center.x) + Math.PI / 2,
    };
  const local = rotateImagePoint(point, center, -mark.rotation);
  let left = handle.includes("w")
    ? Math.min(local.x, box.x + box.width - 2)
    : box.x;
  let top = handle.includes("n")
    ? Math.min(local.y, box.y + box.height - 2)
    : box.y;
  let width =
    (handle.includes("e") ? Math.max(local.x, box.x + 2) : box.x + box.width) -
    left;
  let height =
    (handle.includes("s") ? Math.max(local.y, box.y + 2) : box.y + box.height) -
    top;
  if (mark.tool === "text") {
    const scale = Math.max(
      6 / mark.fontSize,
      Math.min(
        300 / mark.fontSize,
        handle.includes("e") || handle.includes("w")
          ? width / box.width
          : height / box.height,
      ),
    );
    width = box.width * scale;
    height = box.height * scale;
    left = handle.includes("w") ? box.x + box.width - width : box.x;
    top = handle.includes("n") ? box.y + box.height - height : box.y;
  }
  const nextCenter = { x: left + width / 2, y: top + height / 2 };
  const worldCenter = rotateImagePoint(nextCenter, center, mark.rotation);
  return {
    ...mark,
    fontSize:
      mark.tool === "text"
        ? (mark.fontSize * height) / box.height
        : mark.fontSize,
    points: mark.points.map((p) => ({
      x:
        left +
        ((p.x - box.x) * width) / box.width +
        worldCenter.x -
        nextCenter.x,
      y:
        top +
        ((p.y - box.y) * height) / box.height +
        worldCenter.y -
        nextCenter.y,
    })),
  };
}
