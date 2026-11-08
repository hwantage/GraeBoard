// 배경색 위에 올릴 글자색. 밝은 배경에는 잉크색, 어두운 배경에는 흰색.
export function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const luminance =
    (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return luminance > 155 ? "#243642" : "#ffffff";
}

export function normalizeHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex))
    return `#${[...hex].map((digit) => digit + digit).join("")}`.toLowerCase();
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}
