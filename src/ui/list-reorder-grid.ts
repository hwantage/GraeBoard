export type ReorderGridBox = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  span: number;
};
export type ReorderGridPreview = {
  id: string;
  index: number;
  order: string[];
  left: number;
  top: number;
  width: number;
  height: number;
};
const inside = (box: ReorderGridBox, point: { x: number; y: number }) =>
  point.x >= box.left &&
  point.x <= box.left + box.width &&
  point.y >= box.top &&
  point.y <= box.top + box.height;

// Hit the unchanged card geometry, including gaps. Hover never moves the cards
// used as targets, so the next pointer event cannot reverse its own placement.
export function gridDropAt(
  boxes: ReorderGridBox[],
  moving: string,
  point: { x: number; y: number },
) {
  const own = boxes.find((box) => box.id === moving);
  if (own && inside(own, point)) return null;
  const distance = (box: ReorderGridBox) =>
    Math.hypot(
      Math.max(box.left - point.x, 0, point.x - box.left - box.width),
      Math.max(box.top - point.y, 0, point.y - box.top - box.height),
    );
  const target = boxes
    .filter((box) => box.id !== moving)
    .reduce<ReorderGridBox | undefined>(
      (nearest, box) =>
        !nearest || distance(box) < distance(nearest) ? box : nearest,
      undefined,
    );
  if (!target) return null;
  const before =
    point.y < target.top
      ? true
      : point.y > target.top + target.height
        ? false
        : target.span > 1
          ? point.y < target.top + target.height / 2
          : point.x < target.left + target.width / 2;
  return {
    targetId: target.id,
    placement: before ? ("before" as const) : ("after" as const),
  };
}

// Match CSS grid's sparse row-major placement. A full-width item starts a new
// row; each row advances by its tallest card, not by the moving card's height.
export function reorderGridSlots(
  items: ReorderGridBox[],
  columns: number[],
  columnGap: number,
  rowGap: number,
) {
  let column = 0,
    top = 0,
    rowHeight = 0;
  return items.map((item) => {
    const span = Math.min(columns.length, Math.max(1, item.span));
    if (column + span > columns.length) {
      top += rowHeight + rowGap;
      column = 0;
      rowHeight = 0;
    }
    const slot = {
      id: item.id,
      left: columns
        .slice(0, column)
        .reduce((sum, width) => sum + width + columnGap, 0),
      top,
      width:
        columns
          .slice(column, column + span)
          .reduce((sum, width) => sum + width, 0) +
        (span - 1) * columnGap,
      height: item.height,
    };
    rowHeight = Math.max(rowHeight, item.height);
    column += span;
    if (column === columns.length) {
      top += rowHeight + rowGap;
      column = 0;
      rowHeight = 0;
    }
    return slot;
  });
}
