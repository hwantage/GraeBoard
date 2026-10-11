// 배경색 위에 올릴 글자색. 밝은 배경에는 잉크색, 어두운 배경에는 흰색.
export function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const luminance =
    (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return luminance > 155 ? "#243642" : "#ffffff";
}
