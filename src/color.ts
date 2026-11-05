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

export type HSV = { h: number; s: number; v: number };

export function hexToHSV(hex: string): HSV {
  const value = parseInt((normalizeHex(hex) || "#000000").slice(1), 16);
  const r = (value >> 16) / 255,
    g = ((value >> 8) & 255) / 255,
    b = (value & 255) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const h = !delta
    ? 0
    : max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}
