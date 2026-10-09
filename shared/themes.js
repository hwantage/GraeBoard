/** @typedef {"mint" | "sky" | "lavender" | "rose" | "sand"} ThemeId */
/** @type {{id: ThemeId, name: string, accent: string, strong: string, pastel: string, soft: string, surface: string, border: string}[]} */
export const THEMES = [
  {
    id: "mint",
    name: "민트",
    accent: "#24796d",
    strong: "#1b6258",
    pastel: "#deebe4",
    soft: "#e7f2ee",
    surface: "#f0f4f2",
    border: "#bdd4c9",
  },
  {
    id: "sky",
    name: "하늘",
    accent: "#426f9c",
    strong: "#345878",
    pastel: "#deeaf7",
    soft: "#edf3fa",
    surface: "#f1f5fa",
    border: "#bccfe2",
  },
  {
    id: "lavender",
    name: "라벤더",
    accent: "#746099",
    strong: "#5b477d",
    pastel: "#e9e2f3",
    soft: "#f3eff9",
    surface: "#f5f2f8",
    border: "#d0c4e2",
  },
  {
    id: "rose",
    name: "로즈",
    accent: "#986176",
    strong: "#79495c",
    pastel: "#f2e1e7",
    soft: "#faeff3",
    surface: "#faf3f5",
    border: "#e2c5d0",
  },
  {
    id: "sand",
    name: "샌드",
    accent: "#866b42",
    strong: "#6b5433",
    pastel: "#eee5d6",
    soft: "#f6f1e7",
    surface: "#f8f5ef",
    border: "#daccb3",
  },
];
export const THEME_IDS = THEMES.map((theme) => theme.id);
export function getTheme(id) {
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}
export function themeVariables(id) {
  const theme = getTheme(id);
  return {
    "--accent": theme.accent,
    "--accent-strong": theme.strong,
    "--accent-pastel": theme.pastel,
    "--accent-soft": theme.soft,
    "--accent-surface": theme.surface,
    "--accent-border": theme.border,
  };
}
