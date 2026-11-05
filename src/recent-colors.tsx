import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { normalizeHex } from "./color";

const RecentColors = createContext({
  colors: [] as string[],
  add: (_color: string) => {},
});

function storedColors(key: string): string[] | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(stored)) return [];
    return [
      ...new Set(
        stored.flatMap((value) => {
          const color = typeof value === "string" ? normalizeHex(value) : null;
          return color ? [color] : [];
        }),
      ),
    ].slice(0, 6);
  } catch {
    return null;
  }
}

export function RecentColorsProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const key = `weekly-plan:recent-colors:${userId}`;
  const [colors, setColors] = useState(() => storedColors(key) || []);
  const current = useRef(colors);
  const persistent = useRef(true);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      const next = storedColors(key) || [];
      current.current = next;
      persistent.current = true;
      setColors(next);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  function add(value: string) {
    const color = normalizeHex(value);
    if (!color) return;
    const next = [
      color,
      ...(persistent.current
        ? storedColors(key) || current.current
        : current.current
      ).filter((item) => item !== color),
    ].slice(0, 6);
    current.current = next;
    setColors(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      persistent.current = true;
    } catch {
      persistent.current = false;
      // Keep recent colors available for this session when storage is blocked.
    }
  }
  return (
    <RecentColors.Provider value={{ colors, add }}>
      {children}
    </RecentColors.Provider>
  );
}

export const useRecentColors = () => useContext(RecentColors);
