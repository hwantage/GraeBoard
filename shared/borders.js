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
