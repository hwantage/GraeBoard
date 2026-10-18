import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const storageKey = "weekly-plan:calendar-theme";
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
  return { theme, toggle };
}
