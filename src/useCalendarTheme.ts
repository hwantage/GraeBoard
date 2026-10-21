import { useEffect, useState, type CSSProperties } from "react";
import { THEMES, themeVariables } from "../shared/themes.js";
import type { ThemeId } from "./types";

type Theme = "light" | "dark";
const storageKey = "weekly-plan:calendar-theme";
const paletteKey = "weekly-plan:calendar-palette";
type Palette = ThemeId | "cartoon";
function validPalette(value: string | null): value is Palette {
  return value === "cartoon" || THEMES.some((theme) => theme.id === value);
}
function storedPalette(): Palette {
  try {
    const value = localStorage.getItem(paletteKey);
    if (validPalette(value)) return value;
  } catch {
    /* The default palette also works without storage. */
  }
  return "cartoon";
}
function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export default function useCalendarTheme() {
  const [preference, setPreference] = useState(storedTheme);
  const [palette, setPalette] = useState(storedPalette);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(system.matches);
    const storageChanged = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === storageKey || event.key === null)
      )
        setPreference(storedTheme());
      if (
        event.storageArea === localStorage &&
        (event.key === paletteKey || event.key === null)
      )
        setPalette(storedPalette());
    };
    system.addEventListener("change", changed);
    window.addEventListener("storage", storageChanged);
    return () => {
      system.removeEventListener("change", changed);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  const theme = preference ?? (systemDark ? "dark" : "light");
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setPreference(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }
  function selectPalette(value: string) {
    if (!validPalette(value)) return;
    setPalette(value);
    try {
      localStorage.setItem(paletteKey, value);
    } catch {
      /* Keep the current selection when storage is unavailable. */
    }
  }
  const style =
    palette === "cartoon"
      ? undefined
      : (Object.fromEntries(
          Object.entries(themeVariables(palette)).map(([key, value]) => [
            `--calendar-palette${key.slice(1)}`,
            value,
          ]),
        ) as CSSProperties);
  return { theme, toggle, palette, selectPalette, style };
}
