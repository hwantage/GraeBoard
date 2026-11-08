// Keep the existing default first so saved teams and unformatted cells retain it.
export const FONTS = [
  "Noto Sans KR",
  "Pretendard",
  "맑은 고딕",
  "Noto Serif KR",
  "Nanum Gothic Coding",
];
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 36;
export const FONT_SIZES = Array.from(
  { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
  (_, i) => MIN_FONT_SIZE + i,
);

export function normalizeFont(name) {
  const font = String(name)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (/^(malgun gothic|맑은 고딕)$/i.test(font)) return "맑은 고딕";
  return FONTS.find((f) => f.toLowerCase() === font.toLowerCase());
}

export function fontFamilyCSS(name) {
  if (!name) return undefined;
  const font = normalizeFont(name) || FONTS[0];
  // Malgun Gothic is supplied by the user's OS, never redistributed as a web font.
  return font === "맑은 고딕"
    ? '"Malgun Gothic", "맑은 고딕", Pretendard, "Noto Sans KR", sans-serif'
    : `"${font}", "Noto Sans KR", sans-serif`;
}
