export const BORDER_STYLES = [
  "none",
  "solid",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
];
export const BORDER_OPTIONS = [
  { value: "none", label: "없음" },
  { value: "solid", label: "실선" },
  { value: "medium", label: "중간 실선" },
  { value: "thick", label: "굵은 실선" },
  { value: "dashed", label: "파선" },
  { value: "dotted", label: "점선" },
  { value: "double", label: "이중선" },
];
export const BORDER_SIDES = ["Top", "Right", "Bottom", "Left"];

export function borderCSS(border) {
  if (!border) return undefined;
  if (border.style === "none") return "0px none transparent";
  const width =
    border.style === "medium"
      ? 2
      : ["thick", "double"].includes(border.style)
        ? 3
        : 1;
  const style = ["medium", "thick"].includes(border.style)
    ? "solid"
    : border.style;
  return `${width}px ${style} ${border.color}`;
}

export function bordersCSS(style) {
  return Object.fromEntries(
    BORDER_SIDES.flatMap((side) => {
      const key = `border${side}`;
      return style[key] ? [[key, borderCSS(style[key])]] : [];
    }),
  );
}

// The boundary follows the first/last displayed week when weeks are hidden.
export function weekBorderStyle(key, weekKeys, borders) {
  if (!borders || !weekKeys.length) return {};
  return {
    ...(key === weekKeys[0] && borders.left
      ? { borderLeft: borders.left }
      : {}),
    ...(key === weekKeys.at(-1) && borders.right
      ? { borderRight: borders.right }
      : {}),
  };
}
