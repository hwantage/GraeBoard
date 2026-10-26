export const BORDER_STYLES = [
  "none",
  "solid",
  "medium",
  "thick",
  "dashed",
  "double",
];
export const BORDER_OPTIONS = [
  { value: "none", label: "없음" },
  { value: "solid", label: "실선" },
  { value: "medium", label: "중간 실선" },
  { value: "thick", label: "굵은 실선" },
  { value: "dashed", label: "점선" },
  { value: "double", label: "이중선" },
];
export const BORDER_SIDES = ["Top", "Right", "Bottom", "Left"];

/**
 * Date boundaries follow the displayed/exported columns, never a stored date.
 * @param {string[]} keys
 * @param {import("../src/types").Settings["weekBorders"]} borders
 * @param {import("../src/types").Settings["currentWeekBorders"]} currentBorders
 * @param {string} currentWeek Monday key in the same timezone as the week highlight.
 * @returns {Map<string, import("../src/types").Style>}
 */
export function weekBoundaryStyles(
  keys,
  borders = {},
  currentBorders = {},
  currentWeek = "",
) {
  const dates = keys.filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
  const styles = new Map();
  if (!dates.length) return styles;
  for (const [side, key] of [
    ["left", dates[0]],
    ["right", dates.at(-1)],
  ]) {
    const border = borders[side];
    if (border && border.style !== "none")
      styles.set(key, {
        ...styles.get(key),
        [side === "left" ? "borderLeft" : "borderRight"]: border,
      });
  }
  // The current week is a specific date column, never the nearest visible one.
  // Its defaults override range edges only on sides with a configured line.
  if (dates.includes(currentWeek)) {
    for (const [side, property] of [
      ["left", "borderLeft"],
      ["right", "borderRight"],
    ]) {
      const border = currentBorders[side];
      if (border && border.style !== "none")
        styles.set(currentWeek, {
          ...styles.get(currentWeek),
          [property]: border,
        });
    }
  }
  return styles;
}

/**
 * Resolve both cells sharing each date boundary together. Only a visible border
 * stored on a cell overrides the boundary; null/none and inherited task borders
 * fall back to the boundary. Never persist these display styles.
 * @param {string[]} keys
 * @param {import("../src/types").Style[]} styles Effective styles, including task defaults.
 * @param {Map<string, import("../src/types").Style>} boundaries
 * @param {import("../src/types").Style[]} cellStyles Stored cell overrides only.
 * @returns {import("../src/types").Style[]}
 */
export function withWeekBoundaries(keys, styles, boundaries, cellStyles) {
  if (!boundaries.size) return styles;
  const result = [...styles];
  const visible = (border) => border && border.style !== "none";
  const cleared = { style: "none", color: "#000000" };
  for (const [index, key] of keys.entries()) {
    const boundary = boundaries.get(key);
    if (!boundary) continue;
    for (const [side, offset, opposite] of [
      ["borderLeft", -1, "borderRight"],
      ["borderRight", 1, "borderLeft"],
    ]) {
      if (!boundary[side]) continue;
      const neighborIndex = index + offset;
      const own = cellStyles[index]?.[side];
      const neighbor = cellStyles[neighborIndex]?.[opposite];
      result[index] = {
        ...result[index],
        [side]: visible(own)
          ? own
          : visible(neighbor)
            ? cleared
            : boundary[side],
      };
      if (result[neighborIndex])
        result[neighborIndex] = {
          ...result[neighborIndex],
          [opposite]: visible(neighbor) ? neighbor : cleared,
        };
    }
  }
  return result;
}

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

// Collapse explicit borders on both sides of a shared edge. The stronger
// line wins; equal lines belong to the top/left cell. Keep stored styles intact.
/**
 * @param {object} style
 * @param {{top?: {style: string, color: string} | null, left?: {style: string, color: string} | null, right?: {style: string, color: string} | null, bottom?: {style: string, color: string} | null}} neighbors
 */
export function gridBordersCSS(style, neighbors = {}) {
  const weight = (border) =>
    !border || border.style === "none"
      ? 0
      : border.style === "medium"
        ? 2
        : ["thick", "double"].includes(border.style)
          ? 3
          : 1;
  const css = bordersCSS(style);
  for (const side of BORDER_SIDES) {
    const own = weight(style[`border${side}`]);
    const neighbor = weight(neighbors[side.toLowerCase()]);
    if (
      own &&
      neighbor &&
      (neighbor > own || (neighbor === own && ["Top", "Left"].includes(side)))
    )
      css[`border${side}`] = "0px none transparent";
  }
  return css;
}

// 선택 영역 테두리 프리셋. 구글 시트의 테두리 메뉴와 같은 순서다.
export const BORDER_PRESETS = [
  { value: "all", label: "모든 테두리" },
  { value: "inner", label: "안쪽 테두리" },
  { value: "horizontal", label: "가로 안쪽 테두리" },
  { value: "vertical", label: "세로 안쪽 테두리" },
  { value: "outside", label: "바깥쪽 테두리" },
  { value: "left", label: "왼쪽 테두리" },
  { value: "top", label: "위쪽 테두리" },
  { value: "right", label: "오른쪽 테두리" },
  { value: "bottom", label: "아래쪽 테두리" },
  { value: "none", label: "테두리 지우기" },
];

/**
 * 프리셋을 셀 하나의 서식에 적용한다. `outer[side]`는 그 방향 이웃이 선택
 * 영역 밖인지를 뜻한다. 맞닿은 안쪽 경계는 위·왼쪽 셀의 아래·오른쪽 선이
 * 맡고, 아래·오른쪽 셀의 위·왼쪽 선은 지워 선이 두 겹으로 그려지지 않게 한다.
 * null은 업무 기본 서식의 선도 덮어쓰고 기본 격자선으로 되돌린다.
 * 키를 삭제하면 cell()이 업무 기본 서식의 선을 다시 상속하므로 남겨 둔다.
 * border가 null이면 선택한 위치만, preset이 none이면 모든 방향을 되돌린다.
 */
export function applyBorderPreset(style, preset, border, outer) {
  const next = { ...style };
  for (const side of BORDER_SIDES) {
    const key = `border${side}`;
    const edge = outer[side];
    const vertical = side === "Left" || side === "Right";
    const target =
      preset === "all" || preset === "none"
        ? true
        : preset === "inner"
          ? !edge
          : preset === "horizontal"
            ? !edge && !vertical
            : preset === "vertical"
              ? !edge && vertical
              : preset === "outside"
                ? edge
                : edge && preset === side.toLowerCase();
    if (!target) continue;
    if (preset === "none" || (!edge && (side === "Top" || side === "Left")))
      next[key] = null;
    else next[key] = border;
  }
  return next;
}
